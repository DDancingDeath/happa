/**
 * @jest-environment node
 */
/**
 * tools/migrate plan (#15): synthetic backup -> bundle. Covers legacy DD/MM
 * dates, dueAmount-only and payment.* bills, payments[] with write-offs,
 * name-only lines, Hindi names, the wholesale `quantity` field and dev_ data.
 */
import fs from 'fs';
import path from 'path';
import { buildPlan, parseOptions, revive, CLIENT_VERSION } from '../../../tools/migrate/lib/plan.js';
import { istWeekStartKey } from '../../../tools/migrate/lib/rate-stats.js';
import { formatReport } from '../../../tools/migrate/lib/report.js';
import { buildAging } from '../utils/aging.js';
import { billTotal, readPayment, wholesaleOutstanding } from '../utils/money.js';
import { computeFinanceSummary } from '../utils/finance-calc.js';

const ROOT = path.join(__dirname, '..', '..', '..');
const load = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'migrate', 'backup-synthetic.json'), 'utf8'));
const NOW = Date.UTC(2026, 9, 25, 9);
const plan = (opts, backup = load()) => buildPlan(backup, opts, { now: NOW });
const writesOf = (bundle, group) => bundle.writes.filter(w => w.group === group);
const opening = (bundle, coll) => writesOf(bundle, 'opening').filter(w => w.coll === coll);

