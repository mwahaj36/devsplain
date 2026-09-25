/** [ds]
 * Fetches a URL with automatic retry on transient failures (5xx, timeouts).
 * Uses exponential backoff between attempts. Rate-limit (429) errors are
 * tagged with `isRateLimit` and propagated immediately to let callers
 * (e.g. the concurrency controller) apply site-wide throttling rather
 * than per-request retries.
 * @param {string} url - Target URL.
 * @param {object} options - fetch() options.
 * @param {number} maxRetries - Max attempts before giving up.
 * @param {number} initialDelay - Base backoff delay in ms.
 * @returns {Promise<Response>}
*/
async function fetchWithRetry(url, options, maxRetries = 3, initialDelay = 1000) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        // 45s hard timeout guards against hung sockets; abort signal is threaded into fetch below. [ds]
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 45000);
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!response) {
                throw new Error("No response received from fetch");
            }
            if (response.ok) {
                // Opportunistically probe rate-limit headers so getChunkConfig() can scale chunk sizes on subsequent calls. [ds]
                if (response.headers && typeof response.headers.get === 'function') {
                    const limitTokensHeader = response.headers.get('x-ratelimit-limit-tokens');
                    if (limitTokensHeader) {
                        const parsedLimit = parseInt(limitTokensHeader, 10);
                        if (!isNaN(parsedLimit) && parsedLimit > 0) {
                            _discoveredTierLimit = parsedLimit;
                        }
                    }
                }
                return response;
            }
            // 429 is never retried inline — it bubbles up as isRateLimit so the outer concurrency controller can globally throttle. [ds]
            if (response.status === 429) {
                const err = new Error(`HTTP Error 429: ${response.statusText || 'Too Many Requests'}`);
                err.isRateLimit = true;
                throw err;
            }
            // Only 5xx errors trigger retry; all other non-OK statuses (4xx) are returned as-is for caller inspection. [ds]
            if (response.status >= 500 && response.status < 600) {
                lastError = new Error(`HTTP Error ${response.status}: ${response.statusText}`);
            } else {
                return response;
            }
        } catch (err) {
            clearTimeout(timeoutId);
            if (err.isRateLimit) {
                throw err;
            }
            if (err.name === 'AbortError') {
                lastError = new Error("Request timed out after 45 seconds");
            } else {
                lastError = err;
            }
        }

        // Exponential backoff: initialDelay * 2^attempt (1s, 2s, 4s...). Skip after final attempt. [ds]
        if (attempt < maxRetries - 1) {
            const backoffDelay = initialDelay * Math.pow(2, attempt);
            console.warn(`[devsplain] AI request failed. Retrying in ${backoffDelay}ms... (Attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
        }
    }
    throw lastError;
}

// Provider profiles tune chunk sizes to each model's context window and free-tier token budgets. [ds]
// Larger chunks reduce request count (and cost/latency) on high-capacity providers, [ds]
// but risk 429s or truncation on constrained ones like Groq. [ds]
// ─── Provider Profiles for Model-Adaptive Chunking ────────────────────────────
// Baseline free-tier safe defaults: preserves token limits for free/low tiers,
// while expanding window sizes for high-capacity providers (DeepSeek, Gemini, Claude).
const PROVIDER_PROFILES = {
    groq:     { size: 200, overlap: 20, threshold: 250,  maxTokens: 1000 },
    deepseek: { size: 600, overlap: 50, threshold: 750,  maxTokens: 8192 },
    gemini:   { size: 800, overlap: 60, threshold: 1000, maxTokens: 8192 },
    claude:   { size: 600, overlap: 50, threshold: 750,  maxTokens: 8192 },
    openai:   { size: 600, overlap: 50, threshold: 750,  maxTokens: 4096 },
    default:  { size: 250, overlap: 25, threshold: 300,  maxTokens: 4096 }
};

// Populated at runtime by fetchWithRetry() when a response advertises a token rate limit. [ds]
// Tracks discovered rate limits from response headers (e.g. x-ratelimit-limit-tokens)
let _discoveredTierLimit = null;

// Baseline constants exported for backward compatibility
const CHUNK_SIZE = 200;
const CHUNK_OVERLAP = 20;
const CHUNK_THRESHOLD = 250;

/**
 * Returns the effective chunking parameters for a provider.
 * Allows override via config (e.g., config.chunkSize from --chunk-size flag)
 * or scaled up dynamically if response headers reveal high tier capacity.
 * @param {object} config - Provider configuration object.
 * @returns {object} { size, overlap, threshold, maxTokens }
 */
/** [ds]
 * Resolves effective chunking parameters for a provider, layering (in order):
 * explicit config overrides > dynamic tier scaling > provider profile > default.
 * @param {object} config - Provider configuration.
 * @returns {{size:number, overlap:number, threshold:number, maxTokens:number}}
*/
function getChunkConfig(config = {}) {
    const provider = (config.provider || '').toLowerCase();
    const base = PROVIDER_PROFILES[provider] || PROVIDER_PROFILES.default;

    let size = config.chunkSize || base.size;
    let overlap = config.chunkOverlap || base.overlap;
    let threshold = config.chunkThreshold || base.threshold;
    const maxTokens = base.maxTokens;

    // Dynamic Tier Scaling: only applied when the user hasn't forced a chunkSize AND the discovered [ds]
    // rate limit exceeds 100k tokens/min — signaling a paid/high tier where larger chunks are safe. [ds]
    // Dynamic Tier Scaling: if response headers revealed a high-tier token limit (>100k TPM),
    // scale up chunk size safely by 1.5x up to 1000 lines max
    if (!config.chunkSize && _discoveredTierLimit && _discoveredTierLimit > 100000) {
        size = Math.min(1000, Math.round(size * 1.5));
        threshold = Math.min(1200, Math.round(threshold * 1.5));
        overlap = Math.min(100, Math.round(overlap * 1.5));
    }

    return { size, overlap, threshold, maxTokens };
}

function setDiscoveredTierLimit(limit) {
    _discoveredTierLimit = limit;
}

// ─── Adaptive Concurrency Controller ────────────────────────────────────────── [ds]
// Module-level adaptive state: shared across all runWithConcurrency invocations [ds]
// within a single run so a 429 on one task throttles all subsequent tasks. [ds]
// ─── Adaptive Concurrency Controller ──────────────────────────────────────────
// Module-level adaptive state: shared across all runWithConcurrency invocations
// within a single run so a 429 on one task throttles all subsequent tasks.
let _concurrencyLimit = 2;
let _hitRateLimit = false;

/**
 * Reset the adaptive concurrency controller for a new run.
 * @param {number} initialLimit - Starting concurrency level.
 */
/** Resets adaptive concurrency state for a fresh run (called between files/batches). [ds] */
function resetConcurrency(initialLimit = 2) {
    _concurrencyLimit = initialLimit;
    _hitRateLimit = false;
    _discoveredTierLimit = null;
}

/**
 * Zero-dependency promise pool that respects the adaptive concurrency limit.
 * If a task throws a 429 RateLimitError, concurrency is reduced to 1 for
 * the remainder of the run, and the failed task is retried after a backoff.
 * @param {Array} items - Items to process.
 * @param {Function} taskFn - Async function to run per item.
 * @returns {Promise<Array>} - Resolved results in order.
 */
/** [ds]
 * Zero-dependency promise pool that respects the adaptive concurrency limit.
 * On any 429, drops concurrency to 1 for the rest of the run and retries
 * the failing task with exponential backoff + jitter. Jitter prevents
 * thundering-herd sync when multiple workers resume simultaneously.
 * @param {Array} items - Items to process.
 * @param {Function} taskFn - Async function to run per item.
 * @returns {Promise<Array>} - Results in input order.
*/
async function runWithConcurrency(items, taskFn) {
    const results = [];
    const executing = new Set();

    for (let i = 0; i < items.length; i++) {
        const item = items[i];

        // Block until an executing task settles before starting another, enforcing the dynamic limit. [ds]
        while (executing.size >= _concurrencyLimit) {
            await Promise.race(executing);
        }

        const task = (async () => {
            const maxRetries = 3;
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    return await taskFn(item);
                } catch (err) {
                    if (err.isRateLimit && attempt < maxRetries - 1) {
                        if (!_hitRateLimit) {
                            _hitRateLimit = true;
                            _concurrencyLimit = 1;
                            console.warn(`[devsplain] Rate limit hit — switching to serial mode.`);
                        }
                        // Jitter (+0-500ms) desynchronizes retries from parallel workers sharing the same server-side rate limit. [ds]
                        const backoff = (process.env.NODE_ENV === 'test' ? 50 : 2000) * Math.pow(2, attempt) + Math.random() * 500;
                        console.warn(`[devsplain] Backing off for ${Math.round(backoff)}ms...`);
                        await new Promise(r => setTimeout(r, backoff));
                        continue;
                    }
                    throw err;
                }
            }
        })();

        // Attach a settlement hook that removes this task from the executing set once it resolves or rejects, [ds]
        // freeing a concurrency slot. A no-op catch prevents unhandled-rejection warnings before Promise.all. [ds]
        let tracked;
        tracked = task.finally(() => {
            executing.delete(tracked);
        });
        tracked.catch(() => {});
        executing.add(tracked);
        results.push(tracked);
    }
    return Promise.all(results);
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

/**
 * Build the LLM prompt for a block of numbered code lines.
 * @param {string} numberedCode - Code with line numbers prepended.
 * @param {string} language - Filename or language identifier.
 * @param {string} mode - Documentation mode ('default', 'light', 'full').
 * @returns {string} The assembled prompt string.
 */
/** [ds]
 * Builds the LLM prompt for a numbered code block, adapting comment syntax
 * to the source language (Python/Ruby/Shell use '#', HTML/CSS use block comments, etc.).
 * @param {string} numberedCode - Code with line numbers prepended.
 * @param {string} language - Filename or extension used to infer comment style.
 * @param {string} mode - Documentation mode ('default', 'light', 'full').
 * @param {string} contextSnippet - Optional surrounding lines for context.
 * @param {string} projectContext - Optional repo-level context.
 * @returns {string} Prompt string.
*/
function buildPrompt(numberedCode, language, mode, contextSnippet = '', projectContext = '') {
    // Infer language from file extension since `language` may also contain a full path. [ds]
    const extMatch = language.match(/\.[0-9a-z]+$/i);
    const ext = extMatch ? extMatch[0].toLowerCase() : '';
    const isPython = ext === '.py';
    const isRubyOrShell = ['.rb', '.sh'].includes(ext);
    const isHTML = ['.html', '.vue', '.svelte'].includes(ext);
    const isCss = ['.css', '.scss'].includes(ext);
    const isSql = ext === '.sql';
    let singleLineToken = '//';
    let blockExample = '/** Calculates the total price */';
    let inlineExample = '// Check for null values';

    // Language-aware comment token selection: Python and Ruby/Shell share '#', [ds]
    // while HTML/CSS/SQL fall through to the defaults below or use block syntax. [ds]
    if (isPython || isRubyOrShell) {
        singleLineToken = '#';
        blockExample = '# Calculates the total price';
        inlineExample = '# Check for null values';
    } else if (isHTML) {
        singleLineToken = '<!--';
        blockExample = '<!-- Calculates the total price -->';
        inlineExample = '<!-- Check for null values -->';
    } else if (isCss) {
        singleLineToken = '/*';
        blockExample = '/* Calculates the total price */';
        inlineExample = '/* Check for null values */';
    } else if (isSql) {
        singleLineToken = '--';
        blockExample = '-- Calculates the total price';
        inlineExample = '-- Check for null values';
    }

    // Default mode: sparse comments; 'light' trims to function-level only, while 'full' opts into exhaustive branch-by-branch narration. [ds]
    let instruction = `Provide block comments above functions and sparse inline comments for complex logic.`;
    if (mode === 'light') {
        instruction = `Provide ONLY block comments above functions. Keep it minimal.`;
    } else if (mode === 'full') {
        instruction = `Provide highly detailed block comments above functions, and exhaustive step-by-step inline comments explaining every conditional branch, loop, variable assignment, and logical block inside function bodies. Do not be sparse; explain the code's execution flow in detail.`;
    }

    // Rule 5 must be swapped per-language because CSS rejects '//' entirely and Python/Ruby reject C-style block comments. [ds]
    let rule5 = `5. IMPORTANT: Use ONLY ${singleLineToken} for comments. DO NOT use docstrings or multi-line string literals like """ or ''' for comments.`;
    // CSS is the only language where '//' is invalid, so override the generic rule to force /* */ delimiters. [ds]
    if (isCss) {
        rule5 = `5. IMPORTANT: In CSS/SCSS, you MUST use /* ... */ for comments. DO NOT use // comments under any circumstances.`;
    }

    const antiTrivialityRules = `
ANTI-TRIVIALITY RULES (STRICTLY ENFORCED):
6. NEVER write comments that merely narrate the syntax (e.g. NEVER write "// Loop over items" above a for loop, "// Return result" above a return, "// Increment i" above i++, or "// Define variable" above a declaration).
7. NEVER comment standard variable initializations, obvious assignments, or self-describing code.
8. ONLY write comments where:
   - The WHY or architectural intent is non-obvious.
   - An edge case, security workaround, or regex heuristic is being handled.
   - A tricky formula, index manipulation (e.g. 0-indexed vs 1-indexed), or protocol-specific behavior occurs.
9. Prefer comprehensive function-level block comments over cluttered inline comments. Quality over quantity.`;

    // Context is hard-capped to conserve tokens on free-tier rate limits; truncation may cut mid-line, which is acceptable since the context block is advisory only. [ds]
    // Both sources are combined and hard-capped at 600 chars (~150 tokens) to protect free-tier rate limits.
    const MAX_CONTEXT_CHARS = 600;
    let combinedContext = [projectContext, contextSnippet].filter(Boolean).join('\n');
    if (combinedContext.length > MAX_CONTEXT_CHARS) {
        combinedContext = combinedContext.slice(0, MAX_CONTEXT_CHARS);
    }
    // The context block is fenced with explicit markers so the model does not emit comment objects for these read-only lines. [ds]
    const contextBlock = combinedContext ? `
--- PROJECT & FILE CONTEXT (read-only — DO NOT generate comment objects for these lines) ---
${combinedContext}
--- END CONTEXT ---
` : '';

    const prompt = `
You are a code documentation engine. Analyze the following ${language} code which has line numbers prepended to it.
${instruction}

CRITICAL RULES:
1. You MUST respond with ONLY a raw, valid JSON array of objects. NO markdown formatting, NO backticks, NO explanations, NO text before or after the JSON.
2. Each object must have exactly two properties: "line" (the integer line number where the comment should be inserted ABOVE) and "comment" (the text of the comment itself).
3. Do NOT include the original code in your response.
4. If no comments are needed, return an empty array: [].
${rule5}
${antiTrivialityRules}
${contextBlock}
Example Output:
[
  { "line": 4, "comment": "${blockExample}" },
  { "line": 12, "comment": "${inlineExample}" }
]

Here is the source code:
${numberedCode}
    `.trim();

    return prompt;
}

