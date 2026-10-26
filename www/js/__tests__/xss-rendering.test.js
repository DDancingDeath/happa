/**
 * @fileoverview Stored-XSS regression tests: list/detail renderers that build
 * innerHTML from Firestore records must escape every record value (including
 * ids and "numeric" fields, which may be strings in Firestore) so a staff user
 * can't plant markup or break out of inline onclick/onchange handlers.
 * Also covers the wholesale-screen payment path going through the shared
 * Firestore transaction instead of a full-document write.
 */

jest.mock('../firebase/firestore-service.js', () => ({
    FirebaseService: {
        loadCashSessions: jest.fn(async () => []),
        updateWholesaleSale: jest.fn(async () => {}),
        db: null
    }
}));
jest.mock('../services/printer.js', () => ({ PrinterService: {} }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(), ACTIONS: {} } }));
jest.mock('../ui/infinite-scroll.js', () => ({ attachOlderHistoryScroll: jest.fn() }));

import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { HistoryManager } from '../modules/history.js';
import { WholesaleSalesManager } from '../modules/wholesale-sales.js';
import { OutstandingManager } from '../modules/outstanding.js';
import { CashManagementManager } from '../modules/cash-management.js';

const IMG = '"><img src=x onerror="window.__pwned=1">';
const QUOTE_ID = "x');window.__pwned=1;//\"<img src=x>";
const NUM = '1<img src=x onerror="window.__pwned=1">';

function setupDom() {
    document.body.innerHTML = `
        <input id="historySearch" value="">
        <div id="historyList"></div>
        <div id="salesHistoryList"></div>
        <div id="salesOutstandingList"></div>
        <div id="dueList"></div>
        <div id="cashHistoryList"></div>
        <div id="billDetailsOverlay"><div id="billDetailsContent"></div></div>
        <div id="modalOverlay"><div class="modal-box"><div id="modalTitle"></div><div id="modalMessage"></div><button id="modalCancel"></button></div></div>
        <div id="toast"></div>
    `;
}

/** Run an inline handler attribute and return the arguments of every app call it makes. */
function runHandler(attr) {
    const calls = [];
    const handler = () => new Proxy(function () {}, {
        get: () => handler(),
        apply: (_t, _this, args) => { calls.push(args); }
    });
    // Evaluate with a fake window so nothing real runs
    new Function('window', 'event', attr)(handler(), { stopPropagation() {} });
    return calls;
}

function assertNoInjection(root) {
    expect(root.querySelector('img')).toBeNull();
    expect(window.__pwned).toBeUndefined();
    root.querySelectorAll('*').forEach(el => {
        for (const a of el.attributes) {
            if (/^on/i.test(a.name)) {
                expect(['onclick', 'onchange', 'onmouseover', 'onmouseout', 'oninput']).toContain(a.name);
            }
        }
    });
}

function maliciousBill(extra = {}) {
    return {
        id: QUOTE_ID,
        billNumber: IMG,
        customerName: IMG,
        createdByName: IMG,
        date: new Date(2026, 9, 1, 10, 0).toISOString(),
        timestamp: Date.now(),
        totalPackets: NUM,
        items: [{ name: IMG, rate: NUM, total: NUM, qty: 2, weights: [1, 1] }],
        comments: IMG,
        ...extra
    };
}

beforeEach(() => {
    setupDom();
    delete window.__pwned;
    window.app = { outstanding: { renderDue: jest.fn() }, history: {}, wholesaleSales: {} };
    AppState.purchaseHistory = [];
    AppState.salesHistory = [];
    AppState.retailSalesHistory = [];
    AppState.currentUser = { uid: 'owner1', email: 'o@x' };
    AppState.userName = 'Owner';
    HistoryManager.viewMode = 'card';
});

describe('history list escapes record values', () => {
    test('card view: bill number, id, totals and names', () => {
        AppState.purchaseHistory = [maliciousBill({ type: 'purchase' })];
        HistoryManager.renderHistory('purchase');
        const list = document.getElementById('historyList');
        assertNoInjection(list);
        expect(list.textContent).toContain(`#${IMG}`);
        expect(list.textContent).toContain(`${NUM} packets`);

        const span = list.querySelector('.history-header span[onclick]');
        const calls = runHandler(span.getAttribute('onclick'));
        expect(calls).toEqual([[`id:${QUOTE_ID}`, 'purchase']]);
    });

    test('card view: a malicious stored type cannot break out of viewBill()', () => {
        AppState.purchaseHistory = [maliciousBill({ type: "purchase');window.__pwned=1;//" })];
        HistoryManager.renderHistory('purchase');
        const span = document.querySelector('#historyList span[onclick]');
        // History normalises the type by collection (#160), so the stored value never reaches the handler.
        expect(runHandler(span.getAttribute('onclick'))).toEqual([[`id:${QUOTE_ID}`, 'purchase']]);
        expect(window.__pwned).toBeUndefined();
    });

    test('table view: rate cell and row handler', () => {
        HistoryManager.viewMode = 'table';
        AppState.purchaseHistory = [maliciousBill({ type: 'purchase' })];
        HistoryManager.renderHistory('purchase');
        const list = document.getElementById('historyList');
        assertNoInjection(list);
        expect(list.textContent).toContain(`₹${NUM}`);
        const row = list.querySelector('tr[onclick]');
        expect(runHandler(row.getAttribute('onclick'))).toEqual([[`id:${QUOTE_ID}`, 'purchase']]);
    });

    test('bill details: bill number, rate, total, packets', async () => {
        AppState.purchaseHistory = [maliciousBill({ type: 'purchase' })];
        await HistoryManager.viewBill(0, 'purchase');
        const content = document.getElementById('billDetailsContent');
        assertNoInjection(content);
        expect(content.textContent).toContain(`#${IMG}`);
        expect(content.textContent).toContain(NUM);
    });

    test('normal data renders unchanged', () => {
        AppState.purchaseHistory = [{
            id: 'abc123', billNumber: 'P-001', customerName: 'Ram', type: 'purchase',
            date: new Date(2026, 9, 1).toISOString(), totalPackets: 3, grandTotal: 1500,
            items: [{ name: 'Wheat', rate: 25, total: 1500, qty: 60 }]
        }];
        HistoryManager.renderHistory('purchase');
        const text = document.getElementById('historyList').textContent;
        expect(text).toContain('#P-001');
        expect(text).toContain('Wheat • 3 packets');
        expect(text).toContain('₹1,500');
    });
});

