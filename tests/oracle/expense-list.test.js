/**
 * @fileoverview Oracle for the Expenses section totals (docs/calculations.md
 * EXP-LIST, #90): random expenses, an independent day-by-day sum, compared
 * with expenseTotals().
 */
import fc from 'fast-check';
import { expenseTotals } from '../../www/js/utils/expense-list.js';

const pad = (n) => String(n).padStart(2, '0');

describe('EXP-LIST: today and this month of a section', () => {
    test('E1 / E2: sum of the counted expenses on today / from the 1st up to today; E3: the counted shown rows', () => {
        const expense = fc.record({
            month: fc.integer({ min: 8, max: 11 }),
            day: fc.integer({ min: 1, max: 28 }),
            amount: fc.integer({ min: 1, max: 50000 }),
            voided: fc.boolean(),
            shown: fc.boolean()
        });
        fc.assert(fc.property(fc.array(expense, { maxLength: 40 }), fc.integer({ min: 1, max: 28 }), (rows, todayDay) => {
            const now = new Date(2026, 9, todayDay, 12, 0);
            const expenses = rows.map((r, i) => ({
                id: `e${i}`,
                amount: r.amount,
                date: `${pad(r.day)}/${pad(r.month + 1)}/2026, 10:00:00 am`,
                ...(r.voided ? { voided: true } : {})
            }));
            const shown = expenses.filter((_, i) => rows[i].shown);
            let today = 0;
            let month = 0;
            let shownSum = 0;
            rows.forEach(r => {
                if (r.voided) return;
                if (r.month === 9 && r.day <= todayDay) month += r.amount;
                if (r.month === 9 && r.day === todayDay) today += r.amount;
                if (r.shown) shownSum += r.amount;
            });
            const got = expenseTotals(expenses, { now, shown });
            expect([got.today, got.month, got.shown]).toEqual([today, month, shownSum]);
        }), { numRuns: 200, seed: 90 });
    });
});