// ─── Single-Chunk Comment Fetcher ─────────────────────────────────────────────

/**
 * Fetch comments for a single chunk of code from the configured AI provider.
 * @param {string} prompt - The assembled prompt.
 * @param {object} config - Provider config (provider, model, apiKey, baseUrl).
 * @returns {Promise<string>} Raw text response from the AI.
 */
/** [ds]
 * Dispatches a single prompt to the configured AI provider and extracts the
 * assistant's text response from the provider-specific envelope.
 * Each branch normalizes its own response shape and error semantics into a
 * uniform string or thrown Error so callers see a consistent interface.
 *
 * @param {string} prompt - The assembled prompt.
 * @param {object} config - Provider config (provider, model, apiKey, baseUrl).
 * @returns {Promise<string>} Raw text response from the AI.
*/
async function fetchFromProvider(prompt, config) {
    let textResponse = "";

    if (config.provider === 'gemini') {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
        let data;
        try {
            const response = await fetchWithRetry(url, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify({
                    "contents": [{ "parts": [{ "text": prompt }] }]
                })
            });
            data = await response.json();
        // Re-throw rate-limit errors untouched so upstream retry/backoff logic can handle them; wrap only other transport failures. [ds]
        } catch (error) {
            if (error.isRateLimit) throw error;
            throw new Error(`AI Provider Request Failed: ${error.message}`);
        }
        if (data.error) {
            const msg = data.error.message || (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
            throw new Error(`API Error: ${msg}`);
        }
        // Gemini's nested response envelope is notoriously polymorphic (safety blocks, empty candidates, etc.), so drill down defensively. [ds]
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts || !data.candidates[0].content.parts[0]) {
            const reason = data.candidates?.[0]?.finishReason || 'Unknown error';
            throw new Error(`AI Provider returned no content (finish reason: ${reason})`);
        }
        textResponse = data.candidates[0].content.parts[0].text;
    } else if (config.provider === 'claude') {
        const url = `${config.baseUrl}/v1/messages`;
        let data;
        try {
            const response = await fetchWithRetry(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': config.apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    "model": config.model,
                    "max_tokens": 8192,
                    "messages": [{
                        "role": "user",
                        "content": prompt
                    }]
                })
            });
            data = await response.json();
        // Preserve rate-limit signal; all other fetch failures are normalized into a generic provider error. [ds]
        } catch (error) {
            if (error.isRateLimit) throw error;
            throw new Error(`AI Provider Request Failed: ${error.message}`);
        }
        if (data.error) {
            const msg = data.error.message || (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
            throw new Error(`API Error: ${msg}`);
        }
        // Claude returns content as an array of typed parts; the first text part is assumed to hold the model reply. [ds]
        if (!data.content || !data.content[0] || typeof data.content[0].text !== 'string') {
            throw new Error(`AI Provider returned an unexpected response structure: ${JSON.stringify(data)}`);
        }
        textResponse = data.content[0].text;
    } 
    else {
        const url = `${config.baseUrl}/v1/chat/completions`;
        let data;

        const reqBody = { 
            "model": config.model, 
            "messages": [{ 
                "role": "user", 
                "content": prompt 
            }] 
        };
        // OpenAI-compatible endpoints vary in max_tokens support; defer to chunk config to size the budget per model tier. [ds]
        const chunkConfig = getChunkConfig(config);
        reqBody.max_tokens = chunkConfig.maxTokens;

        /** [ds]
         * Sends a request to the AI provider and extracts the text response.
         * Validates response structure and unwraps provider-specific error payloads.
         * Rate-limit errors are rethrown untouched so retry logic upstream can act on them.
        */
        try {
            const response = await fetchWithRetry(url, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json', 
                    'Authorization': `Bearer ${config.apiKey}` 
                },
                body: JSON.stringify(reqBody)
            });
            data = await response.json();
        // Same rate-limit passthrough pattern as the Gemini and Claude branches for consistency. [ds]
        } catch (error) {
            if (error.isRateLimit) throw error;
            throw new Error(`AI Provider Request Failed: ${error.message}`);
        }
        // Provider may return a 200 OK with an error object in the body; normalize string vs object error messages [ds]
        if (data.error) {
            const msg = data.error.message || (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
            throw new Error(`API Error: ${msg}`);
        }
        // Guard against OpenAI-compatible providers returning non-JSON or truncated bodies without a choices array. [ds]
        if (!data.choices || !data.choices[0] || !data.choices[0].message || typeof data.choices[0].message.content !== 'string') {
            throw new Error(`AI Provider returned an unexpected response structure: ${JSON.stringify(data)}`);
        }
        textResponse = data.choices[0].message.content;
    }

    return textResponse;
}

