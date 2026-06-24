const { getConfig } = require('../../lib/config');
const fs = require('fs');
const readline = require('readline');

jest.mock('fs');
jest.mock('readline', () => ({
    createInterface: jest.fn()
}));

describe('Config Module (getConfig)', () => {

    beforeEach(() => {
        jest.clearAllMocks();
    });

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

    test('should run configuration wizard when forceWizard is true', async () => {
        fs.existsSync.mockReturnValue(true);
        fs.writeFileSync = jest.fn();

        const mockRl = {
            question: jest.fn(),
            close: jest.fn()
        };

        mockRl.question
            .mockImplementationOnce((query, cb) => cb('2'))
            .mockImplementationOnce((query, cb) => cb(''))
            .mockImplementationOnce((query, cb) => cb('gemini-key'))
            .mockImplementationOnce((query, cb) => cb('y')) // autoPrune
            .mockImplementationOnce((query, cb) => cb('y')); // confirm

        readline.createInterface.mockReturnValue(mockRl);

        const config = await getConfig(true);

        expect(config).toEqual({
            provider: 'gemini',
            model: 'gemini-2.0-flash',
            apiKey: 'gemini-key',
            baseUrl: null,
            autoPrune: true
        });

        expect(readline.createInterface).toHaveBeenCalled();
        expect(mockRl.close).toHaveBeenCalled();
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.any(String),
            JSON.stringify(config, null, 2)
        );
    });
});