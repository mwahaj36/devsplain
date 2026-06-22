const { execSync } = require('child_process');

/** Test suite for CLI integration */
describe('CLI Integration', () => {

    /** Test case: Default to scanning root folder if no filepath is provided */
    test('should default to scanning root folder if no filepath is provided', () => {
        try {
            // Execute the CLI command with a mock API key
            execSync('node bin/cli.js', {
                env: { ...process.env, DEVSPLAIN_API_KEY: 'mock' }
            });
        } catch (error) {
            const output = error.stdout ? error.stdout.toString() : '';
            // Verify the error output contains the expected message
            expect(output).toContain('Scanning directory:');
        }
    });

    /** Test case: Exit with error 1 if a fake filepath is provided */
    test('should exit with error 1 if a fake filepath is provided', () => {
        try {
            // Execute the CLI command with a fake filepath
            execSync('node bin/cli.js definitely_fake_file.js');
        } catch (error) {
            // Verify the error message and status code
            expect(error.stdout.toString()).toContain("Error: The path 'definitely_fake_file.js' does not exist.");
            expect(error.status).toBe(1);
        }
    });

});