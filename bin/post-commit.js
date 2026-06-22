const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { spliceComments } = require('./cli');

/** Main execution block to detect changes and process documentation generation */
try {
    // Prevent recursive loops if the previous commit was an automated documentation commit
    const lastCommitMsg = execSync('git log -1 --format=%s', { encoding: 'utf8' }).trim();
    if (lastCommitMsg === 'docs: auto-generated comments by devsplain') {
        process.exit(0);
    }

    const changedFilesStr = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { encoding: 'utf8' }).trim();
    if (!changedFilesStr) {
        process.exit(0);
    }
    // Retrieve list of files modified in the latest commit
    const changedFiles = changedFilesStr.split(/\r?\n/);

    const validExtensions = [
        '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.scss', '.vue', '.svelte',
        '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rb', '.php', '.rs',
        '.swift', '.kt', '.dart', '.sh'
    ];

    // Filter for supported file extensions and ensure the file still exists
    const filesToComment = changedFiles.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return validExtensions.includes(ext) && fs.existsSync(file);
    });

    if (filesToComment.length === 0) {
        process.exit(0);
    }

    console.log(`[devsplain] Found ${filesToComment.length} file(s) in the last commit to auto-comment.`);

    // Parse command line arguments to determine documentation verbosity mode
    const args = process.argv.slice(2);
    let modeFlag = '';
    if (args.includes('--light')) modeFlag = ' --light';
    if (args.includes('--full')) modeFlag = ' --full';

    let commentedAny = false;

    // Process each valid file to determine if documentation needs updating
    for (const file of filesToComment) {
        try {
            const ext = path.extname(file).toLowerCase();
            const contentHead = fs.readFileSync(file, 'utf8');
            let contentPrev = '';
            try {
                // Attempt to fetch the file content from the previous commit state for comparison
                contentPrev = execSync(`git show HEAD~1:"${file}"`, { 
                    encoding: 'utf8', 
                    stdio: ['ignore', 'pipe', 'ignore'] 
                });
            } catch (prevErr) {
            }

            if (contentPrev) {
                // Strip comments from head and previous versions to detect if logic actually changed
                const cleanHead = spliceComments(contentHead, [], 'clean', ext);
                const cleanPrev = spliceComments(contentPrev, [], 'clean', ext);
                // Skip processing if only comments were modified in the commit
                if (cleanHead === cleanPrev) {
                    console.log(`[devsplain] Skipping ${file}: commit contains only comment changes.`);
                    continue;
                }
            }
        } catch (cleanErr) {
        }

        console.log(`[devsplain] Automatically commenting file: ${file}`);
        try {
            // Execute the CLI generator for the specific file
            const cliPath = path.join(__dirname, 'cli.js');
            execSync(`node "${cliPath}" "${file}" --force${modeFlag}`, { stdio: 'inherit' });
            commentedAny = true;
        } catch (err) {
            console.warn(`[devsplain] Warning: Failed to comment ${file}: ${err.message}`);
        }
    }

    // If changes were made by the generator, stage and commit the result back to the repository
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
