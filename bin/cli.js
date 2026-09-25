#!/usr/bin/env node

const { getComments, runWithConcurrency, resetConcurrency } = require('../lib/llm.js');
const { getConfig } = require('../lib/config.js');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

let rl;
let askQuestion;

/** [ds]
 * Derives a short project identifier by reading package.json (name/version/description)
 * or falling back to the first README.md heading. Used to give the LLM context about
 * the codebase. Silently returns '' on any error since this is best-effort metadata.
*/
function getProjectFingerprint(targetPath) {
    try {
        // Resolve the project root: if a file path was given, walk up to its containing directory [ds]
        const root = fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
        const pkgPath = path.join(root, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const name = pkg.name || '';
            const version = pkg.version ? `v${pkg.version}` : '';
            const desc = (pkg.description || '').slice(0, 120);
            return `// project: ${[name, version, desc].filter(Boolean).join(' — ')}`.slice(0, 150);
        }
        const readmePath = path.join(root, 'README.md');
        if (fs.existsSync(readmePath)) {
            const firstHeading = fs.readFileSync(readmePath, 'utf8')
                .split('\n')
                .find(l => l.trim().startsWith('#'));
            if (firstHeading) {
                return `// project: ${firstHeading.replace(/^#+\s*/, '').trim()}`.slice(0, 150);
            }
        }
    } catch (_) {}
    return '';
}

/** [ds]
 * Returns true only when inside a git repo AND the working tree has uncommitted changes.
 * Pipes stderr to ignore so non-git directories fail quietly.
*/
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

