#!/usr/bin/env node
/**
 * Requires the necessary modules for the script to run.
 * @requires ../lib/llm.js - provides the getComments function
 * @requires ../lib/config.js - provides the getConfig function
 * @requires fs - provides file system functionality
 */
const { getComments } = require('../lib/llm.js')
const { getConfig } = require('../lib/config.js')
const fs = require('fs');

/**
 * Retrieves the file path from the command line arguments.
 * @type {string}
 */
const filepath = process.argv[2]

/**
 * Checks if a file path was provided.
 * If not, it logs the usage message and exits the process.
 */
if (!filepath) {
    console.log("usage: commie <file>")
    process.exit(1)
}
else {
    /**
     * Defines an asynchronous function to comment the code in the provided file.
     * @async
     */
    (async () => {
        /**
         * Retrieves the configuration settings.
         * @type {object}
         */
        const config = await getConfig();
        
        /**
         * Reads the contents of the file at the provided file path.
         * @type {string}
         */
        const data = fs.readFileSync(filepath, 'utf-8');
        
        // Log a message to indicate that the file is being analyzed
        console.log("Analyzing File...");
        
        /**
         * Retrieves the commented code using the getComments function.
         * @type {string}
         */
        const commentedCode = await getComments(data, 'javascript', config)
        
        // Write the commented code back to the file
        fs.writeFileSync(filepath, commentedCode);
        
        // Log a success message with the file path
        console.log(`Successfully commented ${filepath}`);
    })();
}