// ─── Comment Sanitizer ────────────────────────────────────────────────────────

/**
 * Sanitizes a raw LLM-generated comment string to prevent it from breaking
 * the syntax of the target file. Covers all four comment families used across
 * the 22 supported languages:
 *
 *  1. Block comments  `/* ... * /`  — JS, TS, Java, C, C++, C#, Go, Rust, Swift,
 *                                     Kotlin, Dart, CSS, SCSS, PHP, SQL
 *  2. HTML comments   `<!-- ... -->` — HTML, Vue, Svelte
 *  3. Single-line     `// # --`      — all line-comment languages
 *
 * @param {string} comment - Raw comment text from the LLM.
 * @returns {string} Sanitized comment safe to splice into source code.
 */
function sanitizeCommentText(comment) {
    if (typeof comment !== 'string') return comment;

    const t = comment.trim();

    // ── Block comments: /* ... */ ─────────────────────────────────────────────
    // Triggered when the comment starts with /* (catches /** JSDoc too).
    // Strategy: split on `*/` and rejoin — every `*/` except the very last is
    // interior (escaping it to `* /`) because JS/Java/C parsers close the block
    // at the first `*/` they encounter, not via depth-tracking. [ds]
    if (t.startsWith('/*')) {
        const parts = comment.split('*/');
        if (parts.length <= 1) return comment; // no */ at all — return as-is [ds]
        // Re-join all interior */ as `* /`; the last part is suffix after terminal */ [ds]
        const last = parts.pop();
        return parts.join('* /') + '*/' + last;
    }

    // ── HTML block comments: <!-- ... --> ─────────────────────────────────────
    // Triggered when the comment starts with <!--. Any `-->` before the final
    // one would prematurely close the HTML comment. Escape interior `-->` to
    // `-- >` (whitespace is harmless in HTML comment context). [ds]
    if (t.startsWith('<!--')) {
        // Split on --> and rejoin all-but-last with escaped version [ds]
        const parts = comment.split('-->');
        if (parts.length > 1) {
            const last = parts.pop();
            return parts.join('-- >') + '-->' + last;
        }
        return comment;
    }

    // ── Single-line comments: // # -- ────────────────────────────────────────
    // Single-line comment syntax has no multi-line closing token to worry about,
    // but an LLM could embed a literal newline followed by code — effectively
    // injecting executable lines into the file. Strip embedded newlines so
    // single-line comments remain single-line. [ds]
    if (t.startsWith('//') || t.startsWith('#') || t.startsWith('--')) {
        // Collapse embedded newlines to a space; trailing whitespace is cleaned up [ds]
        return comment.replace(/[\r\n]+/g, ' ').trimEnd();
    }

    // Unknown comment form — return as-is; the marker validator will catch truly invalid content [ds]
    return comment;
}

