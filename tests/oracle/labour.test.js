/**
 * @fileoverview Oracle tests for labour (docs/calculations.md T-LAB-1, T-LAB-2, T-LAB-3):
 * the independent oracle reproduces the hand-worked fixture numbers, the Today
 * Labour card shows them, and utils/labour.js agrees with the oracle on
 * generated bills.
 */
import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import * as O from './oracle.js';
import { DayManager } from '../../www/js/modules/day.js';
import { AnomaliesManager } from '../../www/js/modules/anomalies.js';
import { CashManagementManager } from '../../www/js/modules/cash-management.js';
import { AppState } from '../../www/js/utils/state.js';
import { labourSummary } from '../../www/js/utils/labour.js';

const FIX = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/calculations/shop-month.json'), 'utf8'));
const NOW = O.timeOf(FIX.now);
const E = FIX.expected.labourToday;
const data = { purchases: FIX.purchases };
const copy = (v) => JSON.parse(JSON.stringify(v));
const text = (id) => document.getElementById(id).textContent;
const amount = (id) => Number(text(id).replace(/[^\d.-]/g, ''));

test('oracle reproduces the hand-worked labour numbers', () => {
    const { settings, ...want } = E;
    expect(O.labourDay(data, NOW, settings)).toEqual(want);
});

describe('Today Labour card == oracle', () => {
    const want = O.labourDay(data, NOW, E.settings);
    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        jest.setSystemTime(new Date(NOW));
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(AnomaliesManager, 'renderDayReport').mockImplementation(() => {});
        AppState.purchaseHistory = copy(FIX.purchases);
        AppState.salesHistory = [];
        AppState.retailSalesHistory = [];
        AppState.expensesHistory = [];
        AppState.settings = { showHindi: false, ...E.settings };
        CashManagementManager.todaySession = null;
        document.body.innerHTML = ['todayLaborCost', 'todayLabourDeductedBills', 'todayLabourToPay', 'todayLabourToPayCalc', 'todayLabourDiff']
            .map(id => `<div id="${id}"></div>`).join('');
        DayManager.loadTodayData();
    });
    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        AppState.purchaseHistory = [];
    });

    test('T-LAB-1 deducted from farmers', () => {
        expect(amount('todayLaborCost')).toBe(Math.round(want.T_LAB_1_deducted));
        expect(text('todayLabourDeductedBills')).toBe(`(${want.T_LAB_1_bills} bill${want.T_LAB_1_bills === 1 ? '' : 's'})`);
    });
    test('T-LAB-2 to pay labour, with its working', () => {
        expect(amount('todayLabourToPay')).toBe(Math.round(want.T_LAB_2_toPay));
        expect(text('todayLabourToPayCalc')).toBe(`(${want.T_LAB_2_kg} kg ÷ 35 kg = ${want.T_LAB_2_packages} packages × ₹6)`);
    });
    test('T-LAB-3 difference', () => {
        expect(text('todayLabourDiff')).toBe(`To pay is ₹${want.T_LAB_3_difference} more than deducted`);
    });
});

test('utils/labour.js == oracle on generated purchase bills', () => {
    const day = '2026-10-21T10:00:00';
    const line = fc.record({
        qty: fc.integer({ min: 0, max: 200000 }).map(x => x / 100),
        weights: fc.array(fc.integer({ min: 1, max: 90 }), { maxLength: 6 })
    });
    const bill = fc.record({
        items: fc.array(line, { maxLength: 4 }),
        laborCharges: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 500 })),
        opening: fc.boolean()
    }).map(({ items, laborCharges, opening }, i) => (opening
        ? { id: `o${i}`, date: day, items: [], laborCharges, openingBalance: { amount: 100 } }
        : { id: `p${i}`, date: day, items, laborCharges }));
    const settings = fc.record({
        laborRate: fc.integer({ min: 1, max: 5000 }).map(x => x / 100),
        labourPackageKg: fc.integer({ min: 100, max: 20000 }).map(x => x / 100)
    });
    fc.assert(fc.property(fc.array(bill, { maxLength: 12 }), settings, (bills, s) => {
        const want = O.labourDay({ purchases: bills }, O.timeOf(day), s);
        const got = labourSummary(bills, s);
        expect({
            T_LAB_1_deducted: got.deducted.amount, T_LAB_1_bills: got.deducted.bills,
            T_LAB_2_kg: got.toPay.kg, T_LAB_2_packages: got.toPay.packages, T_LAB_2_toPay: got.toPay.amount,
            T_LAB_3_difference: got.difference
        }).toEqual(want);
    }), { seed: 4242, numRuns: Number(process.env.FC_RUNS) || 200 });
});
