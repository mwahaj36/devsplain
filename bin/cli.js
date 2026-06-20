#!/usr/bin/env node

/**
 * Import required modules.
 * @module llm - Provides functionality for getting comments.
 * @module config - Provides functionality for getting configuration.
 * @module fs - Provides functionality for interacting with the file system.
 * @module path - Provides functionality for interacting with the file system paths.
 */
const { getComments } = require('../lib/llm.js');
const { getConfig } = require('../lib/config.js');
const fs = require('fs');
const path = require('path');

/**
 * Get the filepath from the command line arguments.
 * @type {string}
 * @description The filepath is the first command line argument.
 */
const filepath = process.argv[2];

/**
 * Get additional command line arguments.
 * @type {array}
 * @description These arguments may include mode flags.
 */
const args = process.argv.slice(3);

/**
 * Set the default mode.
 * @type {string}
 * @description The default mode is 'default', but it can be overridden by flags.
 */
let mode = 'default';

/**
 * Check for mode flags in the command line arguments and update the mode accordingly.
 */
if (args.includes('--light')) mode = 'light';
if (args.includes('--full')) mode = 'full';

/**
 * Check if a filepath was provided.
 * @throws {void} If no filepath is provided, print usage instructions and exit.
 */
if (!filepath) {
    console.log("usage: devsplain <file>");
    process.exit(1);
} else {
    /**
     * Main execution block.
     * @async
     * @description This block executes the main functionality of the script.
     */
    (async () => {
        /**
         * Get the configuration.
         * @type {object}
         * @description The configuration is retrieved from the getConfig function.
         */
        const config = await getConfig();
        const filename = path.basename(filepath);

        /**
         * Read the file at the specified filepath.
         * @type {string}
         * @description The file is read in UTF-8 format.
         */
        const data = fs.readFileSync(filepath, 'utf-8');
        if (data.trim() === '') {
        console.log("File is empty, skipping.");
        return;
}

        console.log(`Analyzing ${filename} in ${mode} mode...`);

        /**
         * Get comments for the code in the file.
         * @type {string}
         * @description The getComments function is called with the file data, filename, config, and mode.
         */
        const commentedCode = await getComments(data, filename, config, mode);

        /**
         * Write the commented code back to the file.
         * @description The commented code is written to the file in the same location as the original file.
         */
        fs.writeFileSync(filepath, commentedCode);

        console.log(`Successfully commented ${filepath}`);
    })();
}