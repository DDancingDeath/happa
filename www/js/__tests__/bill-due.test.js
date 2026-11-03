/**
 * @fileoverview DUE-WRITE (#126): withCanonicalDue, the one writer of a bill's `dueAmount`
 * mirror of `payment.due` (tests/property/due-writer.test.js checks it against what the app
 * stored before, on every due shape). Here: its rules, and that nothing else writes dueAmount.
 */
import fs from 'fs';
import path from 'path';
import { withCanonicalDue } from '../firebase/repos/bill-due.js';

const bill = { id: 'b1', total: 1000, items: [{ name: 'Rice', qty: 10, rate: 100, total: 1000 }], cashPayment: 400, onlinePayment: 0, dueAmount: 600, payment: { cash: 400, online: 0, due: 600, total: 1000 } };

describe('withCanonicalDue', () => {
    test('a partial update mirrors payment.due only on a bill that has dueAmount', () => {
        expect(withCanonicalDue({ payment: { cash: 500, online: 0, due: 500 } }, bill)).toEqual({ payment: { cash: 500, online: 0, due: 500 }, dueAmount: 500 });
        const { dueAmount, ...noMirror } = bill;
        expect(dueAmount).toBe(600);
        expect(withCanonicalDue({ payment: { due: 0 } }, noMirror)).toEqual({ payment: { due: 0 } });
    });

    test('a new bill always gets the mirror; an edit gets it when it sets money, else keeps dueAmount as stored', () => {
        expect(withCanonicalDue({ payment: { cash: 0, online: 0, due: 70, total: 70 } }, null, { full: true }).dueAmount).toBe(70);
        const drifted = { ...bill, dueAmount: 650 };
        expect(withCanonicalDue({ ...drifted, customerName: 'Ravi', note: undefined }, drifted, { full: true }).dueAmount).toBe(650);
        expect(withCanonicalDue({ ...drifted, items: [{ name: 'Rice', qty: 11, rate: 100, total: 1100 }] }, drifted, { full: true }).dueAmount).toBe(600);
        expect(withCanonicalDue({ ...drifted, payment: { ...bill.payment, due: 500, cash: 500 } }, drifted, { full: true }).dueAmount).toBe(500);
    });

    test('a write without a numeric payment.due (a void, a legacy bill kept as it was) is left alone', () => {
        const voidFields = { voided: true, openDue: false };
        expect(withCanonicalDue(voidFields, bill)).toEqual({ voided: true, openDue: false });
        const legacy = { total: 500, dueAmount: '200', payment: { cash: 300, due: null } };
        expect(withCanonicalDue({ ...legacy }, null, { full: true })).toEqual(legacy);
        expect(withCanonicalDue({ ...legacy, payment: { cash: 300, due: '200' } }, legacy, { full: true }).dueAmount).toBe('200');
        expect(withCanonicalDue({ payment: 'cash' }, bill)).toEqual({ payment: 'cash' });
        expect(withCanonicalDue(null, bill)).toBeNull();
    });
});

test('only firebase/repos/bill-due.js writes dueAmount (the review rule due-amount-vs-payment-due-drift checks new lines)', () => {
    const root = path.join(__dirname, '..');
    // bill-share.js: a reprint payload, never stored
    const allowed = { 'firebase/repos/bill-due.js': 1, 'utils/bill-share.js': 1 };
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
    expect(found).toEqual(allowed);
});
