// Import the child_process module to enable execution of shell commands
const { execSync } = require('child_process');

/**
 * Test suite for CLI integration.
 * 
 * This suite contains tests for CLI commands, covering various scenarios 
 * including invalid file paths and missing file paths.
 * 
 * @description This suite is designed to verify the correctness of the CLI 
 * implementation, ensuring it behaves as expected under different input conditions.
 */
describe('CLI Integration', () => {

    /**
     * Test case: Verify that the CLI exits with error code 1 when no file path is provided.
     * 
     * This test uses the execSync function from the child_process module to 
     * execute the CLI command. The command is executed without a file path, 
     * which is expected to result in an error.
     * 
     * @throws {Error} If the CLI command does not exit with error code 1.
     * @description This test case checks the scenario where no file path is provided 
     * to the CLI command, and verifies that it exits with the expected error code.
     */
    test('should exit with error 1 if no filepath is provided', () => {
        // Attempt to execute the CLI command without a file path
        try {
            // Execute the CLI command and capture the output
            // NOTE: execSync is a synchronous function that executes the command and returns the output
            execSync('node bin/cli.js');
        } catch (error) {
            // Verify that the error message contains the expected usage string
            // Expect the error message to contain the usage string
            expect(error.stdout.toString()).toContain('usage: devsplain <file-or-directory>');
            // Verify that the error status is 1, indicating that the CLI command exited with an error
            // Expect the error status to be 1, which indicates an error occurred
            expect(error.status).toBe(1);
        }
    });

    /**
     * Test case: Verify that the CLI exits with error code 1 when a fake file path is provided.
     * 
     * This test uses the execSync function from the child_process module to 
     * execute the CLI command. The command is executed with a fake file path, 
     * which is expected to result in an error.
     * 
     * @throws {Error} If the CLI command does not exit with error code 1.
     * @description This test case checks the scenario where a fake file path is 
     * provided to the CLI command, and verifies that it exits with the expected error code.
     */
    test('should exit with error 1 if a fake filepath is provided', () => {
        // Attempt to execute the CLI command with a fake file path
        try {
            // Execute the CLI command with a fake file path and capture the output
            // NOTE: The fake file path 'definitely_fake_file.js' is used to test the error handling
            execSync('node bin/cli.js definitely_fake_file.js');
        } catch (error) {
            // Verify that the error message contains the expected error string
            // Expect the error message to contain the error string indicating the file path does not exist
            expect(error.stdout.toString()).toContain("Error: The path 'definitely_fake_file.js' does not exist.");
            // Verify that the error status is 1, indicating that the CLI command exited with an error
            // Expect the error status to be 1, which indicates an error occurred
            expect(error.status).toBe(1);
        }
    });

});