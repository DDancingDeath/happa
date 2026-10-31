/**
 * @fileoverview One tap = one write (#95): a double tap on a money button while
 * the first save is still running writes once; the button is disabled
 * (aria-busy) until that save ends.
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

const flush = () => new Promise(r => setTimeout(r));

/** A write that stays pending until `release()`. */
function pendingWrite(result) {
    let release;
    const fn = jest.fn(() => new Promise(r => { release = () => r(typeof result === 'function' ? result() : result); }));
    return { fn, release: () => release() };
}

function button(attrs, onClick) {
    document.body.insertAdjacentHTML('beforeend', `<button data-tap ${attrs}></button>`);
    const btn = document.querySelector('[data-tap]');
    btn.addEventListener('click', () => { onClick(); });
    return btn;
}

async function doubleTap(btn, write, release, { held = true } = {}) {
    btn.click();
    btn.click();
    await flush();
    if (held) {
        expect(btn.disabled).toBe(true);
        expect(btn.getAttribute('aria-busy')).toBe('true');
    }
    release();
    await flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(false);
    expect(btn.hasAttribute('aria-busy')).toBe(false);
}

const stubDb = (methods) => jest.spyOn(FirebaseService, 'db', 'get').mockReturnValue({
    collection: () => ({ doc: () => methods }),
    runTransaction: methods.runTransaction
});

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
        // Saved offline-first: the form is free again once the write is queued
        await doubleTap(button('data-expense-save', save), start, write.release, { held: false });
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
        await doubleTap(button('data-cash-save="open"', () => CashManagementManager.signIn()), write.fn, write.release);
    });

    test('Close day: a double tap writes the count once', async () => {
        document.body.innerHTML = '<input id="cashSignOutAmount" value="500"><input id="cashSignOutNotes">';
        openSession();
        const write = pendingWrite();
        stubDb({ update: write.fn });
        await doubleTap(button('data-cash-save="close"', () => CashManagementManager.signOut()), write.fn, write.release);
        expect(UIManager.showModal).not.toHaveBeenCalled();
    });

    test('Late count: a double tap runs one transaction', async () => {
        document.body.innerHTML = '<input id="lateCountAmount" value="250">';
        const write = pendingWrite(null);
        stubDb({ runTransaction: write.fn });
        await doubleTap(button('data-cash-save="count"', () => CashManagementManager.recordLateCount('cash_2026-10-01')), write.fn, write.release);
    });

    test.each([
        ['deposit', ''],
        ['received', 'Ramesh']
    ])('Record (%s): a double tap adds one drawer entry; it is queued, so the button is free again offline', async (type, party) => {
        document.body.innerHTML = `
            <select id="cashTransactionType"><option value="${type}" selected>${type}</option></select>
            <input id="transactionAmount" value="300"><input id="transactionNotes" value="">
            <input id="partyName" value="${party}">
            <select id="dueBillSelect"><option value="__nobill__" selected>-</option></select>`;
        openSession();
        const write = pendingWrite();
        stubDb({ update: write.fn });
        await doubleTap(button('data-cash-save="entry"', () => CashManagementManager.recordTransaction()), write.fn, write.release, { held: false });
    });

    test('a deposit shows at once; a refused write takes it out again', async () => {
        document.body.innerHTML = `
            <select id="cashTransactionType"><option value="deposit" selected>deposit</option></select>
            <input id="transactionAmount" value="300"><input id="transactionNotes" value="">`;
        openSession();
        let refuse;
        stubDb({ update: jest.fn(() => new Promise((_, reject) => { refuse = reject; })) });
        await CashManagementManager.recordTransaction();
        expect(CashManagementManager.todaySession.cashDeposits).toEqual([expect.objectContaining({ amount: 300 })]);
        refuse(new Error('denied'));
        await flush();
        expect(CashManagementManager.todaySession.cashDeposits).toEqual([]);
        expect(UIManager.showToast).toHaveBeenLastCalledWith(expect.stringContaining('denied'));
    });
});

test('Money › Save withdrawal: a double tap saves one withdrawal', async () => {
    document.body.innerHTML = `<div id="moneyWithdrawalForm"></div>
        <input id="moneyWdAmount" value="1000"><input id="moneyWdPerson" value="Owner">
        <input id="moneyWdDate" value="${todayLocalISO()}"><input id="moneyWdPurpose" value="">`;
    jest.spyOn(MoneyManager, 'render').mockImplementation(() => {});
    const write = pendingWrite({ id: 'w1' });
    jest.spyOn(FirebaseService, 'saveWithdrawal').mockImplementation(write.fn);
    await doubleTap(button('data-withdrawal-save', () => MoneyManager.saveWithdrawal()), write.fn, write.release);
});

test('Billing › Save draft: a double tap saves one draft', async () => {
    document.body.innerHTML = '<input id="newWeight"><input id="customerName"><input id="manualLaborCharges" value="0"><input id="billComments">';
    BillingManager.currentMode = 'purchase';
    PurchaseManager.setWeights([40]);
    jest.spyOn(BillingManager, 'updateDraftCount').mockResolvedValue(undefined);
    jest.spyOn(BillingManager, 'clearBill').mockImplementation(() => {});
    const write = pendingWrite();
    global.db = { collection: () => ({ doc: () => ({ set: write.fn }) }) };
    try {
        await doubleTap(button('id="saveDraftBtn"', () => BillingManager.saveDraft()), write.fn, write.release);
    } finally {
        PurchaseManager.setWeights([]);
    }
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
        const btn = button('data-mark-cleared', () => OutstandingManager.markAsCleared('r1', 'retail'));
        btn.click();
        btn.click();
        await flush();
        expect(btn.disabled).toBe(true);
        expect(record.disabled).toBe(true);
        write.release();
        await flush();
        expect(write.fn).toHaveBeenCalledTimes(1);
        expect(btn.disabled).toBe(false);
        expect(record.disabled).toBe(false);
    } finally {
        AppState.retailSalesHistory = [];
    }
});
