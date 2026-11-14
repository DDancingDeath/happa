/**
 * Workers / Salaries (#373): owner only, read once per open, each tap writes one change, and the
 * month's state and cards come from utils/worker-pay.js (WP-*).
 */
jest.mock('../firebase/repos/workers.js', () => ({
    loadWorkers: jest.fn(),
    addWorker: jest.fn(),
    updateWorker: jest.fn(),
    addEntry: jest.fn(),
    removeEntry: jest.fn()
}));

import * as repo from '../firebase/repos/workers.js';
import { WorkersManager as W } from '../modules/workers.js';
import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { monthKeyOf, addMonthKey } from '../utils/worker-pay.js';
import { payDueReminder } from '../utils/pay-reminder.js';

const NOW = monthKeyOf(new Date());
const PREV = addMonthKey(NOW, -1);
const ramu = () => ({ id: 'w1', name: 'Ramu', startMonth: PREV, active: true, pays: [{ from: PREV, amount: 9000 }], entries: [
    { id: 'a', month: PREV, date: `${PREV}-28`, amount: 9000, kind: 'pay', mode: 'cash' },
    { id: 'b', month: NOW, date: `${NOW}-05`, amount: 3000, kind: 'advance', mode: 'cash' }
] });
const body = () => document.getElementById('workersBody');

beforeEach(() => {
    document.body.innerHTML = '<div id="workers" class="tab active"><div id="workersBody"></div></div><div id="toast"></div>';
    AppState.userRole = 'owner';
    jest.clearAllMocks();
    W.reset();
    repo.loadWorkers.mockResolvedValue([ramu()]);
    jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
});

test('a member or manager gets no read and no data', async () => {
    AppState.userRole = 'manager';
    await W.init();
    expect(repo.loadWorkers).not.toHaveBeenCalled();
    expect(body().textContent).toMatch(/Only the owner/);
});

test('the owner reads once per open; the month shows part-paid and the cards', async () => {
    await W.init();
    await W.init();
    expect(repo.loadWorkers).toHaveBeenCalledTimes(2);
    expect(body().querySelector('[data-worker="w1"] [data-wp-state]').textContent).toBe('Part-paid, ₹3,000 of ₹9,000');
    expect(body().querySelector('[data-worker="w1"] [data-wp-state]').className).toBe('tag');
    expect(body().querySelector('[data-worker="w1"] .tone-neg')).toBeNull();
    const card = (id) => body().querySelector(`[data-wp="${id}"]`).textContent;
    expect([card('WP-7'), card('WP-8'), card('WP-9'), card('WP-10')]).toEqual(['₹9,000', '₹3,000', '₹6,000', '₹0']);
    W.step(-1);
    expect(card('WP-8')).toBe('₹9,000');
    expect(body().querySelector('[data-worker="w1"] [data-wp-state]').textContent).toBe('Paid');
});

test('recording pay adds one entry; a bad amount writes nothing', async () => {
    await W.init();
    W.open('w1');
    W.showForm('pay');
    document.getElementById('wpAmount').value = '6000.5';
    await W.savePay();
    expect(repo.addEntry).not.toHaveBeenCalled();
    document.getElementById('wpAmount').value = '6000';
    await W.savePay();
    expect(repo.addEntry).toHaveBeenCalledTimes(1);
    expect(repo.addEntry.mock.calls[0][1]).toMatchObject({ month: NOW, amount: 6000, kind: 'pay', mode: 'cash' });
    expect(body().querySelector('[data-worker="w1"] [data-wp-state]').textContent).toBe('Paid');
});

test('a raise counts from its month; marking as left adds a pay of 0 after the last month', async () => {
    await W.init();
    W.open('w1');
    W.showForm('edit');
    document.getElementById('wpPay').value = '10000';
    await W.saveEdit();
    expect(repo.updateWorker).toHaveBeenLastCalledWith('w1', { name: 'Ramu', startMonth: PREV, pays: [{ from: PREV, amount: 9000 }, { from: NOW, amount: 10000 }] });
    W.showForm('left');
    await W.saveLeft();
    expect(repo.updateWorker).toHaveBeenLastCalledWith('w1', { active: false, pays: [{ from: PREV, amount: 9000 }, { from: NOW, amount: 10000 }, { from: addMonthKey(NOW, 1), amount: 0 }] });
});

