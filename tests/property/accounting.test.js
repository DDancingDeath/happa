/**
 * @fileoverview Accounting checks (#216) as property tests over generated
 * multi-year shop histories (tests/fixtures/generator.js). Spec IDs AC1–AC8 in
 * docs/calculations.md. Each property runs the app's own code on the
 * generated data and compares it with what really happened (`truth`) or with
 * the independent oracle (tests/oracle/oracle.js).
 *
 * Fixed seed, modest runs so CI stays fast; FC_RUNS=50 runs more locally.
 * A property the app currently breaks is skipped with `// BUG: see #N`.
 */
import fc from 'fast-check';
import { generateShop } from '../fixtures/generator.js';
import * as O from '../oracle/oracle.js';
import { readPayment, billTotal, outstandingDue } from '../../www/js/utils/money.js';
import { saleTimePayment, entryParts } from '../../www/js/utils/due-payments.js';
import { computeStock, buildCheckpointState } from '../../www/js/utils/stock-replay.js';
import { sessionTotals } from '../../www/js/utils/cash-session.js';
import { computeFinanceSummary } from '../../www/js/utils/finance-calc.js';
import { DayManager } from '../../www/js/modules/day.js';
import { AnomaliesManager } from '../../www/js/modules/anomalies.js';
import { FinanceManager } from '../../www/js/modules/finance.js';
import { ReportsManager } from '../../www/js/modules/reports.js';
import { AnalyticsManager } from '../../www/js/modules/analytics.js';
import { OutstandingManager } from '../../www/js/modules/outstanding.js';
import { CashManagementManager } from '../../www/js/modules/cash-management.js';
import { AppState } from '../../www/js/utils/state.js';

const RUNS = Number(process.env.FC_RUNS) || 5;
const FC = { seed: 216, numRuns: RUNS, endOnFailure: true };
jest.setTimeout(120000);

/** Generated shop; a failing run prints only the generator options. */
const shopArb = (over = {}) => fc.record({
    seed: fc.integer({ min: 1, max: 0x7fffffff }),
    years: fc.constantFrom(1, 2, 3),
    // A few fixed levels: fast-check's bias would otherwise favour rates near 0.
    creditRate: fc.constantFrom(0.35, 0.1, 0.6),
    legacyRate: fc.constantFrom(0.2, 0.05, 0.5),
    ddmmRate: fc.constantFrom(0.25, 0, 0.5),
    untaggedExpenseRate: fc.constant(0.03)
}).map(o => ({ ...o, ...over })).map(opts => ({
    opts,
    shop: generateShop(opts),
    [fc.toStringMethod]: () => `generateShop(${JSON.stringify(opts)})`
}));

const sources = (s) => ({ purchases: s.purchases, wholesaleSales: s.wholesaleSales, retailSales: s.retailSales, stockAdjustments: s.stockAdjustments });
const allBills = (s) => [...s.purchases, ...s.wholesaleSales, ...s.retailSales];
const close = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const pad = (v) => String(v).padStart(2, '0');
const isoDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function load(s) {
    AppState.items = s.items;
    AppState.purchaseHistory = s.purchases;
    AppState.salesHistory = s.wholesaleSales;
    AppState.retailSalesHistory = s.retailSales;
    AppState.stockAdjustments = s.stockAdjustments;
    AppState.expensesHistory = s.expenses;
    AppState.withdrawalsHistory = s.withdrawals;
    AppState.historyLoadedFrom = 0;
    AppState.userRole = 'owner';
    AppState.settings = { showHindi: false };
}

/** Number shown in an element ("₹1,274", "-₹52" → number). */
function shown(id) {
    const text = document.getElementById(id).textContent.replace(/[,\s₹]/g, '');
    const m = text.match(/^([+-]?)(\d+(?:\.\d+)?)/);
    return (m[1] === '-' ? -1 : 1) * Number(m[2]);
}

/** Up to `k` evenly spread picks from a list (deterministic). */
const spread = (list, k) => (list.length <= k ? list : Array.from({ length: k }, (_, i) => list[Math.floor((i * (list.length - 1)) / (k - 1))]));

/** Calendar months [y, m] covered by the history. */
function monthsOf(s) {
    const out = [];
    const d = new Date(s.truth.start);
    for (let y = d.getFullYear(), m = d.getMonth(); new Date(y, m, 1).getTime() < s.truth.end; m++) {
        if (m === 12) { m = 0; y++; }
        out.push([y, m]);
    }
    return out;
}

beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(AnomaliesManager, 'renderDayReport').mockImplementation(() => {});
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    CashManagementManager.todaySession = null;
    ['purchaseHistory', 'salesHistory', 'retailSalesHistory', 'stockAdjustments', 'expensesHistory', 'withdrawalsHistory'].forEach(k => { AppState[k] = []; });
});

test('generator: multi-year, mixed shapes, never oversells', () => {
    const s = generateShop({ seed: 7, years: 3 });
    expect(allBills(s).length).toBeGreaterThan(2500);
    expect(s.purchases.some(b => /^\d\d\/\d\d\/\d{4}, /.test(b.date))).toBe(true);
    expect(s.retailSales.some(b => b.amountPaid !== undefined && !b.payment)).toBe(true);
    expect(s.retailSales.some(b => b.dueAmount !== undefined && !b.payment)).toBe(true);
    expect(s.wholesaleSales.every(b => b.items.every(l => l.quantity !== undefined))).toBe(true);
    expect(allBills(s).some(b => (b.payments || []).length > 1)).toBe(true);
    expect(allBills(s).some(b => (b.payments || []).some(p => p.kind === 'writeOff'))).toBe(true);
    expect(s.truth.deleted).toBeGreaterThan(0);
    expect(Object.values(s.truth.finalQty).every(q => q >= 0)).toBe(true);
});

// AC1 + AC8 -------------------------------------------------------------------

test('AC1 opening stock value + purchases − cost of goods sold ± corrections = closing stock value (each month)', () => {
    fc.assert(fc.property(shopArb(), ({ shop: s }) => {
        const src = sources(s);
        const appValueAt = (t) => Object.values(buildCheckpointState(src, t, s.items).state)
            .reduce((a, x) => a + (x.quantity > 0 && x.totalValue > 0 ? x.totalValue : 0), 0);
        for (const [y, m] of spread(monthsOf(s), 6)) {
            const from = new Date(y, m, 1).getTime();
            const to = new Date(y, m + 1, 1).getTime();
            const mv = O.stockReplay(s, [from, to]);
            const opening = appValueAt(from);
            const closing = appValueAt(to);
            if (!close(opening, mv.opening, 0.05) || !close(closing, mv.closing, 0.05)) return false;
            if (!close(opening + mv.purchases - mv.cogs + mv.adjustments, closing, 0.05)) return false;
        }
        return true;
    }), FC);
});

test('AC1 closing stock per item: app quantity and value == oracle; AC8 no negative stock', () => {
    fc.assert(fc.property(shopArb(), ({ shop: s }) => {
        const app = computeStock(sources(s), s.items);
        const want = O.stockReplay(s).perItem;
        return Object.entries(want).every(([k, v]) =>
            app[k] && close(app[k].quantity, v.qty, 1e-6) && close(app[k].quantity > 0 ? app[k].quantity * app[k].rate : 0, v.value, 0.05))
            && Object.values(app).every(x => x.quantity >= -1e-9)
            && Object.entries(s.truth.finalQty).every(([k, q]) => close(app[k]?.quantity ?? 0, q, 1e-6));
    }), FC);
});

// AC2 / AC3 -------------------------------------------------------------------

test('AC2 bill total = cash + online + due (+ written off), within ₹1, and matches what happened', () => {
    fc.assert(fc.property(shopArb(), ({ shop: s }) => allBills(s).every(b => {
        const p = readPayment(b);
        const truth = s.truth.bills[b.id];
        const writtenOff = Number(b.payment?.writtenOff) || 0;
        return Math.abs(p.cash + p.online + p.due + writtenOff - billTotal(b)) <= 1
            && billTotal(b) === truth.total
            && p.cash === truth.cash + truth.laterCash && p.online === truth.online + truth.laterOnline
            && outstandingDue(b) === truth.due;
    })), FC);
});

test('AC3 sum of payments[] = amount paid after the bill was saved', () => {
    fc.assert(fc.property(shopArb(), ({ shop: s }) => allBills(s).every(b => {
        const p = readPayment(b);
        const at = saleTimePayment(b);
        const later = (b.payments || []).map(entryParts).reduce((a, e) => ({ cash: a.cash + e.cash, online: a.online + e.online }), { cash: 0, online: 0 });
        const truth = s.truth.bills[b.id];
        return close(at.cash + later.cash, p.cash) && close(at.online + later.online, p.online)
            && at.cash === truth.atSaveCash && at.online === truth.atSaveOnline;
    })), FC);
});

