const { getConfig } = require('../../lib/config');
const fs = require('fs');
const readline = require('readline');

// Mock the fs and readline modules for isolation in the test environment
// Mock the fs and readline modules for isolation in the test environment
// Mock the fs and readline modules for testing
jest.mock('fs');
jest.mock('readline', () => ({
    createInterface: jest.fn()
}));

/** Test suite for the Config Module (getConfig) */
describe('Config Module (getConfig)', () => {

    // Reset all mocks before each test to ensure test independence
    // Reset all mocks before each test
    // Reset all mocks before each test to ensure test independence
    beforeEach(() => {
        jest.clearAllMocks();
    });

    /** Test case: Existing config with .devsplainrc file */
    /** Test case: Existing config with .devsplainrc file to verify successful retrieval of configuration */
    test('should return existing config if the .devsplainrc file exists', async () => {
        // Mock the existence of the .devsplainrc file
        fs.existsSync.mockReturnValue(true);
        const fakeConfig = {
            provider: 'groq',
            apiKey: 'super-secret-test-key',
            model: 'llama-test-model',
            baseUrl: 'https://api.groq.com/openai'
        // Mock the existing config data for testing purposes
        // Mock the existing config data for testing purposes
        };
        fs.readFileSync.mockReturnValue(JSON.stringify(fakeConfig));

        const config = await getConfig();

        expect(config).toEqual(fakeConfig);
        expect(fs.existsSync).toHaveBeenCalled();
        expect(fs.readFileSync).toHaveBeenCalled();
    });

    /** Test case: Run wizard if forced or no config file exists to configure setup */
    /** Test case: Run wizard if forced or no config file exists to configure setup */
    /** Test case: Run wizard if forced or no config file exists */
    test('should run configuration wizard when forceWizard is true', async () => {
        fs.existsSync.mockReturnValue(true);
        fs.writeFileSync = jest.fn();

        // Define a mock readline interface for simulating user input during the wizard
        // Define a mock readline interface for simulating user input during the wizard
        const mockRl = {
            question: jest.fn(),
            close: jest.fn()
        };

        // Define the expected sequence of user responses during the configuration wizard
        // Define the expected sequence of user responses during the configuration wizard
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

        // Set up the mock readline interface as a return value for createInterface
        // Set up the mock readline interface as a return value for createInterface
        readline.createInterface.mockReturnValue(mockRl);

        // Invoke getConfig with forceWizard set to true to initiate the configuration wizard
        // Invoke getConfig with forceWizard set to true to initiate the configuration wizard
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