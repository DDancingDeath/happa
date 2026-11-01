/**
 * @jest-environment node
 */
/**
 * Architecture ratchet (docs/architecture.md §6).
 *
 * Scans every file under www/js (except __tests__ and tip/) and counts, per
 * file, the source LINES that break a layering rule:
 *
 *   firestore     direct Firestore access: `.collection(` / `.collectionGroup(`,
 *                 `firebase.firestore(` and `firebase.firestore.<x>` (FieldValue…),
 *                 `.runTransaction(` / `.batch(` on anything, `.doc(` on `db`,
 *                 `<x>.db` or `getDb()`, `.where(a, op, b)`, `.onSnapshot(`,
 *                 `.waitForPendingWrites(`, get/set/update/delete on a transaction
 *                 (`tx` / `transaction`), commit/set/update/delete on a `batch`.
 *                 Ways round it count too: any `.db` (`FirebaseService.db`,
 *                 `window.db`, `const { db } = …`); `<FirebaseService>.<x>Ref(` (and
 *                 destructuring a `…Ref` from it), through any import name or alias
 *                 of firestore-service.js; `firebase` used for anything but `.auth`
 *                 or `typeof` (`const fb = firebase`, `window.firebase.firestore()`,
 *                 `globalThis.firebase`…); an import / `import()` / re-export whose
 *                 specifier names "firebase" other than our own `firebase/` folder
 *                 (the SDK, CDN URLs, firebaseConfig.js).
 *   moneyMath     arithmetic on money or quantity: `Math.round/floor/ceil/trunc(...)`
 *                 of an expression that names an amount; `Math.round(x * 100) / 100`
 *                 (hand-made paise rounding); `*`, `/`, `%` with an amount on either
 *                 side; `+` / `-` with an amount on both sides; `+=` / `-=` / `*=` /
 *                 `/=` with an amount on either side; `.reduce(` whose callback adds
 *                 or subtracts and whose list or callback names an amount. "Names an
 *                 amount" = an identifier, property or `x["prop"]` in the expression
 *                 has a camelCase word from MONEY_WORDS (total, rate, qty, kg, paid,
 *                 due, cash, sum, sales, expected, …).
 *   domNumber     `parseFloat(` / `parseInt(` / `Number(` / unary `+` of
 *                 `.textContent` / `.innerText` / `.innerHTML`, and
 *                 `Helpers.getElementNumber/getElementInt(` (numbers read back
 *                 from the screen instead of from the data).
 *   appStateWrite `AppState.<x> = …` (any assignment operator), `++` / `--`,
 *                 `delete AppState.<x>`, mutating array calls (`push`, `splice`,
 *                 `sort`, …) on `AppState.<x>`, `Object.assign(AppState.<x>, …)`.
 *                 Writes through an alias (`const s = AppState.stock; s.x = 1`)
 *                 are not seen.
 *   dateMath      calendar arithmetic: `new Date(...)` with `+ - * /` in its
 *                 arguments; `+` / `-` on `new Date(...)` or a
 *                 `getTime/getDate/getMonth/getFullYear/getDay/getHours()` call;
 *                 `setDate/setMonth/setFullYear/setHours/setMinutes/setTime(...)`
 *                 with arithmetic in the argument; whole days of milliseconds
 *                 applied to a variable (`x / 86400000`, `Date.now() - n * DAY_MS`;
 *                 defining `DAY_MS = 24 * 60 * 60 * 1000` is fine).
 *                 Elapsed-time checks (`Date.now() - x.at < TTL`) do not count.
 *
 * Exemptions (the layer that owns the thing): the repositories may call Firestore
 * (firebase/**, with firebase/repos/, and the Rentals repository rent-store.js /
 * rent-receipt-store.js, kept in rentals/ because they load only with Rentals);
 * utils/** and the pure rentals files (rent-math, rent-views, rent-public) may
 * do money and date arithmetic. Every other check still applies there, so the
 * calc layer stays free of Firestore, AppState writes and DOM reads.
 *
 * firestore is absolute (phase 4): outside the repositories the count must be 0
 * and the baseline may hold no firestore entry, so it can never come back.
 *
 * It is a heuristic over the parsed AST (acorn), so comments and strings never
 * count, nor do sort comparators (`b.total - a.total`), text built with `+`
 * (`'₹' + total`) or `html += …`. Known false positives: names that merely
 * contain a money word (`totalDocs`).
 *
 * Two checks:
 *  1. The scan against tests/architecture-baseline.json: fails when a count goes
 *     up or a new file has one; prints what to lower when counts go down
 *     (`ARCH_BASELINE=lower npx jest architecture-guard` lowers, never raises).
 *  2. The baseline against the PR base (`git show origin/<base>:tests/architecture-baseline.json`):
 *     any raised number needs an entry in `exceptions` ({file, category, from,
 *     to, reason, issue}). Skipped when git or the base ref is not available,
 *     unless ARCH_REQUIRE_BASE=1 (set by ci.yml on pull requests, after fetching the base).
 *     `ARCH_BASELINE=reset` (local only, refused when CI is set) writes the exact
 *     counts and adds exception stubs to fill in.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const acorn = require('acorn');
const walk = require('acorn-walk');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const BASELINE_REL = 'tests/architecture-baseline.json';
const BASELINE_FILE = path.join(ROOT, BASELINE_REL);
const SCAN_ROOT = 'www/js';
const SKIP_DIRS = new Set(['www/js/__tests__', 'www/js/tip']);
const CATEGORIES = ['firestore', 'moneyMath', 'domNumber', 'appStateWrite', 'dateMath'];
const PURE_RENTALS = new Set([
    'www/js/rentals/rent-math.js',
    'www/js/rentals/rent-views.js',
    'www/js/rentals/rent-public.js'
]);
/** Repositories outside firebase/: the Rentals data access, loaded only with Rentals (#170). */
const RENTALS_REPOSITORIES = new Set([
    'www/js/rentals/rent-store.js',
    'www/js/rentals/rent-receipt-store.js',
    'www/js/rentals/rent-deposit-store.js'
]);
/** Files that may talk to Firestore (docs/architecture.md: repositories). */
const isRepository = (file) => file.startsWith('www/js/firebase/') || RENTALS_REPOSITORIES.has(file);

