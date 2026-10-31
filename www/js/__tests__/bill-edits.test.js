/**
 * @fileoverview Bill corrections and voids, the pure part (#121, #75):
 * utils/bill-edits.js (what an edit records and how it reads) and the one
 * rule for which bills count, money.isActiveBill, in every calculation that
 * reads bills.
 */
import {
    billEditChanges, hasEditChanges, describeEdit, editHeading, cleanReason, voidBlocker, editCountOf, nextEditNumber, editRecord
} from '../utils/bill-edits.js';
import { activeBills, activityBills, isActiveBill, outstandingDue } from '../utils/money.js';
import { saleTimePayment, dueEvents } from '../utils/due-payments.js';
import { buildAging } from '../utils/aging.js';
import { collectEvents, stockFingerprint, changeInvalidatesCheckpoint } from '../utils/stock-replay.js';
import { firstStockTimes } from '../utils/stock-check.js';
import { partyLedger, partyChoices } from '../utils/statements.js';
import { checkPayments } from '../utils/number-checks.js';

const line = (name, qty, rate, extra = {}) => ({ itemId: name.toLowerCase(), name, qty, rate, total: qty * rate, ...extra });
const BILL = {
    id: 'b1', customerName: 'Ramesh', total: 500, saleTotal: 500, comments: '',
    items: [line('Wheat', 10, 50)], payment: { cash: 500, online: 0, due: 0, total: 500 }
};

