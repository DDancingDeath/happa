/**
 * @fileoverview Oracle for "Receive payment" over a party's bills
 * (docs/calculations.md DUE-FIFO): an independent oldest-first fill agrees with
 * allocateOldestFirst (whole-rupee amount; a part-paid bill gets whole rupees),
 * and the party's due after = before − what was allocated; edited parts are
 * accepted only when they add up to the amount (or the two exceptions); and the
 * bills are in age order (time, else date, then document id).
 */
import fc from 'fast-check';
import { allocateOldestFirst, checkAllocation } from '../../www/js/utils/calc/billing.js';
import { partyDues } from '../../www/js/utils/due-payments.js';

const paise = (x) => Math.round(x * 100);

describe('DUE-FIFO: one payment over the oldest bills first', () => {
    test('each bill up to its due in order; only the last one reached is part-paid; the rest is left', () => {
        fc.assert(fc.property(
            fc.array(fc.integer({ min: 1, max: 500000 }), { minLength: 1, maxLength: 12 }),
            fc.integer({ min: 0, max: 60000 }),
            (duesP, rupees) => {
                const dues = duesP.map(p => p / 100);
                const amount = rupees;
                const amountP = rupees * 100;
                let rest = amountP;
                // A bill paid in full keeps its paise; a part-paid one gets the whole rupees left
                const expected = duesP.map(d => { const part = rest >= d ? d : Math.min(Math.floor(rest / 100) * 100, Math.floor(d / 100) * 100); rest -= part; return part; });
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

describe('DUE-FIFO: the parts must add up to the amount', () => {
    test('accepted exactly when Σ parts = amount, or every bill is full and the amount is more, or < ₹1 short by old paise', () => {
        fc.assert(fc.property(
            fc.array(fc.record({ due: fc.integer({ min: 100, max: 50000 }), paise: fc.boolean() }), { minLength: 1, maxLength: 6 }),
            fc.array(fc.integer({ min: 0, max: 600 }), { minLength: 6, maxLength: 6 }),
            fc.integer({ min: 1, max: 3000 }),
            (raw, partsR, rupees) => {
                const duesP = raw.map(r => r.due * 100 + (r.paise ? 50 : 0));
                const dues = duesP.map(p => p / 100);
                // A part is whole rupees up to the due, or the whole due (paise kept)
                const partsP = duesP.map((d, i) => (partsR[i] * 100 >= d ? d : partsR[i] * 100));
                const total = partsP.reduce((s, p) => s + p, 0);
                const amountP = rupees * 100;
                const allFull = partsP.every((p, i) => p === duesP[i]);
                const expectOk = total > 0 && (total === amountP
                    || (allFull && total < amountP)
                    || (total < amountP && amountP - total < 100 && total % 100 !== 0));
                const got = checkAllocation(dues, partsP.map(p => String(p / 100)), rupees);
                expect(got.ok).toBe(expectOk);
                if (got.ok) expect(paise(got.total)).toBe(total);
                const fill = allocateOldestFirst(dues, rupees);
                expect(checkAllocation(dues, fill.amounts.map(String), rupees).ok).toBe(true);
            }
        ), { numRuns: 400, seed: 1521 });
    });
});

describe('DUE-FIFO / DUE-ALL order', () => {
    test('by numeric time, else the bill date, then the document id (ties stable)', () => {
        fc.assert(fc.property(
            fc.array(fc.record({ t: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }), day: fc.integer({ min: 1, max: 3 }) }), { minLength: 1, maxLength: 8 }),
            (raw) => {
                const bills = raw.map((r, i) => ({ id: `b${String(9 - i)}`, customerName: 'P', timestamp: r.t, date: `0${r.day}/01/1970`, payment: { due: 10 } }));
                const time = (b) => (b.timestamp ? b.timestamp : new Date(1970, 0, Number(b.date.slice(0, 2))).getTime());
                const expected = [...bills].sort((a, b) => (time(a) - time(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(b => b.id);
                expect(partyDues(bills, 'p', (n) => String(n).toLowerCase()).bills.map(x => x.bill.id)).toEqual(expected);
            }
        ), { numRuns: 200, seed: 1522 });
    });
});
