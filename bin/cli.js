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
 * Determines if the git working tree has uncommitted changes.
 * Silently returns false if not in a git repo or git is unavailable.
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
 * Determines whether a given line index resides inside a string literal or comment
 * block for a given file extension. This is a hand-written heuristic lexer used to
 * avoid mis-attributing comment insertions that land inside multi-line strings or
 * block comments. It intentionally supports a wide menu of languages (Python,
 * HTML-family, Rust/Swift nested block comments, C++ raw strings, JS/TS regex literals).
*/
function isLineInsideString(lines, targetLineIndex, ext = '') {
    // Language-family flags derived from file extension drive all downstream branching. [ds]
    const isPython = ext.toLowerCase() === '.py';
    const isHTML = ['.html', '.vue', '.svelte'].includes(ext.toLowerCase());
    const isRustOrSwift = ['.rs', '.swift'].includes(ext.toLowerCase());
    const isCpp = ['.cpp', '.cc', '.cxx', '.c', '.h', '.hpp'].includes(ext.toLowerCase());
    const isJS = ['.js', '.jsx', '.ts', '.tsx'].includes(ext.toLowerCase());
    // Tracks lexical context across the entire prefix of the file up to targetLineIndex. [ds]
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
    // Scan every prior line character-by-character, carrying state forward. [ds]
    for (let i = 0; i < targetLineIndex; i++) {
        const line = lines[i];
        let j = 0;
        while (j < line.length) {
            // Inside /* */ comments: Rust/Swift allow nesting, so we track depth. [ds]
            if (inBlockJS) {
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
            // C++ raw strings (R"delim(...)delim") suppress all quote/comment parsing until terminator. [ds]
            if (inCppRawString) {
                if (line.slice(j, j + 2 + cppRawDelimiter.length) === ')' + cppRawDelimiter + '"') {
                    inCppRawString = false;
                    j += 2 + cppRawDelimiter.length;
                    continue;
                }
                j++;
                continue;
            }
            // JS regex literal: must count preceding backslashes to detect escaped slashes. [ds]
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
            if (inBlockHTML) {
                if (line.slice(j, j + 3) === '-->') {
                    inBlockHTML = false;
                    j += 3;
                    continue;
                }
                j++;
                continue;
            }
            // Comment detection runs BEFORE quote toggling so comment markers inside strings are not misread. [ds]
            // Check if comment starts (skip processing quotes if we are entering a comment)
            if (!inSingle && !inDouble && !inBacktick && !inTripleSingle && !inTripleDouble) {
                if (isPython) {
                    if (line[j] === '#') {
                        // Python comment: bail out of rest of the line entirely. [ds]
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
                        // Detect C++ raw string opener R"delim( — delimiter can be up to 16 chars, no whitespace/parens/backslash. [ds]
                        if (isCpp && line[j] === 'R' && line[j+1] === '"') {
                            const match = line.slice(j).match(/^R"([^()\\\s]{0,16})\(/);
                            if (match) {
                                cppRawDelimiter = match[1];
                                inCppRawString = true;
                                j += match[0].length;
                                continue;
                            }
                        }
                        // Disambiguate '/' as regex-literal vs division by inspecting the prior non-whitespace token. [ds]
                        if (isJS && line[j] === '/') {
                            let k = j - 1;
                            while (k >= 0 && /\s/.test(line[k])) k--;
                            let isRegex = false;
                            if (k < 0) {
                                isRegex = true;
                            } else {
                                const prevChar = line[k];
                                // Slash after these punctuators/keywords is a regex literal, not division. [ds]
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
            // Python triple-quoted strings may span multiple lines and toggle on triple delimiters. [ds]
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
            // Backtick template literals are exclusive to non-Python languages; honor escape sequences. [ds]
            if (!inTripleSingle && !inTripleDouble) {
                if (!isPython) {
                    if (!inSingle && !inDouble) {
                        if (line[j] === '`') {
                        let escaped = false;
                        let k = j - 1;
                        // Count consecutive backslashes by toggling; odd count means escaped [ds]
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
        // C-family and similar languages reset string/quote state per line (unlike backtick templates or Python triple-quotes) [ds]
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
 * Analyzes source lines to determine if the file ends inside an unterminated
 * string, template literal, raw string, regex, or block comment.
 *
 * Handles language-specific quoting rules: Python triple-quotes, C++ raw
 * strings, JS template literals, JS regex literals, HTML block comments,
 * and Rust/Swift nested block comments.
 *
 * @param {string[]} lines - Source lines to scan
 * @param {string} ext - File extension used to select lexer rules
 * @returns {boolean} True if the file ends with an unterminated token
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
                if (line.slice(j, j + 2) === '/*') {
                    // Rust and Swift allow nested /* */ block comments; track depth instead of a boolean [ds]
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
                // C++ raw string terminator is )"delimiter" — delimiter must be matched exactly [ds]
                if (line.slice(j, j + 2 + cppRawDelimiter.length) === ')' + cppRawDelimiter + '"') {
                    inCppRawString = false;
                    j += 2 + cppRawDelimiter.length;
                    continue;
                }
                j++;
                continue;
            }
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
                    // Shell and Ruby use '#' for line comments [ds]
                    const isShellOrRuby = ['.sh', '.rb'].includes(ext.toLowerCase());
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
                        if (ext.toLowerCase() === '.php' && line[j] === '#') {
                            commentStartIndex = j;
                            break;
                        }
                        // C++11 raw string literal: R"delim(...)delim" where delim is up to 16 non-special chars [ds]
                        if (isCpp && line[j] === 'R' && line[j+1] === '"') {
                            const match = line.slice(j).match(/^R"([^()\\\s]{0,16})\(/);
                            if (match) {
                                cppRawDelimiter = match[1];
                                inCppRawString = true;
                                j += match[0].length;
                                continue;
                            }
                        }
                        // Distinguish regex literal /.../  from division operator by inspecting the preceding non-whitespace token [ds]
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
                            // Enter regex mode; the closing '/' will be matched during subsequent char scanning. [ds]
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
                    // Triple-quoted Python strings can span lines; only enter/exit when not already inside another quote type to avoid premature termination. [ds]
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
            // Attempts to detect escaped quote characters (backslash-balanced, ignoring double escaping). [ds]
            if (!inTripleSingle && !inTripleDouble) {
                if (!isPython) {
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
        // C-family languages reset string/comment state at each newline (no line-spanning single/double quotes or regex). Python and JS template literals are excluded to allow multi-line constructs. [ds]
        const resetsAtLineEnd = ['.js', '.jsx', '.ts', '.tsx', '.java', '.c', '.cpp', '.cs', '.go', '.swift', '.kt', '.dart'].includes(ext.toLowerCase());
        if (resetsAtLineEnd) {
            inSingle = false;
            inDouble = false;
            inRegex = false;
        }
        // A line is 'entirely inside a block' if we're at a block start with no trailing code, or fully wrapped by a block comment with no code before/after. [ds]
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
 * Rewrites source by applying user-supplied comments.
 * Handles 'default' (insert annotations), 'prune' (strip inline comments only),
 * and 'clean' (remove auto-generated [ds] doc blocks).
 * Preserves the original line-ending style (CRLF vs LF).
*/
function spliceComments(data, comments, mode = 'default', ext = '') {
    const hasCRLF = data.includes('\r\n');
    const lineEnding = hasCRLF ? '\r\n' : '\n';
    const originalLines = data.split(/\r?\n/);
    // Process in descending line order so earlier insertions don't invalidate line numbers of subsequent edits. [ds]
    const sortedComments = [...comments].sort((a, b) => b.line - a.line);
    const validComments = sortedComments.filter(c => c.line >= 1 && c.line <= originalLines.length + 1);

    const annotated = originalLines.map((text, index) => ({ text, originalIndex: index }));
    let analysis = null;
    let dsBlocks = new Set();

    // 'clean' and 'prune' modes both require lexical analysis to know which lines/regions consist solely of comments. [ds]
    if (mode === 'clean' || mode === 'prune') {
        analysis = analyzeComments(originalLines, ext);
        const finalDeletions = new Set();
        // Pre-scan for [ds]-tagged comment blocks (including the line preceding the block) so entire generated docs can be removed atomically in 'clean' mode. [ds]
        if (mode === 'clean') {
            let i = 0;
            while (i < originalLines.length) {
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

        for (let i = 0; i < originalLines.length; i++) {
            const lineNum = i + 1;
            const lineStr = originalLines[i];
            const lineAnalysis = analysis[i];

            // Preserve shebang lines unconditionally across all modes. [ds]
            if (lineStr.trim().startsWith('#!')) {
                continue;
            }

            if (mode === 'prune') {
                if (lineAnalysis.isPureComment) {
                    finalDeletions.add(lineNum);
                } else if (lineAnalysis.commentStartIndex !== -1) {
                    const idx = lineAnalysis.commentStartIndex;
                    const remainder = lineStr.slice(idx);
                    let newText = lineStr.slice(0, idx).trimEnd();
                    
                    if (remainder.startsWith('/*')) {
                        const endIdx = remainder.indexOf('*/');
                        if (endIdx !== -1) {
                            newText = lineStr.slice(0, idx) + remainder.slice(endIdx + 2);
                        }
                    } else if (remainder.startsWith('<!--')) {
                        // Handle closing of inline block comment: slice out '-->' terminator to preserve any trailing code after the comment [ds]
                        const endIdx = remainder.indexOf('-->');
                        if (endIdx !== -1) {
                            newText = lineStr.slice(0, idx) + remainder.slice(endIdx + 3);
                        }
                    }
                    
                    annotated[i].text = newText.trimEnd();
                }
            // Clean mode removes comments only when tagged with [ds] marker (inline or inside a [ds] block), unlike prune which removes all comments [ds]
            } else if (mode === 'clean') {
                const isDsBlockLine = dsBlocks.has(lineNum);
                const hasDsInline = lineStr.includes('[ds]');

                // Pure-comment lines are dropped entirely; partial (inline) comments require surgical extraction of the surrounding code [ds]
                if (lineAnalysis.isPureComment) {
                    if (isDsBlockLine || hasDsInline) {
                        finalDeletions.add(lineNum);
                    }
                } else if (lineAnalysis.commentStartIndex !== -1) {
                    if (isDsBlockLine || hasDsInline) {
                        const idx = lineAnalysis.commentStartIndex;
                        const remainder = lineStr.slice(idx);
                        let newText = lineStr.slice(0, idx).trimEnd();
                        
                        // Block comment: reattach any content following the closing delimiter since it may be live code on the same line [ds]
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


        // Deletions are collected into a Set to dedupe (a line may be flagged by multiple passes), then sorted descending so splice offsets remain valid [ds]
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
            // Never strip shebang lines - removing them would break the executable script [ds]
            if (trimmedLine.startsWith('#!')) {
                continue;
            }

            // Defense-in-depth guard: before deleting, re-verify the line actually looks like a comment or blank. Prevents catastrophic data loss if upstream analysis is buggy [ds]
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
    // Insertion mode: for prune/annotate-style operations we splice new comment blocks into the source [ds]
    } else {
        for (const c of validComments) {
            // Skip insertion if the target line offset falls inside a string literal, which would corrupt the string [ds]
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

                // Classify comment style to know where to append the [ds] marker: line comments get it at EOL, block comments get it before the closing delimiter [ds]
                const isSingleLine = trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('--');
                const isBlockEnd = trimmed.endsWith('*/') || trimmed.endsWith('-->');

                if (isSingleLine) {
                    trimmed = trimmed + ' [ds]';
                } else if (idx === 0) {
                    if (isBlockEnd) {
                        // Place [ds] marker just before the block-close delimiter so the comment remains syntactically valid [ds]
                        trimmed = trimmed.replace(/(\*\/|-->)$/, '[ds] $1');
                    } else {
                        trimmed = trimmed + ' [ds]';
                    }
                }

                // JSDoc-style continuation lines (' * ...') need an extra leading space to align the asterisk under the opening '/**' [ds]
                if (trimmed.startsWith('*') && !trimmed.startsWith('*/') && !trimmed.startsWith('/*')) {
                    return indentation + ' ' + trimmed;
                }
                return indentation + trimmed;
            });

            const commentObjects = commentLines.map(line => ({ text: line, originalIndex: -1 }));
            annotated.splice(c.line - 1, 0, ...commentObjects);
        }
    }

    // Split annotated stream back into original-indexed lines vs newly-inserted lines so we can validate both independently [ds]
    const filtered = annotated.filter(line => line.originalIndex !== -1);
    const filteredText = filtered.map(line => line.text);
    const filteredIndices = filtered.map(line => line.originalIndex);

    // Validate that every inserted line is a genuine comment (or continuation of a block comment), never stray executable code [ds]
    const insertedLines = annotated.filter(line => line.originalIndex === -1);
    let inInsertedBlock = false;
    for (const item of insertedLines) {
        const trimmed = item.text.trim();
        if (!trimmed) continue;
        // Track whether we are inside a multi-line block comment so inner lines are not individually required to start with a comment token [ds]
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
        if (!isValidComment) {
            throw new Error(`Safety Assertion Failed: Refused to insert non-comment code: "${trimmed}"`);
        }
        // An opening block-comment delimiter without a matching close on the same line flips us into 'inside block' mode [ds]
        if ((trimmed.startsWith('/*') && !trimmed.includes('*/')) || (trimmed.startsWith('<!--') && !trimmed.includes('-->'))) {
            inInsertedBlock = true;
        }
    }

    // Safety assertion: verify the spliced output is equivalent to the original minus the removed comments. Prevents silent corruption of source code. [ds]
    const textEqual = filteredText.every((text, idx) => {
        const origIdx = filteredIndices[idx];
        const originalLine = originalLines[origIdx];
        if (text === originalLine) {
            return true;
        }
        // In clean/prune modes, allow text to differ from the original where a [ds] comment was deliberately stripped from an otherwise-live line [ds]
        if ((mode === 'clean' || mode === 'prune') && analysis) {
            const lineAnalysis = analysis[origIdx];
            if (lineAnalysis && lineAnalysis.commentStartIndex !== -1 && !lineAnalysis.isPureComment) {
                const isDsBlockLine = dsBlocks.has(origIdx + 1);
                const hasDsInline = originalLine.includes('[ds]');
                // Reconstruct expected output after removing the tagged comment and compare - any drift indicates the splice damaged real code [ds]
                if (mode === 'prune' || (mode === 'clean' && (hasDsInline || isDsBlockLine))) {
                    const idx = lineAnalysis.commentStartIndex;
                    const remainder = originalLine.slice(idx);
                    let expectedStripped = originalLine.slice(0, idx).trimEnd();
                    
                    if (remainder.startsWith('/*')) {
                        const endIdx = remainder.indexOf('*/');
                        if (endIdx !== -1) {
                            expectedStripped = originalLine.slice(0, idx) + remainder.slice(endIdx + 2);
                        }
                    } else if (remainder.startsWith('<!--')) {
                        const endIdx = remainder.indexOf('-->');
                        if (endIdx !== -1) {
                            expectedStripped = originalLine.slice(0, idx) + remainder.slice(endIdx + 3);
                        }
                    }
                    expectedStripped = expectedStripped.trimEnd();

                    if (text === expectedStripped) {
                        return true;
                    }
                }
            }
        }
        return false;
    });

    // Ensure original indices remain strictly increasing; a duplicate or reorder would signal that splice offsets were miscomputed [ds]
    let indicesSequential = true;
    for (let i = 1; i < filteredIndices.length; i++) {
        if (filteredIndices[i] <= filteredIndices[i - 1]) {
            indicesSequential = false;
            break;
        }
    }

    // Hard failure if either content drifted or ordering broke - better to abort than to write corrupted files [ds]
    if (!textEqual || !indicesSequential) {
        throw new Error("Safety Assertion Failed: Spliced code does not match original code minus comments!");
    }

    return annotated.map(line => line.text).join(lineEnding);
}

/** [ds]
 * Entry point for the CLI. Parses argv, merges CLI overrides with saved config, and dispatches to the appropriate
 * command (help/version/config/hook install/remove) or the main comment-generation pipeline.
 * Sets up a shared readline interface used by `askQuestion` for interactive prompts.
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

    /** Reads the value immediately following a `--flag` in argv, or null if absent/trailing. [ds] */
    const getArgValue = (flag) => {
        const index = args.indexOf(flag);
        if (index !== -1 && index + 1 < args.length) {
            return args[index + 1];
        }
        return null;
    };

    // Identify the positional file path by skipping over flags and their argument values (flagKeys consume the next token). [ds]
    let filepath = '.';
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

    // Guard against modifying an uncommitted working tree. Skipped in tests and during dry-runs since nothing is written. [ds]
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

    // When the user overrides the provider via CLI, backfill sensible default model and base URL so partial overrides still work. [ds]
    if (cliProvider) {
        config.provider = cliProvider;
        if (!cliModel) {
            config.model = cliProvider === 'gemini' ? 'gemini-2.0-flash' : (cliProvider === 'claude' ? 'claude-3-5-sonnet-20240620' : (cliProvider === 'deepseek' ? 'deepseek-chat' : (cliProvider === 'openai' ? 'gpt-4o' : 'llama-3.3-70b-versatile')));
        }
        if (!cliBaseUrl) {
            config.baseUrl = cliProvider === 'gemini' ? null : (cliProvider === 'groq' ? 'https://api.groq.com/openai' : (cliProvider === 'openai' ? 'https://api.openai.com' : (cliProvider === 'claude' ? 'https://api.anthropic.com' : (cliProvider === 'deepseek' ? 'https://api.deepseek.com' : ''))));
        }
    }
    if (cliModel) config.model = cliModel;
    if (cliApiKey) config.apiKey = cliApiKey;
    if (cliBaseUrl) config.baseUrl = cliBaseUrl;

    let successCount = 0;
    let failCount = 0;

    const isOverwrite = (hasOverwriteFlag || config.autoPrune) && !hasKeepFlag;

    // Clamp concurrency to the 1-5 range; default to 2 to avoid hammering provider rate limits. [ds]
    const cliConcurrency = parseInt(getArgValue('--concurrency'), 10);
    const concurrencyLevel = (cliConcurrency && cliConcurrency >= 1 && cliConcurrency <= 5) ? cliConcurrency : 2;

    // Derive chunk threshold/overlap from the requested chunk size so large files split predictably without cutting mid-function. [ds]
    const cliChunkSize = parseInt(getArgValue('--chunk-size'), 10);
    if (cliChunkSize && cliChunkSize >= 50 && cliChunkSize <= 2000) {
        config.chunkSize = cliChunkSize;
        config.chunkThreshold = Math.round(cliChunkSize * 1.25);
        config.chunkOverlap = Math.max(10, Math.round(cliChunkSize * 0.1));
    }

    // Load user-defined ignore patterns from `.devsplainignore`; silently ignore read/parse errors since the file is optional. [ds]
    let userIgnorePatterns = [];
    try {
        const ignorePath = path.join(process.cwd(), '.devsplainignore');
        if (fs.existsSync(ignorePath)) {
            const ignoreContent = fs.readFileSync(ignorePath, 'utf8');
            // Strip trailing whitespace, drop blank lines and `#` comments to mirror .gitignore semantics. [ds]
            userIgnorePatterns = ignoreContent.split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));
        }
    } catch(e) {}

    const defaultIgnoredFolders = [
        'node_modules', '.git', 'dist', 'build', 'out', 
        '.next', '.nuxt', '.svelte-kit', 
        'venv', 'env', '.venv',          
        '.vscode', '.idea', 'coverage',
        'tests', '__tests__', 'fixtures'
    ];
    const allIgnored = [...defaultIgnoredFolders, ...userIgnorePatterns];

    /** [ds]
     * Returns true if `targetPath` matches any ignored folder name, glob suffix, or is nested under an ignored directory.
     * Compares both the basename and the cwd-relative path so patterns work whether matched at any depth or rooted.
    */
    function isPathIgnored(targetPath) {
        const filename = path.basename(targetPath);
        // Normalize Windows backslashes to forward slashes for consistent pattern matching across platforms. [ds]
        const relPath = path.relative(process.cwd(), targetPath).replace(/\\/g, '/');
        // Trim trailing path separators so `node_modules/` also matches the bare directory name. [ds]
        for (const pattern of allIgnored) {
            // Normalize trailing separators so "foo/" and "foo" compare equal [ds]
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
     * Recursively walks the filesystem from targetPath, returning a flat list of
     * source files whose extensions are in validExtensions and that are non-empty.
     * Empty files are skipped because there is nothing to comment on.
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
            // Extensions are compared case-insensitively (e.g. .JS matches .js) [ds]
            const ext = path.extname(targetPath).toLowerCase();
            if (!validExtensions.includes(ext)) return collected;

            const data = fs.readFileSync(targetPath, 'utf-8');
            if (data.trim() === '') {
                console.log(` Skipping ${path.basename(targetPath)} (Empty File)`);
                return collected;
            }
            collected.push(targetPath);
        }
        return collected;
    }

    /** [ds]
     * Runs the full pipeline on a single file: extract existing comments, generate
     * new comments via the AI, splice them back into the source, and persist atomically.
     *
     * In overwrite mode, an initial "prune" pass strips prior comments before they
     * are regenerated, otherwise previously inserted comments would be duplicated.
     *
     * Writes are atomic (temp file + rename) to avoid corrupting the source if the
     * process is interrupted mid-write.
    */
    async function processSingleFile(targetPath) {
        const filename = path.basename(targetPath);
        const ext = path.extname(targetPath).toLowerCase();
        const data = fs.readFileSync(targetPath, 'utf-8');

        console.log(` Analyzing ${filename} in ${mode} mode...`);
        try {
            let comments = [];
            let commentedCode;
            // 'clean'/'prune' modes skip comment extraction since the output is comment-stripped [ds]
            if (mode !== 'clean' && mode !== 'prune') {
                // Overwrite needs prune (not clean) so existing non-generated comments are preserved as context [ds]
                const preProcessMode = isOverwrite ? 'prune' : 'clean';
                const cleanData = spliceComments(data, [], preProcessMode, ext);
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

    const filesToProcess = collectFiles(filepath);

    // Dry-run and clean operations must stay sequential because they prompt the user per file [ds]
    if (isDryRun || mode === 'clean' || mode === 'prune') {
        for (const file of filesToProcess) {
            await processSingleFile(file);
        }
    } else {
        resetConcurrency(concurrencyLevel);
        console.log(`\n Processing ${filesToProcess.length} file(s) with concurrency: ${concurrencyLevel}`);
        await runWithConcurrency(filesToProcess, processSingleFile);
    }

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

if (require.main === module) {
    runCLI().catch(err => {
        console.error(err);
        process.exit(1);
    });
} else {
    module.exports = { spliceComments, isLineInsideString };
}