/**
 * @fileoverview Real-data number audit (#216), run by tools/audit/real-data-audit.js
 * through Jest (jsdom + Babel, the same environment as tests/oracle). Not part of
 * `npm test`: it needs a backup file (AUDIT_BACKUP) and never runs in CI.
 *
 * For every audited period each number is computed twice: by the independent
 * oracle (tests/oracle/oracle.js) and by the app's own code, the functions the
 * screens call (DayManager, ReportsManager, FinanceManager, AnalyticsManager,
 * OutstandingManager, CashManagementManager, stock-replay, rate-trends,
 * number-checks). App modules come from `@app/` (AUDIT_APP_ROOT, default this
 * checkout), so the same audit can run against another branch's www/.
 */
import fs from 'fs';
import * as O from '../../tests/oracle/oracle.js';
import { loadBackup, auditPeriods, Collector, dataQuality, renderReport, isoDay, negativeDips, withoutItems } from './audit-lib.js';
import { CAUSES, causeFor } from './causes.js';
import { DayManager } from '@app/modules/day.js';
import { AnomaliesManager } from '@app/modules/anomalies.js';
import { FinanceManager } from '@app/modules/finance.js';
import { ReportsManager } from '@app/modules/reports.js';
import { AnalyticsManager } from '@app/modules/analytics.js';
import { OutstandingManager } from '@app/modules/outstanding.js';
import { CashManagementManager } from '@app/modules/cash-management.js';
import { AppState } from '@app/utils/state.js';
import { sessionTotals } from '@app/utils/cash-session.js';
import { computeStock } from '@app/utils/stock-replay.js';
import { profitByDay, computeFinanceSummary } from '@app/utils/finance-calc.js';
import { runNumberChecks } from '@app/utils/number-checks.js';
import { billsToYearDocs, monthBuckets, weekBuckets } from '@app/utils/rate-trends.js';
import { monthBucketsFor, trafficRows } from '@app/utils/product-traffic.js';

const ENV = process.env;
jest.setTimeout(30 * 60 * 1000);

const r2 = O.r2;
const rupee = (v) => Math.round(v);

/** Number shown in an element: "₹1,274", "-₹52", "+₹350" → number (NaN when missing). */
function shown(id) {
    const el = document.getElementById(id);
    if (!el) return NaN;
    const text = el.textContent.replace(/[,\s₹]/g, '');
    const m = text.match(/^([+-]?)(\d+(?:\.\d+)?)/);
    return m ? (m[1] === '-' ? -1 : 1) * Number(m[2]) : NaN;
}

function load(data) {
    AppState.items = data.items;
    AppState.purchaseHistory = data.purchases;
    AppState.salesHistory = data.wholesaleSales;
    AppState.retailSalesHistory = data.retailSales;
    AppState.stockAdjustments = data.stockAdjustments;
    AppState.expensesHistory = data.expenses;
    AppState.withdrawalsHistory = data.withdrawals;
    AppState.historyLoadedFrom = 0;
    AppState.userRole = 'owner';
    AppState.settings = { showHindi: false };
}

const at = (ms) => jest.setSystemTime(new Date(ms));

// ------------------------------------------------------------------ screens

const TODAY = {
    T1_purchases: 'todayTotalPurchases', T2_sales: 'todayTotalSales', T3_labour: 'todayLaborCost',
    T4_businessExpenses: 'todayBusinessExpenses', T5_personalExpenses: 'todayPersonalExpenses',
    T6_cashIn: 'todayCashReceived', T7_onlineIn: 'todayOnlineReceived', T8_cashOut: 'todayCashPaid', T9_onlineOut: 'todayOnlinePaid',
    T10_totalIn: 'todayTotalIn', T11_totalOut: 'todayTotalOut', T13_dueReceived: 'todayDueReceived', T14_duePaid: 'todayDuePaid',
    T15_dueToReceive: 'todayDueToReceive', T16_dueToPay: 'todayDueToPay'
};
function todayScreen(ms, session) {
    const ids = [...Object.values(TODAY), 'todayPurchaseCount', 'todaySaleCount', 'todayNetCashFlow', 'todayCashFlowLabel', 'todayTotalCashFlow',
        'todayBusinessExpenseCount', 'todayPersonalExpenseCount', 'todayPurchaseItems', 'todaySaleItems'];
    document.body.innerHTML = ids.map(id => `<div id="${id}"></div>`).join('');
    at(ms);
    CashManagementManager.todaySession = session || null;
    DayManager.loadTodayData();
    const out = {};
    Object.entries(TODAY).forEach(([k, id]) => { out[k] = shown(id); });
    out.T1_purchaseCount = shown('todayPurchaseCount');
    out.T2_saleCount = shown('todaySaleCount');
    const net = shown('todayNetCashFlow');
    out.T12_net = /outflow/i.test(document.getElementById('todayCashFlowLabel').textContent) ? -net : net;
    return out;
}

