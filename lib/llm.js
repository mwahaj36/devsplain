/**
 * Fetches a URL with retry logic, timeout handling, and exponential backoff.
 * @param {string} url - The URL to fetch.
 * @param {object} options - Fetch options.
 * @param {number} maxRetries - Maximum number of retries.
 * @param {number} initialDelay - Initial delay in ms for backoff.
*/
async function fetchWithRetry(url, options, maxRetries = 3, initialDelay = 1000) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        // AbortController to handle request timeouts
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            // If response is valid, return immediately
            if (response.ok) {
                return response;
            }
            // Retry on rate limit (429) or server-side errors (500-599)
            if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
                lastError = new Error(`HTTP Error ${response.status}: ${response.statusText}`);
            } else {
                return response;
            }
        } catch (err) {
            clearTimeout(timeoutId);
            // Handle specific timeout case separately
            if (err.name === 'AbortError') {
                lastError = new Error("Request timed out after 15 seconds");
            } else {
                lastError = err;
            }
        }

        if (attempt < maxRetries - 1) {
            // Calculate exponential backoff delay
            const backoffDelay = initialDelay * Math.pow(2, attempt);
            console.warn(`[devsplain] AI request failed. Retrying in ${backoffDelay}ms... (Attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
        }
    }
    throw lastError;
}

/**
 * Generates documentation for code by sending it to an LLM provider.
 * @param {string} code - The source code to document.
 * @param {string} language - The programming language.
 * @param {object} config - Provider configuration (apiKey, model, etc.).
 * @param {string} mode - Operation mode (default, clean, light, full).
*/
async function getComments(code, language, config, mode = 'default') {
    // Split into lines and prepend line numbers for LLM context
    const lines = code.split(/\r?\n/);
    const numberedCode = lines.map((line, index) => `${index + 1}: ${line}`).join('\n');

    let prompt = "";
    if (mode === 'clean') {
        prompt = `
You are a code documentation scrubber. Analyze the following ${language} code which has line numbers prepended to it.
Your goal is to identify all lines containing comments (both block/JSDoc and inline comments) and return their line numbers to delete them.

CRITICAL RULES:
1. You MUST respond with ONLY a raw, valid JSON array of objects. NO markdown formatting, NO backticks, NO explanations, NO text before or after the JSON.
2. Each object must have exactly two properties: "line" (the integer line number of the comment line to delete) and "action" (which must be the string "delete").
3. Do NOT include the original code in your response.
4. If no comments are found, return an empty array: [].
5. For block or JSDoc comments (e.g., starting with /* and ending with */), you MUST identify and return the line numbers of ALL lines in that block, including the opening /*, all intermediate lines, and the closing */. Do NOT leave trailing comment delimiters behind.

Example Output:
[
  { "line": 4, "action": "delete" },
  { "line": 5, "action": "delete" }
]

Here is the source code:
${numberedCode}
        `.trim();
    } else {
        let instruction = "Provide JSDoc/docstrings block comments above functions and sparse inline comments for complex logic.";
        if (mode === 'light') {
            instruction = "Provide ONLY JSDoc/docstrings above functions. Keep it minimal.";
        } else if (mode === 'full') {
            instruction = "Provide highly detailed JSDoc/docstrings above functions, and exhaustive step-by-step inline comments (using standard comment syntax like // or #) explaining every conditional branch, loop, variable assignment, and logical block inside function bodies. Do not be sparse; explain the code's execution flow in detail.";
        }

        prompt = `
You are a code documentation engine. Analyze the following ${language} code which has line numbers prepended to it.
${instruction}

CRITICAL RULES:
1. You MUST respond with ONLY a raw, valid JSON array of objects. NO markdown formatting, NO backticks, NO explanations, NO text before or after the JSON.
2. Each object must have exactly two properties: "line" (the integer line number where the comment should be inserted ABOVE) and "comment" (the text of the comment itself, including standard comment syntax like // or /** */).
3. Do NOT include the original code in your response.
4. If no comments are needed, return an empty array: [].

Example Output:
[
  { "line": 4, "comment": "/** Calculates the total price */" },
  { "line": 12, "comment": "// Check for null values" }
]

Here is the source code:
${numberedCode}
        `.trim();
    }

    let textResponse = "";

    // Branching logic for different LLM providers
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
            throw new Error("Network Error: Could not connect to the AI provider. Check your internet or API url.");
        }
        if (data.error) {
            throw new Error(`API Error: ${data.error.message}`);
        }
        textResponse = data.candidates[0].content.parts[0].text;
    } 
    else {
        const url = `${config.baseUrl}/v1/chat/completions`;
        let data;

        try {
            const response = await fetchWithRetry(url, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json', 
                    'Authorization': `Bearer ${config.apiKey}` 
                },
                body: JSON.stringify({ 
                    "model": config.model, 
                    "messages": [{ 
                        "role": "user", 
                        "content": prompt 
                    }] 
                })
            });
            data = await response.json();
        } catch (error) {
            throw new Error("Network Error: Could not connect to the AI provider. Check your internet or API url.");
        }
        if (data.error) {
            throw new Error(`API Error: ${data.error.message}`);
        }
        textResponse = data.choices[0].message.content;
    }

    // Extract JSON array from LLM response text
    let cleanText = textResponse.trim();
    const start = cleanText.indexOf('[');
    const end = cleanText.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end >= start) {
        cleanText = cleanText.substring(start, end + 1);
    }

    let parsed;
    // Validate response format and schema integrity
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
            // Sanity check for valid comment syntax
            const startsWithCommentMarker = 
                trimmedComment.startsWith('//') || 
                trimmedComment.startsWith('/*') || 
                trimmedComment.startsWith('#') ||
                trimmedComment.startsWith('<!--') ||
                trimmedComment.startsWith('--');

            if (!startsWithCommentMarker) {
                throw new Error(`Security Error: Comment on line ${item.line} does not start with a valid comment character sequence. Rejected: ${trimmedComment}`);
            }
        }
    }

    return parsed;
}

module.exports = { getComments };