/**
 * @fileoverview utils/calc/billing.js: the bill forms' maths (docs/calculations.md
 * BF-*, WS-PROFIT, WS-MARGIN, DUE-CHECK). The forms themselves are pinned by
 * bill-forms-characterisation.test.js; the oracle is tests/oracle/billing.test.js.
 */
import {
    autoLabour, BILLING_SPEC, buildPaymentSplit, computeLine, computePurchaseTotals, computeRetailTotals,
    computeWholesaleTotals, draftLineSum, editedPaymentSplit, editKeepsMoney, entryAmount, hasPaise, meterAmount,
    paidOnScreen, payableOnScreen, paymentSplit, settleSplit,
    prefillPayment, restInDue, roundFor, ROUNDING, shownAmount, sumWeights, typedAmount, validateDuePayment,
    validatePaymentSplit, weightsForEdit, wholesaleLiveProfit
} from '../utils/calc/billing.js';
import * as billing from '../utils/calc/billing.js';

describe('ROUNDING: one named policy per figure (MONEY-ROUND, #129)', () => {
    test('the owner\'s decision: every money amount a whole rupee, half-up', () => {
        expect(ROUNDING).toEqual({
            lineAmount: 'rupee', billTotal: 'rupee', labour: 'rupee', payment: 'rupee', restInDue: 'rupee',
            tickFill: 'rupee', entryAmount: 'rupee', meterAmount: 'rupee', autoLabourBox: 'rupee', shown: 'rupee',
            margin: 'tenthOfPercent'
        });
        expect([roundFor('lineAmount', 415.4), roundFor('billTotal', 987.5), roundFor('billTotal', 987.49), roundFor('margin', 0.57753)])
            .toEqual([415, 988, 987, 57.8]);
        // Half-up on the amount in paise: 0.7 kg × ₹45 is ₹31.50 (31.499999999999996 in floating point)
        expect(computeLine({ rate: 45, qty: 0.7 }).total).toBe(32);
        expect(Object.is(roundFor('billTotal', -0.4), 0)).toBe(true);
    });

    test('every exported function has a spec ID', () => {
        const fns = Object.keys(billing).filter(k => typeof billing[k] === 'function' && !['roundFor', 'shownAmount', 'typedAmount'].includes(k));
        expect(fns.filter(k => !BILLING_SPEC[k])).toEqual([]);
    });
});

describe('BF-KG, BF-LINE: lines', () => {
    test('weights add up; the line amount is qty × rate in whole rupees', () => {
        expect(sumWeights([40, 20.3])).toBe(60.3);
        expect(sumWeights([])).toBe(0);
        expect(computeLine({ rate: 25.5, weights: [40, 20.3] })).toEqual({ qty: 60.3, packets: 2, total: 1538 });
        expect(computeLine({ rate: 33.5, qty: 12.4 })).toEqual({ qty: 12.4, packets: 0, total: 415 });
        expect(computeLine({ rate: 10, weights: [0.25] }).total).toBe(3);
    });

    test('weights put back when a line is edited', () => {
        expect(weightsForEdit({ qty: 50, packets: 2 })).toEqual([25, 25]);
        expect(weightsForEdit({ qty: 9, packets: 2, weights: [4, 5] })).toEqual([4, 5]);
        expect(weightsForEdit({ qty: 7.5 })).toEqual([7.5]);
    });
});

