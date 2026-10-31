/**
 * @jest-environment node
 */
/**
 * Architecture ratchet (docs/architecture.md §6).
 *
 * Page code (www/js/modules/** and www/js/rentals/**, except the pure
 * rent-math / rent-views / rent-public) should only render. This test counts,
 * per file, the places where it still does something else, and compares the
 * counts with tests/architecture-baseline.json:
 *
 *   firestore     direct Firestore access: `.collection(` / `.collectionGroup(`,
 *                 `firebase.firestore(`, and `.doc(` / `.runTransaction(` /
 *                 `.batch(` called on `db`, `<x>.db` or `getDb()`.
 *   moneyMath     arithmetic on money or quantity: `Math.round/floor/ceil/trunc(...)`
 *                 of an expression that names an amount; `*`, `/`, `%` with an
 *                 amount on either side; `+` / `-` with an amount on both sides;
 *                 `+=` / `-=` / `*=` / `/=` into an amount; `.reduce(` whose
 *                 callback adds or subtracts and whose list or callback names an
 *                 amount. "Names an amount" = some identifier or property in the
 *                 expression has a camelCase word from MONEY_WORDS (total, rate,
 *                 qty, kg, paid, due, cash, …). String concatenation is ignored.
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
 *                 with arithmetic in the argument. utils/dates.js owns these.
 *                 Elapsed-time checks (`Date.now() - x.at < TTL`) do not count.
 *
 * It is a heuristic over the parsed AST (acorn), so comments and strings never
 * count, nor do sort comparators (`b.total - a.total`) or text built with
 * `+` (`'₹' + total`, `'+' + formatCurrency(x)`). Known false positives: names
 * that merely contain a money word (`totalDocs`). A count is the number of
 * source LINES with at least one hit, so reformatting a line does not move it.
 *
 * The test fails when a count goes UP, or a file not in the baseline has a
 * non-zero count. When counts go DOWN it passes and prints which entries to
 * lower; `ARCH_BASELINE=lower npx jest architecture-guard` writes the lowered
 * baseline (it never raises a count). `ARCH_BASELINE=reset` writes the exact
 * current counts: only for a reviewed exception, and say why in the PR.
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const BASELINE_FILE = path.join(ROOT, 'tests', 'architecture-baseline.json');
const SCAN_DIRS = ['www/js/modules', 'www/js/rentals'];
// Pure rentals code: domain/calc layer already (docs/architecture.md).
const PURE_FILES = new Set([
    'www/js/rentals/rent-math.js',
    'www/js/rentals/rent-views.js',
    'www/js/rentals/rent-public.js'
]);
const CATEGORIES = ['firestore', 'moneyMath', 'domNumber', 'appStateWrite', 'dateMath'];

const MONEY_WORDS = new Set([
    'rate', 'rates', 'qty', 'quantity', 'quantities', 'kg', 'kgs', 'weight', 'weights',
    'amount', 'amounts', 'total', 'totals', 'paid', 'due', 'dues', 'price', 'prices',
    'cost', 'costs', 'profit', 'profits', 'cash', 'online', 'balance', 'balances',
    'labour', 'labor', 'rent', 'rents', 'expense', 'expenses', 'payable', 'receivable',
    'value', 'margin', 'outstanding', 'subtotal'
]);
const MATH_ROUNDING = new Set(['round', 'floor', 'ceil', 'trunc']);
const ARRAY_MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);
const DATE_GETTERS = new Set(['getTime', 'getDate', 'getMonth', 'getFullYear', 'getDay', 'getHours']);
const DATE_SETTERS = new Set(['setDate', 'setMonth', 'setFullYear', 'setHours', 'setMinutes', 'setTime']);
const DOM_TEXT = new Set(['textContent', 'innerText', 'innerHTML']);
const NUMBER_PARSERS = new Set(['parseFloat', 'parseInt', 'Number']);
const ARITH = new Set(['+', '-', '*', '/', '%']);

const words = (name) => String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Identifier and (non-computed) property names anywhere under `node`. */
function namesIn(node) {
    const out = [];
    walk.full(node, (n) => {
        if (n.type === 'Identifier') out.push(n.name);
        else if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') out.push(n.property.name);
    });
    return out;
}

