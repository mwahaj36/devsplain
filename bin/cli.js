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
 * Generates a short project identifier comment by inspecting package.json or README.md.
 * Returns an empty string if no meaningful project metadata can be found; this is
 * intentionally best-effort since the fingerprint is only used as a prompt hint.
*/
function getProjectFingerprint(targetPath) {
    try {
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
 * Detects whether the current working directory is a dirty git work tree.
 * Returns false on any error (not a repo, git missing) so callers can treat
 * failures as "not dirty" rather than aborting the run.
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
 * Heuristically determines whether the given line index is inside a string literal
 * or block comment for the language implied by `ext`.
 *
 * This is used to avoid inserting doc comments into string contents. It is a
 * single-pass, line-oriented lexer (no full parser) that tracks state across
 * lines: JS/HTML block comments, C++ raw string literals, JS regex literals,
 * Python triple-quoted strings, and plain quote/backtick state.
 *
 * Trade-offs: language detection is best-effort and may misclassify exotic
 * syntax, but errs on the side of false positives (treating lines as "inside")
 * so we don't corrupt source code.
*/
function isLineInsideString(lines, targetLineIndex, ext = '') {
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
            if (inCppRawString) {
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
            // Skip quote-state tracking while entering a comment so that comment markers [ds]
            // (which may contain quotes) don't desync the string parser. [ds]
            // Check if comment starts (skip processing quotes if we are entering a comment)
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
                        // C++11 raw string literal: R"delim( ... )delim". Capture the delimiter so [ds]
                        // the matching close can be detected later. Delimiter is limited to <=16 [ds]
                        // chars and must not contain parens, backslash, or whitespace per spec. [ds]
                        if (isCpp && line[j] === 'R' && line[j+1] === '"') {
                            const match = line.slice(j).match(/^R"([^()\\\s]{0,16})\(/);
                            if (match) {
                                cppRawDelimiter = match[1];
                                inCppRawString = true;
                                j += match[0].length;
                                continue;
                            }
                        }
                        // Disambiguate '/' as a regex literal vs division/comment by looking at the [ds]
                        // previous significant token. Regex is valid at start-of-expression positions [ds]
                        // (after operators, keywords like return/typeof, or at line start). [ds]
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
 * Analyzes a file's lines to locate and extract comment blocks.
 * Performs a language-aware lexical scan that tracks nested states across lines,
 * including string literals (single, double, backtick, Python triple-quotes),
 * C++ raw strings, JS/HTML block comments, and regex literals, so that comment
 * delimiters appearing inside string contents are ignored.
 * @param {string[]} lines - Source file lines.
 * @param {string} ext - File extension used to select language-specific rules.
 * @returns {Array} Analysis results with per-line comment information.
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
        // Character-by-character scan is required to distinguish comment markers that appear inside strings, regexes, or nested block comments; a simple line-based check would produce false positives. [ds]
        while (j < line.length) {
            if (inBlockJS) {
                // Rust and Swift allow nested block comments, so track depth rather than a boolean; other languages close on the first */. [ds]
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
                // C++ raw string terminators are of the form )DELIM", where DELIM is the user-chosen delimiter captured at the opening R"DELIM(. [ds]
                if (line.slice(j, j + 2 + cppRawDelimiter.length) === ')' + cppRawDelimiter + '"') {
                    inCppRawString = false;
                    j += 2 + cppRawDelimiter.length;
                    continue;
                }
                j++;
                continue;
            }
            if (inRegex) {
                // Count consecutive preceding backslashes to determine if this '/' is escaped; an even count means the slash is unescaped and closes the regex. [ds]
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
                    const isShellOrRuby = ['.sh', '.rb'].includes(ext.toLowerCase());
                    // Shell and Ruby use '#' for comments; other languages use '//' or '/* */'. PHP also treats '#' as a comment (handled below). [ds]
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
                        // C++11 raw string literals: R"delim(...)delim". The delimiter up to 16 chars cannot contain parens, backslashes, or whitespace. Must be checked before treating '/' as comment start. [ds]
                        if (isCpp && line[j] === 'R' && line[j+1] === '"') {
                            const match = line.slice(j).match(/^R"([^()\\\s]{0,16})\(/);
                            if (match) {
                                cppRawDelimiter = match[1];
                                inCppRawString = true;
                                j += match[0].length;
                                continue;
                            }
                        }
                        // Disambiguate '/' as a regex literal vs division operator. A regex is valid if it appears at start of expression: after an operator, opening bracket, or keywords like return/typeof. [ds]
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
            // Python triple-quoted strings toggle on each occurrence; must not be interpreted while already inside a single/double quote of the other kind. [ds]
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
            // Standard single/double quote and backtick toggling. An odd number of preceding backslashes escapes the quote character (but '\\' is a literal backslash, so the quote is not escaped). [ds]
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
        /** [ds]
         * Collects information about comments and string/block constructs on every line,
         * used by 'clean'/'prune' modes to delete pure comments and strip trailing comments.
         * Returns per-line metadata: isPureComment, commentStartIndex, isInsideBlock.
        */
        const resetsAtLineEnd = ['.js', '.jsx', '.ts', '.tsx', '.java', '.c', '.cpp', '.cs', '.go', '.swift', '.kt', '.dart'].includes(ext.toLowerCase());
        if (resetsAtLineEnd) {
            inSingle = false;
            inDouble = false;
            inRegex = false;
        }
        // A line is 'entirely inside a block' if it began within a block and no comment start was found here (meaning the block-end has not been detected by this line's scanner). [ds]
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
 * Applies comment insertions/removals to source text. Handles three modes:
 *  - 'default': insert the provided comments above their target lines (1-indexed).
 *  - 'clean': delete pure-comment lines; preserve blocks containing '[ds]' markers.
 *  - 'prune': remove pure comments and strip trailing comments from code lines.
 * Preserves the original CRLF/LF line-ending style.
*/
function spliceComments(data, comments, mode = 'default', ext = '') {
    const hasCRLF = data.includes('\r\n');
    const lineEnding = hasCRLF ? '\r\n' : '\n';
    const originalLines = data.split(/\r?\n/);
    // Sort descending by line number so insertions/deletions do not shift indices of later operations. [ds]
    const sortedComments = [...comments].sort((a, b) => b.line - a.line);
    const validComments = sortedComments.filter(c => c.line >= 1 && c.line <= originalLines.length + 1);

    const annotated = originalLines.map((text, index) => ({ text, originalIndex: index }));
    let analysis = null;
    let dsBlocks = new Set();

    // 'clean' and 'prune' require comment analysis; 'default' inserts blindly. [ds]
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
                    let blockStart = Math.max(0, start - 1);
                    let blockEnd = end - 1;
                    let hasDs = false;
                    // Inline '[ds]' markers opt a comment block out of deletion, so users can retain documentation-style comments. [ds]
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

        // Main pass: walk every original line and mutate/prune based on mode. [ds]
        // 'prune' removes all comments; 'clean' removes only [ds]-tagged comments. [ds]
        // Shebang lines are skipped to preserve interpreter directives. [ds]
        for (let i = 0; i < originalLines.length; i++) {
            const lineNum = i + 1;
            const lineStr = originalLines[i];
            const lineAnalysis = analysis[i];

            // Preserve shebang lines: they are syntactically significant and must never be treated as deletable comments. [ds]
            if (lineStr.trim().startsWith('#!')) {
                continue;
            }

            // prune mode: strip comments everywhere, preserving shebangs [ds]
            if (mode === 'prune') {
                if (lineAnalysis.isPureComment) {
                    finalDeletions.add(lineNum);
                } else if (lineAnalysis.commentStartIndex !== -1) {
                    const idx = lineAnalysis.commentStartIndex;
                    const remainder = lineStr.slice(idx);
                    let newText = lineStr.slice(0, idx).trimEnd();
                    
                    // Handle trailing C-style or HTML block comments that start but don't end on this line. Only strip if the closing token is on the same line; otherwise leave intact to avoid mangling multi-line comment bodies. [ds]
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
            // clean mode: only remove [ds]-tagged comments (line-level or inline marker). Non-[ds] comments must be preserved. [ds]
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


        // Fold in comment positions discovered by the AST/parser but not already handled line-by-line above. [ds]
        for (const c of validComments) {
            const lineIdx = c.line - 1;
            if (lineIdx >= 0 && lineIdx < originalLines.length) {
                finalDeletions.add(c.line);
            }
        }

        // Sort descending so splice() by index doesn't shift subsequent targets. [ds]
        const linesToDelete = Array.from(finalDeletions).sort((a, b) => b - a);

        // Final safety net: before removing a line, verify it actually looks like a comment (or blank). Prevents accidentally deleting live code if analysis was wrong. [ds]
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

            // Splice removes exactly one line at the (1-indexed) target position. [ds]
            annotated.splice(lineNum - 1, 1);
        }
    } else {
        // Insertion path: re-inject validComments back into the file at their original line offsets. [ds]
        for (const c of validComments) {
            // Guard against inserting a comment into the middle of a multi-line string literal, which would corrupt parsing. [ds]
            if (isLineInsideString(originalLines, c.line - 1, ext)) {
                console.warn(`[devsplain] Skipping comment insertion at line ${c.line} to avoid string literal corruption.`);
                continue;
            }

            const targetLine = originalLines[c.line - 1] || '';
            // Inherit the target line's leading whitespace so inserted comments align with surrounding code. [ds]
            const indentMatch = targetLine.match(/^([ \t]*)/);
            const indentation = indentMatch ? indentMatch[1] : '';

            const commentLines = c.comment.split(/\r?\n/).map((line, idx) => {
                let trimmed = line.trimStart();
                if (!trimmed) return '';

                // Detect comment dialects to decide where the [ds] marker belongs: single-line comments get it appended; for block comments the marker goes after the opening token on line 0 (or before the closing token if line 0 is already the closer). [ds]
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

                // JSDoc-style continuation lines get an extra leading space so '*' aligns under '/*'. [ds]
                if (trimmed.startsWith('*') && !trimmed.startsWith('*/') && !trimmed.startsWith('/*')) {
                    return indentation + ' ' + trimmed;
                }
                return indentation + trimmed;
            });

            const commentObjects = commentLines.map(line => ({ text: line, originalIndex: -1 }));
            annotated.splice(c.line - 1, 0, ...commentObjects);
        }
    }

    // Split the annotated buffer back into original lines (with possibly edited text) and purely inserted comment lines (originalIndex === -1). [ds]
    const filtered = annotated.filter(line => line.originalIndex !== -1);
    const filteredText = filtered.map(line => line.text);
    const filteredIndices = filtered.map(line => line.originalIndex);

    // Safety assertion pass: every inserted line must actually be a comment. Raises hard error if non-comment content was injected. [ds]
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
        if (!isValidComment) {
            throw new Error(`Safety Assertion Failed: Refused to insert non-comment code: "${trimmed}"`);
        }
        // Track multi-line block comment state so intermediate lines (which may not start with a comment token) aren't wrongly rejected. [ds]
        if ((trimmed.startsWith('/*') && !trimmed.includes('*/')) || (trimmed.startsWith('<!--') && !trimmed.includes('-->'))) {
            inInsertedBlock = true;
        }
    }

    // Post-condition check: for every surviving original line, verify its text either matches the source exactly or is a predictable comment-stripped version. Catches accidental corruption before writing to disk. [ds]
    const textEqual = filteredText.every((text, idx) => {
        const origIdx = filteredIndices[idx];
        const originalLine = originalLines[origIdx];
        if (text === originalLine) {
            return true;
        }
        if ((mode === 'clean' || mode === 'prune') && analysis) {
            /** [ds]
             * Safety verification for the stripping pipeline: checks whether applying the
             * expected comment-removal transformation to `originalLine` produces the
             * already-processed `text`. The check is intentionally strict (must match
             * exactly after trimEnd) because any divergence implies the annotation
             * indices used for splicing are out of sync with the source, which would
             * silently corrupt user code.
            */
            const lineAnalysis = analysis[origIdx];
            // Only relevant when this line actually had a comment start AND isn't already a pure-comment line (which would have no code prefix to verify against). [ds]
            if (lineAnalysis && lineAnalysis.commentStartIndex !== -1 && !lineAnalysis.isPureComment) {
                // origIdx is 0-based; dsBlocks stores 1-based line numbers, hence the +1 offset. [ds]
                const isDsBlockLine = dsBlocks.has(origIdx + 1);
                const hasDsInline = originalLine.includes('[ds]');
                // In 'clean' mode we only strip [ds] lines; in 'prune' mode we strip every comment regardless of origin. [ds]
                if (mode === 'prune' || (mode === 'clean' && (hasDsInline || isDsBlockLine))) {
                    const idx = lineAnalysis.commentStartIndex;
                    const remainder = originalLine.slice(idx);
                    let expectedStripped = originalLine.slice(0, idx).trimEnd();
                    
                    // Reconstruct what the line *should* look like after removing a single block comment. Only single-line comments can be validated this way; multi-line block comments spanning lines are handled elsewhere via block-level logic, so they fall through and skip the equality check. [ds]
                    if (remainder.startsWith('/*')) {
                        const endIdx = remainder.indexOf('*/');
                        if (endIdx !== -1) {
                            // Preserve anything after the closing */ so we can compare against the actually-spliced output. [ds]
                            expectedStripped = originalLine.slice(0, idx) + remainder.slice(endIdx + 2);
                        }
                    // Same reconstruction rationale for HTML comments. [ds]
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

    /** [ds]
     * The filteredIndices array is the list of positions in the original file
     * that survived comment stripping. It must be strictly increasing because
     * downstream splice operations rely on ascending order to rebuild the file
     * correctly. A regression here would mean an index-tracking bug earlier in
     * the pipeline.
    */
    let indicesSequential = true;
    for (let i = 1; i < filteredIndices.length; i++) {
        if (filteredIndices[i] <= filteredIndices[i - 1]) {
            indicesSequential = false;
            break;
        }
    }

    // Failsafe: if either the text content or the index ordering has diverged, we refuse to output — silently writing corrupted code is worse than crashing. [ds]
    if (!textEqual || !indicesSequential) {
        throw new Error("Safety Assertion Failed: Spliced code does not match original code minus comments!");
    }

    return annotated.map(line => line.text).join(lineEnding);
}

/** [ds]
 * Entry point for the `devsplain` command-line tool. Parses argv, handles
 * early-exit flags (--help, --version, --config, hooks), resolves provider/
 * model overrides, then dispatches to the annotation pipeline.
 *
 * Order matters here: flags that short-circuit execution are processed
 * before configuration loading so they work even with a broken config.
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

    /** [ds]
     * Returns the value flagging the given CLI flag, or null if absent.
     * Does NOT detect flags whose value looks like another flag (e.g. missing
     * value followed by `--foo`), which callers must guard against separately.
    */
    const getArgValue = (flag) => {
        const index = args.indexOf(flag);
        if (index !== -1 && index + 1 < args.length) {
            return args[index + 1];
        }
        return null;
    };

    // Defaults to the current directory; will be overridden by the first non-flag positional argument. [ds]
    let filepath = '.';
    // Flags that consume the *next* argv element as their value — needed so the positional-argument scan below doesn't accidentally treat a flag's value (e.g. 'gemini' after --provider) as the target filepath. [ds]
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

    // Guard against running on a dirty working tree so users can review/revert our edits via git. Skipped under NODE_ENV=test to keep tests hermetic, and bypassed with --force. [ds]
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

    // When a provider is switched on the CLI without explicit model/baseUrl defaults, we hardcode sensible fallbacks per provider so the user doesn't have to remember model names. [ds]
    if (cliProvider) {
        config.provider = cliProvider;
        if (!cliModel) {
            // Per-provider default model. Custom provider is intentionally not in this chain and falls through to the Groq-compatible default. [ds]
            config.model = cliProvider === 'gemini' ? 'gemini-2.0-flash' : (cliProvider === 'claude' ? 'claude-3-5-sonnet-20240620' : (cliProvider === 'deepseek' ? 'deepseek-chat' : (cliProvider === 'openai' ? 'gpt-4o' : 'llama-3.3-70b-versatile')));
        }
        if (!cliBaseUrl) {
            // Gemini uses null baseUrl to signal its native SDK path; other providers use OpenAI-compatible HTTP endpoints (hence the /openai suffix on Groq). [ds]
            config.baseUrl = cliProvider === 'gemini' ? null : (cliProvider === 'groq' ? 'https://api.groq.com/openai' : (cliProvider === 'openai' ? 'https://api.openai.com' : (cliProvider === 'claude' ? 'https://api.anthropic.com' : (cliProvider === 'deepseek' ? 'https://api.deepseek.com' : ''))));
        }
    }
    if (cliModel) config.model = cliModel;
    if (cliApiKey) config.apiKey = cliApiKey;
    if (cliBaseUrl) config.baseUrl = cliBaseUrl;

    let successCount = 0;
    let failCount = 0;

    // Project fingerprint lets the config layer recognize previously-annotated projects and reuse cached settings. [ds]
    const projectFingerprint = getProjectFingerprint(filepath);

    // Overwrite only when the user explicitly opted in via --overwrite or autoPrune, unless --keep is set to protect existing comments. [ds]
    const isOverwrite = (hasOverwriteFlag || config.autoPrune) && !hasKeepFlag;

    /** [ds]
     * Parses CLI concurrency flag, clamping to safe range [1,5] to prevent
     * resource exhaustion; falls back to 2 when arg is missing or invalid.
    */
    const cliConcurrency = parseInt(getArgValue('--concurrency'), 10);
    // Clamp concurrency to [1,5]; anything outside that range (including NaN from parseInt) silently falls back to 2 to avoid unbounded API fan-out. [ds]
    const concurrencyLevel = (cliConcurrency && cliConcurrency >= 1 && cliConcurrency <= 5) ? cliConcurrency : 2;

    // Chunk size bounds prevent excessive memory use (too large) or API rate-limit [ds]
    // failures from too many small requests (too small). Threshold/overlap are derived [ds]
    // from chunk size to preserve retrieval fidelity when re-chunking. [ds]
    const cliChunkSize = parseInt(getArgValue('--chunk-size'), 10);
    // chunkThreshold is slightly larger than chunkSize so files near the boundary don't get chunked prematurely; chunkOverlap preserves cross-boundary context. [ds]
    if (cliChunkSize && cliChunkSize >= 50 && cliChunkSize <= 2000) {
        config.chunkSize = cliChunkSize;
        config.chunkThreshold = Math.round(cliChunkSize * 1.25);
        config.chunkOverlap = Math.max(10, Math.round(cliChunkSize * 0.1));
    }

    /** [ds]
     * Loads .devsplainignore from the CWD. Format mirrors .gitignore: one glob
     * per line, blank lines and lines beginning with '#' are ignored.
    */
    let userIgnorePatterns = [];
    try {
        const ignorePath = path.join(process.cwd(), '.devsplainignore');
        if (fs.existsSync(ignorePath)) {
            const ignoreContent = fs.readFileSync(ignorePath, 'utf8');
            // Split on CRLF or LF so patterns work cross-platform without stripping \r into the pattern. [ds]
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
     * Determines if a path should be excluded from scanning. Matches by basename,
     * exact relative path, descendant-of-directory, or suffix wildcard (e.g. *.min.js).
     * Trailing slashes are stripped so patterns like 'dist/' behave like 'dist'.
    */
    function isPathIgnored(targetPath) {
        const filename = path.basename(targetPath);
        const relPath = path.relative(process.cwd(), targetPath).replace(/\\/g, '/');
        for (const pattern of allIgnored) {
            const cleanPattern = pattern.replace(/\/$/, '').replace(/\\$/, '');
            if (filename === cleanPattern || relPath === cleanPattern || relPath.startsWith(cleanPattern + '/')) return true;
            // Wildcard only supported as leading '*'; treated as filename suffix match (not full globbing). [ds]
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
     * Recursively walks a directory tree collecting source files that match the
     * whitelist of extensions. Ignored paths are pruned early, and empty files are
     * skipped to avoid feeding no-op content to the analyzer.
    */
    function collectFiles(targetPath) {
        const collected = [];
        const stats = fs.statSync(targetPath);

        if (isPathIgnored(targetPath)) return collected;

        if (stats.isDirectory()) {
            console.log(`\n Scanning directory: ${targetPath}`);
            const items = fs.readdirSync(targetPath);
            for (const item of items) {
                // Spread-result pattern flattens nested arrays from recursive calls into a single list. [ds]
                collected.push(...collectFiles(path.join(targetPath, item)));
            }
        } else if (stats.isFile()) {
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
     * Runs the analyze/clean/prune pipeline for a single file. In non-clean/prune
     * modes, content is first pre-processed (pruned if overwriting, cleaned otherwise)
     * so the analyzer doesn't see stale comments that could bias results.
    */
    async function processSingleFile(targetPath) {
        const filename = path.basename(targetPath);
        const ext = path.extname(targetPath).toLowerCase();
        const data = fs.readFileSync(targetPath, 'utf-8');

        console.log(` Analyzing ${filename} in ${mode} mode...`);
        try {
            let comments = [];
            let commentedCode;
            // Two-phase: strip existing comments before analysis so comment-generation isn't [ds]
            // influenced by prior comments; then re-splice generated comments into cleaned data. [ds]
            if (mode !== 'clean' && mode !== 'prune') {
                const preProcessMode = isOverwrite ? 'prune' : 'clean';
                const cleanData = spliceComments(data, [], preProcessMode, ext);
                comments = await getComments(cleanData, filename, config, mode, projectFingerprint);
                commentedCode = spliceComments(cleanData, comments, mode, ext);
            } else {
                commentedCode = spliceComments(data, [], mode, ext);
            }
            // Dry-run writes to a temp then prompts before atomically replacing the original, [ds]
            // preserving the source if the user declines. [ds]
            if (isDryRun) {
                console.log(`\n --- DRY RUN PREVIEW: ${filename} ---`);
                console.log(commentedCode);
                console.log(`---------------------------------------\n`);
                const answer = await askQuestion("Type 'write' to save to file, or press any key to discard: ");
                if (answer.toLowerCase() === 'write') {
                    // Write-to-temp-then-rename ensures the destination is never left in a partially-written state. [ds]
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

    // Serial execution is forced for dry-run (needs user prompts) and clean/prune [ds]
    // (mutating ops that should not race on shared state). Parallel mode is only for [ds]
    // read-then-comment workloads. [ds]
    if (isDryRun || mode === 'clean' || mode === 'prune') {
        for (const file of filesToProcess) {
            await processSingleFile(file);
        }
    } else {
        resetConcurrency(concurrencyLevel);
        console.log(`\n Processing ${filesToProcess.length} file(s) with concurrency: ${concurrencyLevel}`);
        await runWithConcurrency(filesToProcess, processSingleFile);
    }

    // Catastrophic failure: nothing succeeded, so exit non-zero to signal CI/build pipelines. [ds]
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

// Direct execution runs the CLI; import-as-module exposes internals for testing/embedding. [ds]
if (require.main === module) {
    runCLI().catch(err => {
        console.error(err);
        process.exit(1);
    });
} else {
    module.exports = { spliceComments, isLineInsideString };
}