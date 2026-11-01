/**
 * Review-rules checker (scripts/check-review-rules.js, #54): YAML subset parsing,
 * glob scoping, diff parsing, and that each rule catches its mistake without
 * flagging the correct pattern.
 */
const fs = require('fs');
const {
    parseRules, globToRegExp, ruleAppliesTo, findViolations, parseAddedLines, RULES_PATH,
} = require('../../../scripts/check-review-rules.js');

const rules = parseRules(fs.readFileSync(RULES_PATH, 'utf8'));
const byId = Object.fromEntries(rules.map((r) => [r.id, r]));
const hits = (id, file, text) => findViolations([byId[id]], [{ file, line: 1, text }]).length > 0;

describe('review-rules.yml', () => {
    test('parses into unique, valid rules with summaries', () => {
        expect(rules.length).toBeGreaterThanOrEqual(10);
        expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
        for (const r of rules) {
            expect(r.applies_to.length).toBeGreaterThan(0);
            expect(r.message.split('\n')[0].length).toBeGreaterThan(10);
        }
    });

    test('block-text messages, inline arrays and quoted regexes survive parsing', () => {
        const [r] = parseRules([
            'rules:',
            '  - id: demo',
            '    pattern: "a\\\\.b\\"c"',
            '    applies_to: ["x/**/*.js", "y.js"]',
            '    message: |',
            '      first line',
            '      second line',
            '    severity: warn',
        ].join('\n'));
        expect(r.regex.source).toBe('a\\.b"c');
        expect(r.applies_to).toEqual(['x/**/*.js', 'y.js']);
        expect(r.excludes).toEqual([]);
        expect(r.message).toBe('first line\nsecond line');
        expect(() => parseRules('rules:\n  - id: bad\n    severity: fatal\n')).toThrow(/bad severity/);
    });

    const cases = [
        ['firestore-collection-literal', 'www/js/modules/items.js', "db.collection('items').get()", 'db.collection(window.getCollection(\'items\')).get()'],
        ['firebase-firestore-in-module', 'www/js/modules/users.js', 'const db = firebase.firestore();', 'const ts = firebase.firestore.FieldValue.serverTimestamp();'],
        ['showToast-wrong-arg-type', 'www/js/modules/admin.js', "UIManager.showToast('Failed', 'danger');", "UIManager.showToast(t('msg.admin.x'), 'error');"],
        ['showToast-wrong-arg-type', 'www/js/modules/finance.js', "UIManager.showToast('Saved', '5s');", "UIManager.showToast('Saved', 3000);"],
        ['top-level-app-shadowing', 'www/firebaseConfig.js', 'let app = firebase.initializeApp(cfg);', 'let firebaseApp = firebase.initializeApp(cfg);'],
        ['raw-date-construction', 'www/js/modules/day.js', "new Date('2026-10-21')", 'parseLocalDate(value)'],
        ['iso-string-date-key', 'www/js/modules/day.js', "new Date().toISOString().split('T')[0]", 'todayLocalISO()'],
        ['hardcoded-collection-prefix', 'www/js/modules/stock.js', "db.collection('dev_items')", "getCollection('items')"],
        ['catch-swallow-empty-body', 'www/js/modules/stock.js', 'try { x(); } catch (e) {}', 'try { x(); } catch (_e) {}'],
        ['cash-sessions-wrong-collection', 'www/js/modules/cash-management.js', "col('cashSessions')", "col('cashManagement')"],
        ['bill-numbering-count-plus-one', 'www/js/modules/billing.js', 'const billNo = snapshot.size + 1;', 'const next = items.length + 1;'],
        ['inline-onclick-without-window-app', 'www/templates/items.html', '<button onclick="saveItem()">', '<button onclick="window.app.items.save()">'],
        ['framework-import', 'www/js/modules/x.js', "import React from 'react';", "import { Helpers } from '../utils/helpers.js';"],
        ['displayed-number-spec', 'www/js/modules/finance.js', 'const profit = revenue - investment;', "const label = t('ui.finance.x');"],
        ['record-date-raw-parse', 'www/js/modules/stock.js', 'const time = new Date(a.date).getTime();', 'const time = parseAnyBillDate(a.date)?.getTime();'],
        ['bill-total-or-chain', 'www/js/services/printer.js', 'const s = billData.billTotal || billData.saleTotal || 0;', 'const s = billLineTotal(billData, true);'],
        ['inline-rupee-format', 'www/js/modules/day.js', 'el.textContent = `₹${total}`;', 'el.textContent = formatRupees(total);'],
        ['inline-rupee-format', 'www/js/services/printer.js', "const text = '₹' + Math.round(due);", "const text = formatRupees(due);"],
        ['inline-rupee-format', 'www/js/modules/day.js', "el.textContent = 'Total: ₹' + total;", "el.textContent = t('ui.x', { amount: formatAmount(total) });"],
        ['inline-rupee-format', 'www/js/modules/day.js', 'el.textContent = `₹ ${total}`;', "el.textContent = formatRupees(total);"],
    ];
    test.each(cases)('%s flags the mistake and allows the fix', (id, file, bad, good) => {
        expect(byId[id]).toBeDefined();
        expect(hits(id, file, bad)).toBe(true);
        expect(hits(id, file, good)).toBe(false);
    });

    test('scoping: tests and the service layer are excluded where intended', () => {
        expect(hits('firestore-collection-literal', 'www/js/__tests__/a.test.js', "db.collection('items')")).toBe(false);
        expect(hits('hardcoded-collection-prefix', 'www/firebaseConfig.js', "const P = 'dev_';")).toBe(false);
        expect(hits('firebase-firestore-in-module', 'www/js/firebase/firestore-service.js', 'firebase.firestore()')).toBe(false);
    });

    test('#80: no file in www/js parses a record date raw or chains bill totals with ||', () => {
        const path = require('path');
        const root = path.resolve(__dirname, '../../..');
        const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
            const p = path.join(dir, e.name);
            return e.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
        });
        const lines = walk(path.join(root, 'www/js')).flatMap(abs => {
            const file = path.relative(root, abs).split(path.sep).join('/');
            return fs.readFileSync(abs, 'utf8').split(/\r?\n/).map((text, i) => ({ file, line: i + 1, text }));
        });
        const found = findViolations([byId['record-date-raw-parse'], byId['bill-total-or-chain']], lines);
        expect(found.map(v => `${v.file}:${v.line}`)).toEqual([]);
        // #129: one money formatter, no inline ₹ anywhere in www/js but utils/money.js
        expect(findViolations([byId['inline-rupee-format']], lines).map(v => `${v.file}:${v.line}`)).toEqual([]);
    });
});

describe('globs and diff parsing', () => {
    test('globToRegExp: ** spans directories, * does not', () => {
        expect(globToRegExp('www/**/*.js').test('www/main.js')).toBe(true);
        expect(globToRegExp('www/**/*.js').test('www/js/modules/a.js')).toBe(true);
        expect(globToRegExp('www/*.js').test('www/js/a.js')).toBe(false);
        expect(ruleAppliesTo({ applies_to: ['www/**/*.js'], excludes: ['www/js/__tests__/**'] }, 'www/js/__tests__/x.test.js')).toBe(false);
    });

    test('parseAddedLines keeps only added lines with new-file line numbers', () => {
        const diff = [
            'diff --git a/www/js/a.js b/www/js/a.js',
            '--- a/www/js/a.js',
            '+++ b/www/js/a.js',
            '@@ -10,2 +10,3 @@ class A {',
            '-old();',
            '+first();',
            '+second();\r',
            'diff --git a/gone.js b/gone.js',
            '--- a/gone.js',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-x',
        ].join('\n');
        expect(parseAddedLines(diff)).toEqual([
            { file: 'www/js/a.js', line: 10, text: 'first();' },
            { file: 'www/js/a.js', line: 11, text: 'second();' },
        ]);
    });
});
