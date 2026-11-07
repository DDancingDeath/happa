/**
 * @fileoverview services/payment-intents.js (D-1, #70): a payment's entry id is owned by the
 * intent (bill, amounts, action), not by the amount box, and is kept until the payment is known
 * to be recorded.
 */
import {
    PAYMENT_INTENT_TTL_MS, PAYMENT_RETRY_WINDOW_MS, forgetPaymentIntents, isRetryOf, paymentEntryOf, paymentIntentIds,
    paymentIntentKey, paymentOutcomeUnknown, pendingPaymentIntent, settlePaymentIntent
} from '../services/payment-intents.js';

beforeEach(() => forgetPaymentIntents());

describe('payment intents', () => {
    const key = paymentIntentKey({ billType: 'retail', billId: 'r1', cash: 100, online: 0 });

    test('the same bill and amounts keep the same id until the payment is known to be recorded', () => {
        const [id] = paymentIntentIds(key, ['r1'], 1000);
        expect(paymentIntentIds(key, ['r1'], 2000)).toEqual([id]);
        expect(paymentIntentIds(paymentIntentKey({ billType: 'retail', billId: 'r1', cash: '100.001', online: 0 }), ['r1'], 3000)).toEqual([id]);
        expect(paymentIntentIds(paymentIntentKey({ billType: 'retail', billId: 'r1', cash: 101 }), ['r1'], 3000)).not.toEqual([id]);
        expect(paymentIntentIds(paymentIntentKey({ billType: 'retail', billId: 'r1', cash: 100, kind: 'clear' }), ['r1'], 3000)).not.toEqual([id]);
        settlePaymentIntent(key);
        expect(pendingPaymentIntent(key, 4000)).toBeNull();
        expect(paymentIntentIds(key, ['r1'], 5000)).not.toEqual([id]);
    });

    test('kept across a reload (localStorage) and forgotten after a day; a retry soon after the last try', () => {
        const ids = paymentIntentIds(key, ['a', 'b'], 1000);
        expect(JSON.parse(localStorage.getItem('aadhat.paymentIntents'))[key].ids).toEqual(ids);
        expect(pendingPaymentIntent(key, 1000 + PAYMENT_INTENT_TTL_MS - 1)).toEqual({ ids, docs: ['a', 'b'], at: 1000 });
        expect(pendingPaymentIntent(key, 1000 + PAYMENT_INTENT_TTL_MS)).toBeNull();
        expect(isRetryOf(pendingPaymentIntent(key, 2000), 1000 + PAYMENT_RETRY_WINDOW_MS - 1)).toBe(true);
        expect(isRetryOf(pendingPaymentIntent(key, 2000), 1000 + PAYMENT_RETRY_WINDOW_MS)).toBe(false);
    });

    test('localStorage is the one source: an intent settled in another tab stays settled here', () => {
        paymentIntentIds(key, ['r1'], 1000);
        localStorage.setItem('aadhat.paymentIntents', '{}');
        expect(pendingPaymentIntent(key, 2000)).toBeNull();
        paymentIntentIds(paymentIntentKey({ billType: 'retail', billId: 'r2', cash: 5 }), ['r2'], 3000);
        expect(Object.keys(JSON.parse(localStorage.getItem('aadhat.paymentIntents')))).toEqual(['pay|retail|r2|5|0']);
    });

    test('a bill tried before keeps its id when the same payment is spread differently', () => {
        const [a, b] = paymentIntentIds(key, ['A', 'B'], 1000);
        const [c, a2] = paymentIntentIds(key, ['C', 'A'], 2000);
        expect(a2).toBe(a);
        expect([a, b]).not.toContain(c);
        expect(pendingPaymentIntent(key, 2000)).toEqual({ ids: [a, b, c], docs: ['A', 'B', 'C'], at: 2000 });
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
