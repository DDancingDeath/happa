/**
 * @fileoverview "Receive payment" from a party spread over their bills, oldest
 * first (#152, DUE-FIFO): allocation, hand-edited parts, one transaction for all
 * bills, totals before − payment = after, owner / manager only.
 */
jest.mock('../firebase/firestore-service.js', () => ({
    FirebaseService: {
        db: null,
        CLIENT_VERSION: 4,
        keptServerPayment: jest.fn(() => false),
        savedOnPhoneOnly: jest.fn(() => false),
        saveUnconfirmed: jest.fn(() => false),
        billHasOpenDue: jest.fn((coll, bill) => !bill.cleared && (bill.payment?.due || 0) > 0),
        documentIdOf: jest.fn(bill => bill.docId || String(bill.id))
    }
}));
jest.mock('../firebase/repos/bill-payments.js', () => ({
    updateBillInTransaction: jest.fn(),
    updateBillsInTransaction: jest.fn()
}));
jest.mock('../services/printer.js', () => ({ PrinterService: {} }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}), ACTIONS: { UPDATE_PAYMENT: 'UPDATE_PAYMENT' } } }));
jest.mock('../ui/infinite-scroll.js', () => ({ attachOlderHistoryScroll: jest.fn() }));

import { updateBillsInTransaction } from '../firebase/repos/bill-payments.js';
import { AuditService } from '../services/audit.js';
import { OutstandingManager } from '../modules/outstanding.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { billAgeOrder, dueEvents, partyDues, sumDueEvents } from '../utils/due-payments.js';
import { allocateOldestFirst, checkAllocation } from '../utils/calc/billing.js';
import { normalizePartyName } from '../utils/aging.js';
import { outstandingDue } from '../utils/money.js';

const bill = (id, customerName, due, ts, extra = {}) => ({
    id, billNumber: `R-${id}`, customerName, total: due + 100, timestamp: ts, date: '01/10/2026',
    payment: { cash: 100, online: 0, due, total: 100 }, dueAmount: due, payments: [], ...extra
});

function serverTx(server) {
    updateBillsInTransaction.mockImplementation(async (collKey, ids, change) => {
        const fresh = ids.map(id => JSON.parse(JSON.stringify(server[id])));
        const out = change(fresh);
        out.bills.forEach((fields, i) => { if (fields) server[ids[i]] = { ...server[ids[i]], ...fields }; });
        return out.result;
    });
}

beforeEach(() => {
    jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(OutstandingManager, 'refreshAfterPayment').mockImplementation(() => {});
    AppState.currentUser = { uid: 'm1', email: 'm@x' };
    AppState.userName = 'Manager';
    AppState.userRole = 'manager';
    AppState.settings = {};
    AppState.currentDueFilter = 'sale';
    updateBillsInTransaction.mockReset();
    AuditService.log.mockClear();
    OutstandingManager.pendingPartyPay = null;
});
afterEach(() => jest.restoreAllMocks());

