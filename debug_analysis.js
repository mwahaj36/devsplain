const { spliceComments } = require('./bin/cli.js'); 
const cli = require('./bin/cli.js'); 
// Extract analyzeComments
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
const analysis = analyzeComments(originalLines, '.js');
console.log(analysis);
