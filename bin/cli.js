#!/usr/bin/env node

/**
 * Import required modules.
 * @module llm
 * @module config
 * @module fs
 * @module path
 * @module readline
 */
const { getComments } = require('../lib/llm.js');
const { getConfig } = require('../lib/config.js');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

/**
 * Asks a question and returns the answer as a promise.
 * @param {string} query - The question to be asked.
 * @returns {Promise<string>} The answer to the question.
 */
const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

/**
 * Get the filepath and arguments from the command line.
 * @type {string}
 */
const filepath = process.argv[2];
const args = process.argv.slice(3);
let mode = 'default';

/**
 * Determine the mode based on the command line arguments.
 * Supported modes are: 'light', 'full', and 'clean'.
 */
if (args.includes('--light')) mode = 'light';
if (args.includes('--full')) mode = 'full';
if (args.includes('--clean')) mode = 'clean';
const isDryRun = args.includes('--dry-run');

/**
 * Check if a filepath was provided, if not display usage information.
 */
if (!filepath) {
    console.log("usage: devsplain <file-or-directory>");
    process.exit(1);
} 
else if (!fs.existsSync(filepath)) {
    console.log(`Error: The path '${filepath}' does not exist.`);
    process.exit(1);
} 
else {
    (async () => {
        /**
         * Get the configuration.
         * @type {object}
         */
        const config = await getConfig();

        /**
         * Process a path, either a file or directory.
         * @param {string} targetPath - The path to process.
         * @returns {Promise<void>}
         */
        async function processPath(targetPath) {
            /**
             * Get the stats of the target path.
             * @type {fs.Stats}
             */
            const stats = fs.statSync(targetPath);

            /**
             * If the target path is a directory, process its contents.
             */
            if (stats.isDirectory()) {
                const folderName = path.basename(targetPath);
                /**
                 * List of ignored folders.
                 * @type {string[]}
                 */
                const ignoredFolders = [
                    'node_modules', '.git', 'dist', 'build', 'out', 
                    '.next', '.nuxt', '.svelte-kit', 
                    'venv', 'env', '.venv',          
                    '.vscode', '.idea', 'coverage'   
                ];

                /**
                 * Check if the folder should be ignored.
                 */
                if (ignoredFolders.includes(folderName)) {
                    // Folder will be skipped
                    return;
                }

                console.log(`\n Scanning directory: ${targetPath}`);
                /**
                 * Read the contents of the directory.
                 * @type {string[]}
                 */
                const items = fs.readdirSync(targetPath);
                
                /**
                 * Process each item in the directory.
                 */
                for (const item of items) {
                    const fullPath = path.join(targetPath, item);
                    await processPath(fullPath); 
                }
            } 
            /**
             * If the target path is a file, process it.
             */
            else if (stats.isFile()) {
                /**
                 * Get the file extension.
                 * @type {string}
                 */
                const ext = path.extname(targetPath).toLowerCase();
                /**
                 * List of valid file extensions.
                 * @type {string[]}
                 */
                const validExtensions = [
                    '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.scss', '.vue', '.svelte',
                    '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rb', '.php', '.rs', 
                    '.swift', '.kt', '.dart', '.sh'
                ];

                /**
                 * Check if the file extension is valid.
                 */
                if (!validExtensions.includes(ext)) {
                    // File type is not supported, skipping
                    return;
                }

                const filename = path.basename(targetPath);
                /**
                 * Read the file contents.
                 * @type {string}
                 */
                const data = fs.readFileSync(targetPath, 'utf-8');
                
                /**
                 * Check if the file is empty.
                 */
                if (data.trim() === '') {
                    console.log(` Skipping ${filename} (Empty File)`);
                    return;
                }

                console.log(` Analyzing ${filename} in ${mode} mode...`);
                /**
                 * Get the commented code.
                 * @type {string}
                 */
                const commentedCode = await getComments(data, filename, config, mode);
                
                /**
                 * If in dry run mode, display a preview of the commented code.
                 */
                if (isDryRun) {
                    console.log(`\n --- DRY RUN PREVIEW: ${filename} ---`);
                    console.log(commentedCode);
                    console.log(`---------------------------------------\n`);
                    
                    /**
                     * Ask the user if they want to save the commented code.
                     */
                    const answer = await askQuestion("Type 'write' to save to file, or press any key to discard ");
                    
                    if (answer.toLowerCase() == 'write') {
                        fs.writeFileSync(targetPath, commentedCode);
                        console.log(` Successfully saved ${targetPath}`);
                    } else {
                        console.log(` Skipped ${targetPath}`);
                    }
                } else {
                    /**
                     * Write the commented code to the file.
                     */
                    fs.writeFileSync(targetPath, commentedCode);
                    console.log(` Successfully commented ${targetPath}`);
                }
            }
        }

        /**
         * Start processing the provided filepath.
         */
        await processPath(filepath);
        console.log("\n All done!");
    })();
}