describe('DUE-FIFO allocation', () => {
    test('fills the oldest bills first; the last one reached is part-paid; the rest gets nothing', () => {
        expect(allocateOldestFirst([100, 250.5, 80], 300)).toEqual({ amounts: [100, 200, 0], allocated: 300, left: 0 });
        expect(allocateOldestFirst([100, 250.5, 80], 431)).toEqual({ amounts: [100, 250.5, 80], allocated: 430.5, left: 0.5 });
        // Typed paise are whole rupees, as Record payment saves them; a part-paid bill gets whole rupees
        expect(allocateOldestFirst([100, 250.5], 299.6)).toEqual({ amounts: [100, 200], allocated: 300, left: 0 });
        expect(allocateOldestFirst([100.5, 250], 150)).toEqual({ amounts: [100.5, 49], allocated: 149.5, left: 0.5 });
        expect(allocateOldestFirst([100, 50], 200)).toEqual({ amounts: [100, 50], allocated: 150, left: 50 });
        expect(allocateOldestFirst([100], 'abc')).toEqual({ amounts: [0], allocated: 0, left: 0 });
    });

    test('the parts must add up to the amount received', () => {
        const ok = (amounts, total, received, excess = 0, allFull = false) => ({ ok: true, amounts, total, received, excess, allFull });
        expect(checkAllocation([100, 50], ['40', ''], 40)).toEqual(ok([40, 0], 40, 40));
        expect(checkAllocation([100, 50], ['40', '50.004'], '90')).toEqual(ok([40, 50], 90, 90));
        expect(checkAllocation([100, 250.5], ['', '120.4'], 120)).toEqual(ok([0, 120], 120, 120));
        // Parts edited up, or down, so they no longer match: blocked, with the difference
        expect(checkAllocation([100, 50], ['100', '50'], 100)).toEqual({ ok: false, error: 'mismatch', total: 150, received: 100, diff: 50, gap: 50 });
        expect(checkAllocation([100, 50], ['40', ''], 100)).toEqual({ ok: false, error: 'mismatch', total: 40, received: 100, diff: -60, gap: 60 });
        // The amount box is required
        expect(checkAllocation([100, 50], ['40', ''], '')).toEqual({ ok: false, error: 'no-amount' });
        expect(checkAllocation([100, 50], ['40', ''], 0)).toEqual({ ok: false, error: 'no-amount' });
        expect(checkAllocation([100, 50], ['40', ''], 'abc')).toEqual({ ok: false, error: 'no-amount' });
        expect(checkAllocation([100, 50], ['40', '51'], 91)).toEqual({ ok: false, error: 'exceeds-due', index: 1 });
        expect(checkAllocation([100, 50], ['-1', '0'], 10)).toEqual({ ok: false, error: 'invalid', index: 0 });
        expect(checkAllocation([100, 50], ['', '0'], 10)).toEqual({ ok: false, error: 'empty' });
    });

    test('only two exceptions: more than all the dues with every bill paid in full, and an old due with paise', () => {
        // (a) over-payment: every bill to its due, the rest is not recorded
        expect(checkAllocation([100, 50], ['100', '50'], 200)).toEqual({ ok: true, amounts: [100, 50], total: 150, received: 200, excess: 50, allFull: true });
        // …but not when a bill is left part-paid
        expect(checkAllocation([100, 50], ['100', '40'], 200).error).toBe('mismatch');
        // (b) an old ₹100.50 due paid in full: the parts carry its 50 paise
        expect(checkAllocation([100.5, 250], ['100.5', '49'], 150)).toEqual({ ok: true, amounts: [100.5, 49], total: 149.5, received: 150, excess: 0.5, allFull: false });
        // …only below the amount, never above it
        expect(checkAllocation([100.5], ['100.5'], 100).error).toBe('mismatch');
        expect(checkAllocation([100.5, 500], ['100.5', '500'], 600).error).toBe('mismatch');
        expect(checkAllocation([100.5], ['100.5'], 100.5)).toMatchObject({ ok: true, total: 100.5, received: 101, excess: 0.5, allFull: true });
        // …but never a rupee or more off
        expect(checkAllocation([100.5, 250], ['100.5', '51'], 150).error).toBe('mismatch');
        // Whatever the fill gives always passes
        [[[100, 250.5, 80], 300], [[100.5, 250], 150], [[100, 50], 500], [[7.25, 3], 9]].forEach(([dues, amount]) => {
            const { amounts } = allocateOldestFirst(dues, amount);
            expect(checkAllocation(dues, amounts.map(String), amount).ok).toBe(true);
        });
    });

    test('oldest first: numeric time, else the bill date, then the document id', () => {
        const a = { id: 'b', timestamp: 2000 };
        const b = { id: 'a', timestamp: 2000 };
        const c = { id: 'z', timestamp: 'not a number', date: '01/01/1970' };
        const d = { id: 'y', date: '15/10/2026' };
        const e = { id: 'x', timestamp: new Date(2026, 9, 1).getTime() };
        expect([a, b, c, d, e].sort(billAgeOrder).map(x => x.id)).toEqual(['z', 'a', 'b', 'x', 'y']);
        const bills = [bill('r2', 'Ravi', 10, 5), bill('r1', 'Ravi', 10, 5), bill('r0', 'Ravi', 10, undefined, { date: '01/01/2020' })];
        // Same time: by document id; no time: the bill date (2020 is after 5 ms past 1970)
        expect(partyDues(bills, normalizePartyName('Ravi'), normalizePartyName).bills.map(x => x.bill.id)).toEqual(['r1', 'r2', 'r0']);
    });
});

