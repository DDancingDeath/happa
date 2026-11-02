/**
 * @fileoverview Cash & outstanding lane: cash-session totals (#69), ₹0 and
 * notes (#66), auto-close (#101), one due-payment path (#98), split payments
 * (#107), Today dues (#95), honest clearing (#104) and expense refresh (#89).
 */
import { CashManagementManager } from '../modules/cash-management.js';
import { OutstandingManager } from '../modules/outstanding.js';
import { WholesaleSalesManager } from '../modules/wholesale-sales.js';
import { ExpensesManager } from '../modules/miscellaneous.js';
import { DayManager } from '../modules/day.js';
import { Helpers } from '../utils/helpers.js';
import { AuditService } from '../services/audit.js';
import { readPayment } from '../utils/money.js';
import { dueEvents, sumDueEvents, saleTimePayment, entryParts, legParts, sameParty } from '../utils/due-payments.js';
import { validateDuePayment } from '../utils/calc/billing.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { sessionTotals, parseCashAmount, isNotCounted, lastCountedSession, autoCloseFields, duplicateSessionDays, sessionForDate, CASH_NEEDS_INTERNET } from '../utils/cash-session.js';
import fs from 'fs';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';
import path from 'path';

const CASH_TEMPLATE = fs.readFileSync(path.join(__dirname, '../../templates/cash-management.html'), 'utf8');
const setVal = (id, v) => { document.getElementById(id).value = String(v); };

let toast;
beforeEach(() => {
    toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    AppState.currentUser = { uid: 'u1', email: 'o@x' };
    AppState.userName = 'Owner';
    AppState.userRole = 'owner';
});
afterEach(() => {
    jest.restoreAllMocks();
    CashManagementManager.todaySession = null;
    CashManagementManager.cachedSessions = null;
    CashManagementManager.olderCursor = null;
    CashManagementManager.hasOlderSessions = false;
});

const TXNS = { cashSales: 1300, cashPurchases: 1500, businessExpenses: 150, personalExpenses: 80, dueReceived: 250, duePaid: 100, cashDeposits: 500 };

describe('#69 session totals', () => {
    test('cash in/out include dues, deposits and both expense kinds', () => {
        expect(sessionTotals({ openingBalance: 2000, transactions: TXNS })).toEqual({
            opening: 2000, cashIn: 500 + 1300 + 250, cashOut: 1500 + 100 + 150 + 80,
            expected: 2000 + 1300 - 1500 - 150 - 80 + 250 - 100 + 500
        });
    });

    test('history detail shows the same totals as the sign-out summary', async () => {
        const session = { id: 's1', date: '2026-10-20', openingBalance: 2000, signedOut: true, closingBalance: 2220, expectedBalance: 2220, difference: 0, transactions: TXNS };
        CashManagementManager.cachedSessions = [session];
        let html = '';
        jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async (h) => { html = h; return true; });
        await CashManagementManager.showSessionDetails('2026-10-20');
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        expect(text).toContain('Total Cash In: ₹4,050');
        expect(text).toContain('Total Cash Out: ₹1,830');
    });

    test('a closed day\'s status card shows what it was closed with, not the live totals (a later void, #99)', () => {
        document.body.innerHTML = CASH_TEMPLATE;
        CashManagementManager.todaySession = {
            id: 's1', date: '2026-10-20', openingBalance: 2000, signedOut: true, counted: true,
            closingBalance: 2000, expectedBalance: 2220, difference: -220, transactions: TXNS
        };
        // a cash expense of ₹150 voided after the close: the live day no longer counts it
        CashManagementManager.todayTransactions = { ...TXNS, businessExpenses: 0 };
        CashManagementManager.updateUI();
        const text = (id) => document.getElementById(id).textContent;
        expect([text('statusOthers'), text('statusExpected'), text('statusActual'), text('statusDiff')])
            .toEqual(['₹330', '₹2,220', '₹2,000', '-₹220.00']);
    });
});

describe('#66 ₹0 opening/closing and session notes', () => {
    let saved;
    beforeEach(() => {
        document.body.innerHTML = CASH_TEMPLATE;
        saved = [];
        jest.spyOn(FirebaseService, 'loadCashSessionsPage').mockResolvedValue({ sessions: [], last: null, more: false });
        jest.spyOn(FirebaseService, 'openCashSession').mockImplementation(async (s) => { saved.push({ ...s }); return { session: { ...s, id: `cash_${s.date}` }, joined: false }; });
        ['salesHistory', 'retailSalesHistory', 'purchaseHistory', 'expensesHistory'].forEach(k => { AppState[k] = []; });
    });

    test.each([['0', 0], ['250.5', 250.5], ['', null], ['   ', null], ['-5', null], ['abc', null], [null, null]])(
        'parseCashAmount(%p) → %p', (raw, expected) => {
            expect(parseCashAmount(raw)).toBe(expected);
        });

    test('opening with ₹0 works and keeps the opening note', async () => {
        setVal('cashSignInAmount', 0);
        setVal('cashSignInNotes', 'Drawer empty, counted by Ramesh');
        await CashManagementManager.signIn();
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ openingBalance: 0, openingNotes: 'Drawer empty, counted by Ramesh', signedOut: false });
        expect(toast).toHaveBeenCalledWith('✓ Cash opened for today');
    });

    test.each([[''], ['-1']])('opening amount %p is rejected', async (value) => {
        setVal('cashSignInAmount', value);
        await CashManagementManager.signIn();
        expect(saved).toHaveLength(0);
        expect(toast).toHaveBeenCalledWith('Please enter a valid opening amount');
    });

    test('closing with ₹0 counted works, computes the difference and keeps the closing note', async () => {
        const update = jest.fn(async () => {});
        jest.spyOn(FirebaseService, 'db', 'get').mockReturnValue({ collection: () => ({ doc: () => ({ update }) }) });
        jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        CashManagementManager.todaySession = { id: 's1', date: '2026-10-21', openingBalance: 300, signedOut: false, duePayments: [] };
        CashManagementManager.todayTransactions = { cashSales: 0, cashPurchases: 0, businessExpenses: 0, personalExpenses: 0, dueReceived: 0, duePaid: 0, cashDeposits: 0 };
        setVal('cashSignOutAmount', 0);
        setVal('cashSignOutNotes', 'Took ₹300 home');
        await CashManagementManager.signOut();
        expect(update).toHaveBeenCalledWith(expect.objectContaining({
            closingBalance: 0, expectedBalance: 300, difference: -300, counted: true, closingNotes: 'Took ₹300 home', signedOut: true
        }));
    });

    test('closing with an empty amount is rejected', async () => {
        CashManagementManager.todaySession = { id: 's1', date: '2026-10-21', openingBalance: 300, signedOut: false };
        setVal('cashSignOutAmount', '');
        await CashManagementManager.signOut();
        expect(toast).toHaveBeenCalledWith('Please enter the actual cash amount');
    });

    test('session detail shows opening and closing notes, escaped', async () => {
        const session = { id: 's1', date: '2026-10-20', openingBalance: 0, signedOut: true, closingBalance: 0, expectedBalance: 0, difference: 0, counted: true,
            openingNotes: '<b>x</b>', closingNotes: 'Took ₹2,000 home', transactions: {} };
        CashManagementManager.cachedSessions = [session];
        let html = '';
        jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async (h) => { html = h; return true; });
        await CashManagementManager.showSessionDetails('2026-10-20');
        expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
        expect(html).toContain('Took ₹2,000 home');
    });
});

