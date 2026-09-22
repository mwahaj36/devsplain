/** [ds]
 * Sends an HTTP request with automatic retry logic and timeout management.
 * @param {string} url - The target URL.
 * @param {object} options - Fetch options including method, headers, and body.
 * @param {number} maxRetries - Maximum number of retry attempts.
 * @param {number} initialDelay - Initial delay in milliseconds for exponential backoff.
 * @returns {Promise<Response>} - Returns the successful Response object.
*/
async function fetchWithRetry(url, options, maxRetries = 3, initialDelay = 1000) {
    // Initialize a variable to store the last encountered error for potential re-throwing [ds]
    let lastError;
    // Enter a retry loop that executes up to 'maxRetries' times [ds]
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        // Create an AbortController to manually trigger request timeouts [ds]
        const controller = new AbortController();
        // Schedule an abort action after 45 seconds to prevent hanging connections [ds]
        const timeoutId = setTimeout(() => controller.abort(), 45000);
        // Begin a try block to handle potential network or processing exceptions [ds]
        try {
            // Execute the fetch request, passing the URL and options with the abort signal [ds]
            const response = await fetch(url, {
                // Spread existing options into the fetch configuration [ds]
                ...options,
                // Attach the abort signal to allow external cancellation [ds]
                signal: controller.signal
            });
            // Clear the timeout timer to clean up the abort signal since the request completed [ds]
            clearTimeout(timeoutId);
            // Validate that a response object was actually received [ds]
            if (!response) {
                // Throw a custom error if the response is missing or null [ds]
                throw new Error("No response received from fetch");
            }
            // Check if the HTTP response indicates success (2xx status) [ds]
            if (response.ok) {
                // Return the response immediately upon successful HTTP completion [ds]
                return response;
            }
            // Identify transient errors: 429 (Too Many Requests) or 5xx (Server Errors) [ds]
            if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
                // Store the transient error to trigger a retry in the next loop iteration [ds]
                lastError = new Error(`HTTP Error ${response.status}: ${response.statusText}`);
            } else {
                // For non-transient errors (4xx), return the response directly to let caller handle [ds]
                return response;
            }
        // Catch any synchronous errors thrown during the await or setup [ds]
        } catch (err) {
            // Clear the timeout timer to prevent memory leaks on failure [ds]
            clearTimeout(timeoutId);
            // Check if the error was caused by the manual timeout abort [ds]
            if (err.name === 'AbortError') {
                // Convert the AbortError into a descriptive timeout message [ds]
                lastError = new Error("Request timed out after 45 seconds");
            } else {
                // Store any other standard errors for potential retry logic [ds]
                lastError = err;
            }
        }

        // Check if more retry attempts remain before the final try [ds]
        if (attempt < maxRetries - 1) {
            // Calculate exponential backoff delay: base delay multiplied by 2 to the power of attempts [ds]
            const backoffDelay = initialDelay * Math.pow(2, attempt);
            // Log a warning to the console indicating a retry is occurring [ds]
            console.warn(`[devsplain] AI request failed. Retrying in ${backoffDelay}ms... (Attempt ${attempt + 1}/${maxRetries})`);
            // Pause execution for the calculated backoff duration before retrying [ds]
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
        }
    }
    // Re-throw the last error if all retry attempts have been exhausted [ds]
    throw lastError;
}

