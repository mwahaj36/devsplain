const { getComments } = require('../../lib/llm');

global.fetch = jest.fn();

/** Test suite for LLM Module (getComments) */
describe('LLM Module (getComments)', () => {
    
    beforeEach(() => {
        fetch.mockClear();
    });

    /** Tests if getComments formats request correctly for Gemini provider */
    test('should format request correctly for Gemini provider', async () => {
        fetch.mockResolvedValueOnce({
            json: async () => ({
                candidates: [
                    { 
                        content: { 
                            parts: [{ 
                                text: '[{"line": 1, "comment": "// fake gemini comments"}]' 
                            }] 
                        } 
                    }
                ]
            })
        });

        // Setup test configuration for Gemini provider
        const fakeConfig = {
            provider: 'gemini',
            model: 'gemini-test',
            apiKey: 'fake-gemini-key'
        };

        // Call getComments with test configuration and code snippet
        const result = await getComments('const x = 1;', 'javascript', fakeConfig, 'default');

        expect(result).toEqual([
            { line: 1, comment: '// fake gemini comments' }
        ]);
        
        expect(fetch).toHaveBeenCalledWith(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent?key=fake-gemini-key',
            expect.objectContaining({ method: 'POST' })
        );
    });

    /** Tests if getComments formats request correctly for Groq/OpenAI provider */
    test('should format request correctly for Groq/OpenAI provider', async () => {
        fetch.mockResolvedValueOnce({
            json: async () => ({
                choices: [
                    { 
                        message: { 
                            content: '[{"line": 1, "comment": "// fake groq comments"}]' 
                        } 
                    }
                ]
            })
        });

        // Setup test configuration for Groq/OpenAI provider
        const fakeConfig = {
            provider: 'groq',
            model: 'llama-test',
            apiKey: 'fake-groq-key',
            baseUrl: 'https://api.groq.com/openai'
        };

        // Call getComments with test configuration and code snippet
        const result = await getComments('const y = 2;', 'javascript', fakeConfig, 'default');

        expect(result).toEqual([
            { line: 1, comment: '// fake groq comments' }
        ]);
        
        expect(fetch).toHaveBeenCalledWith(
            'https://api.groq.com/openai/v1/chat/completions',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Authorization': 'Bearer fake-groq-key'
                })
            })
        );
    });
});