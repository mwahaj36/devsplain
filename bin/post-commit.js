const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { spliceComments } = require('./cli');

/** Main execution block for post-commit hook [ds] */
try {
    // Check if SKIP_DEVSPLAIN environment variable is set [ds]
    if (process.env.SKIP_DEVSPLAIN) {
        console.log('[devsplain] SKIP_DEVSPLAIN is set. Bypassing AI generation.');
        process.exit(0);
    }

    // Determine if Git is in a rebasing, merging, or cherry-picking state [ds]
    const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
    const isRebasing = fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'));
    const isMerging = fs.existsSync(path.join(gitDir, 'MERGE_HEAD'));
    const isCherryPicking = fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'));

    // Exit if Git is in a rebasing, merging, or cherry-picking state to avoid history conflicts [ds]
    if (isRebasing || isMerging || isCherryPicking) {
        console.log('[devsplain] Skipping AI comment generation during git rebase/merge/cherry-pick to avoid history conflicts.');
        process.exit(0);
    }

    // Retrieve the last commit message [ds]
    const lastCommitMsg = execSync('git log -1 --format=%s', { encoding: 'utf8' }).trim();
    if (lastCommitMsg === 'docs: auto-generated comments by devsplain') {
        process.exit(0);
    }

    // Get a list of changed files in the last commit [ds]
    const changedFilesStr = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { encoding: 'utf8' }).trim();
    if (!changedFilesStr) {
        process.exit(0);
    }
    const changedFiles = changedFilesStr.split(/\r?\n/);

    /** List of valid file extensions for auto-commenting [ds] */
    const validExtensions = [
        '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.scss', '.vue', '.svelte',
        '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rb', '.php', '.rs',
        '.swift', '.kt', '.dart', '.sh'
    ];

    /** Filter function to determine which files to auto-comment [ds] */
    const filesToComment = changedFiles.filter(file => {
        const ext = path.extname(file).toLowerCase();
        const isIgnored = file.includes('node_modules/') || file.includes('tests/') || file.includes('__tests__/') || file.includes('fixtures/');
        return validExtensions.includes(ext) && fs.existsSync(file) && !isIgnored;
    });

    if (filesToComment.length === 0) {
        process.exit(0);
    }

    // Log the number of files found for auto-commenting [ds]
    console.log(`[devsplain] Found ${filesToComment.length} file(s) in the last commit to auto-comment.`);

    // Parse command-line arguments for mode flags [ds]
    const args = process.argv.slice(2);
    let modeFlag = '';
    if (args.includes('--light')) modeFlag = ' --light';
    if (args.includes('--full')) modeFlag = ' --full';

    let commentedAny = false;
    const successfullyCommentedFiles = [];

    /** Loop through each file to auto-comment [ds] */
    for (const file of filesToComment) {
        // Attempt to read file contents and previous version [ds]
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

            // Check if file contents have changed (ignoring comments) [ds]
            if (contentPrev) {
                const cleanHead = spliceComments(contentHead, [], 'prune', ext);
                const cleanPrev = spliceComments(contentPrev, [], 'prune', ext);
                const isExplicitOverwrite = !!process.env.DS_OVER;
                if (cleanHead === cleanPrev && !isExplicitOverwrite) {
                    console.log(`[devsplain] Skipping ${file}: commit contains only comment changes.`);
                    continue;
                }
            }
        } catch (cleanErr) {
        }

        // Log and attempt to auto-comment the current file [ds]
        console.log(`[devsplain] Automatically commenting file: ${file}`);
        try {
            let extraFlags = '';
            if (process.env.DS_OVER) extraFlags += ' --overwrite';
            if (process.env.DS_KEEP) extraFlags += ' --keep';

            // Construct the command to run the auto-commenting CLI [ds]
            const cliPath = path.join(__dirname, 'cli.js');
            execSync(`node "${cliPath}" "${file}" --force${modeFlag}${extraFlags}`, { stdio: 'inherit' });
            commentedAny = true;
            successfullyCommentedFiles.push(file);
        } catch (err) {
            console.warn(`[devsplain] Warning: Failed to comment ${file}: ${err.message}`);
        }
    }

    /** If any files were successfully commented, stage and commit changes [ds] */
    if (commentedAny) {
        for (const file of successfullyCommentedFiles) {
            try {
                execSync(`git add "${file}"`);
            } catch (addErr) {}
        }
        
        const stagedChanges = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
        if (stagedChanges.length > 0) {
            console.log('[devsplain] Staging and committing auto-generated comments...');
            execSync('git commit -m "docs: auto-generated comments by devsplain" --no-verify', { stdio: 'inherit' });
            console.log('[devsplain] Comments committed successfully! Rollback via: git reset --hard HEAD~1');
        }
    }
// Catch and log any errors that occur during execution [ds]
} catch (e) {
    console.warn(`[devsplain] Warning: post-commit hook script failed: ${e.message}`);
}
