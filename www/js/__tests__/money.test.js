/**
 * @fileoverview Tests for money helpers / payment schema normalisation
 */
import { round2, sumMoney, readPayment, billTotal, billLineTotal, outstandingDue, paymentSplitMessage, dueNeedsName, isOpeningBalance, openingAmount, openingOldTotals, wholesaleOutstanding } from '../utils/money.js';
import { perUnitRate, normalizePackageKg, normalizeLabourSettings, toMoney, readLineItem, formatAmount, formatRupees } from '../utils/money.js';

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

describe('paymentSplitMessage (#23)', () => {
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
        openingBalance: { amount: 340, billTotal: 500, paidBefore: 160 }

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

    test('old bill total and what was paid before the move', () => {
        expect(openingOldTotals(opening)).toEqual({ total: 500, paid: 160 });
        expect(openingOldTotals({ openingBalance: {} })).toEqual({ total: 0, paid: 0 });
        expect(openingOldTotals({ total: 1 })).toBeNull();
    });});

describe('wholesaleOutstanding (the old app Wholesale page rule, tools/migrate only)', () => {
    test('payment.due, else total minus received; cleared is 0', () => {
        expect(wholesaleOutstanding({ total: 4200, payment: { cash: 1000, online: 1200, due: 2000 } })).toBe(2000);
        expect(wholesaleOutstanding({ total: 2000, payment: { cash: 500, online: 0, due: 0 } })).toBe(1500);
        expect(wholesaleOutstanding({ total: 300 })).toBe(300);
        expect(wholesaleOutstanding({ total: 300, cleared: true })).toBe(0);
        expect(wholesaleOutstanding(null)).toBe(0);
    });
});

describe('billLineTotal (BILL-LINES, #80)', () => {
    test('purchases: billTotal, a present 0 counts; else BILL-TOTAL + labour', () => {
        expect(billLineTotal({ billTotal: 1000, grandTotal: 988, laborCharges: 12 }, true)).toBe(1000);
        expect(billLineTotal({ billTotal: 0, grandTotal: 500, total: 70 }, true)).toBe(0);
        expect(billLineTotal({ grandTotal: 950, laborCharges: 50 }, true)).toBe(1000);
        expect(billLineTotal({ total: 970, labour: 30 }, true)).toBe(1000);
    });
    test('sales: billTotal, saleTotal, total (0 counts), else BILL-TOTAL', () => {
        expect(billLineTotal({ saleTotal: 0, total: 500 }, false)).toBe(0);
        expect(billLineTotal({ total: 795 }, false)).toBe(795);
        expect(billLineTotal({ grandTotal: 400 }, false)).toBe(400);
        expect(billLineTotal(null, false)).toBe(0);
    });
});

describe('small money helpers the mutation run found untested (#160)', () => {
    test('perUnitRate: value ÷ quantity to the paisa; null for no, a negative or a bad quantity or value', () => {
        expect(perUnitRate(100, 3)).toBe(33.33);
        expect(perUnitRate('50', '4')).toBe(12.5);
        expect(perUnitRate(0, 5)).toBe(0);
        expect(perUnitRate(100, 0)).toBeNull();
        expect(perUnitRate(100, -2)).toBeNull();
        expect(perUnitRate(NaN, 2)).toBeNull();
        expect(perUnitRate(10, 'x')).toBeNull();
    });

    test('normalizePackageKg: 1–200 kg is kept, anything else is 35', () => {
        expect([normalizePackageKg(1), normalizePackageKg(200), normalizePackageKg('40.25')]).toEqual([1, 200, 40.25]);
        expect([normalizePackageKg(0.99), normalizePackageKg(200.01), normalizePackageKg(''), normalizePackageKg(null), normalizePackageKg('abc')])
            .toEqual([35, 35, 35, 35, 35]);
    });

    test('normalizeLabourSettings: only positive values are kept', () => {
        expect(normalizeLabourSettings()).toEqual({ laborRate: 6, heavyWeightThreshold: 30, labourPackageKg: 35 });
        expect(normalizeLabourSettings({ laborRate: 0, heavyWeightThreshold: -5 })).toMatchObject({ laborRate: 6, heavyWeightThreshold: 30 });
        expect(normalizeLabourSettings({ laborRate: '7.25', heavyWeightThreshold: 25, labourPackageKg: 50 })).toEqual({ laborRate: 7.25, heavyWeightThreshold: 25, labourPackageKg: 50 });
        expect(normalizeLabourSettings({ laborRate: 0.01 }).laborRate).toBe(0.01);
    });

    test('toMoney: blank, missing or text is null; numeric strings parse; 0 is 0', () => {
        expect([toMoney(''), toMoney(undefined), toMoney(null), toMoney('abc')]).toEqual([null, null, null, null]);
        expect([toMoney('12.5'), toMoney(0), toMoney('0'), toMoney(7)]).toEqual([12.5, 0, 0, 7]);
    });

    test('readLineItem: no line or a non-object is an empty line; the name is trimmed', () => {
        const empty = { name: '', qty: 0, rate: 0, total: 0 };
        expect(readLineItem(null)).toEqual(empty);
        expect(readLineItem('Rice')).toEqual(empty);
        expect(readLineItem({ item: '  Rice ', quantity: 2, rate: 10 })).toEqual({ name: 'Rice', qty: 2, rate: 10, total: 20 });
    });

    test('formatAmount: paise only for small amounts that have them; never "-0"', () => {
        expect(formatAmount(0.4, { small: true })).toBe('0.40');
        expect(formatAmount(99.5, { small: true })).toBe('99.50');
        expect(formatAmount(100.5, { small: true })).toBe('101');
        expect(formatAmount(5, { small: true })).toBe('5');
        expect(formatAmount(0.4)).toBe('0');
        expect(formatAmount(-0.4)).toBe('0');
        expect(formatAmount(1234.5, { decimals: 2 })).toBe('1,234.50');
    });

    test('formatRupees: Indian grouping, the minus before ₹', () => {
        expect(formatRupees(250000)).toBe('₹2,50,000');
        expect(formatRupees(-500)).toBe('-₹500');
    });
});