describe('receivePartyPayment (one transaction)', () => {
    test('each bill gets its own entry at the same time; dues go down; party total before − payment = after', async () => {
        const server = { r1: bill('r1', 'Ravi', 100, 1), r2: bill('r2', 'Ravi', 250, 2) };
        serverTx(server);
        const before = outstandingDue(server.r1) + outstandingDue(server.r2);
        const { settled, total } = await OutstandingManager.receivePartyPayment('retail', [server.r1, server.r2], [100, 150], 'cash');
        expect(updateBillsInTransaction).toHaveBeenCalledTimes(1);
        expect(updateBillsInTransaction.mock.calls[0][0]).toBe('retailSales');
        expect(total).toBe(250);
        expect(settled.map(s => s.amount)).toEqual([100, 150]);
        const e1 = server.r1.payments[0];
        const e2 = server.r2.payments[0];
        expect(e1.id).not.toBe(e2.id);
        expect(e1.at).toBe(e2.at);
        expect(e1).toMatchObject({ amount: 100, cash: 100, online: 0, bulk: true, recordedById: 'm1' });
        expect(server.r1.paidAt).toBe(e1.at);
        expect(server.r1.payment.due).toBe(0);
        expect(server.r2.payment).toMatchObject({ due: 100, cash: 250 });
        expect(server.r2.dueAmount).toBe(100);
        expect(server.r1.cleared).toBeUndefined();
        expect(outstandingDue(server.r1) + outstandingDue(server.r2)).toBe(before - total);
        // The drawer counts these payments from the bill entries (no session legs)
        const events = dueEvents({ bills: { retail: Object.values(server) }, sessions: [], from: e1.at - 1, to: e1.at + 1 });
        expect(sumDueEvents(events).receivedCash).toBe(250);
    });

    test('a part above the due on the server (paid meanwhile) aborts all; a voided bill aborts all', async () => {
        const server = { r1: bill('r1', 'Ravi', 100, 1), r2: bill('r2', 'Ravi', 20, 2) };
        serverTx(server);
        await expect(OutstandingManager.receivePartyPayment('retail', [server.r1, server.r2], [100, 50], 'online'))
            .rejects.toMatchObject({ code: 'due-changed' });
        expect(server.r1.payments).toEqual([]);
        server.r2 = { ...server.r2, payment: { ...server.r2.payment, due: 50 }, voided: true };
        await expect(OutstandingManager.receivePartyPayment('retail', [server.r1, server.r2], [100, 50], 'online'))
            .rejects.toMatchObject({ code: 'voided' });
    });

    test('a retry after a lost answer finds its own entries and writes nothing twice', async () => {
        const server = { r1: bill('r1', 'Ravi', 100, 1) };
        serverTx(server);
        await OutstandingManager.receivePartyPayment('retail', [server.r1], [60], 'cash', ['e1']);
        const again = await OutstandingManager.receivePartyPayment('retail', [server.r1], [60], 'cash', ['e1']);
        expect(server.r1.payments).toHaveLength(1);
        expect(again.total).toBe(60);
    });
});

