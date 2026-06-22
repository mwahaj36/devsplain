const { spliceComments } = require('./bin/cli.js'); 
const fs = require('fs');
const cliCode = fs.readFileSync('./bin/cli.js', 'utf8');
const analyzeCode = cliCode.slice(cliCode.indexOf('function analyzeComments'), cliCode.indexOf('function spliceComments'));
eval(analyzeCode);

const commentedCode = [
    '// User written comment', 
    'const fs = require("fs");', 
    '/** [ds]', 
    ' * Generated jsdoc', 
    ' */', 
    'function read() {', 
    '    // User logic comment', 
    '    // Generated inline [ds]', 
    '    return fs.readFileSync("file.txt", "utf8");', 
    '}'
].join('\n'); 

const originalLines = commentedCode.split('\n');
const ext = '.js';
const analysis = analyzeComments(originalLines, ext);
let dsBlocks = new Set();
let finalDeletions = new Set();
const annotated = originalLines.map((text, index) => ({ text, originalIndex: index }));

            let i = 0;
            while (i < originalLines.length) {
                if (analysis[i].isInsideBlock) {
                    let start = i; // first line of body
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

console.log('dsBlocks:', dsBlocks);

        for (let i = 0; i < originalLines.length; i++) {
            const lineNum = i + 1;
            const lineStr = originalLines[i];
            const lineAnalysis = analysis[i];

            if (lineStr.trim().startsWith('#!')) {
                continue;
            }

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

        const linesToDelete = Array.from(finalDeletions).sort((a, b) => b - a);

        for (const lineNum of linesToDelete) {
            annotated.splice(lineNum - 1, 1);
        }

console.log(annotated.map(l => l.text).join('\n'));
