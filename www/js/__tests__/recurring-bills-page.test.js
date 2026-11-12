/**
 * Recurring bills (#437): owner only, read once per open, each tap writes one entry, an unusual bill
 * asks once and never blocks, and Today's figure (RB-11) is kept without another read.
 */
jest.mock('../firebase/repos/recurring-bills.js', () => ({
    loadBillItems: jest.fn(),
    addBillItem: jest.fn(),
    updateBillItem: jest.fn(),
    addEntry: jest.fn(),
    removeEntry: jest.fn()
}));

import * as repo from '../firebase/repos/recurring-bills.js';
import { RecurringBillsManager as R } from '../modules/recurring-bills.js';
import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { monthKeyOf, addMonthKey } from '../utils/recurring-bills.js';
import { billsDueReminder } from '../utils/pay-reminder.js';
import { todayLocalISO } from '../utils/dates.js';

const NOW = monthKeyOf(new Date());
const TODAY = todayLocalISO();
const PREV = addMonthKey(NOW, -1);
// Monthly water bill due on the 1st, started last month: last month's ₹400 was paid; this month's ₹450 is entered, ₹200 paid
const water = () => ({ id: 'b1', name: 'Water', cadence: 1, dueDay: 1, startMonth: PREV, expected: 0, active: true, endMonth: '', note: '', entries: [
    { id: 'x1', kind: 'bill', period: PREV, date: `${PREV}-01`, amount: 400 },
    { id: 'x2', kind: 'pay', period: PREV, date: `${PREV}-02`, amount: 400, mode: 'cash' },
    { id: 'x3', kind: 'bill', period: NOW, date: `${NOW}-01`, amount: 450 },
    { id: 'x4', kind: 'pay', period: NOW, date: `${NOW}-01`, amount: 200, mode: 'online' }
] });
const body = () => document.getElementById('recurringBody');
const tag = () => body().querySelector('[data-rbill="b1"] [data-rb-state]');
const card = (id) => body().querySelector(`[data-rb="${id}"]`).textContent;

beforeEach(() => {
    document.body.innerHTML = '<div id="recurring" class="tab active"><div id="recurringBody"></div></div><div id="toast"></div>';
    AppState.userRole = 'owner';
    AppState.currentUser = { uid: 'o1' };
    localStorage.clear();
    jest.clearAllMocks();
    R.reset();
    repo.loadBillItems.mockResolvedValue([water()]);
    jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
});
afterAll(() => { AppState.currentUser = null; });

test('a manager or member gets no read and no data', async () => {
    for (const role of ['manager', 'staff']) {
        AppState.userRole = role;
        await R.init();
        expect(body().textContent).toMatch(/Only the owner/);
    }
    expect(repo.loadBillItems).not.toHaveBeenCalled();
    expect(await R.refreshBillsDue()).toBe(false);
    expect(repo.loadBillItems).not.toHaveBeenCalled();
});

test('the owner reads once per open; the period is overdue (past the 1st) with its cards', async () => {
    await R.init();
    await R.init();
    expect(repo.loadBillItems).toHaveBeenCalledTimes(2);
    const day1 = TODAY.endsWith('-01');
    expect(tag().textContent).toBe(day1 ? 'Part-paid, ₹200 of ₹450' : 'Overdue, ₹250');
    expect([card('RB-8'), card('RB-9'), card('RB-5')]).toEqual(['₹250', '₹200', '₹0']);
});

test('paying the rest adds one entry and the bill shows paid; a bad amount writes nothing', async () => {
    await R.init();
    R.open('b1');
    R.showForm('pay');
    expect(document.getElementById('rbAmount').value).toBe('250');
    expect(document.getElementById('rbPeriod').value).toBe(NOW);
    document.getElementById('rbAmount').value = '12.5';
    await R.savePay();
    expect(repo.addEntry).not.toHaveBeenCalled();
    document.getElementById('rbAmount').value = '250';
    await R.savePay();
    expect(repo.addEntry).toHaveBeenCalledTimes(1);
    expect(repo.addEntry.mock.calls[0][1]).toMatchObject({ kind: 'pay', period: NOW, date: TODAY, amount: 250, mode: 'cash' });
    expect(tag().textContent).toBe('Paid');
});

test('a bill over 3× the last one asks "Yes, it\'s right" once and is saved after it; a correction is a new entry', async () => {
    const item = { ...water(), entries: water().entries.slice(0, 2) };
    repo.loadBillItems.mockResolvedValue([item]);
    await R.init();
    R.open('b1');
    R.showForm('bill');
    expect(document.getElementById('rbPeriod').value).toBe(NOW);
    document.getElementById('rbAmount').value = '4500';
    await R.saveBill();
    expect(repo.addEntry).not.toHaveBeenCalled();
    expect(document.getElementById('rbUnusual').textContent).toContain('₹400');
    await R.saveBill(true);
    expect(repo.addEntry).toHaveBeenCalledTimes(1);
    expect(repo.addEntry.mock.calls[0][1]).toMatchObject({ kind: 'bill', period: NOW, amount: 4500 });
    R.showForm('bill');
    document.getElementById('rbPeriod').value = NOW;
    document.getElementById('rbAmount').value = '450';
    await R.saveBill();
    expect(repo.addEntry).toHaveBeenCalledTimes(2);
    expect(body().querySelector(`tr[data-period="${NOW}"]`).textContent).toContain('₹450');
});

