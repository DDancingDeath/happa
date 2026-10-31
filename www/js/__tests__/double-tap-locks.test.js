/**
 * @fileoverview One tap = one write (#95): a second call of a money button's
 * handler while the first save is still running writes nothing; the button is
 * disabled (aria-busy) until that save ends. Saves that work offline free the
 * button as soon as the write is queued on the phone.
 */
import { ExpensesManager } from '../modules/miscellaneous.js';
import { CashManagementManager } from '../modules/cash-management.js';
import { MoneyManager } from '../modules/money.js';
import { BillingManager, PurchaseManager } from '../modules/billing.js';
import { OutstandingManager } from '../modules/outstanding.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { todayLocalISO } from '../utils/dates.js';
import { t } from '../i18n/index.js';

const flush = () => new Promise(r => setTimeout(r));

/** A write that stays pending until `release()` (or `refuse(error)`). */
function pendingWrite(result) {
    let settle;
    const fn = jest.fn(() => new Promise((resolve, reject) => {
        settle = { resolve: () => resolve(typeof result === 'function' ? result() : result), reject };
    }));
    return { fn, release: () => settle.resolve(), refuse: (e) => settle.reject(e) };
}

function button(attrs) {
    document.body.insertAdjacentHTML('beforeend', `<button data-tap ${attrs}></button>`);
    return document.querySelector('[data-tap]');
}

/**
 * Calls the handler twice in a row (the second call is not stopped by a
 * disabled button, only by the lock) and expects one write.
 * `held`: the button stays busy until the server answers.
 */
async function doubleTap(btn, handler, write, release, { held = true } = {}) {
    const first = handler();
    const second = handler();
    await flush();
    if (held) {
        expect(btn.disabled).toBe(true);
        expect(btn.getAttribute('aria-busy')).toBe('true');
    }
    release();
    await Promise.all([first, second]);
    await flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(false);
    expect(btn.hasAttribute('aria-busy')).toBe(false);
}

const stubDb = (methods) => jest.spyOn(FirebaseService, 'db', 'get').mockReturnValue({
    collection: () => ({ doc: () => methods }),
    runTransaction: methods.runTransaction
});

const goOffline = () => jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);

beforeEach(() => {
    ['showToast', 'hapticFeedback', 'showLoading', 'hideLoading', 'closeModal'].forEach(m => jest.spyOn(UIManager, m).mockImplementation(() => {}));
    jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
    jest.spyOn(AuditService, 'log').mockResolvedValue(undefined);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    AppState.currentUser = { uid: 'u1', email: 'o@x' };
    AppState.userName = 'Owner';
    window.app = {};
    global.firebase = {
        auth: () => ({ currentUser: { uid: 'u1', email: 'o@x' } }),
        firestore: { FieldValue: { arrayUnion: (...v) => ({ arrayUnion: v }) } }
    };
});

afterEach(() => {
    jest.restoreAllMocks();
    document.body.innerHTML = '';
    delete window.app;
    delete global.firebase;
    delete global.db;
    CashManagementManager.todaySession = null;
    CashManagementManager.cachedSessions = null;
});

