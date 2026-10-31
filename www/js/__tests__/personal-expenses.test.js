/**
 * Personal expenses in their own collection (#98): saved, edited and deleted
 * there with their key in the day doc; read only when the role may; the cash
 * count and Today add up the day doc on phones that didn't load the rows.
 */
import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';
import { canReadPersonalExpenses, dayDocTotals, personalDayFixes, personalDaysFromRows, personalForDay } from '../utils/personal-expenses.js';
import { toLocalISODate } from '../utils/dates.js';

const settle = async (fake, rounds = 10) => {
    for (let i = 0; i < rounds; i++) await fake.settle();
};

describe('personal expense helpers', () => {
    test('who reads them: owner always; others by Roles & access (default on)', () => {
        expect(canReadPersonalExpenses('owner', { owner: { personalExpenses: false } })).toBe(true);
        expect(canReadPersonalExpenses('staff', undefined)).toBe(true);
        expect(canReadPersonalExpenses('staff', { staff: { personalExpenses: false } })).toBe(false);
        expect(canReadPersonalExpenses('manager', { staff: { personalExpenses: false } })).toBe(true);
    });

    test('day docs: one key per expense; totals are the sum; fixes set or remove keys', () => {
        expect(dayDocTotals({ amounts: { a: 50, b: 25.25 } })).toEqual({ total: 75.25, count: 2 });
        expect(dayDocTotals(null)).toEqual({ total: 0, count: 0 });
        const want = personalDaysFromRows([
            { id: 'a', day: '2026-10-22', amount: 50 }, { id: 'b', date: '22/10/2026, 6:00:00 pm', amount: 10 },
            { id: 'c', day: '2026-10-21', amount: 5 }, { id: 'd', amount: 1 }
        ]);
        expect(want).toEqual({ '2026-10-22': { a: 50, b: 10 }, '2026-10-21': { c: 5 } });
        expect(personalDayFixes(want['2026-10-22'], { amounts: { a: 40, z: 9 } }))
            .toEqual([{ id: 'a', amount: 50 }, { id: 'b', amount: 10 }, { id: 'z', amount: null }]);
        expect(personalDayFixes(want['2026-10-22'], { amounts: { a: 50, b: 10 } })).toEqual([]);
    });

    test('a day: the rows when readable; else the rows still in expenses + the day total', () => {
        const rows = [{ amount: 50 }, { amount: 25.25 }];
        expect(personalForDay(rows, true, { total: 999, count: 9 })).toEqual({ total: 75.25, count: 2 });
        expect(personalForDay([], false, { total: 300, count: 2 })).toEqual({ total: 300, count: 2 });
        expect(personalForDay(rows, false, { total: 300, count: 2 })).toEqual({ total: 375.25, count: 4 });
        expect(personalForDay([], false, null)).toEqual({ total: 0, count: 0 });
    });
});

describe('FirebaseService personal expenses (#98)', () => {
    let fake;
    const NOW = Date.now();
    const today = toLocalISODate(new Date(NOW));
    const date = new Date(NOW).toISOString();

    beforeEach(() => {
        fake = createFakeFirestore();
        global.firebase = fake.firebase;
        fake.seed('items', []);
        AppState.currentUser = { uid: 'u1' };
        AppState.userName = 'U';
        AppState.settings = {};
        jest.spyOn(console, 'info').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        FirebaseService.cleanup();
        jest.restoreAllMocks();
        delete global.firebase;
        AppState.currentUser = null;
        AppState.userRole = null;
        AppState.settings = {};
    });

    const open = async (role, roleAccess) => {
        AppState.userRole = role;
        AppState.settings = { roleAccess };
        FirebaseService.cleanup();
        await FirebaseService.setupRealtimeListeners();
        await settle(fake);
    };

    test('saved in personalExpenses with its key in the day doc; edits and deletes follow; business stays in expenses', async () => {
        await open('staff');
        const { record, committed } = FirebaseService.startSaveExpense({ type: 'Food', amount: 80, category: 'personal', date });
        await committed;
        await FirebaseService.saveExpense({ type: 'Tea', amount: 20, category: 'business', date });
        await settle(fake);
        expect(fake.raw('personalExpenses').get(record.id)).toMatchObject({ amount: 80, category: 'personal', userId: 'u1', day: today });
        expect(fake.raw('expenses').size).toBe(1);
        expect(fake.raw('personalExpenseDays').get(today)).toEqual({ amounts: { [record.id]: 80 }, last: record.id });
        expect(AppState.expensesHistory.map(e => e.amount).sort()).toEqual([20, 80]);

        await FirebaseService.updateExpense(record.id, { amount: 65 });
        expect(fake.raw('personalExpenses').get(record.id).amount).toBe(65);
        expect(fake.raw('personalExpenseDays').get(today).amounts).toEqual({ [record.id]: 65 });

        AppState.expensesHistory = AppState.expensesHistory.filter(e => e.id !== record.id);
        await FirebaseService.deleteExpense(record.id);
        await settle(fake);
        expect(fake.raw('personalExpenses').has(record.id)).toBe(false);
        expect(fake.raw('personalExpenseDays').get(today).amounts).toEqual({});
        expect(AppState.expensesHistory.map(e => e.amount)).toEqual([20]);
    });

    test('saving again over a not-yet-confirmed personal expense keeps one key', async () => {
        await open('owner');
        const first = FirebaseService.startSaveExpense({ type: 'Food', amount: 80, category: 'personal', date });
        await first.committed;
        const again = FirebaseService.startSaveExpense({ type: 'Food', amount: 90, category: 'personal', date }, { id: first.record.id });
        await again.committed;
        await settle(fake);
        expect(fake.raw('personalExpenses').size).toBe(1);
        expect(dayDocTotals(fake.raw('personalExpenseDays').get(today))).toEqual({ total: 90, count: 1 });
    });

    test('a row moved from the old app (numeric id field) is edited and deleted in personalExpenses', async () => {
        fake.seed('personalExpenses', [{ id: 'doc1', amount: 30, category: 'personal', date, day: today, timestamp: NOW }]);
        fake.raw('personalExpenses').get('doc1').id = 1761020000000;
        fake.seed('personalExpenseDays', [{ id: today, amounts: { doc1: 30 } }]);
        await open('owner');
        const row = AppState.expensesHistory.find(e => e.amount === 30);
        expect(row.id).toBe(1761020000000);
        await FirebaseService.updateExpense(row.id, { amount: 35 });
        expect(fake.raw('personalExpenses').get('doc1').amount).toBe(35);
        AppState.expensesHistory = AppState.expensesHistory.filter(e => e !== row);
        await FirebaseService.deleteExpense(String(row.id));
        await settle(fake);
        expect(fake.raw('personalExpenses').has('doc1')).toBe(false);
        expect(fake.raw('personalExpenseDays').get(today).amounts).toEqual({});
        expect(AppState.expensesHistory).toEqual([]);
    });

    test('a role with Personal expenses off never queries them; it reads the day total instead', async () => {
        fake.seed('personalExpenses', [{ id: 'p1', amount: 80, category: 'personal', date, timestamp: NOW }]);
        fake.seed('personalExpenseDays', [{ id: today, amounts: { p1: 80 } }]);
        fake.seed('expenses', [{ id: 'b1', amount: 20, category: 'business', date, timestamp: NOW }]);

        await open('owner');
        expect(AppState.expensesHistory.map(e => e.id).sort()).toEqual(['b1', 'p1']);
        expect(FirebaseService.personalRowsLoaded()).toBe(true);

        fake.stats.listenLog.length = 0;
        fake.stats.queryLog.length = 0;
        await open('staff', { staff: { personalExpenses: false } });
        expect(AppState.expensesHistory.map(e => e.id)).toEqual(['b1']);
        expect(FirebaseService.personalRowsLoaded()).toBe(false);
        expect([...fake.stats.listenLog, ...fake.stats.queryLog.map(q => q.coll)]).not.toContain('personalExpenses');
        expect(await FirebaseService.loadPersonalExpenseDay(today)).toEqual({ total: 80, count: 1 });
        expect(FirebaseService.personalExpenseDay(today)).toEqual({ total: 80, count: 1 });
    });
});

