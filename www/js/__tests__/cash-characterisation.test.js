/**
 * @fileoverview Characterisation of the cash drawer (docs/calculations.md
 * C1–C9): the day's drawer figures, the status card and sign-out summary text,
 * the sign-out check under the count box, the history list, the day details,
 * and what closing, a late count, a "No bill" entry, a deposit and opening
 * (mismatch prompt) write or ask, for the days in
 * tests/fixtures/calculations/cash-days.json. Pinned before the maths moved
 * out of modules/cash-management.js. A change here is a change on screen or in
 * a saved session. `CASH_RECORD=1 npx jest cash-characterisation` rewrites
 * cash-days.expected.json (only for an intended change; say why in the PR).
 */
import fs from 'fs';
import path from 'path';
import { CashManagementManager } from '../modules/cash-management.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { AppState } from '../utils/state.js';

const FIXTURES = path.resolve(__dirname, '../../../tests/fixtures/calculations');
const FIX = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cash-days.json'), 'utf8'));
const EXPECTED_FILE = path.join(FIXTURES, 'cash-days.expected.json');
const TEMPLATE = fs.readFileSync(path.resolve(__dirname, '../../templates/cash-management.html'), 'utf8');
const RECORD = !!process.env.CASH_RECORD;
const EXPECTED = RECORD ? {} : JSON.parse(fs.readFileSync(EXPECTED_FILE, 'utf8'));

const STATUS_IDS = [
    'statusOpeningBalance', 'statusCashIn', 'statusCashOut', 'statusAvailable', 'statusCashAdded', 'statusBuy',
    'statusSale', 'statusOthers', 'statusExpected', 'statusActual', 'statusDiff'
];
const CARD_IDS = [
    'statusOpeningCard', 'statusCashInCard', 'statusCashOutCard', 'statusAvailableCard', 'statusCashAddedCard',
    'statusBuyCard', 'statusSaleCard', 'statusOthersCard', 'statusExpectedCard', 'statusActualCard', 'statusDiffCard',
    'cashSignInSection', 'cashSignOutSection', 'cashDepositSection'
];
const SUMMARY_IDS = [
    'openingBalanceTotal', 'cashSalesTotal', 'cashPurchasesTotal', 'cashBusinessExpensesTotal', 'cashPersonalExpensesTotal',
    'dueReceivedTotal', 'duePaidTotal', 'cashDepositsTotal', 'totalCashIn', 'totalCashOut', 'expectedCashAmount'
];
const copy = (v) => JSON.parse(JSON.stringify(v));
const r2 = (x) => Math.round(x * 100) / 100;
const text = (id) => document.getElementById(id).textContent;
const setVal = (id, v) => { document.getElementById(id).value = String(v); };

let toasts;
let modals;
let modalHtml;
let writes;

/** Loads one fixture day into AppState and the Firebase mocks, renders the Cash page. */
function setup(c) {
    jest.setSystemTime(new Date(c.now));
    AppState.userRole = c.role;
    AppState.settings = { showHindi: false, roleAccess: c.roleAccess || {} };
    AppState.purchaseHistory = copy(c.purchases);
    AppState.salesHistory = copy(c.wholesaleSales);
    AppState.retailSalesHistory = copy(c.retailSales);
    AppState.expensesHistory = copy(c.expenses);
    jest.spyOn(FirebaseService, 'personalRowsLoaded').mockReturnValue(!!c.personalRows);
    jest.spyOn(FirebaseService, 'personalExpenseDay').mockImplementation(d => c.personalDays[d] || null);
    jest.spyOn(FirebaseService, 'loadPersonalExpenseDay').mockImplementation(async d => c.personalDays[d] || null);
    const sessions = copy(c.sessions);
    CashManagementManager.cachedSessions = sessions;
    CashManagementManager.duplicateDays = null;
    CashManagementManager.loadTodaySessionFromCache(sessions);
    CashManagementManager.todayTransactions = CashManagementManager.calculateTransactionsForDate(c.now.slice(0, 10), CashManagementManager.todaySession);
    document.body.innerHTML = TEMPLATE;
    CashManagementManager.updateUI();
    return sessions;
}

function screen() {
    return {
        text: Object.fromEntries([...STATUS_IDS, ...SUMMARY_IDS].map(id => [id, text(id)])),
        shown: Object.fromEntries(CARD_IDS.map(id => [id, document.getElementById(id).style.display])),
        diffColor: document.getElementById('statusDiff').style.color,
        signInAmount: document.getElementById('cashSignInAmount').value,
        signInHint: text('cashSignInSuggestion')
    };
}

function signOutCheck(counted) {
    setVal('cashSignOutAmount', counted);
    CashManagementManager.validateSignOut();
    const alert = document.getElementById('cashDifferenceAlert');
    return { counted, text: alert.textContent, display: alert.style.display, background: alert.style.background, color: alert.style.color };
}