// ─── Response Parser & Validator ──────────────────────────────────────────────

/**
 * Parse, validate, and sanitize the raw text response from the AI provider.
 * @param {string} textResponse - Raw text from the AI.
 * @param {string} mode - Documentation mode.
 * @returns {Array} Validated array of comment objects.
 */
/** [ds]
 * Parses the raw text response from the LLM and enforces a strict schema.
 * Handles the common LLM quirk of wrapping JSON in prose or markdown by
 * extracting the outermost array bounds. Also guards against prompt-injection
 * by rejecting comment bodies whose lines do not start with a recognized
 * comment marker for the target language.
*/
function parseAndValidate(textResponse, mode) {
    let cleanText = textResponse.trim();
    // LLMs often wrap JSON in markdown fences or explanatory text; recover the array by slicing between first '[' and last ']' [ds]
    const start = cleanText.indexOf('[');
    const end = cleanText.lastIndexOf(']');
    if (start !== -1) {
        if (end !== -1 && end >= start) {
            cleanText = cleanText.substring(start, end + 1);
        } else {
            const lastBrace = cleanText.lastIndexOf('}');
            // Truncated response: no closing ']' but we have a '}' — attempt to repair by appending the missing bracket [ds]
            if (lastBrace > start) {
                cleanText = cleanText.substring(start, lastBrace + 1) + ']';
            }
        }
    }

    let parsed;
    try {
        parsed = JSON.parse(cleanText);
    } catch (e) {
        throw new Error(`Parsing Error: Failed to parse LLM response as JSON. Raw response was:\n${textResponse}`);
    }

    if (!Array.isArray(parsed)) {
        throw new Error("Schema Error: LLM response is not a JSON array.");
    }

    for (const item of parsed) {
        if (typeof item !== 'object' || item === null) {
            throw new Error("Schema Error: Array elements must be objects.");
        }
        if (!Number.isInteger(item.line) || item.line <= 0) {
            throw new Error("Schema Error: 'line' must be a positive integer.");
        }

        // Clean mode requests deletions rather than comment text, so only validate the action field [ds]
        if (mode === 'clean') {
            if (item.action !== 'delete') {
                throw new Error("Schema Error: 'action' must be 'delete' in clean mode.");
            }
        } else {
            if (typeof item.comment !== 'string') {
                throw new Error("Schema Error: 'comment' must be a string.");
            }

            const trimmedComment = item.comment.trim();
            // Sanitize comment text against all syntax-breaking sequences for all 22 supported languages.
            // Handles `*/` inside block comments, `-->` inside HTML comments, and newline injection in single-line comments. [ds]
            item.comment = sanitizeCommentText(item.comment);
            const commentLines = trimmedComment.split(/\r?\n/);
            // Track multi-line block comments (/* ... */ or <!-- ... -->) so their interior lines are not checked for comment markers [ds]
            let inBlock = false;
            for (const cl of commentLines) {
                const tcl = cl.trim();
                if (!tcl) continue;
                if (inBlock) {
                    if (tcl.includes('*/') || tcl.includes('-->')) {
                        inBlock = false;
                    }
                    continue;
                }
                const startsWithMarker = 
                    tcl.startsWith('//') || 
                    tcl.startsWith('/*') || 
                    tcl.startsWith('*') || 
                    tcl.startsWith('#') || 
                    tcl.startsWith('<!--') || 
                    tcl.startsWith('--');
                if (!startsWithMarker) {
                    throw new Error(`Security Error: Comment on line ${item.line} contains invalid non-comment line: "${tcl}"`);
                }
                // Enter block-comment mode when an opener appears on a line without a matching closer [ds]
                if ((tcl.startsWith('/*') && !tcl.includes('*/')) || (tcl.startsWith('<!--') && !tcl.includes('-->'))) {
                    inBlock = true;
                }
            }
        }
    }

    return parsed;
}