describe('Receive payment dialog', () => {
    const answer = (amount, method, edit) => jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async (html) => {
        document.body.innerHTML = `<div id="modal">${html}</div>`;
        document.getElementById('ppAmount').value = String(amount);
        OutstandingManager.partyPayFill();
        if (edit) edit();
        if (method) document.querySelector(`input[name="partyPayMethod"][value="${method}"]`).checked = true;
        return true;
    });

    beforeEach(() => {
        AppState.retailSalesHistory = [bill('r2', 'Ravi', 250, 2), bill('r1', ' ravi ', 100, 1), bill('o1', 'Other', 70, 3)];
    });

    test('fills oldest first, shows the total, and records one transaction with an audit row', async () => {
        const server = { r1: bill('r1', 'Ravi', 100, 1), r2: bill('r2', 'Ravi', 250, 2) };
        serverTx(server);
        answer(300, 'online');
        await OutstandingManager.receiveFromParty(normalizePartyName('Ravi'));
        expect(document.getElementById('ppPart-0').value).toBe('100');
        expect(document.getElementById('ppPart-1').value).toBe('200');
        expect(document.getElementById('ppSum').textContent).toBe('Total: ₹300');
        expect(updateBillsInTransaction.mock.calls[0][1]).toEqual(['r1', 'r2']);
        expect(server.r2.payment).toMatchObject({ due: 50, online: 200 });
        expect(AuditService.log).toHaveBeenCalledWith('UPDATE_PAYMENT', expect.objectContaining({ bulk: true, oldestFirst: true, paymentAmount: 300, method: 'online' }));
        expect(UIManager.showToast).toHaveBeenLastCalledWith('✓ ₹300 recorded on 2 bills');
    });

    test('a hand-edited split is used; only bills with a part are written', async () => {
        const server = { r1: bill('r1', 'Ravi', 100, 1), r2: bill('r2', 'Ravi', 250, 2) };
        serverTx(server);
        answer(100, 'cash', () => {
            document.getElementById('ppPart-0').value = '';
            document.getElementById('ppPart-1').value = '100';
        });
        await OutstandingManager.receiveFromParty(normalizePartyName('Ravi'));
        expect(updateBillsInTransaction.mock.calls[0][1]).toEqual(['r2']);
        expect(server.r2.payment.due).toBe(150);
        expect(server.r1.payments).toEqual([]);
    });

    test('more than the dues is shown as not recorded; no method or a bad split writes nothing', async () => {
        answer(500, null);
        await OutstandingManager.receiveFromParty(normalizePartyName('Ravi'));
        expect(document.getElementById('ppSum').textContent).toBe('Total: ₹350 · ₹150 more than the dues is not recorded');
        expect(updateBillsInTransaction).not.toHaveBeenCalled();
        answer(100, 'cash', () => { document.getElementById('ppPart-0').value = '101'; });
        await OutstandingManager.receiveFromParty(normalizePartyName('Ravi'));
        expect(updateBillsInTransaction).not.toHaveBeenCalled();
    });

    test('parts edited so they no longer add up to the amount, or no amount: nothing is written', async () => {
        const server = { r1: bill('r1', 'Ravi', 100, 1), r2: bill('r2', 'Ravi', 250, 2) };
        serverTx(server);
        answer(100, 'cash', () => { document.getElementById('ppPart-1').value = '250'; OutstandingManager.partyPaySum(); });
        await OutstandingManager.receiveFromParty(normalizePartyName('Ravi'));
        expect(UIManager.showToast).toHaveBeenLastCalledWith('The parts add up to ₹350: ₹250 more than the amount ₹100. Change the parts or the amount.');
        expect(document.getElementById('ppSum').textContent).toContain('₹250 more than the amount');
        answer('', 'cash', () => {
            document.getElementById('ppPart-0').value = '100';
            document.getElementById('ppPart-1').value = '250';
        });
        await OutstandingManager.receiveFromParty(normalizePartyName('Ravi'));
        expect(UIManager.showToast).toHaveBeenLastCalledWith('Enter the amount');
        expect(updateBillsInTransaction).not.toHaveBeenCalled();
        expect(server.r1.payments).toEqual([]);
    });

    test('kept retry ids are forgotten once that payment is on the bills, so a new equal payment is saved', async () => {
        const server = { r1: bill('r1', 'Ravi', 2000, 1), r2: bill('r2', 'Ravi', 250, 2) };
        serverTx(server);
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        // First try: committed on the server, answer lost
        updateBillsInTransaction.mockImplementationOnce(async (collKey, ids, change) => {
            const fresh = ids.map(id => JSON.parse(JSON.stringify(server[id])));
            const out = change(fresh);
            out.bills.forEach((fields, i) => { if (fields) server[ids[i]] = { ...server[ids[i]], ...fields }; });
            throw Object.assign(new Error('deadline'), { code: 'deadline-exceeded' });
        });
        AppState.retailSalesHistory = [server.r1, server.r2];
        answer(500, 'cash');
        await OutstandingManager.receiveFromParty(normalizePartyName('Ravi'));
        expect(server.r1.payment.due).toBe(1500);
        // The listener brings the landed payment; the customer pays ₹500 again
        AppState.retailSalesHistory = [server.r1, server.r2];
        answer(500, 'cash');
        await OutstandingManager.receiveFromParty(normalizePartyName('Ravi'));
        expect(server.r1.payments).toHaveLength(2);
        expect(server.r1.payment.due).toBe(1000);
    });

    test('more than 100 open bills: says only the oldest 100 are listed', async () => {
        AppState.retailSalesHistory = Array.from({ length: 105 }, (_, i) => bill(`b${i}`, 'Ravi', 10, i));
        jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async (html) => { document.body.innerHTML = html; return false; });
        await OutstandingManager.receiveFromParty(normalizePartyName('Ravi'));
        expect(document.body.textContent).toContain('Only the oldest 100 of 105 bills are listed');
    });

    test('paise left by a paise due are not called "more than the dues"', async () => {
        AppState.retailSalesHistory = [bill('r1', 'Ravi', 100.5, 1), bill('r2', 'Ravi', 50, 2)];
        answer(150, null);
        await OutstandingManager.receiveFromParty(normalizePartyName('Ravi'));
        expect(document.getElementById('ppSum').textContent).toBe('Total: ₹149.50 · ₹0.50 (paise of an old due) is not recorded');
    });

    test('members can not use it', async () => {
        AppState.userRole = 'staff';
        const modal = jest.spyOn(UIManager, 'showModalWithHtml');
        await OutstandingManager.receiveFromParty(normalizePartyName('Ravi'));
        expect(modal).not.toHaveBeenCalled();
        expect(OutstandingManager.canReceiveFromParty()).toBe(false);
    });
});