/** Categories a file is allowed to have (its layer owns them). */
function exemptCategories(file) {
    if (isRepository(file)) return ['firestore'];
    if (file.startsWith('www/js/utils/') || PURE_RENTALS.has(file)) return ['moneyMath', 'dateMath'];
    return [];
}

const MONEY_WORDS = new Set([
    'rate', 'rates', 'qty', 'quantity', 'quantities', 'kg', 'kgs', 'weight', 'weights',
    'amount', 'amounts', 'amt', 'total', 'totals', 'sum', 'subtotal', 'paid', 'due', 'dues',
    'price', 'prices', 'cost', 'costs', 'profit', 'profits', 'margin', 'margins',
    'cash', 'online', 'balance', 'balances', 'labour', 'labor', 'rent', 'rents',
    'expense', 'expenses', 'payable', 'receivable', 'received', 'expected', 'outstanding',
    'sales', 'discount', 'net', 'value', 'values'
]);
// `html += row(total)` builds text, not a figure.
const TEXT_WORDS = new Set(['html', 'text', 'str', 'string', 'msg', 'message', 'csv', 'label', 'title', 'content', 'markup']);
const MATH_ROUNDING = new Set(['round', 'floor', 'ceil', 'trunc']);
const ARRAY_MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);
const DATE_GETTERS = new Set(['getTime', 'getDate', 'getMonth', 'getFullYear', 'getDay', 'getHours']);
const DATE_SETTERS = new Set(['setDate', 'setMonth', 'setFullYear', 'setHours', 'setMinutes', 'setTime']);
const DOM_TEXT = new Set(['textContent', 'innerText', 'innerHTML']);
const NUMBER_PARSERS = new Set(['parseFloat', 'parseInt', 'Number']);
const ARITH = new Set(['+', '-', '*', '/', '%']);
const TEXT_CALL = /^(format\w*|t|tx|tn|L|toFixed|toLocaleString|toString|padStart|join|escapeHtml)$/;

const words = (name) => String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const unchain = (node) => (node && node.type === 'ChainExpression' ? node.expression : node);

/** Identifier, property and `x["prop"]` names anywhere under `node`. */
function namesIn(node) {
    const out = [];
    walk.full(node, (n) => {
        if (n.type === 'Identifier') out.push(n.name);
        else if (n.type === 'MemberExpression') {
            if (!n.computed && n.property.type === 'Identifier') out.push(n.property.name);
            else if (n.computed && n.property.type === 'Literal' && typeof n.property.value === 'string') out.push(n.property.value);
        }
    });
    return out;
}

const namesMoney = (node) => namesIn(node).some(name => words(name).some(w => MONEY_WORDS.has(w)));
const namesText = (node) => namesIn(node).some(name => words(name).some(w => TEXT_WORDS.has(w)));

function isStringy(node) {
    const n = unchain(node);
    if (!n) return false;
    if (n.type === 'Literal') return typeof n.value === 'string';
    if (n.type === 'TemplateLiteral') return true;
    if (n.type === 'BinaryExpression' && n.operator === '+') return isStringy(n.left) || isStringy(n.right);
    if (n.type === 'ConditionalExpression') return isStringy(n.consequent) || isStringy(n.alternate);
    if (n.type === 'CallExpression') {
        const c = unchain(n.callee);
        const name = c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' && !c.computed ? c.property.name : '');
        return TEXT_CALL.test(name);
    }
    return false;
}

