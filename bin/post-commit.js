const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { spliceComments } = require('./cli');

/** Attempts to execute the post-commit hook [ds] */
try {
    // Prevent the hook from firing during rebases, merges, or cherry-picks [ds]
    const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
    const isRebasing = fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'));
    const isMerging = fs.existsSync(path.join(gitDir, 'MERGE_HEAD'));
    const isCherryPicking = fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'));

    if (isRebasing || isMerging || isCherryPicking) {
        console.log('[devsplain] Skipping AI comment generation during git rebase/merge/cherry-pick to avoid history conflicts.');
        process.exit(0);
    }

    // Get the last commit message [ds]
    const lastCommitMsg = execSync('git log -1 --format=%s', { encoding: 'utf8' }).trim();
    if (lastCommitMsg === 'docs: auto-generated comments by devsplain') {
        process.exit(0);
    }

    // Get the list of changed files in the last commit [ds]
    const changedFilesStr = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { encoding: 'utf8' }).trim();
    if (!changedFilesStr) {
        process.exit(0);
    }
    const changedFiles = changedFilesStr.split(/\r?\n/);

    /** Defines a list of valid file extensions for commenting [ds] */
    const validExtensions = [
        '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.scss', '.vue', '.svelte',
        '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rb', '.php', '.rs',
        '.swift', '.kt', '.dart', '.sh'
    ];

    /** Filters the changed files based on valid extensions and existence [ds] */
    const filesToComment = changedFiles.filter(file => {
        const ext = path.extname(file).toLowerCase();
        const isIgnored = file.includes('node_modules/') || file.includes('tests/') || file.includes('__tests__/') || file.includes('fixtures/');
        return validExtensions.includes(ext) && fs.existsSync(file) && !isIgnored;
    });

    if (filesToComment.length === 0) {
        process.exit(0);
    }

    // Log the number of files to be commented [ds]
    console.log(`[devsplain] Found ${filesToComment.length} file(s) in the last commit to auto-comment.`);

    // Parse command-line arguments for commenting mode [ds]
    const args = process.argv.slice(2);
    let modeFlag = '';
    if (args.includes('--light')) modeFlag = ' --light';
    if (args.includes('--full')) modeFlag = ' --full';

    let commentedAny = false;

    /** Iterates through the files to be commented and attempts to comment each one [ds] */
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

            // Check if the file has been modified beyond just comments [ds]
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

        // Attempt to comment the file using the cli script [ds]
        console.log(`[devsplain] Automatically commenting file: ${file}`);
        try {
            const cliPath = path.join(__dirname, 'cli.js');
            execSync(`node "${cliPath}" "${file}" --force${modeFlag}`, { stdio: 'inherit' });
            commentedAny = true;
        } catch (err) {
            console.warn(`[devsplain] Warning: Failed to comment ${file}: ${err.message}`);
        }
    }

    /** If any files were commented, stage and commit the changes [ds] */
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
