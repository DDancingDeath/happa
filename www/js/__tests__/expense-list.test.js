/**
 * @fileoverview Expenses list (#90): search, template chips and the section
 * totals (docs/calculations.md EXP-LIST). The totals are also checked against
 * an independent oracle in tests/oracle/expense-list.test.js.
 */
import fs from 'fs';
import path from 'path';
import { ExpensesManager } from '../modules/miscellaneous.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { expenseTemplates, expenseTotals, expenseTypes, filterExpenses } from '../utils/expense-list.js';

const TEMPLATE = fs.readFileSync(path.join(__dirname, '../../templates/expenses.html'), 'utf8');
const NOW = new Date(2026, 9, 31, 14, 5, 34);

const ROWS = [
    { id: 'a', category: 'business', type: 'Tea', personName: 'Ramu', amount: 20, remarks: 'morning', date: '31/10/2026, 9:00:00 am', timestamp: new Date(2026, 9, 31, 9).getTime() },
    { id: 'b', category: 'business', type: 'tea ', personName: 'Ramu', amount: '20', date: '30/10/2026, 9:00:00 am', timestamp: new Date(2026, 9, 30, 9).getTime() },
    { id: 'c', category: 'business', type: 'Labour', personName: 'Shyam', amount: 300, remarks: 'unloading truck', date: '15/10/2026, 5:00:00 pm', timestamp: new Date(2026, 9, 15, 17).getTime() },
    { id: 'd', category: 'business', type: 'Rent', amount: 5000, date: '30/09/2026, 10:00:00 am', timestamp: new Date(2026, 8, 30, 10).getTime() },
    { id: 'v', category: 'business', type: 'Diesel', amount: 900, date: '31/10/2026, 8:00:00 am', voided: true, timestamp: new Date(2026, 9, 31, 8).getTime() }
];

describe('expense-list helpers (#90)', () => {
    test('search: every word in type, name, remarks, amount or date; type filter ignores case and spaces', () => {
        expect(filterExpenses(ROWS, { text: 'ramu tea' }).map(e => e.id)).toEqual(['a', 'b']);
        expect(filterExpenses(ROWS, { text: 'TRUCK' }).map(e => e.id)).toEqual(['c']);
        expect(filterExpenses(ROWS, { text: '5000' }).map(e => e.id)).toEqual(['d']);
        expect(filterExpenses(ROWS, { type: 'TEA' }).map(e => e.id)).toEqual(['a', 'b']);
        expect(filterExpenses(ROWS, { text: 'morning', type: 'labour' })).toEqual([]);
        expect(filterExpenses(ROWS, {})).toHaveLength(ROWS.length);
    });

    test('types: distinct ignoring case and spaces, A–Z', () => {
        expect(expenseTypes(ROWS)).toEqual(['Diesel', 'Labour', 'Rent', 'Tea']);
    });

    test('templates: newest distinct type + name + amount that counts; never a voided one', () => {
        expect(expenseTemplates(ROWS)).toEqual([
            { type: 'Tea', personName: 'Ramu', amount: 20 },
            { type: 'Labour', personName: 'Shyam', amount: 300 },
            { type: 'Rent', personName: '', amount: 5000 }
        ]);
        expect(expenseTemplates(ROWS, 1)).toHaveLength(1);
    });

    test('totals: today and this month by the expense day, voided never; a search adds what it shows', () => {
        expect(expenseTotals(ROWS, { now: NOW, shown: filterExpenses(ROWS, { text: 'tea' }) })).toMatchObject({
            today: 20, todayCount: 1, month: 340, monthCount: 3, monthFrom: '2026-10-01', partialMonth: false, shown: 40, shownCount: 2
        });
        // history loaded only from the 20th: the month total is "since" that day
        expect(expenseTotals(ROWS, { now: NOW, loadedFrom: new Date(2026, 9, 20).getTime() })).toMatchObject({ monthFrom: '2026-10-20', partialMonth: true });
        expect(expenseTotals(ROWS, { now: NOW, loadedFrom: new Date(2026, 8, 1) }).partialMonth).toBe(false);
        // an expense saved after that day but dated before it (#118) is not in "since"
        const backDated = { id: 'bd', type: 'Tea', amount: 70, date: '05/10/2026, 10:00:00 am', timestamp: new Date(2026, 9, 21).getTime() };
        expect(expenseTotals([...ROWS, backDated], { now: NOW, loadedFrom: new Date(2026, 9, 20).getTime() }).month)
            .toBe(expenseTotals(ROWS, { now: NOW, loadedFrom: new Date(2026, 9, 20).getTime() }).month);
        expect(expenseTotals([...ROWS, backDated], { now: NOW }).month).toBe(410);
    });
});

