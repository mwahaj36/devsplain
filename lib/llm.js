/**
 * Asynchronously retrieves comments for a given piece of code.
 * 
 * @param {string} code The code for which to retrieve comments.
 * @param {string} language The programming language of the code.
 * @param {object} config An object containing configuration settings for the API request.
 * @param {string} [mode='default'] The mode in which to retrieve comments. Can be 'light', 'full', or 'default'.
 * @returns {Promise<string>} A promise that resolves to the commented code.
 */
async function getComments(code, language, config, mode = 'default') {
    // Determine the instruction based on the mode; this instruction will be used to guide the API's generation of comments
    let instruction = "Add JSDoc/docstrings block above functions. Do NOT add inline comments unless the logic is extremely complex or highly non-obvious. Keep the code clean and readable.";
    
    // Update the instruction if the mode is set to 'light'
    if (mode === 'light') {
        // In 'light' mode, only JSDoc/docstrings should be added above functions, without any inline comments
        instruction = "Add ONLY JSDoc/docstrings above functions. Do NOT add any inline comments inside the functions. Keep it extremely minimal.";
    } 
    // Update the instruction if the mode is set to 'full'
    else if (mode === 'full') {
        // In 'full' mode, add detailed JSDoc/docstrings above functions and include comprehensive inline comments to explain the logic
        instruction = "Add highly detailed JSDoc/docstrings above functions, and add detailed inline comments explaining almost every single line of logic. Do NOT add comments inside string literals, template literals, or multiline strings.";
    }
    
    // Create a prompt based on the language and the determined instruction
    const prompt = `
    Add comments to the code in this file (${language}). ${instruction}
    If the code already contains comments, completely REPLACE them with your own. Do not leave duplicate or messy comments behind.
    Return ONLY the commented code. NO MARKDOWN. NO EXPLANATION. NO PERSONAL MESSAGE.
    Do NOT alter, refactor, or format the existing code in any way. Only add comments. IF ANYTHING WRONG HIGHLIGHT IN COMMENT BUT DO NOT CHANGE
    ${code}
    `;

    // Check the provider specified in the config to determine which API endpoint to use for the request
    if (config.provider === 'gemini') {
        // If the provider is 'gemini', use the Google API endpoint
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
        
        // Make a POST request to the Google API with the constructed prompt
        const response = await fetch(url, {
            method: 'POST',
            // Set the content type of the request to application/json
            headers: { 'Content-Type': 'application/json' },
            // Stringify the prompt as JSON and include it in the request body
            body: JSON.stringify({
                "contents": [{ "parts": [{ "text": prompt }] }]
            })
        });
        
        // Parse the API response as JSON
        const data = await response.json();
        // Log the API response for debugging purposes
        console.log("DEBUG API RESPONSE:", data);
        
        // Check if the API response contains an error
        if (data.error) {
            // If an error is found, log the error message and exit the process
            console.error("\n API Error:", data.error.message);
            process.exit(1);
        }
        
        // Extract the commented code from the API response
        let text = data.candidates[0].content.parts[0].text;
        // Remove any unnecessary characters from the extracted code
        text = text.replace(/^```[\w]*\n/m, '').replace(/```$/m, '').trim();
        // Return the commented code
        return text;
    } 
    // If the provider is not 'gemini', use a different API endpoint
    else {
        // Construct the URL for the alternative API endpoint
        const url = `${config.baseUrl}/v1/chat/completions`;
        
        // Make a POST request to the alternative API with the constructed prompt
        const response = await fetch(url, {
            method: 'POST',
            // Set the content type of the request to application/json and include the API key in the authorization header
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
            // Stringify the prompt as JSON and include it in the request body
            body: JSON.stringify({ "model": config.model, "messages": [{ "role": "user", "content": prompt }] })
        });
        
        // Parse the API response as JSON
        const data = await response.json();
        // Log the API response for debugging purposes
        console.log("DEBUG API RESPONSE:", data);
        
        // Check if the API response contains an error
        if (data.error) {
            // If an error is found, log the error message and exit the process
            console.error("\n API Error:", data.error.message);
            process.exit(1);
        }
        
        // Extract the commented code from the API response
        let text = data.choices[0].message.content;
        // Remove any unnecessary characters from the extracted code
        text = text.replace(/^```[\w]*\n/m, '').replace(/```$/m, '').trim();
        // Return the commented code
        return text;
    }
}

// Export the getComments function to make it available for use in other modules
module.exports = { getComments };