/**
 * @fileoverview Characterisation of the Firestore calls that move out of pages and
 * services into repositories (docs/architecture.md, phase 4): bill drafts,
 * auto-save, item frequency, audit log, telemetry, bill counters, user profiles,
 * cash-session transactions and updates, and the due-payment / write-off
 * transactions; and, before firestore-service.js is split (phase 5, #69), the
 * FirebaseService methods that move out of it (items, rate stats, month
 * snapshots, backup, TIP, notifications, cash sessions, audit, anomalies, user
 * profiles). Every flow runs against the fake Firestore wrapped by
 * recording-firestore.js and pins the exact calls (collection, doc ids, queries,
 * limits, transaction reads and writes, write payloads) in
 * tests/fixtures/repositories-calls.json. Recorded against the code before the
 * move; the move must not change a single call. `REPO_CALLS_RECORD=1 npx jest
 * repositories-characterisation` rewrites the file (only for an intended change;
 * say why in the PR).
 */
import fs from 'fs';
import path from 'path';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';
import { recordFirestore } from './__mocks__/recording-firestore.js';
import { BillingManager, PurchaseManager, RetailSaleManager } from '../modules/billing.js';
import { CashManagementManager } from '../modules/cash-management.js';
import { OutstandingManager } from '../modules/outstanding.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
import { TelemetryService } from '../services/telemetry.js';
import { AuthManager } from '../auth/authentication.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { AppState } from '../utils/state.js';

const FILE = path.resolve(__dirname, '../../../tests/fixtures/repositories-calls.json');
const RECORD = !!process.env.REPO_CALLS_RECORD;
const EXPECTED = RECORD ? {} : JSON.parse(fs.readFileSync(FILE, 'utf8'));
const CASH_TEMPLATE = fs.readFileSync(path.resolve(__dirname, '../../templates/cash-management.html'), 'utf8');
const NOW = new Date(2026, 9, 21, 10, 0, 0).getTime();

/** Compares (or records) one flow's calls. */
function pin(name, log) {
    const calls = JSON.parse(JSON.stringify(log));
    if (RECORD) EXPECTED[name] = calls;
    else expect(calls).toEqual(EXPECTED[name]);
}

afterAll(() => {
    if (RECORD) fs.writeFileSync(FILE, `${JSON.stringify(EXPECTED, null, 2)}\n`);
});

let fake;
let rec;
let user;

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(NOW);
    fake = createFakeFirestore();
    rec = recordFirestore(fake.db);
    user = { uid: 'u1', email: 'o@x' };
    const FieldValue = {
        ...fake.firebase.firestore.FieldValue,
        serverTimestamp: () => 'SERVER_TIME',
        arrayUnion: (...v) => ({ arrayUnion: v })
    };
    global.firebase = {
        firestore: Object.assign(() => rec.db, { ...fake.firebase.firestore, FieldValue }),
        auth: () => ({ currentUser: user, signOut: jest.fn(async () => {}), signInWithEmailAndPassword: jest.fn(async () => ({ user })) })
    };
    window.firebase = global.firebase;
    global.db = rec.db;
    jest.spyOn(FirebaseService, 'db', 'get').mockReturnValue(rec.db);
    window.getCollection = (n) => `dev_${n}`;
    window.COLLECTION_PREFIX = 'dev_';
    let n = 0;
    jest.spyOn(Helpers, 'generateId').mockImplementation(() => `gen-${++n}`);
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    ['showToast', 'hapticFeedback', 'showLoading', 'hideLoading', 'closeModal'].forEach(m => jest.spyOn(UIManager, m).mockImplementation(() => {}));
    jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    // The auto-save stores the device's user agent; jsdom's names the host OS.
    jest.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('test-agent');
    AppState.currentUser = user;
    AppState.userName = 'Owner';
    AppState.userRole = 'owner';
    ['salesHistory', 'retailSalesHistory', 'purchaseHistory', 'expensesHistory'].forEach(k => { AppState[k] = []; });
});

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete global.firebase;
    delete window.firebase;
    delete global.db;
    delete window.getCollection;
    delete window.COLLECTION_PREFIX;
    document.body.innerHTML = '';
    localStorage.clear();
    CashManagementManager.todaySession = null;
    CashManagementManager.cachedSessions = null;
});

/** Lets fire-and-forget writes and their follow-ups run. */
const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await fake.settle();
};