describe('BF-TOTAL, BF-LAB, BF-PAYABLE: purchase (#26)', () => {
    const items = [
        { total: 1530.25, weights: [40, 20.5] },
        { total: 1049.5, weights: [35] },
        { qty: 2.5, rate: 10.1 } // legacy line without total/weights
    ];
    test('totals from the lines in whole rupees; labour typed with paise is saved rounded (₹12.50 → ₹13)', () => {
        expect(computePurchaseTotals(items, 12.5, 30)).toEqual({
            billTotal: 2605, laborCharges: 13, grandTotal: 2592, totalPackets: 3, heavyPackets: 2
        });
        expect(computePurchaseTotals(items, 12.49, 30)).toMatchObject({ laborCharges: 12, grandTotal: 2593 });
    });
    test('#129 example: ₹1,000 of lines, ₹12.50 labour → ₹13 labour, ₹987 payable on screen, in the tick and saved', () => {
        const totals = computePurchaseTotals([{ total: 1000, weights: [40] }], 12.5, 30);
        expect(totals).toMatchObject({ billTotal: 1000, laborCharges: 13, grandTotal: 987 });
        expect(payableOnScreen(1000, 12.5)).toBe(987);
        expect(prefillPayment('cash', totals.grandTotal).cash).toBe(987);
        expect(validatePaymentSplit(totals.grandTotal, { cash: 987 })).toEqual({ ok: true, entered: 987, difference: 0 });
    });
    test('heavy packets use the threshold; no labour / junk labour → 0', () => {
        expect(computePurchaseTotals(items, undefined, 36)).toMatchObject({ heavyPackets: 1, laborCharges: 0, grandTotal: 2605 });
        expect(computePurchaseTotals([], 'x')).toEqual({ billTotal: 0, laborCharges: 0, grandTotal: 0, totalPackets: 0, heavyPackets: 0 });
    });
    test('auto labour: shared rate × heavy packets, whole rupees in the box (as toFixed(0) did)', () => {
        expect(autoLabour({ laborRate: 6 }, 2)).toEqual({ rate: 6, heavyPackets: 2, amount: 12, box: 12, working: '6 × 2' });
        expect(autoLabour({ laborRate: 6.25 }, 2)).toMatchObject({ amount: 12.5, box: 13, working: '6.25 × 2' });
        expect(autoLabour({ laborRate: '' }, 3)).toMatchObject({ rate: 6, box: 18 });
        for (let cents = 1; cents <= 2000; cents += 7) {
            for (let heavy = 0; heavy <= 12; heavy++) {
                const amount = (cents / 100) * heavy;
                expect(String(autoLabour({ laborRate: cents / 100 }, heavy).box)).toBe(amount.toFixed(0));
            }
        }
    });
    test('payable on screen: line total less the labour as saved, whole rupees (= grandTotal)', () => {
        expect(payableOnScreen(1953, 12.5)).toBe(1940);
        expect(payableOnScreen(1953, 0)).toBe(1953);
        expect(payableOnScreen(1953, '')).toBe(1953);
    });
});

describe('BF-TOTAL: retail', () => {
    test('saved total in whole rupees, screen total as a plain sum, packets shown vs saved', () => {
        // Lines with paise only come from bills saved before #129 (an edit re-saves them)
        const lines = [{ total: 100.4, qty: 2.5 }, { total: 50.3, qty: 1.5, packets: 2 }];
        expect(computeRetailTotals(lines)).toEqual({
            total: 151, screenTotal: 100.4 + 50.3, packetsShown: 3, packetsSaved: 2, kg: 4, lines: 2
        });
        expect(shownAmount(computeRetailTotals(lines).screenTotal)).toBe(151);
        expect(computeRetailTotals([])).toEqual({ total: 0, screenTotal: 0, packetsShown: 0, packetsSaved: 0, kg: 0, lines: 0 });
        expect(draftLineSum([{ total: 415 }, { total: 291 }])).toBe(706);
    });
});

describe('BF-TOTAL, WS-PROFIT, WS-MARGIN: wholesale (#26)', () => {
    test('total, cost from stock average rates, profit and profit % from the lines', () => {
        const lines = [{ itemId: 'a', qty: 10.5, total: 420 }, { itemId: 'b', quantity: 4, total: 100.5 }, { itemId: 'c', qty: 1, total: 50 }];
        const stock = { a: { rate: 30.2 }, b: { rate: 20 } };
        // cost 10.5 × 30.2 + 4 × 20 = 397.10 → 397; expenses 20.50 → 21 (as saved)
        expect(computeWholesaleTotals(lines, stock, 20.5)).toEqual({ total: 571, cost: 397, profit: 153, profitPercent: 26.8 });
        expect(computeWholesaleTotals([], {}, 0)).toEqual({ total: 0, cost: 0, profit: 0, profitPercent: 0 });
    });
    test('live profit adds the whole-rupee figure the form shows (never -0)', () => {
        const lines = [{ itemId: 'a', qty: 3.3, total: 66 }];
        expect(wholesaleLiveProfit(lines, { a: { rate: 22.4 } }, 10)).toEqual({ total: 66, cost: 74, profit: -18, profitPercent: -27.3, shownProfit: -18 });
        expect(Object.is(wholesaleLiveProfit([{ itemId: 'a', qty: 1, total: 10 }], { a: { rate: 10.3 } }).shownProfit, 0)).toBe(true);
    });
});

