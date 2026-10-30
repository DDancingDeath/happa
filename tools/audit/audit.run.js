/**
 * @fileoverview Real-data number audit (#216), run by tools/audit/real-data-audit.js
 * through Jest (jsdom + Babel, the same environment as tests/oracle). Not part of
 * `npm test`: it needs a backup file (AUDIT_BACKUP) and never runs in CI.
 *
 * For every audited period each number is computed twice: by the independent
 * oracle (tests/oracle/oracle.js) and by the app's own code, the functions the
 * screens call (DayManager, MoneyManager and the calculation layer,
 * OutstandingManager, CashManagementManager, stock-replay, rate-trends,
 * number-checks). App modules come from `@app/` (AUDIT_APP_ROOT, default this
 * checkout), so the same audit can run against another branch's www/.
 */
import fs from 'fs';
import path from 'path';
import * as O from '../../tests/oracle/oracle.js';
import { loadBackup, auditPeriods, Collector, dataQuality, renderReport, isoDay, negativeDips, withoutItems } from './audit-lib.js';
import { CAUSES, causeFor } from './causes.js';
import { auditPhone, phoneDates, parsePhoneDates } from './phone.js';
import { DayManager } from '@app/modules/day.js';
import { AnomaliesManager } from '@app/modules/anomalies.js';
import { MoneyManager } from '@app/modules/money.js';
import { FirebaseService } from '@app/firebase/firestore-service.js';
import { setInsightsContext, resetInsightsContextForTests } from '@app/utils/insights-context.js';
import { OutstandingManager } from '@app/modules/outstanding.js';
import { CashManagementManager } from '@app/modules/cash-management.js';
import { AppState } from '@app/utils/state.js';
import { sessionTotals } from '@app/utils/cash-session.js';
import { computeStock } from '@app/utils/stock-replay.js';
import { computeFinanceSummary } from '@app/utils/finance-calc.js';
import { runNumberChecks } from '@app/utils/number-checks.js';
import { moneySummary, billCount, itemSummary, partySummary, purchaseItems, outstandingTotals, profitPerDay } from '@app/utils/business-metrics.js';
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

const MONEY_TEMPLATE = () => fs.readFileSync(path.join(ENV.AUDIT_APP_ROOT || process.cwd(), 'www', 'templates', 'money.html'), 'utf8');

