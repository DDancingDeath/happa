/**
 * @fileoverview DUE-WRITE (#126): a bill's one stored due is `payment.due`. withCanonicalDue leaves
 * the legacy `dueAmount` out of every bill write; canonicalDueBill is the copy tools/migrate writes
 * (tests/property/due-writer.test.js checks both against what the app stored and showed before, on
 * every due shape). Here: their rules, and that nothing in the app writes dueAmount.
 */
import fs from 'fs';
import path from 'path';
import { canonicalDueBill, withCanonicalDue } from '../firebase/repos/bill-due.js';

const bill = { id: 'b1', total: 1000, items: [{ name: 'Rice', qty: 10, rate: 100, total: 1000 }], cashPayment: 400, onlinePayment: 0, dueAmount: 600, payment: { cash: 400, online: 0, due: 600, total: 1000 } };

describe('withCanonicalDue', () => {
    test('a partial update or a whole bill never carries dueAmount; everything else is kept', () => {
        expect(withCanonicalDue({ payment: { cash: 500, online: 0, due: 500 }, dueAmount: 500 })).toEqual({ payment: { cash: 500, online: 0, due: 500 } });
        const { dueAmount, ...rest } = bill;
        expect(dueAmount).toBe(600);
        expect(withCanonicalDue({ ...bill, customerName: 'Ravi' })).toEqual({ ...rest, customerName: 'Ravi' });
        expect(withCanonicalDue({ voided: true, openDue: false })).toEqual({ voided: true, openDue: false });
        expect(withCanonicalDue(null)).toBeNull();
    });
});

describe('canonicalDueBill (tools/migrate)', () => {
    test('payment.due = the due the old app read; dueAmount dropped; nothing else changes', () => {
        const { dueAmount, ...rest } = bill;
        expect(dueAmount).toBe(600);
        expect(canonicalDueBill(bill)).toEqual(rest);
        // payment.due wins over a drifted copy
        expect(canonicalDueBill({ ...bill, dueAmount: 650 })).toEqual(rest);
        expect(canonicalDueBill({ total: 500, cashPayment: '300', dueAmount: '200' })).toEqual({ total: 500, cashPayment: '300', payment: { due: 200 } });
        expect(canonicalDueBill({ total: 500, payment: { cash: 300, due: null }, dueAmount: 200 })).toEqual({ total: 500, payment: { cash: 300, due: 200 } });
        expect(canonicalDueBill({ total: 90, cashPayment: 40, due: 50 })).toEqual({ total: 90, cashPayment: 40, due: 50, payment: { due: 50 } });
        expect(canonicalDueBill({ grandTotal: 970, amountPaid: 500 })).toEqual({ grandTotal: 970, amountPaid: 500, payment: { due: 470 } });
        expect(canonicalDueBill({ total: 500, payment: { cash: 700, due: -200 }, dueAmount: -200 })).toEqual({ total: 500, payment: { cash: 700, due: -200 } });
        expect(canonicalDueBill(null)).toBeNull();
    });

    test('does not change the bill it copies', () => {
        const stored = JSON.parse(JSON.stringify(bill));
        canonicalDueBill(stored);
        expect(stored).toEqual(bill);
    });
});

test('nothing in the app writes dueAmount (the review rule due-amount-vs-payment-due-drift checks new lines)', () => {
    const root = path.join(__dirname, '..');
    const found = {};
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name !== '__tests__') walk(full);
        } else if (e.name.endsWith('.js')) {
            const n = (fs.readFileSync(full, 'utf8').match(/(^\s*|[{,]\s*)dueAmount\s*:|\.dueAmount\s*=[^=]/gm) || []).length;
            if (n) found[path.relative(root, full).split(path.sep).join('/')] = n;
        }
    });
    walk(root);
    expect(found).toEqual({});
});
