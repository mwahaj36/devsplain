// Import the getConfig function from the config module
const { getConfig } = require('../../lib/config');
// Import the file system module
const fs = require('fs');

// Mock the fs module to control its behavior during testing
jest.mock('fs');

/**
 * Test suite for the Config Module, specifically the getConfig function.
 * 
 * This suite aims to ensure the getConfig function behaves as expected under different scenarios.
 * 
 * @description This test suite covers various scenarios to validate the getConfig function's behavior.
 */
describe('Config Module (getConfig)', () => {

    /**
     * Before each test, clear all mocks to start with a clean slate.
     * 
     * @description Prevents interference between tests by clearing all mocks before each test case.
     */
    beforeEach(() => {
        // Clear all mocks to prevent interference between tests
        jest.clearAllMocks();
    });

    /**
     * Test that the getConfig function returns the existing config if the .devsplainrc file exists.
     * 
     * This test case covers the happy path where the config file is present and can be read successfully.
     * 
     * @description Validates the getConfig function's behavior when the .devsplainrc file exists.
     */
    test('should return existing config if the .devsplainrc file exists', async () => {
        // Mock the existsSync method to return true, indicating the file exists
        // NOTE: this assumes the file path is correctly resolved by the existsSync method
        fs.existsSync.mockReturnValue(true);
        
        // Define a fake config object to be returned by the readFileSync mock
        // NOTE: this object should match the expected shape of the config object
        const fakeConfig = {
            // Provider for the config
            provider: 'groq',
            // API key for the config
            apiKey: 'super-secret-test-key',
            // Model for the config
            model: 'llama-test-model',
            // Base URL for the config
            baseUrl: 'https://api.groq.com/openai'
        };
        // Mock the readFileSync method to return the fake config as a JSON string
        // NOTE: this assumes the readFileSync method returns a JSON string
        fs.readFileSync.mockReturnValue(JSON.stringify(fakeConfig));

        // Call the getConfig function and await its result
        // NOTE: this assumes the getConfig function returns a promise
        const config = await getConfig();

        // Expect the returned config to match the fake config
        // NOTE: this uses Jest's toEqual matcher to compare the config objects
        expect(config).toEqual(fakeConfig);
        
        // Expect the existsSync method to have been called
        // NOTE: this verifies the existsSync method was called as expected
        expect(fs.existsSync).toHaveBeenCalled();
        // Expect the readFileSync method to have been called
        // NOTE: this verifies the readFileSync method was called as expected
        expect(fs.readFileSync).toHaveBeenCalled();
    });
});