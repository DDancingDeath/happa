/**
 * @fileoverview Wholesale "Complete all due" (#150): one transaction settles every
 * open bill of a party, each with its own payment entry at the same time; owner /
 * manager only; totals before and after reconcile.
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
import { WholesaleSalesManager } from '../modules/wholesale-sales.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { duePaymentUpdate, partyDues, settleDueUpdate, dueEvents } from '../utils/due-payments.js';
import { normalizePartyName } from '../utils/aging.js';
import { outstandingDue, readPayment } from '../utils/money.js';
import { drawerDay } from '../utils/calc/cash.js';
import { toLocalISODate } from '../utils/dates.js';

const bill = (id, customerName, due, extra = {}) => ({
    id, billNumber: `W-${id}`, source: 'sales-tab', customerName, total: due + 100, timestamp: Number(id.replace(/\D/g, '')) || 1,
    payment: { cash: 100, online: 0, due, total: 100 }, dueAmount: due, payments: [], ...extra
});

/** Runs the transaction's change on copies of `server` and applies its writes there. */
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
    AppState.currentUser = { uid: 'm1', email: 'm@x' };
    AppState.userName = 'Manager';
    AppState.userRole = 'manager';
    AppState.settings = { showHindi: false };
    updateBillsInTransaction.mockReset();
    AuditService.log.mockClear();
});
afterEach(() => jest.restoreAllMocks());

describe('pure parts (DUE-ALL)', () => {
    test('partyDues: the open bills of one party (any spelling), oldest first, and their total', () => {
        const bills = [bill('w3', 'Gupta Traders', 300.5), bill('w1', ' gupta  traders ', 120), bill('w2', 'Other', 50),
            bill('w4', 'Gupta Traders', 0), bill('w5', 'Gupta Traders', 80, { cleared: true }), bill('w6', 'Gupta Traders', 70, { voided: true })];
        const got = partyDues(bills, normalizePartyName('GUPTA TRADERS'), normalizePartyName);
        expect(got.bills.map(x => [x.bill.id, x.due])).toEqual([['w1', 120], ['w3', 300.5]]);
        expect(got.total).toBe(420.5);
        expect(partyDues(bills, '', normalizePartyName)).toEqual({ bills: [], total: 0 });
    });

    test('duePaymentUpdate: money up and due down by the payment, entry appended, paidAt = its time; refused above the due', () => {
        const b = bill('w1', 'A', 100);
        const entry = { id: 'e', amount: 60, cash: 40, online: 20, at: 5 };
        expect(duePaymentUpdate(b, { cash: 40, online: 20 }, entry)).toEqual({
            ok: true, due: 40,
            update: { payment: { cash: 140, online: 20, due: 40, total: 160 }, payments: [entry], paidAt: 5, dueAmount: 40 }
        });
        const noTop = { payment: { cash: 0, online: 0, due: 10 } };
        expect(duePaymentUpdate(noTop, { cash: 9.999, online: 0 }, { at: 1 }).update).not.toHaveProperty('dueAmount');
        expect(duePaymentUpdate(noTop, { cash: 9.999, online: 0 }, { at: 1 }).due).toBe(0);
        expect(duePaymentUpdate(noTop, { cash: 10.02, online: 0 }, { at: 1 })).toEqual({ ok: false, error: 'exceeds-due', due: 10 });
    });

    test('settleDueUpdate: the whole due in cash or online; nothing when paid or cleared', () => {
        const b = bill('w1', 'A', 250.25);
        expect(settleDueUpdate(b, 'online', { id: 'e', at: 7 })).toMatchObject({
            amount: 250.25,
            update: { payment: { cash: 100, online: 250.25, due: 0 }, payments: [{ id: 'e', at: 7, amount: 250.25, cash: 0, online: 250.25 }] }
        });
        expect(settleDueUpdate(bill('w2', 'A', 0), 'cash', {})).toBeNull();
        expect(settleDueUpdate(bill('w3', 'A', 5, { cleared: true }), 'cash', {})).toBeNull();
    });
});

