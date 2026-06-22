const { spliceComments, isLineInsideString } = require('../../bin/cli.js');

/** Test suite for line-splicing engine and quote-tracking */
describe('Line-Splicing Engine & Quote-Tracking', () => {

    /** Test for single-line and multi-line comments */
    test('should splice single-line and multi-line comments correctly', () => {
        const originalCode = [
            'function greet(name) {',
            '    return "Hello " + name;',
            '}'
        ].join('\n');

        const comments = [
            { line: 1, comment: '/** Greet function JSDoc */' },
            { line: 2, comment: '// Return greeting' }
        ];

        // Splice comments into the original code
        const output = spliceComments(originalCode, comments);
        const expected = [
            '/** Greet function JSDoc */',
            'function greet(name) {',
            '    // Return greeting',
            '    return "Hello " + name;',
            '}'
        ].join('\n');

        expect(output).toBe(expected);
    });

    /** Test for matching indentation and aligning asterisks for JSDocs */
    test('should match indentation, aligning asterisks for JSDocs', () => {
        const originalCode = [
            'class User {',
            '    constructor() {',
            '\t\tthis.name = "";',
            '    }',
            '}'
        ].join('\n');

        const comments = [
            { 
                line: 2, 
                comment: '/**\n * Constructor for User\n * @constructor\n */' 
            },
            {
                line: 3,
                comment: '// Set default name'
            }
        ];

        // Splice comments into the original code with indentation
        const output = spliceComments(originalCode, comments);
        const expected = [
            'class User {',
            '    /**',
            '     * Constructor for User',
            '     * @constructor',
            '    */',
            '    constructor() {',
            '\t\t// Set default name',
            '\t\tthis.name = "";',
            '    }',
            '}'
        ].join('\n');

        expect(output).toBe(expected);
    });

    /** Test for not inserting comments inside multiline strings/template literals */
    test('should not insert comments inside multiline strings/template literals', () => {
        const originalCode = [
            'const html = `',
            '<div>',
            '    <h1>Hello</h1>',
            '</div>',
            '`;',
            'const x = 1;'
        ];

        // Check if a line is inside a multiline string
        expect(isLineInsideString(originalCode, 1)).toBe(true);
        expect(isLineInsideString(originalCode, 2)).toBe(true);
        expect(isLineInsideString(originalCode, 3)).toBe(true);
        expect(isLineInsideString(originalCode, 4)).toBe(true);
        expect(isLineInsideString(originalCode, 0)).toBe(false);
        expect(isLineInsideString(originalCode, 5)).toBe(false);

        const comments = [
            { line: 3, comment: '// This comment should be skipped' }
        ];

        const output = spliceComments(originalCode.join('\n'), comments);
        expect(output).toBe(originalCode.join('\n'));
    });

    /** Test for identifying Python-style triple quotes */
    test('should identify Python-style triple quotes', () => {
        const pythonCode = [
            'def hello():',
            '    """',
            '    This is a docstring',
            '    """',
            '    print("hello")'
        ];

        // Check if a line is inside a Python-style triple quote
        expect(isLineInsideString(pythonCode, 2, '.py')).toBe(true);
        expect(isLineInsideString(pythonCode, 4, '.py')).toBe(false);
    });

    /** Test for clean mode (deleting comment lines safely) */
    test('should handle clean mode (deleting comment lines safely)', () => {
        const commentedCode = [
            '// Import dependencies',
            'const fs = require("fs");',
            '/**',
            ' * Read file helper',
            ' */',
            'function read() {',
            '    // Read file',
            '    return fs.readFileSync("file.txt", "utf8");',
            '}'
        ].join('\n');

        const deletions = [
            { line: 1, action: 'delete' },
            { line: 3, action: 'delete' },
            { line: 4, action: 'delete' },
            { line: 5, action: 'delete' },
            { line: 7, action: 'delete' }
        ];

        // Splice comments into the original code in clean mode
        const output = spliceComments(commentedCode, deletions, 'clean');
        const expected = [
            'const fs = require("fs");',
            'function read() {',
            '    return fs.readFileSync("file.txt", "utf8");',
            '}'
        ].join('\n');

        expect(output).toBe(expected);
    });

    /** Test for preventing code deletion in clean mode */
    test('should prevent code deletion in clean mode (safety block)', () => {
        const code = [
            'const x = 1;',
            '// comment here',
            'const y = 2;'
        ].join('\n');

        const deletions = [
            { line: 1, action: 'delete' },
            { line: 2, action: 'delete' }
        ];

        // Splice comments into the original code in clean mode with safety block
        const output = spliceComments(code, deletions, 'clean');
        const expected = [
            'const x = 1;',
            'const y = 2;'
        ].join('\n');

        expect(output).toBe(expected);
    });

    /** Fuzz test for randomized comment inputs */
    test('fuzz test: randomized comment inputs should not crash or corrupt code', () => {
        const originalCode = Array.from({ length: 50 }, (_, i) => `const val_${i} = ${i};`).join('\n');
        const comments = [];
        for (let i = 0; i < 30; i++) {
            const randomLine = Math.floor(Math.random() * 60) - 5;
            comments.push({
                line: randomLine,
                comment: `// random comment ${i}`
            });
        }

        // Test that the function does not throw an error
        expect(() => {
            spliceComments(originalCode, comments);
        }).not.toThrow();
    });

    /** Golden regression test */
    test('golden regression test', () => {
        const code = 'class App {\n    start() {\n        console.log("Starting...");\n    }\n}';
        const comments = [
            { line: 1, comment: '// Main application class' },
            { line: 2, comment: '    /** Start the application */' }
        ];
        // Splice comments into the original code for regression test
        const output = spliceComments(code, comments);
        expect(output).toMatchSnapshot();
    });
});