describe('#101 forgotten sessions are closed as "not counted"', () => {
    const DAY_TXNS = { cashSales: 1000, cashPurchases: 400, businessExpenses: 0, personalExpenses: 0, dueReceived: 0, duePaid: 0, cashDeposits: 0 };

    test('autoCloseFields keeps the expected balance but records no count and no difference', () => {
        const fields = autoCloseFields({ date: '2026-10-20', openingBalance: 500 }, DAY_TXNS);
        expect(fields).toMatchObject({
            closingBalance: null, difference: null, expectedBalance: 1100, counted: false,
            signedOut: true, autoSignedOut: true, autoClosed: true, transactions: DAY_TXNS
        });
        const end = new Date(fields.signOutTime);
        expect([end.getFullYear(), end.getMonth(), end.getDate(), end.getHours()]).toEqual([2026, 9, 20, 23]);
    });

    test.each([
        [{ signedOut: true, counted: false }, true],
        [{ signedOut: true, autoSignedOut: true, closingBalance: 0 }, true],                  // older app: fake ₹0 count
        [{ signedOut: true, autoSignedOut: true, counted: true, countedLate: true }, false],   // real count added later
        [{ signedOut: true, closingBalance: 0 }, false],                                     // a real ₹0 count
        [{ signedOut: false }, false]
    ])('isNotCounted(%o) → %p', (session, expected) => {
        expect(isNotCounted(session)).toBe(expected);
    });

    test('the last counted closing skips days closed without a count', () => {
        const sessions = [
            { date: '2026-10-21', signedOut: false, openingBalance: 0 },
            { date: '2026-10-20', signedOut: true, counted: false, closingBalance: null },
            { date: '2026-10-19', signedOut: true, autoSignedOut: true, closingBalance: 0 },
            { date: '2026-10-18', signedOut: true, closingBalance: 1234 },
            { date: '2026-10-17', signedOut: true, closingBalance: 999 }
        ];
        expect(lastCountedSession(sessions).date).toBe('2026-10-18');
        expect(lastCountedSession([])).toBeNull();
    });

    describe('in the app', () => {
        let fake;
        beforeEach(() => {
            jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
            jest.setSystemTime(new Date(2026, 9, 21, 10, 0, 0));
            fake = createFakeFirestore();
            jest.spyOn(FirebaseService, 'db', 'get').mockReturnValue(fake.db);
            global.firebase = fake.firebase;
            window.getCollection = (n) => n;
            document.body.innerHTML = CASH_TEMPLATE + '<div id="modalOverlay"><div id="modalTitle"></div><div id="modalMessage"></div><button id="modalCancel"></button></div>';
            AppState.salesHistory = [{ id: 'w1', date: '2026-10-20T11:00:00', total: 1000, payment: { cash: 1000, online: 0, due: 0 } }];
            AppState.retailSalesHistory = [];
            AppState.purchaseHistory = [];
            AppState.expensesHistory = [];
        });
        afterEach(() => {
            jest.useRealTimers();
            delete window.getCollection;
            delete global.firebase;
            AppState.salesHistory = [];
        });

        test('auto-close writes "not counted" (no ₹0 count, no shortage) and history shows it for review', async () => {
            fake.seed('cashManagement', [
                { id: 's20', date: '2026-10-20', openingBalance: 500, signedOut: false, duePayments: [] },
                { id: 's19', date: '2026-10-19', openingBalance: 800, signedOut: true, counted: true, closingBalance: 500, expectedBalance: 500, difference: 0 }
            ]);
            const sessions = await FirebaseService.loadCashSessions();
            await CashManagementManager.autoSignOutPreviousDays(sessions);

            const doc = fake.raw('cashManagement').get('s20');
            expect(doc).toMatchObject({ signedOut: true, counted: false, closingBalance: null, difference: null, expectedBalance: 1500 });

            CashManagementManager.cachedSessions = sessions;
            CashManagementManager.renderHistoryFromCache();
            const list = document.getElementById('cashHistoryList').textContent.replace(/\s+/g, ' ');
            expect(list).toContain('1 day closed without a cash count');
            expect(list).toContain('Not counted');
            expect(list).not.toMatch(/-₹1,500/);
        });

        test('next opening is pre-filled from the last counted closing', () => {
            CashManagementManager.cachedSessions = [
                { id: 's20', date: '2026-10-20', signedOut: true, counted: false, closingBalance: null },
                { id: 's19', date: '2026-10-19', signedOut: true, counted: true, closingBalance: 500 }
            ];
            CashManagementManager.todaySession = null;
            CashManagementManager.updateUI();
            expect(document.getElementById('cashSignInAmount').value).toBe('500');
            expect(document.getElementById('cashSignInSuggestion').textContent).toContain('2026-10-19');
        });

        test('a late count resolves a not-counted day', async () => {
            fake.seed('cashManagement', [{ id: 's20', date: '2026-10-20', openingBalance: 500, signedOut: true, counted: false, closingBalance: null, expectedBalance: 1500, difference: null }]);
            CashManagementManager.cachedSessions = await FirebaseService.loadCashSessions();
            document.body.insertAdjacentHTML('beforeend', '<input id="lateCountAmount" value="1450">');
            await CashManagementManager.recordLateCount('s20');
            expect(fake.raw('cashManagement').get('s20')).toMatchObject({ closingBalance: 1450, difference: -50, counted: true, countedLate: true });
            expect(isNotCounted(CashManagementManager.cachedSessions[0])).toBe(false);
        });
    });
});

/** Shared emulator-free setup: fake Firestore, local clock 21 Oct 2026 10:00. */
function useFakeShop() {
    const ctx = {};
    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        jest.setSystemTime(new Date(2026, 9, 21, 10, 0, 0));
        ctx.fake = createFakeFirestore();
        jest.spyOn(FirebaseService, 'db', 'get').mockReturnValue(ctx.fake.db);
        global.firebase = ctx.fake.firebase;
        window.getCollection = (n) => n;
        jest.spyOn(AuditService, 'log').mockResolvedValue(undefined);
        jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
        ['salesHistory', 'retailSalesHistory', 'purchaseHistory', 'expensesHistory'].forEach(k => { AppState[k] = []; });
    });
    afterEach(() => {
        jest.useRealTimers();
        delete window.getCollection;
        delete global.firebase;
        ['salesHistory', 'retailSalesHistory', 'purchaseHistory', 'expensesHistory'].forEach(k => { AppState[k] = []; });
    });
    return ctx;
}

