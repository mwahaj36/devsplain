/** [ds]
 * Sends an HTTP request with automatic retry logic and timeout management.
 * @param {string} url - The target URL.
 * @param {object} options - Fetch options including method, headers, and body.
 * @param {number} maxRetries - Maximum number of retry attempts.
 * @param {number} initialDelay - Initial delay in milliseconds for exponential backoff.
 * @returns {Promise<Response>} - Returns the successful Response object.
 * @throws {Error} Throws a RateLimitError (with .isRateLimit=true) on 429, or the last error after exhausting retries.
*/
async function fetchWithRetry(url, options, maxRetries = 3, initialDelay = 1000) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
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
                return response;
            }
            // Surface 429 rate limits immediately so the adaptive controller can react [ds]
            if (response.status === 429) {
                const err = new Error(`HTTP Error 429: ${response.statusText || 'Too Many Requests'}`);
                err.isRateLimit = true;
                throw err;
            }
            if (response.status >= 500 && response.status < 600) {
                lastError = new Error(`HTTP Error ${response.status}: ${response.statusText}`);
            } else {
                return response;
            }
        } catch (err) {
            clearTimeout(timeoutId);
            // Propagate rate limit errors immediately without retrying [ds]
            if (err.isRateLimit) {
                throw err;
            }
            if (err.name === 'AbortError') {
                lastError = new Error("Request timed out after 45 seconds");
            } else {
                lastError = err;
            }
        }

        if (attempt < maxRetries - 1) {
            const backoffDelay = initialDelay * Math.pow(2, attempt);
            console.warn(`[devsplain] AI request failed. Retrying in ${backoffDelay}ms... (Attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
        }
    }
    throw lastError;
}

// ─── Chunking Constants ───────────────────────────────────────────────────────
const CHUNK_SIZE = 200;
const CHUNK_OVERLAP = 20;
const CHUNK_THRESHOLD = 250;

// ─── Adaptive Concurrency Controller ──────────────────────────────────────────
// Shared mutable state: starts at the requested concurrency and drops to 1 on 429 [ds]
let _concurrencyLimit = 2;
let _hitRateLimit = false;

/**
 * Reset the adaptive concurrency controller for a new run.
 * @param {number} initialLimit - Starting concurrency level.
 */
function resetConcurrency(initialLimit = 2) {
    _concurrencyLimit = initialLimit;
    _hitRateLimit = false;
}

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
function buildPrompt(numberedCode, language, mode) {
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

    let rule5 = `5. IMPORTANT: Use ONLY ${singleLineToken} for comments. DO NOT use docstrings or multi-line string literals like """ or ''' for comments.`;
    if (isCss) {
        rule5 = `5. IMPORTANT: In CSS/SCSS, you MUST use /* ... */ for comments. DO NOT use // comments under any circumstances.`;
    }

    // Anti-triviality negative constraints to eliminate syntax-narrating clutter [ds]
    const antiTrivialityRules = `
ANTI-TRIVIALITY RULES (STRICTLY ENFORCED):
6. NEVER write comments that merely narrate the syntax (e.g. NEVER write "// Loop over items" above a for loop, "// Return result" above a return, "// Increment i" above i++, or "// Define variable" above a declaration).
7. NEVER comment standard variable initializations, obvious assignments, or self-describing code.
8. ONLY write comments where:
   - The WHY or architectural intent is non-obvious.
   - An edge case, security workaround, or regex heuristic is being handled.
   - A tricky formula, index manipulation (e.g. 0-indexed vs 1-indexed), or protocol-specific behavior occurs.
9. Prefer comprehensive function-level block comments over cluttered inline comments. Quality over quantity.`;

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
        } catch (error) {
            // Re-throw rate limit errors so the concurrency controller can catch them [ds]
            if (error.isRateLimit) throw error;
            throw new Error(`AI Provider Request Failed: ${error.message}`);
        }
        if (data.error) {
            const msg = data.error.message || (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
            throw new Error(`API Error: ${msg}`);
        }
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
        const url = `${config.baseUrl}/v1/chat/completions`;
        let data;

        const reqBody = { 
            "model": config.model, 
            "messages": [{ 
                "role": "user", 
                "content": prompt 
            }] 
        };
        if (config.provider === 'groq') {
            reqBody.max_tokens = 1000;
        } else {
            reqBody.max_tokens = 8192;
        }

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

// ─── Response Parser & Validator ──────────────────────────────────────────────

/**
 * Parse, validate, and sanitize the raw text response from the AI provider.
 * @param {string} textResponse - Raw text from the AI.
 * @param {string} mode - Documentation mode.
 * @returns {Array} Validated array of comment objects.
 */
function parseAndValidate(textResponse, mode) {
    let cleanText = textResponse.trim();
    const start = cleanText.indexOf('[');
    const end = cleanText.lastIndexOf(']');
    if (start !== -1) {
        if (end !== -1 && end >= start) {
            cleanText = cleanText.substring(start, end + 1);
        } else {
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
async function getComments(code, language, config, mode = 'default') {
    const lines = code.split(/\r?\n/);

    // Small files: single-shot processing (no chunking overhead) [ds]
    if (lines.length <= CHUNK_THRESHOLD) {
        const numberedCode = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
        const prompt = buildPrompt(numberedCode, language, mode);
        const [textResponse] = await runWithConcurrency([prompt], p => fetchFromProvider(p, config));
        return parseAndValidate(textResponse, mode);
    }

    // Large files: slice into overlapping chunks with global line numbers [ds]
    const chunks = [];
    for (let start = 0; start < lines.length; start += (CHUNK_SIZE - CHUNK_OVERLAP)) {
        const end = Math.min(start + CHUNK_SIZE, lines.length);
        chunks.push({ start, end });
        if (end >= lines.length) break;
    }

    // Process chunks through the adaptive concurrency pool [ds]
    const chunkResults = await runWithConcurrency(chunks, async (chunk) => {
        const chunkLines = lines.slice(chunk.start, chunk.end);
        const startLineNum = chunk.start + 1;
        const numberedCode = chunkLines.map((line, i) => `${startLineNum + i}: ${line}`).join('\n');
        const prompt = buildPrompt(numberedCode, language, mode);
        const textResponse = await fetchFromProvider(prompt, config);
        return parseAndValidate(textResponse, mode);
    });

    // Merge and deduplicate: first comment wins for overlapping line numbers [ds]
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

module.exports = { getComments, runWithConcurrency, resetConcurrency, CHUNK_SIZE, CHUNK_OVERLAP, CHUNK_THRESHOLD };