describe('what an edit records (#121)', () => {
    test('only the changed fields, before and after; item lines diffed by item', () => {
        const after = {
            ...BILL, customerName: 'Ramesh Kumar', total: 450, saleTotal: 450,
            items: [line('Wheat', 9, 50), line('Rice', 2, 40)], payment: { cash: 450, online: 0, due: 80, total: 530 }
        };
        const c = billEditChanges(BILL, after);
        expect(Object.keys(c.fields).sort()).toEqual(['customerName', 'payment', 'saleTotal', 'total']);
        expect(c.fields.total).toEqual({ before: 500, after: 450 });
        expect(c.lines).toEqual([
            { name: 'Wheat', before: { qty: 10, rate: 50, total: 500 }, after: { qty: 9, rate: 50, total: 450 } },
            { name: 'Rice', before: null, after: { qty: 2, rate: 40, total: 80 } }
        ]);
        expect(hasEditChanges(c)).toBe(true);
    });

    test('a removed line, and items changed only in their weights, are recorded too', () => {
        const two = { ...BILL, items: [line('Wheat', 10, 50), line('Rice', 2, 40)] };
        expect(billEditChanges(two, BILL).lines).toEqual([{ name: 'Rice', before: { qty: 2, rate: 40, total: 80 }, after: null }]);
        const weights = billEditChanges(BILL, { ...BILL, items: [line('Wheat', 10, 50, { weights: [5, 5] })] });
        expect(weights).toMatchObject({ fields: {}, lines: [], itemsChanged: true });
        expect(hasEditChanges(weights)).toBe(true);
    });

    test('nothing recorded changed: no record and no reason needed; key order and missing vs undefined do not count', () => {
        const same = { ...BILL, payment: { total: 500, due: 0, online: 0, cash: 500 }, printComments: undefined, editedAt: 'now' };
        expect(hasEditChanges(billEditChanges(BILL, same))).toBe(false);
    });

    test('reasons are trimmed and 3–300 characters', () => {
        expect(cleanReason('  Wrong rate ')).toBe('Wrong rate');
        expect(cleanReason('ab')).toBeNull();
        expect(cleanReason('   x   ')).toBeNull();
        expect(cleanReason('x'.repeat(301))).toBeNull();
        expect(cleanReason(null)).toBeNull();
    });

    test('edit numbers count up from 1; the record holds who, why and what', () => {
        expect(editCountOf({})).toBe(0);
        expect(editCountOf({ editCount: 'x' })).toBe(0);
        expect(nextEditNumber({ editCount: 2 })).toBe(3);
        const rec = editRecord({ n: 3, at: 'T', by: 'u1', byName: 'Ravi', reason: ' Wrong rate ', changes: billEditChanges(BILL, { ...BILL, total: 450 }) });
        expect(rec).toEqual({ n: 3, at: 'T', by: 'u1', byName: 'Ravi', reason: 'Wrong rate', fields: { total: { before: 500, after: 450 } }, lines: [], itemsChanged: false });
    });

    test('reads as plain lines in the app language: totals once, payment parts, items', () => {
        const after = { ...BILL, customerName: 'Shyam', total: 450, saleTotal: 450, items: [line('Wheat', 9, 50)], payment: { cash: 400, online: 50, due: 0, total: 450 } };
        const edit = { n: 2, at: new Date(2026, 9, 31, 14, 5).getTime(), byName: 'Ravi', ...billEditChanges(BILL, after) };
        expect(describeEdit(edit, 'en')).toEqual([
            'Party: Ramesh → Shyam', 'Total: ₹500 → ₹450', 'Cash: ₹500 → ₹400', 'Online: ₹0 → ₹50',
            'Wheat: 10 kg × ₹50 → 9 kg × ₹50'
        ]);
        expect(describeEdit(edit, 'hi')).toEqual([
            'पार्टी: Ramesh → Shyam', 'कुल: ₹500 → ₹450', 'नकद: ₹500 → ₹400', 'ऑनलाइन: ₹0 → ₹50',
            'Wheat: 10 किलो × ₹50 → 9 किलो × ₹50'
        ]);
        expect(editHeading(edit, 'en')).toMatch(/^#2 · 31 Oct.* · Ravi$/);
        expect(describeEdit({ itemsChanged: true, lines: [] }, 'en')).toEqual(['Item details changed']);
        expect(describeEdit({ fields: { printComments: { before: false, after: true } } }, 'en')).toEqual(['Print the note: No → Yes']);
    });
});

describe('void (#75): who is blocked', () => {
    test('a voided bill, or one with payments recorded after it was saved', () => {
        expect(voidBlocker(BILL)).toBeNull();
        expect(voidBlocker({ ...BILL, payments: [] })).toBeNull();
        expect(voidBlocker({ ...BILL, payments: [{ amount: 10 }] })).toBe('payments');
        expect(voidBlocker({ ...BILL, voided: true })).toBe('voided');
    });
});

describe('isActiveBill: a voided bill counts in no calculation (#75)', () => {
    const at = new Date(2026, 9, 20, 10).getTime();
    const sale = (id, extra = {}) => ({
        id, date: new Date(at).toISOString(), timestamp: at, customerName: 'Ramesh', items: [line('Wheat', 10, 50)],
        total: 500, payment: { cash: 200, online: 0, due: 300 }, dueAmount: 300, ...extra
    });
    const VOIDED = sale('v', { voided: true, voidReason: 'Entered twice' });

    test('the predicate and the list helpers', () => {
        expect(isActiveBill(sale('a'))).toBe(true);
        expect(isActiveBill(VOIDED)).toBe(false);
        expect(isActiveBill(null)).toBe(false);
        expect(isActiveBill({ ...VOIDED, voided: 'true' })).toBe(true);
        expect(activeBills([sale('a'), VOIDED, null]).map(b => b.id)).toEqual(['a']);
        expect(activityBills([sale('a'), VOIDED, { openingBalance: { amount: 1 } }]).map(b => b.id)).toEqual(['a']);
    });

    test('BILL-DUE, BILL-AT-SAVE, due payments and aging', () => {
        expect(outstandingDue(VOIDED)).toBe(0);
        expect(saleTimePayment(VOIDED)).toEqual({ cash: 0, online: 0 });
        const paid = { ...VOIDED, payments: [{ id: 'p', amount: 50, cash: 50, at: at + 1 }] };
        expect(dueEvents({ bills: { retail: [paid] }, from: at, to: at + 10 })).toEqual([]);
        expect(buildAging([sale('a'), VOIDED], { today: new Date(at) }).total).toBe(300);
    });

    test('stock: no events, no fingerprint (a void invalidates a checkpoint like a delete), never "first stocked"', () => {
        const events = collectEvents({ retailSales: [sale('a'), VOIDED], purchases: [{ ...VOIDED, id: 'pv' }] });
        expect(events.map(e => e.bill.id)).toEqual(['a']);
        expect(stockFingerprint(VOIDED)).toBeNull();
        expect(changeInvalidatesCheckpoint(sale('v'), VOIDED, at + 1)).toBe(true);
        expect(changeInvalidatesCheckpoint(VOIDED, null, at + 1)).toBe(false);
        expect(firstStockTimes({ purchases: [VOIDED] }).size).toBe(0);
    });

    test('statements party ledger and picker, number checks', () => {
        const src = { retailSales: [sale('a'), VOIDED] };
        const ledger = partyLedger(src, 'ramesh', 'customer');
        expect(ledger.count).toBe(1);
        expect(ledger.due).toBe(300);
        expect(partyChoices(src, 'customer')).toEqual([{ key: 'ramesh', name: 'Ramesh', count: 1 }]);
        const bad = { ...VOIDED, payments: [{ amount: 999, cash: 999 }] };
        expect(checkPayments({ retailSales: [bad] }).checked).toBe(0);
    });
});