describe('BF-PAID, BF-SAVE, BF-FILL: the payment split', () => {
    test('typed amounts saved in whole rupees; paid shown in rupees; payment object', () => {
        const split = paymentSplit({ online: 500.354, cash: 1000.5, due: 0 });
        expect(split).toEqual({ online: 500, cash: 1001, due: 0 });
        expect(paidOnScreen(split)).toBe(1501);
        expect(buildPaymentSplit({ online: 500, cash: 1001, due: 445 })).toEqual({ online: 500, cash: 1001, due: 445, total: 1946 });
        expect([typedAmount(20.505), typedAmount(20.49), typedAmount(20.5)]).toEqual([21, 20, 21]);
    });
    test('MONEY-ROUND: expense, withdrawal, deposit and "No bill" amounts as saved; electricity (RENT-7)', () => {
        expect([entryAmount('45.50'), entryAmount(45.49), entryAmount('0.4'), entryAmount(''), entryAmount('x')]).toEqual([46, 45, 0, 0, 0]);
        // 123 units × ₹7.35 = ₹904.05
        expect([meterAmount(123, 7.35), meterAmount(50.5, 8), meterAmount(3, 0.5)]).toEqual([904, 404, 2]);
    });
    test('a tick fills the whole total in rupees, 0 in the others', () => {
        expect(prefillPayment('cash', 1940.5)).toEqual({ online: '0', cash: 1941, due: '0' });
        expect(prefillPayment('online', 706)).toEqual({ online: 706, cash: '0', due: '0' });
        expect(prefillPayment('due', 99.4)).toEqual({ online: '0', cash: '0', due: 99 });
    });
    test('Rest → Due: what is left in paise; refused when more is paid than the total', () => {
        expect(restInDue(1945.75, { cash: 1000.4, online: 500.35 })).toEqual({ ok: true, due: 445, dueTicked: true });
        expect(restInDue(100, { cash: 100, online: 0 })).toEqual({ ok: true, due: 0, dueTicked: false });
        expect(restInDue(1953, { cash: 2000, online: 6 })).toEqual({ ok: false, check: { ok: false, entered: 2006, difference: -53 } });
    });
});

describe('BF-SPLIT: validatePaymentSplit (#23)', () => {
    test('match, short, over and rounding within ₹1', () => {
        expect(validatePaymentSplit(1000, { cash: 600, online: 100, due: 300 })).toEqual({ ok: true, entered: 1000, difference: 0 });
        expect(validatePaymentSplit(5000, { cash: 500 })).toEqual({ ok: false, entered: 500, difference: 4500 });
        expect(validatePaymentSplit(5000, { cash: 50000 })).toEqual({ ok: false, entered: 50000, difference: -45000 });
        expect(validatePaymentSplit(2567.5, { cash: 2568 }).ok).toBe(true);
        expect(validatePaymentSplit(100, { cash: 0.1, online: 0.2, due: 98.7 })).toMatchObject({ ok: true, entered: 99 });
        expect(validatePaymentSplit(100, { cash: 98.9 }).ok).toBe(false);
    });
});

describe('DUE-CHECK: validateDuePayment', () => {
    test.each([
        // A due with paise (saved before #129) paid off exactly: whole-rupee legs, its paise remainder in one leg
        ['500.26', 0, 500.25, { ok: true, cash: 500.25, online: 0, total: 500.25 }],
        ['987.5', 0, 987.5, { ok: true, cash: 987.5, online: 0, total: 987.5 }],
        ['487.5', '500', 987.5, { ok: true, cash: 487.5, online: 500, total: 987.5 }],
        ['487.4', '500.1', 987.5, { ok: true, cash: 487.5, online: 500, total: 987.5 }],
        // A whole-rupee due gets whole-rupee legs, even when the paise add up to it
        ['0.01', '99.99', 100, { ok: true, cash: 0, online: 100, total: 100 }],
        ['99.5', '0.5', 100, { ok: false, error: 'exceeds-due' }],
        // Anything else is saved in whole rupees
        ['500.27', 0, 500.25, { ok: true, cash: 500, online: 0, total: 500 }],
        ['300.6', '200.2', 1000, { ok: true, cash: 301, online: 200, total: 501 }],
        ['988', 0, 987.5, { ok: false, error: 'exceeds-due' }],
        ['0.4', 0, 10, { ok: false, error: 'empty' }],
        ['', undefined, 10, { ok: false, error: 'empty' }],
        ['abc', 0, 10, { ok: false, error: 'empty' }],
        [0, -1, 10, { ok: false, error: 'negative' }]
    ])('validateDuePayment(%p, %p, due %p)', (cash, online, due, expected) => {
        expect(validateDuePayment(cash, online, due)).toEqual(expected);
    });
});

