// Asynchronously fetches data from the specified URL with a retry mechanism [ds]
async function fetchWithRetry(url, options, maxRetries = 3, initialDelay = 1000) {
    let lastError;
    // Loop through each attempt, up to the maximum number of retries [ds]
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (response.ok) {
                return response;
            }
            if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
                lastError = new Error(`HTTP Error ${response.status}: ${response.statusText}`);
            } else {
                return response;
            }
        } catch (err) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') {
                lastError = new Error("Request timed out after 15 seconds");
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

// Retrieves comments for the given code, language, and configuration [ds]
async function getComments(code, language, config, mode = 'default') {
    const lines = code.split(/\r?\n/);
    const numberedCode = lines.map((line, index) => `${index + 1}: ${line}`).join('\n');

    // Extract the file extension from the language string [ds]
    const extMatch = language.match(/\.[0-9a-z]+$/i);
    const ext = extMatch ? extMatch[0].toLowerCase() : '';
    const isPython = ext === '.py';
    const isRubyOrShell = ['.rb', '.sh', '.php'].includes(ext);
    const isHTML = ['.html', '.vue', '.svelte'].includes(ext);
    const isSql = ext === '.sql';
    
    // Define the single-line comment token and examples [ds]
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
    } else if (isSql) {
        singleLineToken = '--';
        blockExample = '-- Calculates the total price';
        inlineExample = '-- Check for null values';
    }

    // Provide instructions based on the mode [ds]
    let instruction = `Provide block comments above functions and sparse inline comments for complex logic.`;
    if (mode === 'light') {
        instruction = `Provide ONLY block comments above functions. Keep it minimal.`;
    } else if (mode === 'full') {
        instruction = `Provide highly detailed block comments above functions, and exhaustive step-by-step inline comments explaining every conditional branch, loop, variable assignment, and logical block inside function bodies. Do not be sparse; explain the code's execution flow in detail.`;
    }

    let prompt = `
You are a code documentation engine. Analyze the following ${language} code which has line numbers prepended to it.
${instruction}

CRITICAL RULES:
1. You MUST respond with ONLY a raw, valid JSON array of objects. NO markdown formatting, NO backticks, NO explanations, NO text before or after the JSON.
2. Each object must have exactly two properties: "line" (the integer line number where the comment should be inserted ABOVE) and "comment" (the text of the comment itself).
3. Do NOT include the original code in your response.
4. If no comments are needed, return an empty array: [].
5. IMPORTANT: Use ONLY ${singleLineToken} for comments. DO NOT use docstrings or multi-line string literals like """ or ''' for comments.

Example Output:
[
  { "line": 4, "comment": "${blockExample}" },
  { "line": 12, "comment": "${inlineExample}" }
]

Here is the source code:
${numberedCode}
    `.trim();

    let textResponse = "";

    // Handle API requests based on the provider [ds]
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
    } else if (config.provider === 'claude') {
        // Handle Claude API requests [ds]
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
            throw new Error("Network Error: Could not connect to the AI provider. Check your internet or API url.");
        }
        if (data.error) {
            throw new Error(`API Error: ${data.error.message}`);
        }
        textResponse = data.content[0].text;
    } 
    // Handle other API requests [ds]
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

    let cleanText = textResponse.trim();
    const start = cleanText.indexOf('[');
    const end = cleanText.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end >= start) {
        cleanText = cleanText.substring(start, end + 1);
    }

    let parsed;
    try {
        // Attempt to parse the response as JSON [ds]
        parsed = JSON.parse(cleanText);
    } catch (e) {
        throw new Error(`Parsing Error: Failed to parse LLM response as JSON. Raw response was:\n${textResponse}`);
    }

    if (!Array.isArray(parsed)) {
        throw new Error("Schema Error: LLM response is not a JSON array.");
    }

    // Validate the parsed response [ds]
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