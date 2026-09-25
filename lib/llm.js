/** [ds]
 * Fetch wrapper with exponential backoff retry logic.
 * Retries on 5xx server errors and network failures, but fails fast on 429
 * rate-limit responses so callers can apply their own adaptive throttling.
 * Uses AbortController to enforce a 45s timeout per attempt.
*/
async function fetchWithRetry(url, options, maxRetries = 3, initialDelay = 1000) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const controller = new AbortController();
        // Hard 45s ceiling per attempt prevents hung sockets from stalling the whole pipeline [ds]
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
                // Defensive header check: some fetch polyfills/test mocks lack a .get() method [ds]
                if (response.headers && typeof response.headers.get === 'function') {
                    // Capture server-reported token quota so concurrency/chunking can adapt to the actual tier [ds]
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
            // 429s are tagged and re-thrown rather than retried locally; the concurrency layer handles backoff [ds]
            if (response.status === 429) {
                const err = new Error(`HTTP Error 429: ${response.statusText || 'Too Many Requests'}`);
                err.isRateLimit = true;
                throw err;
            }
            // Only 5xx responses are retryable; 4xx (other than 429) are terminal client errors [ds]
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

        // Skip the backoff sleep on the final attempt since no further retry will occur [ds]
        if (attempt < maxRetries - 1) {
            // Exponential backoff: delay doubles each attempt (1s, 2s, 4s, ...) [ds]
            const backoffDelay = initialDelay * Math.pow(2, attempt);
            console.warn(`[devsplain] AI request failed. Retrying in ${backoffDelay}ms... (Attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
        }
    }
    throw lastError;
}

// ─── Provider Profiles for Model-Adaptive Chunking ──────────────────────────── [ds]
// Baseline free-tier safe defaults: preserves token limits for free/low tiers, [ds]
// while expanding window sizes for high-capacity providers (DeepSeek, Gemini, Claude). [ds]
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

// Tracks discovered rate limits from response headers (e.g. x-ratelimit-limit-tokens) [ds]
// Tracks discovered rate limits from response headers (e.g. x-ratelimit-limit-tokens)
let _discoveredTierLimit = null;

// Baseline constants exported for backward compatibility
const CHUNK_SIZE = 200;
const CHUNK_OVERLAP = 20;
const CHUNK_THRESHOLD = 250;

/** [ds]
 * Returns the effective chunking parameters for a provider.
 * Allows override via config (e.g., config.chunkSize from --chunk-size flag)
 * or scaled up dynamically if response headers reveal high tier capacity.
 * @param {object} config - Provider configuration object.
 * @returns {object} { size, overlap, threshold, maxTokens }
*/
/**
 * Returns the effective chunking parameters for a provider.
 * Allows override via config (e.g., config.chunkSize from --chunk-size flag)
 * or scaled up dynamically if response headers reveal high tier capacity.
 * @param {object} config - Provider configuration object.
 * @returns {object} { size, overlap, threshold, maxTokens }
 */
function getChunkConfig(config = {}) {
    const provider = (config.provider || '').toLowerCase();
    const base = PROVIDER_PROFILES[provider] || PROVIDER_PROFILES.default;

    let size = config.chunkSize || base.size;
    let overlap = config.chunkOverlap || base.overlap;
    let threshold = config.chunkThreshold || base.threshold;
    const maxTokens = base.maxTokens;

    // Dynamic Tier Scaling: if response headers revealed a high-tier token limit (>100k TPM), [ds]
    // scale up chunk size safely by 1.5x up to 1000 lines max [ds]
    // Respect explicit user overrides (--chunk-size) rather than silently inflating them [ds]
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
let _concurrencyLimit = 2;
let _hitRateLimit = false;

/** [ds]
 * Reset the adaptive concurrency controller for a new run.
 * @param {number} initialLimit - Starting concurrency level.
*/
/**
 * Reset the adaptive concurrency controller for a new run.
 * @param {number} initialLimit - Starting concurrency level.
 */
function resetConcurrency(initialLimit = 2) {
    _concurrencyLimit = initialLimit;
    _hitRateLimit = false;
    _discoveredTierLimit = null;
}

/** [ds]
 * Zero-dependency promise pool that respects the adaptive concurrency limit.
 * If a task throws a 429 RateLimitError, concurrency is reduced to 1 for
 * the remainder of the run, and the failed task is retried after a backoff.
 * @param {Array} items - Items to process.
 * @param {Function} taskFn - Async function to run per item.
 * @returns {Promise<Array>} - Resolved results in order.
*/
/**
 * Zero-dependency promise pool that respects the adaptive concurrency limit.
 * If a task throws a 429 RateLimitError, concurrency is reduced to 1 for
 * the remainder of the run, and the failed task is retried after a backoff.
 * @param {Array} items - Items to process.
 * @param {Function} taskFn - Async function to run per item.
 * @returns {Promise<Array>} - Resolved results in order.
 */
async function runWithConcurrency(items, taskFn) {
    const results = [];
    const executing = new Set();

    for (let i = 0; i < items.length; i++) {
        const item = items[i];

        // Backpressure: block until an in-flight slot frees up before scheduling the next task [ds]
        while (executing.size >= _concurrencyLimit) {
            await Promise.race(executing);
        }

        const task = (async () => {
            const maxRetries = 3;
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    return await taskFn(item);
                } catch (err) {
                    // Only 429s are retried; other errors propagate immediately to the caller [ds]
                    if (err.isRateLimit && attempt < maxRetries - 1) {
                        // First 429 of the run flips the controller into serial mode globally [ds]
                        if (!_hitRateLimit) {
                            _hitRateLimit = true;
                            _concurrencyLimit = 1;
                            console.warn(`[devsplain] Rate limit hit — switching to serial mode.`);
                        }
                        // Reduced backoff in tests keeps the suite fast; jitter prevents thundering-herd sync [ds]
                        const backoff = (process.env.NODE_ENV === 'test' ? 50 : 2000) * Math.pow(2, attempt) + Math.random() * 500;
                        console.warn(`[devsplain] Backing off for ${Math.round(backoff)}ms...`);
                        await new Promise(r => setTimeout(r, backoff));
                        continue;
                    }
                    throw err;
                }
            }
        })();

        let tracked;
        // Wrap in .finally so the executing set always drains, even on rejection [ds]
        tracked = task.finally(() => {
            executing.delete(tracked);
        });
        // Attach a no-op catch to prevent unhandled rejection warnings; errors surface via Promise.all [ds]
        tracked.catch(() => {});
        executing.add(tracked);
        results.push(tracked);
    }
    return Promise.all(results);
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

/** [ds]
 * Build the LLM prompt for a block of numbered code lines.
 * @param {string} numberedCode - Code with line numbers prepended.
 * @param {string} language - Filename or language identifier.
 * @param {string} mode - Documentation mode ('default', 'light', 'full').
 * @returns {string} The assembled prompt string.
*/
/**
 * Build the LLM prompt for a block of numbered code lines.
 * @param {string} numberedCode - Code with line numbers prepended.
 * @param {string} language - Filename or language identifier.
 * @param {string} mode - Documentation mode ('default', 'light', 'full').
 * @returns {string} The assembled prompt string.
 */
/** [ds]
 * Assembles the LLM prompt sent for a given chunk of code.
 * Dynamically adapts comment syntax examples and rules based on the detected
 * language extension (shebang-style `#` for Python/Ruby/Shell, `<!-- -->`
 * for HTML-family, `/* * /` for CSS, `--` for SQL), because emitting the
 * wrong token (e.g. `//` in Python) would produce invalid comments.
 * @param {string} numberedCode - Code with line numbers prepended.
 * @param {string} language - Filename or language identifier.
 * @param {string} mode - Documentation mode ('default', 'light', 'full').
 * @returns {string} The assembled prompt string.
*/
function buildPrompt(numberedCode, language, mode, contextSnippet = '', projectContext = '') {
    // Extract the file extension to select language-appropriate comment syntax [ds]
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

    // Python/Ruby/Shell use # for single-line comments; HTML/CSS/SQL have their own conventions [ds]
    if (isPython || isRubyOrShell) {
        singleLineToken = '#';
        blockExample = '# Calculates the total price';
        inlineExample = '# Check for null values';
    // HTML-family templating languages share the same comment syntax as HTML. [ds]
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

    let instruction = `Provide block comments above functions and sparse inline comments for complex logic.`;
    if (mode === 'light') {
        instruction = `Provide ONLY block comments above functions. Keep it minimal.`;
    } else if (mode === 'full') {
        instruction = `Provide highly detailed block comments above functions, and exhaustive step-by-step inline comments explaining every conditional branch, loop, variable assignment, and logical block inside function bodies. Do not be sparse; explain the code's execution flow in detail.`;
    }

    let rule5 = `5. IMPORTANT: Use ONLY ${singleLineToken} for comments. DO NOT use docstrings or multi-line string literals like """ or ''' for comments.`;
    // CSS treats `//` as a value token, not a comment; must force /* */ syntax. [ds]
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

    // Both sources are combined and hard-capped at 600 chars (~150 tokens) to protect free-tier rate limits.
    // Both sources are combined and hard-capped at 600 chars (~150 tokens) to protect free-tier rate limits. [ds]
    const MAX_CONTEXT_CHARS = 600;
    let combinedContext = [projectContext, contextSnippet].filter(Boolean).join('\n');
    if (combinedContext.length > MAX_CONTEXT_CHARS) {
        combinedContext = combinedContext.slice(0, MAX_CONTEXT_CHARS);
    }
    // Context is injected as read-only reference only when present, to keep the prompt lean otherwise. [ds]
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
 * Fetch comments for a single chunk of code from the configured AI provider.
 * Normalizes the divergent response shapes of Gemini, Claude, and OpenAI-compatible
 * chat completion APIs into a single raw text string, and validates each shape.
 * @param {string} prompt - The assembled prompt.
 * @param {object} config - Provider config (provider, model, apiKey, baseUrl).
 * @returns {Promise<string>} Raw text response from the AI.
*/
async function fetchFromProvider(prompt, config) {
    let textResponse = "";

    // Gemini embeds the API key in the query string rather than a header. [ds]
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
        // Preserve rate-limit errors so the caller's retry/backoff logic can catch them. [ds]
        } catch (error) {
            if (error.isRateLimit) throw error;
            throw new Error(`AI Provider Request Failed: ${error.message}`);
        }
        if (data.error) {
            const msg = data.error.message || (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
            throw new Error(`API Error: ${msg}`);
        }
        // Deep-guard the nested response path because Gemini may return partial shapes on safety blocks. [ds]
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts || !data.candidates[0].content.parts[0]) {
            const reason = data.candidates?.[0]?.finishReason || 'Unknown error';
            throw new Error(`AI Provider returned no content (finish reason: ${reason})`);
        }
        textResponse = data.candidates[0].content.parts[0].text;
    // Claude requires the anthropic-version header to pin API behavior. [ds]
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
        } catch (error) {
            if (error.isRateLimit) throw error;
            throw new Error(`AI Provider Request Failed: ${error.message}`);
        }
        if (data.error) {
            const msg = data.error.message || (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
            throw new Error(`API Error: ${msg}`);
        }
        if (!data.content || !data.content[0] || typeof data.content[0].text !== 'string') {
            throw new Error(`AI Provider returned an unexpected response structure: ${JSON.stringify(data)}`);
        }
        textResponse = data.content[0].text;
    } 
    // Fallback branch targets OpenAI-compatible endpoints (baseUrl + /v1/chat/completions). [ds]
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
        // max_tokens is provider-specific; delegate to chunkConfig to respect per-model limits. [ds]
        const chunkConfig = getChunkConfig(config);
        reqBody.max_tokens = chunkConfig.maxTokens;

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
        } catch (error) {
            if (error.isRateLimit) throw error;
            throw new Error(`AI Provider Request Failed: ${error.message}`);
        }
        if (data.error) {
            const msg = data.error.message || (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
            throw new Error(`API Error: ${msg}`);
        }
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
/** [ds]
 * Neutralizes syntax-breaking sequences in LLM-generated comments across all 22 supported languages.
 * Rather than rejecting malformed comments, this rewrites interior closing tokens (e.g. `* /`, `-->`)
 * into harmless variants so the outer comment block remains syntactically intact — the final token
 * is preserved because it legitimately closes the intended comment. For single-line styles, embedded
 * newlines are collapsed to prevent the LLM from smuggling executable code onto subsequent lines.
*/
function sanitizeCommentText(comment) {
    if (typeof comment !== 'string') return comment;

    const t = comment.trim();

    // ── Block comments: /* ... */ ─────────────────────────────────────────────
    // Triggered when the comment starts with /* (catches /** JSDoc too).
    // Strategy: split on `*/` and rejoin — every `*/` except the very last is
    // interior (escaping it to `* /`) because JS/Java/C parsers close the block
    // Only the last `*/` legitimately closes the block; every earlier one is interior and must be escaped [ds]
    if (t.startsWith('/*')) {
        const parts = comment.split('*/');
        if (parts.length <= 1) return comment;
        const last = parts.pop();
        return parts.join('* /') + '*/' + last;
    }

    // ── HTML block comments: <!-- ... --> ─────────────────────────────────────
    // Triggered when the comment starts with <!--. Any `-->` before the final
    // one would prematurely close the HTML comment. Escape interior `-->` to
    if (t.startsWith('<!--')) {
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
    // Single-line comments have no closing token, but a newline would end the comment and let LLM-injected code execute [ds]
    if (t.startsWith('//') || t.startsWith('#') || t.startsWith('--')) {
        return comment.replace(/[\r\n]+/g, ' ').trimEnd();
    }

    return comment;
}

// ─── Response Parser & Validator ──────────────────────────────────────────────

/**
 * Parse, validate, and sanitize the raw text response from the AI provider.
 * @param {string} textResponse - Raw text from the AI.
 * @param {string} mode - Documentation mode.
 * @returns {Array} Validated array of comment objects.
 */
function parseAndValidate(textResponse, mode) {
    let cleanText = textResponse.trim();
    // LLMs often wrap JSON in prose or markdown fences; carve out the outermost array by bracket position [ds]
    const start = cleanText.indexOf('[');
    const end = cleanText.lastIndexOf(']');
    if (start !== -1) {
        if (end !== -1 && end >= start) {
            cleanText = cleanText.substring(start, end + 1);
        } else {
            // Recover from truncated responses where the closing `]` was cut off but the last object `}` survived [ds]
            const lastBrace = cleanText.lastIndexOf('}');
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

        // Clean mode permits only deletion directives; annotation mode requires comment text [ds]
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
            item.comment = sanitizeCommentText(item.comment);
            const commentLines = trimmedComment.split(/\r?\n/);
            // Detect whether we are inside a multi-line comment so continuation lines (which may lack a leading marker) are not flagged as injection attempts [ds]
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
                // Every non-blank line outside a block must begin with a recognized comment marker, otherwise an LLM could inject executable code disguised as a comment [ds]
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
function buildFileSkeleton(code) {
    const lines = code.split(/\r?\n/);
    const imports = [];
    const declarations = [];
    const exports = [];

    /** [ds]
     * Scans source lines to extract a compact "skeleton" (imports/declarations/exports)
     * used as cheap project context. Runs many language-specific regex heuristics
     * because it must work across JS/TS/Python/Go/Rust/C#/Java/Kotlin/Swift/Dart
     * without a real parser; each branch targets one language's declaration syntax.
    */
    for (const line of lines) {
        const t = line.trim();

        // ── Imports ───────────────────────────────────────────────────────────
        // Truncate captured lines to 80 chars to keep the skeleton compact for prompting [ds]
        if (/^(const|let|var)\s+.+\s*=\s*require\s*\(/.test(t)) {
            imports.push(t.slice(0, 80));
        } else if (/^import\s+/.test(t)) {
            imports.push(t.slice(0, 80));
        } else if (/^from\s+\S+\s+import\s+/.test(t)) {
            imports.push(t.slice(0, 80));
        } else if (/^import\s+"/.test(t) || /^import\s+\(/.test(t)) {
            imports.push(t.slice(0, 80));
        } else if (/^use\s+[\w\\]+/.test(t)) {
            imports.push(t.slice(0, 80));
        } else if (/^require(_relative)?\s+['"]/.test(t)) {
            imports.push(t.slice(0, 80));

        // ── Exports ───────────────────────────────────────────────────────────
        } else if (/^module\.exports/.test(t) || /^export\s+(default\s+)?/.test(t)) {
            exports.push(t.slice(0, 80));

        // ── Declarations ──────────────────────────────────────────────────────
        } else if (/^(async\s+)?function\s+\w+/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        // Negative lookahead excludes Python-style 'class Foo:' from the C/Java branch [ds]
        } else if (/^class\s+\w+/.test(t) && !/^class\s+\w+.*:/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        } else if (/^(async\s+)?def\s+\w+/.test(t) || /^class\s+\w+.*:/.test(t)) {
            declarations.push(t.replace(/:.*$/, '').trim().slice(0, 80));
        } else if (/^func\s+/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        } else if (/^(pub(\s*\([^)]*\))?\s+)?(async\s+)?fn\s+\w+/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        } else if (/^(public|private|protected|internal|static|override|virtual|abstract|inline|extern)\s+.+\s+\w+\s*\(/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        } else if (/^def\s+(self\.)?\w+/.test(t)) {
            declarations.push(t.trim().slice(0, 80));
        } else if (/^(public|private|protected|static|abstract|\s)*function\s+\w+/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        } else if (/^(suspend\s+)?fun\s+\w+/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        } else if (/^(mutating\s+|static\s+|class\s+|open\s+|public\s+|private\s+|internal\s+)?func\s+\w+/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        } else if (/^(void|int|String|bool|double|Widget|List|Map|dynamic)\s+\w+\s*\(/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        } else if (/^function\s+\w+\s*\{?/.test(t) || /^\w+\s*\(\s*\)\s*\{?/.test(t)) {
            declarations.push(t.replace(/\{.*$/, '').trim().slice(0, 80));
        }
    }

    const parts = [];
    if (imports.length)      parts.push(`// file-imports: ${imports.join(' | ')}`);
    if (declarations.length) parts.push(`// file-defines: ${declarations.join(' | ')}`);
    if (exports.length)      parts.push(`// file-exports: ${exports.slice(0, 3).join(' | ')}`);
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
async function getComments(code, language, config, mode = 'default', projectContext = '') {
    const lines = code.split(/\r?\n/);
    const { size: CHUNK_SIZE, overlap: CHUNK_OVERLAP, threshold: CHUNK_THRESHOLD } = getChunkConfig(config);

    const fileSkeleton = buildFileSkeleton(code);
    const fullProjectContext = [projectContext, fileSkeleton].filter(Boolean).join('\n');

    // Reserve most of the context budget for the file skeleton; keep only a small preview [ds]
    const contextLinesCount = Math.min(25, lines.length);
    const contextSnippet = lines.slice(0, contextLinesCount).map((line, i) => `${i + 1}: ${line}`).join('\n');

    if (lines.length <= CHUNK_THRESHOLD) {
        const numberedCode = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
        const prompt = buildPrompt(numberedCode, language, mode, '', fullProjectContext);
        const [textResponse] = await runWithConcurrency([prompt], p => fetchFromProvider(p, config));
        return parseAndValidate(textResponse, mode);
    }

    // Sliding windows with CHUNK_OVERLAP so constructs spanning boundaries aren't lost [ds]
    const chunks = [];
    for (let start = 0; start < lines.length; start += (CHUNK_SIZE - CHUNK_OVERLAP)) {
        const end = Math.min(start + CHUNK_SIZE, lines.length);
        chunks.push({ start, end });
        if (end >= lines.length) break;
    }

    /** [ds]
     * Process each chunk concurrently. Wraps parse+validate so a single bad
     * chunk doesn't poison the whole run, and filters results to the chunk's
     * own line range to drop hallucinated line numbers outside the window.
    */
    const chunkResults = await runWithConcurrency(chunks, async (chunk) => {
        const chunkLines = lines.slice(chunk.start, chunk.end);
        const startLineNum = chunk.start + 1;
        const numberedCode = chunkLines.map((line, i) => `${startLineNum + i}: ${line}`).join('\n');
        const contextForChunk = chunk.start > 0 ? contextSnippet : '';
        const prompt = buildPrompt(numberedCode, language, mode, contextForChunk, fullProjectContext);
        const textResponse = await fetchFromProvider(prompt, config);
        const parsed = parseAndValidate(textResponse, mode);
        // Clamp to chunk range: model may echo overlapping lines from adjacent chunks [ds]
        return parsed.filter(c => c.line >= startLineNum && c.line < startLineNum + chunkLines.length);
    });

    // Deduplicate by line: overlapping windows can produce duplicate line comments [ds]
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