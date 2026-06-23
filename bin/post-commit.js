const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { spliceComments } = require('./cli');

try {
    const lastCommitMsg = execSync('git log -1 --format=%s', { encoding: 'utf8' }).trim();
    if (lastCommitMsg === 'docs: auto-generated comments by devsplain') {
        process.exit(0);
    }

    const changedFilesStr = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { encoding: 'utf8' }).trim();
    if (!changedFilesStr) {
        process.exit(0);
    }
    const changedFiles = changedFilesStr.split(/\r?\n/);

    const validExtensions = [
        '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.scss', '.vue', '.svelte',
        '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rb', '.php', '.rs',
        '.swift', '.kt', '.dart', '.sh'
    ];

    const filesToComment = changedFiles.filter(file => {
        const ext = path.extname(file).toLowerCase();
        const isIgnored = file.includes('node_modules/') || file.includes('tests/') || file.includes('__tests__/') || file.includes('fixtures/');
        return validExtensions.includes(ext) && fs.existsSync(file) && !isIgnored;
    });

    if (filesToComment.length === 0) {
        process.exit(0);
    }

    console.log(`[devsplain] Found ${filesToComment.length} file(s) in the last commit to auto-comment.`);

    const args = process.argv.slice(2);
    let modeFlag = '';
    if (args.includes('--light')) modeFlag = ' --light';
    if (args.includes('--full')) modeFlag = ' --full';

    let commentedAny = false;

    for (const file of filesToComment) {
        try {
            const ext = path.extname(file).toLowerCase();
            const contentHead = fs.readFileSync(file, 'utf8');
            let contentPrev = '';
            try {
                contentPrev = execSync(`git show HEAD~1:"${file}"`, { 
                    encoding: 'utf8', 
                    stdio: ['ignore', 'pipe', 'ignore'] 
                });
            } catch (prevErr) {
            }

            if (contentPrev) {
                const cleanHead = spliceComments(contentHead, [], 'prune', ext);
                const cleanPrev = spliceComments(contentPrev, [], 'prune', ext);
                if (cleanHead === cleanPrev) {
                    console.log(`[devsplain] Skipping ${file}: commit contains only comment changes.`);
                    continue;
                }
            }
        } catch (cleanErr) {
        }

        console.log(`[devsplain] Automatically commenting file: ${file}`);
        try {
            const cliPath = path.join(__dirname, 'cli.js');
            execSync(`node "${cliPath}" "${file}" --force${modeFlag}`, { stdio: 'inherit' });
            commentedAny = true;
        } catch (err) {
            console.warn(`[devsplain] Warning: Failed to comment ${file}: ${err.message}`);
        }
    }

    if (commentedAny) {
        const status = execSync('git diff --name-only', { encoding: 'utf8' }).trim();
        if (status.length > 0) {
            console.log('[devsplain] Staging and committing auto-generated comments...');
            execSync('git commit -am "docs: auto-generated comments by devsplain" --no-verify', { stdio: 'inherit' });
            console.log('[devsplain] Comments committed successfully! Rollback via: git reset --hard HEAD~1');
        }
    }
} catch (e) {
    console.warn(`[devsplain] Warning: post-commit hook script failed: ${e.message}`);
}
