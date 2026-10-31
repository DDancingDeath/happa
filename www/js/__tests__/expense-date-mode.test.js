/**
 * @fileoverview Expenses: the date and the cash / online mode (#118). Which
 * days a role may pick, the check before saving, the stored fields, the
 * Expenses form (new, back-dated, edit keeps the date) and the day book row.
 * The figures (Today T8 / T9, drawer C3, Money M13) are checked against the
 * oracle in tests/oracle/screens.test.js.
 */
import fs from 'fs';
import path from 'path';
import { ExpensesManager } from '../modules/miscellaneous.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { UIManager } from '../ui/ui-manager.js';
import { AuditService } from '../services/audit.js';
import { AppState } from '../utils/state.js';
import { expenseMode, isOnlineExpense } from '../utils/money.js';
import { expenseDateFields, expenseDayRange, validateExpenseEntry } from '../utils/expense-entry.js';
import { dayBook } from '../utils/statements.js';

const TEMPLATE = fs.readFileSync(path.join(__dirname, '../../templates/expenses.html'), 'utf8');
const NOW = new Date(2026, 9, 31, 14, 5, 34);
const setVal = (id, v) => { document.getElementById(id).value = String(v); };

describe('EXP-MODE and the day a new expense may have', () => {
    test('no mode, or anything but online, is cash', () => {
        expect([{}, { paymentMode: 'cash' }, { paymentMode: ' Online ' }, { paymentMode: 'card' }, null].map(expenseMode))
            .toEqual(['cash', 'cash', 'online', 'cash', 'cash']);
        expect(isOnlineExpense({ paymentMode: 'online' })).toBe(true);
    });

    test('days: owner any past day; others the role edit window (default 2 days)', () => {
        expect(expenseDayRange({ role: 'owner', now: NOW })).toEqual({ max: '2026-10-31', min: null, days: Infinity });
        expect(expenseDayRange({ role: 'staff', now: NOW })).toEqual({ max: '2026-10-31', min: '2026-10-29', days: 2 });
        expect(expenseDayRange({ role: 'manager', roleAccess: { manager: { editDays: 0 } }, now: NOW }).min).toBe('2026-10-31');
    });

    test.each([
        [{ day: '2026-10-31', mode: 'cash' }, 'staff', null],
        [{ day: '2026-10-29', mode: 'online' }, 'staff', null],
        [{ day: '2026-10-28', mode: 'cash' }, 'staff', { key: 'msg.expenses.date_too_old', params: { days: 2 } }],
        [{ day: '2026-11-01', mode: 'cash' }, 'owner', { key: 'msg.expenses.date_in_future' }],
        [{ day: '2025-01-15', mode: 'cash' }, 'owner', null],
        [{ day: '2026-10-31', mode: 'upi' }, 'owner', { key: 'msg.expenses.choose_mode' }],
        [{ day: '', mode: 'cash' }, 'owner', { key: 'msg.expenses.choose_date' }]
    ])('%j by %s → %j', (entry, role, want) => {
        expect(validateExpenseEntry(entry, { role, now: NOW })).toEqual(want);
    });

    test('a role with no edit window may enter only today', () => {
        expect(validateExpenseEntry({ day: '2026-10-30', mode: 'cash' }, { role: 'staff', roleAccess: { staff: { editDays: 0 } }, now: NOW }))
            .toEqual({ key: 'msg.expenses.date_today_only' });
    });

    test('stored date: now for today; an earlier day at the current time of day', () => {
        expect(expenseDateFields('2026-10-31', NOW)).toEqual({ day: '2026-10-31', date: NOW.toLocaleString('en-IN') });
        expect(expenseDateFields('2026-10-29', NOW)).toEqual({ day: '2026-10-29', date: new Date(2026, 9, 29, 14, 5, 34).toLocaleString('en-IN') });
    });
});

