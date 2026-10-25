/**
 * @fileoverview Tests for money helpers / payment schema normalisation
 */
import { round2, sumMoney, readPayment, billTotal, outstandingDue, computePurchaseTotals, computeWholesaleTotals, checkPaymentSplit, paymentSplitMessage, dueNeedsName, isOpeningBalance, openingAmount, openingSourceNumbers, wholesaleOutstanding } from '../utils/money.js';

describe('round2', () => {
    test('rounds half-paise correctly', () => {
        expect(round2(1.005)).toBe(1.01);
        expect(round2(0.1 + 0.2)).toBe(0.3);
        expect(round2('12.345')).toBe(12.35);
        expect(round2(undefined)).toBe(0);
    });
});

describe('sumMoney', () => {
    test('sums with mapper and ignores junk', () => {
        expect(sumMoney([{ a: 0.1 }, { a: 0.2 }, { a: 'x' }], x => x.a)).toBe(0.3);
        expect(sumMoney(null)).toBe(0);
    });
});

describe('readPayment', () => {
    test('current schema (payment object + top-level copies)', () => {
        const bill = {
            grandTotal: 1000, amountPayable: 1000, billTotal: 1100,
            onlinePayment: 300, cashPayment: 200, dueAmount: 500,
            payment: { online: 300, cash: 200, due: 500, total: 1000 }
        };
        expect(readPayment(bill)).toEqual({ total: 1000, cash: 200, online: 300, due: 500, paid: 500 });
    });

    test('payment object wins over stale top-level fields after a due payment', () => {
        const bill = {
            total: 1000, cashPayment: 0, dueAmount: 1000,
            payment: { online: 0, cash: 400, due: 600, total: 400 }
        };
        expect(readPayment(bill)).toMatchObject({ cash: 400, due: 600, paid: 400 });
    });

    test('wholesale schema (payment object only)', () => {
        const sale = { total: 2500, payment: { online: 0, cash: 0, total: 0, due: 2500 } };
        expect(readPayment(sale)).toEqual({ total: 2500, cash: 0, online: 0, due: 2500, paid: 0 });
    });

    test('legacy top-level only schema uses dueAmount', () => {
        const bill = { total: 900, cashPayment: 400, onlinePayment: 100, dueAmount: 400 };
        expect(readPayment(bill)).toEqual({ total: 900, cash: 400, online: 100, due: 400, paid: 500 });
    });

    test('amountPaid = 0 does not fall through to cashPayment incorrectly / cashPayment kept', () => {
        const bill = { total: 1000, amountPaid: 0, cashPayment: 600, onlinePayment: 0 };
        expect(readPayment(bill)).toMatchObject({ cash: 600, due: 400 });
    });

    test('explicit cashPayment = 0 is respected (no fall-through to amountPaid)', () => {
        const bill = { total: 1000, cashPayment: 0, amountPaid: 700, onlinePayment: 300, dueAmount: 700 };
        expect(readPayment(bill)).toMatchObject({ cash: 0, online: 300, due: 700 });
    });

    test('legacy amountPaid-only schema derives due from total', () => {
        const bill = { total: 1000, amountPaid: 250, onlinePayment: 150 };
        expect(readPayment(bill)).toEqual({ total: 1000, cash: 250, online: 150, due: 600, paid: 400 });
    });

    test('string amounts and float noise are rounded', () => {
        const bill = { total: '100.10', payment: { cash: '0.1', online: 0.2, due: '99.8' } };
        expect(readPayment(bill)).toEqual({ total: 100.1, cash: 0.1, online: 0.2, due: 99.8, paid: 0.3 });
    });

    test('no payment info at all means no due', () => {
        expect(readPayment({ total: 500 })).toMatchObject({ due: 0, paid: 0 });
        expect(readPayment(null)).toEqual({ total: 0, cash: 0, online: 0, due: 0, paid: 0 });
    });
});

describe('billTotal / outstandingDue', () => {
    test('purchase uses net payable before gross billTotal', () => {
        expect(billTotal({ billTotal: 1100, grandTotal: 1000 })).toBe(1000);
        expect(billTotal({ billTotal: 1100 })).toBe(1100);
    });

    test('cleared or overpaid bills have no outstanding', () => {
        expect(outstandingDue({ payment: { due: 300 }, cleared: true })).toBe(0);
        expect(outstandingDue({ payment: { due: -5 } })).toBe(0);
        expect(outstandingDue({ dueAmount: 300 })).toBe(300);
    });
});

