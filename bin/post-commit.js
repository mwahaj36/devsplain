const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { spliceComments } = require('./cli');

// Wrap logic in try-catch to prevent blocking the git commit process on failure
try {
    const lastCommitMsg = execSync('git log -1 --format=%s', { encoding: 'utf8' }).trim();
    // Avoid infinite loops if this hook triggered the current commit
    if (lastCommitMsg === 'docs: auto-generated comments by devsplain') {
        process.exit(0);
    }

    const changedFilesStr = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { encoding: 'utf8' }).trim();
    if (!changedFilesStr) {
        process.exit(0);
    }
    const changedFiles = changedFilesStr.split(/\r?\n/);

    // Define supported file extensions for auto-documentation
    const validExtensions = [
        '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.scss', '.vue', '.svelte',
        '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rb', '.php', '.rs',
        '.swift', '.kt', '.dart', '.sh'
    ];

    // Filter changed files to include only supported extensions that currently exist
    const filesToComment = changedFiles.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return validExtensions.includes(ext) && fs.existsSync(file);
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

    // Iterate through each changed file to check if content actually changed
    for (const file of filesToComment) {
        try {
            const ext = path.extname(file).toLowerCase();
            // Retrieve current file content from filesystem
            const contentHead = fs.readFileSync(file, 'utf8');
            let contentPrev = '';
            // Attempt to fetch the version of the file from the previous commit for comparison
            try {
                contentPrev = execSync(`git show HEAD~1:"${file}"`, { 
                    encoding: 'utf8', 
                    stdio: ['ignore', 'pipe', 'ignore'] 
                });
            } catch (prevErr) {
            }

            if (contentPrev) {
                // Strip existing comments to determine if the logic changed or just documentation
                const cleanHead = spliceComments(contentHead, [], 'clean', ext);
                const cleanPrev = spliceComments(contentPrev, [], 'clean', ext);
                if (cleanHead === cleanPrev) {
                    console.log(`[devsplain] Skipping ${file}: commit contains only comment changes.`);
                    continue;
                }
            }
        } catch (cleanErr) {
        }

        console.log(`[devsplain] Automatically commenting file: ${file}`);
        try {
            // Invoke the CLI tool to generate comments for the changed file
            const cliPath = path.join(__dirname, 'cli.js');
            execSync(`node "${cliPath}" "${file}" --force${modeFlag}`, { stdio: 'inherit' });
            commentedAny = true;
        } catch (err) {
            console.warn(`[devsplain] Warning: Failed to comment ${file}: ${err.message}`);
        }
    }

    // If changes were made, stage and commit them automatically to the current branch
    if (commentedAny) {
        const status = execSync('git diff --name-only', { encoding: 'utf8' }).trim();
        if (status.length > 0) {
            console.log('[devsplain] Staging and committing auto-generated comments...');
            // Use --no-verify to prevent triggering this hook recursively during the commit
            execSync('git commit -am "docs: auto-generated comments by devsplain" --no-verify', { stdio: 'inherit' });
            console.log('[devsplain] Comments committed successfully! Rollback via: git reset --hard HEAD~1');
        }
    }
} catch (e) {
    console.warn(`[devsplain] Warning: post-commit hook script failed: ${e.message}`);
}
