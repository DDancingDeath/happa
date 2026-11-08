/**
 * @fileoverview Oracle tests for labour (docs/calculations.md T-LAB-1 … T-LAB-5, M20, M21, LABOUR-EXP):
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
import { labourSummary, labourPaid, labourPaidGap } from '../../www/js/utils/labour.js';
import { todaySummary } from '../../www/js/utils/calc/today.js';
import { labourPaidIn, moneySummary } from '../../www/js/utils/business-metrics.js';

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
        expect(text('todayLabourDiff')).toBe(`The estimate is ₹${want.T_LAB_3_difference} more than deducted`);
    });
});

describe('OD-03 step 1: paid to labourers (T-LAB-4 / M20) and paid − deducted (T-LAB-5 / M21) == oracle', () => {
    const DAY = '2026-10-21';
    const at = O.timeOf(`${DAY}T10:00:00`);
    const TYPES = ['Labour', 'labor', ' LABOUR  charges', 'Labourers', 'labour-loading', 'मजदूरी', 'मज\u093Cदूरी', 'Laboratory', 'Tea', 'Salary', '', 'personal', 'Labor 2'];
    const expense = fc.record({
        type: fc.constantFrom(...TYPES), amount: fc.integer({ min: 0, max: 500000 }).map(x => x / 100),
        category: fc.constantFrom(undefined, 'business', 'personal', 'Personal'), voided: fc.boolean(),
        date: fc.constantFrom(DAY, '2026-10-20', '2026-10-22', '2026-10-05', '2026-09-30')
    }).map(e => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)));
    const bill = fc.record({ laborCharges: fc.integer({ min: 0, max: 900 }), date: fc.constantFrom(DAY, '2026-10-20') })
        .map((b, i) => ({ id: `p${i}`, ...b, items: [{ qty: 10, weights: [10] }] }));

    test('Today: the day\'s business Labour expenses, and their difference from T-LAB-1', () => {
        fc.assert(fc.property(fc.array(expense, { maxLength: 12 }), fc.array(bill, { maxLength: 4 }), (expenses, purchases) => {
            const data = O.withoutVoided({ expenses, purchases });
            const want = O.labourPaid(data, O.dayRange(at));
            const deducted = O.labourDay(data, at).T_LAB_1_deducted;
            const got = todaySummary({ bills: { purchase: purchases }, expenses, today: new Date(at) }).labour;
            expect(got.paid).toEqual(want);
            expect(got.paidGap.difference).toBe(O.r2(want.amount - deducted));
            expect(got.paidGap.kind).toBe(Math.abs(want.amount - deducted) < 0.5 ? 'same' : want.amount > deducted ? 'more' : 'less');
        }), { seed: 303, numRuns: Number(process.env.FC_RUNS) || 300 });
    });

    test('Money › Spending (M20): the period\'s business Labour expenses, never more than M4 (they are part of it)', () => {
        const range = [O.timeOf('2026-10-01T00:00:00'), O.timeOf('2026-11-01T00:00:00')];
        fc.assert(fc.property(fc.array(expense, { maxLength: 12 }), (expenses) => {
            const want = O.labourPaid(O.withoutVoided({ expenses }), range);
            const got = labourPaidIn(expenses, range[0], range[1]);
            expect(got).toEqual(want);
            const m = moneySummary({ items: [], purchases: [], wholesaleSales: [], retailSales: [], stockAdjustments: [], expenses, withdrawals: [], base: { state: {}, from: -Infinity } }, { from: range[0], to: range[1] });
            expect(got.amount).toBeLessThanOrEqual(m.M4.total + 0.001);
        }), { seed: 303, numRuns: Number(process.env.FC_RUNS) || 200 });
    });

    test('the card shows them: ₹100 paid (3 expenses) against ₹72 deducted = ₹28 more paid', () => {
        const got = labourPaid([{ type: 'Labor', amount: 50 }, { type: 'labour charges', amount: 40 }, { type: 'मजदूरी', amount: 10 }]);
        expect(got).toEqual({ amount: 100, count: 3 });
        expect(labourPaidGap(got.amount, 72)).toEqual({ difference: 28, amount: 28, kind: 'more' });
        expect(labourPaidGap(71.6, 72).kind).toBe('same');
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