/** `a.b.c` → 'a' (the identifier the member chain starts from). */
function rootName(node) {
    let n = unchain(node);
    while (n && (n.type === 'MemberExpression' || n.type === 'ChainExpression')) n = unchain(n.type === 'MemberExpression' ? n.object : n);
    return n && n.type === 'Identifier' ? n.name : null;
}

const TX_NAMES = new Set(['tx', 'transaction']);
const TX_OPS = new Set(['get', 'set', 'update', 'delete']);
const BATCH_OPS = new Set(['set', 'update', 'delete', 'commit']);

const calleeProp = (call) => {
    const c = unchain(call.callee);
    return c && c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' ? c.property.name : null;
};

function isDbObject(node) {
    const n = unchain(node);
    if (!n) return false;
    if (n.type === 'Identifier') return n.name === 'db';
    if (n.type === 'MemberExpression' && !n.computed) return n.property.name === 'db';
    if (n.type === 'CallExpression') {
        const c = unchain(n.callee);
        return c.type === 'Identifier' ? c.name === 'getDb' : (c.type === 'MemberExpression' && c.property.name === 'getDb');
    }
    return false;
}

function isDateValue(node) {
    const n = unchain(node);
    if (!n) return false;
    if (n.type === 'NewExpression') return n.callee.type === 'Identifier' && n.callee.name === 'Date';
    if (n.type === 'CallExpression') {
        const c = unchain(n.callee);
        return c.type === 'MemberExpression' && !c.computed && DATE_GETTERS.has(c.property.name);
    }
    return false;
}

/** Value of an expression made only of number literals, else null. */
function constValue(node) {
    if (node.type === 'Literal') return typeof node.value === 'number' ? node.value : null;
    if (node.type !== 'BinaryExpression' || !ARITH.has(node.operator)) return null;
    const a = constValue(node.left);
    const b = constValue(node.right);
    if (a === null || b === null) return null;
    return { '+': a + b, '-': a - b, '*': a * b, '/': a / b, '%': a % b }[node.operator];
}

/** A whole number of days in ms (86400000, `24 * 60 * 60 * 1000`, a week), or a DAY_MS / msPerDay name. */
function isDayMs(node) {
    const n = unchain(node);
    if (!n) return false;
    const v = constValue(n);
    if (v !== null) return v > 0 && v % 86400000 === 0;
    const name = n.type === 'Identifier' ? n.name : (n.type === 'MemberExpression' && !n.computed ? n.property.name : '');
    const w = words(name);
    return w.includes('ms') && w.some(x => ['day', 'days', 'week', 'weeks'].includes(x));
}

function hasArithmetic(nodes) {
    let found = false;
    for (const node of nodes) {
        walk.full(node, (n) => {
            if (n.type === 'BinaryExpression' && ARITH.has(n.operator) && !isStringy(n)) found = true;
        });
    }
    return found;
}

function readsDomText(node) {
    let found = false;
    walk.full(node, (n) => {
        if (n.type === 'MemberExpression' && !n.computed && DOM_TEXT.has(n.property.name)) found = true;
    });
    return found;
}

function isMathRounding(node) {
    const n = unchain(node);
    if (!n || n.type !== 'CallExpression') return false;
    const prop = calleeProp(n);
    return !!prop && MATH_ROUNDING.has(prop) && rootName(n.callee) === 'Math';
}

/**
 * Lines per category in one source text (no exemptions applied).
 * @param {string} source
 * @returns {Object<string, number>}
 */
