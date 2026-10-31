/**
 * Rent receipt oracle (#170 phase 2, docs/calculations.md RENT-12): receipts of
 * generated part payments, issued by the real store path (rent-store.js
 * recordPayment on the in-memory Firestore), compared with a plain
 * recomputation: total = rent + electricity, paid earlier = Σ earlier payments,
 * balance = total − Σ payments so far, numbers 1, 2, 3 … of the year. Money
 * amounts are whole rupees (#129 MONEY-ROUND): the electricity amount is units ×
 * rate rounded half-up, and the payments are whole-rupee shares.
 */
import fc from 'fast-check';
import { createFakeFirestore } from '../../www/js/__tests__/__mocks__/fake-firestore.js';

jest.mock('../../www/js/firebase/firestore-service.js', () => ({ FirebaseService: { get db() { return global.__rentOracleDb; }, serverTimestamp: () => 'SERVER_TIME' } }));

import { AppState } from '../../www/js/utils/state.js';
import * as store from '../../www/js/rentals/rent-store.js';
import { paidEarlier } from '../../www/js/rentals/rent-math.js';
import { istYear, receiptNo } from '../../www/js/rentals/rent-math.js';

const cents = (n) => Math.round(n * 100);

test('RENT-12: every receipt of a month adds up (property, fixed seed)', async () => {
    AppState.currentUser = { uid: 'u1' };
    await fc.assert(fc.asyncProperty(
        fc.integer({ min: 500, max: 20000 }),
        fc.option(fc.record({ units: fc.integer({ min: 0, max: 300 }), rate: fc.integer({ min: 0, max: 24 }).map(x => x / 2) }), { nil: null }),
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 5 }),
        async (rent, meter, weights) => {
            const fake = createFakeFirestore({ occ: true });
            global.__rentOracleDb = fake.db;
            const elec = meter ? { prev: 100, curr: 100 + meter.units, rate: meter.rate, units: meter.units, amount: Math.round(Math.round(meter.units * meter.rate * 100) / 100) } : null;
            const total = rent + (elec ? elec.amount : 0);
            fake.seed('rent_charges', [{ id: 'L1_2026-10', leaseId: 'L1', unitId: 'U1', propertyId: 'P1', tenantId: 'T1', month: '2026-10', dueDay: 10,
                rent, electricity: elec, amount: total, paid: 0, open: total > 0, payments: [] }]);
            // Oracle amounts (in paise, whole rupees): the weights' shares of the total, the last one takes the rest.
            const sum = weights.reduce((s, w) => s + w, 0);
            let left = cents(total);
            const amounts = weights.map((w, i) => {
                const a = i === weights.length - 1 ? left : Math.floor(total * w / sum) * 100;
                left -= a;
                return a;
            }).filter(a => a > 0);
            let before = 0;
            for (let i = 0; i < amounts.length; i++) {
                const { receipt: r } = await store.recordPayment('L1_2026-10', { amount: amounts[i] / 100, mode: 'cash', ref: '', date: '2026-10-05' }, { tenantName: 'Ram' });
                expect(r.no).toBe(receiptNo(istYear(), i + 1));
                expect(cents(r.total)).toBe(cents(total));
                expect(cents(r.paid)).toBe(amounts[i]);
                expect(cents(paidEarlier(r))).toBe(before);
                before += amounts[i];
                expect(cents(r.balance)).toBe(cents(total) - before);
                expect(r.elec).toEqual(elec);
            }
            expect(before).toBe(cents(total));
        }
    ), { seed: 170, numRuns: Number(process.env.FC_RUNS) || 40 });
});