describe('bill drafts, auto-save and item frequency (billing.js)', () => {
    const DOM = `
      <input id="customerName" value="Ram"><input id="manualLaborCharges" value="12"><input id="billComments" value="note">
      <input type="checkbox" id="billPrintComments"><input id="newWeight" value=""><input id="billItem" value="Rice"><input id="billRate" value="25">
      <input id="saleCustomerName"><input id="saleComments"><input type="checkbox" id="salePrintComments"><input id="saleWeight"><input id="saleItem"><input id="saleRate">
      <div id="draftsOverlay"><div id="draftsContent"></div></div><span id="draftCount"></span>`;
    beforeEach(() => {
        document.body.innerHTML = DOM;
        BillingManager.currentMode = 'purchase';
        jest.spyOn(PurchaseManager, 'renderBill').mockImplementation(() => {});
        jest.spyOn(PurchaseManager, 'renderWeights').mockImplementation(() => {});
        jest.spyOn(PurchaseManager, 'updateTotals').mockImplementation(() => {});
        jest.spyOn(BillingManager, 'switchMode').mockImplementation(() => {});
        PurchaseManager.setBillItems([{ name: 'Rice', qty: 40, rate: 25, total: 1000 }]);
        PurchaseManager.setWeights([40]);
        fake.seed('dev_drafts', [
            { id: 'd1', userId: 'u1', mode: 'purchase', timestamp: 2, date: '20/10/2026', items: [{ name: 'Rice', qty: 1, rate: 2, total: 2 }], weights: [1] },
            { id: 'd2', userId: 'u1', mode: 'sale', timestamp: 1, date: '19/10/2026', items: [], weights: [] },
            { id: 'd3', userId: 'u2', mode: 'sale', timestamp: 3, date: '19/10/2026', items: [], weights: [] }
        ]);
    });
    afterEach(() => {
        PurchaseManager.setBillItems([]);
        PurchaseManager.setWeights([]);
        PurchaseManager.setPendingBill(null);
        RetailSaleManager.setSaleItems([]);
        RetailSaleManager.setSaleWeights([]);
    });

    test('save a draft: one set of a client-made id, then the auto-save is dropped and the count re-read', async () => {
        await BillingManager.saveDraft();
        await settle();
        pin('draft.save', rec.log);
        expect(fake.raw('dev_drafts').get('gen-1')).toMatchObject({ userId: 'u1', mode: 'purchase', customerName: 'Ram', weights: [40] });
        expect(document.getElementById('draftCount').textContent).toBe('3');
    });

    test('Drafts list: this user\'s drafts, newest first', async () => {
        await BillingManager.showDrafts();
        pin('draft.list', rec.log);
        const html = document.getElementById('draftsContent').innerHTML;
        expect(html.indexOf("loadDraft('d1')")).toBeLessThan(html.indexOf("loadDraft('d2')"));
        expect(html).not.toContain('d3');
    });

    test('load a draft: read it, put it in the editor, delete it, re-count', async () => {
        await BillingManager.loadDraft('d1');
        pin('draft.load', rec.log);
        expect(fake.raw('dev_drafts').has('d1')).toBe(false);
        expect(PurchaseManager.getWeights()).toEqual([1]);
    });

    test('a missing draft: one read, nothing else', async () => {
        await BillingManager.loadDraft('nope');
        pin('draft.load-missing', rec.log);
    });

    test('delete a draft: delete, re-count, re-list', async () => {
        await BillingManager.deleteDraft('d2');
        pin('draft.delete', rec.log);
        expect(fake.raw('dev_drafts').has('d2')).toBe(false);
    });

    test('auto-save: one set of autoSaves/{uid} with both editors', async () => {
        await BillingManager.autoSaveToCloud();
        pin('autosave.save', rec.log);
        expect(fake.raw('dev_autoSaves').get('u1')).toMatchObject({ userId: 'u1', mode: 'purchase', lastSaved: 'SERVER_TIME' });
    });

    test('auto-save with empty editors deletes the auto-save', async () => {
        PurchaseManager.setBillItems([]);
        PurchaseManager.setWeights([]);
        await BillingManager.autoSaveToCloud();
        pin('autosave.empty', rec.log);
    });

    test('auto-save found on open and declined: read, then delete', async () => {
        fake.seed('dev_autoSaves', [{ id: 'u1', mode: 'purchase', purchase: { items: [] }, sale: { items: [] } }]);
        await BillingManager.checkAutoSave();
        expect(fake.raw('dev_autoSaves').has('u1')).toBe(true);
        await BillingManager.resolveRecovery(false);
        pin('autosave.check-declined', rec.log);
        expect(fake.raw('dev_autoSaves').has('u1')).toBe(false);
    });

    test('item frequency: one read of itemFrequency/global', async () => {
        fake.seed('dev_itemFrequency', [{ id: 'global', purchase: { Rice: { score: 5, count: 1, lastUsed: 1 } }, sale: {} }]);
        await BillingManager.loadItemFrequency();
        pin('itemFrequency.load', rec.log);
        expect(BillingManager.itemFrequency.purchase.Rice.score).toBe(5);
    });

    test('item frequency after a bill: one merge set with increments per item', async () => {
        BillingManager.itemFrequency = { purchase: {}, sale: {} };
        await BillingManager.updateItemFrequency([{ name: 'Rice', qty: 40 }, { name: 'Rice', qty: 10 }, { itemId: 'i.2/x', qty: 5 }], 'purchase');
        pin('itemFrequency.update', rec.log);
        expect(fake.raw('dev_itemFrequency').get('global').purchase).toMatchObject({ Rice: { score: 205, count: 2 }, 'i.2/x': { score: 100.5, count: 1 } });
    });
});