function scanSource(source) {
    const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
    const lines = Object.fromEntries(CATEGORIES.map(c => [c, new Set()]));
    const hit = (cat, node) => lines[cat].add(node.loc.start.line);

    // `list.sort((a, b) => b.total - a.total)` orders rows; it computes no figure.
    const comparators = new Set();
    walk.full(ast, (node) => {
        if (node.type === 'CallExpression' && calleeProp(node) === 'sort' && node.arguments[0] && /Function/.test(node.arguments[0].type)) {
            walk.full(node.arguments[0].body, (n) => { if (n.type === 'BinaryExpression' && n.operator === '-') comparators.add(n); });
        }
    });

    walk.full(ast, (node) => {
        switch (node.type) {
            case 'CallExpression': {
                const callee = unchain(node.callee);
                const prop = calleeProp(node);
                // firestore
                if (prop === 'collection' || prop === 'collectionGroup') hit('firestore', node);
                else if (prop === 'firestore' && rootName(callee) === 'firebase') hit('firestore', node);
                else if (prop === 'runTransaction' || prop === 'batch') hit('firestore', node);
                else if (prop === 'doc' && isDbObject(callee.object)) hit('firestore', node);
                else if (prop === 'onSnapshot' || prop === 'waitForPendingWrites' || (prop === 'where' && node.arguments.length === 3)) hit('firestore', node);
                else if (prop && TX_OPS.has(prop) && callee.object.type === 'Identifier' && TX_NAMES.has(callee.object.name)) hit('firestore', node);
                else if (prop && BATCH_OPS.has(prop) && callee.object.type === 'Identifier' && callee.object.name === 'batch') hit('firestore', node);
                // moneyMath: Math.round(amount)
                if (isMathRounding(node) && node.arguments.some(namesMoney)) hit('moneyMath', node);
                // moneyMath: list.reduce((s, x) => s + x.amount, 0)
                if (prop === 'reduce' && node.arguments[0] && /Function/.test(node.arguments[0].type)) {
                    const fn = node.arguments[0];
                    let adds = false;
                    walk.full(fn.body, (n) => {
                        if (n.type === 'BinaryExpression' && (n.operator === '+' || n.operator === '-') && !isStringy(n)) adds = true;
                    });
                    if (adds && (namesMoney(callee.object) || namesMoney(fn.body))) hit('moneyMath', node);
                }
                // domNumber
                if (callee.type === 'Identifier' && NUMBER_PARSERS.has(callee.name) && node.arguments.some(readsDomText)) hit('domNumber', node);
                if (prop && NUMBER_PARSERS.has(prop) && rootName(callee) === 'Number' && node.arguments.some(readsDomText)) hit('domNumber', node);
                if (prop === 'getElementNumber' || prop === 'getElementInt') hit('domNumber', node);
                // appStateWrite
                if (prop && ARRAY_MUTATORS.has(prop) && rootName(callee.object) === 'AppState') hit('appStateWrite', node);
                if (prop === 'assign' && rootName(callee) === 'Object' && node.arguments[0] && rootName(node.arguments[0]) === 'AppState') hit('appStateWrite', node);
                // dateMath
                if (prop && DATE_SETTERS.has(prop) && hasArithmetic(node.arguments)) hit('dateMath', node);
                break;
            }
            case 'MemberExpression':
                // firebase.firestore.FieldValue / .Timestamp / .FieldPath
                if (!node.computed && node.object.type === 'MemberExpression' && !node.object.computed
                    && node.object.property.name === 'firestore' && rootName(node.object) === 'firebase') hit('firestore', node);
                break;
            case 'NewExpression':
                if (node.callee.type === 'Identifier' && node.callee.name === 'Date' && hasArithmetic(node.arguments)) hit('dateMath', node);
                break;
            case 'BinaryExpression': {
                if (comparators.has(node) || isStringy(node.left) || isStringy(node.right)) break;
                const op = node.operator;
                if (!ARITH.has(op)) break;
                if ((op === '*' || op === '/' || op === '%') && (namesMoney(node.left) || namesMoney(node.right))) hit('moneyMath', node);
                if ((op === '+' || op === '-') && namesMoney(node.left) && namesMoney(node.right)) hit('moneyMath', node);
                // Math.round(x * 100) / 100: paise rounding by hand (money.round2 owns it)
                if (op === '/' && isMathRounding(node.left) && [10, 100, 1000].includes(constValue(node.right))) hit('moneyMath', node);
                if ((op === '+' || op === '-') && (isDateValue(node.left) || isDateValue(node.right))) hit('dateMath', node);
                // Day milliseconds applied to a variable (a constant like `DAY_MS = 24 * 60 * 60 * 1000` is fine)
                if ((isDayMs(node.left) && constValue(node.right) === null) || (isDayMs(node.right) && constValue(node.left) === null)) hit('dateMath', node);
                break;
            }
            case 'AssignmentExpression':
                if (node.left.type === 'MemberExpression' && rootName(node.left) === 'AppState') hit('appStateWrite', node);
                if (['+=', '-=', '*=', '/='].includes(node.operator) && !isStringy(node.right) && !namesText(node.left)
                    && (namesMoney(node.left) || namesMoney(node.right))) hit('moneyMath', node);
                break;
            case 'UpdateExpression':
                if (rootName(node.argument) === 'AppState') hit('appStateWrite', node);
                break;
            case 'UnaryExpression':
                if (node.operator === 'delete' && rootName(node.argument) === 'AppState') hit('appStateWrite', node);
                if (node.operator === '+' && readsDomText(node.argument)) hit('domNumber', node);
                break;
            default:
                break;
        }
    });
    firestoreDetours(ast, (node) => hit('firestore', node));
    return Object.fromEntries(CATEGORIES.map(c => [c, lines[c].size]));
}

