/** [ds]
 * Fetches a URL with automatic retry and exponential backoff for transient failures.
 * Uses AbortController + setTimeout to enforce a hard 45s per-attempt timeout, since
 * native fetch has no built-in timeout. 429 (rate limit) errors are tagged and
 * re-thrown immediately without retry (caller-level backoff expected). 5xx responses
 * are treated as retriable; other non-ok responses are returned as-is so the caller
 * can inspect the status. Retries use exponential backoff starting at initialDelay.
 * On final failure, throws the last captured error.
*/
async function fetchWithRetry(url, options, maxRetries = 3, initialDelay = 1000) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const controller = new AbortController();
        // Bridge fetch's lack of timeout support with an abort signal that fires after 45s [ds]
        const timeoutId = setTimeout(() => controller.abort(), 45000);
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            // Defensive guard: some fetch polyfills/mocks may resolve with a falsy value [ds]
            if (!response) {
                throw new Error("No response received from fetch");
            }
            if (response.ok) {
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
            // Rate-limit (429) is a distinct signal for the concurrency controller upstream, [ds]
            // so tag it and bail out immediately rather than consuming remaining retries here [ds]
            if (response.status === 429) {
                const err = new Error(`HTTP Error 429: ${response.statusText || 'Too Many Requests'}`);
                err.isRateLimit = true;
                throw err;
            }
            // Only 5xx server errors are retriable; 4xx and 3xx are returned to the caller [ds]
            // so they can decide how to react (e.g. auth, redirects, not-found) [ds]
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
            // Distinguish user-initiated/our-timeout aborts from real network errors so the [ds]
            // retry log message is meaningful for debugging [ds]
            if (err.name === 'AbortError') {
                lastError = new Error("Request timed out after 45 seconds");
            } else {
                lastError = err;
            }
        }

        // Skip the sleep on the final iteration — no point waiting before giving up [ds]
        if (attempt < maxRetries - 1) {
            // Classic exponential backoff: delay doubles each attempt (1s, 2s, 4s...) [ds]
            const backoffDelay = initialDelay * Math.pow(2, attempt);
            console.warn(`[devsplain] AI request failed. Retrying in ${backoffDelay}ms... (Attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
        }
    }
    throw lastError;
}

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
function getChunkConfig(config = {}) {
    const provider = (config.provider || '').toLowerCase();
    const base = PROVIDER_PROFILES[provider] || PROVIDER_PROFILES.default;

    let size = config.chunkSize || base.size;
    let overlap = config.chunkOverlap || base.overlap;
    let threshold = config.chunkThreshold || base.threshold;
    const maxTokens = base.maxTokens;

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

// ─── Adaptive Concurrency Controller ──────────────────────────────────────────
// Module-level adaptive state: shared across all runWithConcurrency invocations
// within a single run so a 429 on one task throttles all subsequent tasks.
let _concurrencyLimit = 2;
let _hitRateLimit = false;

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
 * If any task throws a 429 RateLimitError, the shared concurrency limit is
 * permanently reduced to 1 (serial mode) and the failing task is retried with
 * exponential backoff plus jitter. Results are returned in the original input
 * order. Tasks are wrapped so that rejections don't produce unhandled-promise
 * warnings while other tasks are still in flight.
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

        // Block until the pool has capacity — Promise.race resolves as soon as ANY [ds]
        // in-flight task settles, freeing a slot for the next item [ds]
        while (executing.size >= _concurrencyLimit) {
            await Promise.race(executing);
        }

        const task = (async () => {
            const maxRetries = 3;
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    return await taskFn(item);
                } catch (err) {
                    // On rate limit, flip the global switch to serial mode exactly once (guard [ds]
                    // prevents log spam and redundant writes when many tasks surface 429s together) [ds]
                    if (err.isRateLimit && attempt < maxRetries - 1) {
                        if (!_hitRateLimit) {
                            _hitRateLimit = true;
                            _concurrencyLimit = 1;
                            console.warn(`[devsplain] Rate limit hit — switching to serial mode.`);
                        }
                        // Jitter (Math.random) avoids thundering-herd retries; shortened in tests to [ds]
                        // keep the suite fast [ds]
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
        // Self-referential finally handler: `tracked` is captured after assignment so [ds]
        // the Set entry is removed exactly when this task settles, regardless of outcome [ds]
        tracked = task.finally(() => {
            executing.delete(tracked);
        });
        // Attach a no-op catch so a rejection here doesn't crash the process before [ds]
        // Promise.all at the end observes it [ds]
        tracked.catch(() => {});
        executing.add(tracked);
        results.push(tracked);
    }
    return Promise.all(results);
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

/** [ds]
 * Build the LLM prompt for a block of numbered code lines.
 * Chooses comment tokens and examples based on the file extension, because
 * templates that show the wrong comment syntax (e.g. `//` for Python) produce
 * unusable output. Mode selects between sparse and exhaustive commenting.
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
function buildPrompt(numberedCode, language, mode, contextSnippet = '') {
    // Extract the extension (e.g. ".py") from the filename to pick a comment style; [ds]
    // code paths without an extension fall through to the default // syntax [ds]
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

    let instruction = `Provide block comments above functions and sparse inline comments for complex logic.`;
    if (mode === 'light') {
        instruction = `Provide ONLY block comments above functions. Keep it minimal.`;
    } else if (mode === 'full') {
        instruction = `Provide highly detailed block comments above functions, and exhaustive step-by-step inline comments explaining every conditional branch, loop, variable assignment, and logical block inside function bodies. Do not be sparse; explain the code's execution flow in detail.`;
    }

    // Rule 5 is language-sensitive: the base case uses the detected single-line token, [ds]
    // but CSS forbids `//` entirely, so it gets a hardcoded /* ... */ variant instead [ds]
    let rule5 = `5. IMPORTANT: Use ONLY ${singleLineToken} for comments. DO NOT use docstrings or multi-line string literals like """ or ''' for comments.`;
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

    const contextBlock = contextSnippet ? `
Top-of-file context (for semantic reference only; DO NOT generate comments for these reference lines):
${contextSnippet}
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
 * Dispatches a prompt to the configured AI provider and normalizes the response
 * into plain text. Each provider has a different wire format:
 *  - Gemini uses API-key query param + `contents[].parts[].text` response shape.
 *  - Claude (Anthropic) requires the `x-api-key` header plus a version pin, and
 *    returns `content[].text`.
 *  - OpenAI-compatible (default: openai, groq, etc.) use Bearer auth and
 *    `choices[].message.content`. Groq caps max_tokens at 1000 to avoid its
 *    per-request limit; other providers use 8192 to allow longer responses.
 *
 * All providers share the same failure surface: rate-limit errors are re-thrown
 * unchanged (so the retry layer can react), transport errors are wrapped, and
 * provider-level error envelopes or malformed response shapes are converted
 * into thrown Errors with descriptive messages to surface the root cause.
*/
async function fetchFromProvider(prompt, config) {
    let textResponse = "";

    // Gemini branch: API key is passed as a query string parameter (Google's convention) rather than an Authorization header. [ds]
    if (config.provider === 'gemini') {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
        let data;
        try {
            // fetchWithRetry handles transient failures/rate limits with backoff; don't retry here. [ds]
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
        } catch (error) {
            // Preserve rate-limit errors so upstream retry logic can detect them via the isRateLimit flag. [ds]
            if (error.isRateLimit) throw error;
            throw new Error(`AI Provider Request Failed: ${error.message}`);
        }
        // Gemini returns errors in-band as a top-level `error` object even on HTTP 200 in some cases; must be checked explicitly. [ds]
        if (data.error) {
            const msg = data.error.message || (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
            throw new Error(`API Error: ${msg}`);
        }
        // Defensive deep-shape check: the response nesting is famously easy to get wrong, so verify each level exists before indexing. When content is missing, surface the finishReason (e.g. SAFETY, MAX_TOKENS) to aid debugging. [ds]
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts || !data.candidates[0].content.parts[0]) {
            const reason = data.candidates?.[0]?.finishReason || 'Unknown error';
            throw new Error(`AI Provider returned no content (finish reason: ${reason})`);
        }
        textResponse = data.candidates[0].content.parts[0].text;
    // Anthropic/Claude branch: baseUrl is user-supplied (supports proxies/gateways) and the API version header is mandated by Anthropic. [ds]
    } else if (config.provider === 'claude') {
        const url = `${config.baseUrl}/v1/messages`;
        let data;
        try {
            const response = await fetchWithRetry(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': config.apiKey,
                    // Pinned Anthropic API version required for deterministic request/response schema. [ds]
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    "model": config.model,
                    // Anthropic requires an explicit max_tokens; 8192 matches Sonnet's ceiling. [ds]
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
        // Claude's content is an array of blocks; only the first text block is consumed here. [ds]
        if (!data.content || !data.content[0] || typeof data.content[0].text !== 'string') {
            throw new Error(`AI Provider returned an unexpected response structure: ${JSON.stringify(data)}`);
        }
        textResponse = data.content[0].text;
    } 
    // Default branch: OpenAI-compatible endpoints (openai, groq, openrouter, local proxies, etc.) all share the chat-completions schema. [ds]
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
        // Validate the full path down to a string content field to avoid downstream `.trim()` crashes on undefined. [ds]
        if (!data.choices || !data.choices[0] || !data.choices[0].message || typeof data.choices[0].message.content !== 'string') {
            throw new Error(`AI Provider returned an unexpected response structure: ${JSON.stringify(data)}`);
        }
        textResponse = data.choices[0].message.content;
    }

    return textResponse;
}

// ─── Response Parser & Validator ──────────────────────────────────────────────

/**
 * Parse, validate, and sanitize the raw text response from the AI provider.
 * @param {string} textResponse - Raw text from the AI.
 * @param {string} mode - Documentation mode.
 * @returns {Array} Validated array of comment objects.
 */
/** [ds]
 * Parses the raw model output into a validated array of annotation objects.
 *
 * Models frequently wrap JSON in prose or markdown fences, so this first
 * isolates the outermost bracketed JSON region via string slicing rather than
 * regex, which is more robust to stray brackets inside string literals.
 *
 * Recovery heuristics for truncated/preamble-wrapped output:
 *   - If both `[` and a later `]` exist, slice between them.
 *   - If `]` is missing but a `}` exists after `[`, assume the array was
 *     truncated after the last object and synthesize a closing `]`.
 *
 * Schema validation then branches on mode:
 *   - "clean": each item must declare `action: 'delete'`.
 *   - default: each item must carry a string `comment`; the comment body is
 *     scanned line-by-line to ensure block comment delimiters are balanced
 *     (no dangling `/*` or `<!--`), preventing malformed output from being
 *     applied to source files.
 *
 * Any deviation throws a descriptive Error to be surfaced to the user.
*/
function parseAndValidate(textResponse, mode) {
    let cleanText = textResponse.trim();
    // Extract the JSON payload by locating the outermost square brackets — models often prepend "Here is the JSON:" or wrap in markdown fences. [ds]
    const start = cleanText.indexOf('[');
    const end = cleanText.lastIndexOf(']');
    if (start !== -1) {
        if (end !== -1 && end >= start) {
            cleanText = cleanText.substring(start, end + 1);
        } else {
            // Fallback for truncated output that ends mid-array: find the last complete object and append a synthetic closing bracket. [ds]
            const lastBrace = cleanText.lastIndexOf('}');
            if (lastBrace > start) {
                cleanText = cleanText.substring(start, lastBrace + 1) + ']';
            }
        }
    }

    let parsed;
    try {
        // Surface raw text on parse failure so users can diagnose model misbehavior. [ds]
        parsed = JSON.parse(cleanText);
    } catch (e) {
        throw new Error(`Parsing Error: Failed to parse LLM response as JSON. Raw response was:\n${textResponse}`);
    }

    if (!Array.isArray(parsed)) {
        throw new Error("Schema Error: LLM response is not a JSON array.");
    }

    // Per-item validation rejects malformed entries before they reach the file writer. [ds]
    for (const item of parsed) {
        if (typeof item !== 'object' || item === null) {
            throw new Error("Schema Error: Array elements must be objects.");
        }
        // line is 1-indexed against the original source; reject 0/negative to catch off-by-one model errors early. [ds]
        if (!Number.isInteger(item.line) || item.line <= 0) {
            throw new Error("Schema Error: 'line' must be a positive integer.");
        }

        // In clean mode the schema is different: items carry `action` instead of `comment`. [ds]
        if (mode === 'clean') {
            // In clean mode the only valid action is 'delete'; reject anything else to prevent the model from smuggling in additions. [ds]
            if (item.action !== 'delete') {
                throw new Error("Schema Error: 'action' must be 'delete' in clean mode.");
            }
        } else {
            if (typeof item.comment !== 'string') {
                throw new Error("Schema Error: 'comment' must be a string.");
            }

            // Track block-comment state across lines to detect unterminated /* or <!-- blocks that would corrupt output. [ds]
            const trimmedComment = item.comment.trim();
            const commentLines = trimmedComment.split(/\r?\n/);
            // Tracks whether we are currently inside a multi-line block comment (/* ... */ or <!-- ... -->) so inner lines are not required to start with a marker. [ds]
            let inBlock = false;
            for (const cl of commentLines) {
                const tcl = cl.trim();
                if (!tcl) continue;
                // Only inspect while inside a block; otherwise stray delimiters in single-line comments are harmless. [ds]
                if (inBlock) {
                    // Recognize both C-style `*/` and HTML-style `-->` terminators so the same validation works across languages. [ds]
                    if (tcl.includes('*/') || tcl.includes('-->')) {
                        inBlock = false;
                    }
                    continue;
                }
                // Whitelist of legitimate comment line prefixes across common languages (C/JS/SQL/Python/HTML/Shell). This guards against prompt-injection where the model emits arbitrary code disguised as a comment. [ds]
                const startsWithMarker = 
                    tcl.startsWith('//') || 
                    tcl.startsWith('/*') || 
                    tcl.startsWith('*') || 
                    tcl.startsWith('#') || 
                    tcl.startsWith('<!--') || 
                    tcl.startsWith('--');
                // Security gate: a line that doesn't start with any known comment marker means the model injected executable content into the 'comment' field — reject loudly. [ds]
                if (!startsWithMarker) {
                    throw new Error(`Security Error: Comment on line ${item.line} contains invalid non-comment line: "${tcl}"`);
                }
                // Detect the opening of a block comment that does NOT also close on the same line, so subsequent lines can be treated as continuation (skip the marker check on them). [ds]
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
 * Fetch and validate AI-generated comments for a source file.
 * Automatically chunks files exceeding CHUNK_THRESHOLD lines into
 * overlapping windows, processes them with adaptive concurrency,
 * and deduplicates comments across chunk boundaries.
 * @param {string} code - Full source code of the file.
 * @param {string} language - Filename or language identifier.
 * @param {object} config - Provider configuration.
 * @param {string} mode - Documentation mode ('default', 'light', 'full', 'clean').
 * @returns {Promise<Array>} Array of validated comment objects with global line numbers.
 */
/** [ds]
 * Top-level entry point for gathering AI-generated comments for a file.
 *
 * Strategy:
 *   1. If the file fits under CHUNK_THRESHOLD lines, send the whole
 *      line-numbered source in a single LLM round-trip.
 *   2. Otherwise, slide a CHUNK_SIZE-line window forward by
 *      (CHUNK_SIZE - CHUNK_OVERLAP) each step so that comments near window
 *      seams are not missed; overlapping regions are deduplicated later.
 *   3. Chunks are dispatched through runWithConcurrency so the provider's
 *      adaptive rate limiter governs throughput.
 *   4. Results from overlapping chunks are merged using a Set keyed on the
 *      global line number, keeping the first comment seen for any line.
 *
 * The 1-indexed line numbers embedded in the prompt are converted back to
 * real file coordinates by starting each chunk's numbering at chunk.start+1.
 *
 * @param {string} code - Full source text of the file.
 * @param {string} language - Filename or language identifier for the prompt.
 * @param {object} config - Provider configuration (model, keys, etc.).
 * @param {string} mode - Documentation mode; affects the prompt and validator.
 * @returns {Promise<Array>} Validated comment objects with global line numbers.
*/
async function getComments(code, language, config, mode = 'default') {
    const lines = code.split(/\r?\n/);
    const { size: CHUNK_SIZE, overlap: CHUNK_OVERLAP, threshold: CHUNK_THRESHOLD } = getChunkConfig(config);

    // Extract top-of-file context (first 25 lines) to retain imports and module scope for subsequent chunks [ds]
    const contextLinesCount = Math.min(25, lines.length);
    const contextSnippet = lines.slice(0, contextLinesCount).map((line, i) => `${i + 1}: ${line}`).join('\n');

    // Small-file fast path: bypass chunking entirely to save tokens and avoid cross-chunk dedup overhead. [ds]
    if (lines.length <= CHUNK_THRESHOLD) {
        // Prefix each source line with its 1-indexed number so the model can reference exact lines; this is the contract parseAndValidate relies on. [ds]
        const numberedCode = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
        const prompt = buildPrompt(numberedCode, language, mode);
        // Reuse runWithConcurrency even for a single prompt so the concurrency limiter/retry logic is applied uniformly. [ds]
        const [textResponse] = await runWithConcurrency([prompt], p => fetchFromProvider(p, config));
        return parseAndValidate(textResponse, mode);
    }

    const chunks = [];
    // Advance the window by (CHUNK_SIZE - CHUNK_OVERLAP) rather than the full CHUNK_SIZE so adjacent windows overlap by CHUNK_OVERLAP lines — this prevents a comment spanning the boundary from being lost in both chunks. [ds]
    for (let start = 0; start < lines.length; start += (CHUNK_SIZE - CHUNK_OVERLAP)) {
        // Clamp the chunk end to the file length so the final window can be shorter than CHUNK_SIZE. [ds]
        const end = Math.min(start + CHUNK_SIZE, lines.length);
        chunks.push({ start, end });
        // Early-exit once the last window reaches EOF; without this the loop would keep emitting a final partial chunk past the end. [ds]
        if (end >= lines.length) break;
    }

    const chunkResults = await runWithConcurrency(chunks, async (chunk) => {
        const chunkLines = lines.slice(chunk.start, chunk.end);
        // Convert the 0-indexed chunk.start into the 1-indexed line number the model expects, so returned line numbers map to real file positions. [ds]
        const startLineNum = chunk.start + 1;
        const numberedCode = chunkLines.map((line, i) => `${startLineNum + i}: ${line}`).join('\n');
        const contextForChunk = chunk.start > 0 ? contextSnippet : '';
        const prompt = buildPrompt(numberedCode, language, mode, contextForChunk);
        const textResponse = await fetchFromProvider(prompt, config);
        const parsed = parseAndValidate(textResponse, mode);
        // Guard against model emitting comments targeting reference lines from contextSnippet [ds]
        return parsed.filter(c => c.line >= startLineNum && c.line < startLineNum + chunkLines.length);
    });

    // Deduplicate comments produced by overlapping windows: a line that appears in two chunks may be reported twice, so keep only the first occurrence. [ds]
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
    CHUNK_SIZE, 
    CHUNK_OVERLAP, 
    CHUNK_THRESHOLD 
};