// Yesterday's credit sale (₹1000, ₹600 due) and today's (₹795, ₹495 due); a supplier bill with ₹1,068 to pay.
const OLD_SALE = { id: 'r0', billNumber: 'S0', customerName: 'Sita', date: '20/10/2026', total: 1000, cashPayment: 400, dueAmount: 600, payment: { cash: 400, online: 0, due: 600, total: 400 } };
const TODAY_SALE = { id: 'r1', billNumber: 'S1', customerName: 'Sita', date: '2026-10-21T09:00:00', total: 795, cashPayment: 300, dueAmount: 495, payment: { cash: 300, online: 0, due: 495, total: 300 } };
const PURCHASE = { id: 'p1', billNumber: 'P1', customerName: 'Ram', date: '2026-10-19T09:00:00', grandTotal: 2568, cashPayment: 1500, dueAmount: 1068, payment: { cash: 1500, online: 0, due: 1068, total: 1500 } };
const OPEN_SESSION = { id: 's21', date: '2026-10-21', openingBalance: 1000, signedOut: false, duePayments: [] };

describe('#98 one due-payment path for Outstanding and Cash', () => {
    const ctx = useFakeShop();
    beforeEach(() => {
        ctx.fake.seed('retailSales', [OLD_SALE, TODAY_SALE]);
        ctx.fake.seed('purchases', [PURCHASE]);
        ctx.fake.seed('cashManagement', [OPEN_SESSION]);
        AppState.retailSalesHistory = [{ ...OLD_SALE }, { ...TODAY_SALE }];
        AppState.purchaseHistory = [{ ...PURCHASE }];
        jest.spyOn(OutstandingManager, 'renderDue').mockImplementation(() => {});
        document.body.innerHTML = CASH_TEMPLATE + '<input id="payment_r0"><input id="payment_r1"><input id="payment_p1">';
        CashManagementManager.todaySession = null;
    });

    const drawer = () => {
        const session = ctx.fake.raw('cashManagement').get('s21');
        CashManagementManager.todaySession = { id: 's21', ...session };
        CashManagementManager.todayTransactions = CashManagementManager.calculateTransactionsForDate('2026-10-21', CashManagementManager.todaySession);
        return CashManagementManager.todayTransactions;
    };

    test('Outstanding cash payment reduces the bill (both due fields) and adds a drawer leg to today\'s open session', async () => {
        setVal('payment_r0', 250);
        await OutstandingManager.recordPayment('r0', 'retail');
        const bill = ctx.fake.raw('retailSales').get('r0');
        expect(bill.payment).toMatchObject({ cash: 650, online: 0, due: 350 });
        expect(bill.dueAmount).toBe(350);
        expect(bill.payments).toEqual([expect.objectContaining({ amount: 250, cash: 250, online: 0 })]);
        const legs = ctx.fake.raw('cashManagement').get('s21').duePayments;
        expect(legs).toEqual([expect.objectContaining({ id: bill.payments[0].id, billId: 'r0', type: 'received', method: 'cash', amount: 250, cash: 250 })]);

        AppState.retailSalesHistory[0] = { ...AppState.retailSalesHistory[0], ...bill };
        const t = drawer();
        expect(t.dueReceived).toBe(250); // bill entry + session leg = one payment
        expect(CashManagementManager.calculateExpectedCash()).toBe(1000 + 300 + 250);
    });

    test('a payment whose bill is no longer loaded still reaches the drawer through the session leg', async () => {
        setVal('payment_r0', 250);
        await OutstandingManager.recordPayment('r0', 'retail');
        AppState.retailSalesHistory = [{ ...TODAY_SALE }]; // old bill paid off and dropped from memory
        expect(drawer().dueReceived).toBe(250);
    });

    test('collecting today\'s own bill does not double count: sale-time cash + due received = cash in', async () => {
        setVal('payment_r1', 495);
        await OutstandingManager.recordPayment('r1', 'retail');
        AppState.retailSalesHistory[1] = { ...AppState.retailSalesHistory[1], ...ctx.fake.raw('retailSales').get('r1') };
        const t = drawer();
        expect(t.cashSales).toBe(300);
        expect(t.dueReceived).toBe(495);
    });

    test('Cash tab "Due received" picks an open bill and reduces its due (same path)', async () => {
        CashManagementManager.todaySession = { ...OPEN_SESSION };
        setVal('cashTransactionType', 'received');
        setVal('partyName', 'sita');
        CashManagementManager.updateTransactionForm();
        const options = [...document.querySelectorAll('#dueBillSelect option')].map(o => o.value);
        expect(options).toEqual(['__none__', 'retail|r0', 'retail|r1', '__nobill__']); // placeholder, oldest first, "no bill" last
        expect(document.getElementById('dueBillSelect').value).toBe('__none__');
        setVal('dueBillSelect', 'retail|r0');
        setVal('transactionAmount', 100);
        jest.spyOn(FirebaseService, 'loadCashSessions').mockResolvedValue([]);
        await CashManagementManager.recordTransaction();

        const bill = ctx.fake.raw('retailSales').get('r0');
        expect(bill.payment.due).toBe(500);
        expect(bill.dueAmount).toBe(500);
        const legs = ctx.fake.raw('cashManagement').get('s21').duePayments;
        expect(legs).toHaveLength(1);
        expect(legs[0]).toMatchObject({ billId: 'r0', cash: 100, type: 'received' });
        expect(CashManagementManager.todaySession.duePayments).toHaveLength(1);
        expect(CashManagementManager.todayTransactions.dueReceived).toBe(100);
    });

    test('paying a supplier due from Outstanding is cash out of the drawer', async () => {
        setVal('payment_p1', 68);
        await OutstandingManager.recordPayment('p1', 'purchase');
        AppState.purchaseHistory[0] = { ...AppState.purchaseHistory[0], ...ctx.fake.raw('purchases').get('p1') };
        const t = drawer();
        expect(t.duePaid).toBe(68);
        expect(t.dueReceived).toBe(0);
    });

    test('online payments never touch the drawer', async () => {
        const bill = AppState.retailSalesHistory[0];
        const written = await OutstandingManager.applyPaymentTransaction('retail', bill, { cash: 0, online: 200 }, { recordedBy: 'Owner' });
        Object.assign(bill, written);
        expect(ctx.fake.raw('cashManagement').get('s21').duePayments[0]).toMatchObject({ method: 'online', cash: 0, online: 200 });
        expect(drawer().dueReceived).toBe(0);
    });

    test('with no open session the payment is still recorded on the bill and counted from it', async () => {
        ctx.fake.raw('cashManagement').delete('s21');
        setVal('payment_r0', 250);
        await OutstandingManager.recordPayment('r0', 'retail');
        AppState.retailSalesHistory[0] = { ...AppState.retailSalesHistory[0], ...ctx.fake.raw('retailSales').get('r0') };
        expect(CashManagementManager.calculateTransactionsForDate('2026-10-21', null).dueReceived).toBe(250);
    });
});

