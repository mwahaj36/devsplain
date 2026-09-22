#!/usr/bin/env node

const { getComments, runWithConcurrency, resetConcurrency } = require('../lib/llm.js');
const { getConfig } = require('../lib/config.js');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

// Global readline interface and question helper are lazily initialized because [ds]
// creating a readline interface at module load time would keep stdin open [ds]
// indefinitely, preventing this CLI from exiting cleanly when not interactive. [ds]
let rl;
let askQuestion;

/** [ds]
 * Determines whether the current working directory is inside a git working
 * tree that has uncommitted changes. This check gates destructive operations
 * (like rewriting files in-place) so users do not lose unstaged work.
 *
 * Returns false when git is not installed, when not inside a repo, or when
 * any git command fails; stderr is suppressed to avoid noisy output on
 * systems without git.
*/
function isGitDirty() {
    try {
        // stderr is redirected to 'ignore' so missing-git errors don't leak to the console; [ds]
        // a thrown execSync error is caught below and treated as 'not a git repo'. [ds]
        const gitDir = execSync('git rev-parse --is-inside-work-tree', { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
        if (gitDir === 'true') {
            const status = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
            return status.length > 0;
        }
    // Swallow all exec errors (git missing, not a repo, etc.) and fall through to false. [ds]
    } catch (e) {
    }
    return false;
}

/** [ds]
 * Returns true if the given line index falls inside a multi-line or single-line
 * string/comment region for a specific language. This is a lightweight, hand-rolled
 * lexical scanner (not a real parser) that tracks a handful of state flags across
 * lines so that callers can avoid pattern-matching against text that merely looks
 * like code (e.g. a URL inside a string, or a comment block containing example code).
 *
 * The scanner is deliberately best-effort: it handles the most common string and
 * comment delimiters for JS/TS, Python, HTML-family, Rust/Swift nested block
 * comments, C/C++ raw strings, shell/ruby/php line comments, and JS regex literals.
 * Edge cases (templated languages, preprocessor macros, exotic raw string
 * delimiters) are not supported.
 *
 * @param {string[]} lines - All lines of the source file.
 * @param {number} targetLineIndex - The 0-based line index to query.
 * @param {string} ext - File extension including the leading dot (e.g. '.js').
 * @returns {boolean} True if the target line starts while inside a string/comment.
*/
function isLineInsideString(lines, targetLineIndex, ext = '') {
    const isPython = ext.toLowerCase() === '.py';
    const isHTML = ['.html', '.vue', '.svelte'].includes(ext.toLowerCase());
    const isRustOrSwift = ['.rs', '.swift'].includes(ext.toLowerCase());
    const isCpp = ['.cpp', '.cc', '.cxx', '.c', '.h', '.hpp'].includes(ext.toLowerCase());
    const isJS = ['.js', '.jsx', '.ts', '.tsx'].includes(ext.toLowerCase());
    // State flags carried across lines. Each represents a lexer mode that can span [ds]
    // newline boundaries; single/double quoted strings are technically single-line in [ds]
    // most of these languages, but we still track them to correctly skip escape handling. [ds]
    let inBacktick = false;
    let inTripleDouble = false;
    let inTripleSingle = false;
    let inSingle = false;
    let inDouble = false;
    let inBlockJS = false;
    let inBlockHTML = false;
    // Rust and Swift permit nested /* */ block comments, so we must track depth [ds]
    // instead of a simple boolean; other languages treat the first */ as closing. [ds]
    let blockDepthJS = 0;
    let inCppRawString = false;
    let cppRawDelimiter = '';
    let inRegex = false;
    // Scan every line strictly before the target line. We exclude the target itself [ds]
    // because the caller only cares whether the line *starts* inside a string/comment, [ds]
    // not what happens later on that same line. [ds]
    for (let i = 0; i < targetLineIndex; i++) {
        const line = lines[i];
        let j = 0;
        while (j < line.length) {
            // Inside a block comment: ignore all content except for nested openers/closers [ds]
            // (Rust/Swift only) and the matching closer that ends the comment. [ds]
            if (inBlockJS) {
                if (line.slice(j, j + 2) === '/*') {
                    if (isRustOrSwift) blockDepthJS++;
                    j += 2;
                    continue;
                }
                if (line.slice(j, j + 2) === '*/') {
                    // For Rust/Swift, keep the outer comment open until all nested depths are closed; [ds]
                    // for other languages, the first */ always closes the block. [ds]
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
            // Inside a C++11 raw string literal (R"delim(...)delim"). We must match the [ds]
            // exact closing sequence '" + delimiter + "' rather than just any quote, otherwise [ds]
            // embedded quotes inside the raw string would incorrectly terminate it. [ds]
            if (inCppRawString) {
                if (line.slice(j, j + 2 + cppRawDelimiter.length) === ')' + cppRawDelimiter + '"') {
                    inCppRawString = false;
                    j += 2 + cppRawDelimiter.length;
                    continue;
                }
                j++;
                continue;
            }
            // Inside a JS regex literal. Detecting the closing '/' is tricky because a [ds]
            // backslash escape sequence like \/ must not terminate the regex; count [ds]
            // preceding consecutive backslashes and only close on an odd/even boundary. [ds]
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
            // Inside an HTML/XML block comment <!-- ... -->. Only '-->' ends it; everything [ds]
            // else (including quotes and slashes) is literal text. [ds]
            if (inBlockHTML) {
                if (line.slice(j, j + 3) === '-->') {
                    inBlockHTML = false;
                    j += 3;
                    continue;
                }
                j++;
                continue;
            }
            // Only attempt to recognize comment starts when we are NOT already inside any [ds]
            // string context; otherwise a '//' inside a string would be treated as a comment. [ds]
            // Check if comment starts (skip processing quotes if we are entering a comment)
            if (!inSingle && !inDouble && !inBacktick && !inTripleSingle && !inTripleDouble) {
                // Python uses '#' for line comments; everything after it on the line is ignored, [ds]
                // so we can short-circuit the rest of the character scan with 'break'. [ds]
                if (isPython) {
                    if (line[j] === '#') {
                        break; // Ignore rest of line
                    }
                // HTML-family files (.html/.vue/.svelte) can contain three comment syntaxes: [ds]
                // HTML comments, JS block comments (inside <script>), and JS line comments. [ds]
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
                // Default path: C-family / JS-family / other languages whose line comment is '//'. [ds]
                // Shell and Ruby are the notable exceptions that use '#' like Python. [ds]
                } else {
                    const isShellOrRuby = ['.sh', '.rb'].includes(ext.toLowerCase());
                    if (isShellOrRuby) {
                        if (line[j] === '#') {
                            break; // Ignore rest of line
                        }
                    // Standard C-style / JS-style line and block comments for the default branch. [ds]
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
                        // PHP supports '#' line comments in addition to '//' and '/* */'. [ds]
                        if (ext.toLowerCase() === '.php' && line[j] === '#') {
                            break; // Ignore rest of line
                        }
                        // Detect C++11 raw string literal opener: R"<optional-delim>(... [ds]
                        // The delimiter may be up to 16 chars and must not contain whitespace, parens, [ds]
                        // or backslashes per the C++ standard. We capture it so we can match the close. [ds]
                        if (isCpp && line[j] === 'R' && line[j+1] === '"') {
                            const match = line.slice(j).match(/^R"([^()\\\s]{0,16})\(/);
                            if (match) {
                                cppRawDelimiter = match[1];
                                inCppRawString = true;
                                j += match[0].length;
                                continue;
                            }
                        }
                        // Disambiguate '/' as division vs. regex literal in JS/TS. A regex can only [ds]
                        // start where a value is expected (after operators, '(', '[', ',', etc.), [ds]
                        // whereas after an identifier or ')' '/' is division. The heuristic: look back [ds]
                        // past whitespace; if the previous non-space char is a value-expecting token or [ds]
                        // a keyword like 'return'/'typeof', treat it as a regex start. [ds]
                        if (isJS && line[j] === '/') {
                            let k = j - 1;
                            // Skip trailing whitespace so the heuristic sees the last meaningful character. [ds]
                            while (k >= 0 && /\s/.test(line[k])) k--;
                            let isRegex = false;
                            // A '/' at column 0 means we are at the start of a statement, so it must be a regex. [ds]
                            if (k < 0) {
                                isRegex = true;
                            } else {
                                const prevChar = line[k];
                                if (/[=({\[:,;!+*&|?<>-]/.test(prevChar)) {
                                    isRegex = true;
                                } else {
                                    const prefix = line.slice(0, k + 1);
                                    // Keywords that syntactically demand an expression as their next token, so a [ds]
                                    // following '/' begins a regex rather than acting as division. [ds]
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
            // Python triple-quoted strings. We only toggle when not already inside a single- [ds]
            // or double-quoted string, so ' """ ' inside '...' is not misinterpreted. [ds]
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
            // Backtick template literals exist in JS/TS and several other languages, but [ds]
            // NOT in Python. Track them across lines (template strings may span newlines). [ds]
            if (!inTripleSingle && !inTripleDouble) {
                if (!isPython) {
                    if (!inSingle && !inDouble) {
                        // Count preceding backslashes to determine if this backtick is escaped; [ds]
                        // an escaped backtick does not toggle the template-literal state. [ds]
                        if (line[j] === '`') {
                        // Count consecutive preceding backslashes to determine whether this backtick is escaped. An even count means unescaped. [ds]
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
                // Quote characters inside a backtick template literal must not toggle string state. [ds]
                if (!inBacktick) {
                    // Only toggle double-quote state if we aren't currently inside a single-quoted string, preventing cross-context toggling. [ds]
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
                    // Mirror of double-quote handling: single quote toggling is blocked while inside a double-quoted string. [ds]
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
        // Many C-family and JS-family languages terminate strings at EOL (unterminated string literals are errors), so reset quote-state to avoid leaking state across lines. [ds]
        const resetsAtLineEnd = ['.js', '.jsx', '.ts', '.tsx', '.java', '.c', '.cpp', '.cs', '.go', '.swift', '.kt', '.dart'].includes(ext.toLowerCase());
        if (resetsAtLineEnd) {
            inSingle = false;
            inDouble = false;
            inRegex = false;
        }
    }
    return inBacktick || inTripleDouble || inTripleSingle || inSingle || inDouble || inCppRawString || inRegex;
}

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
        // Index within current line where a line-comment (// or #) begins; -1 means none found yet. [ds]
        let commentStartIndex = -1;
        // Snapshot whether we entered this line already inside a block comment so we can skip scanning content until the block terminates. [ds]
        let isInsideBlockStart = inBlockJS || inBlockHTML;
        let j = 0;
        while (j < line.length) {
            if (inBlockJS) {
                // Rust and Swift support nested /* */ block comments, so track depth instead of a simple boolean. [ds]
                if (line.slice(j, j + 2) === '/*') {
                    if (isRustOrSwift) blockDepthJS++;
                    j += 2;
                    continue;
                }
                // For nested-comment languages only close a level if more than one depth remains; otherwise exit block-comment mode entirely. [ds]
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
                // C++ raw string literals terminate with )"delimiter", where delimiter can be empty or up to 16 chars. [ds]
                if (line.slice(j, j + 2 + cppRawDelimiter.length) === ')' + cppRawDelimiter + '"') {
                    inCppRawString = false;
                    j += 2 + cppRawDelimiter.length;
                    continue;
                }
                j++;
                continue;
            }
            // Regex mode: scan forward until an unescaped closing '/' terminates the regex literal. [ds]
            if (inRegex) {
                // Backslash-parity check ensures \/ inside a regex does not prematurely close it. [ds]
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
            // HTML comments can only end with the literal --> sequence; scan past everything else. [ds]
            if (inBlockHTML) {
                if (line.slice(j, j + 3) === '-->') {
                    inBlockHTML = false;
                    j += 3;
                    continue;
                }
                j++;
                continue;
            }
            // Comment markers are only meaningful outside all string/regex/template/block contexts. [ds]
            if (!inSingle && !inDouble && !inBacktick && !inTripleSingle && !inTripleDouble) {
                if (isPython) {
                    if (line[j] === '#') {
                        commentStartIndex = j;
                        break;
                    }
                } else if (isHTML) {
                    // In HTML-like files, <!-- opens a block comment whose terminator is -->. [ds]
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
                    // Shell and Ruby share Python's '#' line-comment convention but are not Python. [ds]
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
                        // PHP also supports '#' line comments in addition to // and /* */. [ds]
                        if (ext.toLowerCase() === '.php' && line[j] === '#') {
                            commentStartIndex = j;
                            break;
                        }
                        // C++11 raw string literal start: R"delim(...)". Delimiter must be 0-16 chars and cannot contain whitespace, parens, or backslash. [ds]
                        if (isCpp && line[j] === 'R' && line[j+1] === '"') {
                            const match = line.slice(j).match(/^R"([^()\\\s]{0,16})\(/);
                            if (match) {
                                cppRawDelimiter = match[1];
                                inCppRawString = true;
                                j += match[0].length;
                                continue;
                            }
                        }
                        // Disambiguate a lone '/' between a regex literal and a division operator based on preceding tokens. [ds]
                        if (isJS && line[j] === '/') {
                            // Walk backwards past whitespace to find the last significant character before the '/' so we can apply the regex-context heuristic. [ds]
                            let k = j - 1;
                            // Walk backwards over whitespace to find the last significant character before the '/'. [ds]
                            while (k >= 0 && /\s/.test(line[k])) k--;
                            let isRegex = false;
                            // At start of line, a leading '/' can only be a regex since no left operand exists for division. [ds]
                            if (k < 0) {
                                isRegex = true;
                            } else {
                                const prevChar = line[k];
                                // After these punctuation/keyword contexts, '/' begins a regex literal rather than a division. [ds]
                                if (/[=({\[:,;!+*&|?<>-]/.test(prevChar)) {
                                    isRegex = true;
                                } else {
                                    const prefix = line.slice(0, k + 1);
                                    // Regex is implied when '/' follows a keyword like return/typeof/yield/await/throw. [ds]
                                    if (/(?:return|typeof|yield|await|throw)\s*$/.test(prefix)) {
                                        isRegex = true;
                                    }
                                }
                            }
                            // Enter regex mode and skip past the opening '/'; the regex body is consumed by a separate state machine, so we don't scan its contents for string/comment delimiters. [ds]
                            if (isRegex) {
                                inRegex = true;
                                j++;
                                continue;
                            }
                        }
                    }
                }
            }
            // Python-specific triple-quote handling: triple-quoted strings behave like block strings and may span multiple lines. Only toggle triple-quote state when we are not already inside a single/double/quoted context to avoid misinterpreting inner quotes. [ds]
            if (isPython) {
                // Guard so that """ inside a '...' or "..." or opposite triple-quote isn't seen as a delimiter. [ds]
                if (!inTripleSingle && !inSingle && !inDouble) {
                    // Detect the opening/closing triple-double-quote sequence at the current position. [ds]
                    if (line.slice(j, j + 3) === '"""') {
                        // Toggle triple-double-quote state; using toggle (not set-to-true) allows the same check to close an active block. [ds]
                        inTripleDouble = !inTripleDouble;
                        // Advance j by 3 to consume the entire delimiter; the state machine's main loop also advances j, so using continue prevents double advancement. [ds]
                        j += 3;
                        continue;
                    }
                }
                // Symmetric handling for Python triple-single-quoted strings. [ds]
                if (!inTripleDouble && !inSingle && !inDouble) {
                    if (line.slice(j, j + 3) === "'''") {
                        inTripleSingle = !inTripleSingle;
                        j += 3;
                        continue;
                    }
                }
            }
            // Only process ordinary quote/backtick toggles when we are not inside a Python triple-quoted block; otherwise quote characters are content, not delimiters. [ds]
            if (!inTripleSingle && !inTripleDouble) {
                // Backtick template literals are a JavaScript feature; skip this branch for Python, which has no backtick strings. [ds]
                if (!isPython) {
                    if (!inSingle && !inDouble) {
                        // Backtick handling: count consecutive preceding backslashes to determine if this backtick is escaped. An odd count means the backtick is escaped and must not toggle template-literal state. [ds]
                        if (line[j] === '`') {
                        let escaped = false;
                        let k = j - 1;
                        // Walk backwards over contiguous backslashes; toggling 'escaped' for each one determines parity (odd => escaped). [ds]
                        while (k >= 0 && line[k] === '\\') {
                            escaped = !escaped;
                            k--;
                        }
                        // Only toggle inBacktick when the backtick is not escaped; escaped backticks are literal content. [ds]
                        if (!escaped) {
                            inBacktick = !inBacktick;
                        }
                    }
                }
                }
                // Inside a template literal, single/double quotes are ordinary content, so skip toggle logic for them there. [ds]
                if (!inBacktick) {
                    // For a double-quote, require that we are not currently inside a single-quoted string, then verify it is not escaped via backslash-parity to flip inDouble. [ds]
                    if (line[j] === '"' && !inSingle) {
                        // Parity scan: alternate 'escaped' for each preceding '" so an odd number means the quote is escaped. [ds]
                        let escaped = false;
                        let k = j - 1;
                        while (k >= 0 && line[k] === '\\') {
                            escaped = !escaped;
                            k--;
                        }
                        // Unescaped double quote toggles string state; this handles both opening and closing quotes uniformly. [ds]
                        if (!escaped) {
                            inDouble = !inDouble;
                        }
                    }
                    // Mirror the double-quote logic for single quotes; mutually exclusive with inDouble to avoid cross-nesting errors. [ds]
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
        // Certain languages (C-family, JS/TS, Java, Go, etc.) do not allow single/double quotes to span lines; reset per-line string and regex tracking at end of line so an unterminated quote doesn't leak state into the next line. [ds]
        const resetsAtLineEnd = ['.js', '.jsx', '.ts', '.tsx', '.java', '.c', '.cpp', '.cs', '.go', '.swift', '.kt', '.dart'].includes(ext.toLowerCase());
        if (resetsAtLineEnd) {
            inSingle = false;
            inDouble = false;
            inRegex = false;
        }
        // A line is considered 'entirely inside a block' if we entered the block on this line and remained in it (inBlockJS/inBlockHTML) OR the line had no comment start at all (commentStartIndex === -1). The latter catches lines fully inside a multi-line construct without an explicit delimiter. [ds]
        const isEntirelyInsideBlock = isInsideBlockStart && (inBlockJS || inBlockHTML || (commentStartIndex === -1));
        let isPureComment = false;
        // When the entire line is within a comment block, it qualifies as a pure comment regardless of trailing text. [ds]
        if (isEntirelyInsideBlock) {
            isPureComment = true;
        // Otherwise, if a comment delimiter exists on this line, only treat it as a pure comment when everything before the delimiter is whitespace (nothing but the comment on the line). [ds]
        } else if (commentStartIndex !== -1) {
            const beforeComment = line.slice(0, commentStartIndex).trim();
            if (beforeComment === '') {
                isPureComment = true;
            }
        // Blank lines are considered pure comments so that clean/prune modes may optionally remove them alongside comment-only lines. [ds]
        } else if (line.trim() === '') {
            isPureComment = true;
        }
        // Record per-line analysis results consumed by spliceComments: pureComment flag, index where a comment begins, and whether the line is part of a multi-line comment block (either already inside one, or starts one). [ds]
        analysis.push({
            isPureComment,
            commentStartIndex,
            isInsideBlock: isEntirelyInsideBlock || isInsideBlockStart
        });
    }
    return analysis;
}

function spliceComments(data, comments, mode = 'default', ext = '') {
    const hasCRLF = data.includes('\r\n');
    const lineEnding = hasCRLF ? '\r\n' : '\n';
    const originalLines = data.split(/\r?\n/);
    // Sort comments in descending line order so deletions/insertions from the end of the file don't invalidate line indices of earlier edits. [ds]
    const sortedComments = [...comments].sort((a, b) => b.line - a.line);
    // Filter out comments whose line numbers fall outside the valid range for this file to avoid off-by-one corruption or out-of-bounds indexing. [ds]
    const validComments = sortedComments.filter(c => c.line >= 1 && c.line <= originalLines.length + 1);

    // Wrap each original line with its original index so positional metadata is retained even after text is mutated in the annotated array. [ds]
    const annotated = originalLines.map((text, index) => ({ text, originalIndex: index }));
    let analysis = null;
    let dsBlocks = new Set();

    // In 'clean' and 'prune' modes we need per-line analysis (comment/interpreter-state) to decide what to strip and preserve. [ds]
    if (mode === 'clean' || mode === 'prune') {
        analysis = analyzeComments(originalLines, ext);
        // Set of line numbers that will be deleted from the final output. [ds]
        const finalDeletions = new Set();
        // In 'clean' mode, first identify contiguous comment blocks. Any block containing a [ds] marker is protected (treated as a documentation block) and recorded in dsBlocks so those lines are removed together with any attached pure-comment lines before/after. [ds]
        if (mode === 'clean') {
            let i = 0;
            while (i < originalLines.length) {
                // Detect the start of a contiguous isInsideBlock run; scan forward to find its extent, then include the line immediately preceding the block (if any) so that surrounding comment noise is removed as a unit. [ds]
                if (analysis[i].isInsideBlock) {
                    let start = i;
                    let end = i;
                    while (end < originalLines.length && analysis[end].isInsideBlock) end++;
                    // blockStart falls back to 0 when the block starts at the top of the file. [ds]
                    let blockStart = Math.max(0, start - 1);
                    let blockEnd = end - 1;
                    let hasDs = false;
                    for (let k = blockStart; k <= blockEnd; k++) {
                        // Check whether any line in the candidate block carries the [ds] documentation marker. [ds]
                        if (originalLines[k].includes('[ds]')) hasDs = true;
                    }
                    if (hasDs) {
                        // Mark all lines in the block (1-indexed for comparison with lineNum later) as deletion targets. [ds]
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

            // Preserve shebang lines ('#!...') in all modes; they are interpreter directives, not comments. [ds]
            if (lineStr.trim().startsWith('#!')) {
                continue;
            }

            // 'prune' mode: remove comment-only lines entirely and strip inline comments from code lines. For pure comment lines, add to deletions; for inline, trim or slice out the trailing comment while retaining code on the left. [ds]
            if (mode === 'prune') {
                if (lineAnalysis.isPureComment) {
                    finalDeletions.add(lineNum);
                } else if (lineAnalysis.commentStartIndex !== -1) {
                    const idx = lineAnalysis.commentStartIndex;
                    const remainder = lineStr.slice(idx);
                    let newText = lineStr.slice(0, idx).trimEnd();
                    
                    // Block comment ('/* ... */') spanning: if the terminator appears on the same line, rebuild the line by concatenating the preserved prefix with whatever follows the closing '*/'. Otherwise the line is left for subsequent iterations to handle. [ds]
                    if (remainder.startsWith('/*')) {
                        const endIdx = remainder.indexOf('*/');
                        if (endIdx !== -1) {
                            newText = lineStr.slice(0, idx) + remainder.slice(endIdx + 2);
                        }
                    // Symmetric handling for HTML comments '<!-- ... -->' so inline HTML-comment trailing portions are stripped when the terminator is present. [ds]
                    } else if (remainder.startsWith('<!--')) {
                        const endIdx = remainder.indexOf('-->');
                        if (endIdx !== -1) {
                            newText = lineStr.slice(0, idx) + remainder.slice(endIdx + 3);
                        }
                    }
                    
                    annotated[i].text = newText.trimEnd();
                }
            // 'clean' mode: selectively remove lines associated with [ds]-marked blocks (plus their attached comment header/footer). Non-ds pure comments are preserved as ordinary comments; only ds-blocks and their immediate contextual comment lines are removed. [ds]
            } else if (mode === 'clean') {
                const isDsBlockLine = dsBlocks.has(lineNum);
                const hasDsInline = lineStr.includes('[ds]');

                // Only delete pure-comment lines when they are part of a [ds] block or contain an inline [ds] marker; other comments survive the clean operation. [ds]
                if (lineAnalysis.isPureComment) {
                    if (isDsBlockLine || hasDsInline) {
                        finalDeletions.add(lineNum);
                    }
                // For code lines containing a comment that is either inside a [ds] block or carries an inline [ds] marker: strip the [ds] block-comment portion from the line but keep the executable code that precedes it. [ds]
                } else if (lineAnalysis.commentStartIndex !== -1) {
                    if (isDsBlockLine || hasDsInline) {
                        const idx = lineAnalysis.commentStartIndex;
                        const remainder = lineStr.slice(idx);
                        let newText = lineStr.slice(0, idx).trimEnd();
                        
                        // For C-style block comments, preserve any trailing code after `*/` (e.g. `foo(); /* x */ bar();`) by keeping the tail segment rather than a naive line-suffix drop. [ds]
                        if (remainder.startsWith('/*')) {
                            const endIdx = remainder.indexOf('*/');
                            if (endIdx !== -1) {
                                newText = lineStr.slice(0, idx) + remainder.slice(endIdx + 2);
                            }
                        // Same preservation for HTML comments: keep code that appears after the closing `-->` token on the same line. [ds]
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


        // Collected deletions from prune/clean passes are applied by iterating the original (1-based) line numbers; guard the index to avoid off-by-one or out-of-range splices on malformed files. [ds]
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
            // Shebang lines must never be removed even if misclassified as comments — doing so would break executable scripts. [ds]
            if (trimmedLine.startsWith('#!')) {
                continue;
            }

            // Last-line-of-defense safety heuristic: a line is only deletable if it truly looks like a comment in any supported syntax (or is blank). This guards against a bug elsewhere in the analyzer causing real code to be silently dropped. [ds]
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

            // If the safety heuristic says the line is NOT a comment, refuse to delete it and warn — preferring corrupted output over destroying source code. [ds]
            if (!isCommentLine) {
                console.warn(`[devsplain] Safety Block: Refused to delete non-comment line ${lineNum}: "${trimmedLine}"`);
                continue;
            }

            annotated.splice(lineNum - 1, 1);
        }
    // ANNOTATE MODE: insert the supplied comments before their target lines. Unlike prune/clean this pass never removes any original content. [ds]
    } else {
        for (const c of validComments) {
            // Avoid corrupting string literals: if the target line number falls inside a multi-line string (or contains the insertion point within a string), skip the insert entirely. [ds]
            if (isLineInsideString(originalLines, c.line - 1, ext)) {
                console.warn(`[devsplain] Skipping comment insertion at line ${c.line} to avoid string literal corruption.`);
                continue;
            }

            const targetLine = originalLines[c.line - 1] || '';
            // Extract the leading whitespace of the target line so inserted comments visually align with the code they describe. [ds]
            const indentMatch = targetLine.match(/^([ \t]*)/);
            const indentation = indentMatch ? indentMatch[1] : '';

            // Split multi-line comment bodies and normalize each line. `[ds]` markers are appended so that a subsequent `clean` pass can identify and remove exactly these lines — important because the marker placement differs by comment style (single-line vs block) and must not pollute the closing tokens of block comments. [ds]
            const commentLines = c.comment.split(/\r?\n/).map((line, idx) => {
                let trimmed = line.trimStart();
                if (!trimmed) return '';

                // Single-line comment styles (//, #, --) always get the marker appended at end-of-line. [ds]
                const isSingleLine = trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('--');
                const isBlockEnd = trimmed.endsWith('*/') || trimmed.endsWith('-->');

                if (isSingleLine) {
                    trimmed = trimmed + ' [ds]';
                // For the very first line of a multi-line comment body: if it terminates on the same line (a self-contained block comment) inject the marker just before the terminator; otherwise append at end so the marker sits between the opener and the body. [ds]
                } else if (idx === 0) {
                    if (isBlockEnd) {
                        trimmed = trimmed.replace(/(\*\/|-->)$/, '[ds] $1');
                    } else {
                        trimmed = trimmed + ' [ds]';
                    }
                }

                // JSDoc-style continuation lines begin with `*` — add a single space before the `*` so nested `/*` characters don't accidentally form a premature block-comment terminator when the comment is re-emitted. [ds]
                if (trimmed.startsWith('*') && !trimmed.startsWith('*/') && !trimmed.startsWith('/*')) {
                    return indentation + ' ' + trimmed;
                }
                return indentation + trimmed;
            });

            // Mark inserted lines with originalIndex -1 so downstream passes can distinguish authored lines from injected comments when reconstructing the original view. [ds]
            const commentObjects = commentLines.map(line => ({ text: line, originalIndex: -1 }));
            annotated.splice(c.line - 1, 0, ...commentObjects);
        }
    }

    const filtered = annotated.filter(line => line.originalIndex !== -1);
    const filteredText = filtered.map(line => line.text);
    const filteredIndices = filtered.map(line => line.originalIndex);

    // Safety assertion #1: every inserted line must be a recognisable comment. Track block-open state so that multi-line block comments (whose interior lines don't individually begin with `/*`) are permitted. [ds]
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
        // If any inserted line is not a comment token, abort loudly — the caller (e.g. a model) attempted to inject real code, which would silently execute. [ds]
        if (!isValidComment) {
            throw new Error(`Safety Assertion Failed: Refused to insert non-comment code: "${trimmed}"`);
        }
        // Enter block-comment state when opening tokens lack their matching close on the same line, so follow-up lines are treated as comment content rather than rejected. [ds]
        if ((trimmed.startsWith('/*') && !trimmed.includes('*/')) || (trimmed.startsWith('<!--') && !trimmed.includes('-->'))) {
            inInsertedBlock = true;
        }
    }

    // Safety assertion #2 (text equality): after prune/clean, every surviving original line must still match either its original text or the expected stripped text. This catches any accidental over-deletion that the per-line filters missed. [ds]
    const textEqual = filteredText.every((text, idx) => {
        const origIdx = filteredIndices[idx];
        const originalLine = originalLines[origIdx];
        if (text === originalLine) {
            return true;
        }
        // Only prune/clean with valid analysis has a defined 'expected stripped' form; annotate mode leaves comments untouched so no drift is expected. [ds]
        if ((mode === 'clean' || mode === 'prune') && analysis) {
            const lineAnalysis = analysis[origIdx];
            // Only lines that had a trailing (non-pure) comment are candidates for having been stripped; pure-comment lines are handled by deletion, not rewriting. [ds]
            if (lineAnalysis && lineAnalysis.commentStartIndex !== -1 && !lineAnalysis.isPureComment) {
                const isDsBlockLine = dsBlocks.has(origIdx + 1);
                const hasDsInline = originalLine.includes('[ds]');
                // Prune strips all trailing comments; clean only strips ds-tagged ones. Mirror the earlier logic exactly to compute the expected post-strip text. [ds]
                if (mode === 'prune' || (mode === 'clean' && (hasDsInline || isDsBlockLine))) {
                    const idx = lineAnalysis.commentStartIndex;
                    const remainder = originalLine.slice(idx);
                    let expectedStripped = originalLine.slice(0, idx).trimEnd();
                    
                    // Reapply the same block-comment tail-preservation logic used during stripping so the comparison is apples-to-apples. [ds]
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

    // Safety assertion #3 (ordering): surviving original lines must still appear in strictly increasing order. Duplicates or reorderings would mean a splice landed in the wrong place and silently corrupted the file's semantics. [ds]
    let indicesSequential = true;
    for (let i = 1; i < filteredIndices.length; i++) {
        // Use <= rather than < because equal consecutive indices indicate two comment ranges collapsed onto the same offset -- a sign of overlapping match spans that would corrupt output. [ds]
        if (filteredIndices[i] <= filteredIndices[i - 1]) {
            indicesSequential = false;
            break;
        }
    }

    // Fail hard if either invariant broke — better a loud crash than shipping a file with mangled code. [ds]
    if (!textEqual || !indicesSequential) {
        throw new Error("Safety Assertion Failed: Spliced code does not match original code minus comments!");
    }

    return annotated.map(line => line.text).join(lineEnding);
}

/** [ds]
 * Main CLI entry point orchestrating argument parsing, provider/model resolution, and file traversal setup.
 * Flow: initialize readline -> short-circuit for --help/--version/--config/--setup-hook/--remove-hook (all early-exit)
 * -> parse positional filepath skipping option values -> validate path exists -> resolve mode flags from argv
 * -> gate on Git dirty-tree safety (skipped in tests or when --dry-run/--force) -> merge stored config with CLI overrides
 * -> load ignore patterns (defaults + user .devsplainignore) -> define recursive collectors/processors -> dispatch.
 * Ordering matters: early exits happen before config load and before dirty-tree check so that informational
 * commands (--help, --version) never require a clean repo or valid config.
*/
async function runCLI() {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

    const args = process.argv.slice(2);

    // --help/-h short-circuit: prints usage and exits with 0 BEFORE config load, dirty-tree check, or path validation, so help always works in any repo state. [ds]
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
  --config            Force run the configuration setup wizard
  --setup-hook        Install Git pre-commit and post-commit hooks in repository
  --remove-hook       Remove devsplain-installed Git hooks from repository
  --help, -h          Show this help message
  --version, -v       Show version information
`);
        rl.close();
        process.exit(0);
    }

    // --version/-v short-circuit: resolves version from package.json at runtime (not a static constant) so published version stays authoritative. [ds]
    if (args.includes('--version') || args.includes('-v')) {
        const pkg = require('../package.json');
        console.log(`devsplain v${pkg.version}`);
        rl.close();
        process.exit(0);
    }

    // --config forces the interactive setup wizard by passing true to getConfig, bypassing the "already configured" short-circuit. rl is closed first so the wizard can open its own stdin reader without conflict. [ds]
    if (args.includes('--config')) {
        rl.close();
        await getConfig(true);
        console.log("Success: Configuration updated successfully!");
        process.exit(0);
    }

    // --setup-hook lazily requires setup-hook.js and RETURNS (not process.exit) so the Node event loop can finish any pending async work scheduled by installHooks. Closing rl first avoids a dangling stdin handle keeping the process alive. [ds]
    if (args.includes('--setup-hook')) {
        rl.close();
        const { installHooks } = require('./setup-hook.js');
        await installHooks();
        return;
    }

    // --remove-hook mirrors --setup-hook: lazy require so hook utilities are only loaded when the flag is used, then early return to preserve process lifetime handoff to async hook code. [ds]
    if (args.includes('--remove-hook')) {
        rl.close();
        const { removeHooks } = require('./setup-hook.js');
        await removeHooks();
        return;
    }

    /** [ds]
     * Extracts the value following a named flag from argv.
     * Returns null (not undefined) when the flag is absent OR when it is the last argument with no value.
     * The bounds check `index + 1 < args.length` prevents returning undefined or reading past the array,
     * which matters because callers compare against null and fall back to defaults.
    */
    const getArgValue = (flag) => {
        const index = args.indexOf(flag);
        if (index !== -1 && index + 1 < args.length) {
            return args[index + 1];
        }
        return null;
    };

    // Positional-argument parser: walks argv and picks the FIRST non-flag token as filepath, while SKIPPING the value that follows any known value-taking flag. Options can also appear AFTER the positional path, so once filepath is locked in we break to avoid later tokens (which could be stray values) overriding it. Unknown --flags are treated as boolean and do not consume a following token. [ds]
    let filepath = '.';
    const flagKeys = ['--provider', '--model', '--api-key', '--base-url', '--concurrency'];
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

    // Fail fast on missing paths with exit(1) BEFORE spending time on config load or Git checks — avoids confusing downstream errors when the target simply doesn't exist. [ds]
    if (!fs.existsSync(filepath)) {
        console.log(`Error: The path '${filepath}' does not exist.`);
        rl.close();
        process.exit(1);
    }

    // Mode precedence: last-wins by evaluation order, so --prune beats --clean, which beats --full, which beats --light. Default mode is null (no special comment strategy). [ds]
    let mode = 'default';
    if (args.includes('--light')) mode = 'light';
    if (args.includes('--full')) mode = 'full';
    if (args.includes('--clean')) mode = 'clean';
    if (args.includes('--prune')) mode = 'prune';
    const isDryRun = args.includes('--dry-run');
    const isForce = args.includes('--force');
    const hasOverwriteFlag = args.includes('--overwrite');
    const hasKeepFlag = args.includes('--keep');

    // Git dirty-tree gate: skipped in NODE_ENV=test (so CI unit tests don't need a git repo), during --dry-run (no writes occur, so dirty state is harmless), and when --force is supplied. Prevents accidental loss of uncommitted work if the tool rewrites files. [ds]
    if (process.env.NODE_ENV !== 'test' && isGitDirty() && !isForce && !isDryRun) {
        console.error("Error: Git working tree is dirty. Please commit or stash your changes, or use --force to bypass this check.");
        rl.close();
        process.exit(1);
    }

    // Config is loaded AFTER the dirty-tree check to avoid prompting the user / reading disk when we are about to abort anyway. [ds]
    const config = await getConfig();

    const cliProvider = getArgValue('--provider');
    const cliModel = getArgValue('--model');
    const cliApiKey = getArgValue('--api-key');
    const cliBaseUrl = getArgValue('--base-url');

    // CLI provider override block: when a provider is specified, we must also backfill any unspecified model/baseUrl using provider-specific defaults, otherwise a blank model would reach the API client. Note the nested ternaries deliberately do NOT override cliModel/cliBaseUrl if those were given, so the user's explicit choices take precedence. [ds]
    if (cliProvider) {
        config.provider = cliProvider;
        if (!cliModel) {
            // Provider-specific default model map. Gemini uses a custom baseUrl (null means the provider SDK has its own endpoint). Claude deepseek/openai/groq all use OpenAI-compatible endpoints, but each has a distinct default host -- see the baseUrl ternary below. Fallback is groq's llama-3.3-70b-versatile because groq is the default provider when setup has not been run. [ds]
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

    // Overwrite semantics: file rewrite is allowed if user passed --overwrite OR config.autoPrune is on. --keep explicitly vetoes overwriting regardless of autoPrune, giving users a hard opt-out. [ds]
    const isOverwrite = (hasOverwriteFlag || config.autoPrune) && !hasKeepFlag;

    // Concurrency parsing guard: parseInt on a missing/null flag yields NaN. We clamp to [1,5] to prevent an unbounded fan-out to the AI API (which would trigger rate limits) and to avoid concurrency=0 silently serializing all work. Falls back to 2 — a conservative default that balances throughput and rate-limit safety. [ds]
    const cliConcurrency = parseInt(getArgValue('--concurrency'), 10);
    const concurrencyLevel = (cliConcurrency && cliConcurrency >= 1 && cliConcurrency <= 5) ? cliConcurrency : 2;

    // Load user ignore rules from .devsplainignore in cwd. Read errors are swallowed (empty catch) because a missing or unreadable ignore file should not abort the run — it just means no user-provided exclusions. Blank lines and #-prefixed comments are filtered out so patterns list contains only actionable globs. [ds]
    let userIgnorePatterns = [];
    try {
        const ignorePath = path.join(process.cwd(), '.devsplainignore');
        if (fs.existsSync(ignorePath)) {
            const ignoreContent = fs.readFileSync(ignorePath, 'utf8');
            userIgnorePatterns = ignoreContent.split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));
        }
    } catch(e) {}

    // Default exclusion list covers: package manager caches/node_modules, VCS internals, build artifacts across major frameworks, Python virtual envs, editor project metadata, coverage output, and test fixtures (which often contain intentionally broken/vulnerable code that should NOT be sent to an AI and rewritten). [ds]
    const defaultIgnoredFolders = [
        'node_modules', '.git', 'dist', 'build', 'out', 
        '.next', '.nuxt', '.svelte-kit', 
        'venv', 'env', '.venv',          
        '.vscode', '.idea', 'coverage',
        'tests', '__tests__', 'fixtures'
    ];
    const allIgnored = [...defaultIgnoredFolders, ...userIgnorePatterns];

    /** [ds]
     * Determines whether a path should be skipped during traversal.
     * Matches against three forms: (1) exact basename match (e.g. 'node_modules' anywhere in tree),
     * (2) exact relative-path match from cwd, and (3) prefix match with '/' appended so that
     * 'dist' matches 'dist/' but NOT 'distribution/'. Trailing slashes in user patterns are stripped
     * defensively since .devsplainignore authors commonly write 'build/' by habit.
     * Leading '*' patterns are treated as suffix matches on filename only (e.g. '*.min.js'), which is
     * sufficient for the common case without pulling in a full glob engine.
    */
    function isPathIgnored(targetPath) {
        const filename = path.basename(targetPath);
        // Normalize Windows backslashes to forward slashes so that patterns written in POSIX style (as in .gitignore conventions) match on Windows, where path.relative emits backslashes. [ds]
        const relPath = path.relative(process.cwd(), targetPath).replace(/\\/g, '/');
        for (const pattern of allIgnored) {
            // Strip trailing path separators (both forward and backslash) so that equality and prefix checks work regardless of whether the user/glob supplied a directory path with a trailing slash, avoiding false negatives when matching 'src/' against 'src'. [ds]
            const cleanPattern = pattern.replace(/\/$/, '').replace(/\\$/, '');
            // Match by exact filename OR exact relative path OR when relPath resides under the cleaned pattern directory. The trailing '/' in the startsWith check is crucial: it prevents 'src' from accidentally matching 'src2/foo.js' (prefix collision). [ds]
            if (filename === cleanPattern || relPath === cleanPattern || relPath.startsWith(cleanPattern + '/')) return true;
            // Glob heuristic: patterns like '*.test.js' should match by suffix on the filename only (not the full path), since wildcard prefix matching against path segments would incorrectly match files in subdirectories like 'foo/bar.test.js'. [ds]
            if (pattern.startsWith('*') && filename.endsWith(pattern.slice(1))) return true;
        }
        return false;
    }

    // Allow-list of file extensions across the major language ecosystems devsplain targets. Files outside this list (binaries, images, lockfiles, configs) are skipped because sending them to an AI commenter is meaningless and would waste tokens. [ds]
    const validExtensions = [
        '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.scss', '.vue', '.svelte',
        '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rb', '.php', '.rs', 
        '.swift', '.kt', '.dart', '.sh', '.sql'
    ];

    /** [ds]
     * Recursively walks `targetPath` and returns the list of files eligible for annotation.
     * Ignores paths flagged by isPathIgnored BEFORE stat'ing children (cheap short-circuit).
     * Directory branches recurse via collectFiles; file branches are filtered by extension allow-list.
     * Uses fs.statSync (not lstat) so symlinked files/dirs are followed, matching user expectation when
     * they symlink shared config into a repo.
    */
    function collectFiles(targetPath) {
        const collected = [];
        const stats = fs.statSync(targetPath);

        // Bail out before stat()/readdir() if the path itself is ignored — this is the primary pruning optimization for large trees containing vendor directories. [ds]
        if (isPathIgnored(targetPath)) return collected;

        // Directory branch: recurse into each child. Uses spread-push so the recursion order is preserved and the caller receives a single flattened array (callers rely on stable ordering for dry-run previews). [ds]
        if (stats.isDirectory()) {
            console.log(`\n Scanning directory: ${targetPath}`);
            const items = fs.readdirSync(targetPath);
            for (const item of items) {
                collected.push(...collectFiles(path.join(targetPath, item)));
            }
        } else if (stats.isFile()) {
            // Normalize extension to lowercase because filesystems on macOS/Windows may surface mixed-case extensions (e.g. '.JS') which would otherwise slip past the allowlist. [ds]
            const ext = path.extname(targetPath).toLowerCase();
            // Early-return for unsupported extensions rather than pushing then filtering later; keeps collected array semantics clean (only processable files) so downstream concurrency counters remain accurate. [ds]
            if (!validExtensions.includes(ext)) return collected;

            const data = fs.readFileSync(targetPath, 'utf-8');
            // Treat whitespace-only files (blank lines, BOM, stray newline) as empty — sending these to the LLM would produce meaningless results and skew the success/fail counters. [ds]
            if (data.trim() === '') {
                console.log(` Skipping ${path.basename(targetPath)} (Empty File)`);
                return collected;
            }
            collected.push(targetPath);
        }
        return collected;
    }

    /** [ds]
     * Orchestrates the full comment-splicing pipeline for a single file, including optional two-pass LLM invocation,
     * atomic writeback, and dry-run interactive confirmation.
     *
     * Two-pass rationale: when adding comments (mode not 'clean'/'prune'), the file is first stripped of any existing
     * comments (using 'prune' if overwriting, 'clean' otherwise) so the LLM sees pure code without its prior commentary
     * — this avoids the model echoing/duplicating old comments and prevents token waste. The freshly generated comments
     * are then spliced back into the cleaned source.
     *
     * Atomic write strategy: output is written to a sibling '.tmp' file and then renameSync'd over the original. On POSIX
     * filesystems rename() is atomic, so a crash mid-write cannot corrupt or truncate the user's source file.
    */
    async function processSingleFile(targetPath) {
        const filename = path.basename(targetPath);
        const ext = path.extname(targetPath).toLowerCase();
        const data = fs.readFileSync(targetPath, 'utf-8');

        console.log(` Analyzing ${filename} in ${mode} mode...`);
        try {
            let comments = [];
            let commentedCode;
            // Only the comment-adding modes need the two-pass flow; 'clean' and 'prune' operate directly on raw data since their whole purpose is to strip, not analyze. [ds]
            if (mode !== 'clean' && mode !== 'prune') {
                // When overwriting, existing comments in the file should be pruned (removed) rather than just cleaned of whitespace artifacts, ensuring re-runs are idempotent and don't accumulate stale comments. [ds]
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
                // Interactive dry-run gate: the user must explicitly type 'write' (case-insensitive) to commit changes. Any other input (including empty/Enter) is treated as a discard, which is the safe default for a preview that could otherwise overwrite source silently. [ds]
                const answer = await askQuestion("Type 'write' to save to file, or press any key to discard: ");
                // Only the exact token 'write' triggers persistence — prevents accidental commits from typos or partial matches. [ds]
                if (answer.toLowerCase() === 'write') {
                    // Write-then-rename atomic swap: the '.tmp' suffix must not collide with the user's real files; since it's appended to the exact target filename, if a user file actually ends in '.tmp' the rename will overwrite it — acceptable tradeoff given the low likelihood. [ds]
                    const tempPath = targetPath + '.tmp';
                    fs.writeFileSync(tempPath, commentedCode, 'utf8');
                    fs.renameSync(tempPath, targetPath);
                    console.log(` Successfully saved ${targetPath}`);
                } else {
                    console.log(` Skipped ${targetPath}`);
                }
            } else {
                // Non-dry-run path: unconditional atomic swap. If writeFileSync throws (e.g. permission denied, disk full), the original file is left untouched because renameSync is never reached, preserving user data. [ds]
                const tempPath = targetPath + '.tmp';
                fs.writeFileSync(tempPath, commentedCode, 'utf8');
                fs.renameSync(tempPath, targetPath);
                console.log(` Successfully commented ${targetPath}`);
            }
            successCount++;
        // Per-file try/catch isolates failures so a single unparseable file cannot abort the entire batch. Counters are updated here rather than in the caller to keep success/fail bookkeeping adjacent to the operation that produced the outcome. [ds]
        } catch (err) {
            console.error(` Error processing ${filename}: ${err.message}`);
            failCount++;
        }
    }

    // Materialize the file list once up-front (not lazily) so that the concurrency scheduler has a stable length and the dry-run loop can be driven by a finite iterator; also ensures directory scan errors surface before any processing begins. [ds]
    const filesToProcess = collectFiles(filepath);

    // Dry-run and stripping modes must be serialized: dry-run requires interactive prompts that would interleave confusingly under concurrency, and clean/prune mutate the same file twice (read then write) so parallel execution is unnecessary and would only add contention. [ds]
    if (isDryRun || mode === 'clean' || mode === 'prune') {
        for (const file of filesToProcess) {
            await processSingleFile(file);
        }
    } else {
        // Reset the shared concurrency semaphore before dispatch; without this, any state left by a previous run (e.g. when runCLI is invoked reentrantly in tests) would throttle or release the wrong number of slots. [ds]
        resetConcurrency(concurrencyLevel);
        console.log(`\n Processing ${filesToProcess.length} file(s) with concurrency: ${concurrencyLevel}`);
        await runWithConcurrency(filesToProcess, processSingleFile);
    }

    // Hard-fail when every attempted file failed: exit 1 signals to CI/scripts that the run was a no-op, which is more useful than silently 'succeeding' with zero output. [ds]
    if (failCount > 0 && successCount === 0) {
        console.error("\nFailed: No files were successfully commented.");
        rl.close();
        process.exit(1);
    }

    // Distinguish partial success from full success in the final message so users can spot regressions that only affect a subset of files (e.g. one syntax the parser can't handle). [ds]
    if (successCount > 0 && failCount > 0) {
        console.log(`\n All done! (Successfully commented: ${successCount}, Failed: ${failCount})`);
    } else {
        console.log("\n All done!");
    }
    rl.close();
}

// Dual-use module guard: when executed directly (node cli.js) run the CLI and translate any top-level rejection into a non-zero exit; when imported as a library, expose only the pure functions — the CLI surface (argument parsing, rl, process.exit) is deliberately not exported to keep the module side-effect free for consumers. [ds]
if (require.main === module) {
    runCLI().catch(err => {
        console.error(err);
        process.exit(1);
    });
} else {
    module.exports = { spliceComments, isLineInsideString };
}