const REPORTS = {
    R1_purchases: 'reportsTotalPurchases', R2_sales: 'reportsTotalSales', R3_profit: 'reportsGrossProfit', R4_cash: 'reportsCashPayment',
    R5_online: 'reportsOnlinePayment', R6_dueToPay: 'reportsDueToPay', R7_dueToReceive: 'reportsDueToReceive', R8_labour: 'reportsTotalLabor'
};
function reportsScreen(p) {
    document.body.innerHTML = [...Object.values(REPORTS), 'reportsTotalVolume', 'reportsPurchaseCount', 'reportsSaleCount', 'reportsProfitMargin']
        .map(id => `<span id="${id}"></span>`).join('');
    at(p.now);
    if (p.kind === 'all') {
        ReportsManager.currentDateFilter = 'all';
    } else {
        ReportsManager.currentDateFilter = 'custom';
        ReportsManager.customStartDate = new Date(p.from);
        ReportsManager.customEndDate = new Date(p.to - 1);
    }
    ReportsManager.renderOverview();
    const out = {};
    Object.entries(REPORTS).forEach(([k, id]) => { out[k] = shown(id); });
    out.R1_purchaseCount = shown('reportsPurchaseCount');
    out.R2_saleCount = shown('reportsSaleCount');
    return out;
}

function analyticsScreen(now) {
    const ids = ['monthRevenue', 'monthPurchases', 'monthExpenses', 'monthProfit', 'totalPayable', 'payableCount', 'totalReceivable', 'receivableCount',
        'monthProfitMargin', 'monthExpensesCount', 'monthRevenueGrowth', 'monthPurchasesGrowth'];
    document.body.innerHTML = ids.map(id => `<span id="${id}"></span>`).join('');
    at(now);
    AnalyticsManager.renderMonthSummary();
    AnalyticsManager.renderOutstandingDues();
    return {
        A1_revenue: shown('monthRevenue'), A2_purchases: shown('monthPurchases'), A3_expenses: shown('monthExpenses'), A3_expenseCount: shown('monthExpensesCount'),
        A4_profit: shown('monthProfit'), A5_payable: shown('totalPayable'), A5_payableCount: shown('payableCount'),
        A6_receivable: shown('totalReceivable'), A6_receivableCount: shown('receivableCount')
    };
}

function financeAllScreen(now) {
    const SCREEN = {
        F1_sales: 'financeRevenue', F2_cogs: 'financeCogs', F3_businessExpenses: 'financeBusinessExp', F4_profit: 'financeNetProfit',
        F5_personalExpenses: 'financePersonalExp', F6_stockValue: 'financeStockNow', F11_withdrawals: 'financeTotalWithdrawn'
    };
    at(now);
    FinanceManager.currentDateFilter = 'all';
    document.body.innerHTML = `<div id="financeDashboardSection">${[...Object.values(SCREEN), 'financeProfitPeriod', 'financeAfterPersonalLine',
        'financeRevenueCount', 'financeBusinessExpCount', 'financePersonalExpCount', 'financeAvailableBalance', 'financeProfitWarning']
        .map(id => `<span id="${id}"></span>`).join('')}</div>`;
    FinanceManager.renderDashboard();
    const out = {};
    Object.entries(SCREEN).forEach(([k, id]) => { out[k] = shown(id); });
    return out;
}

/** Per-party dues on Outstanding (party → amount; names stay in memory only). */
function outstandingScreen(filter) {
    document.body.innerHTML = '<div id="dueAging"></div><div id="dueList"></div>';
    AppState.currentDueFilter = filter;
    OutstandingManager.partyFilter = null;
    OutstandingManager.agingBucket = null;
    OutstandingManager.renderDue();
    const byParty = {};
    document.querySelectorAll('#dueList .history-item').forEach(row => {
        const name = row.querySelector('.history-header strong')?.textContent || '';
        const m = row.querySelector('.history-header').textContent.match(/Due: ₹([\d,.]+)/);
        byParty[name] = r2((byParty[name] || 0) + (m ? Number(m[1].replace(/,/g, '')) : NaN));
    });
    const totalEl = document.querySelector('#dueAging .aging-total');
    // No dues: the list shows its empty state and no aging panel, i.e. a total of 0.
    const empty = !Object.keys(byParty).length;
    return { byParty, total: totalEl ? Number(totalEl.textContent.replace(/[^\d.]/g, '')) : (empty ? 0 : NaN) };
}