describe('due-payment helpers', () => {
    test('legacy entries/legs count as cash; write-offs are not money', () => {
        expect(entryParts({ amount: 200 })).toEqual({ cash: 200, online: 0, writeOff: 0 });
        expect(entryParts({ amount: 300, cash: 100, online: 200 })).toEqual({ cash: 100, online: 200, writeOff: 0 });
        expect(entryParts({ kind: 'writeOff', amount: 50 })).toEqual({ cash: 0, online: 0, writeOff: 50 });
        expect(legParts({ amount: 250, method: 'cash' })).toEqual({ cash: 250, online: 0 });
        expect(legParts({ amount: 999, method: 'online' })).toEqual({ cash: 0, online: 999 });
    });

    test('sale-time payment subtracts later due payments', () => {
        const bill = { total: 795, payment: { cash: 500, online: 100, due: 195 }, payments: [{ amount: 200 }, { amount: 100, cash: 0, online: 100 }] };
        expect(saleTimePayment(bill)).toEqual({ cash: 300, online: 0 });
    });

    test('events are de-duplicated by payment id across bills and sessions', () => {
        const from = new Date(2026, 9, 21).getTime();
        const to = new Date(2026, 9, 22).getTime();
        const at = new Date(2026, 9, 21, 14).getTime();
        const events = dueEvents({
            bills: { retail: [{ id: 'r1', payments: [{ id: 'x', amount: 200, cash: 200, online: 0, at }, { amount: 50, date: '20/10/2026, 2:00:00 pm' }] }] },
            sessions: [{ id: 's', duePayments: [{ id: 'x', amount: 200, cash: 200, method: 'cash' }, { id: 'y', amount: 70, method: 'cash', type: 'paid', timestamp: new Date(at).toISOString() }] }],
            from, to
        });
        expect(events.map(e => e.id)).toEqual(['x', 'y']);
        expect(sumDueEvents(events)).toMatchObject({ receivedCash: 200, paidCash: 70 });
    });

    test.each([
        [100, 0, 495, { ok: true, cash: 100, online: 0, total: 100 }],
        [100, 395, 495, { ok: true, cash: 100, online: 395, total: 495 }],
        [100, 396, 495, { ok: false, error: 'exceeds-due' }],
        [0, 0, 495, { ok: false, error: 'empty' }],
        [-5, 10, 495, { ok: false, error: 'negative' }]
    ])('validateDuePayment(%p, %p, due %p)', (cash, online, due, expected) => {
        expect(validateDuePayment(cash, online, due)).toEqual(expected);
    });
});

describe('#107 Outstanding: cash + online split', () => {
    const ctx = useFakeShop();
    beforeEach(() => {
        ctx.fake.seed('retailSales', [OLD_SALE]);
        ctx.fake.seed('cashManagement', [OPEN_SESSION]);
        AppState.retailSalesHistory = [{ ...OLD_SALE }];
        AppState.currentDueFilter = 'sale';
        document.body.innerHTML = '<input id="outstandingSearchInput"><div id="dueList"></div>';
        CashManagementManager.todaySession = null;
    });

    test('each row has a cash and an online box', () => {
        OutstandingManager.renderDue();
        expect(document.getElementById('payment_r0').placeholder).toBe('Cash ₹');
        expect(document.getElementById('paymentOnline_r0').placeholder).toBe('Online ₹');
    });

    test('cash and online parts go to payment.cash / payment.online; only cash reaches the drawer', async () => {
        OutstandingManager.renderDue();
        setVal('payment_r0', 100);
        setVal('paymentOnline_r0', 200);
        await OutstandingManager.recordPayment('r0', 'retail');

        const bill = ctx.fake.raw('retailSales').get('r0');
        expect(bill.payment).toMatchObject({ cash: 500, online: 200, due: 300 });
        expect(bill.dueAmount).toBe(300);
        const pay = readPayment(bill);
        expect(pay.cash + pay.online + pay.due).toBe(bill.total); // M1
        expect(bill.payments[0]).toMatchObject({ amount: 300, cash: 100, online: 200 });
        const leg = ctx.fake.raw('cashManagement').get('s21').duePayments[0];
        expect(leg).toMatchObject({ method: 'split', cash: 100, online: 200, amount: 300 });

        AppState.retailSalesHistory = [{ ...OLD_SALE, ...bill }];
        const t = CashManagementManager.calculateTransactionsForDate('2026-10-21', { id: 's21', ...ctx.fake.raw('cashManagement').get('s21') });
        expect(t.dueReceived).toBe(100);
        expect(toast).toHaveBeenCalledWith('✓ Payment of ₹300 recorded');
    });

    test('a split larger than the due is refused without writing', async () => {
        OutstandingManager.renderDue();
        setVal('payment_r0', 500);
        setVal('paymentOnline_r0', 101);
        const writes = ctx.fake.stats.writes;
        await OutstandingManager.recordPayment('r0', 'retail');
        expect(ctx.fake.stats.writes).toBe(writes);
        expect(toast).toHaveBeenCalledWith('Payment amount exceeds outstanding amount');
    });
});

