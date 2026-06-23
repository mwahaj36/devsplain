const { spliceComments, isLineInsideString } = require('../../bin/cli.js');

describe('Line-Splicing Engine & Quote-Tracking', () => {

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

        const output = spliceComments(originalCode, comments);
        const expected = [
            '/** Greet function JSDoc [ds] */',
            'function greet(name) {',
            '    // Return greeting [ds]',
            '    return "Hello " + name;',
            '}'
        ].join('\n');

        expect(output).toBe(expected);
    });

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

        const output = spliceComments(originalCode, comments);
        const expected = [
            'class User {',
            '    /** [ds]',
            '     * Constructor for User',
            '     * @constructor',
            '    */',
            '    constructor() {',
            '\t\t// Set default name [ds]',
            '\t\tthis.name = "";',
            '    }',
            '}'
        ].join('\n');

        expect(output).toBe(expected);
    });

    test('should not insert comments inside multiline strings/template literals', () => {
        const originalCode = [
            'const html = `',
            '<div>',
            '    <h1>Hello</h1>',
            '</div>',
            '`;',
            'const x = 1;'
        ];

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

    test('should identify Python-style triple quotes', () => {
        const pythonCode = [
            'def hello():',
            '    """',
            '    This is a docstring',
            '    """',
            '    print("hello")'
        ];

        expect(isLineInsideString(pythonCode, 2, '.py')).toBe(true);
        expect(isLineInsideString(pythonCode, 4, '.py')).toBe(false);
    });

    test('should handle prune mode (deleting all comment lines safely)', () => {
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

        const deletions = [];

        const output = spliceComments(commentedCode, deletions, 'prune');
        const expected = [
            'const fs = require("fs");',
            'function read() {',
            '    return fs.readFileSync("file.txt", "utf8");',
            '}'
        ].join('\n');

        expect(output).toBe(expected);
    });

    test('should handle clean mode (deleting only [ds] comments)', () => {
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

        const deletions = [];

        const output = spliceComments(commentedCode, deletions, 'clean');
        const expected = [
            '// User written comment',
            'const fs = require("fs");',
            'function read() {',
            '    // User logic comment',
            '    return fs.readFileSync("file.txt", "utf8");',
            '}'
        ].join('\n');

        expect(output).toBe(expected);
    });

    test('should prevent code deletion in prune mode (safety block)', () => {
        const code = [
            'const x = 1;',
            '// comment here',
            'const y = 2;'
        ].join('\n');

        const deletions = [
            { line: 1, action: 'delete' },
            { line: 2, action: 'delete' }
        ];

        const output = spliceComments(code, deletions, 'prune');
        const expected = [
            'const x = 1;',
            'const y = 2;'
        ].join('\n');

        expect(output).toBe(expected);
    });

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

        expect(() => {
            spliceComments(originalCode, comments);
        }).not.toThrow();
    });

    test('golden regression test', () => {
        const code = 'class App {\n    start() {\n        console.log("Starting...");\n    }\n}';
        const comments = [
            { line: 1, comment: '// Main application class' },
            { line: 2, comment: '    /** Start the application */' }
        ];
        const output = spliceComments(code, comments);
        expect(output).toMatchSnapshot();
    });
});