describe('audit log (services/audit.js)', () => {
    test('log: one add, not awaited', async () => {
        await AuditService.log(AuditService.ACTIONS.EDIT_BILL, { billNumber: 'P1' });
        await settle();
        pin('audit.log', rec.log);
        expect([...fake.raw('dev_auditLogs').values()][0]).toMatchObject({ action: 'EDIT_BILL', userId: 'u1', serverTime: 'SERVER_TIME', details: { billNumber: 'P1' } });
    });

    test('reads: recent, by user, by action', async () => {
        fake.seed('dev_auditLogs', [
            { id: 'a1', action: 'EDIT_BILL', userId: 'u1', timestamp: 3 },
            { id: 'a2', action: 'LOGIN', userId: 'u2', timestamp: 2 },
            { id: 'a3', action: 'EDIT_BILL', userId: 'u2', timestamp: 1 }
        ]);
        const recent = await AuditService.getRecentLogs(2);
        const byUser = await AuditService.getLogsByUser('u2', 5);
        const byAction = await AuditService.getLogsByAction('EDIT_BILL');
        pin('audit.reads', rec.log);
        expect(recent.map(l => l.id)).toEqual(['a1', 'a2']);
        expect(byUser.map(l => l.id)).toEqual(['a2', 'a3']);
        expect(byAction.map(l => l.id)).toEqual(['a1', 'a3']);
    });

    test('cleanup (owner, once a day): logs older than 91 days, at most 100, deleted in one batch', async () => {
        const DAY = 86400000;
        fake.seed('dev_auditLogs', [
            { id: 'old1', action: 'LOGIN', timestamp: NOW - 100 * DAY },
            { id: 'old2', action: 'LOGIN', timestamp: NOW - 92 * DAY },
            { id: 'keep', action: 'LOGIN', timestamp: NOW - 90 * DAY }
        ]);
        const result = await AuditService.cleanupOldLogs();
        const again = await AuditService.cleanupOldLogs();
        pin('audit.cleanup', rec.log);
        expect(result).toEqual({ deleted: 2 });
        expect(again).toEqual({ deleted: 0, skipped: true });
        expect([...fake.raw('dev_auditLogs').keys()]).toEqual(['keep']);
    });
});

describe('telemetry (services/telemetry.js)', () => {
    afterEach(() => {
        TelemetryService.errorBuffer = [];
        TelemetryService.backoffMs = 0;
        TelemetryService.backoffUntil = 0;
    });

    test('sync: one create-only document per grouped error', async () => {
        TelemetryService.errorBuffer = [
            { fingerprint: 'fp1', message: 'boom', type: 'error', timestamp: 1, userId: 'u1', userName: 'Owner' },
            { fingerprint: 'fp1', message: 'boom', type: 'error', timestamp: 2, userId: 'u1', userName: 'Owner' },
            { fingerprint: 'fp2', message: 'bang', type: 'error', timestamp: 3, userId: 'u1', userName: 'Owner' }
        ];
        await TelemetryService.syncToFirestore();
        pin('telemetry.sync', rec.log);
        expect(fake.raw('dev_telemetry').size).toBe(2);
    });

    test('owner reads and hides reports (#116); reports last seen over 90 days ago are deleted, hidden or not', async () => {
        const OLD = NOW - 91 * 86400000;
        fake.seed('dev_telemetry', [
            { id: 't1', fingerprint: 'fp1', message: 'a', lastSeen: NOW - 2000, count: 1 },
            { id: 't2', fingerprint: 'fp2', message: 'b', lastSeen: NOW - 3000, count: 1 },
            { id: 't0', fingerprint: 'fp0', message: 'z', lastSeen: NOW - 1000, count: 1, hidden: true },
            { id: 't9', fingerprint: 'fp9', message: 'old hidden', lastSeen: OLD, count: 1, hidden: true },
            { id: 't8', fingerprint: 'fp8', message: 'old shown', lastSeen: OLD, count: 1 }
        ]);
        const data = await TelemetryService.getTelemetryData();
        for (let i = 0; i < 10; i++) await Promise.resolve();
        await TelemetryService.hideErrors(['t1', 't2', 't1']);
        pin('telemetry.owner', rec.log);
        expect(data.map(d => d.id)).toEqual(['fp1', 'fp2', 'fp8']);
        expect([...fake.raw('dev_telemetry').keys()].sort()).toEqual(['t0', 't1', 't2']);
        expect(fake.raw('dev_telemetry').get('t1')).toMatchObject({ hidden: true, message: 'a' });
        expect((await TelemetryService.getTelemetryData()).length).toBe(0);
        // at most once a day per phone
        expect(await TelemetryService.cleanupOldReports(NOW + 1000)).toBe(0);
    });
});

describe('bill numbers (utils/helpers.js)', () => {
    test('online: one counter transaction, seeded once from today\'s bills', async () => {
        fake.seed('dev_wholesaleSales', [{ id: 'w1', timestamp: NOW - 1000 }, { id: 'w2', timestamp: NOW - 2 * 86400000 }]);
        const first = await Helpers.generateBillNumber('W', 'wholesaleSales');
        const second = await Helpers.generateBillNumber('W', 'wholesaleSales');
        pin('counters.next', rec.log);
        expect([first, second]).toEqual(['W20261021-002', 'W20261021-003']);
    });
});