describe('plan: receivables as Outstanding shows them', () => {
    const { bundle, summary } = plan();
    const today = new Date(Date.parse('2026-10-25T08:30:00Z'));

    test('one opening record per old unpaid bill: same number, date, name, phone and open amount', () => {
        const retail = opening(bundle, 'retailSales');
        expect(retail).toHaveLength(5);
        expect(summary.dues.retail).toMatchObject({ parties: 4, bills: 5, total: 740, records: 5, openingTotal: 740, matches: true });
        const byNo = Object.fromEntries(retail.map(w => [w.data.billNumber, w]));
        // dueAmount-only legacy bill with a DD/MM date and a Hindi name with extra spaces
        expect(byNo['S-OLD-7'].id).toBe('opening-retail-r2');
        expect(byNo['S-OLD-7'].data).toMatchObject({ customerName: 'रामू', customerPhone: '9876500001', date: '05/07/2026, 11:30:00 am', dueAmount: 140 });
        expect(byNo['S-OLD-7'].data.timestamp).toBe(Date.UTC(2026, 6, 5, 6, 0));
        expect(byNo['S20260815-001'].data).toMatchObject({ dueAmount: 200, openingBalance: { billTotal: 300, paidBefore: 100 } });
        // payment.due (300) wins over a drifted dueAmount (400); the written-off bill is not carried
        expect(byNo['S20261020-001'].data.openingBalance).toMatchObject({ amount: 300, billTotal: 600, paidBefore: 300 });
        expect(byNo['S20260901-002']).toBeUndefined();
        // legacy amountPaid only: due derived from the total
        expect(byNo['S-OLD-9'].data.openingBalance).toMatchObject({ amount: 50, billTotal: 90, paidBefore: 40 });
        expect(byNo['S20261024-001'].data.customerName).toBe('');
    });

    test('the new app reads the records exactly like the old bills: totals, parties, age groups', () => {
        const old = load().collections.retailSales.map(d => ({ id: d.id, ...revive(d.data) }));
        const docs = opening(bundle, 'retailSales').map(w => ({ id: w.id, ...revive(w.data) }));
        const before = buildAging(old, { today });
        const after = buildAging(docs, { today });
        expect(after.total).toBe(before.total);
        expect(after.buckets).toEqual(before.buckets);
        const parties = (a) => a.parties.map(p => [p.key, p.total, p.oldestDays, p.phone, p.bills.map(b => [b.billNumber, b.due, b.days])]).sort();
        expect(parties(after)).toEqual(parties(before));
        docs.forEach(d => {
            expect(readPayment(d).due).toBe(d.openingBalance.amount);
            expect(billTotal(d)).toBe(0);
            expect(d.clientVersion).toBe(CLIENT_VERSION);
            expect(d.openDue).toBe(true);
            expect(typeof d.timestamp).toBe('number');
        });
    });

    test('opening records add no sales or profit to Finance', () => {
        const docs = writesOf(bundle, 'opening').map(w => ({ id: w.id, ...revive(w.data) }));
        const s = computeFinanceSummary({
            sources: { retailSales: docs.filter(d => d.type === 'retail'), wholesaleSales: docs.filter(d => d.type === 'wholesale'), purchases: [], stockAdjustments: [] },
            items: [], base: { state: {}, from: -Infinity }
        });
        expect(s.sales.total).toBe(0);
        expect(s.profit).toBe(0);
        expect(s.sales.due).toBe(4240);
    });

    test('wholesale dues follow the Wholesale page rule (sales-tab bills only)', () => {
        const w = opening(bundle, 'wholesaleSales');
        expect(w.map(x => [x.data.billNumber, x.data.openingBalance.amount])).toEqual([['W-OLD-3', 1500], ['W20261025-002', 2000]]);
        w.forEach(x => {
            expect(x.data.source).toBe('sales-tab');
            expect(wholesaleOutstanding(x.data)).toBe(x.data.openingBalance.amount);
            // phone from the party's other bill, so the reminder can open their chat
            expect(x.data.customerPhone).toBe('9876500002');
        });
        expect(summary.dues.wholesale).toMatchObject({ total: 3500, records: 2, matches: true });
    });

    test('wholesale dues no page shows: reported, carried only with the flag', () => {
        expect(summary.hiddenWholesaleDues).toMatchObject({ carried: false, bills: 1, parties: 1, total: 300 });
        expect(bundle.writes.some(w => w.id === 'opening-wholesale-w3')).toBe(false);
        expect(formatReport(summary)).toMatch(/Not carried \(owner to decide\)\n- Wholesale bills not made on the Wholesale page.*1 bills, 1 parties, ₹300/);
        const withHidden = plan({ includeHiddenWholesaleDues: true });
        const rec = withHidden.bundle.writes.find(w => w.id === 'opening-wholesale-w3');
        expect(rec.data).toMatchObject({ source: 'sales-tab', billNumber: 'W-OLD-4', dueAmount: 300 });
        expect(withHidden.summary.hiddenWholesaleDues).toMatchObject({ carried: true, records: 1, matches: true });
    });

    test('ids are the old bill ids', () => {
        const again = plan().bundle;
        expect(writesOf(again, 'opening').map(w => w.id)).toEqual(writesOf(bundle, 'opening').map(w => w.id));
        expect(writesOf(bundle, 'opening').map(w => w.id).sort()).toEqual(
            ['opening-retail-r1', 'opening-retail-r2', 'opening-retail-r4', 'opening-retail-r5', 'opening-retail-r7', 'opening-wholesale-w1', 'opening-wholesale-w2']);
    });
});
describe('plan: payables', () => {
    test('none due: checked only, nothing carried', () => {
        const { bundle, summary } = plan();
        expect(opening(bundle, 'purchases')).toHaveLength(0);
        expect(summary.dues.purchase.total).toBe(0);
        expect(summary.warnings.some(w => /payables/.test(w))).toBe(false);
    });

    test('a supplier due is reported, and carried only with --carry-payables', () => {
        const backup = load();
        const p2 = backup.collections.purchases.find(d => d.id === 'p2').data;
        p2.payment = { cash: 2000, online: 0, due: 1000 };
        const checked = plan({}, backup);
        expect(checked.summary.dues.purchase.total).toBe(1000);
        expect(checked.summary.warnings.some(w => /payables: ₹1000 .*NOT carried/.test(w))).toBe(true);
        const carried = plan({ carryPayables: true }, backup);
        const docs = opening(carried.bundle, 'purchases');
        expect(docs).toHaveLength(1);
        expect(docs[0].data).toMatchObject({ customerName: 'सप्लायर बी', billNumber: 'P-OLD-1', isPurchase: true, dueAmount: 1000, date: '01/06/2026' });
        expect(carried.summary.dues.purchase.matches).toBe(true);
    });
});