describe('Expenses form (#118)', () => {
    let saved;
    let modal;
    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        jest.setSystemTime(NOW);
        document.body.innerHTML = TEMPLATE;
        saved = [];
        modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
        jest.spyOn(UIManager, 'withLoading').mockImplementation(async (fn) => fn());
        jest.spyOn(AuditService, 'log').mockResolvedValue(undefined);
        jest.spyOn(FirebaseService, 'startSaveExpense').mockImplementation((expense) => {
            saved.push({ ...expense });
            return { record: { ...expense, id: `e${saved.length}` }, committed: Promise.resolve(), stored: Promise.resolve(true) };
        });
        AppState.currentUser = { uid: 'u1' };
        AppState.userName = 'Staff';
        AppState.userRole = 'staff';
        AppState.settings = {};
        AppState.expensesHistory = [];
        window.app = {};
        ExpensesManager.renderexpensesHistory();
    });
    afterEach(() => {
        ExpensesManager.cancelExpenseEdit();
        jest.useRealTimers();
        jest.restoreAllMocks();
        delete window.app;
        AppState.expensesHistory = [];
        AppState.userRole = null;
    });

    const fill = (category, { day, mode } = {}) => {
        setVal(`${category}ExpenseType`, 'Diesel');
        setVal(`${category}ExpenseAmount`, 500);
        if (day !== undefined) setVal(`${category}ExpenseDate`, day);
        if (mode !== undefined) setVal(`${category}ExpenseMode`, mode);
    };

    test('opens on today and cash, limited to the role window', () => {
        const date = document.getElementById('businessExpenseDate');
        expect([date.value, date.max, date.min]).toEqual(['2026-10-31', '2026-10-31', '2026-10-29']);
        expect(document.getElementById('personalExpenseMode').value).toBe('cash');
    });

    test('a new expense saves its day and mode; the save time stays in timestamp', async () => {
        fill('business');
        await ExpensesManager.saveBusinessExpense();
        fill('personal', { day: '2026-10-30', mode: 'online' });
        await ExpensesManager.savePersonalExpense();
        expect(saved).toEqual([
            expect.objectContaining({ category: 'business', paymentMode: 'cash', day: '2026-10-31', date: NOW.toLocaleString('en-IN'), timestamp: NOW.getTime() }),
            expect.objectContaining({ category: 'personal', paymentMode: 'online', day: '2026-10-30', date: new Date(2026, 9, 30, 14, 5, 34).toLocaleString('en-IN'), timestamp: NOW.getTime() })
        ]);
        // the form is back on today and cash
        expect([document.getElementById('personalExpenseDate').value, document.getElementById('personalExpenseMode').value]).toEqual(['2026-10-31', 'cash']);
    });

    test('a day outside the window or in the future is refused with a message', async () => {
        fill('business', { day: '2026-10-27' });
        await ExpensesManager.saveBusinessExpense();
        fill('business', { day: '2026-11-01' });
        await ExpensesManager.saveBusinessExpense();
        expect(saved).toEqual([]);
        expect(modal.mock.calls.map(c => c[0])).toEqual(['You can enter an expense only up to 2 days back', "The date can't be in the future"]);
    });

    test('editing keeps the date and may correct the mode', async () => {
        const old = { id: 'x1', category: 'business', type: 'Tea', amount: 40, date: '30/10/2026, 9:00:00 am', day: '2026-10-30', userId: 'u1', createdBy: 'u1', timestamp: NOW.getTime() - 3600000 };
        AppState.expensesHistory = [old];
        AppState.userRole = 'owner';
        const update = jest.spyOn(FirebaseService, 'updateExpense').mockResolvedValue();
        await ExpensesManager.editExpense('x1', 'business');
        const date = document.getElementById('businessExpenseDate');
        expect([date.value, date.disabled, document.getElementById('businessExpenseMode').value]).toEqual(['2026-10-30', true, 'cash']);
        setVal('businessExpenseMode', 'online');
        await ExpensesManager.saveBusinessExpense();
        expect(update).toHaveBeenCalledWith('x1', expect.objectContaining({ amount: 40, paymentMode: 'online' }));
        const fields = update.mock.calls[0][1];
        expect('date' in fields || 'day' in fields || 'timestamp' in fields).toBe(false);
        expect([date.value, date.disabled]).toEqual(['2026-10-31', false]);
    });

    test('lists and details say how it was paid (no mode = cash)', () => {
        AppState.expensesHistory = [
            { id: 'a', category: 'business', type: 'Tea', amount: 40, date: '31/10/2026, 9:00:00 am' },
            { id: 'b', category: 'business', type: 'Rent', amount: 900, date: '31/10/2026, 10:00:00 am', paymentMode: 'online' }
        ];
        ExpensesManager.renderexpensesHistory();
        const text = document.getElementById('businessExpenseHistoryList').textContent;
        expect(text).toMatch(/10:00:00 am • Online/);
        expect(text).toMatch(/9:00:00 am • Cash/);
    });
});

describe('Statements day book (ST1)', () => {
    test('an expense row is cash or online by its mode', () => {
        const { rows } = dayBook({
            expenses: [
                { id: 'a', date: '2026-10-21', amount: 40, category: 'business' },
                { id: 'b', date: '2026-10-21', amount: 90, category: 'business', paymentMode: 'online' }
            ]
        }, { from: new Date(2026, 9, 21).getTime(), to: new Date(2026, 9, 22).getTime() });
        expect(rows.map(r => [r.amount, r.cash, r.online])).toEqual([[40, 40, 0], [90, 0, 90]]);
    });
});