describe('#95 Today shows dues and the hero equals the breakdown (fixture tests/fixtures/today-dues.json)', () => {
    const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../tests/fixtures/today-dues.json'), 'utf8'));
    const DAY_TEMPLATE = fs.readFileSync(path.join(__dirname, '../../templates/day.html'), 'utf8');
    const money = (n) => Helpers.formatCurrency(n);
    const val = (id) => document.getElementById(id).textContent;
    const amount = (id) => Number(val(id).replace(/[^0-9.-]/g, ''));

    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        jest.setSystemTime(new Date(2026, 9, 21, 18, 0, 0));
        document.body.innerHTML = DAY_TEMPLATE;
        const copy = JSON.parse(JSON.stringify(FIX));
        AppState.retailSalesHistory = copy.retailSales;
        AppState.salesHistory = copy.wholesaleSales;
        AppState.purchaseHistory = copy.purchases;
        AppState.expensesHistory = copy.expenses;
        CashManagementManager.todaySession = copy.session;
    });
    afterEach(() => {
        jest.useRealTimers();
        ['salesHistory', 'retailSalesHistory', 'purchaseHistory', 'expensesHistory'].forEach(k => { AppState[k] = []; });
    });

    // Worked by hand:
    //   sales at save time: cash 300 (r1) + 3000 (w1); online 0
    //   due received: e1 200 cash + 100 online, e2 250 cash (also a session leg: once),
    //                 e9 120 cash (bill not loaded), u1 60 cash (unlinked)  → 630 cash + 100 online
    //   purchases at save time: cash 1000, online 500; due paid: e3 400 online (old bill)
    //   expenses 150 + 80 cash
    test('exact Today values', () => {
        DayManager.loadTodayData();
        const e = FIX.expected.today;
        expect(val('todayCashReceived')).toBe(money(e.cashIn));
        expect(val('todayOnlineReceived')).toBe(money(e.onlineIn));
        expect(val('todayCashPaid')).toBe(money(e.cashOut));
        expect(val('todayOnlinePaid')).toBe(money(e.onlineOut));
        expect(val('todayTotalIn')).toBe(money(e.totalIn));
        expect(val('todayTotalOut')).toBe(money(e.totalOut));
        expect(val('todayDueReceived')).toBe(money(e.dueReceived));
        expect(val('todayDuePaid')).toBe(money(e.duePaid));
        expect(val('todayDueToReceive')).toBe(money(e.dueToReceive));
        expect(val('todayDueToPay')).toBe(money(e.dueToPay));
        expect(val('todayCashFlowLabel')).toBe(e.netLabel);
        expect(val('todayNetCashFlow')).toBe(money(e.net));
    });

    test('hero In/Out equal the breakdown below them', () => {
        DayManager.loadTodayData();
        expect(amount('todayTotalIn')).toBe(amount('todayCashReceived') + amount('todayOnlineReceived'));
        expect(amount('todayTotalOut')).toBe(amount('todayCashPaid') + amount('todayOnlinePaid'));
    });

    test('the drawer counts the same day (cash only) with the same de-duplication', () => {
        const t = CashManagementManager.calculateTransactionsForDate(FIX.day, CashManagementManager.todaySession);
        const { expected, ...drawer } = FIX.expected.drawer;
        expect(t).toEqual(drawer);
        CashManagementManager.todayTransactions = t;
        expect(CashManagementManager.calculateExpectedCash()).toBe(expected);
    });

    test('recording a due makes Today\'s due figure move immediately', async () => {
        const fake = createFakeFirestore();
        jest.spyOn(FirebaseService, 'db', 'get').mockReturnValue(fake.db);
        window.getCollection = (n) => n;
        jest.spyOn(AuditService, 'log').mockResolvedValue(undefined);
        jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
        jest.spyOn(OutstandingManager, 'renderDue').mockImplementation(() => {});
        window.app = { day: { loadTodayData: () => DayManager.loadTodayData() } };
        fake.seed('retailSales', [FIX.retailSales[1]]);
        fake.seed('cashManagement', [FIX.session]);
        DayManager.loadTodayData();
        const before = amount('todayDueReceived');
        await OutstandingManager.recordDuePayment({ billType: 'retail', billId: 'r0', cash: 50, online: 0 });
        expect(amount('todayDueReceived')).toBe(before + 50);
        delete window.app;
        delete window.getCollection;
    });
});

describe('Today counts every cash session of the day (T6–T14; two sessions on one day)', () => {
    const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../tests/fixtures/today-dues.json'), 'utf8'));
    const DAY_TEMPLATE = fs.readFileSync(path.join(__dirname, '../../templates/day.html'), 'utf8');
    const amount = (id) => Number(document.getElementById(id).textContent.replace(/[^0-9.-]/g, ''));
    // A legacy session of the same day (random id, closed at noon) with a ₹3,000 cash leg on a bill this
    // phone has not loaded, the online ₹500 leg of a paid-out old purchase, and e2 again (once: same id).
    const LEGACY = {
        id: 'sess-legacy', date: '2026-10-21', openingBalance: 2500, signInTime: '2026-10-21T02:30:00.000Z',
        signedOut: true, counted: true, closingBalance: 5600,
        duePayments: [
            { id: 'e7', billId: 'r-gone', type: 'received', amount: 3000, cash: 3000, online: 0, method: 'cash', timestamp: '2026-10-21T05:00:00.000Z' },
            { id: 'e8', billId: 'p-gone', type: 'paid', amount: 500, cash: 0, online: 500, method: 'online', timestamp: '2026-10-21T05:30:00.000Z' },
            FIX.session.duePayments[0]
        ]
    };
    const DRAWER = { ...FIX.session, id: 'cash_2026-10-21', signInTime: '2026-10-21T07:30:00.000Z' };
    let fake;
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        jest.setSystemTime(new Date(2026, 9, 21, 18, 0, 0));
        document.body.innerHTML = DAY_TEMPLATE;
        const copy = JSON.parse(JSON.stringify(FIX));
        AppState.retailSalesHistory = copy.retailSales;
        AppState.salesHistory = copy.wholesaleSales;
        AppState.purchaseHistory = copy.purchases;
        AppState.expensesHistory = copy.expenses;
        fake = createFakeFirestore();
        jest.spyOn(FirebaseService, 'db', 'get').mockReturnValue(fake.db);
        window.getCollection = (n) => n;
        fake.seed('cashManagement', [JSON.parse(JSON.stringify(DRAWER)), JSON.parse(JSON.stringify(LEGACY))]);
        DayManager.daySessions = { date: null, list: [] };
        DayManager.daySessionsLoading = null;
    });
    afterEach(() => {
        jest.useRealTimers();
        delete window.getCollection;
        DayManager.daySessions = { date: null, list: [] };
        ['salesHistory', 'retailSalesHistory', 'purchaseHistory', 'expensesHistory'].forEach(k => { AppState[k] = []; });
    });

    const expectBothSessions = () => {
        const e = FIX.expected.today;
        expect(amount('todayCashReceived')).toBe(e.cashIn + 3000);
        expect(amount('todayOnlineReceived')).toBe(e.onlineIn);
        expect(amount('todayOnlinePaid')).toBe(e.onlineOut + 500);
        expect(amount('todayTotalIn')).toBe(e.totalIn + 3000);
        expect(amount('todayTotalOut')).toBe(e.totalOut + 500);
        expect(amount('todayDueReceived')).toBe(e.dueReceived + 3000);
        expect(amount('todayDuePaid')).toBe(e.duePaid + 500);
        expect(amount('todayNetCashFlow')).toBe(e.net + 2500);
    };

    test('legs on an unloaded bill in the day\'s other session count once, from one query', async () => {
        CashManagementManager.todaySession = null;
        DayManager.init();
        await flush();
        expectBothSessions();
        const cashQueries = () => fake.stats.queryLog.filter(q => q.coll === 'cashManagement');
        expect(cashQueries()).toHaveLength(1);
        expect(cashQueries()[0].filters).toEqual([{ field: 'date', op: '==', value: '2026-10-21' }]);
        // The drawer is the session the Cash page picks for the day (the per-day id).
        expect(CashManagementManager.todaySession.id).toBe(sessionForDate([LEGACY, DRAWER], '2026-10-21').id);
        expect(CashManagementManager.todaySession.id).toBe('cash_2026-10-21');

        DayManager.init(); // opening Today again reads no session
        await flush();
        expect(cashQueries()).toHaveLength(1);
        expectBothSessions();
    });

    test('with the drawer already loaded by the Cash tab, the other session is still read and counted', async () => {
        CashManagementManager.todaySession = JSON.parse(JSON.stringify(DRAWER));
        DayManager.loadTodayData();
        expect(amount('todayDueReceived')).toBe(FIX.expected.today.dueReceived);
        DayManager.loadTodaySession();
        await flush();
        expectBothSessions();
        expect(fake.stats.queryLog.filter(q => q.coll === 'cashManagement')).toHaveLength(1);
        expect(CashManagementManager.todaySession.id).toBe('cash_2026-10-21');
    });

    test('a leg this phone just added to the live drawer counts before any re-read', async () => {
        CashManagementManager.todaySession = null;
        DayManager.init();
        await flush();
        CashManagementManager.todaySession.duePayments.push({ id: 'e10', type: 'received', amount: 40, cash: 40, online: 0, method: 'cash', timestamp: '2026-10-21T12:00:00.000Z' });
        DayManager.loadTodayData();
        expect(amount('todayDueReceived')).toBe(FIX.expected.today.dueReceived + 3000 + 40);
    });

    test('yesterday\'s sessions do not count today', async () => {
        fake.raw('cashManagement').clear();
        fake.seed('cashManagement', [{ ...JSON.parse(JSON.stringify(LEGACY)), date: '2026-10-20' }]);
        CashManagementManager.todaySession = null;
        DayManager.init();
        await flush();
        expect(CashManagementManager.todaySession).toBeNull();
        expect(DayManager.sessionsOn('2026-10-21')).toEqual([]);
        expect(amount('todayDueReceived')).toBe(FIX.expected.today.dueReceived - 120 - 60);
    });
});