/** [ds]
 * Heuristic scanner that determines whether a given line index sits inside a string,
 * comment, regex literal, or raw string. Runs a lightweight character-by-character
 * state machine over preceding lines using per-extension syntax rules, since different
 * languages (Python, HTML, C++, JS, Rust/Swift, shell/Ruby, PHP) have distinct literal
 * and comment delimiters. Used to avoid placing comments inside non-code regions.
*/
function isLineInsideString(lines, targetLineIndex, ext = '') {
    // Per-language feature flags resolved once from the file extension [ds]
    const isPython = ext.toLowerCase() === '.py';
    const isHTML = ['.html', '.vue', '.svelte'].includes(ext.toLowerCase());
    const isRustOrSwift = ['.rs', '.swift'].includes(ext.toLowerCase());
    const isCpp = ['.cpp', '.cc', '.cxx', '.c', '.h', '.hpp'].includes(ext.toLowerCase());
    const isJS = ['.js', '.jsx', '.ts', '.tsx'].includes(ext.toLowerCase());
    let inBacktick = false;
    let inTripleDouble = false;
    let inTripleSingle = false;
    let inSingle = false;
    let inDouble = false;
    let inBlockJS = false;
    let inBlockHTML = false;
    let blockDepthJS = 0;
    let inCppRawString = false;
    let cppRawDelimiter = '';
    let inRegex = false;
    for (let i = 0; i < targetLineIndex; i++) {
        const line = lines[i];
        let j = 0;
        while (j < line.length) {
            // Rust/Swift allow nested block comments, so track depth instead of a boolean [ds]
            if (inBlockJS) {
                if (line.slice(j, j + 2) === '/*') {
                    if (isRustOrSwift) blockDepthJS++;
                    j += 2;
                    continue;
                }
                if (line.slice(j, j + 2) === '*/') {
                    // Only Rust/Swift nest; other languages close on the first */ [ds]
                    if (isRustOrSwift && blockDepthJS > 1) {
                        blockDepthJS--;
                    } else {
                        inBlockJS = false;
                        blockDepthJS = 0;
                    }
                    j += 2;
                    continue;
                }
                j++;
                continue;
            }
            // C++ raw strings: R"delim(...)delim" — must match the exact closing delimiter [ds]
            if (inCppRawString) {
                if (line.slice(j, j + 2 + cppRawDelimiter.length) === ')' + cppRawDelimiter + '"') {
                    inCppRawString = false;
                    j += 2 + cppRawDelimiter.length;
                    continue;
                }
                j++;
                continue;
            }
            // Regex literals: a '/' is only a terminator when not preceded by an odd number of backslashes [ds]
            if (inRegex) {
                let escaped = false;
                let k = j - 1;
                while (k >= 0 && line[k] === '\\') {
                    escaped = !escaped;
                    k--;
                }
                if (line[j] === '/' && !escaped) {
                    inRegex = false;
                }
                j++;
                continue;
            }
            // HTML/XML block comments terminate with --> [ds]
            if (inBlockHTML) {
                if (line.slice(j, j + 3) === '-->') {
                    inBlockHTML = false;
                    j += 3;
                    continue;
                }
                j++;
                continue;
            }
            // Check if comment starts (skip processing quotes if we are entering a comment)
            // Only treat comment openers as real when outside of any string literal [ds]
            if (!inSingle && !inDouble && !inBacktick && !inTripleSingle && !inTripleDouble) {
                if (isPython) {
                    if (line[j] === '#') {
                        break; // Ignore rest of line
                    }
                } else if (isHTML) {
                    if (line.slice(j, j + 4) === '<!--') {
                        inBlockHTML = true;
                        j += 4;
                        continue;
                    }
                    if (line.slice(j, j + 2) === '/*') {
                        inBlockJS = true;
                        j += 2;
                        continue;
                    }
                    if (line.slice(j, j + 2) === '//') {
                        break; // Ignore rest of line
                    }
                } else {
                    // Shell and Ruby use '#' for line comments like Python [ds]
                    const isShellOrRuby = ['.sh', '.rb'].includes(ext.toLowerCase());
                    if (isShellOrRuby) {
                        if (line[j] === '#') {
                            break; // Ignore rest of line
                        }
                    } else {
                        if (line.slice(j, j + 2) === '//') {
                            break; // Ignore rest of line
                        }
                        if (line.slice(j, j + 2) === '/*') {
                            inBlockJS = true;
                            blockDepthJS = 1;
                            j += 2;
                            continue;
                        }
                        if (ext.toLowerCase() === '.php' && line[j] === '#') {
                            break; // Ignore rest of line
                        }
                        // C++11 raw string syntax: R"<delim>( ... )<delim>" (delimiter up to 16 chars, no parens/backslash/space) [ds]
                        if (isCpp && line[j] === 'R' && line[j+1] === '"') {
                            const match = line.slice(j).match(/^R"([^()\\\s]{0,16})\(/);
                            if (match) {
                                cppRawDelimiter = match[1];
                                inCppRawString = true;
                                j += match[0].length;
                                continue;
                            }
                        }
                        // Distinguishing regex from division in JS requires looking back at the previous non-whitespace token [ds]
                        if (isJS && line[j] === '/') {
                            let k = j - 1;
                            while (k >= 0 && /\s/.test(line[k])) k--;
                            let isRegex = false;
                            if (k < 0) {
                                isRegex = true;
                            } else {
                                const prevChar = line[k];
                                // If preceded by an operator/punctuation, '/' starts a regex rather than division [ds]
                                if (/[=({\[:,;!+*&|?<>-]/.test(prevChar)) {
                                    isRegex = true;
                                } else {
                                    const prefix = line.slice(0, k + 1);
                                    // Keywords like return/typeof/yield/await/throw are followed by expressions, so '/' begins a regex [ds]
                                    if (/(?:return|typeof|yield|await|throw)\s*$/.test(prefix)) {
                                        isRegex = true;
                                    }
                                }
                            }
                            if (isRegex) {
                                inRegex = true;
                                j++;
                                continue;
                            }
                        }
                    }
                }
            }
            // Python triple-quoted strings toggle on (''' or """) and can span many lines [ds]
            if (isPython) {
                if (!inTripleSingle && !inSingle && !inDouble) {
                    if (line.slice(j, j + 3) === '"""') {
                        inTripleDouble = !inTripleDouble;
                        j += 3;
                        continue;
                    }
                }
                if (!inTripleDouble && !inSingle && !inDouble) {
                    if (line.slice(j, j + 3) === "'''") {
                        inTripleSingle = !inTripleSingle;
                        j += 3;
                        continue;
                    }
                }
            }
            // Triple-quoted strings span multiple lines so single/double/backtick toggling must be suppressed while inside them, otherwise quote characters within a docstring would corrupt parser state. [ds]
            if (!inTripleSingle && !inTripleDouble) {
                if (!isPython) {
                    if (!inSingle && !inDouble) {
                        // JS/TS template literals: detect backtick only when not already inside quotes; escaping is determined by counting consecutive backslashes (odd count = escaped) rather than a boolean flag, since '\\\\`' is unescaped but '\\`' is escaped. [ds]
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
                }
                // Quote characters inside a template literal are literal text, so skip quote toggling when inside backticks. [ds]
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
        // Languages whose string literals cannot span lines: reset quote state at each newline so an unterminated string doesn't cascade false positives across the rest of the file. [ds]
        const resetsAtLineEnd = ['.js', '.jsx', '.ts', '.tsx', '.java', '.c', '.cpp', '.cs', '.go', '.swift', '.kt', '.dart'].includes(ext.toLowerCase());
        if (resetsAtLineEnd) {
            inSingle = false;
            inDouble = false;
            inRegex = false;
        }
    }
    return inBacktick || inTripleDouble || inTripleSingle || inSingle || inDouble || inCppRawString || inRegex;
}

/** [ds]
 * Scans source lines and reports which lines contain or are inside comments, handling language-specific string and comment syntax.
 * Tracks multi-line state (block comments, Python triple-quotes, C++ raw strings, regex literals, nested Rust/Swift /* */ blocks, HTML comments) so comment markers inside strings are not misdetected.
 * @param {string[]} lines - Source file contents split by line.
 * @param {string} ext - File extension used to select language-specific rules.
 * @returns {Array} Per-line comment analysis results.
*/
function analyzeComments(lines, ext = '') {
    const isPython = ext.toLowerCase() === '.py';
    const isHTML = ['.html', '.vue', '.svelte'].includes(ext.toLowerCase());
    const isRustOrSwift = ['.rs', '.swift'].includes(ext.toLowerCase());
    const isCpp = ['.cpp', '.cc', '.cxx', '.c', '.h', '.hpp'].includes(ext.toLowerCase());
    const isJS = ['.js', '.jsx', '.ts', '.tsx'].includes(ext.toLowerCase());
    const analysis = [];
    let inBacktick = false;
    let inTripleDouble = false;
    let inTripleSingle = false;
    let inSingle = false;
    let inDouble = false;
    let inBlockJS = false;
    let inBlockHTML = false;
    let blockDepthJS = 0;
    let inCppRawString = false;
    let cppRawDelimiter = '';
    let inRegex = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let commentStartIndex = -1;
        let isInsideBlockStart = inBlockJS || inBlockHTML;
        let j = 0;
        while (j < line.length) {
            if (inBlockJS) {
                // Ensure Rust/Swift nested block comments keep depth so inner '/*' does not prematurely end the outer comment when a single '*/' appears. [ds]
                if (line.slice(j, j + 2) === '/*') {
                    if (isRustOrSwift) blockDepthJS++;
                    j += 2;
                    continue;
                }
                if (line.slice(j, j + 2) === '*/') {
                    if (isRustOrSwift && blockDepthJS > 1) {
                        blockDepthJS--;
                    } else {
                        inBlockJS = false;
                        blockDepthJS = 0;
                    }
                    j += 2;
                    continue;
                }
                j++;
                continue;
            }
            if (inCppRawString) {
                // C++ raw string terminator is ')' + delimiter + '"'; matching must include the delimiter to avoid false termination on incidental ')' characters. [ds]
                if (line.slice(j, j + 2 + cppRawDelimiter.length) === ')' + cppRawDelimiter + '"') {
                    inCppRawString = false;
                    j += 2 + cppRawDelimiter.length;
                    continue;
                }
                j++;
                continue;
            }
            if (inRegex) {
                // Regex literal termination: '/' must be unescaped. Escape detection uses backslash parity rather than a flag so pairs like '\\\\' count as escaped-backslash + bare slash. [ds]
                let escaped = false;
                let k = j - 1;
                while (k >= 0 && line[k] === '\\') {
                    escaped = !escaped;
                    k--;
                }
                if (line[j] === '/' && !escaped) {
                    inRegex = false;
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
            if (!inSingle && !inDouble && !inBacktick && !inTripleSingle && !inTripleDouble) {
                if (isPython) {
                    if (line[j] === '#') {
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
                    // .vue and .svelte files can embed JS, so recognize /* */ inside HTML-typed files as JS block comments. [ds]
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
                    // Shell and Ruby use '#' for comments rather than '//', falling back to the non-HTML branch below. [ds]
                    const isShellOrRuby = ['.sh', '.rb'].includes(ext.toLowerCase());
                    // Shell and Ruby use hash comments, while C-style languages need additional checks for regex, PHP, C++ raw strings, and JS regex literals [ds]
                    if (isShellOrRuby) {
                        if (line[j] === '#') {
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
                            blockDepthJS = 1;
                            j += 2;
                            continue;
                        }
                        // PHP additionally supports '#' line comments alongside '//' and '/* */'. [ds]
                        if (ext.toLowerCase() === '.php' && line[j] === '#') {
                            commentStartIndex = j;
                            break;
                        }
                        // C++ raw string literals use the syntax R"delimiter(...)delimiter" where the delimiter is optionally up to 16 chars without parens/backslashes/whitespace [ds]
                        if (isCpp && line[j] === 'R' && line[j+1] === '"') {
                            const match = line.slice(j).match(/^R"([^()\\\s]{0,16})\(/);
                            if (match) {
                                cppRawDelimiter = match[1];
                                inCppRawString = true;
                                j += match[0].length;
                                continue;
                            }
                        }
                        // Distinguishing a division operator from a regex literal requires checking the previous non-whitespace token: after operators/keywords like 'return' or '=' a '/' starts a regex; after identifiers/numbers/literals it's division [ds]
                        if (isJS && line[j] === '/') {
                            let k = j - 1;
                            while (k >= 0 && /\s/.test(line[k])) k--;
                            let isRegex = false;
                            if (k < 0) {
                                isRegex = true;
                            } else {
                                const prevChar = line[k];
                                if (/[=({\[:,;!+*&|?<>-]/.test(prevChar)) {
                                    isRegex = true;
                                } else {
                                    const prefix = line.slice(0, k + 1);
                                    if (/(?:return|typeof|yield|await|throw)\s*$/.test(prefix)) {
                                        isRegex = true;
                                    }
                                }
                            }
                            if (isRegex) {
                                inRegex = true;
                                j++;
                                continue;
                            }
                        }
                    }
                }
            }
            if (isPython) {
                if (!inTripleSingle && !inSingle && !inDouble) {
                    // Triple-quoted strings (docstrings) toggle on and off, but must not be entered/exited while already inside a single/double-quoted string of the other kind [ds]
                    if (line.slice(j, j + 3) === '"""') {
                        inTripleDouble = !inTripleDouble;
                        j += 3;
                        continue;
                    }
                }
                if (!inTripleDouble && !inSingle && !inDouble) {
                    if (line.slice(j, j + 3) === "'''") {
                        inTripleSingle = !inTripleSingle;
                        j += 3;
                        continue;
                    }
                }
            }
            if (!inTripleSingle && !inTripleDouble) {
                if (!isPython) {
                    if (!inSingle && !inDouble) {
                        // Backtick (template literal) handling: count preceding backslashes to detect escaping; an even count means the backtick is unescaped and toggles the state [ds]
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
                }
                if (!inBacktick) {
                    // Same escaped-backslash parity check applies to quote toggling so that \" or \' do not terminate a string [ds]
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
        // Languages without multi-line string literals (except triple-quoted Python) reset quote/regex state at each newline, since a real newline inside a string is a syntax error or implicitly closes the string [ds]
        const resetsAtLineEnd = ['.js', '.jsx', '.ts', '.tsx', '.java', '.c', '.cpp', '.cs', '.go', '.swift', '.kt', '.dart'].includes(ext.toLowerCase());
        if (resetsAtLineEnd) {
            inSingle = false;
            inDouble = false;
            inRegex = false;
        }
        // A line is fully inside a block comment if it started inside one and did not encounter the closing marker before end-of-line [ds]
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

/** [ds]
 * Splices comment lines into or removes comment lines from source data according to mode.
 * Modes: 'default' inserts comments above their target lines; 'prune' removes comments that occupy their own line;
 * 'clean' removes all comments except those belonging to blocks containing a [ds] tag.
 * Preserves original line endings (CRLF vs LF) and adjusts insertion for 1-indexed comment line numbers.
*/
function spliceComments(data, comments, mode = 'default', ext = '') {
    // Detect and preserve original line-ending style to avoid rewriting the whole file's terminators [ds]
    const hasCRLF = data.includes('\r\n');
    const lineEnding = hasCRLF ? '\r\n' : '\n';
    const originalLines = data.split(/\r?\n/);
    // Process from bottom to top so that line number references remain stable as we mutate the array [ds]
    const sortedComments = [...comments].sort((a, b) => b.line - a.line);
    // Allow line === originalLines.length + 1 to support appending at the very end of the file [ds]
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
                // Identify contiguous runs of lines that are entirely inside block comments so we can decide whether to preserve the whole block [ds]
                if (analysis[i].isInsideBlock) {
                    let start = i;
                    let end = i;
                    while (end < originalLines.length && analysis[end].isInsideBlock) end++;
                    let blockStart = Math.max(0, start - 1);
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
/** [ds]
 * Main processing loop that handles comment removal (prune/clean modes) or insertion.
 * Uses a two-pass strategy: first pass removes/augments lines in the `annotated` array,
 * then final deletions are applied in descending order to avoid index shifting during splice.
 * A safety block prevents deletion of non-comment lines as a defensive guard.
*/

        for (let i = 0; i < originalLines.length; i++) {
            const lineNum = i + 1;
            const lineStr = originalLines[i];
            const lineAnalysis = analysis[i];

            // Preserve shebang lines: they are technically comments but are semantically required to be the first line [ds]
            if (lineStr.trim().startsWith('#!')) {
                continue;
            }

            if (mode === 'prune') {
                if (lineAnalysis.isPureComment) {
                    finalDeletions.add(lineNum);
                // For inline/trailing comments, strip only the comment portion from the line body [ds]
                } else if (lineAnalysis.commentStartIndex !== -1) {
                    const idx = lineAnalysis.commentStartIndex;
                    const remainder = lineStr.slice(idx);
                    let newText = lineStr.slice(0, idx).trimEnd();
                    
                    // For inline block comments, strip from the /* to the */ if both occur on the same line; otherwise leave the remainder intact for subsequent-splice handling [ds]
                    if (remainder.startsWith('/*')) {
                        const endIdx = remainder.indexOf('*/');
                        if (endIdx !== -1) {
                            newText = lineStr.slice(0, idx) + remainder.slice(endIdx + 2);
                        }
                    } else if (remainder.startsWith('<!--')) {
                        const endIdx = remainder.indexOf('-->');
                        if (endIdx !== -1) {
                            newText = lineStr.slice(0, idx) + remainder.slice(endIdx + 3);
                        }
                    }
                    
                    annotated[i].text = newText.trimEnd();
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
                        const idx = lineAnalysis.commentStartIndex;
                        const remainder = lineStr.slice(idx);
                        let newText = lineStr.slice(0, idx).trimEnd();
                        
                        if (remainder.startsWith('/*')) {
                            const endIdx = remainder.indexOf('*/');
                            if (endIdx !== -1) {
                                newText = lineStr.slice(0, idx) + remainder.slice(endIdx + 2);
                            }
                        } else if (remainder.startsWith('<!--')) {
                            const endIdx = remainder.indexOf('-->');
                            if (endIdx !== -1) {
                                newText = lineStr.slice(0, idx) + remainder.slice(endIdx + 3);
                            }
                        }
                        
                        annotated[i].text = newText.trimEnd();
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

        // Sort descending so splices don't invalidate indices of subsequent deletions [ds]
        const linesToDelete = Array.from(finalDeletions).sort((a, b) => b - a);

        for (const lineNum of linesToDelete) {
            const targetLine = originalLines[lineNum - 1];
            if (!targetLine) continue;
            const trimmedLine = targetLine.trim();

            const lineAnalysis = analysis[lineNum - 1];
            // Never delete shebang lines even if flagged, since removing them breaks script execution [ds]
            if (trimmedLine.startsWith('#!')) {
                continue;
            }

            // Defense-in-depth: verify flagged line is actually a comment before mutating the output [ds]
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

            // Abort deletion if line contains code, preserving source integrity over aggressive pruning [ds]
            if (!isCommentLine) {
                console.warn(`[devsplain] Safety Block: Refused to delete non-comment line ${lineNum}: "${trimmedLine}"`);
                continue;
            }

            annotated.splice(lineNum - 1, 1);
        }
    } else {
        for (const c of validComments) {
            // Guard against inserting comments inside string literals (e.g., multiline strings containing '//') [ds]
            if (isLineInsideString(originalLines, c.line - 1, ext)) {
                console.warn(`[devsplain] Skipping comment insertion at line ${c.line} to avoid string literal corruption.`);
                continue;
            }

            const targetLine = originalLines[c.line - 1] || '';
            const indentMatch = targetLine.match(/^([ \t]*)/);
            const indentation = indentMatch ? indentMatch[1] : '';

            // Re-indent each inserted comment line to match the target line's leading whitespace [ds]
            const commentLines = c.comment.split(/\r?\n/).map((line, idx) => {
                let trimmed = line.trimStart();
                if (!trimmed) return '';

                // Detect line-comment styles vs block terminators to place the [ds] marker correctly [ds]
                const isSingleLine = trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('--');
                const isBlockEnd = trimmed.endsWith('*/') || trimmed.endsWith('-->');

                if (isSingleLine) {
                    trimmed = trimmed + ' [ds]';
                } else if (idx === 0) {
                    if (isBlockEnd) {
                        // Insert [ds] before the block-close token so it stays within the comment syntax [ds]
                        trimmed = trimmed.replace(/(\*\/|-->)$/, '[ds] $1');
                    } else {
                        trimmed = trimmed + ' [ds]';
                    }
                }

                // Preserve JSDoc-style asterisk alignment by offsetting one extra space [ds]
                if (trimmed.startsWith('*') && !trimmed.startsWith('*/') && !trimmed.startsWith('/*')) {
                    return indentation + ' ' + trimmed;
                }
                return indentation + trimmed;
            });

            const commentObjects = commentLines.map(line => ({ text: line, originalIndex: -1 }));
            annotated.splice(c.line - 1, 0, ...commentObjects);
        }
    }

    // Separate original lines (with preserved indices) from purely inserted comment lines [ds]
    const filtered = annotated.filter(line => line.originalIndex !== -1);
    const filteredText = filtered.map(line => line.text);
    const filteredIndices = filtered.map(line => line.originalIndex);

    // Track multi-line block comment state so we only validate the first line of each inserted block [ds]
    const insertedLines = annotated.filter(line => line.originalIndex === -1);
    let inInsertedBlock = false;
    for (const item of insertedLines) {
        const trimmed = item.text.trim();
        if (!trimmed) continue;
        if (inInsertedBlock) {
            if (trimmed.includes('*/') || trimmed.includes('-->')) {
                inInsertedBlock = false;
            }
            continue;
        }
        const isValidComment = 
            trimmed.startsWith('//') || 
            trimmed.startsWith('/*') || 
            trimmed.startsWith('*') || 
            trimmed.startsWith('#') || 
            trimmed.startsWith('<!--') || 
            trimmed.startsWith('--');
        // Final safety assertion: refuse to emit output if any inserted line is not comment syntax [ds]
        if (!isValidComment) {
            throw new Error(`Safety Assertion Failed: Refused to insert non-comment code: "${trimmed}"`);
        }
        // Enter block-comment state if this line opens a block without closing it on the same line [ds]
        if ((trimmed.startsWith('/*') && !trimmed.includes('*/')) || (trimmed.startsWith('<!--') && !trimmed.includes('-->'))) {
            inInsertedBlock = true;
        }
    }

    // Verify output fidelity: every retained original line must match its source, accounting for [ds]
    // comment stripping applied during prune/clean. Catches silent corruption before write. [ds]
    const textEqual = filteredText.every((text, idx) => {
        const origIdx = filteredIndices[idx];
        const originalLine = originalLines[origIdx];
        if (text === originalLine) {
            return true;
        }
        if ((mode === 'clean' || mode === 'prune') && analysis) {
            // Verify that removing the comment from this line produces exactly the expected stripped text. This acts as a safety check that the comment parser correctly identified comment boundaries for all supported syntaxes. [ds]
            const lineAnalysis = analysis[origIdx];
            if (lineAnalysis && lineAnalysis.commentStartIndex !== -1 && !lineAnalysis.isPureComment) {
                const isDsBlockLine = dsBlocks.has(origIdx + 1);
                const hasDsInline = originalLine.includes('[ds]');
                if (mode === 'prune' || (mode === 'clean' && (hasDsInline || isDsBlockLine))) {
                    const idx = lineAnalysis.commentStartIndex;
                    const remainder = originalLine.slice(idx);
                    let expectedStripped = originalLine.slice(0, idx).trimEnd();
                    
                    // Handle inline block comments (`/* ... */`) that start and end on the same line; preserve any code that appears after the closing delimiter. [ds]
                    if (remainder.startsWith('/*')) {
                        const endIdx = remainder.indexOf('*/');
                        if (endIdx !== -1) {
                            expectedStripped = originalLine.slice(0, idx) + remainder.slice(endIdx + 2);
                        }
                    // HTML-style comments (`<!-- ... -->`) follow a similar single-line stripping rule with a 3-char closing delimiter. [ds]
                    } else if (remainder.startsWith('<!--')) {
                        const endIdx = remainder.indexOf('-->');
                        if (endIdx !== -1) {
                            expectedStripped = originalLine.slice(0, idx) + remainder.slice(endIdx + 3);
                        }
                    }
                    expectedStripped = expectedStripped.trimEnd();

                    // Only mark this line as unchanged if the actual result exactly matches the predicted comment-stripped form; any mismatch signals a parser bug. [ds]
                    if (text === expectedStripped) {
                        return true;
                    }
                }
            }
        }
        return false;
    });

    // Safety invariant: after splicing out comments, the surviving source line indices must remain strictly increasing (monotonically). A violation means lines were duplicated, reordered, or lost. [ds]
    let indicesSequential = true;
    for (let i = 1; i < filteredIndices.length; i++) {
        if (filteredIndices[i] <= filteredIndices[i - 1]) {
            indicesSequential = false;
            break;
        }
    }

    if (!textEqual || !indicesSequential) {
        throw new Error("Safety Assertion Failed: Spliced code does not match original code minus comments!");
    }

    return annotated.map(line => line.text).join(lineEnding);
}

/** [ds]
 * CLI entry point: parses arguments, merges them with persisted config, runs the commenter across the target file(s), and handles special subcommands like --help, --version, --config, hook install/removal.
*/
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
  --provider <name>   Override AI provider (gemini, groq, openai, claude, deepseek, custom)
  --model <name>      Override AI model name
  --api-key <key>     Override API key for the provider
  --base-url <url>    Override base URL for custom APIs
  --concurrency <num> Override file concurrency level (1-5, default: 2)
  --chunk-size <num>  Override chunk line size (e.g. 200, 600, 1000)
  --config            Force run the configuration setup wizard
  --setup-hook        Install Git pre-commit and post-commit hooks in repository
  --remove-hook       Remove devsplain-installed Git hooks from repository
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
        const { installHooks } = require('./setup-hook.js');
        await installHooks();
        return;
    }

    if (args.includes('--remove-hook')) {
        rl.close();
        const { removeHooks } = require('./setup-hook.js');
        await removeHooks();
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
    // Skip past flag keys that consume the next argument so the positional file path isn't mistaken for a flag value. [ds]
    const flagKeys = ['--provider', '--model', '--api-key', '--base-url', '--concurrency', '--chunk-size'];
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
    const hasOverwriteFlag = args.includes('--overwrite');
    const hasKeepFlag = args.includes('--keep');

    // Refuse to modify a dirty working tree unless the user explicitly forces it or is doing a dry run; prevents accidental loss of uncommitted changes. [ds]
    if (process.env.NODE_ENV !== 'test' && isGitDirty() && !isForce && !isDryRun) {
        console.error("Error: Git working tree is dirty. Please commit or stash your changes, or use --force to bypass this check.");
        rl.close();
        process.exit(1);
    }

    const config = await getConfig();

    const cliProvider = getArgValue('--provider');
    const cliModel = getArgValue('--model');
    const cliApiKey = getArgValue('--api-key');
    const cliBaseUrl = getArgValue('--base-url');

    // When a provider is supplied via CLI without an explicit model, fall back to a sensible default model per provider. [ds]
    if (cliProvider) {
        config.provider = cliProvider;
        if (!cliModel) {
            config.model = cliProvider === 'gemini' ? 'gemini-2.0-flash' : (cliProvider === 'claude' ? 'claude-3-5-sonnet-20240620' : (cliProvider === 'deepseek' ? 'deepseek-chat' : (cliProvider === 'openai' ? 'gpt-4o' : 'llama-3.3-70b-versatile')));
        }
        // Similarly, auto-fill the provider's base URL when none is given; Gemini uses null because its SDK constructs the URL differently. [ds]
        if (!cliBaseUrl) {
            config.baseUrl = cliProvider === 'gemini' ? null : (cliProvider === 'groq' ? 'https://api.groq.com/openai' : (cliProvider === 'openai' ? 'https://api.openai.com' : (cliProvider === 'claude' ? 'https://api.anthropic.com' : (cliProvider === 'deepseek' ? 'https://api.deepseek.com' : ''))));
        }
    }
    if (cliModel) config.model = cliModel;
    if (cliApiKey) config.apiKey = cliApiKey;
    if (cliBaseUrl) config.baseUrl = cliBaseUrl;

    let successCount = 0;
    let failCount = 0;

    const projectFingerprint = getProjectFingerprint(filepath);

    const isOverwrite = (hasOverwriteFlag || config.autoPrune) && !hasKeepFlag;

    // Concurrency is clamped to 1-5 to prevent excessive parallel LLM API calls / resource exhaustion [ds]
    const cliConcurrency = parseInt(getArgValue('--concurrency'), 10);
    const concurrencyLevel = (cliConcurrency && cliConcurrency >= 1 && cliConcurrency <= 5) ? cliConcurrency : 2;

    // Derive the chunk threshold and overlap from the user-supplied chunk size to keep related context adjacent between splits. [ds]
    const cliChunkSize = parseInt(getArgValue('--chunk-size'), 10);
    if (cliChunkSize && cliChunkSize >= 50 && cliChunkSize <= 2000) {
        config.chunkSize = cliChunkSize;
        // Derive threshold and overlap from chunk size using ratios so related config values stay consistent [ds]
        config.chunkThreshold = Math.round(cliChunkSize * 1.25);
        config.chunkOverlap = Math.max(10, Math.round(cliChunkSize * 0.1));
    }

    // Load user-defined ignore patterns from .devsplainignore; silently no-op if file is missing or unreadable [ds]
    let userIgnorePatterns = [];
    try {
        const ignorePath = path.join(process.cwd(), '.devsplainignore');
        if (fs.existsSync(ignorePath)) {
            const ignoreContent = fs.readFileSync(ignorePath, 'utf8');
            // Split on CRLF or LF, then strip blank lines and comments (lines starting with '#') [ds]
            userIgnorePatterns = ignoreContent.split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));
        }
    } catch(e) {}

    // Default folders to skip across JS/TS, Python, Java, and common editor/CI artifacts [ds]
    const defaultIgnoredFolders = [
        'node_modules', '.git', 'dist', 'build', 'out', 
        '.next', '.nuxt', '.svelte-kit', 
        'venv', 'env', '.venv',          
        '.vscode', '.idea', 'coverage',
        'tests', '__tests__', 'fixtures'
    ];
    const allIgnored = [...defaultIgnoredFolders, ...userIgnorePatterns];

    /** [ds]
     * Determines whether a path should be ignored based on default folders and user patterns.
     * Matches against basename, cwd-relative path, and prefix matches (directory + subpaths).
     * Also supports simple '*suffix' globs since full glob matching is not required here.
    */
    function isPathIgnored(targetPath) {
        const filename = path.basename(targetPath);
        // Normalize to forward slashes so patterns work consistently on Windows and POSIX [ds]
        const relPath = path.relative(process.cwd(), targetPath).replace(/\\/g, '/');
        for (const pattern of allIgnored) {
            // Strip trailing slashes so 'node_modules/' matches both the folder and its contents [ds]
            const cleanPattern = pattern.replace(/\/$/, '').replace(/\\$/, '');
            if (filename === cleanPattern || relPath === cleanPattern || relPath.startsWith(cleanPattern + '/')) return true;
            if (pattern.startsWith('*') && filename.endsWith(pattern.slice(1))) return true;
        }
        return false;
    }

    const validExtensions = [
        '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.scss', '.vue', '.svelte',
        '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rb', '.php', '.rs', 
        '.swift', '.kt', '.dart', '.sh', '.sql'
    ];

    /** [ds]
     * Recursively walks targetPath, skipping ignored paths, non-source extensions, and empty files.
     * Returns the list of file paths eligible for commenting.
    */
    function collectFiles(targetPath) {
        const collected = [];
        const stats = fs.statSync(targetPath);

        if (isPathIgnored(targetPath)) return collected;

        if (stats.isDirectory()) {
            console.log(`\n Scanning directory: ${targetPath}`);
            const items = fs.readdirSync(targetPath);
            for (const item of items) {
                collected.push(...collectFiles(path.join(targetPath, item)));
            }
        } else if (stats.isFile()) {
            const ext = path.extname(targetPath).toLowerCase();
            if (!validExtensions.includes(ext)) return collected;

            const data = fs.readFileSync(targetPath, 'utf-8');
            // Skip files that are only whitespace - nothing to comment, avoids wasted LLM calls [ds]
            if (data.trim() === '') {
                console.log(` Skipping ${path.basename(targetPath)} (Empty File)`);
                return collected;
            }
            collected.push(targetPath);
        }
        return collected;
    }

    /** [ds]
     * Runs the full commenting pipeline on a single file: strip existing comments, request new ones
     * from the LLM, splice them back in, and write the result. Supports dry-run preview mode.
    */
    async function processSingleFile(targetPath) {
        const filename = path.basename(targetPath);
        const ext = path.extname(targetPath).toLowerCase();
        const data = fs.readFileSync(targetPath, 'utf-8');

        console.log(` Analyzing ${filename} in ${mode} mode...`);
        try {
            let comments = [];
            let commentedCode;
            // For annotate modes, first strip existing comments (or prune them in overwrite mode) so the model [ds]
            // sees only code and we avoid stacking new comments on top of stale ones [ds]
            if (mode !== 'clean' && mode !== 'prune') {
                const preProcessMode = isOverwrite ? 'prune' : 'clean';
                const cleanData = spliceComments(data, [], preProcessMode, ext);
                comments = await getComments(cleanData, filename, config, mode, projectFingerprint);
                commentedCode = spliceComments(cleanData, comments, mode, ext);
            } else {
                commentedCode = spliceComments(data, [], mode, ext);
            }
            // Dry-run: preview output and require explicit 'write' confirmation before persisting [ds]
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
                // Write via temp file + atomic rename to avoid corrupting the target if the process crashes mid-write [ds]
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

    const filesToProcess = collectFiles(filepath);

    // Dry-run needs interactive prompts and clean/prune are fast, so process sequentially; [ds]
    // otherwise leverage the concurrency limiter for the LLM-bound annotate path [ds]
    if (isDryRun || mode === 'clean' || mode === 'prune') {
        for (const file of filesToProcess) {
            await processSingleFile(file);
        }
    } else {
        resetConcurrency(concurrencyLevel);
        console.log(`\n Processing ${filesToProcess.length} file(s) with concurrency: ${concurrencyLevel}`);
        await runWithConcurrency(filesToProcess, processSingleFile);
    }

    // Exit non-zero only if every file failed - partial failures are reported but not fatal [ds]
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

// Dual entrypoint: runnable as CLI, but also importable as a module for testing/integration [ds]
if (require.main === module) {
    runCLI().catch(err => {
        console.error(err);
        process.exit(1);
    });
} else {
    module.exports = { spliceComments, isLineInsideString };
}