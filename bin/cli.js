#!/usr/bin/env node

const { getComments } = require('../lib/llm.js');
const { getConfig } = require('../lib/config.js');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

let rl;
let askQuestion;

/** Checks if the current Git repository has uncommitted changes [ds] */
function isGitDirty() {
    try {
        const gitDir = execSync('git rev-parse --is-inside-work-tree', { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
        if (gitDir === 'true') {
            const status = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
            return status.length > 0;
        }
    } catch (e) {
    }
    return false;
}

/** Checks if a given line index is inside a string in a list of code lines [ds] */
function isLineInsideString(lines, targetLineIndex, ext = '') {
    const isPython = ext.toLowerCase() === '.py';
    let inBacktick = false;
    let inTripleDouble = false;
    let inTripleSingle = false;
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < targetLineIndex; i++) {
        const line = lines[i];
        let j = 0;
        while (j < line.length) {
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
                if (!inSingle && !inDouble && line[j] === '`') {
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
        if (!isPython) {
            inSingle = false;
            inDouble = false;
        }
    }
    return inBacktick || inTripleDouble || inTripleSingle || inSingle || inDouble;
}

/** Analyzes comments in a list of code lines [ds] */
function analyzeComments(lines, ext = '') {
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
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let commentStartIndex = -1;
        let isInsideBlockStart = inBlockJS || inBlockHTML;
        let j = 0;
        while (j < line.length) {
            if (inBlockJS) {
                if (line.slice(j, j + 2) === '*/') {
                    inBlockJS = false;
                    j += 2;
                    continue;
                }
                j++;
                continue;
            }
            if (inBlockHTML) {
                if (line.slice(j, j + 3) === '-->') {
                    inBlockHTML = false;
                    j += 3;
                    continue;
                }
                j++;
                continue;
            }
            // Check for comment start index in non-Python files [ds]
            if (!inSingle && !inDouble && !inBacktick && !inTripleSingle && !inTripleDouble) {
                if (isPython) {
                    if (line[j] === '#') {
                        commentStartIndex = j;
                        break;
                    }
                    if (line.slice(j, j + 2) === '/*') {
                        commentStartIndex = j;
                        inBlockJS = true;
                        j += 2;
                        continue;
                    }
                    if (line.slice(j, j + 2) === '//') {
                        commentStartIndex = j;
                        break;
                    }
                } else if (isHTML) {
                    if (line.slice(j, j + 4) === '<!--') {
                        commentStartIndex = j;
                        inBlockHTML = true;
                        j += 4;
                        continue;
                    }
                    if (line.slice(j, j + 2) === '/*') {
                        commentStartIndex = j;
                        inBlockJS = true;
                        j += 2;
                        continue;
                    }
                    if (line.slice(j, j + 2) === '//') {
                        commentStartIndex = j;
                        break;
                    }
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
            // Check for string literals in non-Python files [ds]
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
            // Increment character index [ds]
            j++;
        }
        if (!isPython) {
            inSingle = false;
            inDouble = false;
        }
        const isEntirelyInsideBlock = isInsideBlockStart && (inBlockJS || inBlockHTML || (commentStartIndex === -1));
        let isPureComment = false;
        if (isEntirelyInsideBlock) {
            isPureComment = true;
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

/** Splices comments into a list of code lines [ds] */
function spliceComments(data, comments, mode = 'default', ext = '') {
    const hasCRLF = data.includes('\r\n');
    const lineEnding = hasCRLF ? '\r\n' : '\n';
    const originalLines = data.split(/\r?\n/);
    const sortedComments = [...comments].sort((a, b) => b.line - a.line);
    const validComments = sortedComments.filter(c => c.line >= 1 && c.line <= originalLines.length + 1);

    const annotated = originalLines.map((text, index) => ({ text, originalIndex: index }));
    let analysis = null;
    let dsBlocks = new Set();

    if (mode === 'clean' || mode === 'prune') {
        analysis = analyzeComments(originalLines, ext);
        const finalDeletions = new Set();
        if (mode === 'clean') {
            let i = 0;
            while (i < originalLines.length) {
                if (analysis[i].isInsideBlock) {
                    let start = i;
                    let end = i;
                    while (end < originalLines.length && analysis[end].isInsideBlock) end++;
                    let blockStart = start - 1;
                    let blockEnd = end - 1;
                    let hasDs = false;
                    for (let k = blockStart; k <= blockEnd; k++) {
                        if (originalLines[k].includes('[ds]')) hasDs = true;
                    }
                    if (hasDs) {
                        for (let k = blockStart; k <= blockEnd; k++) {
                            dsBlocks.add(k + 1);
                        }
                    }
                    i = end;
                } else {
                    i++;
                }
            }
        }

        for (let i = 0; i < originalLines.length; i++) {
            const lineNum = i + 1;
            const lineStr = originalLines[i];
            const lineAnalysis = analysis[i];

            if (lineStr.trim().startsWith('#!')) {
                continue;
            }

            if (mode === 'prune') {
                if (lineAnalysis.isPureComment) {
                    finalDeletions.add(lineNum);
                } else if (lineAnalysis.commentStartIndex !== -1) {
                    annotated[i].text = lineStr.slice(0, lineAnalysis.commentStartIndex).trimEnd();
                }
            } else if (mode === 'clean') {
                const isDsBlockLine = dsBlocks.has(lineNum);
                const hasDsInline = lineStr.includes('[ds]');

                if (lineAnalysis.isPureComment) {
                    if (isDsBlockLine || hasDsInline) {
                        finalDeletions.add(lineNum);
                    }
                } else if (lineAnalysis.commentStartIndex !== -1) {
                    if (isDsBlockLine || hasDsInline) {
                        annotated[i].text = lineStr.slice(0, lineAnalysis.commentStartIndex).trimEnd();
                    }
                }
            }
        }


        for (const c of validComments) {
            const lineIdx = c.line - 1;
            if (lineIdx >= 0 && lineIdx < originalLines.length) {
                finalDeletions.add(c.line);
            }
        }

        const linesToDelete = Array.from(finalDeletions).sort((a, b) => b - a);

        for (const lineNum of linesToDelete) {
            const targetLine = originalLines[lineNum - 1];
            if (!targetLine) continue;
            const trimmedLine = targetLine.trim();

            const lineAnalysis = analysis[lineNum - 1];
            if (trimmedLine.startsWith('#!')) {
                continue;
            }

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
        for (const c of validComments) {
            if (isLineInsideString(originalLines, c.line - 1, ext)) {
                console.warn(`[devsplain] Skipping comment insertion at line ${c.line} to avoid string literal corruption.`);
                continue;
            }

            const targetLine = originalLines[c.line - 1] || '';
            const indentMatch = targetLine.match(/^([ \t]*)/);
            const indentation = indentMatch ? indentMatch[1] : '';

            const commentLines = c.comment.split(/\r?\n/).map((line, idx) => {
                let trimmed = line.trimStart();
                if (!trimmed) return '';

                const isSingleLine = trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('--');
                const isBlockEnd = trimmed.endsWith('*/') || trimmed.endsWith('-->');

                if (isSingleLine) {
                    trimmed = trimmed + ' [ds]';
                } else if (idx === 0) {
                    if (isBlockEnd) {
                        trimmed = trimmed.replace(/(\*\/|-->)$/, '[ds] $1');
                    } else {
                        trimmed = trimmed + ' [ds]';
                    }
                }

                if (trimmed.startsWith('*') && !trimmed.startsWith('*/') && !trimmed.startsWith('/*')) {
                    return indentation + ' ' + trimmed;
                }
                return indentation + trimmed;
            });

            const commentObjects = commentLines.map(line => ({ text: line, originalIndex: -1 }));
            annotated.splice(c.line - 1, 0, ...commentObjects);
        }
    }

    const filtered = annotated.filter(line => line.originalIndex !== -1);
    const filteredText = filtered.map(line => line.text);
    const filteredIndices = filtered.map(line => line.originalIndex);

    const textEqual = filteredText.every((text, idx) => {
        const origIdx = filteredIndices[idx];
        const originalLine = originalLines[origIdx];
        if (text === originalLine) {
            return true;
        }
        if ((mode === 'clean' || mode === 'prune') && analysis) {
            const lineAnalysis = analysis[origIdx];
            if (lineAnalysis && lineAnalysis.commentStartIndex !== -1 && !lineAnalysis.isPureComment) {
                const isDsBlockLine = dsBlocks.has(origIdx + 1);
                const hasDsInline = originalLine.includes('[ds]');
                if (mode === 'prune' || (mode === 'clean' && (hasDsInline || isDsBlockLine))) {
                    const expectedStripped = originalLine.slice(0, lineAnalysis.commentStartIndex).trimEnd();
                    if (text === expectedStripped) {
                        return true;
                    }
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

/** Runs the CLI interface for the commenting tool [ds] */
async function runCLI() {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

    const args = process.argv.slice(2);

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
  --clean             Scrub only devsplain-generated [ds] comments
  --prune             Destructively scrub ALL comments from files
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
        const installHooks = require('./setup-hook.js');
        await installHooks();
        return;
    }

    const getArgValue = (flag) => {
        const index = args.indexOf(flag);
        if (index !== -1 && index + 1 < args.length) {
            return args[index + 1];
        }
        return null;
    };

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

    if (!fs.existsSync(filepath)) {
        console.log(`Error: The path '${filepath}' does not exist.`);
        rl.close();
        process.exit(1);
    }

    let mode = 'default';
    if (args.includes('--light')) mode = 'light';
    if (args.includes('--full')) mode = 'full';
    if (args.includes('--clean')) mode = 'clean';
    if (args.includes('--prune')) mode = 'prune';
    const isDryRun = args.includes('--dry-run');
    const isForce = args.includes('--force');

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

    async function processPath(targetPath) {
        // Process a directory or file path [ds]
        const stats = fs.statSync(targetPath);

        if (stats.isDirectory()) {
            const folderName = path.basename(targetPath);
            const ignoredFolders = [
                'node_modules', '.git', 'dist', 'build', 'out', 
                '.next', '.nuxt', '.svelte-kit', 
                'venv', 'env', '.venv',          
                '.vscode', '.idea', 'coverage',
                'tests', '__tests__', 'fixtures'
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
            const data = fs.readFileSync(targetPath, 'utf-8');
            if (data.trim() === '') {
                console.log(` Skipping ${filename} (Empty File)`);
                return;
            }

            console.log(` Analyzing ${filename} in ${mode} mode...`);
            try {
                let comments = [];
                let commentedCode;
                if (mode !== 'clean' && mode !== 'prune') {
                    const cleanData = spliceComments(data, [], 'clean', ext);
                    comments = await getComments(cleanData, filename, config, mode);
                    commentedCode = spliceComments(cleanData, comments, mode, ext);
                } else {
                    commentedCode = spliceComments(data, [], mode, ext);
                }
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

// Run the CLI interface if this script is the main module [ds]
if (require.main === module) {
    runCLI().catch(err => {
        console.error(err);
        process.exit(1);
    });
} else {
    module.exports = { spliceComments, isLineInsideString };
}