/** [ds]
 * Fetches a URL with automatic retry using exponential backoff.
 * Rate limit (429) errors are re-thrown immediately so callers can apply
 * higher-level throttling; 4xx client errors are returned as-is (no retry),
 * while 5xx server errors and network/timeout failures are retried up to
 * maxRetries times. A 45s AbortController timeout guards each attempt.
*/
async function fetchWithRetry(url, options, maxRetries = 3, initialDelay = 1000) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        // Fresh AbortController per attempt so a prior timeout does not poison retries [ds]
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
                // Opportunistically harvest provider-advertised token limits from response headers to enable dynamic tier scaling [ds]
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
            // 429 is propagated to the caller (not retried here) so the concurrency controller can globally throttle [ds]
            if (response.status === 429) {
                const err = new Error(`HTTP Error 429: ${response.statusText || 'Too Many Requests'}`);
                err.isRateLimit = true;
                throw err;
            }
            // Retry only transient server errors; other 4xx responses are terminal and returned to caller [ds]
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

        // Exponential backoff (initialDelay * 2^attempt); skip delay after the final attempt [ds]
        if (attempt < maxRetries - 1) {
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
/** [ds]
 * Per-provider chunking profiles tuned to each API's safe free-tier limits.
 * Size/overlap are measured in lines; threshold triggers a fresh chunk;
 * maxTokens caps the model context window for each provider.
*/
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
/** [ds]
 * Resolves effective chunk parameters for a provider, honoring explicit
 * config overrides. When response headers previously revealed a high-tier
 * limit (>100k TPM), chunk sizes are scaled up 1.5x (capped) unless the
 * user explicitly pinned chunkSize.
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
    // Only auto-scale when the user hasn't manually overridden the chunk size [ds]
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
// Shared adaptive state: a 429 anywhere flips the whole run into serial mode [ds]
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

/**
 * Zero-dependency promise pool that respects the adaptive concurrency limit.
 * If a task throws a 429 RateLimitError, concurrency is reduced to 1 for
 * the remainder of the run, and the failed task is retried after a backoff.
 * @param {Array} items - Items to process.
 * @param {Function} taskFn - Async function to run per item.
 * @returns {Promise<Array>} - Resolved results in order.
 */
/** [ds]
 * Runs async tasks through a bounded pool. On a 429 RateLimitError, the
 * controller permanently reduces concurrency to 1 for the rest of the run
 * and retries the failed task with exponential backoff (jittered).
 * Preserves input ordering in the returned results array.
*/
async function runWithConcurrency(items, taskFn) {
    const results = [];
    const executing = new Set();

    for (let i = 0; i < items.length; i++) {
        const item = items[i];

        // Backpressure: wait until a slot frees up before launching the next task [ds]
        while (executing.size >= _concurrencyLimit) {
            await Promise.race(executing);
        }

        // Self-retry loop wraps each task so a single 429 doesn't abort the whole batch [ds]
        const task = (async () => {
            const maxRetries = 3;
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    return await taskFn(item);
                } catch (err) {
                    if (err.isRateLimit && attempt < maxRetries - 1) {
                        if (!_hitRateLimit) {
                            _hitRateLimit = true;
                            // Global throttle: first 429 in the run drops concurrency to serial for all remaining tasks [ds]
                            _concurrencyLimit = 1;
                            console.warn(`[devsplain] Rate limit hit — switching to serial mode.`);
                        }
                        // Use a short backoff under test to keep suites fast; add jitter to avoid thundering herd [ds]
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
        // Attach the removal handler to the tracked promise so the slot frees once the task settles [ds]
        tracked = task.finally(() => {
            executing.delete(tracked);
        });
        // Swallow rejection on the tracked promise to avoid unhandled rejection warnings; callers see it via results [ds]
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
 * Assembles a mode-aware prompt instructing the LLM to emit strictly a JSON
 * array of { line, comment } objects, using language-appropriate comment
 * tokens. Includes anti-triviality rules and optional context to disambiguate.
*/
function buildPrompt(numberedCode, language, mode, contextSnippet = '') {
    // Derive language from file extension since callers may pass a path or a bare identifier. [ds]
    const extMatch = language.match(/\.[0-9a-z]+$/i);
    const ext = extMatch ? extMatch[0].toLowerCase() : '';
    const isPython = ext === '.py';
    // Ruby and shell both share the '#' comment syntax [ds]
    const isRubyOrShell = ['.rb', '.sh'].includes(ext);
    const isHTML = ['.html', '.vue', '.svelte'].includes(ext);
    const isCss = ['.css', '.scss'].includes(ext);
    const isSql = ext === '.sql';
    // Default comment syntax assumes C-style languages; overridden per detected extension below. [ds]
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

    // 'light' and 'full' modes reuse the same scaffolding but swap the core instruction string. [ds]
    let instruction = `Provide block comments above functions and sparse inline comments for complex logic.`;
    if (mode === 'light') {
        instruction = `Provide ONLY block comments above functions. Keep it minimal.`;
    } else if (mode === 'full') {
        instruction = `Provide highly detailed block comments above functions, and exhaustive step-by-step inline comments explaining every conditional branch, loop, variable assignment, and logical block inside function bodies. Do not be sparse; explain the code's execution flow in detail.`;
    }

    // Rule 5 must be language-aware: CSS forbids //, while most other languages forbid # or <!-- as a primary comment marker. [ds]
    let rule5 = `5. IMPORTANT: Use ONLY ${singleLineToken} for comments. DO NOT use docstrings or multi-line string literals like """ or ''' for comments.`;
    // SCSS technically allows //, but we force /* */ to keep the prompt safe for plain CSS output. [ds]
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

    // Context lines are included for semantic grounding only; the model is instructed not to emit comments for them. [ds]
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
 * Dispatches the prompt to the active provider (Gemini, Claude, or OpenAI-compatible)
 * and normalizes the provider-specific response envelope into a single string.
 * Rate-limit errors are re-thrown unmodified so callers can apply backoff.
*/
async function fetchFromProvider(prompt, config) {
    let textResponse = "";

    if (config.provider === 'gemini') {
        // Gemini is the only provider that takes the API key in the query string rather than a header. [ds]
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
        } catch (error) {
            // Preserve rate-limit errors so upstream retry logic can detect and handle them. [ds]
            if (error.isRateLimit) throw error;
            throw new Error(`AI Provider Request Failed: ${error.message}`);
        }
        // Gemini may return errors either as a structured object or a raw string; normalize both. [ds]
        if (data.error) {
            const msg = data.error.message || (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
            throw new Error(`API Error: ${msg}`);
        }
        // Defensive deep-path check: Gemini can return 200 with empty candidates (e.g. safety blocks). [ds]
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts || !data.candidates[0].content.parts[0]) {
            // finishReason distinguishes safety blocks from genuinely empty responses for better diagnostics. [ds]
            const reason = data.candidates?.[0]?.finishReason || 'Unknown error';
            throw new Error(`AI Provider returned no content (finish reason: ${reason})`);
        }
        textResponse = data.candidates[0].content.parts[0].text;
    } else if (config.provider === 'claude') {
        // Anthropic endpoint and API version are pinned to the stable Messages API. [ds]
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
                    // Anthropic requires an explicit max_tokens; 8192 covers large multi-function chunks. [ds]
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
    else {
        // Fallback path assumes OpenAI-compatible /chat/completions schema (OpenAI, Groq, Ollama, etc.). [ds]
        const url = `${config.baseUrl}/v1/chat/completions`;
        let data;

        const reqBody = { 
            "model": config.model, 
            "messages": [{ 
                "role": "user", 
                "content": prompt 
            }] 
        };
        // Provider-specific token limits vary; getChunkConfig caps output to avoid truncation mid-JSON. [ds]
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
        // Verify the nested response shape before accessing content, since some providers return null choices. [ds]
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
 * Parses raw LLM output into a validated comment array. LLMs frequently wrap JSON in prose or
 * markdown fences, so we defensively locate the outermost '[' ... ']' substring before parsing.
 * If the closing ']' is missing (truncated output), we attempt to repair by appending ']' after
 * the last '}' — a heuristic that recovers the common case of a cut-off JSON array.
 * Also enforces that every returned comment is actually comment-shaped (starts with a known
 * comment marker), preventing prompt-injection payloads from being injected as executable code.
*/
function parseAndValidate(textResponse, mode) {
    let cleanText = textResponse.trim();
    // Heuristic extraction: bracketed substring allows recovery even when LLM prefixes/suffixes with prose [ds]
    const start = cleanText.indexOf('[');
    const end = cleanText.lastIndexOf(']');
    if (start !== -1) {
        if (end !== -1 && end >= start) {
            cleanText = cleanText.substring(start, end + 1);
        } else {
            // Truncated-array repair: closing bracket was cut off mid-stream; synthesize one after the final object [ds]
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

        if (mode === 'clean') {
            if (item.action !== 'delete') {
                throw new Error("Schema Error: 'action' must be 'delete' in clean mode.");
            }
        } else {
            if (typeof item.comment !== 'string') {
                throw new Error("Schema Error: 'comment' must be a string.");
            }

            const trimmedComment = item.comment.trim();
            // Multi-line comment validation state machine: detect entering/exiting /* ... */ and <!-- ... --> blocks [ds]
            const commentLines = trimmedComment.split(/\r?\n/);
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
                // Whitelist of comment-start markers; anything else is treated as an injection attempt [ds]
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
                // Block-comment openers without a same-line closer enter block mode; subsequent lines are exempt from marker checks [ds]
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
 * Entry point: obtains AI-generated comments for an entire source file.
 * Files under CHUNK_THRESHOLD are sent in a single request. Larger files are split into
 * overlapping windows (CHUNK_SIZE with CHUNK_OVERLAP) so that cross-boundary context is
 * preserved at chunk seams. Each chunk is processed with global line numbers baked into the
 * prompt, then results are filtered to the chunk's own range and deduplicated by line —
 * the dedup step is required because overlap means a comment may be returned by two chunks.
*/
async function getComments(code, language, config, mode = 'default') {
    const lines = code.split(/\r?\n/);
    const { size: CHUNK_SIZE, overlap: CHUNK_OVERLAP, threshold: CHUNK_THRESHOLD } = getChunkConfig(config);

    // Prepend the file header to every non-first chunk as additional context, capped at 25 lines to bound prompt size [ds]
    const contextLinesCount = Math.min(25, lines.length);
    const contextSnippet = lines.slice(0, contextLinesCount).map((line, i) => `${i + 1}: ${line}`).join('\n');

    if (lines.length <= CHUNK_THRESHOLD) {
        const numberedCode = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
        const prompt = buildPrompt(numberedCode, language, mode);
        const [textResponse] = await runWithConcurrency([prompt], p => fetchFromProvider(p, config));
        return parseAndValidate(textResponse, mode);
    }

    const chunks = [];
    // Stride is (size - overlap) so consecutive windows share CHUNK_OVERLAP lines at their boundaries [ds]
    for (let start = 0; start < lines.length; start += (CHUNK_SIZE - CHUNK_OVERLAP)) {
        const end = Math.min(start + CHUNK_SIZE, lines.length);
        chunks.push({ start, end });
        if (end >= lines.length) break;
    }

    const chunkResults = await runWithConcurrency(chunks, async (chunk) => {
        const chunkLines = lines.slice(chunk.start, chunk.end);
        // Line numbers in the prompt are absolute (1-indexed) so returned comments need no offset translation [ds]
        const startLineNum = chunk.start + 1;
        const numberedCode = chunkLines.map((line, i) => `${startLineNum + i}: ${line}`).join('\n');
        const contextForChunk = chunk.start > 0 ? contextSnippet : '';
        const prompt = buildPrompt(numberedCode, language, mode, contextForChunk);
        const textResponse = await fetchFromProvider(prompt, config);
        const parsed = parseAndValidate(textResponse, mode);
        // Discard hallucinated lines outside this chunk's range; overlap duplicates are resolved during dedup below [ds]
        return parsed.filter(c => c.line >= startLineNum && c.line < startLineNum + chunkLines.length);
    });

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