describe('#104 "Mark as cleared" asks how and records it (no silent write-off)', () => {
    const ctx = useFakeShop();
    let dialogShown;
    /** Answers the clearing dialog like a user: pick a method, type a reason, press OK/Cancel. */
    const answer = (method, reason = '', ok = true) => {
        dialogShown = false;
        jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async (html) => {
            dialogShown = true;
            document.getElementById('modalMessage').innerHTML = html;
            if (method) document.querySelector(`input[name="clearMethod"][value="${method}"]`).checked = true;
            document.getElementById('clearReason').value = reason;
            return ok;
        });
    };
    beforeEach(() => {
        ctx.fake.seed('retailSales', [OLD_SALE, TODAY_SALE]);
        ctx.fake.seed('cashManagement', [OPEN_SESSION]);
        AppState.retailSalesHistory = [{ ...OLD_SALE }, { ...TODAY_SALE }];
        AppState.currentDueFilter = 'sale';
        document.body.innerHTML = '<input id="outstandingSearchInput"><div id="dueList"></div><div id="modalMessage"></div>';
        CashManagementManager.todaySession = null;
    });

    test('the row offers a "Mark as Cleared…" button instead of a one-tap checkbox', () => {
        OutstandingManager.renderDue();
        const list = document.getElementById('dueList');
        expect(list.querySelector('input[type="checkbox"]')).toBeNull();
        expect([...list.querySelectorAll('button')].map(b => b.textContent.trim())).toContain('Mark as Cleared…');
    });

    test('write-off: both due fields to 0, a write-off entry with amount/reason/who/when, not counted as money', async () => {
        answer('writeOff', 'Customer moved away');
        const ok = await OutstandingManager.markAsCleared('r1', 'retail');
        expect(ok).toBe(true);
        const bill = ctx.fake.raw('retailSales').get('r1');
        expect(bill.payment).toMatchObject({ cash: 300, online: 0, due: 0, writtenOff: 495 });
        expect(bill.dueAmount).toBe(0);
        expect(bill).toMatchObject({ cleared: true, clearedBy: 'u1', clearedByName: 'Owner', openDue: false });
        expect(bill.payments).toEqual([expect.objectContaining({ kind: 'writeOff', amount: 495, reason: 'Customer moved away', recordedBy: 'Owner', recordedById: 'u1' })]);
        expect(typeof bill.payments[0].at).toBe('number');
        expect(ctx.fake.raw('cashManagement').get('s21').duePayments).toEqual([]); // no drawer leg

        // Totals drop; the write-off is not cash or online money
        AppState.retailSalesHistory[1] = { ...TODAY_SALE, ...bill };
        const t = CashManagementManager.calculateTransactionsForDate('2026-10-21', null);
        expect(t.dueReceived).toBe(0);
        expect(t.cashSales).toBe(300);
        const events = dueEvents({ bills: { retail: AppState.retailSalesHistory }, from: new Date(2026, 9, 21).getTime(), to: new Date(2026, 9, 22).getTime() });
        expect(sumDueEvents(events)).toMatchObject({ receivedCash: 0, receivedOnline: 0, writtenOffReceivable: 495 });
        OutstandingManager.renderDue();
        expect(document.getElementById('dueList').textContent).not.toContain('S1');
        expect(AuditService.log).toHaveBeenCalledWith('CLEAR_DUE', expect.objectContaining({ method: 'writeOff', amount: 495, reason: 'Customer moved away' }));
    });

    test.each([
        ['writeOff', '', true, 'Please write a reason for the write-off'],
        [null, 'x', true, 'Choose how the due was settled'],
        ['writeOff', 'Moved away', false, null]
    ])('nothing is written when method=%p reason=%p ok=%p', async (method, reason, ok, message) => {
        answer(method, reason, ok);
        const writes = ctx.fake.stats.writes;
        expect(await OutstandingManager.markAsCleared('r1', 'retail')).toBe(false);
        expect(dialogShown).toBe(true);
        expect(ctx.fake.stats.writes).toBe(writes);
        if (message) expect(toast).toHaveBeenCalledWith(message);
    });

    test('received in cash: records the remaining due as a cash payment (drawer leg) and marks the bill cleared', async () => {
        answer('cash', '');
        expect(await OutstandingManager.markAsCleared('r0', 'retail')).toBe(true);
        const bill = ctx.fake.raw('retailSales').get('r0');
        expect(bill.payment).toMatchObject({ cash: 1000, due: 0 });
        expect(bill.dueAmount).toBe(0);
        expect(bill.cleared).toBe(true);
        expect(bill.payments[0]).toMatchObject({ amount: 600, cash: 600, online: 0, settlesDue: true });
        expect(ctx.fake.raw('cashManagement').get('s21').duePayments[0]).toMatchObject({ cash: 600, method: 'cash' });
    });

    test('received online: no drawer cash', async () => {
        answer('online', 'UPI ref 123');
        await OutstandingManager.markAsCleared('r0', 'retail');
        const bill = ctx.fake.raw('retailSales').get('r0');
        expect(bill.payment).toMatchObject({ cash: 400, online: 600, due: 0 });
        expect(bill.payments[0]).toMatchObject({ online: 600, cash: 0, note: 'UPI ref 123' });
    });

    test('wholesale "Mark as Cleared" uses the same dialog and transaction', async () => {
        const W = { id: 'w1', billNumber: 'W1', customerName: 'Gupta', source: 'sales-tab', date: '2026-10-20T10:00:00', total: 5000, payment: { cash: 3000, online: 0, due: 2000 } };
        ctx.fake.seed('wholesaleSales', [W]);
        AppState.salesHistory = [{ ...W }];
        jest.spyOn(WholesaleSalesManager, 'renderSalesHistory').mockImplementation(() => {});
        answer('writeOff', 'Settled by discount');
        await WholesaleSalesManager.markSaleAsCleared('w1');
        expect(ctx.fake.raw('wholesaleSales').get('w1')).toMatchObject({ cleared: true, payment: { due: 0, writtenOff: 2000 } });
    });
});