const namesMoney = (node) => namesIn(node).some(name => words(name).some(w => MONEY_WORDS.has(w)));

const unchain = (node) => (node && node.type === 'ChainExpression' ? node.expression : node);

// Calls that return text: `'+' + formatCurrency(x)` is concatenation, not arithmetic.
const TEXT_CALL = /^(format\w*|t|tx|tn|L|toFixed|toLocaleString|toString|padStart|join|escapeHtml)$/;

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

/**
 * Lines per category in one source file.
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
                else if ((prop === 'doc' || prop === 'runTransaction' || prop === 'batch') && isDbObject(callee.object)) hit('firestore', node);
                // moneyMath: Math.round(amount)
                if (prop && MATH_ROUNDING.has(prop) && rootName(callee) === 'Math' && node.arguments.some(namesMoney)) hit('moneyMath', node);
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
            case 'NewExpression':
                if (node.callee.type === 'Identifier' && node.callee.name === 'Date' && hasArithmetic(node.arguments)) hit('dateMath', node);
                break;
            case 'BinaryExpression': {
                if (comparators.has(node) || isStringy(node.left) || isStringy(node.right)) break;
                const op = node.operator;
                if ((op === '*' || op === '/' || op === '%') && (namesMoney(node.left) || namesMoney(node.right))) hit('moneyMath', node);
                if ((op === '+' || op === '-') && namesMoney(node.left) && namesMoney(node.right)) hit('moneyMath', node);
                if ((op === '+' || op === '-') && (isDateValue(node.left) || isDateValue(node.right))) hit('dateMath', node);
                break;
            }
            case 'AssignmentExpression':
                if (node.left.type === 'MemberExpression' && rootName(node.left) === 'AppState') hit('appStateWrite', node);
                if (['+=', '-=', '*=', '/='].includes(node.operator) && !isStringy(node.right) && namesMoney(node.left)) hit('moneyMath', node);
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
    return Object.fromEntries(CATEGORIES.map(c => [c, lines[c].size]));
}

function listFiles() {
    const out = [];
    const visit = (rel) => {
        for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
            const child = `${rel}/${entry.name}`;
            if (entry.isDirectory()) {
                if (entry.name !== '__tests__') visit(child);
            } else if (entry.name.endsWith('.js') && !PURE_FILES.has(child)) {
                out.push(child);
            }
        }
    };
    SCAN_DIRS.forEach(visit);
    return out.sort();
}

function scanAll() {
    const counts = {};
    for (const file of listFiles()) counts[file] = scanSource(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    return counts;
}

const nonZero = (row) => Object.fromEntries(CATEGORIES.filter(c => row && row[c] > 0).map(c => [c, row[c]]));

function totalsOf(files) {
    const totals = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
    Object.values(files).forEach(row => CATEGORIES.forEach(c => { totals[c] += (row && row[c]) || 0; }));
    return totals;
}

function writeBaseline(files) {
    const sorted = {};
    Object.keys(files).sort().forEach(f => {
        const row = nonZero(files[f]);
        if (Object.keys(row).length) sorted[f] = row;
    });
    const doc = {
        _readme: 'Architecture ratchet baseline: www/js/__tests__/architecture-guard.test.js, docs/architecture.md section 6. Counts may only go down. Lower them with ARCH_BASELINE=lower npx jest architecture-guard.',
        totals: totalsOf(sorted),
        files: sorted
    };
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(doc, null, 2)}\n`);
}

describe('architecture ratchet (docs/architecture.md)', () => {
    const current = scanAll();
    const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    const base = baseline.files || {};

    test('scans page modules and rentals UI, not the pure rentals files', () => {
        const files = Object.keys(current);
        expect(files).toEqual(expect.arrayContaining(['www/js/modules/purchase.js', 'www/js/rentals/rentals.js']));
        PURE_FILES.forEach(f => expect(files).not.toContain(f));
    });

    test('no count goes up and no new file breaks a rule', () => {
        const mode = process.env.ARCH_BASELINE;
        if (mode === 'reset') writeBaseline(current);

        const raised = [];
        const lowered = [];
        for (const [file, row] of Object.entries(current)) {
            for (const cat of CATEGORIES) {
                const was = (base[file] && base[file][cat]) || 0;
                if (row[cat] > was) raised.push(`${file}: ${cat} ${was} -> ${row[cat]}${base[file] ? '' : ' (new file)'}`);
                else if (row[cat] < was) lowered.push(`${file}: ${cat} ${was} -> ${row[cat]}`);
            }
        }
        Object.keys(base).filter(f => !current[f]).forEach(f => lowered.push(`${f}: no longer scanned (moved, deleted or now pure)`));

        if (mode === 'lower' && lowered.length) {
            const next = {};
            new Set([...Object.keys(base), ...Object.keys(current)]).forEach(f => {
                if (!current[f] || !base[f]) return;
                next[f] = Object.fromEntries(CATEGORIES.map(c => [c, Math.min(base[f][c] || 0, current[f][c])]));
            });
            writeBaseline(next);
        } else if (lowered.length && mode !== 'reset') {
            // Not a failure: the ratchet moved the right way.
            console.log(['Architecture counts went DOWN. Lower tests/architecture-baseline.json',
                '(ARCH_BASELINE=lower npx jest architecture-guard) so they cannot creep back:',
                ...lowered.map(l => `  ${l}`)].join('\n'));
        }

        if (mode !== 'reset' && raised.length) {
            throw new Error([
                'Architecture ratchet: page code gained Firestore access, money/qty/date arithmetic,',
                'numbers read from the screen or AppState writes (docs/architecture.md, "Dependency rules").',
                'Move the logic into www/js/utils (calc) or a service, or call the existing function:',
                ...raised.map(r => `  ${r}`)
            ].join('\n'));
        }
    });

    test('baseline totals match its file rows', () => {
        expect(baseline.totals).toEqual(totalsOf(base));
    });

    test.each([
        ['const t = Math.round(qty * rate);', { moneyMath: 1 }],
        ['const due = billTotal - paidAmount;', { moneyMath: 1 }],
        ['const s = bills.reduce((a, b) => a + b.total, 0);', { moneyMath: 1 }],
        ['cashPaid += p.cash;', { moneyMath: 1 }],
        ['el.textContent = "₹" + total;', {}],
        ['const n = items.length * 2;', {}],
        ['const total = Number(document.getElementById("billTotal").textContent);', { domNumber: 1 }],
        ['db.collection(col("drafts")).doc(id).get();', { firestore: 1 }],
        ['FirebaseService.db.runTransaction(async tx => {});', { firestore: 1 }],
        ['AppState.stock = stock; AppState.items.push(x);', { appStateWrite: 1 }],
        ['const end = new Date(y, m, d + 1);', { dateMath: 1 }],
        ['tomorrow.setDate(tomorrow.getDate() + 1);', { dateMath: 1 }],
        ['const fresh = Date.now() - cache.at < TTL_MS;', {}],
        ['rows.sort((a, b) => b.total - a.total);', {}],
        ['el.textContent = (net >= 0 ? "+" : "") + formatCurrency(netTotal);', {}],
        ['// Math.round(qty * rate) in a comment\nconst s = "total / qty";', {}]
    ])('detector: %s', (src, expected) => {
        const got = nonZero(scanSource(src));
        expect(got).toEqual(expected);
    });
});
