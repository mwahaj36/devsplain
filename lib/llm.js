/**
 * This function generates commented code based on the given parameters.
 * It sends a request to the specified AI provider with the provided code, language, and configuration.
 * The function returns the commented code as a string.
 * 
 * @param {string} code - The code that needs to be commented.
 * @param {string} language - The programming language of the code.
 * @param {object} config - The configuration object containing the provider and API details.
 * @param {string} [mode='default'] - The mode of commenting. Default modes are 'default', 'light', 'full', and 'clean'.
 * @returns {Promise<string>} The commented code.
 */
async function getComments(code, language, config, mode = 'default') {
    // Initialize the instruction based on the mode
    let instruction = "Add JSDoc/docstrings block above functions. Do NOT add inline comments unless the logic is extremely complex or highly non-obvious. Keep the code clean and readable.";
    
    // Check if the mode is 'light' and update the instruction accordingly
    if (mode === 'light') {
        // In 'light' mode, only JSDoc comments are added above functions
        instruction = "Add ONLY JSDoc/docstrings above functions. Do NOT add any inline comments inside the functions. Keep it extremely minimal.";
    } 
    // Check if the mode is 'full' and update the instruction accordingly
    else if (mode === 'full') {
        // In 'full' mode, detailed JSDoc comments and inline comments are added
        instruction = "Add highly detailed JSDoc/docstrings above functions, and add detailed inline comments explaining almost every single line of logic. Do NOT add comments inside string literals, template literals, or multiline strings.";
    }
    // Check if the mode is 'clean' and update the instruction accordingly
    else if (mode === 'clean') {
        // In 'clean' mode, all comments are removed from the code
        instruction = "Remove ALL comments (both block/JSDoc and inline comments) from this code. Return only the raw, uncommented code. Do NOT alter the code logic or formatting.";
    }
    
    // Initialize the prompt based on the mode
    let prompt = "";
    // Check if the mode is 'clean' and update the prompt accordingly
    if (mode === 'clean') {
        // In 'clean' mode, the prompt asks to remove all comments
        prompt = `
        Remove ALL comments (both block/JSDoc and inline comments) from the following ${language} code. 
        Return ONLY the raw, uncommented code. NO MARKDOWN. NO EXPLANATION. NO PERSONAL MESSAGE.
        Do NOT alter the code logic or formatting in any way.
        ${code}
        `;
    } else {
        // In other modes, the prompt asks to add comments to the code
        prompt = `
        Add comments to the code in this file (${language}). ${instruction}
        If the code already contains comments, completely REPLACE them with your own. Do not leave duplicate or messy comments behind.
        Return ONLY the commented code. NO MARKDOWN. NO EXPLANATION. NO PERSONAL MESSAGE.
        Do NOT alter, refactor, or format the existing code in any way. Only add comments. IF ANYTHING WRONG HIGHLIGHT IN COMMENT BUT DO NOT CHANGE
        ${code}
        `;
    }

    // Check if the provider is 'gemini' and proceed accordingly
    if (config.provider === 'gemini') {
        // Construct the URL for the API request
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
        let data;
        
        try {
            // Send a POST request to the API with the prompt
            const response = await fetch(url, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify({
                    "contents": [{ "parts": [{ "text": prompt }] }]
                })
            });
            // Parse the response as JSON
            data = await response.json();
        } catch (error) {
            // Log any network errors and exit the process
            console.log("\n Network Error: Could not connect to the AI provider. Check your internet or API url.");
            process.exit(1);
        }
        
        // Check if there is an error in the API response
        if (data.error) {
            // Log the API error and exit the process
            console.error("\n API Error:", data.error.message);
            process.exit(1);
        }
        
        // Extract the generated text from the API response
        let text = data.candidates[0].content.parts[0].text;
        // Remove any unnecessary code blocks and trim the text
        text = text.replace(/^```[\w]*\n/m, '').replace(/```$/m, '').trim();
        // Return the generated text
        return text;
    } 
    // If the provider is not 'gemini', proceed with the default API request
    else {
        // Construct the URL for the API request
        const url = `${config.baseUrl}/v1/chat/completions`;
        let data;

        try {
            // Send a POST request to the API with the prompt
            const response = await fetch(url, {
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
            // Parse the response as JSON
            data = await response.json();
        } catch (error) {
            // Log any network errors and exit the process
            console.log("\n Network Error: Could not connect to the AI provider. Check your internet or API url.");
            process.exit(1);
        }
        
        // Check if there is an error in the API response
        if (data.error) {
            // Log the API error and exit the process
            console.error("\n API Error:", data.error.message);
            process.exit(1);
        }
        
        // Extract the generated text from the API response
        let text = data.choices[0].message.content;
        // Remove any unnecessary code blocks and trim the text
        text = text.replace(/^```[\w]*\n/m, '').replace(/```$/m, '').trim();
        // Return the generated text
        return text;
    }
}

// Export the getComments function as a module
module.exports = { getComments };