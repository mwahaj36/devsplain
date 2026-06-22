const { getConfig } = require('../../lib/config');
const fs = require('fs');
const readline = require('readline');

// Mock the fs and readline modules for testing
jest.mock('fs');
jest.mock('readline', () => ({
    createInterface: jest.fn()
}));

/** Test suite for the Config Module (getConfig) */
describe('Config Module (getConfig)', () => {

    // Reset all mocks before each test
    beforeEach(() => {
        jest.clearAllMocks();
    });

    /** Test case: Existing config with .devsplainrc file */
    test('should return existing config if the .devsplainrc file exists', async () => {
        fs.existsSync.mockReturnValue(true);
        const fakeConfig = {
            provider: 'groq',
            apiKey: 'super-secret-test-key',
            model: 'llama-test-model',
            baseUrl: 'https://api.groq.com/openai'
        };
        fs.readFileSync.mockReturnValue(JSON.stringify(fakeConfig));

        const config = await getConfig();

        expect(config).toEqual(fakeConfig);
        expect(fs.existsSync).toHaveBeenCalled();
        expect(fs.readFileSync).toHaveBeenCalled();
    });

    /** Test case: Run wizard if forced or no config file exists */
    test('should run configuration wizard when forceWizard is true', async () => {
        fs.existsSync.mockReturnValue(true);
        fs.writeFileSync = jest.fn();

        const mockRl = {
            question: jest.fn(),
            close: jest.fn()
        };

        // Mock response sequence for:
        // 1. Choice of provider: Gemini (2)
        // 2. Custom model name: press Enter (default gemini-2.0-flash)
        // 3. API key: 'gemini-key'
        // 4. Confirmation: 'y'
        mockRl.question
            .mockImplementationOnce((query, cb) => cb('2'))
            .mockImplementationOnce((query, cb) => cb(''))
            .mockImplementationOnce((query, cb) => cb('gemini-key'))
            .mockImplementationOnce((query, cb) => cb('y'));

        readline.createInterface.mockReturnValue(mockRl);

        const config = await getConfig(true);

        expect(config).toEqual({
            provider: 'gemini',
            model: 'gemini-2.0-flash',
            apiKey: 'gemini-key',
            baseUrl: null
        });

        expect(readline.createInterface).toHaveBeenCalled();
        expect(mockRl.close).toHaveBeenCalled();
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.any(String),
            JSON.stringify(config, null, 2)
        );
    });
});