describe('BF-SAVE on an edited bill (#129 review)', () => {
    // A bill saved before #129: ₹1,000 of lines, ₹12.50 labour, payable ₹987.50
    const oldBill = (payment) => ({
        items: [{ itemId: 'rice', name: 'Rice', qty: 40, rate: 25, total: 1000, weights: [40] }],
        billTotal: 1000, laborCharges: 12.5, grandTotal: 987.5, amountPayable: 987.5,
        cashPayment: payment.cash, onlinePayment: payment.online, dueAmount: payment.due,
        payment: { ...payment, total: 987.5 }
    });

    test('hasPaise / settleSplit: rounded legs, the remainder in Due, else the largest leg, never below 0', () => {
        expect([hasPaise(987.5), hasPaise(988), hasPaise('0.5'), hasPaise(null)]).toEqual([true, false, true, false]);
        expect(settleSplit({ cash: 300.5, online: 300.5, due: 386.5 }, 987, ['due'])).toEqual({ cash: 301, online: 301, due: 385 });
        expect(settleSplit({ cash: 487.5, online: 500, due: 0 }, 987, ['due'])).toEqual({ cash: 488, online: 499, due: 0 });
        expect(settleSplit({ cash: 0, online: 0, due: 0.5 }, 0, ['due'])).toEqual({ cash: 0, online: 0, due: 0 });
    });

    test('2 legs, ₹987.50 old payable: the split adds up to the new ₹987 exactly (not ₹988 "overpaid")', () => {
        const typed = { cash: 487.5, online: 500, due: 0 };
        expect(paymentSplit(typed)).toEqual({ cash: 488, online: 500, due: 0 });
        const split = editedPaymentSplit(typed, 987, 987.5);
        expect(split).toEqual({ cash: 488, online: 499, due: 0 });
        expect(validatePaymentSplit(987, split)).toMatchObject({ ok: true, difference: 0 });
    });

    test('3 legs: 301 + 301 + 387 = 989 would fail BF-SPLIT against ₹987; settled it is 301 + 301 + 385', () => {
        const typed = { cash: 300.5, online: 300.5, due: 386.5 };
        expect(validatePaymentSplit(987, paymentSplit(typed)).ok).toBe(false);
        const split = editedPaymentSplit(typed, 987, 987.5);
        expect(split).toEqual({ cash: 301, online: 301, due: 385 });
        expect(buildPaymentSplit(split).total).toBe(987);
    });

    test('a ₹0.50 old due on a ₹1,000 sale: the due is ₹0 after the edit, not ₹1', () => {
        expect(paymentSplit({ cash: 999.5, online: 0, due: 0.5 })).toEqual({ cash: 1000, online: 0, due: 1 });
        expect(editedPaymentSplit({ cash: 999.5, online: 0, due: 0.5 }, 1000, 1000)).toEqual({ cash: 1000, online: 0, due: 0 });
    });

    test('a split still being changed (more than ₹1 off) is only rounded, so the form shows what is left', () => {
        expect(editedPaymentSplit({ cash: 500.4, online: 0, due: 0 }, 987, 987.5)).toEqual({ cash: 500, online: 0, due: 0 });
    });

    test('editKeepsMoney: unchanged lines, labour and split keep the stored money; any money change does not', () => {
        const bill = oldBill({ cash: 487.5, online: 500, due: 0 });
        const items = bill.items.map(l => ({ ...l }));
        const typed = { cash: 487.5, online: 500, due: 0 };
        expect(editKeepsMoney({ bill, items, labour: 12.5, typed })).toBe(true);
        expect(editKeepsMoney({ bill, items, labour: 13, typed })).toBe(false);
        expect(editKeepsMoney({ bill, items, labour: 12.5, typed: { ...typed, cash: 488 } })).toBe(false);
        expect(editKeepsMoney({ bill, items: [{ ...items[0], qty: 41 }], labour: 12.5, typed })).toBe(false);
        // Sales have no labour; top-level-only payments are read as BILL-PAY reads them
        const sale = { items: [{ name: 'Rice', qty: 2, rate: 50.25, total: 100.5 }], total: 100.5, cashPayment: 100, dueAmount: 0.5 };
        expect(editKeepsMoney({ bill: sale, items: sale.items, typed: { cash: 100, online: 0, due: 0.5 } })).toBe(true);
    });
});
