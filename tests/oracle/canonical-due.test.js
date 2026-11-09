/**
 * @fileoverview #126 cut-over: a bill's due is read from `payment.due` only. The worked examples'
 * bills are stored the ways older app versions stored a due (only `dueAmount`, `payment.due`
 * null, a text `dueAmount`, only a top-level `due`, a stale `dueAmount`), copied the way
 * tools/migrate copies them (canonicalDueBill) and read by the app: Outstanding (O3/O4, M15's
 * dues), each party's due (aging, "Already owes ₹X"), Today and Money show exactly the figures of
 * the worked examples (whose hand-worked numbers the other oracle tests pin), and the oracle
 * reading the old way agrees.
 */
import fs from 'fs';
import path from 'path';
import * as O from './oracle.js';
import { canonicalDueBill } from '../../www/js/firebase/repos/bill-due.js';
import { moneySummary, outstandingTotals } from '../../www/js/utils/business-metrics.js';
import { buildAging, normalizePartyName } from '../../www/js/utils/aging.js';
import { partyDue } from '../../www/js/utils/party-due.js';
import { todaySummary } from '../../www/js/utils/calc/today.js';
import { legacyDue } from '../../www/js/utils/money.js';

const load = (name) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/calculations', `${name}.json`), 'utf8'));
const copy = (v) => JSON.parse(JSON.stringify(v));
const COLLS = ['purchases', 'wholesaleSales', 'retailSales'];
const KIND = { purchases: 'purchase', wholesaleSales: 'wholesale', retailSales: 'retail' };

const EXAMPLES = [
    ['real-shapes', load('real-shapes')],
    ['shop-month', load('shop-month')],
    ['today-channels', load('today-channels')],
    ...Object.entries(load('today-days').cases).map(([k, c]) => [`today-days ${k}`, c]),
    ...Object.entries(load('cash-days').cases).map(([k, c]) => [`cash-days ${k}`, c]),
    ['phone-path', load('phone-path')]
];

/** How older apps stored the same due (the old reading gives `due` back on each). */
const OLD_SHAPES = [
    (b, due) => { delete b.payment.due; b.dueAmount = due; },
    (b, due) => { b.payment.due = null; b.dueAmount = due; },
    (b, due) => { delete b.payment.due; b.dueAmount = String(due); },
    (b, due) => { delete b.payment.due; delete b.dueAmount; b.due = due; },
    (b, due) => { b.dueAmount = due + 77; },
    () => {}
];

/** The example with its bills' dues stored the older ways, one shape after another. */
function asOldApps(example) {
    const out = copy(example);
    let i = 0;
    COLLS.forEach(c => (out[c] || []).forEach(b => {
        const due = b?.payment?.due;
        if (typeof due !== 'number') return;
        OLD_SHAPES[i++ % OLD_SHAPES.length](b, due);
    }));
    return out;
}

const migrated = (data) => {
    const out = { ...data };
    COLLS.forEach(c => { if (data[c]) out[c] = data[c].map(canonicalDueBill); });
    return out;
};

/** Figures only: a bill inside a result (a list row's bill) stands for its id. */
const figuresOnly = (v) => {
    if (Array.isArray(v)) return v.map(figuresOnly);
    if (v && typeof v === 'object') {
        if ('id' in v && ['items', 'customerName', 'payment', 'billNumber'].some(k => k in v)) return `bill:${v.id}`;
        return Object.fromEntries(Object.keys(v).sort().map(k => [k, figuresOnly(v[k])]));
    }
    return v;
};

/** Every due figure of the four screens, from the app's own calculations. */
function figures(data, now) {
    const today = new Date(now);
    const byKind = Object.fromEntries(COLLS.map(c => [KIND[c], data[c] || []]));
    const names = [...new Set(COLLS.flatMap(c => (data[c] || []).map(b => normalizePartyName(b.customerName || ''))))].sort();
    const money = (range) => {
        const m = moneySummary({ ...data, base: { state: {}, from: -Infinity } }, range);
        return Object.fromEntries(Object.keys(m).filter(k => /^M\d+$/.test(k)).map(k => [k, m[k]]));
    };
    const [dayFrom, dayTo] = O.dayRange(now);
    return figuresOnly({
        outstanding: outstandingTotals(data),
        parties: Object.entries(byKind).map(([kind, bills]) => [kind, buildAging(bills, { today }).parties.map(p => [p.key, p.total, p.bills.length, p.oldestDays])]),
        owes: names.flatMap(name => Object.values(byKind).map(bills => partyDue(bills, name, { today }))),
        today: todaySummary({ bills: byKind, expenses: data.expenses || [], today }),
        moneyAll: money({ from: -Infinity, to: Infinity }),
        moneyDay: money({ from: dayFrom, to: dayTo })
    });
}

describe('#126: worked examples stored by older apps, copied by tools/migrate, show the same figures', () => {
    test.each(EXAMPLES)('%s', (name, example) => {
        const now = O.timeOf(example.now);
        const old = asOldApps(example);
        const moved = migrated(old);
        // Each copy stores the due the old app read, and no dueAmount
        COLLS.forEach(c => (moved[c] || []).forEach((b, i) => {
            expect([c, b.id, b.payment.due]).toEqual([c, b.id, legacyDue(old[c][i])]);
            expect(b).not.toHaveProperty('dueAmount');
        }));
        expect(figures(moved, now)).toEqual(figures(example, now));
        // The oracle reading the old bills the old way agrees with it reading the copies
        expect(O.readingOldDues(() => O.outstanding(old))).toEqual(O.outstanding(moved));
        expect(O.readingOldDues(() => O.finance(old))).toEqual(O.finance(moved));
        expect(O.readingOldDues(() => O.today(old, now))).toEqual(O.today(moved, now));
        expect(O.outstanding(moved)).toEqual(O.outstanding(example));
    });

    test('the copy is needed: read as stored, the older shapes would show other dues', () => {
        const example = load('real-shapes');
        const now = O.timeOf(example.now);
        expect(figures(asOldApps(example), now).outstanding).not.toEqual(figures(example, now).outstanding);
    });
});
