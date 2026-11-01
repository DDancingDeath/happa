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
    let toast;
    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        jest.setSystemTime(NOW);
        document.body.innerHTML = TEMPLATE;
        saved = [];
        modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
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
        if (day !== undefined) {
            setVal(`${category}ExpenseDate`, day);
            document.getElementById(`${category}ExpenseDate`).dispatchEvent(new Event('change'));
        }
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

    test('#129: the amount is saved in whole rupees, half-up; under 50 paise is not an amount', async () => {
        fill('business');
        setVal('businessExpenseAmount', '45.50');
        await ExpensesManager.saveBusinessExpense();
        fill('business');
        setVal('businessExpenseAmount', '0.4');
        await ExpensesManager.saveBusinessExpense();
        expect(saved.map(e => e.amount)).toEqual([46]);
        expect(modal).toHaveBeenLastCalledWith('Please enter a valid amount');
    });

    test('a day outside the window or in the future is refused with a message', async () => {
        fill('business', { day: '2026-10-27' });
        await ExpensesManager.saveBusinessExpense();
        fill('business', { day: '2026-11-01' });
        await ExpensesManager.saveBusinessExpense();
        expect(saved).toEqual([]);
        expect(modal.mock.calls.map(c => c[0])).toEqual(['You can enter an expense only up to 2 days back', "The date can't be in the future"]);
    });

    test('Void & re-enter (#99): voids with a reason, refills the form on the same day, saves a new expense linked by replacesId', async () => {
        const old = { id: 'x1', category: 'business', type: 'Tea', amount: 40, date: '30/10/2026, 9:00:00 am', day: '2026-10-30', userId: 'u1', createdBy: 'u1', timestamp: NOW.getTime() - 3600000 };
        AppState.expensesHistory = [old];
        const update = jest.spyOn(FirebaseService, 'updateExpense');
        const voidExpense = jest.spyOn(FirebaseService, 'voidExpense').mockResolvedValue({ ...old, voided: true });
        jest.spyOn(FirebaseService, 'loadCashSessionsForDate').mockResolvedValue([]);
        jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async (html) => {
            document.body.insertAdjacentHTML('beforeend', html);
            document.getElementById('reasonInput').value = 'wrong amount';
            return true;
        });
        ExpensesManager.viewExpenseDetails('x1', 'business');
        expect(document.getElementById('expenseReenterBtn').style.display).toBe('');
        await ExpensesManager.reenterExpenseFromModal();
        expect(voidExpense).toHaveBeenCalledWith('x1', 'wrong amount');
        expect(AuditService.log).toHaveBeenCalledWith('VOID_EXPENSE', expect.objectContaining({ expenseId: 'x1', reason: 'wrong amount' }));
        const date = document.getElementById('businessExpenseDate');
        expect([date.value, document.getElementById('businessExpenseAmount').value]).toEqual(['2026-10-30', '40']);
        setVal('businessExpenseAmount', 45);
        await ExpensesManager.saveBusinessExpense();
        expect(update).not.toHaveBeenCalled();
        expect(saved).toEqual([expect.objectContaining({ amount: 45, day: '2026-10-30', replacesId: 'x1' })]);
        // the next save is a plain new expense again
        fill('business');
        await ExpensesManager.saveBusinessExpense();
        expect(saved[1].replacesId).toBeUndefined();
    });

    test('void needs a reason and the internet; out of the window it is refused', async () => {
        const old = { id: 'x1', category: 'business', type: 'Tea', amount: 40, date: '30/10/2026, 9:00:00 am', day: '2026-10-30', userId: 'u1', createdBy: 'u1', timestamp: NOW.getTime() - 3600000 };
        AppState.expensesHistory = [old];
        const voidExpense = jest.spyOn(FirebaseService, 'voidExpense').mockResolvedValue({ ...old, voided: true });
        jest.spyOn(FirebaseService, 'loadCashSessionsForDate').mockResolvedValue([]);
        const ask = jest.spyOn(UIManager, 'showModalWithHtml').mockResolvedValue(true);
        ExpensesManager.viewExpenseDetails('x1', 'business');
        await ExpensesManager.voidExpenseFromModal();
        expect(voidExpense).not.toHaveBeenCalled();
        expect(toast).toHaveBeenLastCalledWith('Write a reason (at least 3 letters).');
        const offline = jest.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        ExpensesManager.viewExpenseDetails('x1', 'business');
        await ExpensesManager.voidExpenseFromModal();
        offline.mockRestore();
        expect(toast).toHaveBeenLastCalledWith('Voiding an expense needs the internet.');
        AppState.expensesHistory = [{ ...old, timestamp: NOW.getTime() - 3 * 86400000 }];
        ExpensesManager.viewExpenseDetails('x1', 'business');
        expect(document.getElementById('expenseVoidBtn').style.display).toBe('none');
        await ExpensesManager.voidExpenseFromModal();
        expect(ask).toHaveBeenCalledTimes(1);
        expect(voidExpense).not.toHaveBeenCalled();
    });

    test('Void & re-enter is refused before the void when the day is past the back-dating window (plain Void stays)', async () => {
        // saved an hour ago, back-dated to 27 Oct: inside the void window, outside today's back-dating window
        const old = { id: 'x1', category: 'business', type: 'Tea', amount: 40, date: '27/10/2026, 9:00:00 am', day: '2026-10-27', userId: 'u1', createdBy: 'u1', timestamp: NOW.getTime() - 3600000 };
        AppState.expensesHistory = [old];
        const voidExpense = jest.spyOn(FirebaseService, 'voidExpense').mockResolvedValue({ ...old, voided: true });
        ExpensesManager.viewExpenseDetails('x1', 'business');
        expect(document.getElementById('expenseVoidBtn').style.display).toBe('');
        expect(document.getElementById('expenseReenterBtn').style.display).toBe('none');
        await ExpensesManager.reenterExpenseFromModal();
        expect(voidExpense).not.toHaveBeenCalled();
        expect(toast.mock.calls.at(-1)[0]).toMatch(/older than you can enter now/);
    });

    test('the void dialog says whether the cash goes back into the drawer or that day is closed', async () => {
        const old = { id: 'x1', category: 'business', type: 'Tea', amount: 40, date: '30/10/2026, 9:00:00 am', day: '2026-10-30', userId: 'u1', createdBy: 'u1', timestamp: NOW.getTime() - 3600000 };
        AppState.expensesHistory = [old];
        const sessions = jest.spyOn(FirebaseService, 'loadCashSessionsForDate').mockResolvedValue([]);
        const ask = jest.spyOn(UIManager, 'showModalWithHtml').mockResolvedValue(false);
        ExpensesManager.viewExpenseDetails('x1', 'business');
        await ExpensesManager.voidExpenseFromModal();
        expect(ask.mock.calls[0][0]).toMatch(/cash goes back into that day/);
        sessions.mockResolvedValue([{ date: '2026-10-30', signedOut: true }]);
        ExpensesManager.viewExpenseDetails('x1', 'business');
        await ExpensesManager.voidExpenseFromModal();
        expect(ask.mock.calls[1][0]).toMatch(/already closed/);
    });

    test('voided expenses: off the list unless "Show voided" (struck through, with the reason in the details)', () => {
        AppState.expensesHistory = [{ id: 'a1', category: 'business', type: 'Tea', amount: 40, date: '30/10/2026, 9:00:00 am' }];
        jest.spyOn(FirebaseService, 'voidedExpenses').mockReturnValue([
            { id: 'v1', category: 'business', type: 'Diesel', amount: 90, date: '30/10/2026, 8:00:00 am', voided: true, voidReason: 'typed twice', voidedByName: 'Owner' }
        ]);
        ExpensesManager.renderexpensesHistory();
        const list = () => document.getElementById('businessExpenseHistoryList');
        expect(list().textContent).not.toContain('Diesel');
        ExpensesManager.toggleVoided(true);
        expect(list().querySelectorAll('.expense-card--voided')).toHaveLength(1);
        expect(list().textContent).toContain('Diesel');
        ExpensesManager.viewExpenseDetails('v1', 'business');
        expect(document.getElementById('expenseDetailsContent').textContent).toContain('typed twice');
        expect(document.getElementById('expenseVoidBtn').style.display).toBe('none');
        ExpensesManager.toggleVoided(false);
    });

    test('a form left open over midnight saves on the new day; showing it again moves the inputs', async () => {
        jest.setSystemTime(new Date(2026, 9, 31, 23, 58));
        ExpensesManager.renderexpensesHistory();
        const date = document.getElementById('businessExpenseDate');
        expect([date.value, date.max]).toEqual(['2026-10-31', '2026-10-31']);
        jest.setSystemTime(new Date(2026, 10, 1, 0, 2));
        fill('business');
        await ExpensesManager.saveBusinessExpense();
        expect(saved[0]).toMatchObject({ day: '2026-11-01', date: new Date(2026, 10, 1, 0, 2).toLocaleString('en-IN') });
        // the app shown again the next day, then the Expenses tab the day after
        jest.setSystemTime(new Date(2026, 10, 2, 9, 0));
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
        expect([date.value, date.max, date.min]).toEqual(['2026-11-02', '2026-11-02', '2026-10-31']);
        jest.setSystemTime(new Date(2026, 10, 3, 9, 0));
        window.dispatchEvent(new CustomEvent('aadhat:tabshown', { detail: { tabId: 'expenses' } }));
        expect([date.value, date.max]).toEqual(['2026-11-03', '2026-11-03']);
        delete document.visibilityState;
    });

    test('a day the user picked stays picked over midnight; picking today follows the clock', async () => {
        jest.setSystemTime(new Date(2026, 9, 31, 23, 58));
        ExpensesManager.renderexpensesHistory();
        fill('business', { day: '2026-10-30' });
        fill('personal', { day: '2026-10-31' });
        jest.setSystemTime(new Date(2026, 10, 1, 0, 2));
        await ExpensesManager.saveBusinessExpense();
        await ExpensesManager.savePersonalExpense();
        expect(saved.map(e => e.day)).toEqual(['2026-10-30', '2026-11-01']);
    });

    test('a back-dated cash expense on a closed cash day says that day won\'t change', async () => {
        const load = jest.spyOn(FirebaseService, 'loadCashSessionsForDate')
            .mockResolvedValueOnce([{ id: 'cash_2026-10-30', date: '2026-10-30', signedOut: true, counted: true }])
            .mockResolvedValueOnce([{ id: 'cash_2026-10-29', date: '2026-10-29', signedOut: false }]);
        fill('business', { day: '2026-10-30' });
        await ExpensesManager.saveBusinessExpense();
        fill('business', { day: '2026-10-29' });
        await ExpensesManager.saveBusinessExpense();
        fill('business', { day: '2026-10-30', mode: 'online' });
        await ExpensesManager.saveBusinessExpense();
        fill('business');
        await ExpensesManager.saveBusinessExpense();
        expect(load.mock.calls.map(c => c[0])).toEqual(['2026-10-30', '2026-10-29']);
        expect(toast.mock.calls).toEqual([
            ["✓ Business expense saved. That day's cash is already closed; its figures won't change", 5000],
            ['✓ Business expense saved'], ['✓ Business expense saved'], ['✓ Business expense saved']
        ]);
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