describe('#89 expenses appear / disappear at once, before the server answers', () => {
    const EXPENSES_TEMPLATE = fs.readFileSync(path.join(__dirname, '../../templates/expenses.html'), 'utf8');
    beforeEach(() => {
        // A server that never answers (offline): writes stay pending
        const db = {
            collection: () => ({
                doc: (id) => ({
                    id: id || 'exp-new-1',
                    set: jest.fn(() => new Promise(() => {})),
                    delete: jest.fn(() => new Promise(() => {}))
                })
            })
        };
        global.firebase = { firestore: () => db };
        jest.spyOn(UIManager, 'withLoading').mockImplementation(async (fn) => fn());
        jest.spyOn(AuditService, 'log').mockResolvedValue(undefined);
        document.body.innerHTML = EXPENSES_TEMPLATE;
        AppState.expensesHistory = [{ id: 'old1', category: 'business', type: 'Tea', amount: 40, date: '20/10/2026, 9:00:00 am' }];
        window.app = {};
    });
    afterEach(() => {
        delete global.firebase;
        delete window.app;
        AppState.expensesHistory = [];
    });
    const listText = () => document.getElementById('businessExpenseHistoryList').textContent;

    test('a new expense is listed immediately (no duplicate) while the write is still pending', async () => {
        setVal('businessExpenseType', 'Diesel');
        setVal('businessExpenseAmount', 500);
        await ExpensesManager.saveBusinessExpense();
        expect(AppState.expensesHistory.filter(e => e.type === 'Diesel')).toEqual([expect.objectContaining({ id: 'exp-new-1', amount: 500, category: 'business' })]);
        expect(listText()).toContain('Diesel');
        expect(listText()).toContain('Tea');
        expect(toast).toHaveBeenCalledWith('✓ Business expense saved');
    });
});

describe('#98 review: the Cash-tab bill picker never guesses the bill', () => {
    const ctx = useFakeShop();
    const RAMESH = { id: 'r9', billNumber: 'S9', customerName: 'Ramesh', date: '19/10/2026', total: 500, dueAmount: 500, payment: { cash: 0, online: 0, due: 500 } };
    const RAM_P = { id: 'p9', billNumber: 'P9', customerName: 'Ram', date: '18/10/2026', grandTotal: 900, dueAmount: 900, payment: { cash: 0, online: 0, due: 900 } };
    const HINDI = { id: 'r8', billNumber: 'S8', customerName: 'सीता  देवी', date: '18/10/2026', total: 300, dueAmount: 300, payment: { cash: 0, online: 0, due: 300 } };
    beforeEach(() => {
        ctx.fake.seed('retailSales', [OLD_SALE, TODAY_SALE, RAMESH, HINDI]);
        ctx.fake.seed('cashManagement', [OPEN_SESSION]);
        AppState.retailSalesHistory = [{ ...OLD_SALE }, { ...TODAY_SALE }, { ...RAMESH }, { ...HINDI }];
        AppState.purchaseHistory = [{ ...RAM_P }];
        jest.spyOn(OutstandingManager, 'renderDue').mockImplementation(() => {});
        jest.spyOn(FirebaseService, 'loadCashSessions').mockResolvedValue([]);
        document.body.innerHTML = CASH_TEMPLATE;
        CashManagementManager.todaySession = { ...OPEN_SESSION, duePayments: [] };
    });
    const options = () => [...document.querySelectorAll('#dueBillSelect option')].map(o => o.value);
    const pick = (type, party) => {
        setVal('cashTransactionType', type);
        setVal('partyName', party);
        CashManagementManager.updateTransactionForm();
    };

    test('blank name: no bills listed, and nothing is recorded without an explicit choice', async () => {
        pick('received', '');
        expect(options()).toEqual(['__none__', '__nobill__']);
        expect(document.getElementById('dueBillSelect').value).toBe('__none__');
        setVal('transactionAmount', 100);
        const writes = ctx.fake.stats.writes;
        await CashManagementManager.recordTransaction();
        expect(ctx.fake.stats.writes).toBe(writes);
        expect(toast).toHaveBeenCalledWith('Choose a bill, or "No bill"');
    });

    test('a typed name lists bills but none is pre-selected', async () => {
        pick('received', 'Sita');
        expect(options()).toEqual(['__none__', 'retail|r0', 'retail|r1', '__nobill__']);
        setVal('transactionAmount', 100);
        await CashManagementManager.recordTransaction();
        expect(ctx.fake.raw('retailSales').get('r0').payment.due).toBe(600);
        expect(toast).toHaveBeenCalledWith('Choose a bill, or "No bill"');
    });

    test('names match exactly: "Ram" does not list Ramesh; exact, case/space-insensitive and Hindi names do', () => {
        pick('received', 'Ram');
        expect(options()).toEqual(['__none__', '__nobill__']);
        pick('received', '  ramesh ');
        expect(options()).toEqual(['__none__', 'retail|r9', '__nobill__']);
        pick('received', 'सीता देवी');
        expect(options()).toEqual(['__none__', 'retail|r8', '__nobill__']);
        pick('paid', 'RAM');
        expect(options()).toEqual(['__none__', 'purchase|p9', '__nobill__']);
        expect(sameParty('Ram', 'Ramesh')).toBe(false);
        expect(sameParty('', '')).toBe(false);
    });

    test('the chosen bill\'s party, date and current due are shown', () => {
        pick('received', 'Sita');
        setVal('dueBillSelect', 'retail|r0');
        document.getElementById('dueBillSelect').dispatchEvent(new Event('change'));
        CashManagementManager.showDueBillDetails();
        const hint = document.getElementById('dueBillHint').textContent;
        expect(hint).toContain('Sita');
        expect(hint).toContain('Due now ₹600');
        expect(hint).toContain(Helpers.formatDate('20/10/2026'));
    });

    test('a bill of another party is refused with a bilingual message (name changed after choosing)', async () => {
        pick('received', 'Sita');
        setVal('dueBillSelect', 'retail|r0');
        setVal('partyName', 'Ramesh'); // typed over without the list refreshing
        setVal('transactionAmount', 100);
        const writes = ctx.fake.stats.writes;
        await CashManagementManager.recordTransaction();
        expect(ctx.fake.stats.writes).toBe(writes);
        expect(toast).toHaveBeenCalledWith('This bill is for Sita, not Ramesh');
        expect(ctx.fake.raw('retailSales').get('r0').payment.due).toBe(600);
    });

    test('explicit "No bill" still works offline: shown at once, write queued', async () => {
        const update = jest.fn(() => new Promise(() => {})); // offline: never acknowledged
        jest.spyOn(FirebaseService, 'db', 'get').mockReturnValue({ collection: () => ({ doc: () => ({ update }) }) });
        global.firebase = { firestore: { FieldValue: { arrayUnion: (...v) => ({ arrayUnion: v }) } } };
        pick('received', 'Old customer');
        setVal('dueBillSelect', '__nobill__');
        setVal('transactionAmount', 60);
        await CashManagementManager.recordTransaction();
        expect(update).toHaveBeenCalledWith({ duePayments: { arrayUnion: [expect.objectContaining({ amount: 60, cash: 60, unlinked: true, customer: 'Old customer' })] } });
        expect(CashManagementManager.todaySession.duePayments).toHaveLength(1);
        expect(CashManagementManager.todayTransactions.dueReceived).toBe(60);
        expect(toast).toHaveBeenCalledWith('✓ Recorded ₹60 received from Old customer');
    });
});

