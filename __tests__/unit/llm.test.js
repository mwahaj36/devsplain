const { 
    getComments, 
    runWithConcurrency, 
    resetConcurrency, 
    getChunkConfig, 
    PROVIDER_PROFILES, 
    setDiscoveredTierLimit, 
    CHUNK_SIZE, 
    CHUNK_OVERLAP, 
    CHUNK_THRESHOLD 
} = require('../../lib/llm');

global.fetch = jest.fn();

describe('LLM Module (getComments)', () => {
    beforeEach(() => {
        fetch.mockClear();
        resetConcurrency(2);
    });

    test('should format request correctly for Gemini provider', async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
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
            ok: true,
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

    test('should format request correctly for DeepSeek provider', async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                choices: [
                    { 
                        message: { 
                            content: '[{"line": 1, "comment": "// fake deepseek comments"}]' 
                        } 
                    }
                ]
            })
        });

        const fakeConfig = {
            provider: 'deepseek',
            model: 'deepseek-chat',
            apiKey: 'fake-deepseek-key',
            baseUrl: 'https://api.deepseek.com'
        };

        const result = await getComments('const z = 3;', 'javascript', fakeConfig, 'default');

        expect(result).toEqual([
            { line: 1, comment: '// fake deepseek comments' }
        ]);
        expect(fetch).toHaveBeenCalledWith(
            'https://api.deepseek.com/v1/chat/completions',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Authorization': 'Bearer fake-deepseek-key',
                    'Content-Type': 'application/json'
                }),
                body: expect.stringContaining('"model":"deepseek-chat"')
            })
        );
    });

    test('should instruct LLM to use /* */ for CSS files', async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
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
            ok: true,
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
    }, 10000);

    // ─── NEW: Anti-triviality prompt test ─────────────────────────────────────
    test('should include anti-triviality negative constraints in the prompt', async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                choices: [
                    { message: { content: '[]' } }
                ]
            })
        });

        const fakeConfig = {
            provider: 'groq',
            model: 'llama-test',
            apiKey: 'fake-groq-key',
            baseUrl: 'https://api.groq.com/openai'
        };

        await getComments('const x = 1;', 'main.js', fakeConfig, 'default');

        const requestBody = JSON.parse(fetch.mock.calls[0][1].body);
        const prompt = requestBody.messages[0].content;
        expect(prompt).toContain('ANTI-TRIVIALITY RULES');
        expect(prompt).toContain('NEVER write comments that merely narrate the syntax');
        expect(prompt).toContain('Quality over quantity');
    });

    // ─── NEW: Chunking test ───────────────────────────────────────────────────
    test('should chunk files exceeding threshold and preserve global line numbers', async () => {
        // Create a file with 300 lines (exceeds CHUNK_THRESHOLD of 250) [ds]
        const bigCode = Array.from({ length: 300 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');

        // Calculate expected number of chunks [ds]
        const expectedChunks = Math.ceil((300 - CHUNK_SIZE) / (CHUNK_SIZE - CHUNK_OVERLAP)) + 1;

        // Mock fetch to return line-appropriate comments for each chunk [ds]
        for (let c = 0; c < expectedChunks; c++) {
            const chunkStart = c * (CHUNK_SIZE - CHUNK_OVERLAP);
            const commentLine = chunkStart + 1;
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    choices: [
                        { message: { content: `[{"line": ${commentLine}, "comment": "// chunk ${c + 1} comment"}]` } }
                    ]
                })
            });
        }

        const fakeConfig = {
            provider: 'groq',
            model: 'llama-test',
            apiKey: 'fake-groq-key',
            baseUrl: 'https://api.groq.com/openai'
        };

        const result = await getComments(bigCode, 'big.js', fakeConfig, 'default');

        // Verify multiple fetch calls were made (chunking happened) [ds]
        expect(fetch).toHaveBeenCalledTimes(expectedChunks);

        // Verify all returned comments have valid global line numbers [ds]
        expect(result.length).toBe(expectedChunks);
        for (const comment of result) {
            expect(comment.line).toBeGreaterThanOrEqual(1);
            expect(comment.line).toBeLessThanOrEqual(300);
        }

        // Verify the prompts contain global line numbers, not chunk-local ones [ds]
        const firstCallBody = JSON.parse(fetch.mock.calls[0][1].body);
        const firstPrompt = firstCallBody.messages[0].content;
        expect(firstPrompt).toContain('1: const line1');

        if (expectedChunks > 1) {
            const secondCallBody = JSON.parse(fetch.mock.calls[1][1].body);
            const secondPrompt = secondCallBody.messages[0].content;
            // Second chunk should start at line (CHUNK_SIZE - CHUNK_OVERLAP + 1) [ds]
            const secondChunkStartLine = CHUNK_SIZE - CHUNK_OVERLAP + 1;
            expect(secondPrompt).toContain(`${secondChunkStartLine}: const line${secondChunkStartLine}`);
        }
    });

    // ─── NEW: Small files skip chunking ───────────────────────────────────────
    test('should NOT chunk files under the threshold', async () => {
        const smallCode = Array.from({ length: 50 }, (_, i) => `const x${i} = ${i};`).join('\n');

        fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                choices: [
                    { message: { content: '[{"line": 1, "comment": "// small file comment"}]' } }
                ]
            })
        });

        const fakeConfig = {
            provider: 'groq',
            model: 'llama-test',
            apiKey: 'fake-groq-key',
            baseUrl: 'https://api.groq.com/openai'
        };

        const result = await getComments(smallCode, 'small.js', fakeConfig, 'default');

        // Only 1 fetch call = no chunking [ds]
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(result).toEqual([{ line: 1, comment: '// small file comment' }]);
    });

    // ─── NEW: 429 rate limit triggers serial fallback ─────────────────────────
    test('should fall back to serial mode on 429 rate limit', async () => {
        // Create a file big enough to chunk [ds]
        const bigCode = Array.from({ length: 300 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');
        const expectedChunks = Math.ceil((300 - CHUNK_SIZE) / (CHUNK_SIZE - CHUNK_OVERLAP)) + 1;

        let callCount = 0;
        fetch.mockImplementation(async (url, options) => {
            callCount++;
            // First call returns 429 to trigger fallback [ds]
            if (callCount === 1) {
                return { ok: false, status: 429, statusText: 'Too Many Requests' };
            }
            // Subsequent calls succeed [ds]
            return {
                ok: true,
                json: async () => ({
                    choices: [
                        { message: { content: `[{"line": ${callCount}, "comment": "// retry comment"}]` } }
                    ]
                })
            };
        });

        const fakeConfig = {
            provider: 'groq',
            model: 'llama-test',
            apiKey: 'fake-groq-key',
            baseUrl: 'https://api.groq.com/openai'
        };

        // Suppress console.warn during this test [ds]
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await getComments(bigCode, 'big.js', fakeConfig, 'default');

        // Verify we got results despite the initial 429 [ds]
        expect(result.length).toBeGreaterThan(0);

        // Verify the serial fallback warning was logged [ds]
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('Rate limit hit')
        );

        warnSpy.mockRestore();
    }, 30000);

    // ─── NEW: Deduplication across overlapping chunks ─────────────────────────
    test('should deduplicate comments from overlapping chunks', async () => {
        const bigCode = Array.from({ length: 300 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');
        const expectedChunks = Math.ceil((300 - CHUNK_SIZE) / (CHUNK_SIZE - CHUNK_OVERLAP)) + 1;

        // Both chunks return a comment for the same overlapping line [ds]
        const overlapLine = CHUNK_SIZE - CHUNK_OVERLAP + 5;
        for (let c = 0; c < expectedChunks; c++) {
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    choices: [
                        { message: { content: `[{"line": ${overlapLine}, "comment": "// from chunk ${c + 1}"}]` } }
                    ]
                })
            });
        }

        const fakeConfig = {
            provider: 'groq',
            model: 'llama-test',
            apiKey: 'fake-groq-key',
            baseUrl: 'https://api.groq.com/openai'
        };

        const result = await getComments(bigCode, 'big.js', fakeConfig, 'default');

        // Only one comment for the overlapping line (first chunk wins) [ds]
        const commentsForLine = result.filter(c => c.line === overlapLine);
        expect(commentsForLine.length).toBe(1);
        expect(commentsForLine[0].comment).toBe('// from chunk 1');
    });
});

