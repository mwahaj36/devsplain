
const { getComments } = require('../lib/llm.js');
const { getConfig } = require('../lib/config.js');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

let rl;
let askQuestion;

/** Checks if the current directory is a git repository and if it contains uncommitted changes. */
function isGitDirty() {
    // Wrap in try-catch to handle potential errors if git command is missing
    try {
        // Check if directory is inside a work tree; ignore stderr and pipe stdout
        const gitDir = execSync('git rev-parse --is-inside-work-tree', { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
        // Proceed only if the command returned true
        if (gitDir === 'true') {
            // Run status --porcelain to get a clean list of changes; check if output is not empty
            const status = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
            // Return true if changes found, false otherwise
            return status.length > 0;
        }
    } catch (e) {
    }
    // Default to false if error occurs or not in a git repo
    return false;
}

/** Determines if a specific line index resides within a multi-line string block to prevent insertion. */
function isLineInsideString(lines, targetLineIndex, ext = '') {
    // Determine language-specific syntax handling
    const isPython = ext.toLowerCase() === '.py';
    // Initialize state variables to track nesting levels of quotes and backticks
    let inBacktick = false;
    let inTripleDouble = false;
    let inTripleSingle = false;
    let inSingle = false;
    let inDouble = false;

    // Iterate through all lines preceding the target line to track state
    for (let i = 0; i < targetLineIndex; i++) {
        const line = lines[i];
        let j = 0;
        // Character-by-character scan of the line
        while (j < line.length) {
            // Python specific handling for triple quotes
            if (isPython) {
                if (!inTripleSingle) {
                    // Check for triple double-quotes start/end
                    if (line.slice(j, j + 3) === '"""') {
                        inTripleDouble = !inTripleDouble;
                        j += 3;
                        continue;
                    }
                }
                if (!inTripleDouble) {
                    // Check for triple single-quotes start/end
                    if (line.slice(j, j + 3) === "'''") {
                        inTripleSingle = !inTripleSingle;
                        j += 3;
                        continue;
                    }
                }
            // Standard languages handle backticks and single/double quotes
            } else {
                // Toggle backtick state if not inside other quotes
                if (!inSingle && !inDouble && line[j] === '`') {
                    // Check for escape character (backslash) before current quote to determine if it is literal
                    let escaped = false;
                    let k = j - 1;
                    // Backtrack to count consecutive backslashes
                    while (k >= 0 && line[k] === '\\') {
                        escaped = !escaped;
                        k--;
                    }
                    // If not escaped, toggle state
                    if (!escaped) {
                        inBacktick = !inBacktick;
                    }
                }
                // Check quotes only if not inside backticks
                if (!inBacktick) {
                    // Toggle double quote state
                    if (line[j] === '"' && !inSingle) {
                        let escaped = false;
                        let k = j - 1;
                        while (k >= 0 && line[k] === '\\') {
                            escaped = !escaped;
                            k--;
                        }
                        if (!escaped) {
                            inDouble = !inDouble;
                        }
                    // Toggle single quote state
                    } else if (line[j] === "'" && !inDouble) {
                        let escaped = false;
                        let k = j - 1;
                        while (k >= 0 && line[k] === '\\') {
                            escaped = !escaped;
                            k--;
                        }
                        if (!escaped) {
                            inSingle = !inSingle;
                        }
                    }
                }
            }
            j++;
        }
        // Reset quote state after each line for non-Python languages
        if (!isPython) {
            inSingle = false;
            inDouble = false;
        }
    }
    // Return true if any state variable is active
    return inBacktick || inTripleDouble || inTripleSingle || inSingle || inDouble;
}

/** Performs a static analysis of lines to detect comments and code-blocks. */
function analyzeComments(lines, ext = '') {
    // Configure flags based on file extension
    const isPython = ext.toLowerCase() === '.py';
    const isHTML = ['.html', '.vue', '.svelte'].includes(ext.toLowerCase());
    const analysis = [];
    let inBacktick = false;
    let inTripleDouble = false;
    let inTripleSingle = false;
    let inSingle = false;
    let inDouble = false;
    let inBlockJS = false;
    let inBlockHTML = false;
    // Process line by line
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let commentStartIndex = -1;
        let isInsideBlockStart = inBlockJS || inBlockHTML;
        let j = 0;
        // Character-by-character parsing
        while (j < line.length) {
            // Skip until end of block comment
            if (inBlockJS) {
                if (line.slice(j, j + 2) === '*/') {
                    inBlockJS = false;
                    j += 2;
                    continue;
                }
                j++;
                continue;
            }
            // Skip until end of HTML comment
            if (inBlockHTML) {
                if (line.slice(j, j + 3) === '-->') {
                    inBlockHTML = false;
                    j += 3;
                    continue;
                }
                j++;
                continue;
            }
            // Identify if we are at a position where a comment could start
            if (!inSingle && !inDouble && !inBacktick && !inTripleSingle && !inTripleDouble) {
                // Python: single line comment starts with #
                if (isPython) {
                    if (line[j] === '#') {
                        commentStartIndex = j;
                        break;
                    }
                // HTML/Vue: handle <!-- or //
                } else if (isHTML) {
                    if (line.slice(j, j + 4) === '<!--') {
                        commentStartIndex = j;
                        inBlockHTML = true;
                        j += 4;
                        continue;
                    }
                    if (line.slice(j, j + 2) === '//') {
                        commentStartIndex = j;
                        break;
                    }
                // Other languages: handle //, /*, or #
                } else {
                    if (line.slice(j, j + 2) === '//') {
                        commentStartIndex = j;
                        break;
                    }
                    if (line.slice(j, j + 2) === '/*') {
                        commentStartIndex = j;
                        inBlockJS = true;
                        j += 2;
                        continue;
                    }
                    if (line[j] === '#') {
                        commentStartIndex = j;
                        break;
                    }
                }
            }
            // Update string state machine to avoid comment markers inside strings
            if (isPython) {
                if (!inTripleSingle) {
                    if (line.slice(j, j + 3) === '"""') {
                        inTripleDouble = !inTripleDouble;
                        j += 3;
                        continue;
                    }
                }
                if (!inTripleDouble) {
                    if (line.slice(j, j + 3) === "'''") {
                        inTripleSingle = !inTripleSingle;
                        j += 3;
                        continue;
                    }
                }
            } else {
                if (!inSingle && !inDouble) {
                    if (line[j] === '`') {
                        let escaped = false;
                        let k = j - 1;
                        while (k >= 0 && line[k] === '\\') {
                            escaped = !escaped;
                            k--;
                        }
                        if (!escaped) {
                            inBacktick = !inBacktick;
                        }
                    }
                }
                if (!inBacktick) {
                    if (line[j] === '"' && !inSingle) {
                        let escaped = false;
                        let k = j - 1;
                        while (k >= 0 && line[k] === '\\') {
                            escaped = !escaped;
                            k--;
                        }
                        if (!escaped) {
                            inDouble = !inDouble;
                        }
                    }
                    else if (line[j] === "'" && !inDouble) {
                        let escaped = false;
                        let k = j - 1;
                        while (k >= 0 && line[k] === '\\') {
                            escaped = !escaped;
                            k--;
                        }
                        if (!escaped) {
                            inSingle = !inSingle;
                        }
                    }
                }
            }
            j++;
        }
        if (!isPython) {
            inSingle = false;
            inDouble = false;
        }
        // Determine if this entire line is marked as a comment or code-block
        const isEntirelyInsideBlock = isInsideBlockStart && (inBlockJS || inBlockHTML || (commentStartIndex === -1));
        let isPureComment = false;
        if (isEntirelyInsideBlock) {
            isPureComment = true;
        // If comment exists, check if text preceding it is empty
        } else if (commentStartIndex !== -1) {
            const beforeComment = line.slice(0, commentStartIndex).trim();
            if (beforeComment === '') {
                isPureComment = true;
            }
        } else if (line.trim() === '') {
            isPureComment = true;
        }
        analysis.push({
            isPureComment,
            commentStartIndex,
            isInsideBlock: isEntirelyInsideBlock || isInsideBlockStart
        });
    }
    return analysis;
}

/** Slices and modifies code by inserting or removing comments based on mode. */
function spliceComments(data, comments, mode = 'default', ext = '') {
    // Detect line ending style
    const hasCRLF = data.includes('\r\n');
    const lineEnding = hasCRLF ? '\r\n' : '\n';
    // Split data into array for line-by-line processing
    const originalLines = data.split(/\r?\n/);
    // Sort comments by line index descending for safe splicing
    const sortedComments = [...comments].sort((a, b) => b.line - a.line);
    const validComments = sortedComments.filter(c => c.line >= 1 && c.line <= originalLines.length + 1);

    const annotated = originalLines.map((text, index) => ({ text, originalIndex: index }));
    let analysis = null;

    // If cleaning, identify and remove lines that are pure comments
    if (mode === 'clean') {
        analysis = analyzeComments(originalLines, ext);
        const finalDeletions = new Set();
        for (let i = 0; i < originalLines.length; i++) {
            const lineNum = i + 1;
            if (analysis[i].isPureComment) {
                finalDeletions.add(lineNum);
            } else if (analysis[i].commentStartIndex !== -1) {
                annotated[i].text = originalLines[i].slice(0, analysis[i].commentStartIndex).trimEnd();
            }
        }

        // Apply user-defined deletions from analysis results
        for (const c of validComments) {
            const lineIdx = c.line - 1;
            if (lineIdx >= 0 && lineIdx < originalLines.length) {
                finalDeletions.add(c.line);
            }
        }

        const linesToDelete = Array.from(finalDeletions).sort((a, b) => b - a);

        // Process deletions in reverse
        for (const lineNum of linesToDelete) {
            const targetLine = originalLines[lineNum - 1];
            if (!targetLine) continue;
            const trimmedLine = targetLine.trim();

            const lineAnalysis = analysis[lineNum - 1];
            // Perform safety check to ensure we don't accidentally delete actual logic
            const isCommentLine = 
                lineAnalysis.isInsideBlock ||
                lineAnalysis.isPureComment ||
                trimmedLine.startsWith('//') || 
                trimmedLine.startsWith('/*') || 
                trimmedLine.startsWith('*') || 
                trimmedLine.startsWith('#') || 
                trimmedLine.startsWith('<!--') || 
                trimmedLine.startsWith('-->') || 
                trimmedLine.startsWith('--') ||
                trimmedLine.endsWith('*/') ||
                trimmedLine === '';

            if (!isCommentLine) {
                console.warn(`[devsplain] Safety Block: Refused to delete non-comment line ${lineNum}: "${trimmedLine}"`);
                continue;
            }

            annotated.splice(lineNum - 1, 1);
        }
    } else {
        // For default mode, insert new comments into code
        for (const c of validComments) {
            // Prevent inserting into strings
            if (isLineInsideString(originalLines, c.line - 1, ext)) {
                console.warn(`[devsplain] Skipping comment insertion at line ${c.line} to avoid string literal corruption.`);
                continue;
            }

            const targetLine = originalLines[c.line - 1] || '';
            // Capture existing indentation to maintain code style
            const indentMatch = targetLine.match(/^([ \t]*)/);
            const indentation = indentMatch ? indentMatch[1] : '';

            // Adjust comment block to match indentation
            const commentLines = c.comment.split(/\r?\n/).map(line => {
                const trimmed = line.trimStart();
                if (!trimmed) return '';
                if (trimmed.startsWith('*') && !trimmed.startsWith('*/') && !trimmed.startsWith('/*')) {
                    return indentation + ' ' + trimmed;
                }
                return indentation + trimmed;
            });

            const commentObjects = commentLines.map(line => ({ text: line, originalIndex: -1 }));
            annotated.splice(c.line - 1, 0, ...commentObjects);
        }
    }

    // Final verification to ensure logical consistency of the modified file
    const filtered = annotated.filter(line => line.originalIndex !== -1);
    const filteredText = filtered.map(line => line.text);
    const filteredIndices = filtered.map(line => line.originalIndex);

    const textEqual = filteredText.every((text, idx) => {
        const origIdx = filteredIndices[idx];
        const originalLine = originalLines[origIdx];
        if (text === originalLine) {
            return true;
        }
        if (mode === 'clean' && analysis) {
            const lineAnalysis = analysis[origIdx];
            if (lineAnalysis && lineAnalysis.commentStartIndex !== -1 && !lineAnalysis.isPureComment) {
                const expectedStripped = originalLine.slice(0, lineAnalysis.commentStartIndex).trimEnd();
                if (text === expectedStripped) {
                    return true;
                }
            }
        }
        return false;
    });

    let indicesSequential = true;
    for (let i = 1; i < filteredIndices.length; i++) {
        if (filteredIndices[i] <= filteredIndices[i - 1]) {
            indicesSequential = false;
            break;
        }
    }

    if (!textEqual || !indicesSequential) {
        console.error("\nSafety Assertion Failed: Spliced code does not match original code minus comments!");
        process.exit(1);
    }

    return annotated.map(line => line.text).join(lineEnding);
}

/** Main CLI entry point handling arguments, config, and file processing. */
async function runCLI() {
    // Initialize CLI reader interface
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

    // Get command-line arguments
    const args = process.argv.slice(2);

    // Print help text if flags provided
    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
devsplain - Universal Polyglot AI Code Commenter

Usage:
  devsplain <file-or-directory> [options]

Options:
  --light             Add ONLY JSDoc/block comments above functions (minimalist)
  --full              Add detailed JSDoc/block comments and inline comments
  --dry-run           Preview comments without writing to file
  --force             Bypass the dirty Git tree safety check
  --provider <name>   Override AI provider (gemini, groq, openai, custom)
  --model <name>      Override AI model name
  --api-key <key>     Override API key for the provider
  --base-url <url>    Override base URL for custom APIs
  --config            Force run the configuration setup wizard
  --setup-hook        Install Git pre-commit and post-commit hooks in repository
  --help, -h          Show this help message
  --version, -v       Show version information
`);
        rl.close();
        process.exit(0);
    }

    if (args.includes('--version') || args.includes('-v')) {
        const pkg = require('../package.json');
        console.log(`devsplain v${pkg.version}`);
        rl.close();
        process.exit(0);
    }

    if (args.includes('--config')) {
        rl.close();
        await getConfig(true);
        console.log("Success: Configuration updated successfully!");
        process.exit(0);
    }

    if (args.includes('--setup-hook')) {
        rl.close();
        require('./setup-hook.js');
        return;
    }

    // Helper to extract values from CLI flags
    const getArgValue = (flag) => {
        const index = args.indexOf(flag);
        if (index !== -1 && index + 1 < args.length) {
            return args[index + 1];
        }
        return null;
    };

    // Determine target filepath
    let filepath = '.';
    const flagKeys = ['--provider', '--model', '--api-key', '--base-url'];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            if (flagKeys.includes(arg)) {
                i++;
            }
        } else {
            filepath = arg;
            break;
        }
    }

    // Verify path existence
    if (!fs.existsSync(filepath)) {
        console.log(`Error: The path '${filepath}' does not exist.`);
        rl.close();
        process.exit(1);
    }

    let mode = 'default';
    if (args.includes('--light')) mode = 'light';
    if (args.includes('--full')) mode = 'full';
    if (args.includes('--clean')) mode = 'clean';
    const isDryRun = args.includes('--dry-run');
    const isForce = args.includes('--force');

    // Git dirty check enforcement
    if (process.env.NODE_ENV !== 'test' && isGitDirty() && !isForce) {
        console.error("Error: Git working tree is dirty. Please commit or stash your changes, or use --force to bypass this check.");
        rl.close();
        process.exit(1);
    }

    const config = await getConfig();

    const cliProvider = getArgValue('--provider');
    const cliModel = getArgValue('--model');
    const cliApiKey = getArgValue('--api-key');
    const cliBaseUrl = getArgValue('--base-url');

    // Override configuration from CLI flags if provided
    if (cliProvider) {
        config.provider = cliProvider;
        if (!cliModel) {
            config.model = cliProvider === 'gemini' ? 'gemini-2.0-flash' : 'llama-3.3-70b-versatile';
        }
        if (!cliBaseUrl) {
            config.baseUrl = cliProvider === 'gemini' ? null : (cliProvider === 'groq' ? 'https://api.groq.com/openai' : (cliProvider === 'openai' ? 'https://api.openai.com' : ''));
        }
    }
    if (cliModel) config.model = cliModel;
    if (cliApiKey) config.apiKey = cliApiKey;
    if (cliBaseUrl) config.baseUrl = cliBaseUrl;

    let successCount = 0;
    let failCount = 0;

    // Recursive function to walk directories and process files
    async function processPath(targetPath) {
        const stats = fs.statSync(targetPath);

        // Handle directory traversal
        if (stats.isDirectory()) {
            const folderName = path.basename(targetPath);
            const ignoredFolders = [
                'node_modules', '.git', 'dist', 'build', 'out', 
                '.next', '.nuxt', '.svelte-kit', 
                'venv', 'env', '.venv',          
                '.vscode', '.idea', 'coverage'   
            ];

            if (ignoredFolders.includes(folderName)) {
                return;
            }

            console.log(`\n Scanning directory: ${targetPath}`);
            const items = fs.readdirSync(targetPath);
            for (const item of items) {
                const fullPath = path.join(targetPath, item);
                await processPath(fullPath); 
            }
        } 
        // Handle single file processing
        else if (stats.isFile()) {
            const ext = path.extname(targetPath).toLowerCase();
            const validExtensions = [
                '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.scss', '.vue', '.svelte',
                '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rb', '.php', '.rs', 
                '.swift', '.kt', '.dart', '.sh'
            ];

            if (!validExtensions.includes(ext)) {
                return;
            }

            const filename = path.basename(targetPath);
            // Read file content and check if empty
            const data = fs.readFileSync(targetPath, 'utf-8');
            if (data.trim() === '') {
                console.log(` Skipping ${filename} (Empty File)`);
                return;
            }

            console.log(` Analyzing ${filename} in ${mode} mode...`);
            try {
                let comments = [];
                let commentedCode;
                // Execute commentary logic based on mode
                if (mode !== 'clean') {
                    const cleanData = spliceComments(data, [], 'clean', ext);
                    comments = await getComments(cleanData, filename, config, mode);
                    commentedCode = spliceComments(cleanData, comments, mode, ext);
                } else {
                    commentedCode = spliceComments(data, [], 'clean', ext);
                }
                // Handle dry run preview output
                if (isDryRun) {
                    console.log(`\n --- DRY RUN PREVIEW: ${filename} ---`);
                    console.log(commentedCode);
                    console.log(`---------------------------------------\n`);
                    const answer = await askQuestion("Type 'write' to save to file, or press any key to discard: ");
                    if (answer.toLowerCase() === 'write') {
                        const tempPath = targetPath + '.tmp';
                        fs.writeFileSync(tempPath, commentedCode, 'utf8');
                        fs.renameSync(tempPath, targetPath);
                        console.log(` Successfully saved ${targetPath}`);
                    } else {
                        console.log(` Skipped ${targetPath}`);
                    }
                // Write changes to temporary file then replace to prevent partial write errors
                } else {
                    const tempPath = targetPath + '.tmp';
                    fs.writeFileSync(tempPath, commentedCode, 'utf8');
                    fs.renameSync(tempPath, targetPath);
                    console.log(` Successfully commented ${targetPath}`);
                }
                successCount++;
            } catch (err) {
                console.error(` Error processing ${filename}: ${err.message}`);
                failCount++;
            }
        }
    }

    await processPath(filepath);

    if (failCount > 0 && successCount === 0) {
        console.error("\nFailed: No files were successfully commented.");
        rl.close();
        process.exit(1);
    }

    if (successCount > 0 && failCount > 0) {
        console.log(`\n All done! (Successfully commented: ${successCount}, Failed: ${failCount})`);
    } else {
        console.log("\n All done!");
    }
    rl.close();
}

// Start execution if run directly
if (require.main === module) {
    runCLI().catch(err => {
        console.error(err);
        process.exit(1);
    });
} else {
    module.exports = { spliceComments, isLineInsideString };
}