const financeSummary = (from, to, detail = false) => FinanceManager.computeSummary({ from, to, detail, cashSessions: { sessions: [], complete: true } });

// ------------------------------------------------------------------ one data set

/**
 * Every comparison for one data set.
 * @param {Collector} C
 * @param {string} scope 'real' | 'migrated'
 * @param {Object} data loadBackup().data shape
 * @param {Array} periods auditPeriods()
 * @param {number} nowMs
 */
function auditDataset(C, scope, data, periods, nowMs) {
    load(data);
    const cmp = (spec, page, period, oracle, app, unit = 'money') => C.compare({ spec, page, period, oracle, app, unit, scope });
    const chk = (spec, page, period, ok, expected = null, actual = null, unit = 'money') => C.check({ spec, page, period, ok, expected, actual, unit, scope });
    const sessionOn = (day) => (data.sessions || []).find(s => s.date === day) || null;
    const months = { reports: { R1: 0, R2: 0 }, finance: { F1: 0, F2: 0, F4: 0, F7: 0 } };
    // Items whose stock went below zero (sold before bought): the app writes the refilled deficit off (#215),
    // the oracle carries it forward. Cost of goods sold on the other items must still agree exactly.
    const dipped = negativeDips(data).items;
    const clean = dipped.length ? withoutItems(data, dipped) : null;
    const cleanSources = clean && { purchases: clean.purchases, wholesaleSales: clean.wholesaleSales, retailSales: clean.retailSales, stockAdjustments: clean.stockAdjustments };

    for (const p of periods) {
        const range = [p.from, p.to];
        const label = p.kind === 'all' ? 'all time' : p.label;

        // ---- Today (days only)
        let today = null;
        if (p.kind === 'day') {
            const session = sessionOn(p.label);
            const want = O.today(data, p.now, session);
            today = todayScreen(p.now, session);
            Object.keys(TODAY).forEach(k => cmp(k, 'Today', label, rupee(want[k]), today[k]));
            cmp('T12_net', 'Today', label, rupee(want.T12_net), today.T12_net);
            cmp('T1_purchaseCount', 'Today', label, want.T1_purchaseCount, today.T1_purchaseCount, 'count');
            cmp('T2_saleCount', 'Today', label, want.T2_saleCount, today.T2_saleCount, 'count');

            // ---- Cash drawer on that day (C*, AC6, AC7 Today cash == drawer)
            if (session) {
                const tx = CashManagementManager.calculateTransactionsForDate(session.date, session);
                const dw = O.drawer(data, session);
                [['C1_cashSales', 'cashSales'], ['C2_cashPurchases', 'cashPurchases'], ['C3_businessExpenses', 'businessExpenses'],
                    ['C3_personalExpenses', 'personalExpenses'], ['C4_dueReceived', 'dueReceived'], ['C5_duePaid', 'duePaid'], ['C6_deposits', 'cashDeposits']]
                    .forEach(([k, f]) => cmp(k, 'Cash drawer', label, dw[k], tx[f]));
                const live = sessionTotals(session, tx).expected;
                cmp('C7_expected', 'Cash drawer', label, dw.C7_expected, live);
                chk('AC7_today_cash_vs_drawer', 'Today vs Cash drawer', label,
                    Math.abs(today.T6_cashIn - rupee(tx.cashSales + tx.dueReceived)) <= 1, rupee(tx.cashSales + tx.dueReceived), today.T6_cashIn);
            }
        }

        // ---- Reports
        const rep = reportsScreen(p);
        const wantR = O.reports(data, range);
        ['R1_purchases', 'R2_sales', 'R3_profit', 'R4_cash', 'R5_online', 'R8_labour'].forEach(k => cmp(k, 'Reports', label, rupee(wantR[k]), rep[k]));
        cmp('R1_purchaseCount', 'Reports', label, wantR.R1_purchaseCount, rep.R1_purchaseCount, 'count');
        cmp('R2_saleCount', 'Reports', label, wantR.R2_saleCount, rep.R2_saleCount, 'count');
        if (p.kind === 'all') {
            cmp('R6_dueToPay', 'Reports', label, rupee(wantR.R6_dueToPay), rep.R6_dueToPay);
            cmp('R7_dueToReceive', 'Reports', label, rupee(wantR.R7_dueToReceive), rep.R7_dueToReceive);
        }

        // ---- Finance (the function its dashboard calls)
        const fin = financeSummary(p.from, p.to);
        const wantF = O.finance(data, range);
        cmp('F1_sales', 'Finance', label, wantF.F1_sales, fin.sales.total);
        cmp('F1_saleCount', 'Finance', label, wantF.F1_saleCount, fin.sales.count, 'count');
        cmp('F2_cogs', 'Finance', label, wantF.F2_cogs, fin.cogs);
        cmp('F3_businessExpenses', 'Finance', label, wantF.F3_businessExpenses, fin.expenses.business);
        cmp('F4_profit', 'Finance', label, wantF.F4_profit, fin.profit);
        cmp('F5_personalExpenses', 'Finance', label, wantF.F5_personalExpenses, fin.expenses.personal);
        cmp('F7_cashFlow', 'Finance', label, wantF.F7_cashFlow, fin.cash.net);
        cmp('F11_withdrawals', 'Finance', label, wantF.F11_withdrawals, fin.withdrawn);
        const c = wantF.F8_check;
        chk('AC1_check_line', 'Finance (oracle)', label, Math.abs(c.opening + c.purchases - c.cogs + c.adjustments - c.closing) <= 1,
            c.closing, r2(c.opening + c.purchases - c.cogs + c.adjustments));
        if (fin.stock) chk('F8_gap', 'Finance', label, Math.abs(fin.stock.gap) <= 1, 0, fin.stock.gap);
        if (clean) {
            const appClean = computeFinanceSummary({ sources: cleanSources, items: clean.items, base: { state: {}, from: -Infinity }, from: p.from, to: p.to });
            const wantClean = O.stockReplay(clean, range);
            cmp('F2_cogs_items_never_below_zero', 'Finance', label, wantClean.cogs, appClean.cogs);
            chk('F8_gap_items_never_below_zero', 'Finance', label, Math.abs(appClean.stock.gap) <= 1, 0, appClean.stock.gap);
        }

        // ---- Same period, same number (AC7)
        if (today) {
            chk('AC7_sales_today_reports', 'Today vs Reports', label, today.T2_sales === rep.R2_sales, today.T2_sales, rep.R2_sales);
            chk('AC7_sales_today_finance', 'Today vs Finance', label, Math.abs(today.T2_sales - fin.sales.total) <= 1, today.T2_sales, r2(fin.sales.total));
            chk('AC7_purchases_today_reports', 'Today vs Reports', label, today.T1_purchases === rep.R1_purchases, today.T1_purchases, rep.R1_purchases);
        }
        chk('AC7_sales_reports_finance', 'Reports vs Finance', label, Math.abs(rep.R2_sales - fin.sales.total) <= 1, r2(fin.sales.total), rep.R2_sales);
        if (fin.profit !== null) chk('AC7_profit_reports_finance', 'Reports vs Finance', label, Math.abs(rep.R3_profit - fin.profit) <= 1, r2(fin.profit), rep.R3_profit);

        if (p.kind === 'month') {
            // ---- Analytics "this month" seen at the end of that month
            const an = analyticsScreen(p.now);
            const wantA = O.analyticsMonth(data, p.now);
            ['A1_revenue', 'A2_purchases', 'A3_expenses', 'A4_profit'].forEach(k => cmp(k, 'Analytics', label, rupee(wantA[k]), an[k]));
            cmp('A3_expenseCount', 'Analytics', label, wantA.A3_expenseCount, an.A3_expenseCount, 'count');
            chk('AC7_sales_analytics_reports', 'Analytics vs Reports', label, an.A1_revenue === rep.R2_sales, rep.R2_sales, an.A1_revenue);
            if (fin.profit !== null) chk('AC7_profit_analytics_finance', 'Analytics vs Finance', label, Math.abs(an.A4_profit - fin.profit) <= 1, r2(fin.profit), an.A4_profit);
            months.reports.R1 += rep.R1_purchases; months.reports.R2 += rep.R2_sales;
            months.finance.F1 += fin.sales.total; months.finance.F2 += fin.cogs || 0; months.finance.F4 += fin.profit || 0; months.finance.F7 += fin.cash.net;
        }

        if (p.kind === 'all') {
            // ---- AC4: months add up to all time (only when the audited months cover every bill)
            const covered = periods.filter(x => x.kind === 'month');
            const earliest = Math.min(...covered.map(x => x.from));
            const allDated = [...data.purchases, ...data.retailSales, ...data.wholesaleSales].every(b => O.timeOf(b.date) >= earliest && O.timeOf(b.date) < nowMs + 86400000);
            if (allDated && covered.length) {
                chk('AC4_months_eq_all', 'Reports (R1)', 'months vs all time', Math.abs(months.reports.R1 - rep.R1_purchases) <= covered.length, rep.R1_purchases, months.reports.R1);
                chk('AC4_months_eq_all', 'Reports (R2)', 'months vs all time', Math.abs(months.reports.R2 - rep.R2_sales) <= covered.length, rep.R2_sales, months.reports.R2);
                chk('AC4_months_eq_all', 'Finance (F1)', 'months vs all time', Math.abs(months.finance.F1 - fin.sales.total) <= 1, fin.sales.total, r2(months.finance.F1));
                chk('AC4_months_eq_all', 'Finance (F2)', 'months vs all time', Math.abs(months.finance.F2 - (fin.cogs || 0)) <= 1, fin.cogs, r2(months.finance.F2));
                chk('AC4_months_eq_all', 'Finance (F4)', 'months vs all time', Math.abs(months.finance.F4 - (fin.profit || 0)) <= 1, fin.profit, r2(months.finance.F4));
                chk('AC4_months_eq_all', 'Finance (F7)', 'months vs all time', Math.abs(months.finance.F7 - fin.cash.net) <= 1, fin.cash.net, r2(months.finance.F7));
            }

            // ---- Finance screen, assets, stock
            const fs2 = financeAllScreen(p.now);
            ['F1_sales', 'F2_cogs', 'F3_businessExpenses', 'F4_profit', 'F5_personalExpenses', 'F6_stockValue', 'F11_withdrawals']
                .forEach(k => cmp(k, 'Finance screen', label, rupee(wantF[k]), fs2[k]));
            cmp('F6_stockValue', 'Finance', label, wantF.F6_stockValue, fin.stock ? fin.stock.now : NaN);
            const assets = FinanceManager.calculateOutstanding();
            cmp('F9_dueToReceive', 'Finance', label, wantF.F9_dueToReceive, assets.dueToReceive);
            cmp('F10_dueToPay', 'Finance', label, wantF.F10_dueToPay, assets.dueToPay);

            const app = computeStock({ purchases: data.purchases, wholesaleSales: data.wholesaleSales, retailSales: data.retailSales, stockAdjustments: data.stockAdjustments }, data.items);
            const want = O.stockReplay(data).perItem;
            const itemName = (k) => (data.items.find(i => i.id === k)?.name) || k;
            Object.entries(want).forEach(([k, v]) => {
                const a = app[k] || { quantity: 0, rate: 0 };
                cmp('S1_quantity', 'Stock', itemName(k), v.qty, a.quantity, 'kg');
                if (v.qty > 0) cmp('S3_value', 'Stock', itemName(k), v.value, a.quantity > 0 ? a.quantity * a.rate : 0);
            });
            const appTotal = Object.values(app).reduce((s, x) => s + (x.quantity > 0 ? x.quantity * x.rate : 0), 0);
            cmp('S4_total', 'Stock', label, wantF.F6_stockValue, r2(appTotal));

            // ---- Analytics outstanding (A5/A6) and Outstanding (O*)
            const an = analyticsScreen(p.now);
            const wantA = O.analyticsMonth(data, p.now);
            cmp('A5_payable', 'Analytics', label, rupee(wantA.A5_payable), an.A5_payable);
            cmp('A5_payableCount', 'Analytics', label, wantA.A5_payableCount, an.A5_payableCount, 'count');
            cmp('A6_receivable', 'Analytics', label, rupee(wantA.A6_receivable), an.A6_receivable);
            cmp('A6_receivableCount', 'Analytics', label, wantA.A6_receivableCount, an.A6_receivableCount, 'count');

            const wantO = O.outstanding(data);
            const pay = outstandingScreen('purchase');
            const sale = outstandingScreen('sale');
            const parties = (want2, got, spec) => {
                const keys = [...new Set([...Object.keys(want2), ...Object.keys(got)])].sort();
                keys.forEach((k, i) => cmp(spec, 'Outstanding', `party ${i + 1} of ${keys.length}`, want2[k] || 0, got[k] || 0));
            };
            parties(wantO.O1_payableByParty, pay.byParty, 'O1_payableByParty');
            parties(wantO.O2_receivableByParty, sale.byParty, 'O2_receivableByParty');
            cmp('O3_payableTotal', 'Outstanding', label, rupee(wantO.O3_payableTotal), pay.total);
            cmp('O4_receivableTotal', 'Outstanding', label, rupee(wantO.O4_receivableTotal), sale.total);

            // ---- Cross-page dues (AC5)
            chk('AC5_due_to_pay', 'Finance vs Reports vs Analytics vs Outstanding', label,
                [rep.R6_dueToPay, an.A5_payable, pay.total].every(v => Math.abs(v - assets.dueToPay) <= 1), assets.dueToPay, rep.R6_dueToPay);
            chk('AC5_due_to_receive', 'Finance vs Reports vs Analytics', label,
                [rep.R7_dueToReceive, an.A6_receivable].every(v => Math.abs(v - assets.dueToReceive) <= 1), assets.dueToReceive, an.A6_receivable);
        }
    }

    // ---- A7 profit trend: per-day profit == Finance profit of that day (last audited days)
    const days = periods.filter(p => p.kind === 'day');
    if (days.length) {
        const first = Math.min(...days.map(d => d.from));
        at(Math.max(...days.map(d => d.now)));
        const summary = FinanceManager.profitSummary({ from: first, to: Infinity, detail: true });
        if (summary.profit !== null) {
            const byDay = profitByDay(summary.detail, isoDay);
            days.forEach(d => {
                cmp('A7_profitByDay', 'Analytics', d.label, O.finance(data, [d.from, d.to]).F4_profit, byDay[d.label] || 0);
                const f = financeSummary(d.from, d.to);
                if (f.profit !== null) chk('AC7_profitByDay_vs_finance', 'Analytics vs Finance', d.label, Math.abs((byDay[d.label] || 0) - f.profit) <= 1, f.profit, byDay[d.label] || 0);
            });
        }
    }

    // ---- Cash drawer for every session (AC6: stored expected vs recomputed)
    (data.sessions || []).forEach(s => {
        if (!s.signedOut || !Number.isFinite(Number(s.expectedBalance))) return;
        const tx = CashManagementManager.calculateTransactionsForDate(s.date, s);
        const live = sessionTotals(s, tx).expected;
        chk('AC6_stored_vs_live', 'Cash drawer', s.date, Math.abs(Number(s.expectedBalance) - live) <= 1, live, r2(Number(s.expectedBalance)));
        // Which part of the drawer moved since it was closed (the session keeps its totals at close).
        if (s.transactions && typeof s.transactions === 'object') {
            ['cashSales', 'cashPurchases', 'businessExpenses', 'personalExpenses', 'dueReceived', 'duePaid', 'cashDeposits'].forEach(f => {
                if (s.transactions[f] === undefined) return;
                chk('AC6_stored_part', `Cash drawer (${f})`, s.date, Math.abs(Number(s.transactions[f]) - Number(tx[f])) <= 1, r2(Number(tx[f])), r2(Number(s.transactions[f])));
            });
        }
        cmp('C7_expected_all', 'Cash drawer', s.date, O.drawer(data, s).C7_expected, live);
    });

    // ---- Rate trends RT1/RT4 and product traffic PT1, per month
    const src = { purchase: data.purchases, retail: data.retailSales, wholesale: data.wholesaleSales };
    const docs = Object.entries(billsToYearDocs(src, data.items)).map(([id, d]) => ({ id, ...d }));
    const wantM = O.rateBuckets(src, data.items, O.monthOf);
    const itemName = (k) => (data.items.find(i => i.id === k)?.name) || k;
    const seen = new Set();
    monthBuckets(docs).forEach(b => ['purchase', 'retail', 'wholesale'].forEach(k => {
        if (!(b[k]?.kg > 0)) return;
        const w = wantM[b.itemId]?.[b.month]?.[k] || { kg: 0, amount: 0, bills: 0 };
        seen.add(`${b.itemId}|${b.month}|${k}`);
        const per = `${itemName(b.itemId)} ${b.month} ${k}`;
        cmp('RT4_kg', 'Rate trends', per, w.kg, b[k].kg, 'kg');
        cmp('RT4_bills', 'Rate trends', per, w.bills, b[k].bills, 'count');
        cmp('RT1_amount', 'Rate trends', per, w.amount, b[k].amount);
    }));
    Object.entries(wantM).forEach(([item, byM]) => Object.entries(byM).forEach(([m, byK]) => Object.keys(byK).forEach(k => {
        if (!seen.has(`${item}|${m}|${k}`)) cmp('RT4_kg', 'Rate trends', `${itemName(item)} ${m} ${k}`, byK[k].kg, 0, 'kg');
    })));
    const wantW = O.rateBuckets(src, data.items, O.weekOf);
    let weekKg = 0;
    let weekKgWant = 0;
    weekBuckets(docs).forEach(b => ['purchase', 'retail', 'wholesale'].forEach(k => { weekKg += b[k]?.kg || 0; }));
    Object.values(wantW).forEach(byW => Object.values(byW).forEach(byK => Object.values(byK).forEach(s => { weekKgWant += s.kg; })));
    cmp('RT4_weekly_total_kg', 'Rate trends', 'all weeks', r2(weekKgWant), r2(weekKg), 'kg');
    periods.filter(p => p.kind === 'month').forEach(p => {
        const rows = trafficRows(monthBucketsFor(docs, p.label));
        rows.forEach(r => {
            const w = wantM[r.itemId]?.[p.label] || {};
            const kg = r2(['purchase', 'retail', 'wholesale'].reduce((a, k) => a + (w[k]?.kg || 0), 0));
            cmp('PT1_kg', 'Product traffic', `${itemName(r.itemId)} ${p.label}`, kg, r.kg, 'kg');
        });
    });
}

