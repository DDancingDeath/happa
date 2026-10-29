/**
 * @jest-environment node
 */
/**
 * Rentals stay out of the start-up path (#149 owner rule: "make sure it doesn't
 * make the whole app slow"; docs/rentals-design.md §4). Every PR checks:
 *  - no js/rentals file is reachable through static imports from index.html;
 *  - no start-up file names a rent_* collection (so no rent_* read or listener
 *    can happen before Rentals is opened);
 *  - index.html and the template loader don't load the rentals CSS/template;
 *  - only ui/business-switcher.js imports the Rentals code, with import();
 *  - the Rentals files stay within the size budget.
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const WWW = path.resolve(__dirname, '..', '..');
const JS = path.join(WWW, 'js');
const RENTALS = path.join(JS, 'rentals');
const read = (p) => fs.readFileSync(p, 'utf8');
const rel = (p) => path.relative(WWW, p).split(path.sep).join('/');
const RENT_COLLECTION = /['"`](?:dev_)?rent_[a-z]/;
const BUDGET_BYTES = 130 * 1024;
/** Rentals files loaded with import() only when used (not when Rentals opens), with their own budget. */
const LAZY = ['rent-receipt.js'];
const LAZY_BUDGET_BYTES = 20 * 1024;
/** Size as served (LF line endings), the same on a Windows checkout and in CI. */
const sizeOf = (f) => Buffer.byteLength(read(f).replace(/\r\n/g, '\n'));

function listJs(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === '__tests__' ? [] : listJs(p);
        return e.name.endsWith('.js') ? [p] : [];
    });
}

/** Static import graph from the module scripts in index.html (dynamic import() not followed). */
function startupGraph() {
    const html = read(path.join(WWW, 'index.html'));
    const queue = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"?]+)/g)].map(m => path.join(WWW, m[1]));
    const seen = new Set();
    while (queue.length) {
        const file = queue.shift();
        if (seen.has(file)) continue;
        seen.add(file);
        const ast = acorn.parse(read(file), { ecmaVersion: 'latest', sourceType: 'module' });
        walk.full(ast, (node) => {
            const isStatic = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type);
            if (isStatic && node.source && node.source.value.startsWith('.')) {
                queue.push(path.resolve(path.dirname(file), node.source.value.split(/[?#]/)[0]));
            }
        });
    }
    return seen;
}

const graph = startupGraph();

describe('Rentals are not loaded at start-up (#149, #170)', () => {
    test('the start-up graph is the real app (main.js, billing, firestore-service)', () => {
        const files = [...graph].map(rel);
        expect(files).toEqual(expect.arrayContaining(['js/main.js', 'js/modules/billing.js', 'js/firebase/firestore-service.js', 'js/ui/business-switcher.js']));
    });

    test('no js/rentals file is statically imported at start-up', () => {
        expect([...graph].filter(f => f.startsWith(RENTALS + path.sep)).map(rel)).toEqual([]);
    });

    test('no start-up file names a rent_* collection', () => {
        expect([...graph].filter(f => RENT_COLLECTION.test(read(f))).map(rel)).toEqual([]);
    });

    test('index.html, firebaseConfig.js and the template loader do not load rentals files', () => {
        expect(read(path.join(WWW, 'index.html'))).not.toMatch(/rentals/i);
        expect(read(path.join(WWW, 'firebaseConfig.js'))).not.toMatch(RENT_COLLECTION);
        expect(read(path.join(JS, 'utils', 'template-loader.js'))).not.toMatch(/rentals/);
    });

    test('only ui/business-switcher.js imports the Rentals code, and only with import()', () => {
        const importers = listJs(JS).filter(f => !f.startsWith(RENTALS + path.sep))
            .filter(f => /rentals\/[\w-]+\.js/.test(read(f)))
            .map(rel);
        expect(importers).toEqual(['js/ui/business-switcher.js']);
        const src = read(path.join(JS, 'ui', 'business-switcher.js'));
        expect(src).toMatch(/import\(\s*'\.\.\/rentals\/rentals\.js'\s*\)/);
        expect(src).not.toMatch(/^import .*rentals\//m);
        expect(src).not.toMatch(RENT_COLLECTION);
    });

    test('the switcher starts after the first screen is shown (after the app-shown timing)', () => {
        const main = read(path.join(JS, 'main.js'));
        const shown = main.indexOf("markStartup('app-shown'");
        const init = main.indexOf('BusinessSwitcher.init()');
        expect(shown).toBeGreaterThan(0);
        expect(init).toBeGreaterThan(shown);
    });

    test(`Rentals files stay within the ${BUDGET_BYTES / 1024} KB precache budget`, () => {
        const files = [...listJs(RENTALS).filter(f => !LAZY.includes(path.basename(f))), path.join(WWW, 'templates', 'rentals.html'), path.join(WWW, 'css', 'rentals.css')];
        const bytes = files.reduce((s, f) => s + sizeOf(f), 0);
        expect(bytes).toBeLessThanOrEqual(BUDGET_BYTES);
    });

    // Receipts are split out: rentals.js loads rent-receipt.js with import() when a receipt is opened.
    test(`the receipt module loads only when used and stays within ${LAZY_BUDGET_BYTES / 1024} KB`, () => {
        const files = listJs(RENTALS);
        LAZY.forEach(name => {
            const importers = files.filter(f => path.basename(f) !== name && read(f).includes(name)).map(rel);
            expect(importers).toEqual(['js/rentals/rentals.js']);
            const src = read(path.join(RENTALS, 'rentals.js'));
            expect(src).toMatch(new RegExp(`import\\(\\s*'\\./${name.replace('.', '\\.')}'\\s*\\)`));
            expect(src).not.toMatch(new RegExp(`^import .*${name.replace('.', '\\.')}`, 'm'));
            expect(sizeOf(path.join(RENTALS, name)) + sizeOf(path.join(WWW, 'css', 'rent-receipt.css'))).toBeLessThanOrEqual(LAZY_BUDGET_BYTES);
        });
        expect(read(path.join(RENTALS, 'rent-receipt.js'))).toMatch(/css\/rent-receipt\.css/);
        expect(read(path.join(WWW, 'index.html'))).not.toMatch(/rent-receipt/);
    });
});
