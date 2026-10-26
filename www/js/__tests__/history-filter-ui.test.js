/**
 * @fileoverview #160: History type chips + date presets in the History
 * screen — remembered for the session, paging/search still work, and ranges
 * older than the loaded window load on demand with a progress notice.
 */

jest.mock('../firebase/firestore-service.js', () => ({ FirebaseService: { db: null } }));
jest.mock('../services/printer.js', () => ({ PrinterService: {} }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(), ACTIONS: {} } }));
jest.mock('../ui/infinite-scroll.js', () => ({ attachOlderHistoryScroll: jest.fn() }));

import { AppState } from '../utils/state.js';
import { HistoryManager } from '../modules/history.js';
import { HISTORY_FILTER_KEY, HISTORY_TAB_KEY } from '../utils/history-filters.js';
import { UIManager } from '../ui/ui-manager.js';

const day = (offset, h = 10) => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate() + offset, h).getTime();
};
const bill = (id, timestamp, extra = {}) => ({ id, billNumber: id, timestamp, items: [{ name: 'Wheat', qty: 1, rate: 1 }], total: 1, ...extra });

const html = `
    <div id="history">
      <div class="history-type-filter">
        <button class="filter-btn" data-type="purchase"></button><button class="filter-btn" data-type="sale"></button>
      </div>
      <select id="historyDatePreset"><option value="all"></option><option value="today"></option>
        <option value="yesterday"></option><option value="week"></option><option value="month"></option>
        <option value="lastMonth"></option><option value="custom"></option></select>
      <div id="historyCustomRange" hidden><input id="historyFromDate"><input id="historyToDate"></div>
      <div id="historyRangeLabel" hidden></div>
      <input id="historySearch" value="">
      <div id="wrap"><div id="historyList"></div></div>
    </div>`;

const ids = () => [...document.querySelectorAll('#historyList .history-item .bill-row__no [onclick]')]
    .map(s => s.textContent.replace('#', ''));

describe('History filters (#160)', () => {
    beforeEach(() => {
        document.body.innerHTML = html;
        sessionStorage.clear();
        localStorage.clear();
        HistoryManager.filter = null;
        HistoryManager.pageKey = '';
        HistoryManager.viewMode = 'card';
        delete window.FirebaseService;
        AppState.historyLoadedFrom = 0;
        AppState.purchaseHistory = [bill('P-today', day(0)), bill('P-old', day(-40))];
        AppState.retailSalesHistory = [bill('S-yday', day(-1))];
        AppState.salesHistory = [bill('W-today', day(0, 12), { date: 'x' })];
    });

    test('Purchase | Sale tabs + presets filter, combine with search, and are remembered', () => {
        HistoryManager.refreshHistory();
        expect(ids()).toEqual(['P-today', 'P-old']);
        expect(document.querySelector('[data-type="purchase"]').classList.contains('active')).toBe(true);

        HistoryManager.filterHistory('sale');
        expect(ids()).toEqual(['S-yday']);
        expect(document.querySelector('[data-type="sale"]').classList.contains('active')).toBe(true);

        HistoryManager.filterHistory('purchase');
        HistoryManager.setDatePreset('today');
        expect(ids()).toEqual(['P-today']);
        expect(document.getElementById('historyRangeLabel').textContent).toMatch(/· 1 bill$/);

        document.getElementById('historySearch').value = 'old';
        HistoryManager.refreshHistory();
        expect(ids()).toEqual([]);

        expect(JSON.parse(sessionStorage.getItem(HISTORY_FILTER_KEY))).toMatchObject({ type: 'purchase', preset: 'today' });
        expect(localStorage.getItem(HISTORY_TAB_KEY)).toBe('purchase');
        HistoryManager.filter = null; // new page load in the same session
        document.getElementById('historySearch').value = '';
        HistoryManager.refreshHistory();
        expect(ids()).toEqual(['P-today']);
        expect(document.getElementById('historyDatePreset').value).toBe('today');
    });

    test('custom range shows the date inputs; old "retail" / "all" values map to Sale / Purchase', () => {
        HistoryManager.setDatePreset('custom');
        expect(document.getElementById('historyCustomRange').hidden).toBe(false);
        expect(ids()).toEqual(['P-today']);

        HistoryManager.setDatePreset('all');
        HistoryManager.renderHistory('retail');
        expect(ids()).toEqual(['S-yday']);
        HistoryManager.renderHistory('all');
        expect(ids()).toEqual(['P-today', 'P-old']);
    });

    test('a range older than the loaded window loads on demand with a progress notice', async () => {
        let resolveLoad;
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        const from = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
        window.FirebaseService = {
            getHistoryWindowStart: () => monthStart,
            isFullHistoryLoaded: () => false,
            ensureHistoryFrom: jest.fn(() => new Promise(r => { resolveLoad = r; }))
        };
        HistoryManager.setDatePreset('lastMonth');

        await Promise.resolve();
        expect(window.FirebaseService.ensureHistoryFrom).toHaveBeenCalledWith(from);
        const notice = document.querySelector('.history-range-notice');
        expect(notice.textContent).toContain('Loading older bills');
        expect(document.getElementById('historyList').classList.contains('history-range-loading')).toBe(true);

        window.FirebaseService.getHistoryWindowStart = () => from;
        // The stale-data hint is inserted right above the list, below the notice.
        const hint = document.createElement('div');
        hint.className = 'history-stale-hint';
        document.getElementById('historyList').before(hint);
        resolveLoad();
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
        expect(document.querySelector('.history-range-notice')).toBeNull();
        expect(document.getElementById('historyList').classList.contains('history-range-loading')).toBe(false);
    });
});

