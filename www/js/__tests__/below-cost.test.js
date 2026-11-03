/**
 * @fileoverview I8 "Sold below cost" (Insights) and the Item ledger (ST4) use one rule
 * (docs/calculations.md I8, owner decision on #160): a sale is below cost only when its
 * cost of goods sold is more than ₹0.50 above its value.
 */
import { moneySummary, belowCostSales } from '../utils/business-metrics.js';
import { itemLedger } from '../utils/statements.js';
import { soldBelowCost, BELOW_COST_ALLOWANCE } from '../utils/money.js';

const at = (day, hour = 10) => new Date(2026, 9, day, hour).getTime();
const ITEMS = [{ id: 'rice', name: 'Rice', hindiName: 'चावल' }];
const line = (qty, rate, total) => ({ itemId: 'rice', name: 'Rice', qty, rate, total });
// 10 kg at ₹100/kg; then 1 kg sold 49 paise under cost and 1 kg sold 51 paise under cost
const src = {
    items: ITEMS,
    base: { state: {}, from: -Infinity },
    purchases: [{ id: 'p', timestamp: at(1), items: [line(10, 100, 1000)], grandTotal: 1000 }],
    retailSales: [
        { id: 'r49', billNo: 'R-49', timestamp: at(2), items: [line(1, 99.51, 99.51)], total: 99.51 },
        { id: 'r51', billNo: 'R-51', timestamp: at(3), items: [line(1, 99.49, 99.49)], total: 99.49 }
    ],
    wholesaleSales: [],
    stockAdjustments: []
};

describe('Sold below cost: 50-paise allowance, the same in Insights (I8) and the Item ledger (ST4)', () => {
    test('the allowance is 50 paise', () => {
        expect(BELOW_COST_ALLOWANCE).toBe(0.5);
        expect(soldBelowCost(99.51, 100)).toBe(false);
        expect(soldBelowCost(99.5, 100)).toBe(false);
        expect(soldBelowCost(99.49, 100)).toBe(true);
    });

    test('I8: 49 paise under is not flagged, 51 paise under is', () => {
        const m = moneySummary(src, { from: -Infinity, to: Infinity }, { detail: true });
        expect(belowCostSales(m)).toEqual([{ itemKey: 'rice', item: 'Rice', itemHi: 'चावल', times: 1, qty: 1, lost: 0.51 }]);
    });

    test('Item ledger: 49 paise under is not flagged, 51 paise under is', () => {
        const sales = itemLedger(src, ITEMS, 'rice').rows.filter(r => r.kind === 'retail');
        expect(sales.map(r => [r.billNo, r.cost, r.belowCost])).toEqual([['R-49', 100, false], ['R-51', 100, true]]);
    });

    test('an item\'s lines on one bill are judged together, in both views', () => {
        const two = {
            ...src,
            retailSales: [
                // 30 paise under twice: 60 paise under for the bill
                { id: 'a', billNo: 'R-A', timestamp: at(2), items: [line(1, 99.7, 99.7), line(1, 99.7, 99.7)], total: 199.4 },
                // ₹1 under and ₹1 over: even for the bill
                { id: 'b', billNo: 'R-B', timestamp: at(3), items: [line(1, 99, 99), line(1, 101, 101)], total: 200 }
            ]
        };
        const m = moneySummary(two, { from: -Infinity, to: Infinity }, { detail: true });
        expect(belowCostSales(m)).toEqual([{ itemKey: 'rice', item: 'Rice', itemHi: 'चावल', times: 1, qty: 2, lost: 0.6 }]);
        const sales = itemLedger(two, ITEMS, 'rice').rows.filter(r => r.kind === 'retail');
        expect(sales.map(r => [r.billNo, r.belowCost])).toEqual([['R-A', true], ['R-A', true], ['R-B', false], ['R-B', false]]);
    });
});
