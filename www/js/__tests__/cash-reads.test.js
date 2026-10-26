/**
 * @fileoverview Cash Management reads (#34 / #194): opening the screen and
 * the usual actions read the recent sessions, not the whole cash history.
 */
import fs from 'fs';
import path from 'path';
import { CashManagementManager } from '../modules/cash-management.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

const CASH_TEMPLATE = fs.readFileSync(path.join(__dirname, '../../templates/cash-management.html'), 'utf8');
const DAYS = 365;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

let fake;
beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(new Date(2026, 9, 21, 10, 0, 0));
    fake = createFakeFirestore();
    jest.spyOn(FirebaseService, 'db', 'get').mockReturnValue(fake.db);
    global.firebase = fake.firebase;
    window.getCollection = (n) => n;
    jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(UIManager, 'withLoading').mockImplementation(async (fn) => fn());
    jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
    jest.spyOn(UIManager, 'showModalWithHtml').mockResolvedValue(true);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    AppState.currentUser = { uid: 'u1' };
    AppState.userName = 'Owner';
    AppState.userRole = 'owner';
    ['salesHistory', 'retailSalesHistory', 'purchaseHistory', 'expensesHistory'].forEach(k => { AppState[k] = []; });
    document.body.innerHTML = CASH_TEMPLATE;
    const sessions = [];
    for (let i = 1; i <= DAYS; i++) {
        const date = iso(new Date(2026, 9, 21 - i));
        sessions.push({ id: `s${date}`, date, openingBalance: 500, signInTime: `${date}T04:00:00.000Z`, userId: 'u1', userName: 'Owner',
            signedOut: true, counted: true, closingBalance: 500, expectedBalance: 500, difference: 0, duePayments: [], transactions: {} });
    }
    fake.seed('cashManagement', sessions);
    CashManagementManager.cachedSessions = null;
    CashManagementManager.todaySession = null;
    CashManagementManager.olderCursor = null;
    CashManagementManager.hasOlderSessions = false;
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete window.getCollection;
    delete global.firebase;
});

async function openSignInAndBrowse() {
    await CashManagementManager.init();
    document.getElementById('cashSignInAmount').value = '500';
    await CashManagementManager.signIn();
    await CashManagementManager.showSessionDetails('2026-10-20');
    await CashManagementManager.renderHistory();
}

test('open + sign in + details + history reads the recent sessions only', async () => {
    await openSignInAndBrowse();
    process.stdout.write(`cash reads (${DAYS} days of history): ${fake.stats.reads}\n`);
    expect(fake.stats.reads).toBeLessThan(10);
    expect(fake.stats.queryLog.filter(q => q.coll === 'cashManagement' && !q.limitN && !q.filters.length)).toHaveLength(0);
});

test('details of a loaded day come from the cache; opening Cash again keeps older pages', async () => {
    await CashManagementManager.init();
    const before = fake.stats.reads;
    await CashManagementManager.showSessionDetails('2026-10-20');
    expect(fake.stats.reads).toBe(before);

    await CashManagementManager.loadOlderSessions();
    expect(CashManagementManager.cachedSessions).toHaveLength(2 + 30);
    await CashManagementManager.init();
    expect(CashManagementManager.cachedSessions).toHaveLength(2 + 30);
});

test('"Load older" pages back through history and disappears at the end', async () => {
    await CashManagementManager.init();
    const list = () => document.getElementById('cashHistoryList');
    expect(list().querySelector('#cashLoadOlder')).not.toBeNull();
    for (let i = 0; i < 20 && CashManagementManager.hasOlderSessions; i++) await CashManagementManager.loadOlderSessions();
    expect(CashManagementManager.cachedSessions).toHaveLength(DAYS);
    expect(new Set(CashManagementManager.cachedSessions.map(s => s.id)).size).toBe(DAYS);
    expect(list().querySelector('#cashLoadOlder')).toBeNull();
});

test('without "Past cash days" there is no Load older button', async () => {
    AppState.userRole = 'manager';
    AppState.settings = { roleAccess: { manager: { oldCashSessions: false } } };
    await CashManagementManager.init();
    expect(document.getElementById('cashLoadOlder')).toBeNull();
    AppState.settings = {};
});
