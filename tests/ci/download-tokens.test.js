/**
 * @jest-environment node
 */
/**
 * Standalone pages can't link variables.css or app.css (they pin html / body for the app shell), so each carries a
 * copy of the design tokens it uses: /download in its <style>, the tenant's rent-history page (/r/<token>) in
 * www/r/rent-history.css. The copies must match www/css/variables.css (Modern light), and the pages' rules may use
 * only those tokens: no raw colours.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const variables = strip(read('www/css/variables.css'));

const PAGES = [
    ['/download', strip(read('www/download.html').match(/<style>([\s\S]*?)<\/style>/)[1])],
    ['/r rent history', strip(read('www/r/rent-history.css'))]
];

/** Custom properties of the top-level blocks whose selector list matches `selector`, first value wins. */
function tokens(css, selector) {
    const out = {};
    for (const m of css.matchAll(/(^|\})\s*([^{}@]+)\{([^{}]*)\}/g)) {
        if (!m[2].split(',').some((s) => selector.test(s.trim()))) continue;
        for (const d of m[3].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) if (!(d[1] in out)) out[d[1]] = d[2].trim();
    }
    return out;
}

describe.each(PAGES)('%s', (_, style) => {
    test('the copied tokens equal variables.css (light, and Hindi type)', () => {
        const page = tokens(style, /^:root$/);
        const source = tokens(variables, /^:root$/);
        expect(Object.keys(page).length).toBeGreaterThan(10);
        for (const [name, value] of Object.entries(page)) expect([name, value]).toEqual([name, source[name]]);
        const pageHi = tokens(style, /^html\[lang="hi"\]$/);
        const sourceHi = tokens(variables, /^html\[lang="hi"\]$/);
        for (const [name, value] of Object.entries(pageHi)) expect([name, value]).toEqual([name, sourceHi[name]]);
    });

    test('the page rules use tokens, not raw colours', () => {
        const rules = style.replace(/:root\s*\{[^}]*\}/, '');
        expect(rules.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi)).toBeNull();
    });
});
