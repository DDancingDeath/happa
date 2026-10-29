/**
 * @fileoverview #24: History renders 50 bills at a time.
 */

jest.mock('../firebase/firestore-service.js', () => ({ FirebaseService: { db: null } }));
jest.mock('../services/printer.js', () => ({ PrinterService: {} }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(), ACTIONS: {} } }));
jest.mock('../ui/infinite-scroll.js', () => ({ attachOlderHistoryScroll: jest.fn() }));

import { AppState } from '../utils/state.js';
import { HistoryManager } from '../modules/history.js';
import { attachOlderHistoryScroll } from '../ui/infinite-scroll.js';

const bills = (n) => Array.from({ length: n }, (_, i) => ({
    id: `b${i}`,
    billNumber: `P20261021-${String(i).padStart(3, '0')}`,
    customerName: `Farmer ${i}`,
    date: new Date(2026, 9, 21, 10, 0, 0).toISOString(),
    timestamp: 1_000_000 + (n - i), // b0 newest
    items: [{ name: 'Wheat', qty: 1, rate: 1 }],
    total: 10
}));

describe('History paging (#24)', () => {
    beforeEach(() => {
        document.body.innerHTML = '<input id="historySearch" value=""><div id="historyList"></div>';
        AppState.purchaseHistory = bills(120);
        AppState.salesHistory = [];
        AppState.retailSalesHistory = [];
        AppState.historyLoadedFrom = 0;
        HistoryManager.viewMode = 'card';
        HistoryManager.pageKey = '';
    });

    const cards = () => document.querySelectorAll('#historyList .history-item');
    const showMore = () => document.querySelector('#historyList .history-show-more button');
    const olderScrollEnabled = () => attachOlderHistoryScroll.mock.calls.at(-1)[1].enabled();

    test('renders 50, then 50 more per Show more; older-month loading waits for the end', () => {
        HistoryManager.renderHistory('purchase');
        expect(cards()).toHaveLength(50);
        expect(cards()[0].textContent).toContain('P20261021-000');
        expect(showMore().textContent).toBe('Show more (70 more)');
        expect(olderScrollEnabled()).toBe(false);

        showMore().click();
        expect(cards()).toHaveLength(100);
        showMore().click();
        expect(cards()).toHaveLength(120);
        expect(showMore()).toBeNull();
        expect(olderScrollEnabled()).toBe(true);
    });

    test('live refresh keeps the shown count; search still covers every loaded bill', () => {
        HistoryManager.renderHistory('purchase');
        showMore().click();
        HistoryManager.refreshHistory();
        expect(cards()).toHaveLength(100);

        HistoryManager.renderHistory('purchase', 'P20261021-119');
        expect(cards()).toHaveLength(1);
        expect(cards()[0].textContent).toContain('Farmer 119');

        HistoryManager.renderHistory('purchase');
        expect(cards()).toHaveLength(50);
    });

    test('table view is paged too', () => {
        HistoryManager.viewMode = 'table';
        HistoryManager.renderHistory('purchase');
        expect(document.querySelectorAll('#historyList tbody tr')).toHaveLength(50);
        showMore().click();
        expect(document.querySelectorAll('#historyList tbody tr')).toHaveLength(100);
    });
});
