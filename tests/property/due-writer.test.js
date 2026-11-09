/**
 * @fileoverview DUE-WRITE (#126): a bill's one stored due is `payment.due`.
 *  - tools/migrate copies every bill with canonicalDueBill: on every due shape the shop's data holds
 *    (tests/fixtures/due-shapes.js) the copy stores the due the old app read in payment.due, carries
 *    no dueAmount, and Outstanding, the statements, the cash day, Today and the "Already owes ₹X"
 *    line show from it exactly what the old app showed (shownBefore).
 *  - After the cut-over every bill write (withCanonicalDue: a new bill, a money edit, a name-only
 *    edit, a due payment, a settled due and a write-off) stores what the app stored before #126,
 *    without the dueAmount copy, with the same figures.
 */
jest.mock('../../www/js/firebase/repos/bill-payments.js', () => ({
    updateBillInTransaction: jest.fn(),
    updateBillsInTransaction: jest.fn()
}));
jest.mock('../../www/js/services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}), entry: jest.fn((action, details) => ({ action, details })), ACTIONS: {} } }));

import fc from 'fast-check';
import { canonicalDueBill, withCanonicalDue } from '../../www/js/firebase/repos/bill-due.js';
import { updateBillInTransaction } from '../../www/js/firebase/repos/bill-payments.js';
import { OutstandingManager } from '../../www/js/modules/outstanding.js';
import { duePaymentUpdate, settleDueUpdate } from '../../www/js/utils/due-payments.js';
import { buildPaymentSplit } from '../../www/js/utils/calc/billing.js';
import { isActiveBill, readPayment } from '../../www/js/utils/money.js';
import { AppState } from '../../www/js/utils/state.js';
import { billsArb, legacyBill, SHAPES, TYPES, screenFigures, shownBefore } from '../fixtures/due-shapes.js';

const RUNS = Number(process.env.FC_RUNS) || 40;
const FC = { seed: 126, numRuns: RUNS, endOnFailure: true };
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const copy = (v) => JSON.parse(JSON.stringify(v));
const withoutDueAmount = (b) => {
    const out = { ...b };
    delete out.dueAmount;
    return out;
};

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

/** One write both ways, on a bill as stored: as the app stored it before #126 and through the writer now. */
async function writeBoth(fresh, how, k) {
    const w = await WRITES[how](fresh, k);
    if (!w) return null;
    if (w.kind === 'update') {
        return { old: { ...fresh, ...before126.update(w.fields, fresh) }, now: { ...fresh, ...withCanonicalDue(copy(w.fields)) } };
    }
    return { old: before126.edit(w.fields, w.money), now: withCanonicalDue(copy(w.fields)) };
}

const canWrite = (bill, how) => isActiveBill(bill) && (['moneyEdit', 'nameEdit'].includes(how) || (!bill.cleared && readPayment(bill).due > 1));

beforeAll(() => {
    AppState.currentUser = { uid: 'u1', email: 'o@x' };
    AppState.userName = 'Owner';
});

describe('tools/migrate: the copy of every bill shows what the old app showed', () => {
    test.each(TYPES.flatMap(type => SHAPES.map(shape => [type, shape])))('%s, %s: paid, part-paid, unpaid, cleared, voided', (type, shape) => {
        const bills = [
            legacyBill({ id: 'part', type, shape, total: 1000.5, cash: 300, online: 200 }),
            legacyBill({ id: 'paid', type, shape, total: 800, cash: 500, online: 300 }),
            legacyBill({ id: 'unpaid', type, shape, total: 640, cash: 0, online: 0, daysAgo: 40 }),
            legacyBill({ id: 'cleared', type, shape, total: 700, cash: 0, online: 0, cleared: true }),
            legacyBill({ id: 'void', type, shape, total: 900, cash: 100, online: 0, voided: true })
        ];
        const migrated = bills.map(canonicalDueBill);
        migrated.forEach((m, i) => {
            expect([m.id, m.payment.due]).toEqual([m.id, bills[i].oldDue]);
            expect(m).not.toHaveProperty('dueAmount');
        });
        expect(screenFigures(migrated)).toEqual(screenFigures(bills.map(shownBefore)));
    });

    test('property: mixed shapes: same documents as shownBefore, same screen figures', () => {
        fc.assert(fc.property(billsArb(1, 12), (bills) => {
            const migrated = bills.map(canonicalDueBill);
            expect(migrated).toEqual(bills.map(shownBefore));
            expect(screenFigures(migrated)).toEqual(screenFigures(bills.map(shownBefore)));
        }), FC);
    });
});

describe('DUE-WRITE after the cut-over: what the app stored before #126, without dueAmount', () => {
    test.each(TYPES.flatMap(type => SHAPES.map(shape => [type, shape])))('%s, %s: new bill, edits, payment, settle, write-off', async (type, shape) => {
        const stored = canonicalDueBill(legacyBill({ id: 'x', type, shape, total: 1000.5, cash: 300, online: 200 }));
        for (const how of Object.keys(WRITES)) {
            if (!canWrite(stored, how)) continue;
            const both = await writeBoth(stored, how, 3);
            if (!both) continue;
            expect([how, both.now]).toEqual([how, withoutDueAmount(both.old)]);
            expect(screenFigures([both.now])).toEqual(screenFigures([both.old]));
        }
        const fresh = { id: 'n', type, items: [], total: 900, cashPayment: 400, onlinePayment: 0, payment: buildPaymentSplit({ cash: 400, online: 0, due: 500 }) };
        expect(withCanonicalDue(copy(fresh))).toEqual(withoutDueAmount(before126.newBill(fresh)));
    });

    test('property: migrated bills, any writes: the same documents without dueAmount and the same screen figures', async () => {
        const hows = Object.keys(WRITES);
        await fc.assert(fc.asyncProperty(billsArb(1, 10), fc.array(fc.nat(), { minLength: 10, maxLength: 10 }), async (bills, picks) => {
            const stored = bills.map(canonicalDueBill);
            const old = copy(stored);
            const now = copy(stored);
            for (let i = 0; i < stored.length; i++) {
                const how = hows[picks[i] % (hows.length + 2)];
                if (!how || !canWrite(stored[i], how)) continue;
                const both = await writeBoth(stored[i], how, picks[i]);
                if (!both) continue;
                old[i] = both.old;
                now[i] = both.now;
            }
            expect(now).toEqual(old.map(withoutDueAmount));
            expect(screenFigures(now)).toEqual(screenFigures(old));
        }), FC);
    });
});
