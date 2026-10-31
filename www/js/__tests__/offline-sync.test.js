/**
 * @fileoverview Offline / waiting-to-sync pill (#70) and "Save failed — storage
 * full" instead of a false "Saved" (#153).
 */
import { createSyncStatus, syncStatusText, PENDING_SHOW_DELAY_MS, SYNCED_SHOW_MS } from '../ui/sync-status.js';
import { isStorageFullError, safeSetItem } from '../utils/storage-full.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { PurchaseManager } from '../modules/purchase.js';
import { SettingsManager } from '../modules/settings.js';
import { ExpensesManager } from '../modules/miscellaneous.js';
import { AuditService } from '../services/audit.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { AppState } from '../utils/state.js';
import { t, setLang } from '../i18n/index.js';
import { isQuotaExhaustedError } from '../utils/quota-guard.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';
import { sampleItems } from '../../../tests/fixtures/sample-items.js';

const quotaDom = () => new DOMException("Setting the value of 'settings' exceeded the quota.", 'QuotaExceededError');
// What Firestore 10.7.1 rejects a write with when IndexedDB is full
const persistFull = () => Object.assign(
    new Error("Failed to persist write: IndexedDbTransactionError: IndexedDB transaction 'Locally write mutations' failed: QuotaExceededError: The quota has been exceeded."),
    { code: 'unavailable', name: 'FirebaseError' }
);
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('sync pill (#70)', () => {
    let online;
    let db;
    let status;
    const pill = () => document.getElementById('syncStatus');
    const go = (on) => { online = on; window.dispatchEvent(new Event(on ? 'online' : 'offline')); };

    beforeEach(() => {
        jest.useFakeTimers();
        document.body.innerHTML = '';
        online = true;
        jest.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online);
        db = { waitForPendingWrites: jest.fn(() => Promise.resolve()) };
        status = createSyncStatus({ win: window, doc: document, getDb: () => db });
        status.start();
    });
    afterEach(() => {
        status.stop();
        setLang('en');
        jest.useRealTimers();
    });

    test('hidden while online with nothing waiting', () => {
        expect(pill().hidden).toBe(true);
    });

    test('offline → "Offline"; back online → "Synced" once the SDK has nothing queued, then hides', async () => {
        go(false);
        expect(pill().hidden).toBe(false);
        expect(pill().textContent).toBe('Offline');
        expect(pill().dataset.state).toBe('offline');

        let flushed;
        db.waitForPendingWrites.mockImplementation(() => new Promise(r => { flushed = r; }));
        go(true);
        await flush();
        expect(db.waitForPendingWrites).toHaveBeenCalledTimes(1);
        expect(pill().hidden).toBe(true);
        flushed();
        await flush();
        expect(pill().textContent).toBe('Synced');
        expect(pill().dataset.state).toBe('synced');
        jest.advanceTimersByTime(SYNCED_SHOW_MS);
        expect(pill().hidden).toBe(true);
    });

    test('going offline again before the queue drained shows no stale "Synced"', async () => {
        go(false);
        let flushed;
        db.waitForPendingWrites.mockImplementation(() => new Promise(r => { flushed = r; }));
        go(true);
        await flush();
        go(false);
        flushed();
        await flush();
        expect(pill().textContent).toBe('Offline');
    });

    test('counts changes waiting to sync: own writes and listener docs, each document once', async () => {
        go(false);
        let ack;
        status.trackWrite('purchases/p1', new Promise(r => { ack = r; }));
        expect(pill().textContent).toBe('Offline · 1 change waiting to sync');

        const pendingDoc = (path) => ({ ref: { path }, metadata: { hasPendingWrites: true } });
        status.noteSnapshot('purchases', {
            metadata: { hasPendingWrites: true },
            docs: [pendingDoc('purchases/p1'), pendingDoc('purchases/p2'), { ref: { path: 'purchases/p0' }, metadata: { hasPendingWrites: false } }]
        });
        status.noteSnapshot('expenses', { metadata: { hasPendingWrites: true }, docs: [pendingDoc('expenses/e1')] });
        expect(status.pendingCount()).toBe(3);
        expect(pill().textContent).toBe('Offline · 3 changes waiting to sync');

        go(true);
        expect(pill().textContent).toBe('3 changes waiting to sync');
        expect(pill().dataset.state).toBe('pending');

        ack();
        await flush();
        status.noteSnapshot('purchases', { metadata: { hasPendingWrites: false }, docs: [] });
        expect(pill().textContent).toBe('1 change waiting to sync');
        status.noteSnapshot('expenses', { metadata: { hasPendingWrites: false }, docs: [] });
        await flush();
        expect(pill().textContent).toBe('Synced');
    });

    test('an online save acknowledged quickly never flashes the pill', async () => {
        let ack;
        status.trackWrite('purchases/p1', new Promise(r => { ack = r; }));
        expect(pill().hidden).toBe(true);
        jest.advanceTimersByTime(PENDING_SHOW_DELAY_MS - 1);
        ack();
        await flush();
        jest.advanceTimersByTime(10);
        expect(pill().hidden).toBe(true);
        expect(db.waitForPendingWrites).not.toHaveBeenCalled();
    });

    test('a slow online save shows as waiting after the delay; a refused write stops counting', async () => {
        let refuse;
        status.trackWrite('purchases/p1', new Promise((_, reject) => { refuse = reject; }));
        jest.advanceTimersByTime(PENDING_SHOW_DELAY_MS);
        expect(pill().textContent).toBe('1 change waiting to sync');
        refuse(persistFull());
        await flush();
        expect(status.pendingCount()).toBe(0);
    });

    test('follows the app language (one language at a time)', () => {
        go(false);
        status.trackWrite('purchases/p1', new Promise(() => {}));
        status.trackWrite('purchases/p2', new Promise(() => {}));
        setLang('hi');
        expect(pill().textContent).toBe(`${t('ui.sync.offline', null, 'hi')} · ${t('ui.sync.waiting', { count: 2 }, 'hi')}`);
        expect(pill().textContent).not.toMatch(/[A-Za-z]/);
    });

    test('syncStatusText', () => {
        expect(syncStatusText({ online: true, pending: 0 })).toBe('');
        expect(syncStatusText({ online: true, pending: 0, synced: true })).toBe('Synced');
        expect(syncStatusText({ online: false, pending: 0 })).toBe('Offline');
        expect(syncStatusText({ online: true, pending: 4 })).toBe('4 changes waiting to sync');
    });
});

