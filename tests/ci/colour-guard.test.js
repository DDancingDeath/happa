/**
 * @jest-environment node
 */
/**
 * Colour ratchet (redesign phase 2, docs: DIRECTION "Theme system"): colours come from the
 * design tokens in www/css/variables.css, so every theme and mode restyles them. This test
 * counts, per file, the hard-coded colours that would not follow a theme:
 *   - www/css/*.css: colour values in declarations (hex, rgb()/hsl(), colour names);
 *   - www/index.html and www/templates/*.html: the same in style="…" and <style> blocks;
 *   - www/js/**: hex / rgb() / hsl() literals and colour names after a colour property.
 * Not counted: variables.css (the token home), the built app.css, @media print blocks and the
 * print / receipt output (rent-receipt.css, services/printer.js, rentals/rent-receipt.js), which
 * stay black on white in every theme.
 *
 * Counts may only go down. COLOUR_BASELINE=lower npx jest colour-guard lowers
 * tests/colour-baseline.json; a new colour uses a token (var(--…)) instead.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const BASELINE_REL = 'tests/colour-baseline.json';
const BASELINE_FILE = path.join(ROOT, BASELINE_REL);
const SKIP = new Set([
    'www/css/app.css', 'www/css/variables.css', 'www/css/rent-receipt.css',
    'www/js/services/printer.js', 'www/js/rentals/rent-receipt.js',
]);

const NAMES = 'white|black|red|green|blue|gr[ae]y|orange|yellow|purple|pink|brown|navy|teal|silver|gold|maroon';
const HEX = /(?<![\w&#-])#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![\w-])/gi;
const FUNC = /(?<![\w-])(?:rgba?|hsla?)\(/gi;
const NAMED_VALUE = new RegExp(`(?<![\\w-])(?:${NAMES})(?![\\w-])`, 'gi');
const NAMED_AFTER_PROP = new RegExp(
    `(?:color|background(?:-color)?|border(?:-[a-z]+)*|outline(?:-color)?|fill|stroke|box-shadow|text-shadow)\\s*:\\s*[^;"'\`}{]*?(?<![\\w-])(?:${NAMES})(?![\\w-])`, 'gi');

const count = (text, re) => (text.match(re) || []).length;
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Removes `@media print { … }` blocks (brace-matched). */
function stripPrint(css) {
    let out = '';
    let i = 0;
    const re = /@media\s+print[^{]*\{/gi;
    let m;
    while ((m = re.exec(css))) {
        out += css.slice(i, m.index);
        let depth = 1;
        let j = m.index + m[0].length;
        while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
        i = j;
        re.lastIndex = j;
    }
    return out + css.slice(i);
}

/** Colours in the values of CSS declarations (selectors such as [style*="#fff"] don't count). */
function cssColours(css) {
    let n = 0;
    for (const body of stripPrint(stripComments(css)).matchAll(/\{([^{}]*)\}/g)) {
        for (const decl of body[1].split(';')) {
            const at = decl.indexOf(':');
            if (at < 0 || /^\s*--/.test(decl)) continue;
            const value = decl.slice(at + 1).replace(/var\([^)]*\)/g, '');
            n += count(value, HEX) + count(value, FUNC) + count(value, NAMED_VALUE);
        }
    }
    return n;
}

function htmlColours(html) {
    let n = 0;
    for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) n += cssColours(m[1]);
    for (const m of html.matchAll(/\sstyle="([^"]*)"/gi)) n += cssColours(`{${m[1]}}`);
    return n;
}

function jsColours(src) {
    return count(src, HEX) + count(src, FUNC) + count(src, NAMED_AFTER_PROP);
}

function walk(dir, out = []) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(rel, out); } else out.push(rel);
    }
    return out;
}

function scan() {
    const files = [
        ...walk('www/css').filter((f) => f.endsWith('.css')),
        'www/index.html',
        ...walk('www/templates').filter((f) => f.endsWith('.html')),
        ...walk('www/js').filter((f) => f.endsWith('.js')),
    ].filter((f) => !SKIP.has(f)).sort();
    const result = {};
    for (const f of files) {
        const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
        const n = f.endsWith('.css') ? cssColours(text) : f.endsWith('.html') ? htmlColours(text) : jsColours(text);
        if (n) result[f] = n;
    }
    return result;
}

const raisedAgainst = (current, base) => Object.entries(current)
    .filter(([f, n]) => n > (base[f] || 0))
    .map(([f, n]) => `  ${f}: ${base[f] || 0} -> ${n}${base[f] ? '' : ' (new file)'}`);

function writeBaseline(files) {
    const total = Object.values(files).reduce((a, b) => a + b, 0);
    const doc = {
        _readme: 'Hard-coded colour ratchet (tests/ci/colour-guard.test.js). Counts may only go down: COLOUR_BASELINE=lower npx jest colour-guard. Use a design token (var(--…), www/css/variables.css) for a new colour.',
        total,
        files,
    };
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(doc, null, 2)}\n`);
}

describe('hard-coded colours (design tokens only)', () => {
    const current = scan();

    if (process.env.COLOUR_BASELINE === 'reset' && !process.env.CI) writeBaseline(current);
    const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    const base = baseline.files;

    test('no file gains a hard-coded colour', () => {
        const raised = raisedAgainst(current, base);
        if (!raised.length && process.env.COLOUR_BASELINE === 'lower') {
            writeBaseline(Object.fromEntries(Object.entries(base)
                .filter(([f]) => current[f]).map(([f, n]) => [f, Math.min(n, current[f])])));
        }
        if (raised.length) {
            throw new Error(['New hard-coded colours: use a design token (var(--…)) from www/css/variables.css.', ...raised].join('\n'));
        }
    });

    test('the baseline is no higher than the PR base', () => {
        const ref = process.env.ARCH_BASE_REF || `origin/${process.env.GITHUB_BASE_REF || 'main'}`;
        let prior;
        try {
            prior = JSON.parse(execFileSync('git', ['show', `${ref}:${BASELINE_REL}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }));
        } catch {
            return;
        }
        expect(raisedAgainst(base, prior.files)).toEqual([]);
    });

    test('the baseline total matches its rows', () => {
        expect(baseline.total).toBe(Object.values(base).reduce((a, b) => a + b, 0));
    });

    test.each([
        ['a { color: #fff; background: rgba(0, 0, 0, .1); border: 1px solid white; }', 3],
        ['a { color: var(--ink); --x: #fff; } #fade { color: currentColor; }', 0],
        ['[style*="background: #fff"] { color: var(--ink); }', 0],
        ['@media print { a { color: #000; } } b { color: #111; }', 1],
        ['a { font-family: "Segoe UI"; transition: color 1s; }', 0],
    ])('cssColours(%s) = %i', (css, n) => {
        expect(cssColours(css)).toBe(n);
    });

    test.each([
        ['<div style="color: #333; margin: 0">x</div><style>.a { background: red; }</style>', 2],
        ['<meta name="theme-color" content="#667eea"><div style="color: var(--ink)"></div>', 0],
    ])('htmlColours(%s) = %i', (html, n) => {
        expect(htmlColours(html)).toBe(n);
    });

    test.each([
        ["el.style.color = '#b91c1c'; q('#billDate');", 1],
        ['`<span style="color: white; background: rgb(1, 2, 3)">`', 2],
        ["const label = 'white rice'; document.querySelector('#saleSection');", 0],
    ])('jsColours(%s) = %i', (src, n) => {
        expect(jsColours(src)).toBe(n);
    });
});
