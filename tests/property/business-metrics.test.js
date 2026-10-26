/**
 * @fileoverview Accounting checks for the calculation layer (utils/business-metrics.js)
 * on generated multi-year histories: AC10 (items add up), AC11 (parties add up),
 * AC4 months = all time, AC14 (one bill count), and layer == oracle for M*.
 * Fixed seed; FC_RUNS=50 for more runs locally.
 */
import fc from 'fast-check';
import { generateShop } from '../fixtures/generator.js';
import * as O from '../oracle/oracle.js';
import {
    moneySummary, itemSummary, partySummary, purchaseItems, billCount, outstandingTotals
} from '../../www/js/utils/business-metrics.js';

const RUNS = Number(process.env.FC_RUNS) || 4;
const FC = { seed: 4747, numRuns: RUNS, endOnFailure: true };
jest.setTimeout(120000);

const shopArb = (over = {}) => fc.record({
    seed: fc.integer({ min: 1, max: 0x7fffffff }),
    years: fc.constantFrom(1, 2),
    creditRate: fc.constantFrom(0.35, 0.1),
    legacyRate: fc.constantFrom(0.2, 0.05),
    ddmmRate: fc.constantFrom(0.25, 0.5),
    untaggedExpenseRate: fc.constant(0.03),
    openingRate: fc.constantFrom(0, 0.5)
}).map(o => ({ ...o, ...over })).map(opts => ({
    opts, shop: generateShop(opts), [fc.toStringMethod]: () => `generateShop(${JSON.stringify(opts)})`
}));

const close = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;
const input = (s) => ({ ...s, base: { state: {}, from: -Infinity } });

function months(s) {
    const times = [...s.purchases, ...s.retailSales, ...s.wholesaleSales].filter(b => !O.isOpening(b))
        .map(b => (typeof b.timestamp === 'number' ? b.timestamp : O.timeOf(b.date))).filter(Number.isFinite);
    const first = new Date(Math.min(...times));
    const last = new Date(Math.max(...times));
    const out = [];
    for (let d = new Date(first.getFullYear(), first.getMonth(), 1); d <= last; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
        out.push({ from: d.getTime(), to: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() });
    }
    return out;
}
const spread = (list, k) => (list.length <= k ? list : Array.from({ length: k }, (_, i) => list[Math.floor((i * (list.length - 1)) / (k - 1))]));

test('M* == oracle each sampled month (DD/MM dates, opening records, legacy shapes)', () => {
    fc.assert(fc.property(shopArb(), ({ shop: s }) => spread(months(s), 5).every(r => {
        const m = moneySummary(input(s), r);
        const w = O.metrics(s, [r.from, r.to]);
        return close(m.M1.total, w.M1_sales) && m.M1.count === w.M1_saleCount && close(m.M2, w.M2_cogs)
            && close(m.M4.total, w.M4_businessExpenses) && close(m.M6.total, w.M6_profit) && close(m.M7, w.M7_labour)
            && close(m.M12.cash, w.M12_inCash) && close(m.M13.cash, w.M13_outCash) && close(m.M14, w.M14_net)
            && close(m.M16.total, w.M16_purchases) && m.M16.count === w.M16_purchaseCount;
    })), FC);
});

test('AC10 items add up to M1 and M2; AC11 parties add up to M1 and M16; purchase items add up to M16 (#47)', () => {
    fc.assert(fc.property(shopArb(), ({ shop: s }) => spread(months(s), 4).every(r => {
        const m = moneySummary(input(s), r, { detail: true });
        const items = itemSummary(m);
        const cust = partySummary(s, 'sales', r);
        const sup = partySummary(s, 'purchases', r);
        const pItems = purchaseItems(s.purchases, s.items, r);
        const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
        return close(sum(items, x => x.sales), m.M1.total) && close(sum(items, x => x.cogs), m.M2)
            && close(sum(cust, x => x.total), m.M1.total) && close(sum(sup, x => x.total), m.M16.total)
            && close(sum(pItems, x => x.amount), m.M16.total) && close(sum(pItems, x => x.labour), m.M7);
    })), FC);
});

test('AC4 months add up to all time for M1, M2, M6, M16', () => {
    fc.assert(fc.property(shopArb({ years: 1 }), ({ shop: s }) => {
        const all = moneySummary(input(s), { from: -Infinity, to: Infinity });
        const per = months(s).map(r => moneySummary(input(s), r));
        const sum = (f) => per.reduce((a, m) => a + f(m), 0);
        return close(sum(m => m.M1.total), all.M1.total, 0.5) && close(sum(m => m.M2), all.M2, 0.5)
            && close(sum(m => m.M6.total), all.M6.total, 0.5) && close(sum(m => m.M16.total), all.M16.total, 0.5);
    }), FC);
});

test('AC14 one bill count; AC5 dues == oracle (opening records included in dues only)', () => {
    fc.assert(fc.property(shopArb({ openingRate: 1 }), ({ shop: s }) => {
        const d = outstandingTotals(s);
        const w = O.dueTotals(s);
        const okDues = close(d.payable.total, w.payable) && close(d.receivable.total, w.receivable)
            && d.payable.count === w.payableCount && d.receivable.count === w.receivableCount;
        return okDues && spread(months(s), 4).every(r => {
            const c = billCount(s, r.from, r.to);
            const w2 = O.metrics(s, [r.from, r.to]);
            return c.sales === w2.M1_saleCount && c.purchases === w2.M16_purchaseCount;
        });
    }), FC);
});
