const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { spliceComments } = require('./cli');

/** Main execution block [ds] */
try {
    // Allow users to completely bypass the AI hook using an environment variable [ds]
    if (process.env.SKIP_DEVSPLAIN) {
        console.log('[devsplain] SKIP_DEVSPLAIN is set. Bypassing AI generation.');
        process.exit(0);
    }

    // Prevent the hook from firing during rebases, merges, or cherry-picks [ds]
    const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
    const isRebasing = fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'));
    const isMerging = fs.existsSync(path.join(gitDir, 'MERGE_HEAD'));
    const isCherryPicking = fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'));

    if (isRebasing || isMerging || isCherryPicking) {
        console.log('[devsplain] Skipping AI comment generation during git rebase/merge/cherry-pick to avoid history conflicts.');
        process.exit(0);
    }

    /** Check if the current operation is a rebase, merge or cherry-pick [ds] */
    const lastCommitMsg = execSync('git log -1 --format=%s', { encoding: 'utf8' }).trim();
    if (lastCommitMsg === 'docs: auto-generated comments by devsplain') {
        process.exit(0);
    }

    // Get the last commit message [ds]
    const changedFilesStr = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { encoding: 'utf8' }).trim();
    if (!changedFilesStr) {
        process.exit(0);
    }
    const changedFiles = changedFilesStr.split(/\r?\n/);

    /** List of valid file extensions for commenting [ds] */
    const validExtensions = [
        '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.scss', '.vue', '.svelte',
        '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rb', '.php', '.rs',
        '.swift', '.kt', '.dart', '.sh'
    ];

    /** Filter files to be commented [ds] */
    const filesToComment = changedFiles.filter(file => {
        const ext = path.extname(file).toLowerCase();
        const isIgnored = file.includes('node_modules/') || file.includes('tests/') || file.includes('__tests__/') || file.includes('fixtures/');
        return validExtensions.includes(ext) && fs.existsSync(file) && !isIgnored;
    });

    // Check if there are any files to comment [ds]
    if (filesToComment.length === 0) {
        process.exit(0);
    }

    console.log(`[devsplain] Found ${filesToComment.length} file(s) in the last commit to auto-comment.`);

    // Parse command line arguments for mode flag [ds]
    const args = process.argv.slice(2);
    let modeFlag = '';
    if (args.includes('--light')) modeFlag = ' --light';
    if (args.includes('--full')) modeFlag = ' --full';

    let commentedAny = false;
    const successfullyCommentedFiles = [];

    /** Iterate over files to comment [ds] */
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

            // Compare file content before and after the last commit [ds]
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

        // Comment the file using the CLI [ds]
        console.log(`[devsplain] Automatically commenting file: ${file}`);
        try {
            const cliPath = path.join(__dirname, 'cli.js');
            execSync(`node "${cliPath}" "${file}" --force${modeFlag}`, { stdio: 'inherit' });
            commentedAny = true;
            successfullyCommentedFiles.push(file);
        } catch (err) {
            console.warn(`[devsplain] Warning: Failed to comment ${file}: ${err.message}`);
        }
    }

    /** Stage and commit auto-generated comments if any [ds] */
    if (commentedAny) {
        // Only stage the exact files that the AI touched to avoid accidentally committing unstaged work [ds]
        for (const file of successfullyCommentedFiles) {
            try {
                execSync(`git add "${file}"`);
            } catch (addErr) {}
        }
        
        // Check if there are actually staged changes now [ds]
        const stagedChanges = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
        if (stagedChanges.length > 0) {
            console.log('[devsplain] Staging and committing auto-generated comments...');
            execSync('git commit -m "docs: auto-generated comments by devsplain" --no-verify', { stdio: 'inherit' });
            console.log('[devsplain] Comments committed successfully! Rollback via: git reset --hard HEAD~1');
        }
    }
/** Catch and log any errors [ds] */
} catch (e) {
    console.warn(`[devsplain] Warning: post-commit hook script failed: ${e.message}`);
}
