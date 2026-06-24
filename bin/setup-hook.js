const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

/** Installs Git hooks and configures commit settings [ds] */
async function installHooks() {
    try {
        const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
        const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
        const hooksDir = path.join(gitDir, 'hooks');
        if (!fs.existsSync(hooksDir)) {
            fs.mkdirSync(hooksDir, { recursive: true });
        }

        let modeChoice = '1';
        // Check if process is run in a TTY environment [ds]
        if (process.stdout.isTTY) {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

            // Prompt user to select the default commenting mode [ds]
            console.log('\nSelect default commenting mode for Git commits:');
            console.log('1. Balanced (mix of JSDoc and sparse inline comments)');
            console.log('2. Light (JSDoc block comments above functions only)');
            console.log('3. Full (aggressive inline commenting)');
            
            // Validate user input for commenting mode [ds]
            while (true) {
                const answer = (await askQuestion('Select (1-3, default: 1): ')).trim();
                if (answer === '' || ['1', '2', '3'].includes(answer)) {
                    modeChoice = answer || '1';
                    break;
                }
                console.log('Invalid choice. Please select 1, 2, or 3.');
            }
            rl.close();
        }

        // Determine mode arguments based on user choice [ds]
        let modeArgs = '';
        if (modeChoice === '2') {
            modeArgs = ' --light';
        } else if (modeChoice === '3') {
            modeArgs = ' --full';
        }

        // Define the pre-commit hook script [ds]
        const preCommitHookPath = path.join(hooksDir, 'pre-commit');
        const preCommitContent = `#!/bin/sh
# devsplain native pre-commit hook
if [ -f package.json ] && grep -q '"test"' package.json 2>/dev/null; then
  echo "Running pre-commit tests..."
  npm test || exit 1
fi
`;
        // Write the pre-commit hook to the Git hooks directory [ds]
        fs.writeFileSync(preCommitHookPath, preCommitContent);
        try {
            fs.chmodSync(preCommitHookPath, 0o755);
        } catch (err) {}

        // Define the post-commit script path [ds]
        const postCommitScript = path.join(__dirname, 'post-commit.js').replace(/\\/g, '/');

        // Define the post-commit hook script [ds]
        const postCommitHookPath = path.join(hooksDir, 'post-commit');
        const postCommitContent = `#!/bin/sh
# devsplain native post-commit hook
echo "Auto-generating comments for files in the last commit..."
node "${postCommitScript}"${modeArgs} || exit 1
`;
        fs.writeFileSync(postCommitHookPath, postCommitContent);
        try {
            fs.chmodSync(postCommitHookPath, 0o755);
        } catch (err) {}

        // Inform the user about the successful installation of the post-commit hook [ds]
        console.log(`[devsplain] Git post-commit hook successfully installed at: ${postCommitHookPath}`);

        // Check if a .devsplainignore file exists in the Git root directory [ds]
        const ignorePath = path.join(gitRoot, '.devsplainignore');
        if (!fs.existsSync(ignorePath)) {
            const defaultIgnore = `node_modules/
.git/
dist/
build/
out/
.next/
.nuxt/
.svelte-kit/
venv/
env/
.venv/
.vscode/
.idea/
coverage/
tests/
__tests__/
fixtures/
`;
            fs.writeFileSync(ignorePath, defaultIgnore);
            console.log(`[devsplain] Created default .devsplainignore file at: ${ignorePath}`);
        }
    } catch (e) {
        console.warn('Warning: Could not set up Git hooks (not inside a git repository or git command missing).');
        console.warn(e.message);
    }
}

// Check if the script is run as the main module [ds]
if (require.main === module) {
    installHooks();
}
// Export the installHooks function for external use [ds]
module.exports = installHooks;
