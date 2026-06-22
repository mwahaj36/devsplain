const fs = require('fs');
const path = require('path');
// Import execSync from child_process module for executing shell commands
const { execSync } = require('child_process');
const readline = require('readline');

/** Installs native Git hooks for auto-commenting and pre-commit testing */
/** Installs native Git hooks for auto-commenting and pre-commit testing */
async function installHooks() {
    try {
        // Get the path to the Git directory
        // Get the path to the Git directory using git rev-parse --git-dir
        const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
        const hooksDir = path.join(gitDir, 'hooks');
        
        // Ensure the hooks directory exists
        // Ensure hooks directory exists
        // Create the hooks directory if it does not exist
        if (!fs.existsSync(hooksDir)) {
            fs.mkdirSync(hooksDir, { recursive: true });
        }

        // Set default mode choice
        // Set default mode choice to balanced (mix of JSDoc and sparse inline comments)
        let modeChoice = '1';
        if (process.stdout.isTTY) {
            // Create a readline interface for user input
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            // Create a readline interface for user input
            // Function to ask a question and resolve with the user's answer
            const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

            // Display mode selection options
            // Display mode selection options to the user
            console.log('\nSelect default commenting mode for Git commits:');
            console.log('1. Balanced (mix of JSDoc and sparse inline comments)');
            console.log('2. Light (JSDoc block comments above functions only)');
            console.log('3. Full (aggressive inline commenting)');
            const answer = await askQuestion('Select (1-3, default: 1): ');
            modeChoice = answer.trim() || '1';
            rl.close();
        }

        // Determine mode arguments based on the user's selection
        // Determine mode arguments based on user selection
        let modeArgs = '';
        if (modeChoice === '2') {
            modeArgs = ' --light';
        } else if (modeChoice === '3') {
            modeArgs = ' --full';
        }

        // Setup pre-commit hook to run tests
        /** Setup pre-commit hook to run tests */
        // 1. Setup pre-commit hook (to run tests)
        // Define the pre-commit hook script
        // Define the pre-commit hook script
        const preCommitHookPath = path.join(hooksDir, 'pre-commit');
        const preCommitContent = `#!/bin/sh
# devsplain native pre-commit hook
echo "Running pre-commit tests..."
npm test || exit 1
`;
        fs.writeFileSync(preCommitHookPath, preCommitContent);
        try {
            fs.chmodSync(preCommitHookPath, 0o755);
        } catch (err) {}

        /** Setup post-commit hook for auto-commenting */
        // Setup post-commit hook for auto-commenting
        // 2. Setup post-commit hook (to auto-comment)
        // Define the post-commit hook script
        // Define the post-commit hook script
        const postCommitHookPath = path.join(hooksDir, 'post-commit');
        const postCommitContent = `#!/bin/sh
# devsplain native post-commit hook
echo "Auto-generating comments for files in the last commit..."
node bin/post-commit.js${modeArgs} || exit 1
`;
        fs.writeFileSync(postCommitHookPath, postCommitContent);
        try {
            fs.chmodSync(postCommitHookPath, 0o755);
        } catch (err) {}

        // Display success message after installing hooks
        // Display success message
        console.log('Success: Native Git pre-commit and post-commit hooks installed successfully!');
    // Catch any errors during hook installation
    // Catch any errors during hook installation
    } catch (e) {
        console.warn('Warning: Could not set up Git hooks (not inside a git repository or git command missing).');
    }
}

// Call the installHooks function
installHooks();