describe('wholesale screen escapes record values', () => {
    const sale = () => ({
        ...maliciousBill(),
        source: 'sales-tab',
        total: 100,
        payment: { online: 0, cash: 0, due: 100, total: 0 },
        payments: [{ amount: NUM, date: IMG, recordedBy: IMG }]
    });

    test('history list', () => {
        AppState.salesHistory = [sale()];
        WholesaleSalesManager.renderSalesHistory();
        const list = document.getElementById('salesHistoryList');
        assertNoInjection(list);
        expect(list.textContent).toContain(`#${IMG}`);
        expect(runHandler(list.querySelector('[onclick]').getAttribute('onclick'))).toEqual([[QUOTE_ID]]);
    });

    test('outstanding list: ids in onclick/onchange/id/for attributes', () => {
        AppState.salesHistory = [sale()];
        WholesaleSalesManager.renderSalesOutstanding();
        const list = document.getElementById('salesOutstandingList');
        assertNoInjection(list);
        const handlers = [...list.querySelectorAll('[onclick],[onchange]')]
            .map(el => runHandler(el.getAttribute('onclick') || el.getAttribute('onchange')));
        expect(handlers).toEqual([[[QUOTE_ID]], [[QUOTE_ID]], [[QUOTE_ID]]]);
        expect(list.querySelector('input[type="number"]').id).toBe(`payment_${QUOTE_ID}`);
        expect(list.querySelector('label[for]').htmlFor).toBe(`clear_${QUOTE_ID}`);
    });

    test('sale details: bill number, rate, qty', async () => {
        AppState.salesHistory = [{ ...sale(), items: [{ name: IMG, rate: NUM, qty: NUM, total: 5 }] }];
        await WholesaleSalesManager.reprintSale(0);
        const content = document.getElementById('billDetailsContent');
        assertNoInjection(content);
        expect(content.textContent).toContain(`#${IMG}`);
    });
});

describe('outstanding (Due) list escapes record values', () => {
    test('ids/types in handlers and bill number', () => {
        AppState.currentDueFilter = 'purchase';
        AppState.purchaseHistory = [maliciousBill({ total: 100, payment: { online: 0, cash: 0, due: 100 } })];
        OutstandingManager.renderDue();
        const list = document.getElementById('dueList');
        assertNoInjection(list);
        expect(list.textContent).toContain(`#${IMG}`);
        const handlers = [...list.querySelectorAll('[onclick],[onchange]')]
            .map(el => runHandler(el.getAttribute('onclick') || el.getAttribute('onchange')));
        expect(handlers).toEqual([
            [[QUOTE_ID, 'purchase']], [[QUOTE_ID, 'purchase']], [[QUOTE_ID, 'purchase']]
        ]);
        expect(list.querySelector('input[type="number"]').id).toBe(`payment_${QUOTE_ID}`);
    });
});

describe('cash management escapes session values', () => {
    const session = () => ({
        id: 's1', date: '2026-10-01', signedOut: true,
        openingBalance: NUM, closingBalance: NUM, expectedBalance: NUM, difference: 0,
        transactions: {
            cashDeposits: NUM, cashSales: NUM, dueReceived: NUM, cashPurchases: NUM,
            duePaid: NUM, businessExpenses: NUM, personalExpenses: NUM
        },
        cashDeposits: [{ amount: NUM, reason: IMG, addedBy: IMG }],
        duePayments: [{ amount: NUM, customer: IMG, method: IMG, notes: IMG, type: 'received' }],
        openingNotes: IMG, closingNotes: IMG
    });

    test('history list', () => {
        CashManagementManager.cachedSessions = [session()];
        CashManagementManager.renderHistoryFromCache();
        const list = document.getElementById('cashHistoryList');
        assertNoInjection(list);
        expect(list.textContent).toContain(`Opening: ₹${NUM}`);
    });

    test('session details (signed out and in progress)', async () => {
        for (const signedOut of [true, false]) {
            FirebaseService.loadCashSessions.mockResolvedValueOnce([{ ...session(), signedOut }]);
            await CashManagementManager.showSessionDetails('2026-10-01');
            const modal = document.getElementById('modalMessage');
            assertNoInjection(modal);
            expect(modal.textContent).toContain(`₹${NUM}`);
            expect(modal.textContent).toContain(IMG);
        }
    });
});