describe('runWithConcurrency', () => {
    beforeEach(() => {
        resetConcurrency(3);
    });

    test('should process all items', async () => {
        const items = [1, 2, 3, 4, 5];
        const results = await runWithConcurrency(items, async (item) => item * 2);
        expect(results).toEqual([2, 4, 6, 8, 10]);
    });

    test('should propagate errors from task functions', async () => {
        const items = [1, 2, 3];
        await expect(
            runWithConcurrency(items, async (item) => {
                if (item === 2) throw new Error('Boom');
                return item;
            })
        ).rejects.toThrow('Boom');
    });
});

describe('Model-Adaptive Chunking & Tier Scaling', () => {
    beforeEach(() => {
        fetch.mockClear();
        resetConcurrency(2);
    });

    test('should return provider-specific chunk profiles', () => {
        const groqCfg = getChunkConfig({ provider: 'groq' });
        expect(groqCfg.size).toBe(200);
        expect(groqCfg.threshold).toBe(250);
        expect(groqCfg.maxTokens).toBe(1000);

        const deepseekCfg = getChunkConfig({ provider: 'deepseek' });
        expect(deepseekCfg.size).toBe(600);
        expect(deepseekCfg.threshold).toBe(750);
        expect(deepseekCfg.maxTokens).toBe(8192);

        const geminiCfg = getChunkConfig({ provider: 'gemini' });
        expect(geminiCfg.size).toBe(800);
        expect(geminiCfg.threshold).toBe(1000);

        const defaultCfg = getChunkConfig({ provider: 'unknown' });
        expect(defaultCfg.size).toBe(250);
    });

    test('should respect manual chunkSize override from config', () => {
        const customCfg = getChunkConfig({ provider: 'groq', chunkSize: 500, chunkThreshold: 625, chunkOverlap: 50 });
        expect(customCfg.size).toBe(500);
        expect(customCfg.threshold).toBe(625);
        expect(customCfg.overlap).toBe(50);
    });

    test('should dynamically scale chunk size when response header reveals high tier limit', () => {
        setDiscoveredTierLimit(200000);
        const scaledCfg = getChunkConfig({ provider: 'deepseek' });
        expect(scaledCfg.size).toBe(900); // 600 * 1.5
        expect(scaledCfg.threshold).toBe(1125); // 750 * 1.5
    });

    test('should NOT chunk a 500-line file on DeepSeek provider', async () => {
        const mediumCode = Array.from({ length: 500 }, (_, i) => `const x${i} = ${i};`).join('\n');
        fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                choices: [
                    { message: { content: '[{"line": 1, "comment": "// single shot comment"}]' } }
                ]
            })
        });

        const dsConfig = {
            provider: 'deepseek',
            model: 'deepseek-chat',
            apiKey: 'fake-ds-key',
            baseUrl: 'https://api.deepseek.com'
        };

        const result = await getComments(mediumCode, 'medium.js', dsConfig, 'default');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(result).toEqual([{ line: 1, comment: '// single shot comment' }]);
    });
});