describe('user profiles (auth/authentication.js)', () => {
    test('register: create the pending profile in a transaction, never over an existing one', async () => {
        const created = await AuthManager.createPendingProfile(user, 'Asha', 'a@x.com');
        const again = await AuthManager.createPendingProfile(user, 'Asha', 'a@x.com');
        pin('users.createPending', rec.log);
        expect([created, again]).toEqual([true, false]);
        expect(fake.raw('dev_users').get('u1')).toMatchObject({ name: 'Asha', role: 'staff', status: 'pending', createdAt: 'SERVER_TIME' });
    });

    test('login: the profile is read once; a pending one is re-read from the server', async () => {
        document.body.innerHTML = `<div id="authScreen"></div><input id="loginEmail" value="a@x.com"><input id="loginPassword" value="secret1">
          <form id="loginForm"><div id="loginMessage"></div><button type="submit">Login</button></form>`;
        window.initializeApp = jest.fn(async () => {});
        fake.seed('dev_users', [{ id: 'u1', name: 'Asha', role: 'staff', status: 'pending' }]);
        await AuthManager.handleLogin();
        delete window.initializeApp;
        pin('users.login-pending', rec.log);
    });
});

describe('cash sessions (cash-management.js)', () => {
    beforeEach(() => {
        document.body.innerHTML = CASH_TEMPLATE;
        AppState.salesHistory = [{ id: 'w1', date: '2026-10-20T11:00:00', total: 1000, payment: { cash: 1000, online: 0, due: 0 } }];
    });

    test('auto-close of an earlier open day: a transaction reads the session and updates it', async () => {
        fake.seed('dev_cashManagement', [
            { id: 's20', date: '2026-10-20', openingBalance: 500, signedOut: false, duePayments: [] },
            { id: 's19', date: '2026-10-19', openingBalance: 800, signedOut: true, counted: true, closingBalance: 500 }
        ]);
        const sessions = [{ id: 's20', date: '2026-10-20', openingBalance: 500, signedOut: false, duePayments: [] }];
        await CashManagementManager.autoSignOutPreviousDays(sessions);
        pin('cash.autoClose', rec.log);
        expect(sessions[0]).toMatchObject({ signedOut: true, expectedBalance: 1500 });
    });

    test('late count: a transaction reads the session and writes the count', async () => {
        fake.seed('dev_cashManagement', [{ id: 's20', date: '2026-10-20', signedOut: true, counted: false, closingBalance: null, expectedBalance: 1500 }]);
        CashManagementManager.cachedSessions = [{ id: 's20', date: '2026-10-20', signedOut: true, counted: false, closingBalance: null, expectedBalance: 1500 }];
        document.body.insertAdjacentHTML('beforeend', '<input id="lateCountAmount" value="1450">');
        await CashManagementManager.recordLateCount('s20');
        pin('cash.lateCount', rec.log);
        expect(fake.raw('dev_cashManagement').get('s20')).toMatchObject({ closingBalance: 1450, difference: -50, counted: true });
    });

    test('close, a deposit and a "No bill" entry: field updates of today\'s session (arrayUnion for entries)', async () => {
        const session = { id: 's21', date: '2026-10-21', openingBalance: 1000, signedOut: false, duePayments: [], cashDeposits: [] };
        fake.seed('dev_cashManagement', [session]);
        CashManagementManager.todaySession = { ...session };
        CashManagementManager.cachedSessions = [{ ...session }];
        jest.spyOn(CashManagementManager, 'renderHistory').mockImplementation(() => {});

        document.getElementById('cashTransactionType').value = 'deposit';
        CashManagementManager.updateTransactionForm();
        document.getElementById('transactionAmount').value = '200';
        document.getElementById('transactionNotes').value = 'float';
        await CashManagementManager.recordTransaction();
        await settle();

        document.getElementById('cashTransactionType').value = 'received';
        CashManagementManager.updateTransactionForm();
        document.getElementById('partyName').value = 'Gita';
        CashManagementManager.populateDueBills();
        document.getElementById('dueBillSelect').value = '__nobill__';
        document.getElementById('transactionAmount').value = '50';
        document.getElementById('transactionNotes').value = 'old';
        await CashManagementManager.recordTransaction();
        await settle();

        document.getElementById('cashSignOutAmount').value = String(CashManagementManager.calculateExpectedCash());
        await CashManagementManager.signOut();
        await settle();
        pin('cash.updates', rec.log);
        expect(fake.raw('dev_cashManagement').get('s21')).toMatchObject({ signedOut: true });
    });
});