describe('#38 one cash session per day', () => {
    const ctx = useFakeShop();
    beforeEach(() => {
        document.body.innerHTML = CASH_TEMPLATE;
        const runTx = ctx.fake.db.runTransaction;
        let queue = Promise.resolve();
        // Firestore serialises transactions on one document: model that.
        ctx.fake.db.runTransaction = (fn) => {
            const run = queue.then(() => runTx(fn));
            queue = run.catch(() => {});
            return run;
        };
    });

    const open = (amount, uid, name) => FirebaseService.openCashSession({
        date: '2026-10-21', openingBalance: amount, signInTime: new Date().toISOString(), userId: uid, userName: name, signedOut: false, duePayments: []
    });

    test('two phones opening at once share one session at cash_<date>', async () => {
        const [a, b] = await Promise.all([open(1000, 'u1', 'Owner'), open(900, 'u2', 'Ramesh')]);
        const docs = [...ctx.fake.raw('cashManagement').keys()];
        expect(docs).toEqual(['cash_2026-10-21']);
        expect([a.joined, b.joined].sort()).toEqual([false, true]);
        expect(a.session.id).toBe('cash_2026-10-21');
        expect(b.session).toMatchObject({ id: 'cash_2026-10-21', openingBalance: 1000, userId: 'u1' });
    });

    test('joins a session an older app opened today with a random id', async () => {
        ctx.fake.seed('cashManagement', [{ ...OPEN_SESSION, userName: 'Ramesh' }]);
        const r = await open(700, 'u1', 'Owner');
        expect(r).toMatchObject({ joined: true, session: { id: 's21', openingBalance: 1000 } });
        expect(ctx.fake.raw('cashManagement').has('cash_2026-10-21')).toBe(false);
    });

    test('sign-in on a second phone joins and says so; sign-out stores closedBy', async () => {
        await open(1000, 'u2', 'Ramesh');
        setVal('cashSignInAmount', 1000);
        await CashManagementManager.signIn();
        expect(CashManagementManager.todaySession).toMatchObject({ id: 'cash_2026-10-21', userId: 'u2' });
        expect(toast).toHaveBeenCalledWith(expect.stringContaining('already open (Ramesh, ₹1,000)'));
        expect(ctx.fake.raw('cashManagement').size).toBe(1);

        setVal('cashSignOutAmount', 1000);
        await CashManagementManager.signOut();
        expect(ctx.fake.raw('cashManagement').get('cash_2026-10-21')).toMatchObject({ signedOut: true, closedBy: 'u1', userId: 'u2' });
    });

    test('offline, opening cash is refused and writes nothing (no blind merge over the day)', async () => {
        const closed = { date: '2026-10-21', openingBalance: 1000, userId: 'u2', signInTime: 'x',
            signedOut: true, counted: true, closingBalance: 1200, duePayments: [{ id: 'p1', amount: 50 }] };
        ctx.fake.seed('cashManagement', [{ id: 'cash_2026-10-21', ...closed }]);
        jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
        await expect(open(900, 'u1', 'Owner')).rejects.toMatchObject({ code: CASH_NEEDS_INTERNET });
        jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        setVal('cashSignInAmount', 900);
        await CashManagementManager.signIn();
        await ctx.fake.settle();
        expect(toast).toHaveBeenCalledWith('Open cash needs internet. Connect and try again.');
        expect(ctx.fake.raw('cashManagement').get('cash_2026-10-21')).toEqual(closed);
        expect(ctx.fake.raw('cashManagement').size).toBe(1);
    });

    test('a lost connection during the open is reported as needing internet, nothing queued', async () => {
        ctx.fake.db.runTransaction = () => Promise.reject(Object.assign(new Error('offline'), { code: 'unavailable' }));
        await expect(open(900, 'u1', 'Owner')).rejects.toMatchObject({ code: CASH_NEEDS_INTERNET });
        await ctx.fake.settle();
        expect(ctx.fake.raw('cashManagement').size).toBe(0);
    });

    test('the same-day lookup asks the server, not the offline cache', async () => {
        const spy = jest.spyOn(FirebaseService, 'loadCashSessionsForDate');
        await open(900, 'u1', 'Owner');
        expect(spy).toHaveBeenCalledWith('2026-10-21', { source: 'server' });
    });

    test('owner sees days with more than one session; the per-day id wins for that day', () => {
        AppState.userRole = 'owner';
        const sessions = [
            { id: 'a', date: '2026-10-20', signInTime: '2026-10-20T04:00:00Z', openingBalance: 1, signedOut: true, counted: true, closingBalance: 1 },
            { id: 'cash_2026-10-20', date: '2026-10-20', signInTime: '2026-10-20T05:00:00Z', openingBalance: 2, signedOut: true, counted: true, closingBalance: 2 },
            { id: 'c', date: '2026-10-19', openingBalance: 3, signedOut: true, counted: true, closingBalance: 3 }
        ];
        expect(duplicateSessionDays(sessions)).toEqual(['2026-10-20']);
        expect(sessionForDate(sessions, '2026-10-20').id).toBe('cash_2026-10-20');
        expect(sessionForDate(sessions.filter(s => s.id !== 'cash_2026-10-20').concat({ id: 'b', date: '2026-10-20', signInTime: '2026-10-20T03:00:00Z' }), '2026-10-20').id).toBe('b');
        CashManagementManager.cachedSessions = sessions;
        CashManagementManager.renderHistoryFromCache();
        expect(document.getElementById('cashHistoryList').textContent).toContain('1 day has more than one cash session');
        AppState.userRole = 'manager';
        CashManagementManager.renderHistoryFromCache();
        expect(document.getElementById('cashHistoryList').textContent).not.toContain('more than one cash session');
    });
});