describe('isStorageFullError (#153)', () => {
    test.each([
        [quotaDom()],
        [persistFull()],
        [{ name: 'NS_ERROR_DOM_QUOTA_REACHED' }],
        [{ code: 22, name: 'Error' }]
    ])('detects %p', (err) => expect(isStorageFullError(err)).toBe(true));

    test.each([
        [null],
        [{ code: 'unavailable', message: 'Failed to get document because the client is offline.' }],
        [{ code: 'resource-exhausted', message: 'Quota exceeded.' }],
        [{ code: 'permission-denied' }]
    ])('ignores %p', (err) => expect(isStorageFullError(err)).toBe(false));

    test("the Firestore daily limit and a full phone are told apart", () => {
        expect(isQuotaExhaustedError(persistFull())).toBe(false);
        expect(isStorageFullError({ code: 'resource-exhausted', message: 'Quota exceeded.' })).toBe(false);
    });

    test('safeSetItem reports a full localStorage instead of throwing', () => {
        jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw quotaDom(); });
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(safeSetItem('k', 'v')).toEqual({ ok: false, full: true });
    });
});

const PURCHASE_DOM = `
  <select id="billItem"><option value=""></option><option value="0">Rice</option><option value="1">Wheat</option></select>
  <input id="billRate"><input id="newWeight"><div id="weightsList"></div>
  <table id="billTable"><tbody></tbody></table><div id="weightBreakdownSection"></div>
  <span id="billTotal">0</span><span id="totalPacketsInBill">0</span>
  <input type="checkbox" id="autoLaborCharge" checked><input id="manualLaborCharges" value="0"><span id="laborCalculation"></span>
  <span id="amountPayable">0</span><span id="totalPayment">0</span>
  <input id="onlinePayment"><input id="cashPayment"><input id="dueAmount"><strong id="purchaseSplitRemaining"></strong>
  <input type="checkbox" id="onlineCheckbox"><input type="checkbox" id="cashCheckbox"><input type="checkbox" id="dueCheckbox">
  <input id="customerName"><input id="billComments"><input type="checkbox" id="billPrintComments">
  <button id="saveBillBtn"></button><button id="printBillBtn"></button><div id="toast"></div>`;