describe('OutstandingManager.settleAllDues', () => {
    test('one transaction: each bill its own entry at the same now, due 0, cleared; totals reconcile', async () => {
        const server = { w1: bill('w1', 'Gupta', 120), w2: bill('w2', 'Gupta', 300.5, { payments: [{ id: 'old', amount: 10, at: 1 }] }) };
        serverTx(server);
        const before = outstandingDue(server.w1) + outstandingDue(server.w2);
        const { settled, total } = await OutstandingManager.settleAllDues('wholesale', [server.w1, server.w2], 'cash');

        expect(updateBillsInTransaction).toHaveBeenCalledTimes(1);
        expect(updateBillsInTransaction.mock.calls[0][0]).toBe('wholesaleSales');
        expect(total).toBe(before);
        expect(settled.map(s => s.amount)).toEqual([120, 300.5]);
        const entries = [server.w1, server.w2].map(b => b.payments.at(-1));
        expect(new Set(entries.map(e => e.id)).size).toBe(2);
        expect(entries.every(e => e.at === entries[0].at && Math.abs(e.at - Date.now()) < 5000)).toBe(true);
        expect(entries.map(e => [e.amount, e.cash, e.online, e.recordedById])).toEqual([[120, 120, 0, 'm1'], [300.5, 300.5, 0, 'm1']]);
        for (const b of [server.w1, server.w2]) {
            expect(readPayment(b).due).toBe(0);
            expect(b).toMatchObject({ dueAmount: 0, cleared: true, clearedBy: 'm1', openDue: false, clientVersion: 4, paidAt: entries[0].at });
        }
        expect(server.w2.payments[0].id).toBe('old');
        // The drawer counts the bill entries (no session legs needed)
        const events = dueEvents({ bills: { wholesale: [server.w1, server.w2] }, from: entries[0].at, to: entries[0].at + 1 });
        expect(events.reduce((s, e) => s + e.cash, 0)).toBe(420.5);
        // Today's drawer (C4) takes the settled cash, with or without a cash session; the old bills' sale-time cash stays on their days
        const today = toLocalISODate(new Date(entries[0].at));
        const session = { date: today, openingBalance: 500, dueTransactions: [] };
        for (const s of [null, session]) {
            expect(drawerDay({ date: today, bills: { wholesale: [server.w1, server.w2] }, session: s })).toMatchObject({ dueReceived: 420.5, cashSales: 0 });
        }
    });

    test('settles what is due on the server: a bill paid meanwhile is skipped, a part-paid one settles the rest; a voided one aborts all', async () => {
        const server = { w1: bill('w1', 'Gupta', 0, { cleared: true }), w2: bill('w2', 'Gupta', 40) };
        serverTx(server);
        const { settled, total } = await OutstandingManager.settleAllDues('wholesale', [bill('w1', 'Gupta', 120), bill('w2', 'Gupta', 300)], 'online');
        expect(settled.map(s => s.bill.id)).toEqual(['w2']);
        expect(total).toBe(40);
        expect(server.w1.payments).toEqual([]);

        const voided = { w3: bill('w3', 'Gupta', 50), w4: bill('w4', 'Gupta', 60, { voided: true }) };
        serverTx(voided);
        await expect(OutstandingManager.settleAllDues('wholesale', [voided.w3, voided.w4], 'cash')).rejects.toMatchObject({ code: 'voided' });
        expect(voided.w3.payments).toEqual([]);
    });

    test('re-run after a commit whose answer was lost: this run\'s entries count as settled, nothing written twice', async () => {
        const server = { w1: bill('w1', 'Gupta', 120), w2: bill('w2', 'Gupta', 80) };
        let runs = 0;
        updateBillsInTransaction.mockImplementation(async (collKey, ids, change) => {
            let out;
            // The SDK re-runs the change once more after the first commit (answer lost)
            for (let k = 0; k < 2; k++) {
                runs++;
                out = change(ids.map(id => JSON.parse(JSON.stringify(server[id]))));
                out.bills.forEach((fields, i) => { if (fields) server[ids[i]] = { ...server[ids[i]], ...fields }; });
            }
            return out.result;
        });
        const { settled, total } = await OutstandingManager.settleAllDues('wholesale', [server.w1, server.w2], 'cash', [120, 80]);
        expect(runs).toBe(2);
        expect([settled.length, total]).toEqual([2, 200]);
        expect([server.w1, server.w2].map(b => [b.payments.length, readPayment(b).cash, readPayment(b).due])).toEqual([[1, 220, 0], [1, 180, 0]]);
        expect(settled[0].fields.payments).toHaveLength(1);
    });

    test('a legacy bill is written at its document id, not its `id` field', async () => {
        const legacy = { ...bill('w9', 'Gupta', 30), docId: 'doc-9' };
        const server = { 'doc-9': bill('w9', 'Gupta', 30) };
        serverTx(server);
        const { total } = await OutstandingManager.settleAllDues('wholesale', [legacy], 'cash');
        expect(updateBillsInTransaction.mock.calls[0][1]).toEqual(['doc-9']);
        expect(total).toBe(30);
        expect(readPayment(server['doc-9']).due).toBe(0);
    });

    test('a due raised on the server after the confirm aborts all: never more money than confirmed', async () => {
        const server = { w1: bill('w1', 'Gupta', 120), w2: bill('w2', 'Gupta', 95) };
        serverTx(server);
        await expect(OutstandingManager.settleAllDues('wholesale', [bill('w1', 'Gupta', 120), bill('w2', 'Gupta', 80)], 'cash', [120, 80]))
            .rejects.toMatchObject({ code: 'due-changed' });
        expect(server.w1.payments).toEqual([]);
        const { total } = await OutstandingManager.settleAllDues('wholesale', [server.w1, server.w2], 'cash', [120, 95]);
        expect(total).toBe(215);
    });
});

