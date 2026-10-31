/**
 * @fileoverview utils/calc/billing.js: the bill forms' maths (docs/calculations.md
 * BF-*, WS-PROFIT, WS-MARGIN, DUE-CHECK). The forms themselves are pinned by
 * bill-forms-characterisation.test.js; the oracle is tests/oracle/billing.test.js.
 */
import {
    autoLabour, BILLING_SPEC, buildPaymentSplit, computeLine, computePurchaseTotals, computeRetailTotals,
    computeWholesaleTotals, draftLineSum, paidOnScreen, payableOnScreen, paymentSplit, prefillPayment, restInDue,
    roundFor, ROUNDING, shownAmount, sumWeights, typedAmount, validateDuePayment, validatePaymentSplit,
    weightsForEdit, wholesaleCostRate, wholesaleLiveProfit
} from '../utils/calc/billing.js';
import * as billing from '../utils/calc/billing.js';

describe('ROUNDING: one named policy per figure (#129 open)', () => {
    test('today\'s choices', () => {
        expect(ROUNDING).toEqual({
            lineAmount: 'rupee', billTotal: 'paise', payment: 'paise', restInDue: 'paise',
            tickFill: 'rupee', autoLabourBox: 'rupee', shown: 'rupee', margin: 'tenthOfPercent'
        });
        expect([roundFor('lineAmount', 415.4), roundFor('billTotal', 987.505), roundFor('margin', 0.57753)]).toEqual([415, 987.51, 57.8]);
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
    test('totals come from the lines with paise kept, labour deducted', () => {
        expect(computePurchaseTotals(items, 12.5, 30)).toEqual({
            billTotal: 2605.0, laborCharges: 12.5, grandTotal: 2592.5, totalPackets: 3, heavyPackets: 2
        });
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
    test('payable on screen: line total less the labour box, whole rupees', () => {
        expect(payableOnScreen(1953, 12.5)).toBe(1941);
        expect(payableOnScreen(1953, 0)).toBe(1953);
    });
});

describe('BF-TOTAL: retail', () => {
    test('saved total in paise, screen total as a plain sum, packets shown vs saved', () => {
        const lines = [{ total: 100.4, qty: 2.5 }, { total: 50.3, qty: 1.5, packets: 2 }];
        expect(computeRetailTotals(lines)).toEqual({
            total: 150.7, screenTotal: 100.4 + 50.3, packetsShown: 3, packetsSaved: 2, kg: 4, lines: 2
        });
        expect(shownAmount(computeRetailTotals(lines).screenTotal)).toBe(151);
        expect(computeRetailTotals([])).toEqual({ total: 0, screenTotal: 0, packetsShown: 0, packetsSaved: 0, kg: 0, lines: 0 });
        expect(draftLineSum([{ total: 415 }, { total: 291 }])).toBe(706);
    });
});

describe('BF-TOTAL, WS-PROFIT, WS-MARGIN: wholesale (#26)', () => {
    test('total, cost from stock average rates, profit and profit % from the lines', () => {
        const lines = [{ itemId: 'a', qty: 10.5, total: 420 }, { itemId: 'b', quantity: 4, total: 100.5 }, { itemId: 'c', qty: 1, total: 50 }];
        const stock = { a: { rate: 30.2 }, b: { rate: 20 }, c: { rate: 15 } };
        expect(computeWholesaleTotals(lines, stock, 20.5)).toEqual({ total: 570.5, cost: 412.1, profit: 137.9, profitPercent: 24.2, unknownCost: [] });
        expect(computeWholesaleTotals([], {}, 0)).toEqual({ total: 0, cost: 0, profit: 0, profitPercent: 0, unknownCost: [] });
    });
    test('a line without an average cost makes the profit unknown, never cost ₹0 (#102, WS-COST)', () => {
        const lines = [{ itemId: 'a', qty: 10.5, total: 420 }, { itemId: 'b', quantity: 4, total: 100.5 }, { itemId: 'c', qty: 1, total: 50 }];
        expect(computeWholesaleTotals(lines, { a: { rate: 30.2 }, b: { rate: 20 }, c: { rate: 0 } }, 20.5))
            .toEqual({ total: 570.5, cost: 397.1, profit: null, profitPercent: null, unknownCost: [2] });
        expect(wholesaleLiveProfit(lines.slice(2), {}).shownProfit).toBeNull();
    });
    test('WS-COST finds the stock by itemId, else the catalogue item by id / name / Hindi name', () => {
        const catalogue = [{ id: 'rice', name: 'Rice', hindiName: 'चावल' }, { id: 'dal', name: 'Dal' }];
        expect(wholesaleCostRate({ itemId: 'rice' }, { rice: { rate: 30 } }, catalogue)).toBe(30);
        expect(wholesaleCostRate({ name: 'चावल' }, { rice: { rate: 31 } }, catalogue)).toBe(31);
        expect(wholesaleCostRate({ itemId: 'old-id', name: 'rice ' }, { Rice: { rate: 29 } }, catalogue)).toBe(29);
        expect(wholesaleCostRate({ itemId: 'dal' }, { dal: { quantity: 5 } }, catalogue)).toBeNull();
        expect(wholesaleCostRate({ name: 'Corn ' }, { corn: { rate: 18 } }, catalogue)).toBe(18);
        expect(wholesaleCostRate({ itemId: 'gone', name: 'Gone' }, { rice: { rate: 30 } }, catalogue)).toBeNull();
    });
    test('live profit adds the whole-rupee figure the form shows (never -0)', () => {
        const lines = [{ itemId: 'a', qty: 3.3, total: 66 }];
        expect(wholesaleLiveProfit(lines, { a: { rate: 22.4 } }, 10)).toEqual({ total: 66, cost: 73.92, profit: -17.92, profitPercent: -27.2, shownProfit: -18, unknownCost: [] });
        expect(Object.is(wholesaleLiveProfit([{ itemId: 'a', qty: 1, total: 10 }], { a: { rate: 10.3 } }).shownProfit, 0)).toBe(true);
    });
});

describe('BF-PAID, BF-SAVE, BF-FILL: the payment split', () => {
    test('typed amounts in paise; paid shown in rupees; payment object', () => {
        const split = paymentSplit({ online: 500.354, cash: 1000.4, due: 0 });
        expect(split).toEqual({ online: 500.35, cash: 1000.4, due: 0 });
        expect(paidOnScreen(split)).toBe(1501);
        expect(buildPaymentSplit({ online: 500.35, cash: 1000.4, due: 445 })).toEqual({ online: 500.35, cash: 1000.4, due: 445, total: 1945.75 });
        expect(typedAmount(20.505)).toBe(20.51);
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
        ['500.26', 0, 500.25, { ok: true, cash: 500.26, online: 0, total: 500.26 }],
        ['500.27', 0, 500.25, { ok: false, error: 'exceeds-due' }],
        ['', undefined, 10, { ok: false, error: 'empty' }],
        ['abc', 0, 10, { ok: false, error: 'empty' }],
        [0, -1, 10, { ok: false, error: 'negative' }]
    ])('validateDuePayment(%p, %p, due %p)', (cash, online, due, expected) => {
        expect(validateDuePayment(cash, online, due)).toEqual(expected);
    });
});
