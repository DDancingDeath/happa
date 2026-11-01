/**
 * @fileoverview Guard against new un-awaited ("floating") async calls (#126).
 *
 * Every call to an async function in www/js must be awaited, returned, chained
 * with .then/.catch, assigned, or passed on (argument / array element). The
 * remaining floating calls are listed in ALLOWED with the reason they are safe
 * (see docs/async-audit.md). A new floating call fails this test: await it, or
 * add `.catch(...)` that logs (background work) / tells the user (saves).
 */
import fs from 'fs';
import path from 'path';

const JS_ROOT = path.join(__dirname, '..');

// file (relative to www/js) + called name -> reason it may stay floating.
const ALLOWED = {
    'firebase/firestore-service.js flushPendingWork': 'tab-shown render flush; catches stock errors itself',
    'main.js updateDraftCount': 'draft badge refresh; has its own try/catch',
    'main.js editBill': 'editBillDetails handler; editBill() catches and toasts its own errors',
    'modules/purchase.js addToBill': 'no awaits inside, runs synchronously before editBillItem continues',
    'modules/retail-sale.js addToSalesBill': 'no awaits inside, runs synchronously',
    'modules/settings.js connectToPrinter': 'has its own try/catch with a user toast',
    'modules/stock.js renderStock': 'UI refresh; has its own try/catch',
    'modules/stock.js renderAdjustmentHistory': 'UI refresh; has its own try/catch',
    'modules/stock.js renderDeadStock': 'UI refresh; has its own try/catch',
    'ui/infinite-scroll.js trigger': 'catches load errors and switches to the retry state',
};

// Too generic to resolve by name (console.log, many init/showTab); AuditService.log is checked explicitly.
const IGNORED_NAMES = new Set(['log', 'init', 'showTab', 'get', 'set', 'then', 'catch', 'delete', 'write', 'connect', 'disconnect']);

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(full);
        return e.name.endsWith('.js') ? [full] : [];
    });
}

function closingParen(text, open) {
    let depth = 0;
    let quote = null;
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') quote = c;
        else if (c === '(') depth++;
        else if (c === ')' && --depth === 0) return i;
    }
    return -1;
}

export function findFloatingCalls(files) {
    const sources = files.map((f) => ({ f, text: fs.readFileSync(f, 'utf8') }));
    const asyncNames = new Set();
    const syncNames = new Set();
    for (const { text } of sources) {
        for (const m of text.matchAll(/^\s*(static\s+)?(async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
            (m[2] ? asyncNames : syncNames).add(m[3]);
        }
        for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*[:=]\s*async\s*\(/g)) asyncNames.add(m[1]);
    }
    const names = [...asyncNames].filter((n) => !syncNames.has(n) && !IGNORED_NAMES.has(n) && n.length > 3);
    const callRe = new RegExp(`(?<![\\w$])(${names.join('|')})\\s*\\(`, 'g');
    const found = [];
    for (const { f, text } of sources) {
        for (const m of [...text.matchAll(callRe), ...text.matchAll(/AuditService\.(log)\s*\(/g)]) {
            const lineStart = text.lastIndexOf('\n', m.index) + 1;
            const before = text.slice(lineStart, m.index);
            const trimmed = before.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
            if (/on\w+="[^"]*$/.test(before)) continue; // inline HTML handler string
            if (((before.match(/['"`]/g) || []).length % 2) === 1) continue; // inside a string literal
            const close = closingParen(text, m.index + m[0].length - 1);
            if (close < 0) continue;
            const isDefinition = /^\s*(export\s+)?(static\s+)?(async\s+)?(function\s+)?$/.test(before)
                && /^\s*\{/.test(text.slice(close + 1, close + 20));
            if (isDefinition) continue;
            // Consumed: awaited / returned / assigned / argument / array element / arrow body.
            const pre = text.slice(Math.max(0, m.index - 300), m.index).replace(/(?:[\w$.]|\(\))*$/, '').trimEnd();
            if (/(\bawait|\breturn|\bvoid|=>|[=(,?:[])$/.test(pre)) continue;
            if (/^\s*\.(then|catch|finally)\(/.test(text.slice(close + 1))) continue;
            const rel = path.relative(JS_ROOT, f).split(path.sep).join('/');
            found.push({ key: `${rel} ${m[1]}`, line: text.slice(0, m.index).split('\n').length });
        }
    }
    return found;
}

describe('floating async calls (#126)', () => {
    const floating = findFloatingCalls(walk(JS_ROOT));

    test('no new un-awaited async calls outside the reviewed allow-list', () => {
        const unexpected = floating.filter((c) => !ALLOWED[c.key]).map((c) => `${c.key} (line ${c.line})`);
        expect(unexpected).toEqual([]);
    });

    test('allow-list has no stale entries', () => {
        const keys = new Set(floating.map((c) => c.key));
        expect(Object.keys(ALLOWED).filter((k) => !keys.has(k))).toEqual([]);
    });

    test('detector flags a bare save call and accepts awaited / caught ones', () => {
        const tmp = path.join(__dirname, '__floating_sample__.js');
        fs.writeFileSync(tmp, [
            'const S = {',
            '    async saveThing() {},',
            '    async other() {',
            '        await this.saveThing();',
            '        this.saveThing().catch(() => {});',
            '        return Promise.all([this.saveThing(), S.saveThing()]);',
            '    }',
            '};',
            'function f() { S.saveThing(); }',
            'function g() {',
            '    S.saveThing({',
            '        a: 1',
            '    }).catch(() => {});',
            '}',
        ].join('\n'));
        try {
            const calls = findFloatingCalls([tmp]);
            expect(calls.map((c) => c.line)).toEqual([9]);
        } finally {
            fs.unlinkSync(tmp);
        }
    });
});
