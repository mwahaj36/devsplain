#!/usr/bin/env node

/**
 * Import required modules.
 * @module llm - Provides functionality for getting comments.
 * @module config - Provides functionality for getting configuration.
 * @module fs - Provides functionality for interacting with the file system.
 */
const { getComments } = require('../lib/llm.js');
const { getConfig } = require('../lib/config.js');
const fs = require('fs');

/**
 * Get the filepath from the command line arguments.
 * @type {string}
 */
const filepath = process.argv[2];

/**
 * Get additional command line arguments.
 * @type {array}
 */
const args = process.argv.slice(3);

/**
 * Set the default mode.
 * @type {string}
 */
let mode = 'default';

/**
 * Check for mode flags in the command line arguments and update the mode accordingly.
 */
if (args.includes('--light')) mode = 'light';
if (args.includes('--full')) mode = 'full';

/**
 * Check if a filepath was provided.
 */
if (!filepath) {
    console.log("usage: devsplain <file>");
    process.exit(1);
} else {
    /**
     * Main execution block.
     * @async
     */
    (async () => {
        /**
         * Get the configuration.
         * @type {object}
         */
        const config = await getConfig();

        /**
         * Read the file at the specified filepath.
         * @type {string}
         */
        const data = fs.readFileSync(filepath, 'utf-8');

        console.log("Analyzing File...");
        console.log(`Analyzing File in ${mode} mode...`);

        /**
         * Get comments for the code in the file.
         * @type {string}
         */
        const commentedCode = await getComments(data, 'javascript', config, mode);

        /**
         * Write the commented code back to the file.
         */
        fs.writeFileSync(filepath, commentedCode);

        console.log(`Successfully commented ${filepath}`);
    })();
}