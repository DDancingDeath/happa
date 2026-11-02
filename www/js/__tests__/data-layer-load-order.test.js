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
/** Array methods whose callback runs during the call. */
const ITERATES = new Set(['map', 'forEach', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex', 'flatMap', 'sort', 'from']);

/**
 * Names imported from data-layer modules that a module reads while it loads: outside functions,
 * and inside the functions that loading runs (an IIFE, a local function or class called at the
 * top, a callback handed to such a call, e.g. `[1, 7].map(n => n * DAY_MS)`).
 */
function loadTimeUses(src, file) {
    const ast = parse(src);
    const imported = new Set();
    ast.body.filter(s => s.type === 'ImportDeclaration'
        && path.resolve(path.dirname(file), s.source.value).startsWith(FIREBASE + path.sep))
        .forEach(s => s.specifiers.forEach(sp => imported.add(sp.local.name)));
    const local = new Map();
    ast.body.forEach(s => {
        const d = s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration' ? s.declaration : s;
        if (!d) return;
        if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) local.set(d.id.name, d);
        if (d.type === 'VariableDeclaration') {
            d.declarations.forEach(v => {
                if (v.id.type === 'Identifier' && v.init && (FUNCTIONS.has(v.init.type) || v.init.type === 'ClassExpression')) local.set(v.id.name, v.init);
            });
        }
    });
    const ran = new Set();
    const uses = [];
    const runs = (fn) => {
        if (!fn || ran.has(fn)) return;
        ran.add(fn);
        if (fn.type === 'ClassDeclaration' || fn.type === 'ClassExpression') {
            const ctor = fn.body.body.find(m => m.kind === 'constructor');
            if (ctor) visit(ctor.value.body, null);
            return;
        }
        visit(fn.body, null);
    };
    const visit = (node, parent) => {
        if (!node || typeof node.type !== 'string' || FUNCTIONS.has(node.type) || node.type === 'ImportDeclaration') return;
        if (node.type === 'Identifier' && imported.has(node.name)
            && !(parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed)
            && !(parent && parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand)) {
            uses.push(`${path.relative(JS, file).replace(/\\/g, '/')}:${node.loc.start.line} ${node.name}`);
        }
        if (node.type === 'CallExpression' || node.type === 'NewExpression') {
            const c = node.callee;
            if (FUNCTIONS.has(c.type) || c.type === 'ClassExpression') runs(c);
            if (c.type === 'Identifier' && local.has(c.name)) runs(local.get(c.name));
            node.arguments.forEach(a => {
                // Array callbacks run now; listeners, timers and promise callbacks run later
                const now = c.type === 'MemberExpression' && !c.computed && ITERATES.has(c.property.name);
                if (!now) return;
                if (FUNCTIONS.has(a.type)) runs(a);
                if (a.type === 'Identifier' && local.has(a.name)) runs(local.get(a.name));
            });
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

    test('…and in the functions loading runs: IIFEs, local functions and classes, callbacks', () => {
        const file = path.join(FIREBASE, 'core', 'example.js');
        const src = [
            "import { DAY_MS } from './stock-checkpoint.js';",
            'const a = (() => DAY_MS * 2)();',
            'const days = (n) => n * DAY_MS; export const SPAN = days(14);',
            'export const SPANS = [1, 7].map(n => n * DAY_MS);',
            'class C { constructor() { this.v = DAY_MS; } } export const c = new C();',
            'export const never = () => DAY_MS;',
            "if (typeof window !== 'undefined') window.addEventListener('x', () => days(1));"
        ].join('\n');
        expect(loadTimeUses(src, file).map(u => u.split(':')[1].split(' ')[0])).toEqual(['2', '3', '4', '5']);
    });

    test('modules spread into FirebaseService are imported only by the facade and each other', () => {
        const spread = new Set(listJs(FIREBASE).filter(f => /^export const \w+Methods\b/m.test(fs.readFileSync(f, 'utf8'))));
        const found = [];
        for (const f of listJs(JS)) {
            if (f === FACADE || spread.has(f)) continue;
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
