/**
 * Unit tests for sanitizeCommentText()
 *
 * Covers all four comment families across all 22 supported languages:
 *   Family 1 — Block comments: /* ... * /
 *              JS, TS, JSX, TSX, Java, C, C++, C#, Go, Rust, Swift, Kotlin, Dart, CSS, SCSS, PHP, SQL
 *   Family 2 — HTML block comments: <!-- ... -->
 *              HTML, Vue, Svelte
 *   Family 3 — Single-line: // (JS/TS/Java/C/C++/C#/Go/Rust/Swift/Kotlin/Dart/PHP/Scss)
 *   Family 4 — Single-line: # (Python, Ruby, Shell)
 *   Family 5 — Single-line: -- (SQL)
 *
 * For each family the tests verify:
 *   (a) Normal comments are NOT mutated
 *   (b) Syntax-breaking sequences ARE sanitized
 *   (c) Edge cases (empty, unterminated, nested) are handled
 */

const { sanitizeCommentText } = require('../../lib/llm');

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Note: assertions use direct string checks rather than a helper to avoid
// the ironic problem of putting */ inside helper JSDoc comments.

// ─── Family 1: /* */ Block Comments ──────────────────────────────────────────

describe('sanitizeCommentText — /* */ block comments (JS/TS/Java/C/C++/C#/Go/Rust/Swift/Kotlin/Dart/CSS/SCSS/PHP/SQL)', () => {

    // (a) Normal cases — must NOT be mutated
    test('JS: normal single-line block comment is preserved', () => {
        expect(sanitizeCommentText('/* simple comment */')).toBe('/* simple comment */');
    });

    test('JS: JSDoc block comment is preserved', () => {
        const doc = '/** [ds]\n * Returns the total price.\n * @param {number} qty\n */';
        expect(sanitizeCommentText(doc)).toBe(doc);
    });

    test('CSS: /* */ block comment is preserved', () => {
        expect(sanitizeCommentText('/* css comment */')).toBe('/* css comment */');
    });

    test('Go: normal block comment is preserved', () => {
        expect(sanitizeCommentText('/* Go package doc */')).toBe('/* Go package doc */');
    });

    test('Rust: normal block comment is preserved', () => {
        expect(sanitizeCommentText('/* Rust block */')).toBe('/* Rust block */');
    });

    test('SQL: /* */ block comment is preserved', () => {
        expect(sanitizeCommentText('/* SQL block comment */')).toBe('/* SQL block comment */');
    });

    // (b) Breaking cases — interior */ must be escaped
    test('JS: interior */ in JSDoc body is escaped', () => {
        const raw = '/** [ds]\n * Handles Rust/Swift /* */ nested blocks.\n */';
        const result = sanitizeCommentText(raw);
        // The comment must still open with /** and close with */
        expect(result.startsWith('/**')).toBe(true);
        expect(result.trimEnd().endsWith('*/')).toBe(true);
        // The interior */ must be escaped
        expect(result).not.toMatch(/\/\*[^]*?\*\/[^]*\*\//); // no premature close before end
        expect(result).toContain('* /'); // escaped form present
    });

    test('Java: interior */ inside block comment body is escaped', () => {
        const raw = '/** Returns the result of /* inner */ computation. */';
        const result = sanitizeCommentText(raw);
        expect(result.startsWith('/**')).toBe(true);
        expect(result.trimEnd().endsWith('*/')).toBe(true);
        expect(result).toContain('* /');
    });

    test('C: LLM mentions /* */ syntax inside block comment', () => {
        const raw = '/* Uses the C-style /* */ comment convention. */';
        const result = sanitizeCommentText(raw);
        expect(result.startsWith('/*')).toBe(true);
        expect(result.trimEnd().endsWith('*/')).toBe(true);
        expect(result).toContain('* /');
    });

    test('CSS: LLM mentions /* */ inside CSS block comment', () => {
        const raw = '/* Override: use /* important */ rule carefully. */';
        const result = sanitizeCommentText(raw);
        expect(result.startsWith('/*')).toBe(true);
        expect(result.trimEnd().endsWith('*/')).toBe(true);
        expect(result).toContain('* /');
    });

    test('Kotlin: interior */ inside /** */ JSDoc is escaped', () => {
        const raw = '/** Kotlin doc — note the /* */ syntax in the example. */';
        const result = sanitizeCommentText(raw);
        expect(result.startsWith('/**')).toBe(true);
        expect(result.trimEnd().endsWith('*/')).toBe(true);
        expect(result).toContain('* /');
    });

    test('Swift: block comment with nested /* */ mention is escaped', () => {
        const raw = '/** Swift: /* nested */ comments are supported. */';
        const result = sanitizeCommentText(raw);
        expect(result.trimEnd().endsWith('*/')).toBe(true);
        expect(result).toContain('* /');
    });

    test('PHP: block comment with interior */ is escaped', () => {
        const raw = '/** PHP doc: use /* */ for multi-line blocks. */';
        const result = sanitizeCommentText(raw);
        expect(result.trimEnd().endsWith('*/')).toBe(true);
        expect(result).toContain('* /');
    });

    // (c) Edge cases
    test('unterminated block comment (no closing */) is returned safely', () => {
        const raw = '/* This comment was cut off by LLM truncation';
        const result = sanitizeCommentText(raw);
        expect(result).toBe(raw); // no crash, returned as-is
    });

    test('empty block comment /* */ is preserved', () => {
        expect(sanitizeCommentText('/**/')).toBe('/**/');
    });

    test('multiple interior */ are all escaped', () => {
        const raw = '/** mentions */ and again */ inside. */';
        const result = sanitizeCommentText(raw);
        // Only the last */ should remain as-is (terminal)
        const allCloses = [...result.matchAll(/\*\//g)];
        expect(allCloses.length).toBe(1); // exactly one real close
        expect(result.trimEnd().endsWith('*/')).toBe(true);
    });
});

// ─── Family 2: <!-- --> HTML Block Comments ───────────────────────────────────

describe('sanitizeCommentText — <!-- --> block comments (HTML/Vue/Svelte)', () => {

    // (a) Normal cases
    test('HTML: normal <!-- --> comment is preserved', () => {
        expect(sanitizeCommentText('<!-- normal html comment -->')).toBe('<!-- normal html comment -->');
    });

    test('Vue: <!-- --> comment is preserved', () => {
        expect(sanitizeCommentText('<!-- Vue template comment -->')).toBe('<!-- Vue template comment -->');
    });

    test('Svelte: <!-- --> comment is preserved', () => {
        expect(sanitizeCommentText('<!-- Svelte comment -->')).toBe('<!-- Svelte comment -->');
    });

    // (b) Breaking cases — interior --> must be escaped
    test('HTML: interior --> in comment body is escaped to -- >', () => {
        const raw = '<!-- Click --> to navigate, but also see the next section. -->';
        const result = sanitizeCommentText(raw);
        expect(result.startsWith('<!--')).toBe(true);
        expect(result.trimEnd().endsWith('-->')).toBe(true);
        // The interior --> must be escaped
        const closes = [...result.matchAll(/-->/g)];
        expect(closes.length).toBe(1); // only the terminal one remains
        expect(result).toContain('-- >'); // escaped interior form
    });

    test('HTML: multiple interior --> sequences are all escaped', () => {
        const raw = '<!-- Step 1 --> then Step 2 --> final. -->';
        const result = sanitizeCommentText(raw);
        const closes = [...result.matchAll(/-->/g)];
        expect(closes.length).toBe(1);
        expect(result.trimEnd().endsWith('-->')).toBe(true);
    });

    test('HTML: comment with no interior --> is not mutated', () => {
        expect(sanitizeCommentText('<!-- no closer here')).toBe('<!-- no closer here');
    });
});

// ─── Family 3: // Single-line Comments ────────────────────────────────────────

describe('sanitizeCommentText — // single-line comments (JS/TS/Java/C/C++/C#/Go/Rust/Swift/Kotlin/Dart/PHP/SCSS)', () => {

    // (a) Normal cases
    test('JS: normal // comment is preserved', () => {
        expect(sanitizeCommentText('// normal inline comment')).toBe('// normal inline comment');
    });

    test('Go: normal // comment is preserved', () => {
        expect(sanitizeCommentText('// Go comment')).toBe('// Go comment');
    });

    test('Rust: normal // comment is preserved', () => {
        expect(sanitizeCommentText('// Rust comment')).toBe('// Rust comment');
    });

    // (b) Breaking cases — embedded newlines must be collapsed
    test('JS: embedded newline in // comment collapses to space', () => {
        const raw = '// normal start\nmalicious_code()';
        const result = sanitizeCommentText(raw);
        expect(result).not.toContain('\n');
        expect(result.startsWith('//')).toBe(true);
    });

    test('TS: embedded CRLF in // comment collapses to space', () => {
        const raw = '// legit\r\nevil()';
        const result = sanitizeCommentText(raw);
        expect(result).not.toContain('\r');
        expect(result).not.toContain('\n');
    });

    test('Java: multiple embedded newlines all collapsed', () => {
        const raw = '// line1\nline2\nline3';
        const result = sanitizeCommentText(raw);
        expect((result.match(/\n/g) || []).length).toBe(0);
    });

    test('C#: newline injection attempt is neutralized', () => {
        const raw = '// valid comment\nexec("rm -rf /")';
        const result = sanitizeCommentText(raw);
        expect(result).not.toContain('\n');
        expect(result.startsWith('//')).toBe(true);
    });
});

// ─── Family 4: # Single-line Comments ────────────────────────────────────────

describe('sanitizeCommentText — # single-line comments (Python/Ruby/Shell)', () => {

    test('Python: normal # comment is preserved', () => {
        expect(sanitizeCommentText('# Calculate total')).toBe('# Calculate total');
    });

    test('Ruby: normal # comment is preserved', () => {
        expect(sanitizeCommentText('# Ruby method doc')).toBe('# Ruby method doc');
    });

    test('Shell: normal # comment is preserved', () => {
        expect(sanitizeCommentText('# !/bin/bash guard')).toBe('# !/bin/bash guard');
    });

    test('Python: embedded newline injection is neutralized', () => {
        const raw = '# safe line\nos.system("evil")';
        const result = sanitizeCommentText(raw);
        expect(result).not.toContain('\n');
        expect(result.startsWith('#')).toBe(true);
    });

    test('Shell: embedded newline injection is neutralized', () => {
        const raw = '# comment\nrm -rf /';
        const result = sanitizeCommentText(raw);
        expect(result).not.toContain('\n');
    });
});

// ─── Family 5: -- Single-line Comments (SQL) ─────────────────────────────────

describe('sanitizeCommentText — -- single-line comments (SQL)', () => {

    test('SQL: normal -- comment is preserved', () => {
        expect(sanitizeCommentText('-- select all records')).toBe('-- select all records');
    });

    test('SQL: embedded newline injection is neutralized', () => {
        const raw = '-- safe\nDROP TABLE users;';
        const result = sanitizeCommentText(raw);
        expect(result).not.toContain('\n');
        expect(result.startsWith('--')).toBe(true);
    });
});

// ─── Edge / Boundary Cases ────────────────────────────────────────────────────

describe('sanitizeCommentText — edge cases', () => {

    test('non-string input is returned as-is', () => {
        expect(sanitizeCommentText(null)).toBe(null);
        expect(sanitizeCommentText(undefined)).toBe(undefined);
        expect(sanitizeCommentText(42)).toBe(42);
    });

    test('empty string is returned as-is', () => {
        expect(sanitizeCommentText('')).toBe('');
    });

    test('unknown comment form (e.g., bare text) is returned as-is', () => {
        expect(sanitizeCommentText('no prefix here')).toBe('no prefix here');
    });

    test('/* */ with no interior terminators is not mutated at all', () => {
        const clean = '/** Clean JSDoc with no interior terminators. */';
        expect(sanitizeCommentText(clean)).toBe(clean);
    });

    test('<!-- --> with no interior terminators is not mutated at all', () => {
        const clean = '<!-- Clean HTML comment with no interior terminators. -->';
        expect(sanitizeCommentText(clean)).toBe(clean);
    });

    test('// with no embedded newlines is not mutated at all', () => {
        const clean = '// Clean single-line comment.';
        expect(sanitizeCommentText(clean)).toBe(clean);
    });

    test('sanitized output is always safe to embed (no early block close)', () => {
        const dangerous = [
            '/** mentions */ and */ again. */',
            '/* C style: use /* */ carefully */',
            '/** Kotlin: /* nested */ blocks. */',
        ];
        for (const d of dangerous) {
            const result = sanitizeCommentText(d);
            // After sanitization, only 1 real */ should remain at the end
            const realCloses = [...result.matchAll(/\*\//g)];
            expect(realCloses.length).toBe(1);
            expect(result.trimEnd().endsWith('*/')).toBe(true);
        }
    });
});