describe('rows loaded or not (#98)', () => {
    afterEach(() => { AppState.userRole = null; jest.restoreAllMocks(); });

    test('only owner/manager phones whose personal listener delivered the rows write the shared snapshots', async () => {
        const { MoneyManager } = await import('../modules/money.js');
        const loaded = jest.spyOn(FirebaseService, 'personalRowsLoaded');
        const as = (role, rows) => { AppState.userRole = role; loaded.mockReturnValue(rows); return MoneyManager.writesSnapshots(); };
        expect(as('owner', true)).toBe(true);
        expect(as('owner', false)).toBe(false);
        expect(as('manager', true)).toBe(true);
        expect(as('manager', false)).toBe(false);
        expect(as('staff', true)).toBe(false);
    });

    test('auto-closing past days without the rows: a day whose total could not be loaded stays open', async () => {
        const { CashManagementManager } = await import('../modules/cash-management.js');
        jest.spyOn(FirebaseService, 'personalRowsLoaded').mockReturnValue(false);
        jest.spyOn(FirebaseService, 'loadPersonalExpenseDay').mockImplementation(async d => (d === '2026-10-20' ? { total: 30, count: 1 } : null));
        expect(await CashManagementManager.loadPersonalDays(['2026-10-20', '2026-10-21']))
            .toEqual({ '2026-10-20': { total: 30, count: 1 }, '2026-10-21': null });
        FirebaseService.personalRowsLoaded.mockReturnValue(true);
        expect(await CashManagementManager.loadPersonalDays(['2026-10-21'])).toEqual({ '2026-10-21': undefined });
    });
});

describe('rebuild of the day docs from the rows (#98)', () => {
    let fake;
    afterEach(() => {
        FirebaseService.cleanup();
        jest.restoreAllMocks();
        delete global.firebase;
        AppState.userRole = null;
    });

    test('an owner/manager phone sets wrong keys and removes stray ones; nothing when right', async () => {
        fake = createFakeFirestore();
        global.firebase = fake.firebase;
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        const now = Date.now();
        const today = toLocalISODate(new Date(now));
        fake.seed('items', []);
        fake.seed('personalExpenses', [
            { id: 'p1', amount: 80, category: 'personal', day: today, date: new Date(now).toISOString(), timestamp: now },
            { id: 'p2', amount: 20, category: 'personal', day: today, date: new Date(now).toISOString(), timestamp: now }
        ]);
        fake.seed('personalExpenseDays', [{ id: today, amounts: { p1: 5, gone: 99 } }]);
        AppState.currentUser = { uid: 'm1' };
        AppState.userRole = 'manager';
        AppState.settings = {};
        await FirebaseService.setupRealtimeListeners();
        await settle(fake);
        expect(await FirebaseService.rebuildPersonalExpenseDays([today])).toBe(3);
        expect(fake.raw('personalExpenseDays').get(today).amounts).toEqual({ p1: 80, p2: 20 });
        expect(await FirebaseService.rebuildPersonalExpenseDays([today])).toBe(0);
        AppState.currentUser = null;
    });
});