// AC4 -------------------------------------------------------------------------

test('AC4 sum over months = all time (Reports screen; Finance sales, purchases, cost of goods sold, profit, cash flow)', () => {
    fc.assert(fc.property(shopArb({ years: 2 }), ({ shop: s }) => {
        load(s);
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        jest.setSystemTime(new Date(s.truth.end + 3600000));
        jest.spyOn(ReportsManager, 'renderTrendChart').mockImplementation(() => {});
        jest.spyOn(ReportsManager, 'renderTopItems').mockImplementation(() => {});
        document.body.innerHTML = ['reportsTotalVolume', 'reportsTotalPurchases', 'reportsTotalSales', 'reportsPurchaseCount', 'reportsSaleCount',
            'reportsGrossProfit', 'reportsProfitMargin', 'reportsTotalLabor', 'reportsCashPayment', 'reportsOnlinePayment', 'reportsDueToPay', 'reportsDueToReceive']
            .map(id => `<span id="${id}"></span>`).join('');
        const reports = () => { ReportsManager.renderOverview(); return { sales: shown('reportsTotalSales'), purchases: shown('reportsTotalPurchases') }; };
        const finance = (from, to) => {
            const f = FinanceManager.computeSummary({ from, to, cashSessions: { sessions: [], complete: true } });
            return { sales: f.sales.total, purchases: f.purchases.total, cogs: f.cogs, profit: f.profit, cash: f.cash.net };
        };

        ReportsManager.currentDateFilter = 'all';
        const allR = reports();
        const allF = finance(-Infinity, Infinity);
        const sumR = { sales: 0, purchases: 0 };
        const sumF = { sales: 0, purchases: 0, cogs: 0, profit: 0, cash: 0 };
        for (const [y, m] of monthsOf(s)) {
            ReportsManager.currentDateFilter = 'custom';
            ReportsManager.customStartDate = new Date(y, m, 1);
            ReportsManager.customEndDate = new Date(y, m + 1, 0, 23, 59, 59, 999);
            const r = reports();
            sumR.sales += r.sales; sumR.purchases += r.purchases;
            const f = finance(new Date(y, m, 1).getTime(), new Date(y, m + 1, 1).getTime());
            Object.keys(sumF).forEach(k => { sumF[k] += f[k]; });
        }
        const truthSales = Object.values(s.truth.bills).filter(b => b.kind !== 'purchase').reduce((a, b) => a + b.total, 0);
        const truthPurchases = Object.values(s.truth.bills).filter(b => b.kind === 'purchase').reduce((a, b) => a + b.total, 0);
        return sumR.sales === allR.sales && sumR.purchases === allR.purchases && allR.sales === truthSales
            && Object.keys(sumF).every(k => close(sumF[k], allF[k], 0.5))
            && allF.sales === truthSales && allF.purchases === truthPurchases;
    }), { ...FC, numRuns: Math.max(2, Math.ceil(RUNS / 2)) });
});

// AC5 -------------------------------------------------------------------------

test('AC5 Outstanding total = sum of open dues (Outstanding screen, Finance)', () => {
    fc.assert(fc.property(shopArb(), ({ shop: s }) => {
        load(s);
        const truth = Object.entries(s.truth.bills);
        const open = (pred) => truth.filter(([, b]) => pred(b)).reduce((a, [, b]) => a + b.due, 0);
        const screenTotal = (filter) => {
            document.body.innerHTML = '<div id="dueAging"></div><div id="dueList"></div>';
            AppState.currentDueFilter = filter;
            OutstandingManager.partyFilter = null;
            OutstandingManager.agingBucket = null;
            OutstandingManager.renderDue();
            let total = 0;
            document.querySelectorAll('#dueList .history-item .history-header').forEach(h => {
                total += Number(h.textContent.match(/Due: ₹([\d,.]+)/)[1].replace(/,/g, ''));
            });
            return total;
        };
        const fin = FinanceManager.calculateOutstanding();
        return screenTotal('purchase') === open(b => b.kind === 'purchase')
            && screenTotal('sale') === open(b => b.kind === 'retail')
            && close(fin.dueToPay, open(b => b.kind === 'purchase'))
            && close(fin.dueToReceive, open(b => b.kind !== 'purchase'));
    }), FC);
});

// AC6 -------------------------------------------------------------------------