test('adding an item, editing it (schedule fixed once there are entries) and stopping it', async () => {
    repo.loadBillItems.mockResolvedValue([]);
    repo.addBillItem.mockResolvedValue('n1');
    await R.init();
    R.showForm('add');
    document.getElementById('rbName').value = 'Electricity';
    document.getElementById('rbCadence').value = '2';
    document.getElementById('rbDueDay').value = '29';
    await R.saveItem();
    expect(repo.addBillItem).not.toHaveBeenCalled();
    document.getElementById('rbDueDay').value = '10';
    await R.saveItem();
    expect(repo.addBillItem).toHaveBeenCalledWith({ name: 'Electricity', cadence: 2, dueDay: 10, startMonth: NOW, expected: 0, note: '' });
    R.showForm('edit');
    expect(document.getElementById('rbCadence').disabled).toBe(false);
    document.getElementById('rbExpected').value = '1200';
    await R.saveEdit();
    expect(repo.updateBillItem).toHaveBeenLastCalledWith('n1', { name: 'Electricity', cadence: 2, dueDay: 10, startMonth: NOW, expected: 1200, note: '' });
    R.showForm('stop');
    await R.saveStop();
    expect(repo.updateBillItem).toHaveBeenLastCalledWith('n1', { active: false, endMonth: NOW });

    repo.loadBillItems.mockResolvedValue([water()]);
    await R.init();
    R.open('b1');
    R.showForm('edit');
    expect(document.getElementById('rbCadence').disabled).toBe(true);
    document.getElementById('rbName').value = 'Jal';
    await R.saveEdit();
    expect(repo.updateBillItem).toHaveBeenLastCalledWith('b1', { name: 'Jal', dueDay: 1, expected: 0, note: '' });
});

test('stopping before a month that already has a bill asks first; No writes nothing', async () => {
    const it = { ...water(), entries: [...water().entries, { id: 'x5', kind: 'bill', period: addMonthKey(NOW, 1), date: TODAY, amount: 500 }] };
    repo.loadBillItems.mockResolvedValue([it]);
    const modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(false);
    await R.init();
    R.open('b1');
    R.showForm('stop');
    document.getElementById('rbLastMonth').value = NOW;
    await R.saveStop();
    expect(modal.mock.calls[0][0]).toMatch(/A bill is already entered for .* Stop anyway\?/);
    expect(repo.updateBillItem).not.toHaveBeenCalled();
    modal.mockResolvedValue(true);
    await R.saveStop();
    expect(repo.updateBillItem).toHaveBeenCalledWith('b1', { active: false, endMonth: NOW });
});

test('only a payment can be removed, exactly as loaded', async () => {
    jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
    await R.init();
    R.open('b1');
    await R.removeEntry('b1', 'x3');
    expect(repo.removeEntry).not.toHaveBeenCalled();
    await R.removeEntry('b1', 'x4');
    expect(repo.removeEntry).toHaveBeenCalledWith('b1', water().entries[3]);
});

test('Today\'s bills due (RB-11) is kept when the page loads and saves, with no other read; the daily refresh reads once', async () => {
    await R.init();
    expect(billsDueReminder(localStorage, 'o1', TODAY)).toMatchObject({ count: 1, due: 250, nobill: 0 });
    R.open('b1');
    R.showForm('pay');
    await R.savePay();
    expect(billsDueReminder(localStorage, 'o1', TODAY)).toBeNull();
    expect(repo.loadBillItems).toHaveBeenCalledTimes(1);

    localStorage.clear();
    R.reset();
    repo.loadBillItems.mockResolvedValue([water()]);
    expect(await R.refreshBillsDue()).toBe(true);
    expect(repo.loadBillItems).toHaveBeenCalledTimes(2);
    expect(billsDueReminder(localStorage, 'o1', TODAY)).toMatchObject({ count: 1, due: 250 });
});

test('a background refresh still in flight when the page loads and saves never overwrites the page\'s newer figure', async () => {
    let answer;
    repo.loadBillItems.mockReturnValueOnce(new Promise(r => { answer = r; }));
    const refresh = R.refreshBillsDue();
    await R.init();
    R.open('b1');
    R.showForm('pay');
    await R.savePay();
    expect(billsDueReminder(localStorage, 'o1', TODAY)).toBeNull();
    answer([water()]);
    expect(await refresh).toBe(false);
    expect(billsDueReminder(localStorage, 'o1', TODAY)).toBeNull();
});
