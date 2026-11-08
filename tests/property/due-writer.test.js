/**
 * @fileoverview DUE-WRITE (#126): every bill write goes through one writer of the stored due
 * (withCanonicalDue, www/js/firebase/repos/bill-due.js). It must store exactly what the app
 * stored before it, on every due shape the shop's data holds (tests/fixtures/due-shapes.js),
 * for every write: a new bill, a money edit, a name-only edit, a due payment, a settled due and
 * a write-off. Then Outstanding, the statements, the cash day, Today and the "Already owes ₹X"
 * line show the same numbers on old, new and mixed data.
 */
jest.mock('../../www/js/firebase/repos/bill-payments.js', () => ({
    updateBillInTransaction: jest.fn(),
    updateBillsInTransaction: jest.fn()
}));
jest.mock('../../www/js/services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}), entry: jest.fn((action, details) => ({ action, details })), ACTIONS: {} } }));

import fc from 'fast-check';
import { withCanonicalDue } from '../../www/js/firebase/repos/bill-due.js';
import { updateBillInTransaction } from '../../www/js/firebase/repos/bill-payments.js';
import { OutstandingManager } from '../../www/js/modules/outstanding.js';
import { duePaymentUpdate, settleDueUpdate } from '../../www/js/utils/due-payments.js';
import { buildPaymentSplit } from '../../www/js/utils/calc/billing.js';
import { isActiveBill, readPayment } from '../../www/js/utils/money.js';
import { AppState } from '../../www/js/utils/state.js';
import { billsArb, legacyBill, SHAPES, TYPES, screenFigures } from '../fixtures/due-shapes.js';

const RUNS = Number(process.env.FC_RUNS) || 40;
const FC = { seed: 126, numRuns: RUNS, endOnFailure: true };
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const copy = (v) => JSON.parse(JSON.stringify(v));

/** What the app stored before #126, when each writer set dueAmount itself. */
const before126 = {
    // duePaymentUpdate and the write-off: dueAmount = the new due, only on a bill that has it
    update: (fields, fresh) => (hasOwn(fresh, 'dueAmount') ? { ...fields, dueAmount: fields.payment.due } : { ...fields }),
    // the bill forms: dueAmount = the typed due (= payment.due), always
    newBill: (record) => ({ ...record, dueAmount: record.payment.due }),
    // billing.js edits: a money edit wrote dueAmount = payment.due; a name-only edit kept every money field
    edit: (record, money) => (money ? { ...record, dueAmount: record.payment.due } : { ...record })
};

/** The bill fields each write sets, from the bill as stored (`fresh`), as the app builds them. */
const WRITES = {
    pay: (fresh, k) => {
        const due = readPayment(fresh).due;
        const amount = Math.max(1, Math.min(Math.floor(due), 1 + (k % Math.max(1, Math.floor(due)))));
        const parts = k % 2 ? { cash: amount, online: 0 } : { cash: 0, online: amount };
        const out = duePaymentUpdate(fresh, parts, { id: `e${k}`, amount, ...parts, at: 1 });
        return out.ok ? { kind: 'update', fields: out.update } : null;
    },
    settle: (fresh, k) => {
        const out = settleDueUpdate(fresh, k % 2 ? 'cash' : 'online', { id: `s${k}`, at: 1 });
        return out?.update ? { kind: 'update', fields: out.update } : null;
    },
    writeOff: async (fresh) => {
        let fields = null;
        updateBillInTransaction.mockImplementationOnce(async (collKey, id, sessionId, change) => {
            fields = change(copy(fresh), null).bill;
            return fields;
        });
        await OutstandingManager.applyWriteOffTransaction(fresh.type, fresh, 'gone');
        return { kind: 'update', fields };
    },
    moneyEdit: (fresh, k) => {
        const total = Math.round(readPayment(fresh).total) + 10 + (k % 7);
        const split = { cash: Math.floor(total / 3), online: 0, due: total - Math.floor(total / 3) };
        const totals = fresh.type === 'purchase' ? { grandTotal: total, amountPayable: total } : { total };
        return { kind: 'edit', money: true, fields: { ...copy(fresh), ...totals, cashPayment: split.cash, onlinePayment: split.online, payment: buildPaymentSplit(split) } };
    },
    nameEdit: (fresh) => ({ kind: 'edit', money: false, fields: { ...copy(fresh), customerName: `${fresh.customerName} Jr` } })
};

/** One write both ways: as stored before #126 and through the writer. */
async function writeBoth(fresh, how, k) {
    const w = await WRITES[how](fresh, k);
    if (!w) return null;
    if (w.kind === 'update') {
        return {
            old: { ...fresh, ...before126.update(w.fields, fresh) },
            now: { ...fresh, ...withCanonicalDue(copy(w.fields), copy(fresh)) }
        };
    }
    return { old: before126.edit(w.fields, w.money), now: withCanonicalDue(copy(w.fields), copy(fresh), { full: true }) };
}

const canWrite = (bill, how) => isActiveBill(bill) && (['moneyEdit', 'nameEdit'].includes(how) || (!bill.cleared && readPayment(bill).due > 1));

beforeAll(() => {
    AppState.currentUser = { uid: 'u1', email: 'o@x' };
    AppState.userName = 'Owner';
});

describe('DUE-WRITE: the same stored bill as before #126', () => {
    test.each(TYPES.flatMap(type => SHAPES.map(shape => [type, shape])))('%s, %s: new bill, edits, payment, settle, write-off', async (type, shape) => {
        const stored = legacyBill({ id: 'x', type, shape, total: 1000.5, cash: 300, online: 200 });
        for (const how of Object.keys(WRITES)) {
            if (!canWrite(stored, how)) continue;
            const both = await writeBoth(stored, how, 3);
            if (!both) continue;
            expect([how, both.now]).toEqual([how, both.old]);
            expect(readPayment(both.now)).toEqual(readPayment(both.old));
        }
        const fresh = { id: 'n', type, items: [], total: 900, cashPayment: 400, onlinePayment: 0, payment: buildPaymentSplit({ cash: 400, online: 0, due: 500 }) };
        expect(withCanonicalDue(copy(fresh), null, { full: true })).toEqual(before126.newBill(fresh));
    });

    test('property: mixed old and new bills, any writes: identical documents and identical screen figures', async () => {
        const hows = Object.keys(WRITES);
        await fc.assert(fc.asyncProperty(billsArb(1, 10), fc.array(fc.nat(), { minLength: 10, maxLength: 10 }), async (bills, picks) => {
            const old = copy(bills);
            const now = copy(bills);
            for (let i = 0; i < bills.length; i++) {
                const how = hows[picks[i] % (hows.length + 2)];
                if (!how || !canWrite(bills[i], how)) continue;
                const both = await writeBoth(bills[i], how, picks[i]);
                if (!both) continue;
                old[i] = both.old;
                now[i] = both.now;
            }
            expect(now).toEqual(old);
            expect(screenFigures(now)).toEqual(screenFigures(old));
        }), FC);
    });
});
