/**
 * @fileoverview Diagnostics → Number checks (#216): the accounting checks on
 * loaded data find real differences, pass on clean data, and the tab is
 * available to owners and managers only.
 */
import { runNumberChecks, checkBillSplit, checkPayments, checkStock, checkDates, checkDueFields, checkDrawer } from '../utils/number-checks.js';
import { DiagnosticsManager } from '../modules/diagnostics.js';
import { CashManagementManager } from '../modules/cash-management.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { generateShop } from '../../../tests/fixtures/generator.js';

const items = [{ id: 'i-rice', name: 'Rice' }];
const status = (results) => Object.fromEntries(results.map(r => [r.id, r.status]));

describe('number checks on loaded data', () => {
    test('a clean generated history passes every check', () => {
        const s = generateShop({ seed: 11, years: 1, openingRate: 1 });
        const results = runNumberChecks(s, { fullHistory: true });
        expect(status(results)).toEqual({ AC1: 'pass', AC8: 'pass', AC2: 'pass', AC3: 'pass', AC4: 'pass', AC5: 'pass', AC6: 'skip' });
    });

    test('AC2: a bill whose cash + online + due is not its total', () => {
        const r = checkBillSplit({ retailSales: [
            { id: 'r1', billNumber: 'R-1', customerName: 'Sita', date: '2026-10-21', total: 500, payment: { cash: 300, online: 0, due: 100 } },
            { id: 'r2', date: '2026-10-21', total: 500, payment: { cash: 300, online: 0, due: 199.5 } }
        ] });
        expect(r.status).toBe('fail');
        expect(r.rows).toEqual([{ ref: { kind: 'retail', id: 'r1', number: 'R-1', party: 'Sita', day: '21/10/2026' }, expected: 500, actual: 400, diff: 100 }]);
    });

    test('AC2: a written-off due still adds up', () => {
        expect(checkBillSplit({ purchases: [{ id: 'p', grandTotal: 1000, payment: { cash: 600, online: 0, due: 0, writtenOff: 400 } }] }).status).toBe('pass');
    });

    test('AC3: a later payment that never reached payment.* is reported', () => {
        const r = checkPayments({ retailSales: [{ id: 'r', total: 500, payment: { cash: 100, online: 0, due: 400 },
            payments: [{ id: 'x', cash: 200, online: 0, at: 1 }] }] });
        expect(r.status).toBe('fail');
        expect(r.rows[0]).toMatchObject({ expected: 100, actual: 200 });
    });

    test('AC1 + AC8: goods sold before their purchase leave a value gap and negative stock', () => {
        const [ac1, ac8] = checkStock({
            items,
            purchases: [{ date: '2026-10-02T10:00:00', items: [{ itemId: 'i-rice', qty: 10, rate: 30 }] }],
            retailSales: [{ date: '2026-10-01T10:00:00', items: [{ itemId: 'i-rice', qty: 15, rate: 40 }] }],
            wholesaleSales: [], stockAdjustments: []
        });
        expect(ac1.status).toBe('fail');
        expect(ac1.rows[0]).toMatchObject({ ref: { item: 'Rice' }, expected: 300, actual: 0, diff: 300 });
        expect(ac8.rows[0]).toMatchObject({ ref: { item: 'Rice' }, actual: -5, unit: 'qty' });
    });

    test('AC1/AC8 are skipped until the full history is loaded', () => {
        expect(checkStock({ items }, { fullHistory: false }).map(r => r.status)).toEqual(['skip', 'skip']);
    });

    test('AC4: an unreadable date is listed (it is in "All" but in no month)', () => {
        const r = checkDates({ purchases: [{ id: 'p', date: 'yesterday', grandTotal: 700 }, { id: 'q', date: '05/10/2026', grandTotal: 300 }] });
        expect(r.rows).toHaveLength(1);
        expect(r.totals).toEqual({ all: 1000, months: 300 });
    });

    test('AC5: dueAmount and payment.due disagree (cleared bills ignored)', () => {
        const r = checkDueFields({ retailSales: [
            { id: 'a', dueAmount: 250, payment: { due: 100 } },
            { id: 'b', dueAmount: 80, payment: { due: 0 }, cleared: true },
            { id: 'c', dueAmount: 50 }
        ] });
        expect(r.checked).toBe(1);
        expect(r.rows[0]).toMatchObject({ expected: 100, actual: 250, diff: -150 });
    });

    test('AC6: a closed session whose saved expected cash no longer matches the bills', () => {
        const tx = { cashSales: 500, cashPurchases: 0, businessExpenses: 0, personalExpenses: 0, dueReceived: 0, duePaid: 0, cashDeposits: 0 };
        const session = { date: '2026-10-21', openingBalance: 1000, signedOut: true, expectedBalance: 1300 };
        expect(checkDrawer(session, () => tx).rows[0]).toMatchObject({ expected: 1500, actual: 1300, diff: 200 });
        expect(checkDrawer({ ...session, expectedBalance: 1500 }, () => tx).status).toBe('pass');
        expect(checkDrawer(null, () => tx).status).toBe('skip');
    });
});

describe('Diagnostics → Number checks tab', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="diagnosticsTabsContainer"></div><div id="diagnosticsContainer"></div>';
        jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        DiagnosticsManager.numberChecks = null;
        DiagnosticsManager.activeTab = 'errors';
        AppState.items = items;
        AppState.purchaseHistory = [];
        AppState.salesHistory = [];
        AppState.stockAdjustments = [];
        AppState.historyLoadedFrom = 0;
        AppState.retailSalesHistory = [{ id: 'r1', billNumber: '<b>R1</b>', customerName: '<img src=x onerror=alert(1)>', date: '2026-10-21',
            total: 500, payment: { cash: 300, online: 0, due: 100 }, items: [] }];
        CashManagementManager.todaySession = null;
    });
    afterEach(() => {
        jest.restoreAllMocks();
        AppState.retailSalesHistory = [];
    });

    test('a manager sees only Number checks, and running it lists the difference (escaped)', async () => {
        AppState.userRole = 'manager';
        await DiagnosticsManager.init();
        const tabs = document.getElementById('diagnosticsTabsContainer').textContent;
        expect(tabs).toContain('Number checks');
        expect(tabs).not.toContain('Errors');
        DiagnosticsManager.runNumberChecks();
        const card = document.querySelector('.diag-numcheck[data-check="AC2"]');
        expect(card.dataset.status).toBe('fail');
        expect(card.textContent).toContain('₹100');
        expect(card.querySelector('img')).toBeNull();
        expect(card.innerHTML).toContain('&lt;img');
    });

    test('other users cannot open Diagnostics', async () => {
        AppState.userRole = 'member';
        await DiagnosticsManager.init();
        expect(UIManager.showToast).toHaveBeenCalled();
        expect(document.getElementById('diagnosticsContainer').innerHTML).toBe('');
    });
});