/** [ds]
 * Orchestrate code documentation by calling various AI providers.
 * Handles prompt construction, provider-specific API calls, and response parsing.
 * @param {string} code - The source code to analyze.
 * @param {string} language - The programming language and file extension.
 * @param {object} config - Provider configuration details.
 * @param {string} mode - Documentation density mode ('default', 'light', 'full', 'clean').
 * @returns {Promise<Array>} - Array of comment insertion objects.
*/
async function getComments(code, language, config, mode = 'default') {
    // Split source code into an array of lines, handling Windows and Unix newline styles [ds]
    const lines = code.split(/\r?\n/);
    // Prepend line numbers to each line to help the AI map comments to specific locations [ds]
    const numberedCode = lines.map((line, index) => `${index + 1}: ${line}`).join('\n');

    // Extract the file extension using a regular expression [ds]
    const extMatch = language.match(/\.[0-9a-z]+$/i);
    // Normalize the extension to lowercase or default to empty string if missing [ds]
    const ext = extMatch ? extMatch[0].toLowerCase() : '';
    // Determine if the language is Python [ds]
    const isPython = ext === '.py';
    // Determine if the language is Ruby or Shell Script [ds]
    const isRubyOrShell = ['.rb', '.sh'].includes(ext);
    // Determine if the language is HTML-based (HTML, Vue, Svelte) [ds]
    const isHTML = ['.html', '.vue', '.svelte'].includes(ext);
    // Determine if the language is CSS or SCSS [ds]
    const isCss = ['.css', '.scss'].includes(ext);
    // Determine if the language is SQL [ds]
    const isSql = ext === '.sql';
    // Initialize comment syntax tokens for standard C-like languages [ds]
    let singleLineToken = '//';
    let blockExample = '/** Calculates the total price */';
    let inlineExample = '// Check for null values';

    // Adjust comment syntax for Python and Shell-based languages [ds]
    if (isPython || isRubyOrShell) {
        singleLineToken = '#';
        blockExample = '# Calculates the total price';
        inlineExample = '# Check for null values';
    // Adjust comment syntax for HTML template languages [ds]
    } else if (isHTML) {
        singleLineToken = '<!--';
        blockExample = '<!-- Calculates the total price -->';
        inlineExample = '<!-- Check for null values -->';
    // Adjust comment syntax for CSS stylesheets [ds]
    } else if (isCss) {
        singleLineToken = '/*';
        blockExample = '/* Calculates the total price */';
        inlineExample = '/* Check for null values */';
    // Adjust comment syntax for SQL queries [ds]
    } else if (isSql) {
        singleLineToken = '--';
        blockExample = '-- Calculates the total price';
        inlineExample = '-- Check for null values';
    }

    // Set default prompting instruction for standard documentation [ds]
    let instruction = `Provide block comments above functions and sparse inline comments for complex logic.`;
    // Modify instruction if minimal documentation is requested [ds]
    if (mode === 'light') {
        instruction = `Provide ONLY block comments above functions. Keep it minimal.`;
    // Modify instruction for exhaustive step-by-step documentation mode [ds]
    } else if (mode === 'full') {
        instruction = `Provide highly detailed block comments above functions, and exhaustive step-by-step inline comments explaining every conditional branch, loop, variable assignment, and logical block inside function bodies. Do not be sparse; explain the code's execution flow in detail.`;
    }

    // Define a placeholder rule for comment syntax restrictions [ds]
    let rule5 = `5. IMPORTANT: Use ONLY ${singleLineToken} for comments. DO NOT use docstrings or multi-line string literals like """ or ''' for comments.`;
    // Override the syntax rule specifically for CSS files [ds]
    if (isCss) {
        rule5 = `5. IMPORTANT: In CSS/SCSS, you MUST use /* ... */ for comments. DO NOT use // comments under any circumstances.`;
    }

    // Construct the full prompt combining rules, examples, and the numbered source code [ds]
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

    // Initialize a variable to hold the raw text output from the AI provider [ds]
    let textResponse = "";

    // Branch to handle the Google Gemini API provider [ds]
    if (config.provider === 'gemini') {
        // Construct the Google Gemini API endpoint URL with model and API key [ds]
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
        // Declare a variable to store the parsed API response [ds]
        let data;
        // Begin error handling for the Gemini API call [ds]
        try {
            // Send the POST request to the Gemini API with the constructed prompt [ds]
            const response = await fetchWithRetry(url, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify({
                    "contents": [{ "parts": [{ "text": prompt }] }]
                })
            });
            // Parse the JSON response body from the Gemini service [ds]
            data = await response.json();
        // Wrap network or fetch errors in a standard descriptive error [ds]
        } catch (error) {
            throw new Error(`AI Provider Request Failed: ${error.message}`);
        }
        // Check if the Gemini response contains an error object [ds]
        if (data.error) {
            // Extract the human-readable error message from the Google-specific structure [ds]
            const msg = data.error.message || (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
            // Throw a normalized error based on the API error details [ds]
            throw new Error(`API Error: ${msg}`);
        }
        // Validate that the Gemini response structure contains the expected content [ds]
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts || !data.candidates[0].content.parts[0]) {
            // Capture the finish reason to provide context for empty content errors [ds]
            const reason = data.candidates?.[0]?.finishReason || 'Unknown error';
            // Throw an error indicating the AI returned no usable content [ds]
            throw new Error(`AI Provider returned no content (finish reason: ${reason})`);
        }
        // Extract the raw text content from the Gemini response candidates [ds]
        textResponse = data.candidates[0].content.parts[0].text;
    // Branch to handle the Anthropic Claude API provider [ds]
    } else if (config.provider === 'claude') {
        // Construct the Anthropic API endpoint URL [ds]
        const url = `${config.baseUrl}/v1/messages`;
        // Declare a variable to store the parsed Anthropic API response [ds]
        let data;
        // Begin error handling for the Anthropic API call [ds]
        try {
            // Send the POST request to Anthropic with version headers and API key [ds]
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
            // Parse the JSON response body from the Anthropic service [ds]
            data = await response.json();
        // Wrap network or fetch errors in a standard descriptive error [ds]
        } catch (error) {
            throw new Error(`AI Provider Request Failed: ${error.message}`);
        }
        // Check if the Anthropic response contains an error object [ds]
        if (data.error) {
            // Extract the human-readable error message from the Anthropic response [ds]
            const msg = data.error.message || (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
            // Throw a normalized error based on the API error details [ds]
            throw new Error(`API Error: ${msg}`);
        }
        // Validate that the Anthropic response structure contains valid text content [ds]
        if (!data.content || !data.content[0] || typeof data.content[0].text !== 'string') {
            // Throw an error with the raw JSON if the structure is unexpected [ds]
            throw new Error(`AI Provider returned an unexpected response structure: ${JSON.stringify(data)}`);
        }
        // Extract the text content from the first message block [ds]
        textResponse = data.content[0].text;
    } 
    // Default branch for OpenAI-compatible APIs (OpenAI, Groq, etc.) [ds]
    else {
        // Construct the OpenAI-compatible chat completions endpoint [ds]
        const url = `${config.baseUrl}/v1/chat/completions`;
        // Declare a variable to store the parsed OpenAI-compatible response [ds]
        let data;

        // Initialize the request body structure with model and message content [ds]
        const reqBody = { 
            "model": config.model, 
            "messages": [{ 
                "role": "user", 
                "content": prompt 
            }] 
        };
        // Apply specific token limits for Groq provider to avoid issues [ds]
        if (config.provider === 'groq') {
            reqBody.max_tokens = 1000;
        // Apply default high token limit for other OpenAI-compatible providers [ds]
        } else {
            reqBody.max_tokens = 8192;
        }

        // Begin error handling for the OpenAI-compatible API call [ds]
        try {
            // Send the POST request with Bearer token authentication [ds]
            const response = await fetchWithRetry(url, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json', 
                    'Authorization': `Bearer ${config.apiKey}` 
                },
                body: JSON.stringify(reqBody)
            });
            // Parse the JSON response body from the OpenAI-compatible service [ds]
            data = await response.json();
        // Wrap network or fetch errors in a standard descriptive error [ds]
        } catch (error) {
            throw new Error(`AI Provider Request Failed: ${error.message}`);
        }
        // Check if the OpenAI-compatible response contains an error object [ds]
        if (data.error) {
            // Extract the human-readable error message from the OpenAI error structure [ds]
            const msg = data.error.message || (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
            // Throw a normalized error based on the API error details [ds]
            throw new Error(`API Error: ${msg}`);
        }
        // Validate that the OpenAI response structure contains a valid message object [ds]
        if (!data.choices || !data.choices[0] || !data.choices[0].message || typeof data.choices[0].message.content !== 'string') {
            // Throw an error with the raw JSON if the structure is unexpected [ds]
            throw new Error(`AI Provider returned an unexpected response structure: ${JSON.stringify(data)}`);
        }
        // Extract the text content from the first choice's message [ds]
        textResponse = data.choices[0].message.content;
    }

    // Remove leading and trailing whitespace from the AI text output [ds]
    let cleanText = textResponse.trim();
    // Locate the starting index of the JSON array [ds]
    const start = cleanText.indexOf('[');
    // Locate the ending index of the JSON array [ds]
    const end = cleanText.lastIndexOf(']');
    // Check if a JSON array was actually found in the text [ds]
    if (start !== -1) {
        // Validate that the end index exists and comes after the start index [ds]
        if (end !== -1 && end >= start) {
            // Slice the text to contain only the JSON array portion [ds]
            cleanText = cleanText.substring(start, end + 1);
        } else {
            // If ']' is missing, look for the last closing brace to fix truncated JSON [ds]
            const lastBrace = cleanText.lastIndexOf('}');
            // Ensure the found brace is actually within the current text segment [ds]
            if (lastBrace > start) {
                // Manually append the missing closing bracket to make valid JSON [ds]
                cleanText = cleanText.substring(start, lastBrace + 1) + ']';
            }
        }
    }

    // Declare a variable to store the parsed JSON object [ds]
    let parsed;
    // Attempt to parse the cleaned text string into a JavaScript object [ds]
    try {
        // Execute the JSON parsing operation [ds]
        parsed = JSON.parse(cleanText);
    // Catch parsing errors if the text is malformed [ds]
    } catch (e) {
        // Throw a descriptive error including the raw response for debugging [ds]
        throw new Error(`Parsing Error: Failed to parse LLM response as JSON. Raw response was:\n${textResponse}`);
    }

    // Validate that the parsed result is a JavaScript array [ds]
    if (!Array.isArray(parsed)) {
        // Throw an error if the top-level JSON structure is not an array [ds]
        throw new Error("Schema Error: LLM response is not a JSON array.");
    }

    // Iterate over each comment object in the parsed array for validation [ds]
    for (const item of parsed) {
        // Verify that each item is a real object and not null or a primitive [ds]
        if (typeof item !== 'object' || item === null) {
            // Throw a schema error for invalid object types [ds]
            throw new Error("Schema Error: Array elements must be objects.");
        }
        // Validate that the 'line' property is a positive integer [ds]
        if (!Number.isInteger(item.line) || item.line <= 0) {
            // Throw a schema error for invalid line numbers [ds]
            throw new Error("Schema Error: 'line' must be a positive integer.");
        }

        // Enforce specific schema rules for data cleaning mode [ds]
        if (mode === 'clean') {
            // Ensure the 'action' property is 'delete' if in clean mode [ds]
            if (item.action !== 'delete') {
                // Throw a schema error for invalid actions in clean mode [ds]
                throw new Error("Schema Error: 'action' must be 'delete' in clean mode.");
            }
        // Handle standard documentation modes that require comment text [ds]
        } else {
            // Verify that the 'comment' property exists and is a string [ds]
            if (typeof item.comment !== 'string') {
                // Throw a schema error if comment text is missing or not a string [ds]
                throw new Error("Schema Error: 'comment' must be a string.");
            }

            // Normalize the comment text by trimming whitespace [ds]
            const trimmedComment = item.comment.trim();
            // Split the comment into lines to validate syntax per line [ds]
            const commentLines = trimmedComment.split(/\r?\n/);
            // Track whether we are currently inside a block comment [ds]
            let inBlock = false;
            // Loop through each line of the comment string [ds]
            for (const cl of commentLines) {
                // Trim leading/trailing whitespace from the current comment line [ds]
                const tcl = cl.trim();
                // Skip empty lines during validation [ds]
                if (!tcl) continue;
                // Check if this line is part of the continuation of a block comment [ds]
                if (inBlock) {
                    // Detect if the line closes a block comment (CSS/HTML style) [ds]
                    if (tcl.includes('*/') || tcl.includes('-->')) {
                        // Mark block comment state as false if a closing marker is found [ds]
                        inBlock = false;
                    }
                    // Skip validation for lines inside a block comment [ds]
                    continue;
                }
                // Check if the line starts with a valid comment marker [ds]
                const startsWithMarker = 
                    tcl.startsWith('//') || 
                    tcl.startsWith('/*') || 
                    tcl.startsWith('*') || 
                    tcl.startsWith('#') || 
                    tcl.startsWith('<!--') || 
                    tcl.startsWith('--');
                // Throw a strict security error if a line lacks a comment prefix [ds]
                if (!startsWithMarker) {
                    throw new Error(`Security Error: Comment on line ${item.line} contains invalid non-comment line: "${tcl}"`);
                }
                // Detect if a line opens a block comment without closing it [ds]
                if ((tcl.startsWith('/*') && !tcl.includes('*/')) || (tcl.startsWith('<!--') && !tcl.includes('-->'))) {
                    // Set the block comment state to true for subsequent line processing [ds]
                    inBlock = true;
                }
            }
        }
    }

    // Return the fully validated and parsed array of comments [ds]
    return parsed;
}

// Export the main function for use by external modules [ds]
module.exports = { getComments };