const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self', 'global']);

/** An import specifier that reaches Firebase other than through our own firebase/ folder. */
function isFirebaseSpecifier(spec) {
    if (typeof spec !== 'string' || !/firebase/i.test(spec)) return false;
    return !(spec.startsWith('.') && spec.split(/[/?#]/).includes('firebase'));
}

/**
 * Ways to reach Firestore without the direct calls above (review of #199): SDK
 * imports, FirebaseService.db / …Ref() through any name, the firebase global through
 * window / globalThis or an alias.
 */
function firestoreDetours(ast, hit) {
    // Local names of firestore-service.js (import names, namespaces, `const S = FirebaseService`).
    const service = new Set(['FirebaseService']);
    const isService = (node) => {
        const n = unchain(node);
        if (!n) return false;
        if (n.type === 'Identifier') return service.has(n.name);
        if (n.type === 'MemberExpression') return isService(n.object) || (!n.computed && n.property.name === 'FirebaseService');
        return false;
    };
    walk.full(ast, (node) => {
        if (node.type === 'ImportDeclaration' && /firestore-service(\.js)?$/.test(node.source.value)) {
            node.specifiers.forEach(sp => service.add(sp.local.name));
        }
    });
    for (let grew = true; grew;) {
        grew = false;
        walk.full(ast, (node) => {
            if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && isService(node.init) && !service.has(node.id.name)) {
                service.add(node.id.name);
                grew = true;
            }
        });
    }

    walk.full(ast, (node) => {
        switch (node.type) {
            case 'ImportDeclaration':
            case 'ExportAllDeclaration':
            case 'ExportNamedDeclaration':
            case 'ImportExpression':
                if (node.source && isFirebaseSpecifier(node.source.value)) hit(node);
                break;
            case 'MemberExpression':
                if (!node.computed && node.property.name === 'db') hit(node);
                break;
            case 'CallExpression': {
                const callee = unchain(node.callee);
                if (callee.type === 'MemberExpression' && !callee.computed && /Ref$/.test(callee.property.name) && isService(callee.object)) hit(node);
                if (callee.type === 'Identifier' && callee.name === 'require' && isFirebaseSpecifier(node.arguments[0]?.value)) hit(node);
                break;
            }
            case 'VariableDeclarator':
                // const { db, cashSessionRef } = FirebaseService
                if (node.id.type === 'ObjectPattern' && node.init && (isService(node.init) || /^(window|globalThis|self|global)$/.test(rootName(node.init) || ''))
                    && node.id.properties.some(p => p.type === 'Property' && !p.computed && /^(db|firebase)$|Ref$/.test(p.key.name || p.key.value))) hit(node);
                break;
            default:
                break;
        }
    });

    // The firebase global: only `firebase.auth` and `typeof firebase` are allowed outside the repositories.
    walk.fullAncestor(ast, (node, _state, ancestors) => {
        const isGlobalRef = (node.type === 'Identifier' && node.name === 'firebase')
            || (node.type === 'MemberExpression' && !node.computed && node.property.name === 'firebase'
                && node.object.type === 'Identifier' && GLOBAL_OBJECTS.has(node.object.name));
        if (!isGlobalRef) return;
        let i = ancestors.length - 2;
        let parent = ancestors[i];
        while (parent && parent.type === 'ChainExpression') parent = ancestors[--i];
        if (parent && parent.type === 'MemberExpression' && parent.object === node && !parent.computed && parent.property.name === 'auth') return;
        if (parent && parent.type === 'UnaryExpression' && parent.operator === 'typeof') return;
        hit(node);
    });
}

/** Counts of one file with its layer's exemptions applied. */
function scanFile(file, source) {
    const counts = scanSource(source);
    exemptCategories(file).forEach(c => { counts[c] = 0; });
    return counts;
}

function listFiles() {
    const out = [];
    const visit = (rel) => {
        for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
            const child = `${rel}/${entry.name}`;
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(child)) visit(child);
            } else if (entry.name.endsWith('.js')) {
                out.push(child);
            }
        }
    };
    visit(SCAN_ROOT);
    return out.sort();
}

