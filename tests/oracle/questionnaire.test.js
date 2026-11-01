/**
 * @fileoverview Oracle for the questionnaire figures (#111): M19 business
 * expenses per ₹100 of sales on the worked example equals the oracle's M4 ÷ M1,
 * and C10's whole hours equal an independent count.
 */
import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import * as O from './oracle.js';
import { moneySummary, expensePer100Sales } from '../../www/js/utils/business-metrics.js';
import { openHours } from '../../www/js/utils/cash-session.js';

const FIX = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/calculations/shop-month.json'), 'utf8'));
const NOW = O.timeOf(FIX.now);
const data = {
    items: FIX.items, purchases: FIX.purchases, wholesaleSales: FIX.wholesaleSales, retailSales: FIX.retailSales,
    stockAdjustments: FIX.stockAdjustments, expenses: FIX.expenses, withdrawals: FIX.withdrawals
};

describe('M19: business expenses per ₹100 of sales', () => {
    test.each([
        ['all time', [-Infinity, Infinity]],
        ['October', [new Date(2026, 9, 1).getTime(), NOW + 1]]
    ])('%s', (_, [from, to]) => {
        const want = O.metrics(data, [from, to]);
        const got = expensePer100Sales(moneySummary({ ...data, base: { state: {}, from: -Infinity } }, { from, to }));
        expect(want.M1_sales).toBeGreaterThan(0);
        expect(got.value).toBe(Math.round((want.M4_businessExpenses / want.M1_sales) * 1000) / 10);
    });
});

describe('C10: hours the cash has been open', () => {
    test('whole hours, rounded down', () => {
        fc.assert(fc.property(fc.integer({ min: 0, max: 48 * 60 }), (minutes) => {
            const since = new Date(2026, 10, 1, 7, 30).getTime();
            const r = openHours({ signInTime: new Date(since).toISOString(), signedOut: false }, since + minutes * 60000);
            expect(r.hours).toBe(Math.floor(minutes / 60));
            expect(r.long).toBe(minutes >= 14 * 60);
        }), { numRuns: 200, seed: 111 });
    });
});
