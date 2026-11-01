/**
 * @fileoverview Oracle for period A vs period B (#140, docs/calculations.md
 * CMP-AB, PERIOD-CUSTOM): the comparison card's A, B, ₹ change and % for
 * chosen days equal the independent oracle's M1, M16, M4, M6 and M14 of the
 * two periods.
 */
import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import * as O from './oracle.js';
import { moneySummary, periodCompare, periodRange, customRangePreset, PERIOD_COMPARE_IDS } from '../../www/js/utils/business-metrics.js';

const FIX = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/calculations/shop-month.json'), 'utf8'));
const NOW = new Date(O.timeOf(FIX.now));
const data = {
    items: FIX.items, purchases: FIX.purchases, wholesaleSales: FIX.wholesaleSales, retailSales: FIX.retailSales,
    stockAdjustments: FIX.stockAdjustments, expenses: FIX.expenses, withdrawals: FIX.withdrawals
};
const input = { ...data, base: { state: {}, from: -Infinity } };
const ORACLE_KEY = { M1: 'M1_sales', M16: 'M16_purchases', M4: 'M4_businessExpenses', M6: 'M6_profit', M14: 'M14_net' };
const figures = (m) => ({ M1: m.M1.total, M16: m.M16.total, M4: m.M4.total, M6: m.M6.total, M14: m.M14 });
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('PERIOD-CUSTOM: chosen days', () => {
    test('from the first day 00:00 to the end of the last, either order, never past today', () => {
        fc.assert(fc.property(fc.integer({ min: 0, max: 400 }), fc.integer({ min: 0, max: 400 }), (x, y) => {
            const a = new Date(2026, 9, 21 - x);
            const b = new Date(2026, 9, 21 - y + 30);
            const r = periodRange(customRangePreset(iso(b), iso(a)), NOW);
            const [lo, hi] = a <= b ? [a, b] : [b, a];
            const end = Math.min(new Date(hi.getFullYear(), hi.getMonth(), hi.getDate() + 1).getTime(), new Date(2026, 9, 22).getTime());
            expect(r.from).toBe(lo.getTime());
            expect(r.to).toBe(Math.max(lo.getTime(), end));
        }), { numRuns: 200, seed: 140 });
    });
});

describe('CMP-AB: A vs B = oracle', () => {
    test('every pair of chosen periods in the worked example', () => {
        fc.assert(fc.property(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 20 }), (a0, aLen, b0, bLen) => {
            const day = (n) => new Date(2026, 9, 21 - n);
            const A = periodRange(customRangePreset(iso(day(a0)), iso(day(Math.max(0, a0 - aLen)))), NOW);
            const B = periodRange(customRangePreset(iso(day(b0)), iso(day(Math.max(0, b0 - bLen)))), NOW);
            const rows = periodCompare(figures(moneySummary(input, A)), figures(moneySummary(input, B)));
            const oa = O.metrics(data, [A.from, A.to]);
            const ob = O.metrics(data, [B.from, B.to]);
            expect(rows.map(r => r.id)).toEqual(PERIOD_COMPARE_IDS);
            rows.forEach(r => {
                const x = oa[ORACLE_KEY[r.id]];
                const y = ob[ORACLE_KEY[r.id]];
                expect(r.a).toBeCloseTo(x, 2);
                expect(r.b).toBeCloseTo(y, 2);
                expect(r.diff).toBeCloseTo(x - y, 2);
                if (Math.abs(y) < 0.005) expect(r.c).toBeNull();
                else expect(r.c.pct).toBe(Math.round(((r.a - r.b) / Math.abs(r.b)) * 100));
            });
        }), { numRuns: 60, seed: 140 });
    });

    test('B not known: no ₹ change and no %, A still shown', () => {
        const rows = periodCompare({ M1: 100, M16: 50, M4: 10, M6: 5, M14: 20 }, null);
        expect(rows.every(r => r.b === null && r.diff === null && r.c === null)).toBe(true);
        expect(rows.map(r => r.a)).toEqual([100, 50, 10, 5, 20]);
    });
});