describe('due payments and write-offs (outstanding.js)', () => {
    const SALE = { id: 'r1', billNumber: 'S1', customerName: 'Sita', date: '2026-10-21T09:00:00', total: 795, cashPayment: 300, dueAmount: 495, payment: { cash: 300, online: 0, due: 495, total: 300 } };
    const SESSION = { id: 's21', date: '2026-10-21', openingBalance: 1000, signedOut: false, duePayments: [] };

    test('a payment with today\'s drawer open: one transaction reads bill and session, updates both', async () => {
        fake.seed('dev_retailSales', [SALE]);
        fake.seed('dev_cashManagement', [SESSION]);
        CashManagementManager.todaySession = { ...SESSION };
        const written = await OutstandingManager.applyPaymentTransaction('retail', { ...SALE }, { cash: 200, online: 95 }, { recordedBy: 'Owner', date: '21/10/2026', note: 'n' });
        pin('bills.payment', rec.log);
        expect(written.payment).toMatchObject({ cash: 500, online: 95, due: 200 });
        expect(fake.raw('dev_cashManagement').get('s21').duePayments).toHaveLength(1);
    });

    test('a payment retried after it reached the server adds nothing', async () => {
        fake.seed('dev_retailSales', [{ ...SALE, payments: [{ id: 'e1', amount: 10 }] }]);
        CashManagementManager.todaySession = { ...SESSION, signedOut: true };
        await OutstandingManager.applyPaymentTransaction('retail', { ...SALE }, 10, { id: 'e1', recordedBy: 'Owner' });
        pin('bills.payment-retry', rec.log);
    });

    test('a legacy bill stored under another doc id: the transaction finds nothing, the doc is looked up by its id field, then retried', async () => {
        fake.seed('dev_wholesaleSales', [{ ...SALE, id: 'legacy-7', docKey: 'x' }]);
        fake.raw('dev_wholesaleSales').set('autoDoc', fake.raw('dev_wholesaleSales').get('legacy-7'));
        fake.raw('dev_wholesaleSales').delete('legacy-7');
        fake.raw('dev_wholesaleSales').get('autoDoc').id = 'legacy-7';
        CashManagementManager.todaySession = { ...SESSION, signedOut: true };
        await OutstandingManager.applyPaymentTransaction('wholesale', { ...SALE, id: 'legacy-7' }, 95, { recordedBy: 'Owner' });
        pin('bills.payment-legacy', rec.log);
        expect(fake.raw('dev_wholesaleSales').get('autoDoc').payment.due).toBe(400);
    });

    test('write-off: one transaction, both due fields to 0, a writeOff entry', async () => {
        fake.seed('dev_purchases', [{ ...SALE, id: 'p1' }]);
        const written = await OutstandingManager.applyWriteOffTransaction('purchase', { ...SALE, id: 'p1' }, 'left town');
        pin('bills.writeOff', rec.log);
        expect(written.payment).toMatchObject({ due: 0, writtenOff: 495 });
    });

    test('a bill that is gone: both attempts find nothing → "Transaction not found"', async () => {
        await expect(OutstandingManager.applyWriteOffTransaction('purchase', { ...SALE, id: 'gone' }, 'x')).rejects.toThrow('Transaction not found');
        pin('bills.missing', rec.log);
    });
});

