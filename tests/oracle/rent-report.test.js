/**
 * @fileoverview Oracle for the Rentals yearly report per property (#157,
 * docs/calculations.md RENT-19): per property and month, rent = Σ amount,
 * collected = Σ paid, due = Σ (amount − paid, never below 0) of that month's
 * charges; expenses = Σ that month's expenses (property tax = category 'tax');
 * net = collected − expenses; the months add up to the year and the properties
 * to the total.
 */
import fc from 'fast-check';
import { yearReport, reportMonths } from '../../www/js/rentals/rent-math-report.js';

const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const MONTHS = reportMonths(2026);

describe('RENT-19: yearly report per property', () => {
    test('equals an independent sum; months add up to the year, properties to the total', () => {
        const month = fc.constantFrom(...MONTHS, '2026-03', '2027-04');
        fc.assert(fc.property(
            fc.array(fc.record({ p: fc.constantFrom('A', 'B', 'C'), month, amount: fc.integer({ min: 0, max: 20000 }), paid: fc.integer({ min: 0, max: 25000 }) }), { maxLength: 40 }),
            fc.array(fc.record({ p: fc.constantFrom('A', 'B'), month, amount: fc.integer({ min: 1, max: 5000 }), tax: fc.boolean() }), { maxLength: 15 }),
            (charges, expenses) => {
                const props = [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }, { id: 'C', name: 'Gamma' }];
                const r = yearReport({
                    properties: props,
                    charges: charges.map(c => ({ propertyId: c.p, month: c.month, amount: c.amount, paid: c.paid })),
                    expenses: expenses.map(e => ({ propertyId: e.p, month: e.month, amount: e.amount, category: e.tax ? 'tax' : 'repairs' }))
                }, MONTHS);
                const inYear = (m) => MONTHS.includes(m);
                let all = { rent: 0, collected: 0, due: 0, expenses: 0, tax: 0 };
                props.forEach(p => {
                    const row = r.rows.find(x => x.id === p.id);
                    let year = { rent: 0, collected: 0, due: 0, expenses: 0, tax: 0 };
                    MONTHS.forEach(m => {
                        const ch = charges.filter(c => c.p === p.id && c.month === m);
                        const ex = expenses.filter(e => e.p === p.id && e.month === m);
                        const want = {
                            rent: ch.reduce((s, c) => s + c.amount, 0),
                            collected: ch.reduce((s, c) => s + c.paid, 0),
                            due: ch.reduce((s, c) => s + Math.max(0, c.amount - c.paid), 0),
                            expenses: ex.reduce((s, e) => s + e.amount, 0),
                            tax: ex.filter(e => e.tax).reduce((s, e) => s + e.amount, 0)
                        };
                        want.net = want.collected - want.expenses;
                        expect(row.months[m]).toEqual(want);
                        Object.keys(year).forEach(k => { year[k] += want[k]; });
                    });
                    expect(row.total).toEqual({ ...year, net: r2(year.collected - year.expenses) });
                    Object.keys(all).forEach(k => { all[k] += year[k]; });
                });
                expect(r.total).toEqual({ ...all, net: r2(all.collected - all.expenses) });
                expect(charges.some(c => !inYear(c.month)) ? r.rows.length : 3).toBe(3);
            }
        ), { numRuns: 150, seed: 157 });
    });
});
