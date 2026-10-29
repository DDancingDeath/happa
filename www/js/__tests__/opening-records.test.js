/**
 * @fileoverview Opening records carried from the old app (tools/migrate) are
 * balances only: they count in dues (Outstanding, aging, all-time due totals,
 * Money receivables) and in no period or activity figure. Reproduces the live
 * Today screen: one large opening due dated today + a ₹10 sale paid ₹4
 * showed the opening due + ₹6 as "Due to receive" and "Sales ₹10 · 2 bills".
 * Fake values: ₹2,50,000 opening, so Today due ₹6 and Outstanding ₹2,50,006.
 */
import { DayManager } from '../modules/day.js';
import { AnomaliesManager } from '../modules/anomalies.js';
import { OutstandingManager } from '../modules/outstanding.js';
import { billCount, outstandingTotals } from '../utils/business-metrics.js';
import { CashManagementManager } from '../modules/cash-management.js';
import { AppState } from '../utils/state.js';
import { activityBills, isOpeningRecord } from '../utils/money.js';
import { computeFinanceSummary } from '../utils/finance-calc.js';
import { collectEvents } from '../utils/stock-replay.js';
import { addBillToAcc, createCatalogueResolver } from '../utils/rate-trends.js';
import { detectAnomalies } from '../utils/anomalies.js';
import { runNumberChecks } from '../utils/number-checks.js';
import { dueEvents, sumDueEvents } from '../utils/due-payments.js';
import { itemUsageFrequency } from '../utils/item-catalog.js';

const NOW = new Date(2026, 9, 25, 21, 0);
const ITEMS = [{ id: 'i-test', name: 'Test Item', hindiName: 'टेस्ट आइटम' }];

/** The opening record exactly as tools/migrate writes it (an old bill from today). */
function partyAOpening(over = {}) {
    return {
        id: 'opening-retail-old1', billNumber: 'S-TEST-1', customerName: 'Test Party A',
        date: '2026-10-25', timestamp: new Date(2026, 9, 25, 17, 35).getTime(), type: 'retail', isPurchase: false,
        items: [], total: 0, cashPayment: 0, onlinePayment: 0, dueAmount: 250000,
        payment: { cash: 0, online: 0, due: 250000, total: 0 }, openDue: true, cleared: false,
        openingBalance: { migrated: true, kind: 'receivable', billType: 'retail', amount: 250000, billTotal: 250000, paidBefore: 0,
            asOf: new Date(2026, 9, 25, 20, 0).getTime(), fromProject: 'aadhat-management', sourceBillId: 'old1' },
        ...over
    };
}
const sale = () => ({
    id: 'r-today', billNumber: 'S-TEST-2', customerName: 'Test Party C', date: new Date(2026, 9, 25, 20, 59).toISOString(),
    timestamp: new Date(2026, 9, 25, 20, 59).getTime(), type: 'retail',
    items: [{ itemId: 'i-test', name: 'Test Item', qty: 1, rate: 10, total: 10 }],
    total: 10, cashPayment: 4, onlinePayment: 0, dueAmount: 6, payment: { cash: 4, online: 0, due: 6, total: 10 }
});

const text = (id) => document.getElementById(id).textContent;

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(NOW);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    AppState.items = ITEMS;
    AppState.purchaseHistory = [];
    AppState.salesHistory = [];
    AppState.retailSalesHistory = [partyAOpening(), sale()];
    AppState.stockAdjustments = [];
    AppState.expensesHistory = [];
    AppState.withdrawalsHistory = [];
    AppState.historyLoadedFrom = 0;
    AppState.userRole = 'owner';
    AppState.settings = { showHindi: false };
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    CashManagementManager.todaySession = null;
    AppState.retailSalesHistory = [];
});