describe('Custom range quota guard (#199 review)', () => {
    const now = new Date();
    const windowStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const monthsAgo = (m, d = 3) => new Date(now.getFullYear(), now.getMonth() - m, d);
    let start;
    const flush = () => new Promise(r => setTimeout(r, 0));

    beforeEach(() => {
        document.body.innerHTML = html.replace('<div id="historyRangeLabel" hidden></div>',
            '<div id="historyRangeHint" hidden></div><div id="historyRangeLabel" hidden></div>');
        sessionStorage.clear();
        localStorage.clear();
        HistoryManager.filter = null;
        HistoryManager.pageKey = '';
        HistoryManager.confirmedFrom = null;
        HistoryManager.loadingGap = false;
        start = windowStart;
        window.FirebaseService = {
            getHistoryWindowStart: () => start,
            isFullHistoryLoaded: () => start === 0,
            ensureHistoryFrom: jest.fn(async (ms) => { start = ms; }),
            loadOlderHistory: jest.fn(async () => ({ reachedEnd: false }))
        };
        AppState.purchaseHistory = [bill('P-now', day(0))];
        AppState.retailSalesHistory = [];
        AppState.salesHistory = [];
    });
    afterEach(() => { delete window.FirebaseService; });

    test('the date inputs have no change/input handler: only Apply applies', () => {
        const tpl = require('fs').readFileSync(require('path').join(__dirname, '../../templates/history.html'), 'utf8');
        const inputs = tpl.match(/<input type="date"[^>]*>/g);
        expect(inputs).toHaveLength(2);
        inputs.forEach(tag => expect(tag).not.toMatch(/on(change|input|blur)=/));
        expect(tpl).toContain('window.app.history.applyCustomRange()');
    });

    test('typing a year (0002 → 0020 → 0202) never triggers a load or gets saved', async () => {
        const modal = jest.spyOn(UIManager, 'showModal');
        for (const partial of ['0002-08-03', '0020-08-03', '0202-08-03', '2019-08-03']) {
            document.getElementById('historyFromDate').value = partial;
            expect(await HistoryManager.applyCustomRange()).toBe(false);
        }
        await flush();
        expect(window.FirebaseService.ensureHistoryFrom).not.toHaveBeenCalled();
        expect(modal).not.toHaveBeenCalled();
        expect(sessionStorage.getItem(HISTORY_FILTER_KEY)).toBeNull();
        expect(document.getElementById('historyRangeHint').textContent).toBe('Dates before 2020 are not allowed');
    });

    test('a wide From range needs a confirm; declined = no load, nothing saved', async () => {
        const modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(false);
        expect(await HistoryManager.applyCustomRange(iso(monthsAgo(8)), '')).toBe(false);
        expect(modal.mock.calls[0][0]).toMatch(/load 8 months of older bills and use more data\. Continue\?/);
        await flush();
        expect(window.FirebaseService.ensureHistoryFrom).not.toHaveBeenCalled();
        expect(sessionStorage.getItem(HISTORY_FILTER_KEY)).toBeNull();

        modal.mockResolvedValue(true);
        expect(await HistoryManager.applyCustomRange(iso(monthsAgo(8)), '')).toBe(true);
        await flush();
        expect(window.FirebaseService.ensureHistoryFrom).toHaveBeenCalledWith(monthsAgo(8, 3).getTime());
        expect(JSON.parse(sessionStorage.getItem(HISTORY_FILTER_KEY))).toMatchObject({ preset: 'custom', from: iso(monthsAgo(8)) });
    });

    test('a narrow range loads without asking', async () => {
        const modal = jest.spyOn(UIManager, 'showModal');
        expect(await HistoryManager.applyCustomRange(iso(monthsAgo(1)), '')).toBe(true);
        await flush();
        expect(modal).not.toHaveBeenCalled();
        expect(window.FirebaseService.ensureHistoryFrom).toHaveBeenCalledTimes(1);
    });

    test('a wide range restored from the session waits for "Load older" + confirm', async () => {
        sessionStorage.setItem(HISTORY_FILTER_KEY, JSON.stringify({ type: 'all', preset: 'custom', from: iso(monthsAgo(8)), to: '' }));
        const modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        HistoryManager.refreshHistory();
        await flush();
        expect(window.FirebaseService.ensureHistoryFrom).not.toHaveBeenCalled();
        const btn = document.querySelector('#historyRangeGap button');
        expect(document.getElementById('historyRangeGap').textContent).toContain("aren't loaded");
        btn.click();
        await flush(); await flush();
        expect(modal).toHaveBeenCalledTimes(1);
        expect(window.FirebaseService.ensureHistoryFrom).toHaveBeenCalledWith(monthsAgo(8, 3).getTime());
    });

    test('To-only range before the window says older bills aren\'t loaded and offers Load older', async () => {
        jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        expect(await HistoryManager.applyCustomRange('', iso(monthsAgo(2, 10)))).toBe(true);
        const list = document.getElementById('historyList');
        expect(list.textContent).toContain("aren't loaded");
        expect(list.textContent).not.toContain('No bills in this period');
        document.querySelector('#historyRangeGap button').click();
        await flush(); await flush();
        expect(window.FirebaseService.ensureHistoryFrom).toHaveBeenCalledWith(monthsAgo(2, 1).getTime());
    });
});