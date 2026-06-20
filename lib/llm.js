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
    // First, we need to determine the instruction based on the mode
    let instruction = "Add JSDoc/docstrings block above functions. Do NOT add inline comments unless the logic is extremely complex or highly non-obvious. Keep the code clean and readable.";
    // If the mode is 'light', we update the instruction accordingly
    if (mode === 'light') {
        instruction = "Add ONLY JSDoc/docstrings above functions. Do NOT add any inline comments inside the functions. Keep it extremely minimal.";
    } 
    // If the mode is 'full', we update the instruction to include detailed inline comments
    else if (mode === 'full') {
        instruction = "Add highly detailed JSDoc/docstrings above functions, and add detailed inline comments explaining almost every single line of logic.";
    }
    
    // Now, we create a prompt based on the language and instruction
    const prompt = `
    // This is a prompt to add comments to the provided code
    Add comments to this ${language} code. ${instruction}
    // The commented code should be returned without any markdown, explanations, or personal messages
    Return ONLY the commented code. NO MARKDOWN. NO EXPLANATION. NO PERSONAL MESSAGE.
    ${code}
    `;

    // Next, we check the provider in the config to determine which API to use
    if (config.provider === 'gemini') {
        // If the provider is 'gemini', we use the Google API
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
        // We make a POST request to the API with the prompt
        const response = await fetch(url, {
            method: 'POST',
            // We set the content type to application/json
            headers: { 'Content-Type': 'application/json' },
            // We stringified the prompt as JSON
            body: JSON.stringify({
                "contents": [{ "parts": [{ "text": prompt }] }]
            })
        });
        
        // We parse the response as JSON
        const data = await response.json();
        // For debugging purposes, we log the API response
        console.log("DEBUG API RESPONSE:", data);
        
        // If there's an error in the response, we log the error and exit the process
        if (data.error) {
            console.error("\n API Error:", data.error.message);
            process.exit(1);
        }
        
        // We extract the commented code from the response
        let text = data.candidates[0].content.parts[0].text;
        // We remove any unnecessary characters from the commented code
        text = text.replace(/^```[\w]*\n/m, '').replace(/```$/m, '').trim();
        // Finally, we return the commented code
        return text;
    } 
    // If the provider is not 'gemini', we use a different API
    else {
        const url = `${config.baseUrl}/v1/chat/completions`;
        // We make a POST request to the API with the prompt
        const response = await fetch(url, {
            method: 'POST',
            // We set the content type to application/json and include the API key in the authorization header
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
            // We stringified the prompt as JSON
            body: JSON.stringify({ "model": config.model, "messages": [{ "role": "user", "content": prompt }] })
        });
        
        // We parse the response as JSON
        const data = await response.json();
        // For debugging purposes, we log the API response
        console.log("DEBUG API RESPONSE:", data);
        
        // If there's an error in the response, we log the error and exit the process
        if (data.error) {
            console.error("\n API Error:", data.error.message);
            process.exit(1);
        }
        
        // We extract the commented code from the response
        let text = data.choices[0].message.content;
        // We remove any unnecessary characters from the commented code
        text = text.replace(/^```[\w]*\n/m, '').replace(/```$/m, '').trim();
        // Finally, we return the commented code
        return text;
    }
}

// We export the getComments function
module.exports = { getComments };