describe('a save the phone refused is never reported as saved (#153)', () => {
    let fake;
    let toast;
    let online;

    beforeEach(() => {
        fake = createFakeFirestore();
        global.firebase = fake.firebase;
        FirebaseService.cleanup();
        online = false;
        jest.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online);
        toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(Helpers, 'generateBillNumber').mockImplementation(async (prefix) => `${prefix}20261031-001`);
        jest.spyOn(AuditService, 'log').mockResolvedValue(undefined);
        AppState.items = sampleItems();
        AppState.stock = {};
        AppState.settings = { laborRate: 6, heavyWeightThreshold: 30 };
        AppState.currentUser = { uid: 'u1', email: 'o@x' };
        AppState.userName = 'Owner';
        AppState.userRole = 'owner';
        document.body.innerHTML = PURCHASE_DOM;
    });

    afterEach(() => {
        jest.restoreAllMocks();
        FirebaseService.cleanup();
        PurchaseManager.setBillItems([]);
        PurchaseManager.setWeights([]);
        PurchaseManager.setPendingBill(null);
    });

    const toastTexts = () => toast.mock.calls.map(c => c[0]);

    async function fillBill() {
        document.getElementById('billItem').value = '0';
        document.getElementById('billRate').value = '20';
        PurchaseManager.setWeights([50]);
        await PurchaseManager.addToBill(false);
        document.getElementById('cashPayment').value = String(PurchaseManager.computeTotals().grandTotal);
    }

    /** Makes this phone refuse the next set() on `collName` (IndexedDB full). */
    function refuseNextSet(collName) {
        const collection = fake.db.collection;
        fake.db.collection = (name) => {
            const c = collection(name);
            if (name !== collName) return c;
            return { ...c, doc: (id) => ({ ...c.doc(id), set: () => Promise.reject(persistFull()) }) };
        };
    }

    test('offline bill save, phone storage full: "Save failed — storage full", not "Saved"', async () => {
        await fillBill();
        refuseNextSet('purchases');
        await expect(PurchaseManager.saveBillToHistory()).rejects.toThrow(/QuotaExceededError/);
        expect(toastTexts()).toContain(t('msg.sync.storage_full'));
        expect(toastTexts()).not.toContain(t('msg.purchase.bill_saved_successfully'));
        expect(toastTexts()).not.toContain(t('msg.sync.saved_on_phone'));
        expect(PurchaseManager.getBillItems()).toHaveLength(1);
    });

    test('offline bill stored on the phone: "Saved on this phone, will sync"', async () => {
        await fillBill();
        const write = jest.fn(() => new Promise(() => {}));
        const collection = fake.db.collection;
        fake.db.collection = (name) => {
            const c = collection(name);
            return name === 'purchases' ? { ...c, doc: (id) => ({ ...c.doc(id), set: write }) } : c;
        };
        const bill = await PurchaseManager.saveBillToHistory();
        expect(write).toHaveBeenCalledTimes(1);
        expect(FirebaseService.savedOnPhoneOnly(bill)).toBe(true);
        expect(toastTexts()).toContain(t('msg.sync.saved_on_phone'));
        expect(toastTexts()).not.toContain(t('msg.purchase.bill_saved_successfully'));
    });

    test('online bill acknowledged by the server: "Bill saved successfully!"', async () => {
        online = true;
        await fillBill();
        const bill = await PurchaseManager.saveBillToHistory();
        expect(FirebaseService.savedOnPhoneOnly(bill)).toBe(false);
        expect(toastTexts()).toContain(t('msg.purchase.bill_saved_successfully'));
    });

    test('expense refused by the phone: storage-full toast, no "saved", form kept', async () => {
        document.body.innerHTML = `<input id="businessExpenseType" value="Tea"><input id="businessExpensePerson" value="">
            <input id="businessExpenseAmount" value="50"><input id="businessExpenseRemarks" value=""><div id="toast"></div>`;
        jest.spyOn(UIManager, 'withLoading').mockImplementation(async (fn) => fn());
        jest.spyOn(ExpensesManager, 'refreshExpenseViews').mockImplementation(() => {});
        AppState.expensesHistory = [];
        refuseNextSet('expenses');
        await ExpensesManager.saveBusinessExpense();
        await flush();
        expect(toastTexts()).toContain(t('msg.sync.storage_full'));
        expect(toastTexts()).not.toContain(t('msg.expenses.business_expense_saved'));
        expect(document.getElementById('businessExpenseAmount').value).toBe('50');
        expect(AppState.expensesHistory).toHaveLength(0);
    });

    test('settings with localStorage full: storage-full toast instead of "Settings saved"', () => {
        document.body.innerHTML = '<input id="settingUpiId" value="shop@upi"><div id="toast"></div>';
        jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw quotaDom(); });
        SettingsManager.saveUpi();
        expect(toastTexts()).toEqual([t('msg.sync.storage_full')]);
    });

    describe('a slow local store (review of #182)', () => {
        /** Holds `collName` writes and this phone's local-store confirmation until the test releases them. */
        function holdWrites(collName) {
            let storeLocally;
            const barrier = new Promise(r => { storeLocally = () => r({ exists: false, metadata: { fromCache: true } }); });
            let refuse;
            const write = jest.fn(() => new Promise((_, reject) => { refuse = reject; }));
            const collection = fake.db.collection;
            fake.db.collection = (name) => {
                const c = collection(name);
                if (name === 'items') {
                    return { ...c, doc: (id) => ({ ...c.doc(id), get: (opts) => (opts?.source === 'cache' ? barrier : c.doc(id).get(opts)) }) };
                }
                return name === collName ? { ...c, doc: (id) => ({ ...c.doc(id), set: write }) } : c;
            };
            return { write, storeLocally: () => storeLocally(), refuse: (e) => refuse(e) };
        }
        const saved = () => [t('msg.purchase.bill_saved_successfully'), t('msg.sync.saved_on_phone')];

        afterEach(() => jest.useRealTimers());

        test('offline: "Saved on this phone" and a cleared form only once the phone confirms storing it', async () => {
            await fillBill();
            const held = holdWrites('purchases');
            jest.useFakeTimers();
            let result = 'waiting';
            PurchaseManager.saveBillToHistory().then(r => { result = r; });
            await jest.advanceTimersByTimeAsync(3000);
            expect(result).toBe('waiting');
            expect(toastTexts().filter(x => saved().includes(x))).toEqual([]);
            expect(PurchaseManager.getBillItems()).toHaveLength(1);

            held.storeLocally();
            await jest.advanceTimersByTimeAsync(0);
            expect(FirebaseService.savedOnPhoneOnly(result)).toBe(true);
            expect(toastTexts()).toContain(t('msg.sync.saved_on_phone'));
            expect(PurchaseManager.getBillItems()).toHaveLength(0);
        });

        test('offline: refused by the phone after 2 s (past the old 1.5 s release) → storage full, bill kept', async () => {
            await fillBill();
            const held = holdWrites('purchases');
            jest.useFakeTimers();
            let error = null;
            PurchaseManager.saveBillToHistory().catch(e => { error = e; });
            await jest.advanceTimersByTimeAsync(2000);
            held.refuse(persistFull());
            await jest.advanceTimersByTimeAsync(0);
            expect(isStorageFullError(error)).toBe(true);
            expect(toastTexts()).toContain(t('msg.sync.storage_full'));
            expect(toastTexts().filter(x => saved().includes(x))).toEqual([]);
            expect(PurchaseManager.getBillItems()).toHaveLength(1);
        });

        test('offline: still unconfirmed after 10 s → "Saving… check before re-entering", form kept, retry reuses the id', async () => {
            await fillBill();
            const held = holdWrites('purchases');
            jest.useFakeTimers();
            let result = 'waiting';
            PurchaseManager.saveBillToHistory().then(r => { result = r; });
            await jest.advanceTimersByTimeAsync(9999);
            expect(result).toBe('waiting');
            await jest.advanceTimersByTimeAsync(1);
            expect(result).toBeUndefined();
            expect(toastTexts()).toContain(t('msg.sync.save_unconfirmed'));
            expect(toastTexts().filter(x => saved().includes(x))).toEqual([]);
            expect(PurchaseManager.getBillItems()).toHaveLength(1);
            expect(held.write).toHaveBeenCalledTimes(1);
            expect(PurchaseManager.getPendingBill()).toMatchObject({ id: expect.any(String), attempted: true });
        });

        test('expense: the save never hangs; unconfirmed after a few seconds → no "saved", form kept', async () => {
            online = true;
            document.body.innerHTML = `<input id="businessExpenseType" value="Tea"><input id="businessExpensePerson" value="">
                <input id="businessExpenseAmount" value="50"><input id="businessExpenseRemarks" value=""><div id="toast"></div>`;
            jest.spyOn(UIManager, 'withLoading').mockImplementation(async (fn) => fn());
            jest.spyOn(ExpensesManager, 'refreshExpenseViews').mockImplementation(() => {});
            AppState.expensesHistory = [];
            holdWrites('expenses');
            jest.useFakeTimers();
            let done = false;
            ExpensesManager.saveBusinessExpense().then(() => { done = true; });
            await jest.advanceTimersByTimeAsync(4000);
            expect(done).toBe(true);
            expect(toastTexts()).toContain(t('msg.sync.expense_unconfirmed'));
            expect(toastTexts()).not.toContain(t('msg.expenses.business_expense_saved'));
            expect(document.getElementById('businessExpenseAmount').value).toBe('50');
        });
    });
});
