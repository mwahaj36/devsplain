const { getComments } = require('../../lib/llm');

global.fetch = jest.fn();

describe('LLM Module (getComments)', () => {
    beforeEach(() => {
        fetch.mockClear();
    });

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

        const fakeConfig = {
            provider: 'gemini',
            model: 'gemini-test',
            apiKey: 'fake-gemini-key'
        };

        const result = await getComments('const x = 1;', 'javascript', fakeConfig, 'default');

        expect(result).toEqual([
            { line: 1, comment: '// fake gemini comments' }
        ]);
        expect(fetch).toHaveBeenCalledWith(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent?key=fake-gemini-key',
            expect.objectContaining({ method: 'POST' })
        );
    });

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

        const fakeConfig = {
            provider: 'groq',
            model: 'llama-test',
            apiKey: 'fake-groq-key',
            baseUrl: 'https://api.groq.com/openai'
        };

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

    test('should instruct LLM to use /* */ for CSS files', async () => {
        fetch.mockResolvedValueOnce({
            json: async () => ({
                choices: [
                    { 
                        message: { 
                            content: '[{"line": 1, "comment": "/* css comment */"}]' 
                        } 
                    }
                ]
            })
        });

        const fakeConfig = {
            provider: 'groq',
            model: 'llama-test',
            apiKey: 'fake-groq-key',
            baseUrl: 'https://api.groq.com/openai'
        };

        const result = await getComments('body { color: red; }', 'style.css', fakeConfig, 'default');
        expect(result).toEqual([
            { line: 1, comment: '/* css comment */' }
        ]);

        const requestBody = JSON.parse(fetch.mock.calls[0][1].body);
        const prompt = requestBody.messages[0].content;
        expect(prompt).toContain('In CSS/SCSS, you MUST use /* ... */ for comments');
    });

    test('should reject comments containing unescaped non-comment lines', async () => {
        fetch.mockResolvedValueOnce({
            json: async () => ({
                choices: [
                    { 
                        message: { 
                            content: '[{"line": 1, "comment": "// first line\\nconst malicious = true;\\n// third line"}]' 
                        } 
                    }
                ]
            })
        });

        const fakeConfig = {
            provider: 'groq',
            model: 'llama-test',
            apiKey: 'fake-groq-key',
            baseUrl: 'https://api.groq.com/openai'
        };

        await expect(getComments('const x = 1;', 'main.js', fakeConfig, 'default'))
            .rejects.toThrow(/Security Error: Comment on line 1 contains invalid non-comment line/);
    });

    test('should preserve original error message on network failure', async () => {
        fetch.mockRejectedValue(new Error('Connection reset by peer'));

        const fakeConfig = {
            provider: 'groq',
            model: 'llama-test',
            apiKey: 'fake-groq-key',
            baseUrl: 'https://api.groq.com/openai'
        };

        await expect(getComments('const x = 1;', 'main.js', fakeConfig, 'default'))
            .rejects.toThrow('AI Provider Request Failed: Connection reset by peer');
    });
});