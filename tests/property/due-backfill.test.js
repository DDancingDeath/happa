/**
 * @fileoverview DUE-BACKFILL (#126): the owner's one-time backfill (dueBackfillFields, written by
 * FirebaseService.backfillDueFields) stores each bill's due once, as a number in payment.due: the
 * due the old app read (#126: the app reads payment.due only). On every due shape
 * (tests/fixtures/due-shapes.js) and on mixed old and new bills Outstanding, the statements, the
 * cash day, Today and the "Already owes ₹X" line then show what the old app showed (shownBefore),
 * and a second run must find nothing to write. A due payment after it gives the same figures as
 * on the bill as the old app showed it.
 */
import fc from 'fast-check';
import { dueBackfillFields, withCanonicalDue } from '../../www/js/firebase/repos/bill-due.js';
import { duePaymentUpdate } from '../../www/js/utils/due-payments.js';
import { isActiveBill, readPayment } from '../../www/js/utils/money.js';
import { billsArb, legacyBill, SHAPES, TYPES, screenFigures, shownBefore } from '../fixtures/due-shapes.js';

const RUNS = Number(process.env.FC_RUNS) || 40;
const FC = { seed: 1126, numRuns: RUNS, endOnFailure: true };

/** One backfill pass over the bills (what backfillDueFields writes on each). */
function backfill(bills) {
    let writes = 0;
    const out = bills.map(b => {
        const need = dueBackfillFields(b);
        expect(need?.reason).not.toBe('changes');
        if (!need?.fields) return b;
        writes++;
        return { ...b, ...need.fields, clientVersion: 5 };
    });
    return { bills: out, writes };
}

/** A due payment of ₹1 on every active bill with a due, as the payment path writes it. */
function payOne(bills) {
    return bills.map(b => {
        if (!isActiveBill(b) || b.cleared || !(readPayment(b).due >= 1)) return b;
        const out = duePaymentUpdate(b, { cash: 1, online: 0 }, { id: `pay-${b.id}`, amount: 1, cash: 1, online: 0, at: 1 });
        return out.ok ? { ...b, ...withCanonicalDue(out.update) } : b;
    });
}

const EXPECTED_REASON = {
    modern: null, drift: null, paymentOnly: null, topOnly: 'missing', paymentNoDue: 'missing', nullDue: 'notNumber',
    stringDue: 'missing', topDue: 'missing', amountPaid: 'missing', dueOnly: 'missing', topDueOnly: 'missing', opening: null
};
// A voided bill counts nowhere and the rules refuse any change to it, so the backfill leaves it as it is
const figures = (bills) => screenFigures(bills.filter(isActiveBill));

describe('DUE-BACKFILL', () => {
    test.each(TYPES.flatMap(type => SHAPES.map(shape => [type, shape])))('%s, %s: reason, figures unchanged, idempotent', (type, shape) => {
        const bills = [legacyBill({ id: 'a', type, shape, total: 1000.5, cash: 300, online: 200 }),
            legacyBill({ id: 'c', type, shape, total: 700, cash: 0, online: 0, cleared: true }),
            legacyBill({ id: 'v', type, shape, total: 900, cash: 100, online: 0, voided: true })];
        expect(dueBackfillFields(bills[0])?.reason ?? null).toBe(EXPECTED_REASON[shape]);
        expect(dueBackfillFields(bills[2])).toBeNull();
        const once = backfill(bills);
        expect(figures(once.bills)).toEqual(figures(bills.map(shownBefore)));
        once.bills.filter(isActiveBill).forEach((b, i) => {
            // Left as they are: nothing owed either way
            if (readPayment(b).due === 0 && bills[i].oldDue === 0 && typeof b.payment?.due !== 'number') return;
            expect(b.payment.due).toBe(bills[i].oldDue);
        });
        expect(backfill(once.bills)).toEqual({ bills: once.bills, writes: 0 });
    });

    test('a bill with nothing owed either way is not written (no noise)', () => {
        expect(dueBackfillFields({ id: 'z', type: 'retail', total: 500 })).toBeNull();
        expect(dueBackfillFields({ id: 'z', type: 'retail', total: 500, amountPaid: 500 })).toBeNull();
        expect(dueBackfillFields({ id: 'z', type: 'retail', total: 500, payment: { cash: 500, due: null } })).toBeNull();
        expect(dueBackfillFields({ id: 'z', type: 'retail', total: 500, cashPayment: 500, dueAmount: 0 })).toBeNull();
        expect(dueBackfillFields({ id: 'z', type: 'retail', total: 500, dueAmount: 500 })).toEqual({ reason: 'missing', fields: { payment: { due: 500 } } });
        expect(dueBackfillFields({ id: 'z', type: 'retail', total: 500, amountPaid: 100 })).toMatchObject({ reason: 'missing', fields: { payment: { due: 400 } } });
    });
    test('a payment stored as something else than a map, or a NaN where the write goes, is never written; reported as changes', () => {
        const base = legacyBill({ id: 'x', type: 'retail', shape: 'topOnly', total: 1000, cash: 400, online: 0 });
        for (const payment of ['cash', [{ amount: 400 }], 7]) {
            expect(dueBackfillFields({ ...base, payment })).toEqual({ reason: 'changes', fields: null });
        }
        expect(dueBackfillFields({ ...base, payment: { cash: 400, due: NaN } })).toEqual({ reason: 'changes', fields: null });
        expect(dueBackfillFields({ ...base, payment: { cash: 400, online: 0 }, dueAmount: NaN })).toEqual({ reason: 'changes', fields: null });
        expect(dueBackfillFields({ ...base, payment: { cash: NaN, online: 0, due: 600 }, dueAmount: 600 })).toBeNull();
        expect(dueBackfillFields({ ...base, payment: { cash: 400, online: 0, due: 600 }, dueAmount: NaN })).toBeNull();
    });

    test('property: mixed old and new bills: same figures after the backfill, nothing left on a second run, a payment is the same before or after it', () => {
        fc.assert(fc.property(billsArb(1, 12), (bills) => {
            const shown = bills.map(shownBefore);
            const once = backfill(bills);
            expect(figures(once.bills)).toEqual(figures(shown));
            const twice = backfill(once.bills);
            expect(twice.writes).toBe(0);
            expect(twice.bills).toEqual(once.bills);
            expect(figures(payOne(once.bills))).toEqual(figures(payOne(shown)));
        }), FC);
    });
});
