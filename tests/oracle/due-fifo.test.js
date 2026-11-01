/**
 * @fileoverview Oracle for "Receive payment" over a party's bills
 * (docs/calculations.md DUE-FIFO): an independent oldest-first fill agrees with
 * allocateOldestFirst, and the party's due after = before − what was allocated.
 */
import fc from 'fast-check';
import { allocateOldestFirst } from '../../www/js/utils/due-payments.js';

const paise = (x) => Math.round(x * 100);

describe('DUE-FIFO: one payment over the oldest bills first', () => {
    test('each bill up to its due in order; only the last one reached is part-paid; the rest is left', () => {
        fc.assert(fc.property(
            fc.array(fc.integer({ min: 1, max: 500000 }), { minLength: 1, maxLength: 12 }),
            fc.integer({ min: 0, max: 6000000 }),
            (duesP, amountP) => {
                const dues = duesP.map(p => p / 100);
                const amount = amountP / 100;
                let rest = amountP;
                const expected = duesP.map(d => { const part = Math.min(d, rest); rest -= part; return part; });
                const got = allocateOldestFirst(dues, amount);
                expect(got.amounts.map(paise)).toEqual(expected);
                expect(paise(got.left)).toBe(rest);
                expect(paise(got.allocated)).toBe(amountP - rest);
                const partPaid = got.amounts.map((a, i) => a > 0 && paise(a) < duesP[i]).filter(Boolean).length;
                expect(partPaid).toBeLessThanOrEqual(1);
                const before = duesP.reduce((s, d) => s + d, 0);
                const after = duesP.reduce((s, d, i) => s + d - paise(got.amounts[i]), 0);
                expect(after).toBe(before - paise(got.allocated));
            }
        ), { numRuns: 300, seed: 152 });
    });
});