test('AC6 drawer expected cash = opening + cash in − cash out (sampled days)', () => {
    fc.assert(fc.property(shopArb(), ({ shop: s }) => {
        load(s);
        return spread(s.sessions, 25).every(session => {
            const tx = CashManagementManager.calculateTransactionsForDate(session.date, session);
            const day = s.truth.cashDays[session.date] || { in: 0, out: 0 };
            return close(sessionTotals(session, tx).expected, session.openingBalance + day.in - day.out);
        });
    }), FC);
});

// AC7 -------------------------------------------------------------------------

/** Renders Today for the day containing `ms` and returns its numbers. */
function todayScreen(s, ms) {
    const ids = ['todayTotalPurchases', 'todayPurchaseCount', 'todayTotalSales', 'todaySaleCount', 'todayLaborCost', 'todayBusinessExpenses',
        'todayBusinessExpenseCount', 'todayPersonalExpenses', 'todayPersonalExpenseCount', 'todayTotalIn', 'todayTotalOut', 'todayNetCashFlow',
        'todayCashFlowLabel', 'todayCashReceived', 'todayOnlineReceived', 'todayCashPaid', 'todayOnlinePaid', 'todayTotalCashFlow',
        'todayDueReceived', 'todayDuePaid', 'todayDueToReceive', 'todayDueToPay', 'todayPurchaseItems', 'todaySaleItems'];
    document.body.innerHTML = ids.map(id => `<div id="${id}"></div>`).join('');
    jest.setSystemTime(new Date(ms));
    CashManagementManager.todaySession = s.sessions.find(x => x.date === isoDay(ms)) || null;
    DayManager.loadTodayData();
    return {
        T1_purchases: shown('todayTotalPurchases'), T2_sales: shown('todayTotalSales'), T3_labour: shown('todayLaborCost'),
        T4_businessExpenses: shown('todayBusinessExpenses'), T5_personalExpenses: shown('todayPersonalExpenses'),
        T6_cashIn: shown('todayCashReceived'), T7_onlineIn: shown('todayOnlineReceived'), T8_cashOut: shown('todayCashPaid'),
        T9_onlineOut: shown('todayOnlinePaid'), T10_totalIn: shown('todayTotalIn'), T11_totalOut: shown('todayTotalOut'),
        T13_dueReceived: shown('todayDueReceived'), T14_duePaid: shown('todayDuePaid'),
        T15_dueToReceive: shown('todayDueToReceive'), T16_dueToPay: shown('todayDueToPay')
    };
}

/** Same-day Today / Reports / cash drawer / oracle agreement for sampled days. */
function sameDayAgrees(s) {
    load(s);
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.spyOn(ReportsManager, 'renderTrendChart').mockImplementation(() => {});
    jest.spyOn(ReportsManager, 'renderTopItems').mockImplementation(() => {});
    return spread(s.sessions, 8).every(session => {
        const ms = O.timeOf(session.date) + 19 * 3600000;
        const t = todayScreen(s, ms);
        const want = O.today(s, ms, session);
        const tx = CashManagementManager.calculateTransactionsForDate(session.date, session);
        const okToday = Object.keys(t).every(k => t[k] === Math.round(want[k]));
        const okDrawer = close(t.T6_cashIn, Math.round(tx.cashSales + tx.dueReceived), 1)
            && close(t.T8_cashOut, Math.round(tx.cashPurchases + tx.duePaid + tx.businessExpenses + tx.personalExpenses), 1);
        document.body.innerHTML = '<span id="reportsTotalSales"></span><span id="reportsTotalPurchases"></span>';
        ReportsManager.currentDateFilter = 'today';
        ReportsManager.renderOverview();
        return okToday && okDrawer && shown('reportsTotalSales') === t.T2_sales;
    });
}

test('AC7 same day: Today == oracle, Today cash == drawer, Today sales == Reports (no untagged expenses)', () => {
    fc.assert(fc.property(shopArb({ untaggedExpenseRate: 0 }), ({ shop: s }) => sameDayAgrees(s)), FC);
});

// BUG: see #219 — Today drops untagged expenses, so Today and the drawer disagree when there are any
test.skip('AC7 same day agreement with untagged expenses (#219)', () => {
    fc.assert(fc.property(shopArb({ untaggedExpenseRate: 0.3 }), ({ shop: s }) => sameDayAgrees(s)), FC);
});