// ------------------------------------------------------------------ migrated state

/** Opening records + catalogue from a migration bundle, plus a few synthetic bills on the go-live day. */
function migratedData(bundle, goLive) {
    const pick = (coll) => bundle.writes.filter(w => w.coll === coll).map(w => ({ id: w.id, ...w.data }));
    const items = pick('items');
    const openings = { purchases: pick('purchases'), wholesaleSales: pick('wholesaleSales'), retailSales: pick('retailSales') };
    const item = items[0];
    const t = (h, m = 0) => { const d = new Date(goLive); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime(); };
    const iso = (ms) => new Date(ms).toISOString();
    const line = (qty, rate) => ({ itemId: item.id, name: item.name, qty, rate, total: qty * rate });
    const purchases = [...openings.purchases, {
        id: 'syn-p1', billNumber: 'SYN-P1', customerName: 'Synthetic supplier', date: iso(t(9)), timestamp: t(9), type: 'purchase', isPurchase: true,
        items: [line(100, 30)], billTotal: 3000, laborCharges: 0, grandTotal: 3000, amountPayable: 3000,
        cashPayment: 2000, onlinePayment: 500, dueAmount: 500, payment: { cash: 2000, online: 500, due: 500, total: 3000 }
    }];
    const retailSales = [...openings.retailSales.map(o => ({ ...o })), {
        id: 'syn-r1', billNumber: 'SYN-R1', customerName: 'Synthetic customer', date: iso(t(10)), timestamp: t(10), type: 'retail',
        items: [line(10, 40)], total: 400, cashPayment: 300, onlinePayment: 0, dueAmount: 100, payment: { cash: 300, online: 0, due: 100, total: 400 }
    }, {
        id: 'syn-r2', billNumber: 'SYN-R2', customerName: '', date: iso(t(11)), timestamp: t(11), type: 'retail',
        items: [line(5, 40)], total: 200, cashPayment: 0, onlinePayment: 200, dueAmount: 0, payment: { cash: 0, online: 200, due: 0, total: 200 }
    }];
    // A due payment on a carried opening record, made on the go-live day: money in today, but the opening itself stays out.
    const target = retailSales.find(b => b.openingBalance && b.openingBalance.amount >= 10);
    const leg = { id: 'syn-pay-1', cash: 10, online: 0, date: iso(t(12)), at: t(12) };
    if (target) {
        target.payments = [leg];
        target.payment = { ...target.payment, cash: 10, due: target.payment.due - 10 };
        target.cashPayment = 10;
        target.dueAmount = target.payment.due;
    }
    const expenses = [{ id: 'syn-e1', amount: 50, category: 'business', type: 'Synthetic', date: iso(t(13)), timestamp: t(13) }];
    const sessions = [{
        id: 'syn-s1', date: isoDay(t(9)), openingBalance: 1000, cashDeposits: [], signedOut: false,
        duePayments: target ? [{ id: leg.id, type: 'received', cash: 10, online: 0, at: leg.at, billId: target.id }] : []
    }];
    return {
        data: { items, purchases, wholesaleSales: openings.wholesaleSales, retailSales, stockAdjustments: [], expenses, withdrawals: [], sessions },
        openingCount: openings.purchases.length + openings.wholesaleSales.length + openings.retailSales.length,
        paidOpening: !!target
    };
}

