/**
 * @fileoverview History page review fixes: Purchase | Sale tabs only (no
 * wholesale bills; old 'wholesale' links open Wholesale › History), old-app
 * carried dues hidden behind a per-tab toggle, one aligned row layout shared
 * with Wholesale › History, and the plain "not updated live" notice.
 */

jest.mock('../firebase/firestore-service.js', () => ({ FirebaseService: { db: null } }));
jest.mock('../services/printer.js', () => ({ PrinterService: {} }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(), ACTIONS: {} } }));
jest.mock('../ui/infinite-scroll.js', () => ({ attachOlderHistoryScroll: jest.fn() }));

import fs from 'fs';
import path from 'path';
import { AppState } from '../utils/state.js';
import { HistoryManager } from '../modules/history.js';
import { WholesaleSalesManager } from '../modules/wholesale-sales.js';
import { HISTORY_TAB_KEY, HISTORY_FILTER_KEY } from '../utils/history-filters.js';
import { BILL_ROW_SLOTS } from '../ui/bill-row.js';
import { resolveRoute } from '../ui/navigation.js';
import en from '../i18n/en.js';
import hi from '../i18n/hi.js';

const WWW = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(WWW, rel), 'utf8');

const day = (offset, h = 10) => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate() + offset, h).getTime();
};
const bill = (id, timestamp, extra = {}) => ({
    id, billNumber: id, customerName: `Party ${id}`, timestamp, totalPackets: 2,
    items: [{ name: 'Wheat', qty: 1, rate: 1 }], total: 100, payment: { cash: 100, online: 0, due: 0 }, ...extra
});
const opening = (id, timestamp, amount = 2500) => bill(id, timestamp, {
    items: [], total: 0, totalPackets: undefined, payment: { cash: 0, online: 0, due: amount },
    dueAmount: amount, openingBalance: { migrated: true, amount, billTotal: amount, paidBefore: 0 }
});

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
    </div>
    <div id="wholesale-sales">
      <div id="salesRecentList"></div>
      <select id="wholesaleHistoryPreset"><option value="all"></option><option value="today"></option></select>
      <div id="wholesaleHistoryCustomRange" hidden></div>
      <button id="wholesaleHistoryViewToggle"></button>
      <div><div id="salesHistoryList"></div></div>
    </div>`;

const historyNos = () => [...document.querySelectorAll('#historyList .bill-row__no [onclick]')].map(s => s.textContent.replace('#', ''));
const wholesaleNos = () => [...document.querySelectorAll('#salesHistoryList .bill-row__no [onclick]')].map(s => s.textContent.replace('#', ''));

beforeEach(() => {
    document.body.innerHTML = html;
    sessionStorage.clear();
    localStorage.clear();
    Object.assign(HistoryManager, { filter: null, pageKey: '', viewMode: 'card', showOpening: { purchase: false, sale: false }, pendingWholesaleRedirect: false });
    Object.assign(WholesaleSalesManager, { historyFilter: { preset: 'all', from: '', to: '' }, historySearch: '', historyView: 'card', showOpening: false });
    delete window.FirebaseService;
    window.app = { nav: { showTab: jest.fn() } };
    AppState.historyLoadedFrom = 0;
    AppState.purchaseHistory = [bill('P1', day(0)), opening('P-OLD-1', day(-2)), opening('P-OLD-2', day(-3))];
    AppState.retailSalesHistory = [bill('S20261022-005', day(-1)), opening('S-OLD-1', day(-4))];
    AppState.salesHistory = [bill('W1', day(0, 12), { source: 'sales-tab' }), bill('W2', day(-5)), opening('W-OLD-1', day(-6))];
});

describe('History tabs: Purchase | Sale only', () => {
    test('no wholesale bills in History; the tab is remembered on this device, Purchase on first use', () => {
        HistoryManager.refreshHistory();
        expect(historyNos()).toEqual(['P1']);
        HistoryManager.filterHistory('sale');
        expect(historyNos()).toEqual(['S20261022-005']);
        expect(document.getElementById('historyList').textContent).not.toMatch(/W1|W2/);
        expect(localStorage.getItem(HISTORY_TAB_KEY)).toBe('sale');

        HistoryManager.filter = null; // app reopened
        sessionStorage.clear();
        HistoryManager.refreshHistory();
        expect(historyNos()).toEqual(['S20261022-005']);
        expect(document.querySelector('[data-type="sale"]').classList.contains('active')).toBe(true);
    });

    test('old "wholesale" links and saved filters open Wholesale › History', () => {
        HistoryManager.filterHistory('wholesale');
        expect(window.app.nav.showTab).toHaveBeenCalledWith('wholesale-history');

        window.app.nav.showTab.mockClear();
        sessionStorage.setItem(HISTORY_FILTER_KEY, JSON.stringify({ type: 'wholesale', preset: 'all' }));
        HistoryManager.filter = null;
        HistoryManager.refreshHistory();
        expect(window.app.nav.showTab).toHaveBeenCalledWith('wholesale-history');
        expect(resolveRoute('wholesale-history')).toEqual({ id: 'wholesale-history', tab: 'wholesale-sales', section: 'history', needs: null, nav: 'wholesale-sales' });
    });

    test('tab labels: Purchase | Sale in English, खरीद | बिक्री in Hindi', () => {
        const tpl = read('templates/history.html');
        const keys = [...tpl.matchAll(/class="filter-btn[^"]*"[^>]*data-i18n="([^"]+)"/g)].map(m => m[1]);
        expect(keys).toEqual(['ui.history.tab_purchase', 'ui.history.tab_sale']);
        expect(keys.map(k => en[k])).toEqual(['Purchase', 'Sale']);
        expect(keys.map(k => hi[k])).toEqual(['खरीद', 'बिक्री']);
        expect(tpl).not.toMatch(/data-type="(all|retail|wholesale)"/);
    });
});

describe('old-app carried dues in History', () => {
    test('hidden by default; the toggle shows N for the tab and reveals them as a separate group', () => {
        HistoryManager.refreshHistory();
        expect(historyNos()).toEqual(['P1']);
        const chip = document.getElementById('historyOpeningToggle');
        expect(chip.textContent).toBe('Show dues carried from old app (2)');
        expect(chip.getAttribute('aria-pressed')).toBe('false');

        chip.click();
        const group = document.querySelector('#historyList .bill-group--opening');
        expect([...group.querySelectorAll('.bill-row__no [onclick]')].map(s => s.textContent)).toEqual(['#P-OLD-1', '#P-OLD-2']);
        expect(group.querySelectorAll('.old-app-chip')).toHaveLength(2);
        expect(document.getElementById('historyOpeningToggle').textContent).toBe('Hide dues carried from old app (2)');

        // Per tab: Sale still hides its one opening record
        HistoryManager.filterHistory('sale');
        expect(document.querySelector('#historyList .bill-group--opening')).toBeNull();
        expect(document.getElementById('historyOpeningToggle').textContent).toBe('Show dues carried from old app (1)');
    });

    test('search finds them only when the toggle is on', () => {
        document.getElementById('historySearch').value = 'P-OLD-2';
        HistoryManager.refreshHistory();
        expect(historyNos()).toEqual([]);
        expect(document.getElementById('historyOpeningToggle').textContent).toContain('(1)');
        HistoryManager.toggleOpenings();
        expect(historyNos()).toEqual(['P-OLD-2']);
    });

    test('Table View groups them the same way', () => {
        HistoryManager.viewMode = 'table';
        HistoryManager.refreshHistory();
        expect(document.querySelectorAll('#historyList tr.is-opening')).toHaveLength(0);
        HistoryManager.toggleOpenings();
        expect(document.querySelectorAll('#historyList tr.is-opening')).toHaveLength(2);
        expect(document.querySelector('#historyList .bill-table__group').textContent).toBe('Dues carried from the old app');
    });
});

describe('aligned bill row', () => {
    const slots = (row) => [...row.querySelectorAll('[class^="bill-row__"]')]
        .map(el => el.className.split(' ')[0].replace('bill-row__', ''))
        .filter(s => BILL_ROW_SLOTS.includes(s));

    test('every row has the same slots in column order; chips have their own slot', () => {
        HistoryManager.toggleOpenings();
        const rows = [...document.querySelectorAll('#historyList .history-item')];
        expect(rows.length).toBe(3);
        rows.forEach(row => {
            expect(row.classList.contains('bill-row')).toBe(true);
            expect(slots(row)).toEqual(['no', 'party', 'amount', 'date', 'items', 'chips']);
        });
        const old = rows.find(r => r.classList.contains('is-opening'));
        // The "Old app" chip sits in the chips slot, never next to the amount.
        expect(old.querySelector('.bill-row__chips .old-app-chip')).not.toBeNull();
        expect(old.querySelector('.bill-row__amount').textContent).toBe('₹2,500');
    });

    test('Wholesale › History uses the same row component and lists only wholesale bills', () => {
        WholesaleSalesManager.renderSalesHistory();
        expect(wholesaleNos()).toEqual(['W1', 'W2']);
        const row = document.querySelector('#salesHistoryList .history-item');
        expect(row.classList.contains('bill-row')).toBe(true);
        expect(slots(row)).toEqual(['no', 'party', 'amount', 'date', 'items', 'chips']);
        expect(row.getAttribute('data-type')).toBe('wholesale');
        // Recent list under the entry form uses it too
        expect(document.querySelectorAll('#salesRecentList .bill-row')).toHaveLength(2);
        for (const mod of ['js/modules/history.js', 'js/modules/wholesale-sales.js']) {
            expect(read(mod)).toMatch(/import \{[^}]*buildBillRow[^}]*\} from '\.\.\/ui\/bill-row\.js'/);
        }
    });

    test('Wholesale › History: old-app dues behind the toggle, search and Table View work', () => {
        WholesaleSalesManager.renderWholesaleHistory();
        expect(document.getElementById('wholesaleOpeningToggle').textContent).toBe('Show dues carried from old app (1)');
        document.getElementById('wholesaleOpeningToggle').click();
        expect(wholesaleNos()).toEqual(['W-OLD-1', 'W1', 'W2']);
        WholesaleSalesManager.searchHistory('W2');
        expect(wholesaleNos()).toEqual(['W2']);
        WholesaleSalesManager.toggleHistoryView();
        expect([...document.querySelectorAll('#salesHistoryList tbody tr.bill-table__row')].map(r => r.querySelector('.bill-table__no').textContent)).toEqual(['#W2']);
    });

    test('CSS: the bill number never wraps; amounts are right-aligned; desktop uses six fixed columns', () => {
        const css = read('css/history.css');
        const rule = (src, sel) => {
            const m = src.match(new RegExp(`(^|\\n)\\s*([^{}]*\\${sel}[^{}]*)\\{([^}]*)\\}`, 'g')) || [];
            return m.join('\n');
        };
        const noRule = rule(css, '.bill-row__no');
        expect(noRule).toMatch(/white-space:\s*nowrap/);
        expect(noRule).toMatch(/text-overflow:\s*ellipsis/);
        expect(rule(css, '.bill-row__amount')).toMatch(/text-align:\s*right/);
        expect(rule(css, '.bill-table__no')).toMatch(/white-space:\s*nowrap/);

        const desktop = read('css/desktop.css');
        const grid = desktop.match(/\.history-item\.bill-row\s*\{([^}]*)\}/)[1];
        const cols = grid.match(/grid-template-columns:\s*([^;]+);/)[1].trim().split(/\s+(?![^(]*\))/);
        expect(cols).toHaveLength(6);
        expect(desktop).not.toMatch(/bill-row__no[^{]*\{[^}]*white-space:\s*(normal|pre-wrap)/);
    });
});

describe('Wholesale › History respects the role\'s History "days back" limit', () => {
    const DAY = 24 * 60 * 60 * 1000;
    afterEach(() => {
        AppState.userRole = undefined;
        AppState.settings = {};
    });

    test.each([['manager'], ['staff']])('%s with historyDays: older bills hidden, no older months loaded', async (role) => {
        AppState.userRole = role;
        AppState.settings = { roleAccess: { [role]: { historyDays: 3 } } };
        const windowStart = Date.now() - DAY; // loaded window is newer than the cutoff
        window.FirebaseService = {
            getHistoryWindowStart: () => windowStart,
            isFullHistoryLoaded: () => false,
            ensureHistoryFrom: jest.fn(() => new Promise(() => {}))
        };

        WholesaleSalesManager.renderSalesHistory();
        expect(wholesaleNos()).toEqual(['W1']);
        expect(document.getElementById('wholesaleOpeningToggle')).toBeNull(); // W-OLD-1 is 6 days old
        expect([...document.querySelectorAll('#salesRecentList .bill-row__no [onclick]')].map(s => s.textContent)).toEqual(['#W1']);

        // A custom range back to 2020 only loads from the cutoff, never older months.
        WholesaleSalesManager.applyHistoryRange('2020-01-01', '');
        await new Promise(r => setTimeout(r, 0));
        const calls = window.FirebaseService.ensureHistoryFrom.mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        calls.forEach(([from]) => {
            expect(from).toBeGreaterThanOrEqual(Date.now() - 3 * DAY - 60000);
            expect(from).toBeLessThan(windowStart);
        });
    });

    test('no limit for the owner: the whole range may load', () => {
        AppState.userRole = 'owner';
        WholesaleSalesManager.renderSalesHistory();
        expect(wholesaleNos()).toEqual(['W1', 'W2']);
    });
});