function scanAll() {
    const counts = {};
    for (const file of listFiles()) counts[file] = scanFile(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
    return counts;
}

const nonZero = (row) => Object.fromEntries(CATEGORIES.filter(c => row && row[c] > 0).map(c => [c, row[c]]));
const countOf = (files, file, cat) => (files && files[file] && files[file][cat]) || 0;

function totalsOf(files) {
    const totals = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
    Object.values(files).forEach(row => CATEGORIES.forEach(c => { totals[c] += (row && row[c]) || 0; }));
    return totals;
}

/** Entries of `next` above `prev` (a file missing from `prev` counts as 0). */
function raisedEntries(next, prev) {
    const out = [];
    for (const [file, row] of Object.entries(next)) {
        for (const cat of CATEGORIES) {
            const from = countOf(prev, file, cat);
            const to = (row && row[cat]) || 0;
            if (to > from) out.push({ file, category: cat, from, to });
        }
    }
    return out;
}

/** Entries of `next` below `prev`, and files of `prev` gone from `next`. */
function loweredEntries(next, prev) {
    const out = [];
    for (const [file, row] of Object.entries(prev)) {
        if (!next[file]) { out.push(`${file}: no longer scanned (moved or deleted)`); continue; }
        CATEGORIES.forEach(cat => {
            if (next[file][cat] < countOf(prev, file, cat)) out.push(`${file}: ${cat} ${countOf(prev, file, cat)} -> ${next[file][cat]}`);
        });
    }
    return out;
}

const isRecorded = (raise, exceptions) => (exceptions || []).some(e => e && e.file === raise.file
    && e.category === raise.category && e.from === raise.from && e.to === raise.to
    && typeof e.reason === 'string' && e.reason.trim() && e.reason.trim() !== 'TODO'
    && (typeof e.issue === 'number' || /^#?\d+$/.test(String(e.issue || ''))));

function writeBaseline(files, exceptions) {
    const sorted = {};
    Object.keys(files).sort().forEach(f => {
        const row = nonZero(files[f]);
        if (Object.keys(row).length) sorted[f] = row;
    });
    const doc = {
        _readme: 'Architecture ratchet baseline (www/js/__tests__/architecture-guard.test.js, docs/architecture.md section 6). Counts may only go down: lower them with ARCH_BASELINE=lower npx jest architecture-guard. A raise needs an entry in exceptions: {file, category, from, to, reason, issue}.',
        totals: totalsOf(sorted),
        files: sorted,
        exceptions: exceptions || []
    };
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(doc, null, 2)}\n`);
}

/** The baseline on the PR base, or why it can't be read. */
function readBaseBaseline() {
    const ref = process.env.ARCH_BASE_REF || `origin/${process.env.GITHUB_BASE_REF || 'main'}`;
    try {
        execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
    } catch (_) {
        return { ref, missing: 'ref' };
    }
    try {
        const text = execFileSync('git', ['show', `${ref}:${BASELINE_REL}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
        return { ref, baseline: JSON.parse(text) };
    } catch (_) {
        return { ref, missing: 'file' };
    }
}

describe('architecture ratchet (docs/architecture.md)', () => {
    const mode = process.env.ARCH_BASELINE;
    const current = scanAll();
    const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    const base = baseline.files || {};

    test('scans all of www/js except tests and tip/', () => {
        const files = Object.keys(current);
        expect(files).toEqual(expect.arrayContaining([
            'www/js/main.js', 'www/js/modules/purchase.js', 'www/js/rentals/rent-math.js',
            'www/js/ui/ui-manager.js', 'www/js/services/printer.js', 'www/js/firebase/firestore-service.js',
            'www/js/utils/money.js', 'www/js/auth/authentication.js'
        ]));
        expect(files.some(f => f.startsWith('www/js/__tests__/') || f.startsWith('www/js/tip/'))).toBe(false);
    });

    test('no count goes up and no new file breaks a rule', () => {
        if (mode === 'reset') {
            if (process.env.CI) throw new Error('ARCH_BASELINE=reset is local only (CI is set).');
            const exceptions = [...(baseline.exceptions || [])];
            const prior = readBaseBaseline();
            if (prior.baseline) {
                raisedEntries(current, prior.baseline.files || {})
                    .filter(r => !isRecorded(r, exceptions))
                    .forEach(r => exceptions.push({ ...r, reason: 'TODO', issue: null }));
            }
            writeBaseline(current, exceptions);
            return;
        }

        const raised = raisedEntries(current, base);
        const lowered = loweredEntries(current, base);

        if (mode === 'lower' && lowered.length) {
            const next = {};
            Object.keys(base).filter(f => current[f]).forEach(f => {
                next[f] = Object.fromEntries(CATEGORIES.map(c => [c, Math.min(countOf(base, f, c), current[f][c])]));
            });
            writeBaseline(next, baseline.exceptions);
        } else if (lowered.length) {
            // Not a failure: the ratchet moved the right way.
            console.log(['Architecture counts went DOWN. Lower tests/architecture-baseline.json',
                '(ARCH_BASELINE=lower npx jest architecture-guard) so they cannot creep back:',
                ...lowered.map(l => `  ${l}`)].join('\n'));
        }

        if (raised.length) {
            throw new Error([
                'Architecture ratchet: code gained Firestore access outside firebase/, money/qty/date',
                'arithmetic outside utils/, numbers read from the screen or AppState writes',
                '(docs/architecture.md, "Dependency rules"). Move the logic to its layer or call the existing function:',
                ...raised.map(r => `  ${r.file}: ${r.category} ${r.from} -> ${r.to}${base[r.file] ? '' : ' (new file)'}`)
            ].join('\n'));
        }
    });

    test('every raise against the PR base is a recorded exception', () => {
        const prior = readBaseBaseline();
        if (!prior.baseline) {
            const why = prior.missing === 'ref' ? `${prior.ref} is not available (no git / shallow clone)` : `${prior.ref} has no ${BASELINE_REL} yet`;
            if (prior.missing === 'ref' && process.env.ARCH_REQUIRE_BASE === '1') throw new Error(`Cannot compare the baseline with the PR base: ${why}.`);
            console.log(`Architecture baseline not compared with the base: ${why}.`);
            return;
        }
        const unrecorded = raisedEntries(base, prior.baseline.files || {}).filter(r => !isRecorded(r, baseline.exceptions));
        if (unrecorded.length) {
            throw new Error([
                `tests/architecture-baseline.json raises counts above ${prior.ref} without a recorded exception.`,
                'Move the logic instead, or add to "exceptions": {file, category, from, to, reason, issue}:',
                ...unrecorded.map(r => `  ${JSON.stringify(r)}`)
            ].join('\n'));
        }
    });

    test('no Firestore access outside the repositories, ever (absolute: no baseline entries)', () => {
        const outside = Object.entries(current)
            .filter(([file, row]) => !isRepository(file) && row.firestore > 0)
            .map(([file, row]) => `${file}: ${row.firestore}`);
        expect(outside).toEqual([]);
        expect(Object.entries(base).filter(([, row]) => row.firestore).map(([file]) => file)).toEqual([]);
        expect((baseline.exceptions || []).filter(e => e && e.category === 'firestore')).toEqual([]);
    });

    test('baseline totals match its file rows', () => {
        expect(baseline.totals).toEqual(totalsOf(base));
        expect(Array.isArray(baseline.exceptions)).toBe(true);
    });

    test.each([
        ['const t = Math.round(qty * rate);', { moneyMath: 1 }],
        ['const due = billTotal - paidAmount;', { moneyMath: 1 }],
        ['const s = bills.reduce((a, b) => a + b.total, 0);', { moneyMath: 1 }],
        ['cashPaid += p.cash;', { moneyMath: 1 }],
        ['for (const b of bills) sum += b.total;', { moneyMath: 1 }],
        ['acc += b.amount;', { moneyMath: 1 }],
        ['const r = Math.round(x * 100) / 100;', { moneyMath: 1 }],
        ['const gap = b["total"] - b["paid"];', { moneyMath: 1 }],
        // cash-management.js:766 (C8) and modules/money.js:650-651 (AC10)
        ['const difference = (actualAmount ?? 0) - expected;', { moneyMath: 1 }],
        ['const sum = items.reduce((a, x) => a + x.sales, 0);\nconst okItems = Math.abs(sum - m.M1.total) <= 1;', { moneyMath: 2 }],
        ['el.textContent = "₹" + total;', {}],
        ['html += row(item.total);', {}],
        ['count += 1;', {}],
        ['const n = items.length * 2;', {}],
        ['rows.sort((a, b) => b.total - a.total);', {}],
        ['el.textContent = (net >= 0 ? "+" : "") + formatCurrency(netTotal);', {}],
        ['const total = Number(document.getElementById("billTotal").textContent);', { domNumber: 1 }],
        ['db.collection(col("drafts")).doc(id).get();', { firestore: 1 }],
        ['FirebaseService.db.runTransaction(async tx => {});', { firestore: 1 }],
        ['const snap = await tx.get(ref);\ntx.update(ref, { a: 1 });', { firestore: 2 }],
        ['batch.delete(doc.ref);\nawait batch.commit();', { firestore: 2 }],
        ['const q = ref.where("userId", "==", uid);', { firestore: 1 }],
        ['const off = query.onSnapshot(fn);', { firestore: 1 }],
        ['const at = firebase.firestore.FieldValue.serverTimestamp();', { firestore: 1 }],
        ['const kept = rows.where(x => x.ok); map.set("a", 1); list.delete(0);', {}],
        // Ways round the direct calls (review of #199): each must count outside the repositories
        ['import { getFirestore } from "firebase/firestore";', { firestore: 1 }],
        ['import * as sdk from "https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js";', { firestore: 1 }],
        ['export { db } from "../../firebaseConfig.js";', { firestore: 1 }],
        ['const m = await import("firebase/firestore");', { firestore: 1 }],
        ['import { FirebaseService as FS } from "../firebase/firestore-service.js";\nconst d = FS.db;', { firestore: 1 }],
        ['import * as S from "../firebase/firestore-service.js";\nS.FirebaseService.cashSessionRef("s1").update({ a: 1 });', { firestore: 1 }],
        ['FirebaseService.cashSessionRef(id).update({ closingBalance: 1 });', { firestore: 1 }],
        ['const S = FirebaseService;\nconst r = S.sessionRef(1);', { firestore: 1 }],
        ['const d = FirebaseService.db;\nawait d.runTransaction(async () => {});', { firestore: 2 }],
        ['const { db } = FirebaseService;', { firestore: 1 }],
        ['const { cashSessionRef: ref } = FirebaseService;', { firestore: 1 }],
        ['const x = window.db;', { firestore: 1 }],
        ['window.firebase.firestore();', { firestore: 1 }],
        ['globalThis.firebase.firestore.FieldValue.increment(1);', { firestore: 1 }],
        ['const fb = firebase; fb.firestore.FieldValue.increment(1);', { firestore: 1 }],
        ['const fb = window.firebase;', { firestore: 1 }],
        ['const { firebase: fb } = window;', { firestore: 1 }],
        ['useSdk(firebase);', { firestore: 1 }],
        ['const t = store.runTransaction(fn);', { firestore: 1 }],
        ['const b = anything.batch();', { firestore: 1 }],
        // ...while the sanctioned paths stay free
        ['import { FirebaseService } from "../firebase/firestore-service.js";\nFirebaseService.loadUsers();', {}],
        ['import { userProfile } from "../firebase/repos/users.js";\nconst p = userProfile("u1");', {}],
        ['const u = firebase.auth().currentUser;\nif (typeof firebase === "undefined") {}', {}],
        ['const u = globalThis.firebase?.auth?.().currentUser;', {}],
        ['const r = billRef(b); AnomaliesManager.openRef(1);', {}],
        ['AppState.stock = stock; AppState.items.push(x);', { appStateWrite: 1 }],
        ['const end = new Date(y, m, d + 1);', { dateMath: 1 }],
        ['tomorrow.setDate(tomorrow.getDate() + 1);', { dateMath: 1 }],
        ['const days = (b - a) / 86400000;', { dateMath: 1 }],
        ['const from = Date.now() - n * DAY_MS;', { dateMath: 1 }],
        ['const from = Date.now() - 30 * 24 * 60 * 60 * 1000;', { dateMath: 1 }],
        ['const WEEK_MS = 7 * 24 * 60 * 60 * 1000;', {}],
        ['const fresh = Date.now() - cache.at < TTL_MS;', {}],
        ['// Math.round(qty * rate) in a comment\nconst s = "total / qty";', {}]
    ])('detector: %s', (src, expected) => {
        expect(nonZero(scanSource(src))).toEqual(expected);
    });

    test('a raise passes only with a filled-in matching exception', () => {
        const raise = { file: 'www/js/ui/x.js', category: 'moneyMath', from: 0, to: 2 };
        expect(isRecorded(raise, [{ ...raise, reason: 'Printer layout needs widths', issue: 77 }])).toBe(true);
        expect(isRecorded(raise, [{ ...raise, reason: 'TODO', issue: null }])).toBe(false);
        expect(isRecorded(raise, [{ ...raise, to: 1, reason: 'older raise', issue: '#77' }])).toBe(false);
    });

    describe('a new file outside its layer fails', () => {
        const maths = 'export const lineTotal = (qty, rate) => Math.round(qty * rate);';
        const write = 'export const save = (db, x) => db.collection("bills").doc(x.id).set(x);';
        const state = 'import { AppState } from "../utils/state.js"; export const keep = (s) => { AppState.stock = s; };';
        test.each([
            ['www/js/ui/new-widget.js', maths, ['moneyMath']],
            ['www/js/services/new-sync.js', write, ['firestore']],
            ['www/js/services/new-calc.js', maths, ['moneyMath']],
            ['www/js/utils/new-repo.js', write, ['firestore']],
            ['www/js/utils/new-store.js', state, ['appStateWrite']],
            ['www/js/utils/new-calc.js', maths, []],
            ['www/js/firebase/new-repo.js', write, []],
            ['www/js/firebase/repos/new-repo.js', write, []],
            ['www/js/rentals/rent-store.js', write, []],
            ['www/js/rentals/rentals.js', write, ['firestore']],
            ['www/js/modules/new-page.js', write, ['firestore']]
        ])('%s', (file, src, failing) => {
            const raised = raisedEntries({ [file]: scanFile(file, src) }, base);
            expect(raised.map(r => r.category)).toEqual(failing);
        });
    });
});
