/**
 * @jest-environment jsdom
 */
/** Today › Cash shows the Cash page's own body, never a copy (#96). */
import fs from 'fs';
import path from 'path';
import { DayManager } from '../modules/day.js';
import { CashManagementManager } from '../modules/cash-management.js';

const tpl = (name) => fs.readFileSync(path.resolve(__dirname, `../../templates/${name}.html`), 'utf8');
const duplicateIds = () => {
    const seen = new Set();
    return [...document.querySelectorAll('[id]')].map(el => el.id).filter(id => seen.has(id) || !seen.add(id));
};

beforeEach(() => {
    document.body.innerHTML = tpl('day') + tpl('cash-management');
    window.app = { cashManagement: { init: jest.fn().mockResolvedValue() } };
    jest.spyOn(DayManager, 'loadTodayData').mockImplementation(() => {});
    jest.spyOn(DayManager, 'loadTodaySession').mockImplementation(() => {});
    DayManager.currentSubTab = 'today';
});
afterEach(() => {
    jest.restoreAllMocks();
    delete window.app;
});

test('opening Today › Cash moves the cash body: one copy of every id', () => {
    expect(duplicateIds()).toEqual([]);
    DayManager.showSubTab('cash');
    expect(duplicateIds()).toEqual([]);
    expect(document.querySelectorAll('.cash-body')).toHaveLength(1);
    expect(document.querySelector('#dayCashManagementContainer .cash-body #statusAvailable')).not.toBeNull();
    expect(window.app.cashManagement.init).toHaveBeenCalledTimes(1);
    DayManager.showSubTab('cash');
    expect(duplicateIds()).toEqual([]);
});

test('the Cash page takes the body back; Today › Cash takes it again when Today is the open page', () => {
    DayManager.showSubTab('cash');
    DayManager.returnCashBody();
    expect(document.querySelector('#cash-management > .cash-body')).not.toBeNull();
    expect(document.getElementById('dayCashManagementContainer').children).toHaveLength(0);
    DayManager.init();
    expect(document.querySelector('#cash-management > .cash-body')).not.toBeNull();
    document.getElementById('day').classList.add('active');
    DayManager.init();
    expect(document.querySelector('#dayCashManagementContainer > .cash-body')).not.toBeNull();
    expect(duplicateIds()).toEqual([]);
});

test('a second tap while init runs shares it', async () => {
    const first = DayManager.loadCashManagement();
    DayManager.loadCashManagement();
    expect(window.app.cashManagement.init).toHaveBeenCalledTimes(1);
    await first;
    DayManager.loadCashManagement();
    expect(window.app.cashManagement.init).toHaveBeenCalledTimes(2);
});

test('the moved fields get their listeners once, however often init runs', async () => {
    for (const m of ['loadRecentSessions', 'autoSignOutPreviousDays', 'loadTodaySessionFromCache', 'calculateTodayTransactions',
        'updateUI', 'loadCustomerOptions', 'renderHistoryFromCache', 'loadDuplicateDays', 'updateTransactionForm']) {
        jest.spyOn(CashManagementManager, m).mockImplementation(() => Promise.resolve([]));
    }
    const due = jest.spyOn(CashManagementManager, 'populateDueBills').mockImplementation(() => {});
    await CashManagementManager.init();
    DayManager.showSubTab('cash');
    await CashManagementManager.init();
    document.getElementById('partyName').dispatchEvent(new Event('input'));
    expect(due).toHaveBeenCalledTimes(1);
});