// ─── Core Public API ──────────────────────────────────────────────────────────

/**
 * Extracts a lightweight structural skeleton from source code using regex only.
 * Captures imports, top-level function/class declarations, and exports.
 * Deliberately avoids AST parsing to preserve zero runtime dependencies.
 * @param {string} code - Full source code of the file.
 * @returns {string} Compact multi-line skeleton string, or empty string if nothing found.
 */
/** [ds]
 * Builds a lightweight file outline using regex only (no AST).
 * The skeleton is injected into prompts to give the model structural context
 * about the file without shipping a parser dependency. Each entry is truncated
 * to 80 chars to keep the prompt within token budgets.
*/
function buildFileSkeleton(code) {
    const lines = code.split(/\r?\n/);
    const imports = [];
    const declarations = [];
    const exports = [];

    for (const line of lines) {
        const t = line.trim();

        // ── Imports ───────────────────────────────────────────────────────────
        // JS/TS: CommonJS require() [ds]
        if (/^(const|let|var)\s+.+\s*=\s*require\s*\(/.test(t)) {
            imports.push(t.slice(0, 80));
        // JS/TS ES6 + Java/C#/Swift/Kotlin/Dart: import ... [ds]
        } else if (/^import\s+/.test(t)) {
            imports.push(t.slice(0, 80));
        // Python: import X  /  from X import Y [ds]
        } else if (/^from\s+\S+\s+import\s+/.test(t)) {
            imports.push(t.slice(0, 80));
        // Go: import "pkg" or import ( block opener [ds]
        } else if (/^import\s+"/.test(t) || /^import\s+\(/.test(t)) {
            imports.push(t.slice(0, 80));
        // PHP: use Namespace\Class [ds]
        } else if (/^use\s+[\w\\]+/.test(t)) {
            imports.push(t.slice(0, 80));
        // Ruby: require / require_relative [ds]
        } else if (/^require(_relative)?\s+['"]/.test(t)) {
            imports.push(t.slice(0, 80));

        // ── Exports ───────────────────────────────────────────────────────────
        // JS/TS: module.exports and named ES6 exports; checked before declarations so `export function foo` is caught here [ds]
        } else if (/^module\.exports/.test(t) || /^export\s+(default\s+)?/.test(t)) {
            exports.push(t.slice(0, 80));

        // ── Declarations ──────────────────────────────────────────────────────
        // JS/TS: async function foo / function foo / class Foo [ds]
        } else if (/^(async\s+)?function\s+\w+/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        // JS/TS class (no colon after name — avoids matching Python `class Foo:`) [ds]
        } else if (/^class\s+\w+/.test(t) && !/^class\s+\w+.*:/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        // Python: def foo / async def foo / class Foo: [ds]
        } else if (/^(async\s+)?def\s+\w+/.test(t) || /^class\s+\w+.*:/.test(t)) {
            declarations.push(t.replace(/:.*$/, '').trim().slice(0, 80));
        // Go: func Foo() / func (r Receiver) Foo() [ds]
        } else if (/^func\s+/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        // Rust: pub fn foo / async fn foo / fn foo [ds]
        } else if (/^(pub(\s*\([^)]*\))?\s+)?(async\s+)?fn\s+\w+/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        // Java / C# / C / C++: visibility/return-type + name + paren (method signatures) [ds]
        } else if (/^(public|private|protected|internal|static|override|virtual|abstract|inline|extern)\s+.+\s+\w+\s*\(/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        // Ruby: def foo / def self.foo [ds]
        } else if (/^def\s+(self\.)?\w+/.test(t)) {
            declarations.push(t.trim().slice(0, 80));
        // PHP: function foo / public function foo [ds]
        } else if (/^(public|private|protected|static|abstract|\s)*function\s+\w+/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        // Kotlin: fun foo / suspend fun foo [ds]
        } else if (/^(suspend\s+)?fun\s+\w+/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        // Swift: func foo / mutating func / static func [ds]
        } else if (/^(mutating\s+|static\s+|class\s+|open\s+|public\s+|private\s+|internal\s+)?func\s+\w+/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        // Dart: return-type + name + paren (e.g. `void main()`, `Widget build(`) [ds]
        } else if (/^(void|int|String|bool|double|Widget|List|Map|dynamic)\s+\w+\s*\(/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        // Shell: function foo { / foo() { [ds]
        } else if (/^function\s+\w+\s*\{?/.test(t) || /^\w+\s*\(\s*\)\s*\{?/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        }
    }

    const parts = [];
    if (imports.length)      parts.push(`// file-imports: ${imports.join(' | ')}`);
    if (declarations.length) parts.push(`// file-defines: ${declarations.join(' | ')}`);
    if (exports.length)      parts.push(`// file-exports: ${exports.slice(0, 3).join(' | ')}`);
    // Returns empty string for languages with no matched patterns — never garbage [ds]
    return parts.join('\n');
}

/**
 * Fetch and validate AI-generated comments for a source file.
 * Automatically chunks files exceeding CHUNK_THRESHOLD lines into
 * overlapping windows, processes them with adaptive concurrency,
 * and deduplicates comments across chunk boundaries.
 * @param {string} code - Full source code of the file.
 * @param {string} language - Filename or language identifier.
 * @param {object} config - Provider configuration.
 * @param {string} mode - Documentation mode ('default', 'light', 'full', 'clean').
 * @param {string} [projectContext=''] - One-line project fingerprint from package.json/README.
 * @returns {Promise<Array>} Array of validated comment objects with global line numbers.
 */
/** [ds]
 * Top-level entry point: fetch and validate AI-generated comments for a file.
 * Small files are processed in a single request; large files are split into
 * overlapping chunks to stay under model context limits and merged afterward.
 * Overlap prevents comments from being lost at chunk boundaries, and dedupe
 * by line number ensures at most one comment per source line.
*/
async function getComments(code, language, config, mode = 'default', projectContext = '') {
    const lines = code.split(/\r?\n/);
    const { size: CHUNK_SIZE, overlap: CHUNK_OVERLAP, threshold: CHUNK_THRESHOLD } = getChunkConfig(config);

    const fileSkeleton = buildFileSkeleton(code);
    const fullProjectContext = [projectContext, fileSkeleton].filter(Boolean).join('\n');

    // Small header snippet is prepended to every chunk prompt so the model retains awareness of imports/file-level declarations beyond the current window [ds]
    const contextLinesCount = Math.min(25, lines.length);
    const contextSnippet = lines.slice(0, contextLinesCount).map((line, i) => `${i + 1}: ${line}`).join('\n');

    if (lines.length <= CHUNK_THRESHOLD) {
        const numberedCode = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
        const prompt = buildPrompt(numberedCode, language, mode, '', fullProjectContext);
        const [textResponse] = await runWithConcurrency([prompt], p => fetchFromProvider(p, config));
        return parseAndValidate(textResponse, mode);
    }

    const chunks = [];
    // Advance by (CHUNK_SIZE - CHUNK_OVERLAP) so consecutive chunks share the overlap region; termination check prevents an extra empty chunk when the last end hits EOF [ds]
    for (let start = 0; start < lines.length; start += (CHUNK_SIZE - CHUNK_OVERLAP)) {
        const end = Math.min(start + CHUNK_SIZE, lines.length);
        chunks.push({ start, end });
        if (end >= lines.length) break;
    }

    const chunkResults = await runWithConcurrency(chunks, async (chunk) => {
        // Global 1-indexed line numbers require converting the chunk's 0-indexed start; all downstream filtering compares against this base. [ds]
        const chunkLines = lines.slice(chunk.start, chunk.end);
        const startLineNum = chunk.start + 1;
        const numberedCode = chunkLines.map((line, i) => `${startLineNum + i}: ${line}`).join('\n');
        // Only prepend the header snippet for chunks past the first, since the first chunk already contains those lines [ds]
        const contextForChunk = chunk.start > 0 ? contextSnippet : '';
        const prompt = buildPrompt(numberedCode, language, mode, contextForChunk, fullProjectContext);
        const textResponse = await fetchFromProvider(prompt, config);
        const parsed = parseAndValidate(textResponse, mode);
        // Discard any comments the model hallucinated outside the current chunk's line range (e.g. from the prepended context snippet) [ds]
        return parsed.filter(c => c.line >= startLineNum && c.line < startLineNum + chunkLines.length);
    });

    // Deduplicate across chunk boundaries: overlapping windows may yield the same comment line twice; first occurrence wins [ds]
    const seenLines = new Set();
    const allComments = [];
    for (const chunkComments of chunkResults) {
        for (const c of chunkComments) {
            if (!seenLines.has(c.line)) {
                seenLines.add(c.line);
                allComments.push(c);
            }
        }
    }

    return allComments;
}

module.exports = { 
    getComments, 
    runWithConcurrency, 
    resetConcurrency, 
    getChunkConfig, 
    PROVIDER_PROFILES, 
    setDiscoveredTierLimit, 
    sanitizeCommentText,
    CHUNK_SIZE, 
    CHUNK_OVERLAP, 
    CHUNK_THRESHOLD 
};