/** Same calendar month: Reports, Analytics, Finance (custom range) and the oracle. */
function sameMonth(s, check) {
    load(s);
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.spyOn(ReportsManager, 'renderTrendChart').mockImplementation(() => {});
    jest.spyOn(ReportsManager, 'renderTopItems').mockImplementation(() => {});
    ['renderMonthlyChart', 'renderProfitBreakdown', 'renderStockBreakdown', 'renderCashFlow', 'renderFullHistoryPrompt']
        .forEach(fn => jest.spyOn(FinanceManager, fn).mockImplementation(() => {}));
    return spread(monthsOf(s).slice(0, -1), 4).every(([y, m]) => {
        const now = new Date(y, m + 1, 0, 23, 59, 0).getTime(); // last minute of the month
        jest.setSystemTime(new Date(now));
        document.body.innerHTML = ['reportsTotalPurchases', 'reportsTotalSales', 'reportsGrossProfit', 'monthRevenue', 'monthPurchases',
            'monthProfit', 'monthExpenses', 'monthProfitMargin', 'monthExpensesCount']
            .map(id => `<span id="${id}"></span>`).join('') +
            '<div id="financeDashboardSection"><span id="financeRevenue"></span><span id="financeNetProfit"></span></div>';
        ReportsManager.currentDateFilter = 'month';
        ReportsManager.renderOverview();
        AnalyticsManager.renderMonthSummary();
        FinanceManager.currentDateFilter = 'custom';
        FinanceManager.customStartDate = `${y}-${pad(m + 1)}-01`;
        FinanceManager.customEndDate = isoDay(now);
        FinanceManager.renderDashboard();
        const want = O.reports(s, [new Date(y, m, 1).getTime(), new Date(y, m + 1, 1).getTime()]);
        return check({
            reports: { sales: shown('reportsTotalSales'), purchases: shown('reportsTotalPurchases'), profit: shown('reportsGrossProfit') },
            analytics: { sales: shown('monthRevenue'), purchases: shown('monthPurchases'), profit: shown('monthProfit') },
            finance: { sales: shown('financeRevenue'), profit: shown('financeNetProfit') },
            want
        });
    });
}

test('AC7 same month: sales on Reports == Analytics == Finance == oracle; Finance profit == oracle (ISO dates)', () => {
    fc.assert(fc.property(shopArb({ ddmmRate: 0, years: 1 }), ({ shop: s }) => sameMonth(s, ({ reports, analytics, finance, want }) =>
        reports.sales === Math.round(want.R2_sales) && analytics.sales === reports.sales && finance.sales === reports.sales
        && finance.profit === Math.round(want.R3_profit))), FC);
});

// BUG: see #49 — Analytics parses DD/MM/YYYY dates with new Date(), so its month misses those bills
test.skip('AC7 same month with DD/MM dates: Analytics sales == Reports (#49)', () => {
    fc.assert(fc.property(shopArb({ ddmmRate: 0.4, years: 1 }), ({ shop: s }) => sameMonth(s, ({ reports, analytics }) => analytics.sales === reports.sales)), FC);
});

test('AC7 same month: purchases and profit agree on Reports, Analytics and Finance (#36, #47)', () => {
    fc.assert(fc.property(shopArb({ ddmmRate: 0, years: 1 }), ({ shop: s }) => sameMonth(s, ({ reports, analytics, finance, want }) =>
        reports.purchases === Math.round(want.R1_purchases) && analytics.purchases === reports.purchases
        && reports.profit === finance.profit && analytics.profit === finance.profit)), FC);
});

test('AC1/AC7 each month: Finance cost of goods sold, profit and cash flow == oracle (#215)', () => {
    fc.assert(fc.property(shopArb({ years: 1 }), ({ shop: s }) => spread(monthsOf(s).slice(0, -1), 4).every(([y, m]) => {
        const from = new Date(y, m, 1).getTime();
        const to = new Date(y, m + 1, 1).getTime();
        const got = computeFinanceSummary({
            sources: sources(s), items: s.items, base: { state: {}, from: -Infinity }, expenses: s.expenses, withdrawals: s.withdrawals, from, to
        });
        const want = O.finance(s, [from, to]);
        return close(got.sales.total, want.F1_sales) && close(got.cogs, want.F2_cogs, 0.05) && close(got.profit, want.F4_profit, 0.05)
            && close(got.cash.net, want.F7_cashFlow, 0.05) && close(got.stock.gap, 0, 0.05);
    })), FC);
});