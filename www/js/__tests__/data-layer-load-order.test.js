/**
 * @fileoverview Load order of the data layer (#69). firestore-service.js and the modules split
 * out of it import each other; in the browser (native ES modules) a binding of such a cycle read
 * while the modules load can still be uninitialised (ReferenceError, the app does not start),
 * while Jest (babel) quietly sees `undefined`, so the other tests can't catch it. Two rules:
 * - in www/js/firebase/** (but the facade firestore-service.js), what is imported from another
 *   data-layer module is used only inside functions, never while the module loads;
 * - code outside www/js/firebase/ never imports a module whose method object the facade spreads
 *   in (`export const xMethods`): it is loaded through firestore-service.js, so the facade's
 *   spreads always run after those modules are done.
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const JS = path.resolve(__dirname, '..');
const FIREBASE = path.join(JS, 'firebase');
const FACADE = path.join(FIREBASE, 'firestore-service.js');

const parse = (src) => acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
const listJs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : listJs(p);
    return p.endsWith('.js') ? [p] : [];
});
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** Names imported from data-layer modules that a module reads while it loads (outside any function). */
function loadTimeUses(src, file) {
    const ast = parse(src);
    const imported = new Set();
    ast.body.filter(s => s.type === 'ImportDeclaration'
        && path.resolve(path.dirname(file), s.source.value).startsWith(FIREBASE + path.sep))
        .forEach(s => s.specifiers.forEach(sp => imported.add(sp.local.name)));
    const uses = [];
    const visit = (node, parent) => {
        if (!node || typeof node.type !== 'string' || FUNCTIONS.has(node.type) || node.type === 'ImportDeclaration') return;
        if (node.type === 'Identifier' && imported.has(node.name)
            && !(parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed)
            && !(parent && parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand)) {
            uses.push(`${path.relative(JS, file).replace(/\\/g, '/')}:${node.loc.start.line} ${node.name}`);
        }
        for (const key of Object.keys(node)) {
            const v = node[key];
            if (key === 'loc') continue;
            if (Array.isArray(v)) v.forEach(x => visit(x, node));
            else if (v && typeof v.type === 'string') visit(v, node);
        }
    };
    ast.body.forEach(s => visit(s, null));
    return uses;
}

describe('data layer load order (#69)', () => {
    test('data-layer modules read no imported data-layer binding while loading', () => {
        const uses = listJs(FIREBASE).filter(f => f !== FACADE)
            .flatMap(f => loadTimeUses(fs.readFileSync(f, 'utf8'), f));
        expect(uses).toEqual([]);
    });

    test('the detector sees a constant derived from another data-layer module, not uses inside functions', () => {
        const file = path.join(FIREBASE, 'core', 'example.js');
        const src = [
            "import { DAY_MS, later } from './stock-checkpoint.js';",
            "import { round2 } from '../../utils/money.js';",
            'export const SPAN = 14 * DAY_MS;',
            'export const HALF = round2(0.5);',
            'export const methods = { run() { return later(DAY_MS); }, at: () => later };'
        ].join('\n');
        expect(loadTimeUses(src, file)).toEqual(['firebase/core/example.js:3 DAY_MS']);
    });

    test('modules spread into FirebaseService are imported only by the data layer', () => {
        const spread = new Set(listJs(FIREBASE).filter(f => /^export const \w+Methods\b/m.test(fs.readFileSync(f, 'utf8'))));
        const outside = listJs(JS).filter(f => !f.startsWith(FIREBASE + path.sep));
        const found = [];
        for (const f of outside) {
            for (const s of parse(fs.readFileSync(f, 'utf8')).body) {
                if (s.type !== 'ImportDeclaration' && s.type !== 'ExportNamedDeclaration' && s.type !== 'ExportAllDeclaration') continue;
                if (!s.source || !s.source.value.startsWith('.')) continue;
                if (spread.has(path.resolve(path.dirname(f), s.source.value))) found.push(`${path.relative(JS, f).replace(/\\/g, '/')} → ${s.source.value}`);
            }
        }
        expect(spread.size).toBeGreaterThan(5);
        expect(found).toEqual([]);
    });
});
