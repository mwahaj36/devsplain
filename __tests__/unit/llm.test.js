/**
 * Import the getComments function from the llm module.
 * The getComments function is used to retrieve comments for a given code snippet.
 * @see ../../lib/llm
 */
const { getComments } = require('../../lib/llm');

// Set up a mock implementation for the fetch function.
// This is necessary for testing purposes, as we don't want to make actual HTTP requests during testing.
global.fetch = jest.fn();

/**
 * Describe block for testing the LLM module's getComments function.
 * This block contains multiple test cases to ensure the getComments function works correctly.
 */
describe('LLM Module (getComments)', () => {
    
    /**
     * Before each test, clear the mock fetch function to reset its state.
     * This ensures that each test starts with a clean slate.
     */
    beforeEach(() => {
        // Clear the mock fetch function to reset its state.
        // This is crucial for maintaining isolation between test cases.
        fetch.mockClear();
    });

    /**
     * Test case: should format request correctly for Gemini provider.
     * This test ensures that the getComments function formats the request correctly when using the Gemini provider.
     */
    test('should format request correctly for Gemini provider', async () => {
        // Mock the fetch function to return a resolved promise with a JSON response.
        // The response contains a single candidate with a comment.
        fetch.mockResolvedValueOnce({
            // Mock the json method to return a promise that resolves with the response data.
            json: async () => ({
                // Response data: an array of candidates.
                candidates: [
                    // Single candidate with a comment.
                    { 
                        // Content of the candidate.
                        content: { 
                            // Parts of the content.
                            parts: [{ 
                                // Text of the part, including the comment and the original code.
                                text: "/** fake gemini comments */\nconst x = 1;" 
                            }] 
                        } 
                    }
                ]
            })
        });

        // Create a fake configuration object for the test.
        // This object contains the necessary parameters for the getComments function, such as provider, model, and API key.
        const fakeConfig = {
            // Provider: Gemini.
            provider: 'gemini',
            // Model: gemini-test.
            model: 'gemini-test',
            // API key: fake-gemini-key.
            apiKey: 'fake-gemini-key'
        };

        // Call the getComments function with the fake configuration and the code snippet.
        // This will trigger the mock fetch function to return the mock response.
        const result = await getComments('const x = 1;', 'javascript', fakeConfig, 'default');

        // Expect the result to be the commented code snippet.
        // This assertion verifies that the getComments function returned the expected comment.
        expect(result).toBe('/** fake gemini comments */\nconst x = 1;');
        
        // Expect the fetch function to have been called with the correct URL and options.
        // This assertion verifies that the getComments function made the correct request to the Gemini provider.
        expect(fetch).toHaveBeenCalledWith(
            // URL for the Gemini provider.
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent?key=fake-gemini-key',
            // Options for the fetch call, including the method (POST).
            expect.objectContaining({ method: 'POST' })
        );
    });

    /**
     * Test case: should format request correctly for Groq/OpenAI provider.
     * This test ensures that the getComments function formats the request correctly when using the Groq/OpenAI provider.
     */
    test('should format request correctly for Groq/OpenAI provider', async () => {
        // Mock the fetch function to return a resolved promise with a JSON response.
        // The response contains a single choice with a comment.
        fetch.mockResolvedValueOnce({
            // Mock the json method to return a promise that resolves with the response data.
            json: async () => ({
                // Response data: an array of choices.
                choices: [
                    // Single choice with a comment.
                    { 
                        // Message of the choice.
                        message: { 
                            // Content of the message, including the comment and the original code.
                            content: "/** fake groq comments */\nconst y = 2;" 
                        } 
                    }
                ]
            })
        });

        // Create a fake configuration object for the test.
        // This object contains the necessary parameters for the getComments function, such as provider, model, API key, and base URL.
        const fakeConfig = {
            // Provider: Groq.
            provider: 'groq',
            // Model: llama-test.
            model: 'llama-test',
            // API key: fake-groq-key.
            apiKey: 'fake-groq-key',
            // Base URL for the Groq/OpenAI provider.
            baseUrl: 'https://api.groq.com/openai'
        };

        // Call the getComments function with the fake configuration and the code snippet.
        // This will trigger the mock fetch function to return the mock response.
        const result = await getComments('const y = 2;', 'javascript', fakeConfig, 'default');

        // Expect the result to be the commented code snippet.
        // This assertion verifies that the getComments function returned the expected comment.
        expect(result).toBe('/** fake groq comments */\nconst y = 2;');
        
        // Expect the fetch function to have been called with the correct URL and options.
        // This assertion verifies that the getComments function made the correct request to the Groq/OpenAI provider.
        expect(fetch).toHaveBeenCalledWith(
            // URL for the Groq/OpenAI provider.
            'https://api.groq.com/openai/v1/chat/completions',
            // Options for the fetch call, including the method (POST) and authorization header.
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    // Authorization header with the API key.
                    'Authorization': 'Bearer fake-groq-key'
                })
            })
        );
    });
});