describe('plan: copies, settings, counters, dev_', () => {
    const { bundle, summary } = plan();

    test('items, users, rate history and item frequency are copied as is with the same ids', () => {
        const backup = load();
        ['items', 'users', 'rateHistory', 'itemFrequency'].forEach(name => {
            const got = writesOf(bundle, `copy:${name}`);
            expect(got.map(w => w.id)).toEqual(backup.collections[name].map(d => d.id));
            expect(got.map(w => w.data)).toEqual(backup.collections[name].map(d => d.data));
        });
        expect(writesOf(bundle, 'copy:users').find(w => w.id === 'uid-owner').data.role).toBe('owner');
    });

    test('no bills, stock, cash or party list in a fresh start', () => {
        const colls = new Set(bundle.writes.map(w => w.coll));
        ['stockAdjustments', 'cashManagement', 'expenses', 'stockCheckpoints', 'telemetry'].forEach(c => expect(colls.has(c)).toBe(false));
        expect(bundle.writes.filter(w => w.coll === 'retailSales').every(w => w.group === 'opening')).toBe(true);
    });

    test('settings minus project-specific fields', () => {
        const s = writesOf(bundle, 'settings');
        expect(s).toHaveLength(1);
        expect(s[0].data).toEqual({ laborRate: 6, heavyWeightThreshold: 30, checkThresholds: { maxBillAmount: 100000 } });
    });

    test('bill numbers continue on the cutoff day; restart writes no counters', () => {
        const c = Object.fromEntries(writesOf(bundle, 'counters').map(w => [w.id, w.data.next]));
        expect(c).toEqual({ P20261025: 3, W20261025: 2 });
        expect(writesOf(plan({ billNumbers: 'restart' }).bundle, 'counters')).toHaveLength(0);
    });

    test('dev_ collections never reach the bundle', () => {
        expect(bundle.writes.some(w => w.coll.startsWith('dev_'))).toBe(false);
        expect(summary.devExcluded.map(d => d.name)).toEqual(['dev_retailSales', 'dev_users']);
        expect(() => parseOptions({ copy: ['items', 'dev_items'] })).toThrow(/dev_/);
    });

    test('full mode copies the history and makes no opening balances', () => {
        const full = plan({ mode: 'full' }).bundle;
        expect(writesOf(full, 'opening')).toHaveLength(0);
        expect(writesOf(full, 'copy:retailSales')).toHaveLength(7);
        expect(full.writes.some(w => w.coll === 'stockCheckpoints' || w.coll === 'telemetry')).toBe(false);
    });

    test('bad options and non-backups are refused', () => {
        expect(() => parseOptions({ mode: 'x' })).toThrow(/--mode/);
        expect(() => parseOptions({ billNumbers: 'x' })).toThrow(/--bill-numbers/);
        expect(() => buildPlan({ format: 'nope' })).toThrow(/decrypted backup/);
    });
});

describe('plan: buying and rate patterns (rateStats)', () => {
    const { bundle, summary } = plan();
    const stats = Object.fromEntries(writesOf(bundle, 'rateStats').map(w => [w.id, w.data]));

    test('one doc per item and year with weekly and monthly buckets', () => {
        expect(Object.keys(stats).sort()).toEqual(['item-chana_2026', 'item-rice_2026', 'item-wheat_2026']);
        const rice = stats['item-rice_2026'];
        // wholesale `quantity` lines; 20/09/2026 is a Sunday -> week of Monday 14 Sep
        expect(rice['m2026-09'].wholesale).toMatchObject({ kg: 50, amount: 2000, avg: 40, bills: 1 });
        expect(rice['w2026-09-14'].wholesale.kg).toBe(50);
        expect(rice['w2026-10-19']).toMatchObject({ bills: 3, retail: { kg: 13, avg: 50, bills: 2 }, wholesale: { kg: 100, avg: 42 } });
        // name-only Hindi line (no itemId) on a DD/MM bill counts for wheat in July
        expect(stats['item-wheat_2026']['m2026-07'].retail).toMatchObject({ kg: 5, avg: 28, bills: 1 });
    });

    test('monthly buckets equal the app aggregation; weeks add up to months', () => {
        expect(summary.rateStats).toMatchObject({ mismatches: 0, weeksMatchMonths: true, bills: 12 });
        expect(summary.warnings.some(w => /rate stats/.test(w))).toBe(false);
    });

    test('_meta marks the history built up to the cutoff, written last', () => {
        const last = bundle.writes[bundle.writes.length - 1];
        expect(last).toMatchObject({ coll: 'rateStats', id: '_meta' });
        expect(last.data).toMatchObject({ backfillDone: true, bills: 12, cutoff: Date.parse('2026-10-25T08:30:00Z'), cutoffDay: '2026-10-25' });
    });

    test('IST weeks start on Monday', () => {
        // 2026-10-25 23:30 IST is still Sunday in IST (18:00 UTC)
        expect(istWeekStartKey(Date.UTC(2026, 9, 25, 18))).toBe('2026-10-19');
        // 2026-10-26 00:30 IST is Monday (Sunday 19:00 UTC)
        expect(istWeekStartKey(Date.UTC(2026, 9, 25, 19))).toBe('2026-10-26');
    });
});

describe('plan report', () => {
    test('counts and totals only: no party, item or user names', () => {
        const { summary } = plan();
        const text = formatReport(summary);
        expect(text).toMatch(/\| \*\*total\*\* \| \*\*\d+\*\* \|/);
        expect(text).toMatch(/₹740/);
        ['रामू', 'Shyam', 'Geeta', 'Kirana', 'Supplier', 'सप्लायर', 'owner@example', 'Wheat', 'गेहूं', 'uid-owner'].forEach(name => expect(text).not.toContain(name));
    });

    test('CLIENT_VERSION matches the app', () => {
        const src = fs.readFileSync(path.join(ROOT, 'www', 'js', 'firebase', 'firestore-service.js'), 'utf8');
        expect(src).toContain(`const CLIENT_VERSION = ${CLIENT_VERSION};`);
    });
});
