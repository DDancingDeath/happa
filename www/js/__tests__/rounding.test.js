/**
 * @fileoverview #129 (owner decision 2026-11-01: "rate will have paise, total
 * will not, it will be rounded"), docs/calculations.md MONEY-ROUND: rates and kg
 * keep their decimals, money amounts are whole rupees (half-up), stock is valued
 * at the saved line amounts, and records saved before with paise still add up
 * exactly as stored.
 */
import * as O from '../../../tests/oracle/oracle.js';
import { computeLine } from '../utils/calc/billing.js';
import { stockValue } from '../utils/calc/stock.js';
import { todaySummary } from '../utils/calc/today.js';
import { stockMovement } from '../utils/finance-calc.js';
import { checkStock } from '../utils/number-checks.js';
import { billTotal, outstandingDue, readPayment } from '../utils/money.js';
import {
    collectEvents, computeStock, createItemKeyResolver, purchaseLineValue, replayEvents, stockFingerprint
} from '../utils/stock-replay.js';

const ITEMS = [{ id: 'wheat', name: 'Wheat' }];
const T0 = new Date(2026, 10, 1, 10).getTime();
const line = (qty, rate, total) => ({ itemId: 'wheat', name: 'Wheat', qty, rate, ...(total === undefined ? {} : { total }) });
const purchase = (id, items, extra = {}) => ({ id, items, timestamp: T0, date: new Date(T0).toISOString(), ...extra });

describe('a 12.4 kg × ₹33.50 line is ₹415 everywhere (not ₹415.40)', () => {
    const lineOnBill = computeLine({ rate: 33.5, qty: 12.4 });
    const data = { items: ITEMS, purchases: [purchase('p1', [line(12.4, 33.5, lineOnBill.total)])], wholesaleSales: [], retailSales: [], stockAdjustments: [] };

    test('bill line, stock value, Money\'s "Bought (at line rate)", AC1 and the oracle agree', () => {
        expect(lineOnBill.total).toBe(415);
        const stock = computeStock(data, ITEMS);
        expect(stock.wheat.quantity).toBe(12.4);
        expect(stock.wheat.rate).toBeCloseTo(415 / 12.4, 10);
        expect(stockValue(stock)).toBeCloseTo(415, 9);
        const state = replayEvents({}, collectEvents(data), createItemKeyResolver(ITEMS));
        expect(stockValue(state)).toBe(415);
        expect(stockMovement({ base: { state: {}, from: -Infinity }, sources: data, items: ITEMS })).toMatchObject({ purchases: 415, closing: 415, gap: 0 });
        expect(checkStock(data).map(r => r.problems)).toEqual([0, 0]);
        expect(O.stockReplay(data)).toMatchObject({ purchases: 415, closing: 415 });
    });

    test('the cost of a sale comes from the saved amount: half of it sold costs ₹207.50', () => {
        const sold = { ...data, wholesaleSales: [{ id: 'w1', items: [{ itemId: 'wheat', name: 'Wheat', quantity: 6.2, rate: 40, total: 248 }], timestamp: T0 + 1, date: new Date(T0 + 1).toISOString() }] };
        expect(stockMovement({ base: { state: {}, from: -Infinity }, sources: sold, items: ITEMS })).toMatchObject({ purchases: 415, cogs: 207.5, closing: 207.5 });
        expect(O.stockReplay(sold)).toMatchObject({ cogs: 207.5, closing: 207.5 });
    });

    test('a line saved without an amount (oldest bills) is still kg × rate; `amount` counts like `total`', () => {
        expect(purchaseLineValue(line(12.4, 33.5))).toEqual({ qty: 12.4, value: 12.4 * 33.5, rate: 33.5 });
        expect(purchaseLineValue({ quantity: 10, rate: 2.25, amount: 23 })).toEqual({ qty: 10, value: 23, rate: 2.3 });
        expect(purchaseLineValue({ qty: 0, rate: 5, total: 7 })).toEqual({ qty: 0, value: 0, rate: 5 });
    });

    test('an edit that changes only a line amount invalidates the stock checkpoint', () => {
        expect(stockFingerprint(purchase('p1', [line(12.4, 33.5, 415)]))).not.toBe(stockFingerprint(purchase('p1', [line(12.4, 33.5, 416)])));
    });
});

describe('records saved before #129 with paise add up exactly as stored', () => {
    const today = new Date(T0);
    const legacy = purchase('old', [line(40, 25, 1000)], {
        billTotal: 1000, laborCharges: 12.5, grandTotal: 987.5, amountPayable: 987.5,
        cashPayment: 487.5, dueAmount: 500, payment: { cash: 487.5, online: 0, due: 500, total: 987.5 }
    });
    const fresh = purchase('new', [line(40, 25, 1000)], {
        billTotal: 1000, laborCharges: 13, grandTotal: 987, amountPayable: 987,
        cashPayment: 987, dueAmount: 0, payment: { cash: 987, online: 0, due: 0, total: 987 }
    });

    test('bill total, payment and due are read as stored', () => {
        expect([billTotal(legacy), readPayment(legacy).cash, outstandingDue(legacy)]).toEqual([987.5, 487.5, 500]);
        expect([billTotal(fresh), readPayment(fresh).cash, outstandingDue(fresh)]).toEqual([987, 987, 0]);
    });

    test('Today sums the stored amounts: paise of old records stay, new ones are whole rupees', () => {
        const day = todaySummary({
            bills: { purchase: [legacy, fresh] },
            expenses: [{ amount: 45.5, type: 'tea', date: new Date(T0).toISOString() }, { amount: 46, type: 'tea', date: new Date(T0).toISOString() }],
            today
        });
        expect(day).toMatchObject({ purchases: 1974.5, cashOut: 487.5 + 987 + 45.5 + 46, dueToPay: 500, businessExpenses: 91.5 });
        expect(day.labour.deducted.amount).toBe(25.5);
    });
});