describe('computePurchaseTotals (#26)', () => {
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
});

describe('computeWholesaleTotals (#26)', () => {
    test('total, cost from stock average rates, profit and profit % from the lines', () => {
        const lines = [{ itemId: 'a', qty: 10.5, total: 420 }, { itemId: 'b', quantity: 4, total: 100.5 }, { itemId: 'c', qty: 1, total: 50 }];
        const stock = { a: { rate: 30.2 }, b: { rate: 20 } };
        expect(computeWholesaleTotals(lines, stock, 20.5)).toEqual({ total: 570.5, cost: 397.1, profit: 152.9, profitPercent: 26.8 });
        expect(computeWholesaleTotals([], {}, 0)).toEqual({ total: 0, cost: 0, profit: 0, profitPercent: 0 });
    });
});


describe('checkPaymentSplit (#23)', () => {
    test('match, short, over and rounding within ₹1', () => {
        expect(checkPaymentSplit(1000, { cash: 600, online: 100, due: 300 })).toEqual({ ok: true, entered: 1000, difference: 0 });
        expect(checkPaymentSplit(5000, { cash: 500 })).toEqual({ ok: false, entered: 500, difference: 4500 });
        expect(checkPaymentSplit(5000, { cash: 50000 })).toEqual({ ok: false, entered: 50000, difference: -45000 });
        expect(checkPaymentSplit(2567.5, { cash: 2568 }).ok).toBe(true);
        expect(checkPaymentSplit(100, { cash: 0.1, online: 0.2, due: 98.7 })).toMatchObject({ ok: true, entered: 99 });
        expect(checkPaymentSplit(100, { cash: 98.9 }).ok).toBe(false);
    });
    test('message says how much is missing or extra, in the app language (#143)', () => {
        expect(paymentSplitMessage({ difference: 4500 })).toMatch(/₹4,500 less .*Add ₹4,500/);
        expect(paymentSplitMessage({ difference: -45000 })).toMatch(/₹45,000 more .*by ₹45,000/);
        expect(paymentSplitMessage({ difference: 4500 }, 'hi')).toMatch(/₹4,500 कम/);
        expect(paymentSplitMessage({ difference: -45000 }, 'hi')).toMatch(/₹45,000 ज़्यादा/);
    });
});

describe('dueNeedsName (#68)', () => {
    test('blocks only when something is due and the name is blank', () => {
        expect(dueNeedsName(10, '  ')).toBe(true);
        expect(dueNeedsName(10, 'Sita')).toBe(false);
        expect(dueNeedsName(0, '')).toBe(false);
        expect(dueNeedsName(0.001, '')).toBe(false);
    });
});

describe('opening balances carried from the old project (#15)', () => {
    const opening = {
        items: [], total: 0, dueAmount: 340, payment: { cash: 0, online: 0, due: 340, total: 0 },
        openingBalance: { amount: 340, sourceBills: [{ billNumber: 'S-OLD-7' }, { billNumber: 'S20260815-001' }, { billNumber: '' }] }
    };

    test('carried amount is shown as the total; the bill adds no sale', () => {
        expect(isOpeningBalance(opening)).toBe(true);
        expect(isOpeningBalance({ total: 5 })).toBe(false);
        expect(openingAmount(opening)).toBe(340);
        expect(openingAmount({ total: 5 })).toBe(0);
        expect(billTotal(opening)).toBe(0);
        expect(readPayment(opening).due).toBe(340);
        expect(outstandingDue(opening)).toBe(340);
    });

    test('lists the old bill numbers, capped', () => {
        expect(openingSourceNumbers(opening)).toBe('#S-OLD-7, #S20260815-001');
        expect(openingSourceNumbers(opening, 1)).toBe('#S-OLD-7, …');
        expect(openingSourceNumbers({ total: 1 })).toBe('');
        expect(openingSourceNumbers({ openingBalance: {} })).toBe('');
    });
});

describe('wholesaleOutstanding (Wholesale page rule)', () => {
    test('payment.due, else total minus received; cleared is 0', () => {
        expect(wholesaleOutstanding({ total: 4200, payment: { cash: 1000, online: 1200, due: 2000 } })).toBe(2000);
        expect(wholesaleOutstanding({ total: 2000, payment: { cash: 500, online: 0, due: 0 } })).toBe(1500);
        expect(wholesaleOutstanding({ total: 300 })).toBe(300);
        expect(wholesaleOutstanding({ total: 300, cleared: true })).toBe(0);
        expect(wholesaleOutstanding(null)).toBe(0);
    });
});