describe('FirebaseService collection methods (phase 5: pinned before the split of firestore-service.js)', () => {
    const DAY = 86400000;
    afterEach(() => {
        FirebaseService.forgetPeopleCaches();
        FirebaseService.cleanup();
    });

    test('items and rate history: list, save (new / existing), archive, import, history entries and reads', async () => {
        fake.seed('dev_items', [{ id: 'i1', name: 'Rice', rate: 30 }]);
        fake.seed('dev_rateHistory', [
            { id: 'i1_0000000000001', itemId: 'i1', at: 1 },
            { id: 'i1_9999999999998', itemId: 'i1', at: 2 },
            { id: 'i2_0000000000001', itemId: 'i2', at: 3 }
        ]);
        const items = await FirebaseService.loadItems();
        const added = await FirebaseService.saveItem({ name: 'Wheat', rate: 25 });
        await FirebaseService.saveItem({ id: 'i1', name: 'Rice', rate: 31 });
        await FirebaseService.setItemArchived('i1', true);
        const imported = await FirebaseService.importItems([{ id: 'i9', fields: { rate: 5 } }], [{ fields: { name: 'Dal' } }]);
        await FirebaseService.importItems([], []);
        await FirebaseService.addRateHistoryEntries([{ id: 'i1_5', data: { itemId: 'i1', rate: 31 } }]);
        await FirebaseService.addRateHistoryEntries([]);
        const all = await FirebaseService.loadRateHistory('i1', 2);
        const since = await FirebaseService.loadRateHistory('i1', 30, { since: NOW });
        pin('service.items', rec.log);
        expect(items.map(i => i.id)).toEqual(['i1']);
        expect(added.id).toBeTruthy();
        expect(imported).toHaveLength(1);
        expect(all.length).toBeGreaterThan(0);
        expect(Array.isArray(since)).toBe(true);
    });

    test('rate stats: bill pages by id, oldest bill, year docs, server years, writes and the meta doc', async () => {
        fake.seed('dev_purchases', [{ id: 'p1', timestamp: 500 }, { id: 'p2', timestamp: 300 }]);
        fake.seed('dev_retailSales', [{ id: 'r1', timestamp: 200 }]);
        fake.seed('dev_rateStats', [
            { id: 'i1_2025', year: '2025', itemId: 'i1' },
            { id: 'i1_2026', year: '2026', itemId: 'i1' },
            { id: 'i2_2026', year: '2026', itemId: 'i2' },
            { id: '_meta', done: true }
        ]);
        const page1 = await FirebaseService.loadBillPageById('purchases', null, 1);
        const page2 = await FirebaseService.loadBillPageById('purchases', page1.docs[0].id, 1);
        const oldest = await FirebaseService.oldestBillTimestamp();
        const forItem = await FirebaseService.loadRateStatsForItem('i1');
        const forYear = await FirebaseService.loadRateStatsForYear('2026', 1);
        const fromYear = await FirebaseService.loadServerRateStatsFromYear('2026');
        await FirebaseService.saveRateStats([{ id: 'i3_2026', data: { year: '2026' } }]);
        await FirebaseService.saveRateStats([]);
        const meta = await FirebaseService.loadRateStatsMeta();
        const metaServer = await FirebaseService.loadRateStatsMeta({ server: true });
        await FirebaseService.saveRateStatsMeta({ done: false });
        pin('service.rateStats', rec.log);
        expect([page1.docs[0].id, page2.docs[0].id]).toEqual(['p1', 'p2']);
        expect(oldest).toBe(200);
        expect(forItem.map(d => d.id)).toEqual(['i1_2025', 'i1_2026']);
        expect(forYear.more).toBe(true);
        expect(fromYear.docs).toHaveLength(2);
        expect(meta).toMatchObject({ done: true });
        expect(metaServer).toMatchObject({ done: true });
    });

    test('month snapshots: reads from a month, writes, the guarded rebuild and save', async () => {
        fake.seed('dev_monthStats', [
            { id: '2026-08', sales: 1 },
            { id: '2026-09', sales: 2, stale: true, staleAt: 7 },
            { id: '2026-10', sales: 3, stale: true, staleAt: 9 },
            { id: '2026-06', sales: 4, stale: true, staleAt: 3 }
        ]);
        const months = await FirebaseService.loadMonthStats('2026-09');
        await FirebaseService.saveMonthStats([{ month: '2026-07', sales: 0 }]);
        await FirebaseService.saveMonthStats([]);
        const rebuilt = await FirebaseService.rebuildMonthStat({ month: '2026-09', sales: 5 }, 7);
        const newer = await FirebaseService.rebuildMonthStat({ month: '2026-10', sales: 5 }, 8);
        const fresh = await FirebaseService.rebuildMonthStat({ month: '2026-08', sales: 5 }, 1);
        const guarded = await FirebaseService.saveMonthStatGuarded({ month: '2026-10', sales: 6 }, { staleAt: 9 });
        const unseeded = await FirebaseService.saveMonthStatGuarded({ month: '2026-11', sales: 6 });
        const refused = await FirebaseService.saveMonthStatGuarded({ month: '2026-06', sales: 6 });
        const otherMark = await FirebaseService.saveMonthStatGuarded({ month: '2026-06', sales: 6 }, { staleAt: 2 });
        pin('service.monthStats', rec.log);
        expect(Object.keys(months)).toEqual(['2026-09', '2026-10']);
        expect([rebuilt.status, newer.status, fresh.status, guarded.status, unseeded.status, refused.status, otherMark.status])
            .toEqual(['written', 'newer', 'fresh', 'written', 'written', 'newer', 'newer']);
        expect(fake.raw('dev_monthStats').get('2026-06')).toMatchObject({ sales: 4, stale: true });
    });

    test('backup and storage: read a collection, delete in batches, count documents', async () => {
        fake.seed('dev_telemetry', [{ id: 'a', x: 1 }, { id: 'b', x: 2 }]);
        const docs = await FirebaseService.readCollectionForBackup('telemetry');
        const count = await FirebaseService.countDocuments('telemetry');
        const deleted = await FirebaseService.deleteDocsInBatches('telemetry', ['a', 'b']);
        pin('service.backup', rec.log);
        expect([docs.length, count, deleted]).toEqual([2, 2, 2]);
    });

    test('Test in Production: day counters, failure samples, health and failure reads', async () => {
        fake.seed('dev_tipHealth', [{ id: 'h1', day: '20261020' }, { id: 'h2', day: '20261021' }]);
        fake.seed('dev_tipFailures', [{ id: 'f1', at: 1 }, { id: 'f2', at: 2 }]);
        const out = await FirebaseService.writeTip({
            uid: 'u1', deviceId: 'dev1', delta: { 20261021: { '1.0.0': { BillSave: { ok: 1 } } } },
            failures: [{ seq: 1, scenario: 'BillSave', at: NOW }, { seq: 'bad' }], appVersion: '1.0.0', buildId: 'b', platform: 'web'
        });
        const health = await FirebaseService.loadTipHealth({ sinceDay: '20261020', untilDay: '20261021', limit: 5 });
        const healthOpen = await FirebaseService.loadTipHealth({ sinceDay: '20261021' });
        const failures = await FirebaseService.loadTipFailures({ limit: 1 });
        pin('service.tip', rec.log);
        expect(out.retryFailures).toEqual([]);
        expect(health).toHaveLength(3);
        expect(healthOpen).toHaveLength(2);
        expect(failures).toHaveLength(1);
    });

    test('notifications: send, rate change and item edit fan-out (owner reads the profiles), list, page, mark read, clean up', async () => {
        fake.seed('dev_users', [
            { id: 'u1', name: 'Owner', role: 'owner', status: 'active' },
            { id: 'u2', name: 'Man', role: 'manager', status: 'active' },
            { id: 'u3', name: 'Ram', role: 'staff', status: 'active' }
        ]);
        fake.seed('dev_notifications', [
            { id: 'n1', userId: 'u1', read: false, timestamp: NOW - 2 * DAY },
            { id: 'n2', userId: 'u1', read: true, timestamp: NOW - 40 * DAY },
            { id: 'n3', userId: 'u2', read: false, timestamp: NOW - DAY }
        ]);
        AppState.userRole = 'owner';
        // The owner's fan-out also syncs the team directory in the background: done here
        // first, so the pinned log holds only the fan-out (the sync has its own flow below).
        await FirebaseService.loadUsers();
        await settle();
        rec.clear();
        // A different number than the cutoff, so the log shows the converted value reaches the query
        const fromMillis = jest.fn(ms => ms - 1);
        global.firebase.firestore.Timestamp = { fromMillis };
        const sent = await FirebaseService.sendNotification('evt-1', ['u2', 'u3', 'u1'], { type: 'x' });
        await FirebaseService.notifyRateChanges({ id: 'i1', name: 'Rice' }, [{ rateType: 'wholesale', oldRate: 1, newRate: 2 }, { rateType: 'sale', oldRate: 3, newRate: 4 }], 'evt-r');
        await FirebaseService.notifyRateChange({ id: 'i1', name: 'Rice' }, 'purchase', 5, 6);
        await FirebaseService.notifyItemEdit({ id: 'i1', name: 'Rice' }, 'updated', ['name']);
        await settle();
        const seen = [];
        const stop = FirebaseService.listenUnreadNotifications('u1', 10, (list, changes) => seen.push([list.length, changes.length]), () => {});
        await settle();
        stop();
        const page = await FirebaseService.loadNotificationsPage('u1', { limit: 1 });
        const page2 = await FirebaseService.loadNotificationsPage('u1', { limit: 1, after: page.cursor });
        await FirebaseService.markNotificationsRead(['n1', 'n1', '']);
        await FirebaseService.markNotificationsRead([]);
        const all = await FirebaseService.markAllNotificationsRead('u2', { pageSize: 1, maxPages: 3 });
        const none = await FirebaseService.markAllNotificationsRead('');
        const old = await FirebaseService.deleteOldNotifications('u1', NOW - 30 * DAY, 10);
        pin('service.notifications', rec.log);
        expect(sent).toBe(2);
        expect(seen.length).toBeGreaterThan(0);
        expect(page.items).toHaveLength(1);
        expect(page2.items).toHaveLength(1);
        expect([all, none, old]).toEqual([3, 0, 1]);
        expect(fromMillis).toHaveBeenCalledWith(NOW - 30 * DAY);
    });

    test('owner fan-out: the profiles are read and the team directory brought in line (no recipient left)', async () => {
        fake.seed('dev_users', [
            { id: 'u1', name: 'Owner', role: 'owner', status: 'active' },
            { id: 'u2', name: 'Man', role: 'manager', status: 'active' }
        ]);
        AppState.userRole = 'owner';
        await FirebaseService.notifyItemEdit({ id: 'i1', name: 'Rice' }, 'updated', ['name']);
        await settle();
        pin('service.notifications-owner-sync', rec.log);
        expect(fake.raw('dev_settings').get('team').people).toMatchObject({ u1: { role: 'owner' }, u2: { role: 'manager' } });
    });

    test('notifications as a manager: recipients from the team directory, no profile read', async () => {
        fake.seed('dev_settings', [{ id: 'team', people: { u1: { name: 'Owner', role: 'owner' }, u2: { name: 'Man', role: 'manager' } } }]);
        AppState.userRole = 'manager';
        AppState.currentUser = { uid: 'u2' };
        await FirebaseService.notifyItemEdit({ id: 'i1', name: 'Rice' }, 'added');
        pin('service.notifications-manager', rec.log);
    });

    test('cash sessions: all, a page, the few needed, one day, between days, open (new and joined), update', async () => {
        fake.seed('dev_cashManagement', [
            { id: 's18', date: '2026-10-18', signedOut: true, counted: true },
            { id: 's19', date: '2026-10-19', signedOut: false },
            { id: 's20', date: '2026-10-20', signedOut: true, counted: false }
        ]);
        const all = await FirebaseService.loadCashSessions();
        const page = await FirebaseService.loadCashSessionsPage(2);
        const page2 = await FirebaseService.loadCashSessionsPage(2, page.last);
        const needed = await FirebaseService.loadCashSessionsNeeded('2026-10-21');
        const day = await FirebaseService.loadCashSessionsForDate('2026-10-20');
        const between = await FirebaseService.loadCashSessionsBetween('2026-10-19', '2026-10-20');
        const opened = await FirebaseService.openCashSession({ date: '2026-10-21', openingBalance: 500 });
        const joined = await FirebaseService.openCashSession({ date: '2026-10-21', openingBalance: 900 });
        const legacy = await FirebaseService.openCashSession({ date: '2026-10-20', openingBalance: 1 });
        await FirebaseService.updateCashSession({ id: 's20', date: '2026-10-20', counted: true });
        await expect(FirebaseService.updateCashSession({ date: 'x' })).rejects.toThrow('Session ID is required');
        pin('service.cashSessions', rec.log);
        expect(all.map(s => s.id)).toEqual(['s20', 's19', 's18']);
        expect([page.sessions.length, page.more, page2.sessions.length]).toEqual([2, true, 1]);
        expect(needed.map(s => s.id)).toEqual(['s18', 's19', 's20']);
        expect([day.length, between.length]).toEqual([1, 2]);
        expect([opened.joined, joined.joined, legacy.joined]).toEqual([false, true, true]);
        expect(joined.session.openingBalance).toBe(500);
    });

    test('audit log since a time (pages) and anomalies (server, cache only, write)', async () => {
        fake.seed('dev_auditLogs', [
            { id: 'a1', timestamp: NOW - 1 }, { id: 'a2', timestamp: NOW - 2 }, { id: 'a3', timestamp: NOW - 3 }, { id: 'a0', timestamp: 5 }
        ]);
        fake.seed('dev_anomalies', [{ id: 'x1', dayKey: '2026-10-20' }, { id: 'x2', dayKey: '2026-10-21' }]);
        const logs = await FirebaseService.loadAuditLogsSince(NOW - 1000, 3, 2);
        const p1 = await FirebaseService.loadAnomalies('2026-10-01', '2026-10-31', { limit: 1 });
        const p2 = await FirebaseService.loadAnomalies('2026-10-01', '2026-10-31', { limit: 1, after: p1.last, server: true });
        const cached = await FirebaseService.loadAnomalies('2026-10-01', '2026-10-31', { cacheOnly: true });
        await FirebaseService.saveAnomalies([{ id: 'x3', data: { dayKey: '2026-10-21', kind: 'k' } }]);
        await FirebaseService.saveAnomalies([]);
        pin('service.auditAnomalies', rec.log);
        expect(logs.map(l => l.id)).toEqual(['a1', 'a2', 'a3']);
        expect([p1.docs[0].id, p1.more, p2.docs[0].id]).toEqual(['x2', true, 'x1']);
        expect(cached.docs).toHaveLength(2);
    });

    test('user profiles: list (owner: the team directory follows), people, audit people (cached), role changes, reject, restore, remove', async () => {
        fake.seed('dev_users', [
            { id: 'u1', name: 'Owner', role: 'owner', status: 'active', createdAt: 2 },
            { id: 'u4', name: 'New', role: 'staff', status: 'pending', createdAt: 5 }
        ]);
        AppState.userRole = 'owner';
        const users = await FirebaseService.loadUsers();
        await settle();
        const people = await FirebaseService.loadPeople();
        const audit1 = await FirebaseService.loadAuditPeople();
        const audit2 = await FirebaseService.loadAuditPeople();
        await FirebaseService.notifyItemEdit({ id: 'i1', name: 'Rice' }, 'updated');
        await settle();
        await FirebaseService.updateUser('u4', { role: 'manager', status: 'active' });
        const wrote = await FirebaseService.ensureTeamDirectory();
        const again = await FirebaseService.ensureTeamDirectory();
        const audit3 = await FirebaseService.loadAuditPeople();
        await FirebaseService.notifyItemEdit({ id: 'i1', name: 'Rice' }, 'updated');
        await settle();
        const afterChanges = [];
        for (const change of [
            () => FirebaseService.rejectUserProfile('u4', 'u1'),
            () => FirebaseService.restoreUserProfile('u4'),
            () => FirebaseService.disableUserProfile('u4', 'u1')
        ]) {
            await change();
            afterChanges.push(await FirebaseService.loadAuditPeople());
            await FirebaseService.notifyItemEdit({ id: 'i1', name: 'Rice' }, 'updated');
            await settle();
        }
        FirebaseService.forgetPeopleCaches();
        AppState.userRole = 'manager';
        const managerPeople = await FirebaseService.loadPeople();
        pin('service.users', rec.log);
        expect(users.map(u => u.id)).toEqual(['u4', 'u1']);
        expect(people).toHaveLength(2);
        expect(audit2).toBe(audit1);
        expect(audit3).not.toBe(audit1);
        [audit3, ...afterChanges].reduce((prev, next) => { expect(next).not.toBe(prev); return next; });
        expect(afterChanges.map(list => list.find(u => u.id === 'u4').status)).toEqual(['rejected', 'pending', 'disabled']);
        expect(audit3.find(u => u.id === 'u4')).toMatchObject({ role: 'manager' });
        expect(rec.log.filter(c => c[0] === 'collection' && c[1] === 'dev_users').length).toBeGreaterThanOrEqual(5);
        expect(fake.raw('dev_users').get('u4')).toMatchObject({ status: 'disabled', disabledBy: 'u1' });
        expect([wrote, again]).toEqual([true, false]);
        expect(Array.isArray(managerPeople)).toBe(true);
        expect(FirebaseService.serverTimestamp()).toBe('SERVER_TIME');
    });
});
