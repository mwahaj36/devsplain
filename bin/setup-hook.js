const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

/** Installs Git hooks for the repository. [ds] */
async function installHooks() {
    try {
        const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
        const hooksDir = path.join(gitDir, 'hooks');
        if (!fs.existsSync(hooksDir)) {
            fs.mkdirSync(hooksDir, { recursive: true });
        }

        let modeChoice = '1';
        // Check if process is running in a TTY to prompt for user input [ds]
        if (process.stdout.isTTY) {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            // Create a readline interface for user input [ds]
            const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

            // Display a menu for the user to select the default commenting mode [ds]
            console.log('\nSelect default commenting mode for Git commits:');
            console.log('1. Balanced (mix of JSDoc and sparse inline comments)');
            console.log('2. Light (JSDoc block comments above functions only)');
            console.log('3. Full (aggressive inline commenting)');
            const answer = await askQuestion('Select (1-3, default: 1): ');
            modeChoice = answer.trim() || '1';
            rl.close();
        }

        // Determine the command line arguments based on the chosen mode [ds]
        let modeArgs = '';
        if (modeChoice === '2') {
            modeArgs = ' --light';
        } else if (modeChoice === '3') {
            modeArgs = ' --full';
        }

        // Define the path to the pre-commit hook file [ds]
        const preCommitHookPath = path.join(hooksDir, 'pre-commit');
        const preCommitContent = `#!/bin/sh
# devsplain native pre-commit hook
if [ -f package.json ] && grep -q '"test"' package.json 2>/dev/null; then
  echo "Running pre-commit tests..."
  npm test || exit 1
fi
`;
        fs.writeFileSync(preCommitHookPath, preCommitContent);
        // Attempt to set the execute permissions for the pre-commit hook file [ds]
        try {
            fs.chmodSync(preCommitHookPath, 0o755);
        } catch (err) {}

        // Define the path to the post-commit script [ds]
        const postCommitScript = path.join(__dirname, 'post-commit.js').replace(/\\/g, '/');

        // Define the path to the post-commit hook file [ds]
        const postCommitHookPath = path.join(hooksDir, 'post-commit');
        const postCommitContent = `#!/bin/sh
# devsplain native post-commit hook
echo "Auto-generating comments for files in the last commit..."
node "${postCommitScript}"${modeArgs} || exit 1
`;
        fs.writeFileSync(postCommitHookPath, postCommitContent);
        // Attempt to set the execute permissions for the post-commit hook file [ds]
        try {
            fs.chmodSync(postCommitHookPath, 0o755);
        } catch (err) {}

        // Display a success message if the hooks are installed successfully [ds]
        console.log('Success: Native Git pre-commit and post-commit hooks installed successfully!');
    // Catch and handle any exceptions that occur during the installation process [ds]
    } catch (e) {
        console.warn('Warning: Could not set up Git hooks (not inside a git repository or git command missing).');
    }
}

// Check if this script is being run directly (not being required as a module) [ds]
if (require.main === module) {
    installHooks();
}
// Export the installHooks function as a module [ds]
module.exports = installHooks;