/** The Money page drawn in jsdom for a period: every section's headline figures. */
function moneyScreen(p) {
    at(p.now);
    resetInsightsContextForTests();
    setInsightsContext({ preset: p.kind === 'all' ? 'all' : `month:${p.label}` });
    document.body.innerHTML = MONEY_TEMPLATE();
    document.getElementById('money').classList.add('active');
    Object.assign(MoneyManager, { snapshots: {}, snapshotsLoaded: true, sessionCache: new Map(), drawerCache: null });
    const out = {};
    MoneyManager.init('profit');
    Object.assign(out, { M1_sales: shown('moneySales'), M2_cogs: shown('moneyCogs'), M6_profit: shown('moneyProfitValue'),
        M16_purchases: shown('moneyPurchases') });
    MoneyManager.init('cash');
    out.M14_net = shown('moneyNetCash');
    MoneyManager.init('spending');
    Object.assign(out, { M4_businessExpenses: shown('moneyBusiness'), M8_personalExpenses: shown('moneyPersonal'), M9_withdrawals: shown('moneyWithdrawn'),
        M7_labour: shown('moneyLabour') });
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

/** Open dues of wholesale sales (Outstanding lists them on Wholesale, Money adds them to "To receive"). */
function wholesaleDue(data) {
    return outstandingTotals({ wholesaleSales: data.wholesaleSales }).receivable.total;
}

// ------------------------------------------------------------------ one data set

/**
 * Every comparison for one data set.
 * @param {Collector} C
 * @param {string} scope 'real' | 'migrated'
 * @param {Object} data loadBackup().data shape
 * @param {Array} periods auditPeriods()
 * @param {number} nowMs
 * @returns {{negativeStock: (row: Object) => boolean}} evidence for causeFor()
 */
function auditDataset(C, scope, data, periods, nowMs) {
    load(data);
    const cmp = (spec, page, period, oracle, app, unit = 'money') => C.compare({ spec, page, period, oracle, app, unit, scope });
    const chk = (spec, page, period, ok, expected = null, actual = null, unit = 'money') => C.check({ spec, page, period, ok, expected, actual, unit, scope });
    const sessionOn = (day) => (data.sessions || []).find(s => s.date === day) || null;
    const months = { M1: 0, M16: 0, M2: 0, M6: 0, M14: 0 };
    // Items whose stock went below zero (sold before bought): the app writes the refilled deficit off (#215),
    // the oracle carries it forward. Cost of goods sold on the other items must still agree exactly.
    const dips = negativeDips(data);
    const dipped = dips.items;
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

        // ---- Stock check line (M17) and cost of goods sold without the items that went below zero
        const wantF = O.finance(data, range);
        const c = wantF.F8_check;
        chk('AC1_check_line', 'Money (oracle)', label, Math.abs(c.opening + c.purchases - c.cogs + c.adjustments - c.closing) <= 1,
            c.closing, r2(c.opening + c.purchases - c.cogs + c.adjustments));
        if (clean) {
            const appClean = computeFinanceSummary({ sources: cleanSources, items: clean.items, base: { state: {}, from: -Infinity }, from: p.from, to: p.to });
            const wantClean = O.stockReplay(clean, range);
            cmp('M2_cogs_items_never_below_zero', 'Money (layer)', label, wantClean.cogs, appClean.cogs);
            chk('M17_gap_items_never_below_zero', 'Money (layer)', label, Math.abs(appClean.stock.gap) <= 1, 0, appClean.stock.gap);
        }

        // ---- Calculation layer (business-metrics.js): Money M*, bill count, items and parties add up
        const mm = moneySummary({ ...data, base: { state: {}, from: -Infinity } }, { from: p.from, to: p.to }, { detail: true });
        const wantM = O.metrics(data, range);
        [['M1_sales', mm.M1.total], ['M2_cogs', mm.M2], ['M3_gross', mm.M3.total], ['M4_businessExpenses', mm.M4.total],
            ['M5_badDebts', mm.M5], ['M6_profit', mm.M6.total], ['M7_labour', mm.M7], ['M8_personalExpenses', mm.M8.total],
            ['M9_withdrawals', mm.M9], ['M10_kept', mm.M10], ['M12_inCash', mm.M12.cash], ['M12_inOnline', mm.M12.online],
            ['M13_outCash', mm.M13.cash], ['M13_outOnline', mm.M13.online], ['M14_net', mm.M14], ['M16_purchases', mm.M16.total]]
            .forEach(([k, v]) => cmp(k, 'Money (layer)', label, wantM[k], v));
        cmp('M1_saleCount', 'Money (layer)', label, wantM.M1_saleCount, mm.M1.count, 'count');
        cmp('M16_purchaseCount', 'Money (layer)', label, wantM.M16_purchaseCount, mm.M16.count, 'count');
        if (mm.M17) chk('M17_gap', 'Money (layer)', label, Math.abs(mm.M17.gap) <= 1, 0, mm.M17.gap);
        const bc = billCount(data, p.from, p.to);
        chk('AC14_bill_count', 'Money vs oracle', label, bc.sales === wantM.M1_saleCount && bc.sales === mm.M1.count,
            wantM.M1_saleCount, bc.sales, 'count');
        const itemRows = itemSummary(mm);
        const sumOf = (list, f) => list.reduce((a, x) => a + f(x), 0);
        chk('AC10_items_eq_sales', 'Insights (layer)', label, Math.abs(sumOf(itemRows, x => x.sales) - mm.M1.total) <= 1, mm.M1.total, r2(sumOf(itemRows, x => x.sales)));
        if (mm.M2 !== null) chk('AC10_items_eq_cogs', 'Insights (layer)', label, Math.abs(sumOf(itemRows, x => x.cogs) - mm.M2) <= 1, mm.M2, r2(sumOf(itemRows, x => x.cogs)));
        const cust = partySummary(data, 'sales', { from: p.from, to: p.to });
        const sup = partySummary(data, 'purchases', { from: p.from, to: p.to });
        chk('AC11_parties_eq_sales', 'Insights (layer)', label, Math.abs(sumOf(cust, x => x.total) - mm.M1.total) <= 1, mm.M1.total, r2(sumOf(cust, x => x.total)));
        chk('AC11_parties_eq_purchases', 'Insights (layer)', label, Math.abs(sumOf(sup, x => x.total) - mm.M16.total) <= 1, mm.M16.total, r2(sumOf(sup, x => x.total)));
        const pItems = purchaseItems(data.purchases, data.items, { from: p.from, to: p.to });
        chk('I4_items_eq_purchases', 'Insights (layer)', label, Math.abs(sumOf(pItems, x => x.amount) - mm.M16.total) <= 1, mm.M16.total, r2(sumOf(pItems, x => x.amount)));

        // ---- Same period, same number (AC7)
        if (today) {
            chk('AC7_sales_today_money', 'Today vs Money', label, Math.abs(today.T2_sales - mm.M1.total) <= 1, today.T2_sales, r2(mm.M1.total));
            chk('AC7_purchases_today_money', 'Today vs Money', label, Math.abs(today.T1_purchases - mm.M16.total) <= 1, today.T1_purchases, r2(mm.M16.total));
        }

        if (p.kind === 'month' || p.kind === 'all') {
            // ---- Money page on screen (that month seen at its end, or all time)
            const scr = moneyScreen(p);
            Object.keys(scr).forEach(k => cmp(k, 'Money screen', label, rupee(wantM[k]), scr[k]));
            if (mm.M6.total !== null) chk('AC7_profit_screen_layer', 'Money screen vs layer', label, Math.abs(scr.M6_profit - mm.M6.total) <= 1, r2(mm.M6.total), scr.M6_profit);
        }
        if (p.kind === 'month') {
            months.M1 += mm.M1.total; months.M16 += mm.M16.total; months.M2 += mm.M2 || 0; months.M6 += mm.M6.total || 0; months.M14 += mm.M14;
        }

        if (p.kind === 'all') {
            // ---- AC4: months add up to all time (only when the audited months cover every bill)
            const covered = periods.filter(x => x.kind === 'month');
            const earliest = Math.min(...covered.map(x => x.from));
            const allDated = [...data.purchases, ...data.retailSales, ...data.wholesaleSales].every(b => O.timeOf(b.date) >= earliest && O.timeOf(b.date) < nowMs + 86400000);
            if (allDated && covered.length) {
                [['M1', mm.M1.total], ['M16', mm.M16.total], ['M2', mm.M2 || 0], ['M6', mm.M6.total || 0], ['M14', mm.M14]].forEach(([k, all]) =>
                    chk('AC4_months_eq_all', `Money (${k})`, 'months vs all time', Math.abs(months[k] - all) <= 1, r2(all), r2(months[k])));
            }

            // ---- Stock
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

            // ---- Cross-page dues (AC5): Outstanding == Money › Worth terms
            const dues = outstandingTotals(data);
            chk('AC5_due_to_pay', 'Outstanding vs Money', label, Math.abs(pay.total - dues.payable.total) <= 1, r2(dues.payable.total), pay.total);
            chk('AC5_due_to_receive', 'Outstanding vs Money', label, Math.abs(sale.total + wholesaleDue(data) - dues.receivable.total) <= 1, r2(dues.receivable.total), r2(sale.total + wholesaleDue(data)));
        }
    }

    // ---- M11 profit by day: per-day profit == that day's profit (last audited days)
    const days = periods.filter(p => p.kind === 'day');
    if (days.length) {
        const first = Math.min(...days.map(d => d.from));
        const summary = moneySummary({ ...data, base: { state: {}, from: -Infinity } }, { from: first, to: Infinity }, { detail: true });
        if (summary.M6.total !== null) {
            const byDay = profitPerDay(summary);
            days.forEach(d => {
                cmp('M11_profitByDay', 'Money (layer)', d.label, O.metrics(data, [d.from, d.to]).M6_profit, byDay[d.label] || 0);
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

    // Evidence for tools/audit/causes.js: 'negative stock' only where it really applies.
    const firstDip = Math.min(Infinity, ...Object.values(dips.firstDip));
    const periodEnd = new Map(periods.map(p => [p.kind === 'all' ? 'all time' : p.label, p.to]));
    const dippedNames = new Set(dipped.map(itemName));
    return {
        // An item went below zero before the period ended, and the same figure without those items agrees.
        negativeStock: (row) => {
            if (!clean) return false;
            if (row.spec === 'S3_value') return dippedNames.has(row.period);
            const end = periodEnd.get(row.period);
            if (end === undefined || !(firstDip < end)) return false;
            return !C.mismatches.some(m => m.scope === scope && m.period === row.period && /_items_never_below_zero$/.test(m.spec));
        }
    };
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
    jest.spyOn(FirebaseService, 'loadCashSessionsBetween').mockResolvedValue([]);
});

const run = ENV.AUDIT_BACKUP ? test : test.skip;

run('real-data number audit', async () => {
    const started = process.hrtime.bigint();
    const { exportedAt, data } = loadBackup(JSON.parse(fs.readFileSync(ENV.AUDIT_BACKUP, 'utf8')));
    const nowMs = ENV.AUDIT_NOW ? Date.parse(ENV.AUDIT_NOW) : exportedAt;
    const opts = { days: Number(ENV.AUDIT_DAYS) || 60, months: Number(ENV.AUDIT_MONTHS) || 24 };
    const C = new Collector();
    const notes = [];

    const evidence = { real: auditDataset(C, 'real', data, auditPeriods(nowMs, opts), nowMs) };
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
        evidence.migrated = auditDataset(C, 'migrated', m.data, periods, goLive);
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

    // ---- The phone path: windowed history, month snapshots, stock checkpoint, rate history, cash sessions
    let phone = null;
    if (ENV.AUDIT_PHONE !== '0') {
        const dips = negativeDips(data);
        const stockEvidence = {
            firstDip: Math.min(Infinity, ...Object.values(dips.firstDip)),
            cleanAgrees: !C.mismatches.some(m => m.scope === 'real' && /_items_never_below_zero$/.test(m.spec))
        };
        const dates = ENV.AUDIT_PHONE_DATES ? parsePhoneDates(ENV.AUDIT_PHONE_DATES) : phoneDates(nowMs);
        phone = await auditPhone({ C, data, dates, appRoot: ENV.AUDIT_APP_ROOT || process.cwd(), stockEvidence });
        evidence.phone = phone.evidence;
    }

    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const report = renderReport({
        title: 'Real-data number audit',
        appRef: ENV.AUDIT_APP_REF || 'working tree',
        compare: ENV.AUDIT_COMPARE && fs.existsSync(ENV.AUDIT_COMPARE) ? JSON.parse(fs.readFileSync(ENV.AUDIT_COMPARE, 'utf8')) : null,
        exportedAt, ms, periods: opts, collector: C, causes: (g) => causeFor(g, CAUSES, evidence[g.scope]), quality, numberChecks, migrated, notes, phone
    });
    if (ENV.AUDIT_OUT) fs.writeFileSync(ENV.AUDIT_OUT, report);
    if (ENV.AUDIT_JSON) {
        fs.writeFileSync(ENV.AUDIT_JSON, JSON.stringify({
            exportedAt, ms, appRef: ENV.AUDIT_APP_REF || null, checked: C.checked,
            mismatches: C.mismatches.map(m => ({ ...m, cause: causeFor({ ...m, rows: [m] }, CAUSES, evidence[m.scope])?.known || 'new' })),
            unknowns: C.unknowns,
            phone: phone ? phone.dates : null,
            quality: quality.map(({ id, count, of }) => ({ id, count, of })),
            numberChecks: numberChecks.map(({ id, status, checked, problems }) => ({ id, status, checked, problems })), migrated
        }, null, 1));
    }
    expect(report).toBeTruthy();
});
