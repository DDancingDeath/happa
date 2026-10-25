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

    test('one opening balance per party; totals equal the old Outstanding', () => {
        const retail = opening(bundle, 'retailSales');
        expect(retail).toHaveLength(4);
        expect(summary.dues.retail).toMatchObject({ parties: 4, bills: 5, total: 740, openingTotal: 740, matches: true });
        const byName = Object.fromEntries(retail.map(w => [w.data.customerName, w.data]));
        // Hindi name with extra spaces is the same party; dueAmount-only (140) + payment.due (200)
        expect(byName['रामू'].openingBalance.amount).toBe(340);
        expect(byName['रामू'].customerPhone).toBe('9876500001');
        // Legacy DD/MM bill is the oldest: 05/07/2026 is 5 July
        expect(byName['रामू'].date).toBe('2026-07-05');
        expect(byName['रामू'].openingBalance.sourceBills.map(s => s.billNumber)).toEqual(['S-OLD-7', 'S20260815-001']);
        // payment.due (300) wins over a drifted dueAmount (400); the written-off bill is not carried
        expect(byName.Shyam.openingBalance.amount).toBe(300);
        expect(byName.Shyam.openingBalance.sourceBills).toHaveLength(1);
        // legacy amountPaid only: due derived from the total
        expect(byName.Geeta.openingBalance.amount).toBe(50);
        expect(byName[''].openingBalance.amount).toBe(50);
    });

    test('the new app reads the opening balances exactly like the old bills', () => {
        const old = load().collections.retailSales.map(d => ({ id: d.id, ...revive(d.data) }));
        const docs = opening(bundle, 'retailSales').map(w => ({ id: w.id, ...revive(w.data) }));
        const today = new Date(Date.parse('2026-10-25T08:30:00Z'));
        const before = buildAging(old, { today });
        const after = buildAging(docs, { today });
        expect(after.total).toBe(before.total);
        expect(after.parties.map(p => [p.key, p.total]).sort()).toEqual(before.parties.map(p => [p.key, p.total]).sort());
        docs.forEach(d => {
            expect(readPayment(d).due).toBe(d.openingBalance.amount);
            expect(billTotal(d)).toBe(0);
            expect(d.clientVersion).toBe(CLIENT_VERSION);
            expect(d.openDue).toBe(true);
            expect(typeof d.timestamp).toBe('number');
        });
    });

    test('opening balances add no sales or profit to Finance', () => {
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
        expect(w).toHaveLength(1);
        expect(w[0].data.source).toBe('sales-tab');
        // 2000 due + 1500 (payment.due 0, total − received) on the same party (case/space differ)
        expect(w[0].data.openingBalance.amount).toBe(3500);
        expect(wholesaleOutstanding(w[0].data)).toBe(3500);
        expect(summary.dues.wholesale).toMatchObject({ total: 3500, matches: true });
        expect(summary.warnings.some(x => /not made on the Wholesale page/.test(x))).toBe(true);
    });

    test('ids and bill numbers are deterministic', () => {
        const again = plan().bundle;
        expect(writesOf(again, 'opening').map(w => [w.id, w.data.billNumber])).toEqual(writesOf(bundle, 'opening').map(w => [w.id, w.data.billNumber]));
        expect(writesOf(bundle, 'opening').map(w => w.data.billNumber)).toEqual(['OB-S-001', 'OB-S-002', 'OB-S-003', 'OB-S-004', 'OB-W-001']);
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
        expect(docs[0].data).toMatchObject({ customerName: 'सप्लायर बी', supplierName: 'सप्लायर बी', isPurchase: true, dueAmount: 1000, date: '2026-06-01' });
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
