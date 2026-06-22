const { spliceComments } = require('./bin/cli.js'); 
const cli = require('./bin/cli.js'); 
// Extract analyzeComments
/** Import file system module for reading the CLI source code [ds] */
const fs = require('fs');
const cliCode = fs.readFileSync('./bin/cli.js', 'utf8');
// Extract the target function dynamically from the source string to isolate analysis logic [ds]
const analyzeCode = cliCode.slice(cliCode.indexOf('function analyzeComments'), cliCode.indexOf('function spliceComments'));
// Evaluate the extracted code string into the current scope [ds]
eval(analyzeCode);

/** Mock data representing source code with a mix of manual and placeholder comments [ds] */
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

// Convert the joined string back into an array of lines for processing by the analyzer [ds]
const originalLines = commentedCode.split('\n');
// Run the extracted analysis function against the mock lines to test functionality [ds]
const analysis = analyzeComments(originalLines, '.js');
console.log(analysis);