// ------------------------------------------------------------------ run

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'hrtime', 'performance'] });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(AnomaliesManager, 'renderDayReport').mockImplementation(() => {});
    jest.spyOn(ReportsManager, 'renderTrendChart').mockImplementation(() => {});
    jest.spyOn(ReportsManager, 'renderTopItems').mockImplementation(() => {});
    ['renderMonthlyChart', 'renderProfitBreakdown', 'renderStockBreakdown', 'renderCashFlow', 'renderFullHistoryPrompt']
        .forEach(fn => jest.spyOn(FinanceManager, fn).mockImplementation(() => {}));
});

const run = ENV.AUDIT_BACKUP ? test : test.skip;

run('real-data number audit', () => {
    const started = process.hrtime.bigint();
    const { exportedAt, data } = loadBackup(JSON.parse(fs.readFileSync(ENV.AUDIT_BACKUP, 'utf8')));
    const nowMs = ENV.AUDIT_NOW ? Date.parse(ENV.AUDIT_NOW) : exportedAt;
    const opts = { days: Number(ENV.AUDIT_DAYS) || 60, months: Number(ENV.AUDIT_MONTHS) || 24 };
    const C = new Collector();
    const notes = [];

    auditDataset(C, 'real', data, auditPeriods(nowMs, opts), nowMs);
    load(data);
    CashManagementManager.todaySession = null;
    const numberChecks = runNumberChecks(data, { fullHistory: true });
    const quality = dataQuality(data, exportedAt);

    const migrated = [];
    if (ENV.AUDIT_BUNDLE && fs.existsSync(ENV.AUDIT_BUNDLE)) {
        const bundle = JSON.parse(fs.readFileSync(ENV.AUDIT_BUNDLE, 'utf8'));
        const cutoff = bundle.writes.find(w => w.group === 'opening')?.data?.openingBalance?.asOf || nowMs;
        const d = new Date(cutoff);
        const goLive = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 18).getTime();
        const m = migratedData(bundle, goLive);
        const openDays = new Set(m.data.retailSales.concat(m.data.purchases, m.data.wholesaleSales).filter(O.isOpening).map(b => isoDay(O.timeOf(b.date))));
        const periods = auditPeriods(goLive, { days: 2, months: 1 });
        // Also look at every day an opening record is dated on (they carry the old bill's date).
        openDays.forEach(day => {
            if (periods.some(p => p.label === day)) return;
            const [y, mo, dd] = day.split('-').map(Number);
            const from = new Date(y, mo - 1, dd).getTime();
            periods.push({ kind: 'day', label: day, from, to: new Date(y, mo - 1, dd + 1).getTime(), now: new Date(y, mo - 1, dd, 23, 59).getTime() });
        });
        periods.sort((a, b) => (a.kind === 'all') - (b.kind === 'all') || (a.kind === 'month') - (b.kind === 'month'));
        const before = C.mismatches.length;
        auditDataset(C, 'migrated', m.data, periods, goLive);
        const found = C.mismatches.slice(before);
        // Is anything from an opening record in a period figure? Compare the app with the openings removed.
        const withoutOpenings = { ...m.data, purchases: m.data.purchases.filter(b => !O.isOpening(b)), retailSales: m.data.retailSales.filter(b => !O.isOpening(b)), wholesaleSales: m.data.wholesaleSales.filter(b => !O.isOpening(b)) };
        let leaked = 0;
        const leakedSpecs = new Set();
        periods.filter(p => p.kind === 'day').forEach(p => {
            load(m.data);
            const withO = todayScreen(p.now, m.data.sessions.find(s => s.date === p.label));
            load(withoutOpenings);
            const noO = todayScreen(p.now, m.data.sessions.find(s => s.date === p.label));
            Object.keys(TODAY).filter(k => !['T13_dueReceived', 'T6_cashIn', 'T10_totalIn', 'T12_net'].includes(k)).forEach(k => {
                if (withO[k] !== noO[k]) { leaked++; leakedSpecs.add(`${k} on ${p.label} (₹${noO[k]} → ₹${withO[k]})`); }
            });
        });
        migrated.push(`${m.openingCount} opening records from the bundle, dated on ${openDays.size} different days (they keep the old bill's date); synthetic bills on ${isoDay(goLive)}${m.paidOpening ? ', including a ₹10 due payment on one opening record' : ''}.`);
        migrated.push(leaked
            ? `Opening records DO enter Today's period figures on this app code: ${[...leakedSpecs].join('; ')}.`
            : 'Opening records do not change any Today period figure on this app code (only dues and the due payment made on the go-live day).');
        migrated.push(`${found.length} oracle/app mismatches in the migrated state (details above).`);
        notes.push(`Migrated state audited from ${ENV.AUDIT_BUNDLE.replace(/^.*[\\/]/, '')}.`);
    }

    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const report = renderReport({
        title: 'Real-data number audit',
        appRef: ENV.AUDIT_APP_REF || 'working tree',
        compare: ENV.AUDIT_COMPARE && fs.existsSync(ENV.AUDIT_COMPARE) ? JSON.parse(fs.readFileSync(ENV.AUDIT_COMPARE, 'utf8')) : null,
        exportedAt, ms, periods: opts, collector: C, causes: (g) => causeFor(g, CAUSES), quality, numberChecks, migrated, notes
    });
    if (ENV.AUDIT_OUT) fs.writeFileSync(ENV.AUDIT_OUT, report);
    if (ENV.AUDIT_JSON) {
        fs.writeFileSync(ENV.AUDIT_JSON, JSON.stringify({
            exportedAt, ms, appRef: ENV.AUDIT_APP_REF || null, checked: C.checked,
            mismatches: C.mismatches, quality: quality.map(({ id, count, of }) => ({ id, count, of })),
            numberChecks: numberChecks.map(({ id, status, checked, problems }) => ({ id, status, checked, problems })), migrated
        }, null, 1));
    }
    expect(report).toBeTruthy();
});
