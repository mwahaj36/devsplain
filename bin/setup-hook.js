const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

/** [ds]
 * Automatically detects the local Git repository structure, configures hook directories,
 * allows the user to select a commenting intensity mode, installs executable pre-commit
 * and post-commit shell hooks, and ensures a .devsplainignore file is generated or updated
 * based on existing .gitignore patterns to defer specific paths from automated comment injection.
*/
async function installHooks() {
    try {
        // Exec 'git rev-parse --git-dir' to identify the absolute path to the Git directory, normalizing the output by removing any trailing whitespace characters. [ds]
        const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
        // Exec 'git rev-parse --show-toplevel' to obtain the absolute path to the top-level directory of the Git repository, parsing away any trailing whitespace to ensure clean path handling. [ds]
        const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
        // Construct the absolute path to the 'hooks' directory by joining the discovered Git directory path with the subfolder name 'hooks'. [ds]
        const hooksDir = path.join(gitDir, 'hooks');
        // Preemptive check to evaluate if the target 'hooks' directory currently exists in the file system to prevent unnecessary file operations. [ds]
        if (!fs.existsSync(hooksDir)) {
            // Preventively generate the directory hierarchy if it is missing, passing 'recursive: true' so that parent directories are automatically created alongside the target. [ds]
            fs.mkdirSync(hooksDir, { recursive: true });
        }

        // Initialize the selected execution mode with a default value of '1', which corresponds to a 'Balanced' commenting strategy, pending further user interaction or console settings. [ds]
        let modeChoice = '1';
        // Check the 'isTTY' property to ascertain whether the current process is running in a true interactive terminal environment capable of capturing standard input. [ds]
        if (process.stdout.isTTY) {
            // Construct an interactive command-line interface, binding the input stream to the standard terminal output to enable typed responses from the executing user. [ds]
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            // Define a reusable utility function that wraps the readline interface's question method, encapsulating the asynchronous nature of input polling into a standard resolved Promise. [ds]
            const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

            // Print an introductory banner to the standard output, prompting the user to establish the preferred level of conceptual commenting density. [ds]
            console.log('\nSelect default commenting mode for Git commits:');
            // Display the first selectable option, which represents a balanced hybrid of structural JSDoc blocks and contextual inline variable annotations. [ds]
            console.log('1. Balanced (mix of JSDoc and sparse inline comments)');
            // Display the second selectable option, which restricts automated formatting solely to high-level JSDoc block comments sitting directly above declared functions. [ds]
            console.log('2. Light (JSDoc block comments above functions only)');
            // Display the third selectable option, which executes an aggressive generation strategy injecting exhaustive inline step-by-step commentary for every functional line. [ds]
            console.log('3. Full (aggressive inline commenting)');
            // Establish a continuous, infinite loop necessary to repeatedly prompt the user for terminal input until a fully valid and non-empty alphanumeric selection is secured. [ds]
            while (true) {
                // Suspend execution while awaiting the asynchronous resolution of the user's keyboard input, subsequently clearing any leading or trailing accidental spaces from the selection string. [ds]
                const answer = (await askQuestion('Select (1-3, default: 1): ')).trim();
                // Perform a boolean evaluation to verify if the received input is either an empty string (which invokes the default state) or strictly matches one of the three valid numerical identifiers. [ds]
                if (answer === '' || ['1', '2', '3'].includes(answer)) {
                    // Store the validated input into the 'modeChoice' tracking variable; safely defaulting to '1' automatically if the user provided an empty or whitespace-only string selection. [ds]
                    modeChoice = answer || '1';
                    // Successfully terminate the infinite validation loop upon securing a valid configuration selection, passing execution to the subsequent argument construction logic. [ds]
                    break;
                }
                console.log('Invalid choice. Please select 1, 2, or 3.');
            // Output an explicit validation error message to the user's terminal to instruct them that the provided numerical format was out of the defined allowable logical bounds. [ds]
            }
            // Explicitly terminate the active readline interface to cleanly release captured system resources, preventing residual event listeners from blocking the Node.js event loop. [ds]
            rl.close();
        }

        // Declare a string container, initialized with an empty state, intended to house custom command-line flags corresponding to the identified user selection preferences. [ds]
        let modeArgs = '';
        // Branch execution path if the user dynamically opted into the 'Light' commenting threshold, which dictates minimal architectural styling without deep execution line mapping. [ds]
        if (modeChoice === '2') {
            // Assign the literal command-line flag '--light', prepending a space to facilitate seamless templating into the future shell script argument string. [ds]
            modeArgs = ' --light';
        // Alternate conditional execution path triggered if the user selected the 'Full' commenting threshold, indicating a mandate for high-verbosity and deeply inline code descriptions. [ds]
        } else if (modeChoice === '3') {
            // Assign the literal string value '--full', ensuring a preceding space is present so it consistently formats cleanly as a discrete command-line flag argument. [ds]
            modeArgs = ' --full';
        }

        // Programmatically assemble the complete absolute file path directing toward the executable segment intended for the Git pre-commit lifecycle event hook. [ds]
        const preCommitHookPath = path.join(hooksDir, 'pre-commit');
        // Generate a shell script body utilizing multi-line template literals to define the structural logic required to programmatically intercept and inspect the pre-commit sequence. [ds]
        const preCommitContent = `#!/bin/sh
# devsplain native pre-commit hook
if [ -f package.json ] && grep -q '"test"' package.json 2>/dev/null; then
  echo "Running pre-commit tests..."
  npm test || exit 1
fi
`;
        // Check the state of the file system to determine whether a pre-existing pre-commit hook artifact has already been deployed to the repository's primary hooking directory. [ds]
        if (fs.existsSync(preCommitHookPath)) {
            // Synchronously read the complete, unmodified contents of the pre-existing hook script and capture it into a string for subsequent signature-based integrity verification. [ds]
            const existing = fs.readFileSync(preCommitHookPath, 'utf8');
            // Perform a string mutation check on the existing file body to ascertain if the deployer's specific native hash signature ('# devsplain native pre-commit hook') is entirely absent. [ds]
            if (!existing.includes('# devsplain native pre-commit hook')) {
                // If the target signature is absent, signaling that an external custom hook is currently in place, safely concatenate and append the required new native testing execution block to the file's tail. [ds]
                fs.appendFileSync(preCommitHookPath, '\n' + preCommitContent);
            } else {
                // If the required native signature is detected within the existing payload, force a full overwrite of the file object to cleanly restore it to the precise native implementation state. [ds]
                fs.writeFileSync(preCommitHookPath, preCommitContent);
            }
        } else {
            // Account for the primary cold-start condition where no prior hook file is detected, directly creating the configuration file and persisting the newly templated bash command chain. [ds]
            fs.writeFileSync(preCommitHookPath, preCommitContent);
        }
        // Enclose the specific file permission modification routine within an internal fail-safe error boundary to prevent total deployment aborts upon platform-specific permission barriers. [ds]
        try {
            // Mutate the file system metadata, overriding standard safety permissions to specifically set executable read/write/execute privileges (octal 0o755) upon the newly written artifact. [ds]
            fs.chmodSync(preCommitHookPath, 0o755);
        } catch (err) {}

        // Evaluate the script's global root directory path, dynamically applying a standard global regular expression substitution to forcibly normalize any Windows-style backslash path breaks into universal forward slashes. [ds]
        const postCommitScript = path.join(__dirname, 'post-commit.js').replace(/\\/g, '/');

        // Dynamically map the generated environment state to assemble the absolute full path string intended to target and configure the subsequent Git post-commit lifecycle event. [ds]
        const postCommitHookPath = path.join(hooksDir, 'post-commit');
        // Create a formatted string literal using multi-line template interpolation to construct the actual executable shell command sequence invoking localized script handling at the post-commit stage. [ds]
        const postCommitContent = `#!/bin/sh
# devsplain native post-commit hook
echo "Auto-generating comments for files in the last commit..."
node "${postCommitScript}"${modeArgs} || exit 1
`;
        // Execute a fast synchronous existence check against the post-commit path variable to identify if a command chain is already resident and active in the system's Git hook directory. [ds]
        if (fs.existsSync(postCommitHookPath)) {
            // Pull the existing code from the post-commit sequence file stored on the underlying disk format into the active memory context for structural logical inspection and validation. [ds]
            const existing = fs.readFileSync(postCommitHookPath, 'utf8');
            // Test the retrieved content payload against the specific hard-coded signature string of the native pipeline to definitively state whether this artifact was previously managed by this system. [ds]
            if (!existing.includes('# devsplain native post-commit hook')) {
                // If the identification signature is missing, execute a safety-preserve action by appending the new script array to the end of the file, rather than running a destructive overwrite deletion. [ds]
                fs.appendFileSync(postCommitHookPath, '\n' + postCommitContent);
            } else {
                // If the specific native marker is found, the system assumes full ownership and forces an atomic file rewrite to precisely match the expected execution payload and override missing lines. [ds]
                fs.writeFileSync(postCommitHookPath, postCommitContent);
            }
        } else {
            // Address the initial initialization state, bypassing the append logic to directly create the target artifact file and persist the customized templated post-commit execution code. [ds]
            fs.writeFileSync(postCommitHookPath, postCommitContent);
        }
        // Instantiate a nested error containing architecture that protects the vital permission update command from cascading uncaught errors and halting subsequent hook deployment operations. [ds]
        try {
            // Update the file system permissions on the post-commit hook specifically to 0o755 to guarantee that the core operating system is functionally authorized to execute the file as a shell script. [ds]
            fs.chmodSync(postCommitHookPath, 0o755);
        } catch (err) {}

        // Provide immediate visual stdout feedback to the user's command prompt, proving the successful localization and environment writing of the post-commit file within the local repository. [ds]
        console.log(`[devsplain] Git post-commit hook successfully installed at: ${postCommitHookPath}`);

        // Construct the top-level root path variable by joining the current repository base with the hidden custom generated environment suffix '.devsplainignore'. [ds]
        const ignorePath = path.join(gitRoot, '.devsplainignore');
        // Define a compact hardcoded array payload storing the foundational and universally recognized developer ignore standard defaults, such as local frameworks, build outputs, and IDE-specific state caches. [ds]
        const defaultIgnoreLines = [
            'node_modules/', '.git/', 'dist/', 'build/', 'out/',
            '.next/', '.nuxt/', '.svelte-kit/',
            'venv/', 'env/', '.venv/',
            '.vscode/', '.idea/', 'coverage/',
            'tests/', '__tests__/', 'fixtures/'
        ];

        // Assemble the exact path coordinates in memory for the root-level standard '.gitignore' file, which has underlying authority and precedence in determining the repository's ignored visual outputs. [ds]
        const gitignorePath = path.join(gitRoot, '.gitignore');
        // Prepare an empty array structural container for active utilization, designed specifically to intake, parse, and hold the filtered, non-comment active lines from the previously discovered gitignore. [ds]
        let gitignoreLines = [];
        // Verify at the file-system level whether the conventional and standard root-level '.gitignore' has been explicitly manually created and secured within the exact repository target directory. [ds]
        if (fs.existsSync(gitignorePath)) {
            // Load the complete raw textual representation of the discovered '.gitignore' configuration into an in-memory variable utilizing the universally resilient default UTF-8 character encoding system. [ds]
            const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
            // Invoke a high-performance string splitting operation using a strictly matching regular expression explicitly designed to handle both standard newline and cross-platform carriage-return formatting styles. [ds]
            gitignoreLines = gitignoreContent.split(/\r?\n/)
                // Pipe the generated string array sequentially to a map operation, systematically iterating and applying strict whitespace-parsing to the exact front and rear boundary of each individual detected line. [ds]
                .map(l => l.trim())
                // Perform a rigorous structural filter over the parsed array, executing a boolean check to actively strip out and eject any empty strings, fully inert lines, and purely informational documentation comment headers. [ds]
                .filter(l => l && !l.startsWith('#'));
        }

        // Execute a protective condition to verify if the target internal hidden '.devsplainignore' file is completely absent to dictate whether to handle a fresh creation or an existing incremental update. [ds]
        if (!fs.existsSync(ignorePath)) {
            // Compute the exact structural delta by aggressively filtering the raw '.gitignore' payload to physically exclude all internal defaults that the system has already explicitly hardcoded and initialized by design. [ds]
            const gitignoreOnly = gitignoreLines.filter(p => !defaultIgnoreLines.includes(p));
            // Dynamically synthesize the initial sequential payload by collapsing the hardcoded default ignore array values into a single flat string specifically utilizing standard UNIX newline separators. [ds]
            let content = defaultIgnoreLines.join('\n') + '\n';
            // Check if the resulting differential payload contains any logically unmatched and entirely novel patterns generated from the operational '.gitignore' system's custom user environment needs. [ds]
            if (gitignoreOnly.length > 0) {
                // Conditionally chain the newly discovered custom repository rules to the back of the initial payload string, physically interpolating a clear visual banner to indicate external origin. [ds]
                content += '\n# From .gitignore\n' + gitignoreOnly.join('\n') + '\n';
            }
            // Resolve the structural assembly and explicitly write the synthesized logical payload representation down to disk to officially establish the root of the hidden configuration file context. [ds]
            fs.writeFileSync(ignorePath, content);
            // Present an immediate confirmation message directly to the user's terminal prompting, explicitly validating and proving the successful deployment of the new hidden configuration artifact. [ds]
            console.log(`[devsplain] Created .devsplainignore at: ${ignorePath}`);
            // Evaluate if any custom unique patterns survived the comparative filtering process, specifically serving as the logical trigger to broadcast the exact number of migrated items. [ds]
            if (gitignoreOnly.length > 0) {
                // Output a localized high-fidelity statistics string dynamically interpolating the exact numerical length of the moved unique patterns from the external environment into the internal file. [ds]
                console.log(`[devsplain] Merged ${gitignoreOnly.length} pattern(s) from .gitignore into .devsplainignore.`);
            }
        } else {
            // Navigate into the supplementary update pathway specifically designated for handling active repositories which have already previously established and generated their custom hidden ignore file structure. [ds]
            const existingContent = fs.readFileSync(ignorePath, 'utf8');
            // Sync-read the fully active existing payload and programmatically pipeline it through the exact same data parsing and filtering sanitation chain used earlier to extract viable active structural rules. [ds]
            const existingLines = existingContent.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
            // Dynamically isolate the exact, fully matching strings belonging to the root outer system level that are entirely and systematically missing from the current active internal existing hidden ignore file. [ds]
            const newPatterns = gitignoreLines.filter(p => !existingLines.includes(p));
            // Perform an evaluation to specifically check if the structural delta extraction operation returned an array populated with even one actively required and missing novel unique operating rule. [ds]
            if (newPatterns.length > 0) {
                // Formulate a targeted append text structure by concatenating the isolated novel lines linearly, automatically prepending a human-readable informational text category banner underneath. [ds]
                const appendContent = '\n# From .gitignore\n' + newPatterns.join('\n') + '\n';
                // Execute a non-destructive, physically conservative file appending command to strictly guarantee that the newly appended array chunk is safely padded down to the final byte of the active text file. [ds]
                fs.appendFileSync(ignorePath, appendContent);
                // Broadcast a specifically targeted command prompt notification, accurately surfacing the exact counted quantity of active novel logical rules that were conditionally propagated into the system local file. [ds]
                console.log(`[devsplain] Merged ${newPatterns.length} new pattern(s) from .gitignore into .devsplainignore.`);
            // Drop into the else-if fallback branch, logically dictated directly by the complete absence of any missing novel patterns, specifically paired with a confirmation that the source external archive contains items. [ds]
            } else if (gitignoreLines.length > 0) {
                // Display a purely confirmatory terminal sequence to log the structural immutability state, explicitly projecting and confirming that the system internal system is already completely complete and synchronized. [ds]
                console.log('[devsplain] .devsplainignore is already up-to-date with .gitignore patterns.');
            }
        }

    // Enclose the exhaustively complex environment check, write, and setup process inside a robust fail-safe exception container in order to safely capture immediate downstream system interruptions gracefully. [ds]
    } catch (e) {
        // Intercept the caught high-level exception, force a standardized and targeted warning status into the console, specifically flagging the potential unavailability of native Git CLI command systems. [ds]
        console.warn('Warning: Could not set up Git hooks (not inside a git repository or git command missing).');
        console.warn(e.message);
    }
}

