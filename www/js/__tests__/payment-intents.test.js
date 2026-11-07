/**
 * @fileoverview services/payment-intents.js (D-1, #70): a payment's entry id is owned by the
 * intent (bill, amounts, action), not by the amount box, and is kept until the payment is known
 * to be recorded.
 */
import {
    PAYMENT_INTENT_TTL_MS, forgetPaymentIntents, paymentEntryOf, paymentIntentIds, paymentIntentKey,
    paymentOutcomeUnknown, pendingPaymentIntent, settlePaymentIntent
} from '../services/payment-intents.js';

beforeEach(() => forgetPaymentIntents());

describe('payment intents', () => {
    const key = paymentIntentKey({ billType: 'retail', billId: 'r1', cash: 100, online: 0 });

    test('the same bill and amounts keep the same id until the payment is known to be recorded', () => {
        const [id] = paymentIntentIds(key, 1, 1000);
        expect(paymentIntentIds(key, 1, 2000)).toEqual([id]);
        expect(paymentIntentIds(paymentIntentKey({ billType: 'retail', billId: 'r1', cash: '100.001', online: 0 }), 1, 3000)).toEqual([id]);
        expect(paymentIntentIds(paymentIntentKey({ billType: 'retail', billId: 'r1', cash: 101 }), 1, 3000)).not.toEqual([id]);
        expect(paymentIntentIds(paymentIntentKey({ billType: 'retail', billId: 'r1', cash: 100, kind: 'clear' }), 1, 3000)).not.toEqual([id]);
        settlePaymentIntent(key);
        expect(pendingPaymentIntent(key, 4000)).toBeNull();
        expect(paymentIntentIds(key, 1, 5000)).not.toEqual([id]);
    });

    test('kept across a reload (localStorage) and forgotten after a day', () => {
        const ids = paymentIntentIds(key, 2, 1000);
        expect(JSON.parse(localStorage.getItem('aadhat.paymentIntents'))[key].ids).toEqual(ids);
        expect(pendingPaymentIntent(key, 1000 + PAYMENT_INTENT_TTL_MS - 1)).toEqual({ ids, at: 1000 });
        expect(pendingPaymentIntent(key, 1000 + PAYMENT_INTENT_TTL_MS)).toBeNull();
    });

    test('only refusals are a known outcome; no answer may hide a commit', () => {
        ['exceeds-due', 'voided', 'not-found', 'due-changed', 'permission-denied', 'invalid-argument']
            .forEach(code => expect(paymentOutcomeUnknown({ code })).toBe(false));
        [{ code: 'unavailable' }, { code: 'deadline-exceeded' }, { code: 'aborted' }, new Error('Timed out'), null]
            .forEach(e => expect(paymentOutcomeUnknown(e)).toBe(true));
    });

    test('paymentEntryOf finds the entry by id only', () => {
        const bill = { payments: [{ id: 'a', amount: 5 }, null, { amount: 9 }] };
        expect(paymentEntryOf(bill, 'a')).toEqual({ id: 'a', amount: 5 });
        expect(paymentEntryOf(bill, 'b')).toBeNull();
        expect(paymentEntryOf(bill, null)).toBeNull();
        expect(paymentEntryOf(null, 'a')).toBeNull();
    });
});
