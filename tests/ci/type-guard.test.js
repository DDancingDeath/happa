/**
 * @jest-environment node
 */
/**
 * Type ratchet (redesign phase 2.3, DIRECTION §3.2-3.3): font sizes come from the type scale
 * (--fs-caption … --fs-hero) and weights from --w-regular / --w-label / --w-strong, so Hindi
 * (larger sizes, regular labels) and the Android app (Roboto Medium) adjust them in one place.
 * Counted per file: a font-size or font-weight that is not a var() / inherit, in www/css, in a
 * template's style="…" / <style>, and in style text or .style.fontSize / .fontWeight in www/js.
 * Not counted: app.css (built), @media print and the receipt output (black on white, own layout).
 *
 * Strict: a raw size or weight fails unless tests/ds-allowlist.json has an entry (metric "type")
 * for the file at that count, with a reason (ds-allowlist.js).
 */
const fs = require('fs');
const path = require('path');
const { expectAllowed } = require('./ds-allowlist');

const ROOT = path.join(__dirname, '..', '..');
const SKIP = new Set(['www/css/app.css', 'www/css/rent-receipt.css', 'www/js/services/printer.js', 'www/js/services/receipt-drawing.js', 'www/js/rentals/rent-receipt.js']);

const FREE = /^\s*(var\(|inherit|initial|unset|revert)/i;
const DECL = /(?:^|[;{\s"'`])font-(size|weight)\s*:\s*([^;"'`}\r\n]+)/gi;
const JS_PROP = /\.style\.font(Size|Weight)\s*=\s*(['"`])([^'"`]*)\2/g;

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

const rawDecls = (text) => [...text.matchAll(DECL)].filter((m) => !FREE.test(m[2])).length;
const cssCount = (css) => rawDecls(stripPrint(css.replace(/\/\*[\s\S]*?\*\//g, '')));
function htmlCount(html) {
    let n = 0;
    for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) n += cssCount(m[1]);
    for (const m of html.matchAll(/\sstyle="([^"]*)"/gi)) n += rawDecls(` ${m[1]}`);
    return n;
}
function jsCount(source) {
    const src = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return rawDecls(src) + [...src.matchAll(JS_PROP)].filter((m) => !FREE.test(m[3])).length;
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
        const n = f.endsWith('.css') ? cssCount(text) : f.endsWith('.html') ? htmlCount(text) : jsCount(text);
        if (n) result[f] = n;
    }
    return result;
}

describe('font sizes and weights come from the type tokens', () => {
    const current = scan();

    test('every file is at 0 or at its allowlist entry (tests/ds-allowlist.json)', () => {
        expectAllowed('type', current, 'use --fs-* / --w-* tokens from www/css/variables.css');
    });

    test.each([
        ['a { font-size: 14px; font-weight: 700; } b { font-size: var(--fs-sm); font-weight: var(--w-strong); }', 2],
        ['a { font: inherit; font-size: inherit; } @media print { a { font-size: 9pt; } }', 0],
        ['/* font-size: 12px */ a { font-weight: 600 !important; }', 1],
    ])('cssCount(%s) = %i', (css, n) => {
        expect(cssCount(css)).toBe(n);
    });

    test.each([
        ['el.style.fontSize = "18px"; el.style.fontWeight = "var(--w-strong)";', 1],
        ['`<b style="font-size: 12px; font-weight: var(--w-label)">`', 1],
    ])('jsCount(%s) = %i', (src, n) => {
        expect(jsCount(src)).toBe(n);
    });
});