describe('live case (fake values): ₹2,50,000 opening due today + ₹10 sale paid ₹4', () => {
    test('Today: due to receive ₹6, sales ₹10 from 1 bill', () => {
        const ids = ['todayTotalPurchases', 'todayPurchaseCount', 'todayTotalSales', 'todaySaleCount', 'todayLaborCost', 'todayBusinessExpenses',
            'todayBusinessExpenseCount', 'todayPersonalExpenses', 'todayPersonalExpenseCount', 'todayTotalIn', 'todayTotalOut', 'todayNetCashFlow',
            'todayCashFlowLabel', 'todayCashReceived', 'todayOnlineReceived', 'todayCashPaid', 'todayOnlinePaid', 'todayTotalCashFlow',
            'todayDueReceived', 'todayDuePaid', 'todayDueToReceive', 'todayDueToPay', 'todayPurchaseItems', 'todaySaleItems', 'todayTransactionsList'];
        document.body.innerHTML = ids.map(id => `<div id="${id}"></div>`).join('');
        const report = jest.spyOn(AnomaliesManager, 'renderDayReport').mockImplementation(() => {});
        DayManager.loadTodayData();
        expect(text('todayDueToReceive')).toBe('₹6');
        expect(text('todayTotalSales')).toBe('₹10');
        expect(text('todaySaleCount')).toBe('1 bill');
        expect(text('todayCashReceived')).toBe('₹4');
        expect(text('todayTransactionsList')).not.toContain('Test Party A');
        expect(JSON.stringify(report.mock.calls[0][0])).not.toContain('opening-retail-old1');
    });

    test('Outstanding (aging panel and bill list) still holds ₹2,50,006', () => {
        document.body.innerHTML = '<div id="dueAging"></div><div id="dueList"></div>';
        AppState.currentDueFilter = 'sale';
        OutstandingManager.partyFilter = null;
        OutstandingManager.agingBucket = null;
        OutstandingManager.renderDue();
        expect(document.querySelector('#dueAging .aging-total').textContent.replace(/[^\d]/g, '')).toBe('250006');
        expect(document.querySelectorAll('#dueList .history-item')).toHaveLength(2);
        expect(outstandingTotals({ retailSales: AppState.retailSalesHistory }).receivable.total).toBe(250006);
    });

    test('Money: 1 sale of ₹10 today', () => {
        const day = [new Date(2026, 9, 25).getTime(), new Date(2026, 9, 26).getTime()];
        const s = computeFinanceSummary({
            sources: { purchases: [], wholesaleSales: [], retailSales: AppState.retailSalesHistory, stockAdjustments: [] },
            items: ITEMS, base: { state: {}, from: -Infinity }, from: day[0], to: day[1]
        });
        expect(s.sales).toEqual({ total: 10, count: 1, due: 6 });
        expect(billCount({ retailSales: AppState.retailSalesHistory }, day[0], day[1]).sales).toBe(1);
    });
});

describe('one shared rule: isOpeningRecord / activityBills', () => {
    test('marks only migration records', () => {
        expect(isOpeningRecord(partyAOpening())).toBe(true);
        expect(isOpeningRecord(sale())).toBe(false);
        expect(activityBills([partyAOpening(), sale(), null]).map(b => b && b.id)).toEqual(['r-today', null]);
        expect(activityBills(undefined)).toEqual([]);
    });

    test('stock replay, rate trends and item frequency skip opening records, even with stray lines', () => {
        const withLine = partyAOpening({ items: [{ itemId: 'i-test', name: 'Test Item', qty: 5, rate: 10, total: 50 }] });
        expect(collectEvents({ retailSales: [withLine] })).toEqual([]);
        expect(addBillToAcc({}, withLine, 'retail', createCatalogueResolver(ITEMS))).toBe(false);
        expect(itemUsageFrequency({ retailSales: [withLine] }, ITEMS)).toEqual({});
    });

    test('anomaly scans and number checks AC2 / AC4 ignore opening records', () => {
        const from = new Date(2026, 9, 25).getTime();
        const anomalies = detectAnomalies({ bills: { retail: [partyAOpening({ customerName: '' })] }, from, to: from + 86400000 });
        expect(anomalies).toEqual([]);
        const checks = runNumberChecks({ purchases: [], wholesaleSales: [], retailSales: [partyAOpening()], stockAdjustments: [], items: ITEMS });
        expect(checks.find(c => c.id === 'AC2')).toMatchObject({ problems: 0, checked: 0 });
        expect(checks.find(c => c.id === 'AC4')).toMatchObject({ problems: 0, checked: 0 });
    });

    test('money paid on an opening due counts on its day; its write-off is not a bad debt', () => {
        const paidAt = new Date(2026, 9, 25, 12).getTime();
        const bill = partyAOpening({
            payment: { cash: 1000, online: 0, due: 0, total: 1000, writtenOff: 249000 }, cleared: true,
            payments: [{ id: 'p1', cash: 1000, online: 0, at: paidAt }, { id: 'w1', kind: 'writeOff', amount: 249000, at: paidAt }]
        });
        const t = sumDueEvents(dueEvents({ bills: { retail: [bill] }, from: paidAt - 1, to: paidAt + 1 }));
        expect(t.receivedCash).toBe(1000);
        expect(t.writtenOffReceivable).toBe(0);
    });
});
