const { execSync } = require('child_process');

describe('CLI Integration', () => {

    test('should default to scanning root folder if no filepath is provided', () => {
        try {
            execSync('node bin/cli.js', {
                env: { ...process.env, DEVSPLAIN_API_KEY: 'mock' }
            });
        } catch (error) {
            const output = error.stdout ? error.stdout.toString() : '';
            expect(output).toContain('Scanning directory:');
        }
    });

    test('should exit with error 1 if a fake filepath is provided', () => {
        try {
            execSync('node bin/cli.js definitely_fake_file.js');
        } catch (error) {
            expect(error.stdout.toString()).toContain("Error: The path 'definitely_fake_file.js' does not exist.");
            expect(error.status).toBe(1);
        }
    });

});