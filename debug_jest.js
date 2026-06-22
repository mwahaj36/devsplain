/** Import the comment manipulation utility from the CLI bin directory [ds] */
const { spliceComments } = require('./bin/cli.js'); 
/** Source code string containing various types of documentation and user comments to be processed [ds] */
const commentedCode = [
    '// User written comment', 
    'const fs = require("fs");', 
    '/** [ds]', 
    ' * Generated jsdoc', 
    ' */', 
    /** [ds]
     * Reads the content of file.txt
     * @returns {string} The content of the file
    */
    'function read() {', 
    '    // User logic comment', 
    '    // Generated inline [ds]', 
    '    return fs.readFileSync("file.txt", "utf8");', 
    '}'
].join('\n'); 

// Executes the spliceComments utility to process the provided code string and remove documentation tags [ds]
console.log(spliceComments(commentedCode, [], 'clean', '.js'));
