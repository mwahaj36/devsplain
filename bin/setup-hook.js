const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

/**
 * Orchestrates the installation of Git pre-commit and post-commit hooks.
 * Sets up necessary directories and writes hook files with user-selected configuration.
*/
async function installHooks() {
    try {
        // Determine the actual git directory path using git command line tool
        const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
        const hooksDir = path.join(gitDir, 'hooks');
        // Ensure the hooks directory exists before attempting to write files
        if (!fs.existsSync(hooksDir)) {
            fs.mkdirSync(hooksDir, { recursive: true });
        }

        let modeChoice = '1';
        // Prompt the user for mode selection only if running in an interactive terminal session
        if (process.stdout.isTTY) {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

            console.log('\nSelect default commenting mode for Git commits:');
            console.log('1. Balanced (mix of JSDoc and sparse inline comments)');
            console.log('2. Light (JSDoc block comments above functions only)');
            console.log('3. Full (aggressive inline commenting)');
            const answer = await askQuestion('Select (1-3, default: 1): ');
            modeChoice = answer.trim() || '1';
            rl.close();
        }

        // Map user input to CLI arguments for the post-commit script execution
        let modeArgs = '';
        if (modeChoice === '2') {
            modeArgs = ' --light';
        } else if (modeChoice === '3') {
            modeArgs = ' --full';
        }

        // Generate and write the pre-commit shell script to trigger tests before committing
        const preCommitHookPath = path.join(hooksDir, 'pre-commit');
        const preCommitContent = `#!/bin/sh
# devsplain native pre-commit hook
if [ -f package.json ] && grep -q '"test"' package.json 2>/dev/null; then
  echo "Running pre-commit tests..."
  npm test || exit 1
fi
`;
        fs.writeFileSync(preCommitHookPath, preCommitContent);
        try {
            // Apply execute permissions to the hook file
            fs.chmodSync(preCommitHookPath, 0o755);
        } catch (err) {}

        // Normalize the path for cross-platform compatibility when injecting into shell script
        const postCommitScript = path.join(__dirname, 'post-commit.js').replace(/\\/g, '/');

        // Generate and write the post-commit shell script to execute the documentation generation
        const postCommitHookPath = path.join(hooksDir, 'post-commit');
        const postCommitContent = `#!/bin/sh
# devsplain native post-commit hook
echo "Auto-generating comments for files in the last commit..."
node "${postCommitScript}"${modeArgs} || exit 1
`;
        fs.writeFileSync(postCommitHookPath, postCommitContent);
        // Apply execute permissions to the hook file
        try {
            fs.chmodSync(postCommitHookPath, 0o755);
        } catch (err) {}

        console.log('Success: Native Git pre-commit and post-commit hooks installed successfully!');
    } catch (e) {
        console.warn('Warning: Could not set up Git hooks (not inside a git repository or git command missing).');
    }
}

// Execute installation automatically if this script is run as the entry point
if (require.main === module) {
    installHooks();
}
module.exports = installHooks;
