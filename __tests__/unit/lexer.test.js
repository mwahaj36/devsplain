const { spliceComments } = require('../../bin/cli.js');

describe('Lexer Edge Cases', () => {
    const tests = [
        // --- JS / TS / JSX / TSX ---
        {
            name: 'JS: Private fields should not be treated as comment',
            ext: '.js',
            code: 'class A {\n  #privateField = `value`;\n}\n// target',
            comments: [{ line: 4, comment: '// comment' }],
            expected: 'class A {\n  #privateField = `value`;\n}\n// comment [ds]\n// target'
        },
        {
            name: 'JS: Comments in backticks should not desync',
            ext: '.js',
            code: 'const x = `\n  // not a comment\n`;\n// target',
            comments: [{ line: 4, comment: '// comment' }],
            expected: 'const x = `\n  // not a comment\n`;\n// comment [ds]\n// target'
        },
        {
            name: 'JS: Normal string with comment token',
            ext: '.js',
            code: 'const x = "http://google.com";\n// target',
            comments: [{ line: 2, comment: '// comment' }],
            expected: 'const x = "http://google.com";\n// comment [ds]\n// target'
        },
        {
            name: 'JS: Regex Literals',
            ext: '.js',
            code: 'const r = /"/;\n// target',
            comments: [{ line: 2, comment: '// comment' }],
            expected: 'const r = /"/;\n// comment [ds]\n// target'
        },

        // --- HTML / Vue / Svelte ---
        {
            name: 'HTML: HTML comments and scripts',
            ext: '.html',
            code: '<!-- comment -->\n<script>\nconst x = "hello";\n// target\n</script>',
            comments: [{ line: 4, comment: '// comment' }],
            expected: '<!-- comment -->\n<script>\nconst x = "hello";\n// comment [ds]\n// target\n</script>'
        },

        // --- CSS / SCSS ---
        {
            name: 'CSS: Block comments',
            ext: '.css',
            code: 'body {\n  color: red; /* comment */\n}\n/* target */',
            comments: [{ line: 4, comment: '/* comment */' }],
            expected: 'body {\n  color: red; /* comment */\n}\n/* comment [ds] */\n/* target */'
        },
        {
            name: 'SCSS: Line and block comments',
            ext: '.scss',
            code: 'body {\n  // line comment\n  color: red; /* block */\n}\n// target',
            comments: [{ line: 5, comment: '// comment' }],
            expected: 'body {\n  // line comment\n  color: red; /* block */\n}\n// comment [ds]\n// target'
        },

        // --- Python ---
        {
            name: 'Python: Integer division should not start comment',
            ext: '.py',
            code: 'x = 10 // 2\n# target',
            comments: [{ line: 2, comment: '# comment' }],
            expected: 'x = 10 // 2\n# comment [ds]\n# target'
        },
        {
            name: 'Python: Hash in string should not start comment',
            ext: '.py',
            code: 's = "hello # world"\n# target',
            comments: [{ line: 2, comment: '# comment' }],
            expected: 's = "hello # world"\n# comment [ds]\n# target'
        },
        {
            name: 'Python: Triple quotes multiline string',
            ext: '.py',
            code: 's = """\nmultiline # string\n"""\n# target',
            comments: [{ line: 4, comment: '# comment' }],
            expected: 's = """\nmultiline # string\n"""\n# comment [ds]\n# target'
        },
        {
            name: 'Python Bug Check: Normal quotes resetting at line ends',
            ext: '.py',
            code: 's = "unclosed quote\n# comment to clean',
            comments: [],
            mode: 'clean',
            expected: 's = "unclosed quote\n# comment to clean'
        },

        // --- C-like languages ---
        {
            name: 'C: Preprocessor and strings',
            ext: '.c',
            code: '#include <stdio.h>\nconst char* s = "hello /* world */";\n// target',
            comments: [{ line: 3, comment: '// comment' }],
            expected: '#include <stdio.h>\nconst char* s = "hello /* world */";\n// comment [ds]\n// target'
        },
        {
            name: 'C++: Preprocessor and strings',
            ext: '.cpp',
            code: '#define FOO "bar"\nconst char* s = "hello // world";\n// target',
            comments: [{ line: 3, comment: '// comment' }],
            expected: '#define FOO "bar"\nconst char* s = "hello // world";\n// comment [ds]\n// target'
        },
        {
            name: 'C++: Raw Strings',
            ext: '.cpp',
            code: 'auto s = R"delim(\n"quoted"\n)delim";\n// target',
            comments: [{ line: 4, comment: '// comment' }],
            expected: 'auto s = R"delim(\n"quoted"\n)delim";\n// comment [ds]\n// target'
        },

        // --- Shell / Bash ---
        {
            name: 'Bash Bug Check: Quotes NOT resetting at line ends',
            ext: '.sh',
            code: 'echo "hello\n# not a comment\nworld"',
            comments: [],
            mode: 'clean',
            expected: 'echo "hello\n# not a comment\nworld"'
        },

        // --- Ruby ---
        {
            name: 'Ruby: Hash in string and comments',
            ext: '.rb',
            code: 's = "hello # world"\n# target',
            comments: [{ line: 2, comment: '# comment' }],
            expected: 's = "hello # world"\n# comment [ds]\n# target'
        },

        // --- PHP ---
        {
            name: 'PHP: Multiple comment styles',
            ext: '.php',
            code: '<?php\n// line comment\n# hash comment\n/* block */\n// target',
            comments: [{ line: 5, comment: '// comment' }],
            expected: '<?php\n// line comment\n# hash comment\n/* block */\n// comment [ds]\n// target'
        },

        // --- Rust ---
        {
            name: 'Rust: Nested block comments',
            ext: '.rs',
            code: '/* outer /* inner */ */\n// target',
            comments: [{ line: 2, comment: '// comment' }],
            expected: '/* outer /* inner */ */\n// comment [ds]\n// target'
        },

        // --- Shell / Ruby ---
        {
            name: 'Shell: // and /* should not be treated as comments',
            ext: '.sh',
            code: 'cd //tmp\nrm -rf /*\ntarget',
            comments: [{ line: 3, comment: '# target comment' }],
            expected: 'cd //tmp\nrm -rf /*\n# target comment [ds]\ntarget'
        },
        {
            name: 'Ruby: // and /* should not be treated as comments',
            ext: '.rb',
            code: 'path = "//etc"\nregex = /*/\ntarget',
            comments: [{ line: 3, comment: '# target comment' }],
            expected: 'path = "//etc"\nregex = /*/\n# target comment [ds]\ntarget'
        },
        {
            name: 'PHP: # and // and /* should all be treated as comments',
            ext: '.php',
            code: '# comment\n// comment\n/* comment */\ntarget',
            comments: [{ line: 4, comment: '// target comment' }],
            expected: '# comment\n// comment\n/* comment */\n// target comment [ds]\ntarget'
        }
    ];

    tests.forEach((t) => {
        test(t.name, () => {
            const mode = t.mode || 'default';
            const result = spliceComments(t.code, t.comments || [], mode, t.ext);
            const normResult = result.replace(/\r\n/g, '\n');
            const normExpected = t.expected.replace(/\r\n/g, '\n');
            expect(normResult).toBe(normExpected);
        });
    });
});