test('a worker who left: the start month cannot move to or past the month pay stopped, so they can always work again', async () => {
    const stop = addMonthKey(NOW, 1);
    repo.loadWorkers.mockResolvedValue([{ ...ramu(), active: false, pays: [{ from: PREV, amount: 9000 }, { from: stop, amount: 0 }] }]);
    await W.init();
    W.open('w1');
    W.showForm('edit');
    expect(document.getElementById('wpPay')).toBeNull();
    expect(document.getElementById('wpStart').getAttribute('max')).toBe(NOW);
    document.getElementById('wpStart').value = stop;
    await W.saveEdit();
    expect(repo.updateWorker).not.toHaveBeenCalled();
    expect(UIManager.showToast).toHaveBeenLastCalledWith(expect.stringMatching(/before the month they stopped/), 'warning');
    await W.rejoin();
    expect(repo.updateWorker).toHaveBeenLastCalledWith('w1', { active: true, pays: [{ from: PREV, amount: 9000 }, { from: NOW, amount: 9000 }] });
});

test('working again with no earlier pay asks for the pay instead of a dead end', async () => {
    repo.loadWorkers.mockResolvedValue([{ ...ramu(), active: false, pays: [{ from: PREV, amount: 0 }] }]);
    await W.init();
    W.open('w1');
    await W.rejoin();
    expect(repo.updateWorker).not.toHaveBeenCalled();
    document.getElementById('wpPay').value = '8000';
    await W.saveEdit();
    expect(repo.updateWorker).toHaveBeenLastCalledWith('w1', { name: 'Ramu', startMonth: PREV, active: true, pays: [{ from: PREV, amount: 0 }, { from: NOW, amount: 8000 }] });
});

test('Today\'s salaries due (WP-11) is kept when the page loads and saves, without another read; the daily refresh reads once, owner only', async () => {
    localStorage.clear();
    AppState.currentUser = { uid: 'o1' };
    await W.init();
    expect(repo.loadWorkers).toHaveBeenCalledTimes(1);
    expect(payDueReminder(localStorage, 'o1', NOW)).toMatchObject({ count: 1, due: 6000 });
    W.open('w1');
    W.showForm('pay');
    document.getElementById('wpAmount').value = '6000';
    await W.savePay();
    expect(payDueReminder(localStorage, 'o1', NOW)).toBeNull();
    expect(repo.loadWorkers).toHaveBeenCalledTimes(1);

    localStorage.clear();
    W.reset();
    repo.loadWorkers.mockResolvedValue([ramu()]);
    expect(await W.refreshPayDue()).toBe(true);
    expect(repo.loadWorkers).toHaveBeenCalledTimes(2);
    expect(payDueReminder(localStorage, 'o1', NOW)).toMatchObject({ count: 1, due: 6000 });
    expect(payDueReminder(localStorage, 'o1', addMonthKey(NOW, 1))).toMatchObject({ count: 1, due: 15000 });
    AppState.userRole = 'manager';
    expect(await W.refreshPayDue()).toBe(false);
    expect(repo.loadWorkers).toHaveBeenCalledTimes(2);
    AppState.currentUser = null;
});

test('a background refresh still in flight when the page loads and saves never overwrites the page\'s newer figure', async () => {
    localStorage.clear();
    AppState.currentUser = { uid: 'o1' };
    let answer;
    repo.loadWorkers.mockReturnValueOnce(new Promise(r => { answer = r; }));
    const refresh = W.refreshPayDue();
    await W.init();
    W.open('w1');
    W.showForm('pay');
    document.getElementById('wpAmount').value = '6000';
    await W.savePay();
    expect(payDueReminder(localStorage, 'o1', NOW)).toBeNull();
    answer([ramu()]);
    expect(await refresh).toBe(false);
    expect(payDueReminder(localStorage, 'o1', NOW)).toBeNull();
    AppState.currentUser = null;
});