describe('expenses', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <input id="businessExpenseType" value="Tea"><input id="businessExpensePerson" value="">
            <input id="businessExpenseAmount" value="40"><input id="businessExpenseRemarks" value="">
            <input id="personalExpenseType" value="Bus"><input id="personalExpensePerson" value="">
            <input id="personalExpenseAmount" value="30"><input id="personalExpenseRemarks" value="">`;
        jest.spyOn(ExpensesManager, 'refreshExpenseViews').mockImplementation(() => {});
    });

    test.each([
        ['Save expense', () => ExpensesManager.saveBusinessExpense()],
        ['Print expense', () => ExpensesManager.saveAndPrintPersonal()]
    ])('%s: a double tap saves one expense', async (_name, save) => {
        const write = pendingWrite();
        const start = jest.spyOn(FirebaseService, 'startSaveExpense').mockImplementation(() => ({ record: {}, committed: write.fn() }));
        await doubleTap(button('data-expense-save'), save, start, write.release, { held: false });
    });
});

describe('cash drawer', () => {
    const today = todayLocalISO();
    beforeEach(() => {
        ['calculateTodayTransactions', 'updateUI', 'renderHistory', 'renderHistoryFromCache', 'populateDueBills']
            .forEach(m => jest.spyOn(CashManagementManager, m).mockImplementation(async () => {}));
    });
    const openSession = () => {
        CashManagementManager.todaySession = { id: `cash_${today}`, date: today, openingBalance: 500, signedOut: false, duePayments: [], cashDeposits: [] };
        CashManagementManager.todayTransactions = { cashSales: 0, cashPurchases: 0, businessExpenses: 0, personalExpenses: 0, dueReceived: 0, duePaid: 0, cashDeposits: 0 };
    };

    test('Open: a double tap opens the day once', async () => {
        document.body.innerHTML = '<input id="cashSignInAmount" value="500"><input id="cashSignInNotes">';
        CashManagementManager.cachedSessions = [];
        const write = pendingWrite(() => ({ session: { id: `cash_${today}`, date: today, openingBalance: 500 }, joined: false }));
        jest.spyOn(FirebaseService, 'openCashSession').mockImplementation(write.fn);
        await doubleTap(button('data-cash-save="open"'), () => CashManagementManager.signIn(), write.fn, write.release);
    });

    test('Close: a double tap writes the count once', async () => {
        document.body.innerHTML = '<input id="cashSignOutAmount" value="500"><input id="cashSignOutNotes">';
        openSession();
        const write = pendingWrite();
        stubDb({ update: write.fn });
        await doubleTap(button('data-cash-save="close"'), () => CashManagementManager.signOut(), write.fn, write.release);
        expect(UIManager.showModal).not.toHaveBeenCalled();
    });

    test('Close offline: says it needs internet, writes nothing, keeps the count', async () => {
        document.body.innerHTML = '<input id="cashSignOutAmount" value="500"><input id="cashSignOutNotes">';
        openSession();
        goOffline();
        const update = jest.fn();
        stubDb({ update });
        const btn = button('data-cash-save="close"');
        await CashManagementManager.signOut();
        expect(update).not.toHaveBeenCalled();
        expect(UIManager.showToast).toHaveBeenCalledWith(t('msg.cash.close_needs_internet'), 'warning');
        expect(document.getElementById('cashSignOutAmount').value).toBe('500');
        expect(btn.disabled).toBe(false);
    });

    test('Close waiting long for the server: says so, the button stays busy until it answers', async () => {
        jest.useFakeTimers();
        try {
            document.body.innerHTML = '<input id="cashSignOutAmount" value="500"><input id="cashSignOutNotes">';
            openSession();
            const write = pendingWrite();
            stubDb({ update: write.fn });
            const btn = button('data-cash-save="close"');
            const done = CashManagementManager.signOut();
            jest.advanceTimersByTime(8000);
            expect(UIManager.showToast).toHaveBeenCalledWith(t('msg.cash.close_waiting'), 'warning');
            expect(btn.disabled).toBe(true);
            write.release();
            await done;
            expect(btn.disabled).toBe(false);
            expect(CashManagementManager.todaySession.signedOut).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });

    test('Late count: a double tap runs one transaction', async () => {
        document.body.innerHTML = '<input id="lateCountAmount" value="250">';
        const write = pendingWrite(null);
        stubDb({ runTransaction: write.fn });
        await doubleTap(button('data-cash-save="count"'), () => CashManagementManager.recordLateCount('cash_2026-10-01'), write.fn, write.release);
    });

    const entryForm = (type, party) => `
        <select id="cashTransactionType"><option value="${type}" selected>${type}</option></select>
        <input id="transactionAmount" value="300"><input id="transactionNotes" value="">
        <input id="partyName" value="${party}">
        <select id="dueBillSelect"><option value="__nobill__" selected>-</option></select>`;

    test.each([
        ['deposit', '', 'cashDeposits'],
        ['received', 'Ramesh', 'duePayments']
    ])('#129: a %s typed with paise is saved in whole rupees, half-up', async (type, party, field) => {
        document.body.innerHTML = entryForm(type, party).replace('value="300"', 'value="300.50"');
        openSession();
        const session = CashManagementManager.todaySession;
        stubDb({ update: pendingWrite().fn });
        await CashManagementManager.recordTransaction();
        expect(session[field]).toEqual([expect.objectContaining({ amount: 301 })]);
    });

    test.each([
        ['deposit', ''],
        ['received', 'Ramesh']
    ])('Record (%s): a double tap adds one drawer entry; it is queued, so the button is free again offline', async (type, party) => {
        document.body.innerHTML = entryForm(type, party);
        openSession();
        const write = pendingWrite();
        stubDb({ update: write.fn });
        await doubleTap(button('data-cash-save="entry"'), () => CashManagementManager.recordTransaction(), write.fn, write.release, { held: false });
    });

    test.each([
        ['deposit', '', 'cashDeposits'],
        ['received', 'Ramesh', 'duePayments']
    ])('Record (%s) shows at once; a refused write takes it out of every copy of the session', async (type, party, field) => {
        document.body.innerHTML = entryForm(type, party);
        openSession();
        const session = CashManagementManager.todaySession;
        const write = pendingWrite();
        stubDb({ update: write.fn });
        await CashManagementManager.recordTransaction();
        expect(session[field]).toEqual([expect.objectContaining({ amount: 300 })]);
        // Meanwhile the history was reloaded and a listener replaced today's session object
        const entry = session[field][0];
        CashManagementManager.cachedSessions = [{ ...session, [field]: [entry] }, { id: 'cash_2026-10-01', [field]: [entry] }];
        CashManagementManager.todaySession = { ...session, [field]: [entry] };
        CashManagementManager.renderHistory.mockClear();
        write.refuse(new Error('denied'));
        await flush();
        expect(session[field]).toEqual([]);
        expect(CashManagementManager.todaySession[field]).toEqual([]);
        expect(CashManagementManager.cachedSessions[0][field]).toEqual([]);
        expect(CashManagementManager.cachedSessions[1][field]).toEqual([entry]);
        expect(CashManagementManager.renderHistory).toHaveBeenCalled();
        expect(UIManager.showToast).toHaveBeenLastCalledWith(expect.stringContaining('denied'));
    });
});

describe('Money › Save withdrawal', () => {
    beforeEach(() => {
        document.body.innerHTML = `<div id="moneyWithdrawalForm"></div>
            <input id="moneyWdAmount" value="1000"><input id="moneyWdPerson" value="Owner">
            <input id="moneyWdDate" value="${todayLocalISO()}"><input id="moneyWdPurpose" value="">`;
        jest.spyOn(MoneyManager, 'render').mockImplementation(() => {});
    });

    test('a double tap saves one withdrawal', async () => {
        const write = pendingWrite();
        const start = jest.spyOn(FirebaseService, 'startSaveWithdrawal').mockImplementation(() => ({ record: {}, committed: write.fn() }));
        await doubleTap(button('data-withdrawal-save'), () => MoneyManager.saveWithdrawal(), start, write.release, { held: false });
    });

    test('#129: an amount typed with paise is saved in whole rupees, half-up', async () => {
        document.getElementById('moneyWdAmount').value = '1000.50';
        const start = jest.spyOn(FirebaseService, 'startSaveWithdrawal').mockImplementation(() => ({ record: {}, committed: Promise.resolve() }));
        await MoneyManager.saveWithdrawal();
        expect(start).toHaveBeenCalledWith(expect.objectContaining({ amount: 1001 }));
    });

    test('offline: saved on the phone at once (id made on the phone), form cleared; a refused write says so', async () => {
        goOffline();
        let refuse;
        const set = jest.fn(() => new Promise((_, reject) => { refuse = reject; }));
        const firestore = () => ({ collection: () => ({ doc: () => ({ id: 'wd-local-1', set }) }) });
        global.firebase.firestore = Object.assign(firestore, global.firebase.firestore);
        AppState.withdrawalsHistory = [];
        const btn = button('data-withdrawal-save');
        await MoneyManager.saveWithdrawal();
        expect(set).toHaveBeenCalledWith(expect.objectContaining({ amount: 1000, person: 'Owner', userId: 'u1' }));
        expect(AppState.withdrawalsHistory).toEqual([expect.objectContaining({ id: 'wd-local-1', amount: 1000 })]);
        expect(document.getElementById('moneyWdAmount').value).toBe('');
        expect(btn.disabled).toBe(false);
        expect(UIManager.showToast).toHaveBeenLastCalledWith(t('msg.sync.saved_on_phone'), 'success');
        refuse(new Error('denied'));
        await flush();
        expect(AppState.withdrawalsHistory).toEqual([]);
        expect(UIManager.showToast).toHaveBeenLastCalledWith(t('msg.finance.error_recording_withdrawal'), 'error');
    });
});

describe('Billing › Save draft', () => {
    beforeEach(() => {
        document.body.innerHTML = '<input id="newWeight"><input id="customerName"><input id="manualLaborCharges" value="0"><input id="billComments">';
        BillingManager.currentMode = 'purchase';
        PurchaseManager.setWeights([40]);
        jest.spyOn(BillingManager, 'updateDraftCount').mockResolvedValue(undefined);
    });
    afterEach(() => {
        PurchaseManager.setWeights([]);
        PurchaseManager.setBillItems([]);
    });

    test('a double tap saves one draft', async () => {
        jest.spyOn(BillingManager, 'clearBill').mockImplementation(() => {});
        const write = pendingWrite();
        global.db = { collection: () => ({ doc: () => ({ set: write.fn }) }) };
        await doubleTap(button('id="saveDraftBtn"'), () => BillingManager.saveDraft(), write.fn, write.release, { held: false });
    });

    test('offline: the bill is cleared at once; if the server refuses the draft, the bill comes back', async () => {
        goOffline();
        jest.spyOn(BillingManager, 'clearBill').mockImplementation(() => {
            PurchaseManager.setWeights([]);
            PurchaseManager.setBillItems([]);
        });
        const applied = jest.spyOn(BillingManager, 'applyDraft').mockImplementation((d) => PurchaseManager.setWeights(d.weights));
        const write = pendingWrite();
        global.db = { collection: () => ({ doc: () => ({ set: write.fn }) }) };
        await BillingManager.saveDraft();
        expect(PurchaseManager.getWeights()).toEqual([]);
        expect(UIManager.showToast).toHaveBeenLastCalledWith(t('msg.sync.saved_on_phone'));
        write.refuse(new Error('denied'));
        await flush();
        expect(applied).toHaveBeenCalledWith(expect.objectContaining({ mode: 'purchase', weights: [40] }));
        expect(PurchaseManager.getWeights()).toEqual([40]);
        expect(UIManager.showToast).toHaveBeenLastCalledWith(t('msg.billing.failed_save_draft'), 'error');
    });
});

test('Outstanding › Mark as cleared (write-off): a double tap writes it off once; Record waits meanwhile', async () => {
    document.body.innerHTML = `<button data-record-payment></button>
        <input type="radio" name="clearMethod" value="writeOff" checked><textarea id="clearReason">left town</textarea>`;
    AppState.retailSalesHistory = [{ id: 'r1', billNumber: 'S1', total: 500, payment: { cash: 0, online: 0, due: 500 } }];
    jest.spyOn(UIManager, 'showModalWithHtml').mockResolvedValue(true);
    jest.spyOn(OutstandingManager, 'refreshAfterPayment').mockImplementation(() => {});
    const write = pendingWrite({ payment: { due: 0, writtenOff: 500 }, cleared: true });
    jest.spyOn(OutstandingManager, 'applyWriteOffTransaction').mockImplementation(write.fn);
    const record = document.querySelector('[data-record-payment]');
    try {
        const btn = button('data-mark-cleared');
        const first = OutstandingManager.markAsCleared('r1', 'retail');
        const second = OutstandingManager.markAsCleared('r1', 'retail');
        await flush();
        expect(btn.disabled).toBe(true);
        expect(record.disabled).toBe(true);
        write.release();
        expect(await Promise.all([first, second])).toEqual([true, false]);
        expect(write.fn).toHaveBeenCalledTimes(1);
        expect(btn.disabled).toBe(false);
        expect(record.disabled).toBe(false);
    } finally {
        AppState.retailSalesHistory = [];
    }
});
