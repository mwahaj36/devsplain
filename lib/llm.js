/** [ds]
 * Executes a fetch request with automatic retry logic and exponential backoff.
 * Handles timeouts and distinguishes between retryable (5xx/429) and non-retryable HTTP errors.
 * 
 * @param {string} url - The target URL to fetch.
 * @param {object} options - Fetch API options and headers.
 * @param {number} maxRetries - Maximum number of retry attempts.
 * @param {number} initialDelay - Initial delay in milliseconds for exponential backoff.
 * @returns {Promise<Response>} - The successful Response object.
*/
async function fetchWithRetry(url, options, maxRetries = 3, initialDelay = 1000) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const controller = new AbortController();
        // Set up an automatic abort if the request hangs for 45 seconds or more [ds]
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
            // Automatically retry on Rate Limit (429) or Server Error (5xx) responses [ds]
            if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
                lastError = new Error(`HTTP Error ${response.status}: ${response.statusText}`);
            } else {
                return response;
            }
        } catch (err) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') {
                lastError = new Error("Request timed out after 45 seconds");
            } else {
                lastError = err;
            }
        }

        if (attempt < maxRetries - 1) {
            // Calculate exponential backoff delay, doubling the wait time on each retry attempt [ds]
            const backoffDelay = initialDelay * Math.pow(2, attempt);
            console.warn(`[devsplain] AI request failed. Retrying in ${backoffDelay}ms... (Attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
        }
    }
    throw lastError;
}

/** [ds]
 * Generates documentation comments for source code using the configured LLM provider.
 * Prepends line numbers to code, formats provider-specific prompts, and parses the
 * resulting JSON response into a validated list of comments.
 * 
 * @param {string} code - The source code string to be annotated.
 * @param {string} language - File extension or language identifier (e.g. '.js', 'python').
 * @param {object} config - Configuration object containing provider, model, and API keys.
 * @param {string} mode - Description mode: 'default', 'light', 'full', or 'clean'.
 * @returns {Promise<Array>} - Parsed array of comment objects.
*/
async function getComments(code, language, config, mode = 'default') {
    const lines = code.split(/\r?\n/);
    // Concatenate lines with line numbers to help the LLM accurately locate where comments should be inserted [ds]
    const numberedCode = lines.map((line, index) => `${index + 1}: ${line}`).join('\n');

    // Isolate the file extension (e.g., '.py') to determine the correct comment syntax [ds]
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
        // Adjust syntax if the detected language relies on hash symbols for comments (Python/Ruby) [ds]
        singleLineToken = '#';
        blockExample = '# Calculates the total price';
        inlineExample = '# Check for null values';
    } else if (isHTML) {
        // Use HTML-style comment syntax for markup languages [ds]
        singleLineToken = '<!--';
        blockExample = '<!-- Calculates the total price -->';
        inlineExample = '<!-- Check for null values -->';
    } else if (isCss) {
        // Standard C-style block comments are required for CSS/SCSS [ds]
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
        // In 'full' mode, explicitly request highly verbose, step-by-step documentation from the LLM [ds]
        instruction = `Provide highly detailed block comments above functions, and exhaustive step-by-step inline comments explaining every conditional branch, loop, variable assignment, and logical block inside function bodies. Do not be sparse; explain the code's execution flow in detail.`;
    }

    let rule5 = `5. IMPORTANT: Use ONLY ${singleLineToken} for comments. DO NOT use docstrings or multi-line string literals like """ or ''' for comments.`;
    if (isCss) {
        rule5 = `5. IMPORTANT: In CSS/SCSS, you MUST use /* ... */ for comments. DO NOT use // comments under any circumstances.`;
    }

    let prompt = `
You are a code documentation engine. Analyze the following ${language} code which has line numbers prepended to it.
${instruction}

CRITICAL RULES:
1. You MUST respond with ONLY a raw, valid JSON array of objects. NO markdown formatting, NO backticks, NO explanations, NO text before or after the JSON.
2. Each object must have exactly two properties: "line" (the integer line number where the comment should be inserted ABOVE) and "comment" (the text of the comment itself).
3. Do NOT include the original code in your response.
4. If no comments are needed, return an empty array: [].
${rule5}

Example Output:
[
  { "line": 4, "comment": "${blockExample}" },
  { "line": 12, "comment": "${inlineExample}" }
]

Here is the source code:
${numberedCode}
    `.trim();

    let textResponse = "";

    // Execute provider-specific API calls based on the configured model [ds]
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
            throw new Error(`AI Provider Request Failed: ${error.message}`);
        }
        if (data.error) {
            const msg = data.error.message || (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
            throw new Error(`API Error: ${msg}`);
        }
        // Detect malformed Claude API responses to prevent undefined logic later in the function [ds]
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
        // Apply specific token limit constraints for Groq provider in OpenAI-compatible mode [ds]
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

    // Strip potential conversational prefixes and find the absolute boundaries of the JSON payload [ds]
    let cleanText = textResponse.trim();
    const start = cleanText.indexOf('[');
    const end = cleanText.lastIndexOf(']');
    if (start !== -1) {
        if (end !== -1 && end >= start) {
            cleanText = cleanText.substring(start, end + 1);
        } else {
            // Gracefully recover truncated JSON arrays by finding the last complete object closing brace [ds]
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

    // Iterate through parsed comments to strictly enforce schema, rejecting invalid types or missing string fields [ds]
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
// Begin a multi-line security scan to ensure each character returns purely a valid comment [ds]

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

module.exports = { getComments };