describe('Expenses page: search, templates and totals (#90)', () => {
    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        jest.setSystemTime(NOW);
        document.body.innerHTML = TEMPLATE;
        jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        jest.spyOn(FirebaseService, 'voidedExpenses').mockReturnValue([]);
        AppState.currentUser = { uid: 'u1' };
        AppState.userRole = 'owner';
        AppState.settings = {};
        AppState.expensesHistory = ROWS.filter(e => !e.voided);
        window.app = { expenses: ExpensesManager };
        ExpensesManager.renderexpensesHistory();
    });
    afterEach(() => {
        ExpensesManager.search = { business: { text: '', type: '' }, personal: { text: '', type: '' } };
        jest.useRealTimers();
        jest.restoreAllMocks();
        delete window.app;
        AppState.expensesHistory = [];
        AppState.userRole = null;
    });

    const list = () => document.getElementById('businessExpenseHistoryList');
    const cards = () => list().querySelectorAll('.expense-card').length;

    test('totals line: today and this month; a search adds what it shows', () => {
        const totals = document.getElementById('businessExpenseTotals');
        expect(totals.textContent).toBe('Today ₹20 · This month ₹340');
        document.getElementById('businessExpenseSearch').value = 'ramu';
        ExpensesManager.onSearch('business');
        expect(cards()).toBe(2);
        expect(totals.textContent).toBe('Today ₹20 · This month ₹340 · 2 shown ₹40');
    });

    test('type filter lists the types; picking one narrows the list; no match says so', () => {
        const filter = document.getElementById('businessExpenseTypeFilter');
        expect([...filter.options].map(o => o.value)).toEqual(['', 'Labour', 'Rent', 'Tea']);
        filter.value = 'Labour';
        ExpensesManager.onSearch('business');
        expect(cards()).toBe(1);
        expect(document.getElementById('businessExpenseTypeFilter').value).toBe('Labour');
        document.getElementById('businessExpenseSearch').value = 'zzz';
        ExpensesManager.onSearch('business');
        expect(cards()).toBe(0);
        expect(list().textContent).toContain('No expenses match this search');
    });

    test('the picked type stays selected when a newer entry spells it in another case', () => {
        const filter = document.getElementById('businessExpenseTypeFilter');
        filter.value = 'Labour';
        ExpensesManager.onSearch('business');
        AppState.expensesHistory = [{ id: 'n', category: 'business', type: 'LABOUR', amount: 50, date: '31/10/2026, 11:00:00 am', timestamp: NOW.getTime() }, ...AppState.expensesHistory];
        ExpensesManager.renderexpensesHistory();
        expect(document.getElementById('businessExpenseTypeFilter').value).toBe('LABOUR');
        expect(cards()).toBe(2);
    });

    test('a template chip fills type, name and amount; nothing is saved', () => {
        const save = jest.spyOn(FirebaseService, 'startSaveExpense');
        const chips = document.querySelectorAll('#businessExpenseTemplates .expense-template-chip');
        expect([...chips].map(c => c.textContent)).toEqual(['Tea · Ramu · ₹20', 'Labour · Shyam · ₹300', 'Rent · ₹5,000']);
        chips[1].click();
        expect(['Type', 'Person', 'Amount'].map(n => document.getElementById(`businessExpense${n}`).value)).toEqual(['Labour', 'Shyam', '300']);
        expect(save).not.toHaveBeenCalled();
    });

    test('names are escaped in chips and the type filter', () => {
        AppState.expensesHistory = [{ id: 'x', category: 'business', type: '<img src=x onerror=alert(1)>', amount: 5, date: '31/10/2026, 9:00:00 am', timestamp: 1 }];
        ExpensesManager.renderexpensesHistory();
        expect(document.querySelector('#businessExpenseTemplates img')).toBeNull();
        expect(document.querySelector('#businessExpenseTypeFilter img')).toBeNull();
    });
});
