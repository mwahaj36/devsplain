const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

/**
 * Orchestrates the installation of Git pre-commit and post-commit hooks.
 * Detects the local .git directory and configures hooks with user-specified mode.
*/
async function installHooks() {
    try {
        // Determine the path to the .git directory
        const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
        const hooksDir = path.join(gitDir, 'hooks');
        if (!fs.existsSync(hooksDir)) {
            fs.mkdirSync(hooksDir, { recursive: true });
        }

        let modeChoice = '1';
        // Interact with user via terminal to select documentation verbosity
        if (process.stdout.isTTY) {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            // Promisify readline to allow async flow control
            const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

            console.log('\nSelect default commenting mode for Git commits:');
            console.log('1. Balanced (mix of JSDoc and sparse inline comments)');
            console.log('2. Light (JSDoc block comments above functions only)');
            console.log('3. Full (aggressive inline commenting)');
            const answer = await askQuestion('Select (1-3, default: 1): ');
            modeChoice = answer.trim() || '1';
            rl.close();
        }

        // Map selected mode to command-line arguments for the post-commit script
        let modeArgs = '';
        if (modeChoice === '2') {
            modeArgs = ' --light';
        } else if (modeChoice === '3') {
            modeArgs = ' --full';
        }

        // Create the executable pre-commit script
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
            // Ensure the hook file is executable
            fs.chmodSync(preCommitHookPath, 0o755);
        } catch (err) {}

        // Locate the source script for post-commit actions
        const postCommitScript = path.join(__dirname, 'post-commit.js').replace(/\\/g, '/');

        // Create the executable post-commit script that calls the documentation engine
        const postCommitHookPath = path.join(hooksDir, 'post-commit');
        const postCommitContent = `#!/bin/sh
# devsplain native post-commit hook
echo "Auto-generating comments for files in the last commit..."
node "${postCommitScript}"${modeArgs} || exit 1
`;
        fs.writeFileSync(postCommitHookPath, postCommitContent);
        try {
            // Ensure the hook file is executable
            fs.chmodSync(postCommitHookPath, 0o755);
        } catch (err) {}

        console.log('Success: Native Git pre-commit and post-commit hooks installed successfully!');
    } catch (e) {
        console.warn('Warning: Could not set up Git hooks (not inside a git repository or git command missing).');
    }
}

if (require.main === module) {
    installHooks();
}
module.exports = installHooks;
