/**
 * @fileoverview Oracle test for DUE-ALL (docs/calculations.md, #150): what
 * "Complete all due" settles for a party equals an independent sum of that party's
 * open dues, and settling every bill leaves the party owing nothing.
 */
import fc from 'fast-check';
import * as O from './oracle.js';
import { partyDues, settleDueUpdate } from '../../www/js/utils/due-payments.js';
import { normalizePartyName } from '../../www/js/utils/aging.js';

const RUNS = Number(process.env.FC_RUNS) || 200;
const r2 = (x) => Math.round(x * 100) / 100;

test('DUE-ALL: the party total and the settled amounts match the oracle; nothing is left owing', () => {
    const party = fc.constantFrom('Gupta Traders', ' gupta  traders', 'GUPTA TRADERS', 'Other');
    const billArb = fc.record({
        customerName: party,
        due: fc.integer({ min: 0, max: 500000 }).map(x => x / 100),
        cleared: fc.boolean(),
        timestamp: fc.integer({ min: 1, max: 1e6 })
    }).map(b => ({ ...b, total: b.due + 10, payment: { cash: 10, online: 0, due: b.due, total: 10 }, dueAmount: b.due }));
    fc.assert(fc.property(fc.array(billArb, { maxLength: 12 }), (bills) => {
        const key = normalizePartyName('Gupta Traders');
        const mine = bills.filter(b => b.customerName.trim().replace(/\s+/g, ' ').toLowerCase() === 'gupta traders');
        const want = r2(mine.reduce((s, b) => s + O.openDue(b), 0));
        const got = partyDues(bills, key, normalizePartyName);
        expect(got.total).toBe(want);
        expect(got.bills.length).toBe(mine.filter(b => O.openDue(b) > 0).length);

        const after = got.bills.map(({ bill }) => {
            const part = settleDueUpdate(bill, 'cash', { at: 1 });
            return { amount: part.amount, bill: { ...bill, ...part.update } };
        });
        expect(r2(after.reduce((s, x) => s + x.amount, 0))).toBe(want);
        expect(after.every(x => O.openDue(x.bill) === 0)).toBe(true);
    }), { seed: 150, numRuns: RUNS });
});
