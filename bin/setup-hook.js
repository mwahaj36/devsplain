const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

async function installHooks() {
    try {
        const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
        const hooksDir = path.join(gitDir, 'hooks');
        
        // Ensure hooks directory exists
        if (!fs.existsSync(hooksDir)) {
            fs.mkdirSync(hooksDir, { recursive: true });
        }

        let modeChoice = '1';
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

        let modeArgs = '';
        if (modeChoice === '2') {
            modeArgs = ' --light';
        } else if (modeChoice === '3') {
            modeArgs = ' --full';
        }

        // 1. Setup pre-commit hook (to run tests)
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

        // 2. Setup post-commit hook (to auto-comment)
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

        console.log('Success: Native Git pre-commit and post-commit hooks installed successfully!');
    } catch (e) {
        console.warn('Warning: Could not set up Git hooks (not inside a git repository or git command missing).');
    }
}

installHooks();
