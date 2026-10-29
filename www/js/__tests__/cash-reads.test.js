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
    CashManagementManager.duplicateDays = null;
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
    AppState.userRole = 'manager';
    await openSignInAndBrowse();
    process.stdout.write(`cash reads, manager (${DAYS} days of history): ${fake.stats.reads}\n`);
    expect(fake.stats.reads).toBeLessThan(10);
    expect(fake.stats.queryLog.filter(q => q.coll === 'cashManagement' && !q.limitN && !q.filters.length)).toHaveLength(0);
});

test('the owner also reads the last month once for the duplicate-day check', async () => {
    await openSignInAndBrowse();
    await fake.settle();
    const first = fake.stats.reads;
    await CashManagementManager.init();
    await fake.settle();
    process.stdout.write(`cash reads, owner (${DAYS} days of history): ${first}, opening Cash again: ${fake.stats.reads - first}\n`);
    expect(first).toBeLessThan(45);
    expect(fake.stats.reads - first).toBeLessThan(10);
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

describe('partial history: the targeted queries fill what the 2-day window misses', () => {
    const day = (n) => iso(new Date(2026, 9, 21 - n));
    const reseed = (patch) => {
        const docs = [...fake.raw('cashManagement').entries()].map(([id, d]) => ({ id, ...d, ...(patch(d.date) || {}) }));
        fake.raw('cashManagement').clear();
        fake.seed('cashManagement', docs);
    };

    test('carry-forward and the opening check use the newest counted day even 11 days back', async () => {
        reseed(date => {
            if (date >= day(10)) return { counted: false, autoSignedOut: true, closingBalance: null };
            if (date === day(11)) return { closingBalance: 777 };
            return null;
        });
        await CashManagementManager.init();
        expect(document.getElementById('cashSignInAmount').value).toBe('777');
        expect(document.getElementById('cashSignInSuggestion').textContent).toContain(day(11));
        document.getElementById('cashSignInAmount').value = '500';
        await CashManagementManager.signIn();
        expect(UIManager.showModal.mock.calls[0][0]).toContain(`(${day(11)}) was ₹777`);
    });

    test('days closed without a count are listed even when far back, also without "Past cash days"', async () => {
        const uncounted = [day(3), day(40), day(200)];
        reseed(date => (uncounted.includes(date) ? { counted: false, autoSignedOut: true, closingBalance: null } : null));
        AppState.userRole = 'manager';
        AppState.settings = { roleAccess: { manager: { oldCashSessions: false } } };
        await CashManagementManager.init();
        const text = document.getElementById('cashHistoryList').textContent;
        expect(text).toContain('3 days closed without a cash count');
        expect(document.querySelectorAll('#cashHistoryList a[onclick*="showDetails"]')).toHaveLength(3);
        AppState.settings = {};
    });

    test('a past day left open is closed automatically even outside the window', async () => {
        reseed(date => (date === day(5) ? { signedOut: false, counted: null, closingBalance: null } : null));
        await CashManagementManager.init();
        expect(fake.raw('cashManagement').get(`s${day(5)}`)).toMatchObject({ signedOut: true, counted: false });
    });

    test('owner sees a day with two sessions from a targeted query, not only the loaded window', async () => {
        fake.seed('cashManagement', [{ id: 'legacyRandom', date: day(9), openingBalance: 1, signInTime: 'x', userId: 'u2', signedOut: true, counted: true, closingBalance: 1 }]);
        await CashManagementManager.init();
        await fake.settle();
        expect(document.getElementById('cashHistoryList').textContent).toContain('1 day has more than one cash session');
    });
});