/** [ds]
 * Scans the active Git repository's hook location, identifies the native developers' hook
 * marker signature, then safely executes a hard unlink process to completely delete
 * the corresponding lifecycle script, alongside confirming the operational status via
 * standard terminal output prompting to the executing user.
*/
async function removeHooks() {
    try {
        // Re-invoke the internal Git configuration command to discover the precise filesystem location of the underlying Git state directory utilizing standard cross-platform normalizing output. [ds]
        const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
        // Synthesize the direct absolute path coordinates required to target the actual, specific folder housing predefined lifecycle event scripts directly operating through the Git process. [ds]
        const hooksDir = path.join(gitDir, 'hooks');
        // Define an immutable object payload map mapping each specific expected lifecycle event identifier strictly to the exact embedded string signature utilized to prove complete system ownership. [ds]
        const hookSignatures = {
            'pre-commit': '# devsplain native pre-commit hook',
            'post-commit': '# devsplain native post-commit hook'
        };

        // Inception a strict numeric integer tracking variable, structurally initialized to zero, which will exclusively and atomically evaluate and count the total fully successful hard deletions executed. [ds]
        let removed = 0;
        // Initiate a strictly bounded for...of structural traversal cycle directly over the mapped object entries, dynamically isolating the primary key identifier label and the target string marker value. [ds]
        for (const [hookName, signature] of Object.entries(hookSignatures)) {
            // Construct the exact, un-escaped absolute target path string natively resolved by joining the isolated sub-folder base coordinate with the actively evaluated specific lifecycle hook name string. [ds]
            const hookPath = path.join(hooksDir, hookName);
            // Execute a fast, direct filesystem probe to safely verify if the exact isolated file structure actually fully exists and remains physically active on the disk device at the targeted coordinates. [ds]
            if (fs.existsSync(hookPath)) {
                // If affirmative, read the physical file payload from the disk entirely into string memory specifically utilizing the standard UTF-8 encoding protocol to fully prepare for in-memory deep parsing. [ds]
                const content = fs.readFileSync(hookPath, 'utf8');
                // String-search the stored active file memory state to check definitively for the presence of the primary native system hash signature physically marking complete file ownership to this system. [ds]
                if (content.includes(signature)) {
                    // Confidently resolve the file pathway and immediately execute a destructive physical unlink operation that entirely and irreversibly removes the target file structure from the local computer's drive. [ds]
                    fs.unlinkSync(hookPath);
                    // Log an immediate, high-visibility success confirmation to the user prompt area, dynamically interpolating the exact function of the deleted script target alongside its precise absolute storage directory. [ds]
                    console.log(`[devsplain] Removed ${hookName} hook at: ${hookPath}`);
                    // Safely mutate the previously initialized tracking variable integer by executing a direct increment by one strictly and exclusively upon the completion of undeniably proven targeted file deletion. [ds]
                    removed++;
                } else {
                    // Otherwise, navigate to a conservative refusal branch indicating that a conflicting external script resides at the exact same directory coordinates, thereby forcing the process to completely skip physical deletion. [ds]
                    console.log(`[devsplain] Skipping ${hookName}: not installed by devsplain.`);
                }
            } else {
                // Navigate to a safe fallback branch addressing an empty slot condition where no structural file system paths are discovered to be actively mapped at the target destination point to evaluate. [ds]
                console.log(`[devsplain] No ${hookName} hook found at: ${hookPath}`);
            }
        }

        // Check if the counter tracking variable was mutated from an initial zero state to prove that at least one highly targeted physical file deletion process actively survived through execution cleanly. [ds]
        if (removed > 0) {
            // Broadcast a localized final success tally update to the user console, dynamically surfacing the exact total count of fully removed lifecycle event operations within the active Git system workspace. [ds]
            console.log(`[devsplain] Successfully removed ${removed} hook(s).`);
        } else {
            // Display an unconditional, globally quiet status report immediately to the user's active standard output, specifically concluding and notifying that absolutely no conflicting active structured installations were found to delete. [ds]
            console.log('[devsplain] No devsplain hooks were found to remove.');
        }
    } catch (e) {
        // Intercept any sudden crashes from the deletion cycle, immediately transforming the raw error payload into a targeted and focused console warning to prevent abrupt termination of the parent CLI execution. [ds]
        console.warn('Warning: Could not remove Git hooks (not inside a git repository or git command missing).');
        console.warn(e.message);
    }
}

// Verify the module's native invocation context by comparing the currently running entry point object literal against the module's own namespace reference to guarantee that this file was the direct core origin trigger. [ds]
if (require.main === module) {
    // If validation is completely successful, actively trigger and dispatch the asynchronous installation call responsible for deploying all required Git scripts natively within the currently mapped environment context. [ds]
    installHooks();
}
// Relocate both primary action utilities into the locally configured module's exported public interface dictionary to explicitly permit perfectly controlled programmatic execution from strictly external source systems. [ds]
module.exports = { installHooks, removeHooks };