describe('Wholesale › Outstanding: "Complete all due" (owner / manager)', () => {
    const DOM = '<div id="salesOutstandingList"></div><div id="salesRecentList"></div><div id="salesHistoryList"></div><div id="toast"></div>';
    let server;
    beforeEach(() => {
        document.body.innerHTML = DOM;
        server = { w1: bill('w1', 'Gupta', 120), w2: bill('w2', 'Gupta', 80), w3: bill('w3', 'Other', 50) };
        AppState.salesHistory = Object.values(server).map(b => ({ ...b }));
        serverTx(server);
        WholesaleSalesManager.outstandingParty = null;
        WholesaleSalesManager.pendingSettle = null;
    });

    test('a member sees no button and is refused', async () => {
        AppState.userRole = 'staff';
        WholesaleSalesManager.renderSalesOutstanding();
        expect(document.querySelectorAll('[data-complete-all]')).toHaveLength(0);
        await WholesaleSalesManager.completeAllDue('Gupta');
        expect(UIManager.showToast).toHaveBeenCalledWith('Access denied', 'error');
        expect(updateBillsInTransaction).not.toHaveBeenCalled();
    });

    test('a manager confirms count and total, picks Online: both bills settled in one go, one audit row', async () => {
        WholesaleSalesManager.renderSalesOutstanding();
        expect(document.querySelectorAll('[data-complete-all]').length).toBeGreaterThan(0);
        const modal = jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async (html) => {
            expect(html).toContain('2 bills due, ₹200 in all');
            document.body.insertAdjacentHTML('beforeend', '<input type="radio" name="completeAllMethod" value="online" checked>');
            return true;
        });
        await WholesaleSalesManager.completeAllDue('gupta');
        expect(modal).toHaveBeenCalledTimes(1);
        expect(updateBillsInTransaction).toHaveBeenCalledTimes(1);
        expect(updateBillsInTransaction.mock.calls[0][1]).toEqual(['w1', 'w2']);
        expect([server.w1, server.w2].map(b => [readPayment(b).due, readPayment(b).online])).toEqual([[0, 120], [0, 80]]);
        expect(readPayment(server.w3).due).toBe(50);
        expect(AppState.salesHistory.filter(s => outstandingDue(s) > 0).map(s => s.id)).toEqual(['w3']);
        expect(console.error.mock.calls).toEqual([]);
        expect(AuditService.log).toHaveBeenCalledTimes(1);
        expect(AuditService.log.mock.calls[0][1]).toMatchObject({ bulk: true, customer: 'gupta', method: 'online', paymentAmount: 200 });
        expect(UIManager.showToast).toHaveBeenLastCalledWith('2 bills settled, ₹200 received');
    });

    test('a retry after a write that reached the server but errored: same entry ids, so it is done (audit + toast), recorded once', async () => {
        // The first transaction is written on the server, but its answer never comes back
        updateBillsInTransaction.mockImplementationOnce(async (collKey, ids, change) => {
            const out = change(ids.map(id => JSON.parse(JSON.stringify(server[id]))));
            out.bills.forEach((fields, i) => { if (fields) server[ids[i]] = { ...server[ids[i]], ...fields }; });
            throw Object.assign(new Error('deadline'), { code: 'unavailable' });
        });
        jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async () => {
            document.querySelectorAll('input[name="completeAllMethod"]').forEach(el => el.remove());
            document.body.insertAdjacentHTML('beforeend', '<input type="radio" name="completeAllMethod" value="cash" checked>');
            return true;
        });
        await WholesaleSalesManager.completeAllDue('Gupta');
        expect(UIManager.showToast).toHaveBeenLastCalledWith('Internet required to record payment');
        // This phone still shows both bills due; the owner taps again
        expect(AppState.salesHistory.filter(s => outstandingDue(s) > 0)).toHaveLength(3);
        await WholesaleSalesManager.completeAllDue('Gupta');
        expect(updateBillsInTransaction).toHaveBeenCalledTimes(2);
        expect([server.w1, server.w2].map(b => [b.payments.length, readPayment(b).cash, readPayment(b).due])).toEqual([[1, 220, 0], [1, 180, 0]]);
        const firstIds = [server.w1, server.w2].map(b => b.payments[0].id);
        expect(UIManager.showToast).toHaveBeenLastCalledWith('2 bills settled, ₹200 received');
        expect(UIManager.showToast).not.toHaveBeenCalledWith(expect.stringContaining('0 bills'));
        expect(AuditService.log).toHaveBeenCalledTimes(1);
        expect(AuditService.log.mock.calls[0][1]).toMatchObject({ bulk: true, method: 'cash', paymentAmount: 200 });

        // Done: the ids are forgotten; another party's settle (or a later one) gets new ids
        expect(WholesaleSalesManager.pendingSettle).toBeNull();
        expect(WholesaleSalesManager.settleEntryIds('Gupta', 'cash', [server.w1, server.w2])).not.toEqual(firstIds);
    });

    test('settled elsewhere before this phone tried: "already settled", nothing recorded, no audit', async () => {
        for (const id of ['w1', 'w2']) server[id] = { ...server[id], payment: { ...server[id].payment, due: 0 }, dueAmount: 0, cleared: true };
        jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async () => {
            document.body.insertAdjacentHTML('beforeend', '<input type="radio" name="completeAllMethod" value="online" checked>');
            return true;
        });
        await WholesaleSalesManager.completeAllDue('Gupta');
        expect(UIManager.showToast).toHaveBeenLastCalledWith('Already settled: nothing is due on these bills now. Nothing was recorded again');
        expect([server.w1, server.w2].map(b => b.payments.length)).toEqual([0, 0]);
        expect(AuditService.log).not.toHaveBeenCalled();
    });

    test('a definite refusal (due changed) forgets the ids; a network error keeps them', async () => {
        updateBillsInTransaction.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'unavailable' }));
        await WholesaleSalesManager._completeAllDue('Gupta', [server.w1, server.w2], 'cash', [120, 80]);
        const kept = WholesaleSalesManager.pendingSettle.ids;
        expect(WholesaleSalesManager.settleEntryIds('Gupta', 'cash', [server.w1, server.w2])).toBe(kept);
        // another method or bill list is another settle
        expect(WholesaleSalesManager.settleEntryIds('Gupta', 'online', [server.w1, server.w2])).not.toBe(kept);
        updateBillsInTransaction.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'due-changed' }));
        await WholesaleSalesManager._completeAllDue('Gupta', [server.w1, server.w2], 'cash', [120, 80]);
        expect(WholesaleSalesManager.pendingSettle).toBeNull();
    });

    test('cancelling, or not picking cash / online, writes nothing', async () => {
        jest.spyOn(UIManager, 'showModalWithHtml').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await WholesaleSalesManager.completeAllDue('Gupta');
        await WholesaleSalesManager.completeAllDue('Gupta');
        expect(updateBillsInTransaction).not.toHaveBeenCalled();
    });
});