/** Everything the page shows and writes for one fixture day. */
async function recordCase(c) {
    const out = {};
    const sessions = setup(c);
    out.drawers = sessions.map(s => ({ id: s.id, tx: CashManagementManager.calculateTransactionsForDate(s.date, copy(s)) }));
    out.drawerNoSession = CashManagementManager.calculateTransactionsForDate(c.now.slice(0, 10), null);
    out.liveSession = CashManagementManager.todaySession ? CashManagementManager.todaySession.id : null;
    out.expected = CashManagementManager.calculateExpectedCash();
    out.screen = screen();
    out.checks = [
        ...c.counts.map(d => signOutCheck(r2(out.expected + d))),
        ...c.absoluteCounts.map(signOutCheck)
    ];

    const list = document.getElementById('cashHistoryList');
    CashManagementManager.renderSessionList(list, copy(sessions));
    out.history = list.innerHTML;
    out.details = {};
    for (const date of [...new Set(sessions.map(s => s.date))]) {
        modalHtml = null;
        await CashManagementManager.showSessionDetails(date);
        out.details[date] = modalHtml;
    }

    const docs = Object.fromEntries(sessions.map(s => [s.id, s]));
    const docRef = (id) => ({
        id,
        exists: !!docs[id],
        data: () => { const { id: _id, ...rest } = copy(docs[id]); return rest; },
        update: async (fields) => { writes.push({ id, fields: copy(fields) }); }
    });
    jest.spyOn(FirebaseService, 'db', 'get').mockReturnValue({
        collection: () => ({ doc: docRef }),
        runTransaction: async (fn) => fn({
            get: async (ref) => ref,
            update: (ref, fields) => { writes.push({ id: ref.id, fields: copy(fields) }); }
        })
    });

    if (c.close) {
        setup(c);
        writes = []; modals = []; toasts = [];
        setVal('cashSignOutAmount', r2(CashManagementManager.calculateExpectedCash() + c.close.delta));
        setVal('cashSignOutNotes', c.close.notes);
        await CashManagementManager.signOut();
        out.close = { writes, modals, toasts, screen: screen() };
    }
    for (const key of ['noBill', 'noBillPaid', 'deposit']) {
        const e = c[key];
        if (!e) continue;
        setup(c);
        writes = []; toasts = [];
        setVal('cashTransactionType', key === 'deposit' ? 'deposit' : e.type);
        CashManagementManager.updateTransactionForm();
        if (key !== 'deposit') {
            setVal('partyName', e.party);
            CashManagementManager.populateDueBills();
            setVal('dueBillSelect', '__nobill__');
        }
        setVal('transactionAmount', e.amount);
        setVal('transactionNotes', e.notes);
        await CashManagementManager.recordTransaction();
        await Promise.resolve();
        out[key] = { writes, toasts, tx: copy(CashManagementManager.todayTransactions), screen: screen() };
    }
    if (c.lateCount) {
        setup(c);
        writes = []; toasts = [];
        document.body.insertAdjacentHTML('beforeend', `<input id="lateCountAmount" value="${c.lateCount.amount}">`);
        await CashManagementManager.recordLateCount(c.lateCount.sessionId);
        out.lateCount = { writes, toasts };
    }
    if (c.autoCloseRun) {
        const list2 = setup(c);
        writes = []; toasts = [];
        await CashManagementManager.autoSignOutPreviousDays(list2);
        out.autoClose = { writes, toasts, sessions: list2.map(s => ({ id: s.id, expectedBalance: s.expectedBalance, signedOut: s.signedOut })) };
    }
    if (c.signIn) {
        setup(c);
        modals = []; toasts = [];
        jest.spyOn(FirebaseService, 'openCashSession').mockImplementation(async () => { throw new Error('not opened in this test'); });
        UIManager.showModal.mockImplementation(async (message, title) => { modals.push({ message, title }); return false; });
        setVal('cashSignInAmount', c.signIn.amount);
        await CashManagementManager.signIn();
        out.signIn = { modals, toasts };
    }
    return out;
}

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    toasts = []; modals = []; writes = [];
    jest.spyOn(UIManager, 'showToast').mockImplementation((m, kind) => { toasts.push(kind ? [m, kind] : m); });
    jest.spyOn(UIManager, 'showModal').mockImplementation(async (message, title) => { modals.push({ message, title }); return true; });
    jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async (html) => { modalHtml = html; return true; });
    jest.spyOn(UIManager, 'closeModal').mockImplementation(() => {});
    let n = 0;
    jest.spyOn(Helpers, 'generateId').mockImplementation(() => `gen-${++n}`);
    global.firebase = { firestore: { FieldValue: { arrayUnion: (...v) => ({ arrayUnion: v }) } } };
    AppState.currentUser = { uid: 'u1', email: 'o@x' };
    AppState.userName = 'Owner';
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    CashManagementManager.todaySession = null;
    CashManagementManager.cachedSessions = null;
    CashManagementManager.duplicateDays = null;
    delete global.firebase;
    ['purchaseHistory', 'salesHistory', 'retailSalesHistory', 'expensesHistory'].forEach(k => { AppState[k] = []; });
});
afterAll(() => {
    if (RECORD) fs.writeFileSync(EXPECTED_FILE, `${JSON.stringify(EXPECTED, null, 2)}\n`);
});

describe('Cash drawer, pinned (cash-days.json)', () => {
    test.each(Object.keys(FIX.cases))('%s', async (name) => {
        const got = await recordCase(FIX.cases[name]);
        if (RECORD) EXPECTED[name] = got;
        else expect(got).toEqual(EXPECTED[name]);
    });
});
