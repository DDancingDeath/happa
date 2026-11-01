/**
 * @fileoverview One calculation layer for every money and insight figure
 * (docs/insights-redesign.md §7, spec IDs M*, I* and the building blocks
 * BILL-TIME, BILL-COUNT, OPENING, CMP in docs/calculations.md).
 *
 * Pure: no DOM, no Firestore, no AppState. Pages pass plain arrays in and only
 * render what comes back. Dates are read only through utils/dates.js (via the
 * stock replay's eventTime for bills), dues only through outstandingDue(),
 * opening records are left out of period figures with activityBills().
 * @module utils/business-metrics
 */

import { computeFinanceSummary, billsInRange, profitByDay } from './finance-calc.js';
import { activityBills, billLabour, billTotal, isPersonalExpense, outstandingDue, readLineItem, round2 } from './money.js';
import { eventTime, createItemKeyResolver } from './stock-replay.js';
import { parseAnyBillDate, toLocalISODate } from './dates.js';
import { saleTimePayment, dueEvents, sumDueEvents } from './due-payments.js';
import { normalizePartyName, pickPartyName } from './aging.js';
import { INSIGHTS_DEFAULTS } from './insights-config.js';

const DAY_MS = 86400000;
const num = (v) => {
    const x = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(x) ? x : 0;
};
const inRange = (t, from, to) => Number.isFinite(t) && t >= from && t < to;

// ------------------------------------------------------------------ BILL-TIME, PERIOD, CMP

/**
 * BILL-TIME: when a bill counts (numeric `timestamp`, else its date via dates.js).
 * @param {Object} bill
 * @returns {?number} ms, null when undated
 */
export function billTime(bill) {
    const t = eventTime(bill);
    return Number.isFinite(t) && t !== Number.MAX_SAFE_INTEGER ? t : null;
}

/**
 * Time of an expense / withdrawal / payment `date` (dates.js only; fixes #49).
 * @param {*} value
 * @returns {?number}
 */
export function recordTime(value) {
    const d = parseAnyBillDate(value);
    return d ? d.getTime() : null;
}

const localMidnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * PERIOD: [from, to) for a preset. Calendar periods run up to the end of today.
 * @param {string} preset 'this-month' | 'last-month' | 'this-year' | 'last-year' | 'last-30' | 'all' | 'month:YYYY-MM'
 * @param {Date} [now]
 * @param {{monthMode?: string, yearStartMonth?: number}} [cfg]
 * @returns {{preset: string, from: number, to: number, month?: string}}
 */
export function periodRange(preset, now = new Date(), cfg = INSIGHTS_DEFAULTS) {
    const today = localMidnight(now);
    const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime();
    const y = now.getFullYear();
    const m = now.getMonth();
    const ys = cfg.yearStartMonth || 0;
    const yearStart = (offset) => {
        const startYear = m >= ys ? y : y - 1;
        return new Date(startYear + offset, ys, 1);
    };
    const mk = (from, to, extra = {}) => ({ preset, from: from instanceof Date ? from.getTime() : from, to: to instanceof Date ? to.getTime() : to, ...extra });
    const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (preset === 'this-month' && cfg.monthMode === 'last30') return mk(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29), endOfToday);
    switch (preset) {
        case 'this-month': return mk(new Date(y, m, 1), endOfToday, { month: monthKey(now) });
        case 'last-month': return mk(new Date(y, m - 1, 1), new Date(y, m, 1), { month: monthKey(new Date(y, m - 1, 1)) });
        case 'this-year': return mk(yearStart(0), endOfToday);
        case 'last-year': return mk(yearStart(-1), yearStart(0));
        case 'this-fy': return mk(fyStart(now, 0), endOfToday, { fy: fyStart(now, 0).getFullYear() });
        case 'last-fy': return mk(fyStart(now, -1), fyStart(now, 0), { fy: fyStart(now, -1).getFullYear() });
        case 'last-30': return mk(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29), endOfToday);
        case 'all': return mk(-Infinity, Infinity);
        default: {
            const hit = /^month:(\d{4})-(\d{2})$/.exec(String(preset));
            if (hit) {
                const from = new Date(+hit[1], +hit[2] - 1, 1);
                const end = new Date(+hit[1], +hit[2], 1);
                return mk(from, Math.min(end.getTime(), Math.max(from.getTime(), endOfToday)), { month: `${hit[1]}-${hit[2]}` });
            }
            return mk(new Date(y, m, 1), endOfToday, { month: monthKey(now) });
        }
    }
}

/** PERIOD-FY: 1 April of the Indian financial year containing `now`, `offset` years away. */
function fyStart(now, offset = 0) {
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return new Date(y + offset, 3, 1);
}

/**
 * PERIOD-FY: the label of the financial year starting in April of `startYear`: "2026-27".
 * @param {number} startYear
 * @returns {string}
 */
export function fiscalYearLabel(startYear) {
    return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** The same local date `years` / `months` away, clipped to the month's last day. */
function shiftDate(ms, { years = 0, months = 0 }) {
    const d = new Date(ms);
    const target = new Date(d.getFullYear() + years, d.getMonth() + months, 1);
    const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), last), d.getHours(), d.getMinutes()).getTime();
}

/**
 * CMP: the two comparison ranges for a period. A (partial) calendar month is
 * compared with the same days of the previous month; other periods with the
 * same length just before. "Last year" = the same dates one year earlier.
 * @param {{from: number, to: number, month?: string}} range
 * @returns {{previous: ?{from: number, to: number}, lastYear: ?{from: number, to: number}}}
 */
export function comparisonRanges(range) {
    if (!Number.isFinite(range.from) || !Number.isFinite(range.to)) return { previous: null, lastYear: null };
    let previous;
    const f = new Date(range.from);
    const rolling = range.preset === 'last-30' || (range.preset === 'this-month' && !range.month);
    if (!rolling && f.getDate() === 1 && f.getHours() === 0 && range.to - range.from <= 31 * DAY_MS) {
        previous = { from: shiftDate(range.from, { months: -1 }), to: Math.min(shiftEnd(range.to, { months: -1 }), range.from) };
    } else {
        previous = { from: range.from - (range.to - range.from), to: range.from };
    }
    const lastYear = { from: shiftDate(range.from, { years: -1 }), to: shiftEnd(range.to, { years: -1 }) };
    return { previous, lastYear };
}

/** Exclusive end shifted by its inclusive last day (to − 1 ms), clipped to the month's end (a month's last day stays the last day), plus a day. */
function shiftEnd(to, by) {
    const last = new Date(to - 1);
    const dayStart = new Date(last.getFullYear(), last.getMonth(), last.getDate()).getTime();
    const monthEnd = new Date(last.getFullYear(), last.getMonth() + 1, 0).getDate() === last.getDate();
    const shifted = new Date(shiftDate(dayStart, by));
    const end = monthEnd
        ? new Date(shifted.getFullYear(), shifted.getMonth() + 1, 1)
        : new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate() + 1);
    return end.getTime() - (dayStart + DAY_MS - to);
}

/**
 * CMP: % change now vs then. null when `then` is 0/unknown or `now` unknown.
 * @param {?number} now
 * @param {?number} then
 * @param {number} [sameWithin=2]
 * @returns {?{pct: number, diff: number, dir: 'up'|'down'|'same'}}
 */
export function change(now, then, sameWithin = INSIGHTS_DEFAULTS.sameWithinPct) {
    if (now === null || now === undefined || then === null || then === undefined) return null;
    if (!Number.isFinite(now) || !Number.isFinite(then) || then === 0) return null;
    const pct = Math.round(((now - then) / Math.abs(then)) * 100);
    const dir = Math.abs(pct) < sameWithin ? 'same' : pct > 0 ? 'up' : 'down';
    return { pct, diff: round2(now - then), dir };
}

// ------------------------------------------------------------------ BILL-COUNT

/**
 * BILL-COUNT: activity bills (no opening records) whose BILL-TIME is in [from, to).
 * @param {Object} src {purchases, wholesaleSales, retailSales}
 * @param {number} from
 * @param {number} to
 * @returns {{purchases: number, retail: number, wholesale: number, sales: number}}
 */
export function billCount(src, from, to) {
    const c = (list) => billsInRange(list || [], from, to).length;
    const retail = c(src.retailSales);
    const wholesale = c(src.wholesaleSales);
    return { purchases: c(src.purchases), retail, wholesale, sales: retail + wholesale };
}

// ------------------------------------------------------------------ Money (M*)

const sumBills = (bills) => round2(bills.reduce((a, b) => a + billTotal(b), 0));

/**
 * Every Money figure (M1–M17) for [from, to).
 * @param {Object} input {purchases, wholesaleSales, retailSales, stockAdjustments, expenses,
 *   withdrawals, sessions, items, base, duesComplete}
 * @param {{from: number, to: number}} range
 * @param {{detail?: boolean}} [opts]
 * @returns {Object} M1…M17 plus `caveats` and (with detail) `detail`
 */
export function moneySummary(input, { from, to }, { detail = false } = {}) {
    const sources = {
        purchases: input.purchases || [],
        wholesaleSales: input.wholesaleSales || [],
        retailSales: input.retailSales || [],
        stockAdjustments: input.stockAdjustments || []
    };
    const s = computeFinanceSummary({
        sources, items: input.items || [], base: input.base ?? null,
        expenses: input.expenses || [], withdrawals: input.withdrawals || [],
        sessions: input.sessions || [], duesComplete: input.duesComplete !== false,
        from, to, detail
    });
    const retail = billsInRange(sources.retailSales, from, to);
    const wholesale = billsInRange(sources.wholesaleSales, from, to);
    const purchases = billsInRange(sources.purchases, from, to);
    const lineValue = round2(purchases.reduce((a, b) => a + (Array.isArray(b.items) ? b.items : []).reduce((x, l) => x + readLineItem(l).total, 0), 0));

    // Money in / out split by cash and online (M12–M14).
    const at = (bills) => bills.reduce((a, b) => {
        const p = saleTimePayment(b);
        a.cash += p.cash;
        a.online += p.online;
        return a;
    }, { cash: 0, online: 0 });
    const events = dueEvents({
        bills: { retail: sources.retailSales, wholesale: sources.wholesaleSales, purchase: sources.purchases },
        sessions: input.sessions || [], from, to
    });
    const dues = sumDueEvents(events);
    const sold = at([...wholesale, ...retail]);
    const bought = at(purchases);
    const expensesAll = round2(s.expenses.business + s.expenses.personal);
    // EXP-MODE (#118): online expenses are online money out; the rest (and every expense without a mode) cash
    const expensesOnline = s.expenses.online || 0;
    const moneyIn = {
        cash: round2(sold.cash + dues.receivedCash), online: round2(sold.online + dues.receivedOnline),
        atSale: round2(sold.cash + sold.online), dueReceived: round2(dues.receivedCash + dues.receivedOnline)
    };
    moneyIn.total = round2(moneyIn.cash + moneyIn.online);
    const moneyOut = {
        cash: round2(bought.cash + dues.paidCash + expensesAll - expensesOnline), online: round2(bought.online + dues.paidOnline + expensesOnline),
        atPurchase: round2(bought.cash + bought.online), duePaid: round2(dues.paidCash + dues.paidOnline), expenses: expensesAll,
        expensesCash: round2(expensesAll - expensesOnline), expensesOnline
    };
    moneyOut.total = round2(moneyOut.cash + moneyOut.online);

    const caveats = [];
    if (s.stock === null) caveats.push({ key: 'history', ids: ['M2', 'M3', 'M6', 'M10', 'M17'] });
    if (s.uncostedWarning) caveats.push({ key: 'uncosted', ids: ['M2', 'M3', 'M6'], qty: s.stock.uncosted.qty, estimate: s.stock.uncosted.estimate });
    if (s.expenses.uncategorised > 0) caveats.push({ key: 'untagged', ids: ['M4'], amount: s.expenses.uncategorised });
    if (s.duesApproximate) caveats.push({ key: 'dues', ids: ['M5', 'M12', 'M13', 'M14'] });
    if (s.stockMismatch) caveats.push({ key: 'gap', ids: ['M17'], gap: s.stock.gap });

    const salesTotal = s.sales.total;
    const per100 = (v) => (v === null || !salesTotal ? null : round2((v / salesTotal) * 100));
    return {
        range: { from, to },
        M1: {
            total: salesTotal, count: s.sales.count, due: s.sales.due,
            retail: { total: sumBills(retail), count: retail.length },
            wholesale: { total: sumBills(wholesale), count: wholesale.length }
        },
        M2: s.cogs,
        M3: { total: s.grossProfit, per100: per100(s.grossProfit) },
        M4: { total: s.expenses.business, count: s.expenses.businessCount, uncategorised: s.expenses.uncategorised, byCategory: expenseCategories(input.expenses, from, to) },
        M5: s.badDebts,
        M6: { total: s.profit, per100: per100(s.profit) },
        M7: s.purchases.labour,
        M8: { total: s.expenses.personal, count: s.expenses.personalCount },
        M9: s.withdrawn,
        M10: s.afterWithdrawals,
        M12: moneyIn,
        M13: moneyOut,
        M14: round2(moneyIn.total - moneyOut.total),
        M16: { total: s.purchases.total, count: s.purchases.count, lineValue, labour: s.purchases.labour },
        M17: s.stock ? {
            opening: s.stock.opening, purchases: s.stock.purchases, cogs: s.stock.cogs, adjustments: s.stock.adjustments,
            closing: s.stock.closing, now: s.stock.now, gap: s.stock.gap
        } : null,
        stockNow: s.stock ? s.stock.now : null,
        caveats,
        finance: s,
        detail: s.detail
    };
}

/**
 * Business expenses per category (M4 breakdown). The category is the expense's
 * `type` (rent, transport…); untagged business expenses are their own row.
 */
export function expenseCategories(expenses, from, to) {
    const out = new Map();
    (expenses || []).forEach(e => {
        if (isPersonalExpense(e)) return;
        const t = recordTime(e?.date);
        const ok = t !== null ? inRange(t, from, to) : from === -Infinity && to === Infinity;
        if (!ok) return;
        const key = String(e.type || '').trim() || (e.category === 'business' ? 'other' : 'untagged');
        const row = out.get(key) || { category: key, total: 0, count: 0 };
        row.total = round2(row.total + num(e.amount));
        row.count++;
        out.set(key, row);
    });
    return [...out.values()].sort((a, b) => b.total - a.total);
}

/**
 * M6 per day of a detailed summary (sums to M6). Keys are local YYYY-MM-DD.
 * @param {Object} summary moneySummary(..., {detail: true})
 * @returns {Object<string, number>}
 */
export function profitPerDay(summary) {
    const pad = (x) => String(x).padStart(2, '0');
    return profitByDay(summary.detail, (ms) => {
        const d = new Date(ms);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    });
}

// ------------------------------------------------------------------ Outstanding totals (O3/O4)

/**
 * O3 / O4 totals and bill counts (BILL-DUE: cleared bills and opening records'
 * settled dues handled by outstandingDue). Receivables include wholesale.
 * @param {Object} src {purchases, wholesaleSales, retailSales}
 * @returns {{payable: {total: number, count: number}, receivable: {total: number, count: number}}}
 */
export function outstandingTotals(src) {
    const tally = (bills) => (bills || []).reduce((a, b) => {
        const d = outstandingDue(b);
        if (d > 0.005) { a.total += d; a.count++; }
        return a;
    }, { total: 0, count: 0 });
    const p = tally(src.purchases);
    const r = tally([...(src.retailSales || []), ...(src.wholesaleSales || [])]);
    return { payable: { total: round2(p.total), count: p.count }, receivable: { total: round2(r.total), count: r.count } };
}

// ------------------------------------------------------------------ Items (I1, I2, I8)

/**
 * I1/I2: sales, cost of goods sold and profit per item for the period, from a
 * detailed moneySummary. Rows add up to M1 (a bill whose total differs from its
 * lines adds a "bill adjustments" row, itemKey '') and to M2.
 * @param {Object} summary moneySummary(..., {detail: true})
 * @param {{type?: 'retail'|'wholesale'|'both'}} [opts]
 * @returns {Array<{itemKey, item, itemHi, sales, qty, cogs, profit, per100, retail, wholesale}>}
 */
export function itemSummary(summary, { type = 'both' } = {}) {
    const d = summary.detail;
    if (!d) return [];
    const rows = new Map();
    const row = (r) => {
        const k = r.itemKey || '';
        if (!rows.has(k)) rows.set(k, { itemKey: k, item: r.item || '', itemHi: r.itemHi || '', sales: 0, qty: 0, cogs: 0, retail: 0, wholesale: 0, adjustment: !k });
        return rows.get(k);
    };
    const want = (bt) => type === 'both' || bt === type;
    (d.sales || []).forEach(r => {
        if (!want(r.billType)) return;
        const x = row(r);
        x.sales += num(r.amount);
        x.qty += num(r.qty);
        if (r.billType === 'retail') x.retail += num(r.amount); else x.wholesale += num(r.amount);
    });
    (d.stock?.cogs || []).forEach(r => {
        if (!want(r.billType)) return;
        row(r).cogs += num(r.amount);
    });
    const known = !!d.stock;
    return [...rows.values()].map(x => {
        const sales = round2(x.sales);
        const cogs = known ? round2(x.cogs) : null;
        const profit = cogs === null ? null : round2(sales - cogs);
        return {
            ...x, sales, qty: round2(x.qty), cogs, profit,
            retail: round2(x.retail), wholesale: round2(x.wholesale),
            per100: profit === null || !sales ? null : round2((profit / sales) * 100)
        };
    }).sort((a, b) => (b.profit ?? b.sales) - (a.profit ?? a.sales));
}

/**
 * I8: sale lines sold below their cost (sale value < cost of goods sold of the
 * same bill and item), per item.
 * @param {Object} summary moneySummary(..., {detail: true})
 * @returns {Array<{itemKey, item, itemHi, times, qty, lost}>}
 */
export function belowCostSales(summary) {
    const d = summary.detail;
    if (!d || !d.stock) return [];
    const byLine = new Map();
    const key = (r) => `${r.billType}|${r.billId}|${r.itemKey}`;
    (d.sales || []).forEach(r => {
        if (!r.itemKey) return;
        const x = byLine.get(key(r)) || { itemKey: r.itemKey, item: r.item, itemHi: r.itemHi, sales: 0, cogs: 0, qty: 0 };
        x.sales += num(r.amount);
        x.qty += num(r.qty);
        byLine.set(key(r), x);
    });
    (d.stock.cogs || []).forEach(r => {
        const x = byLine.get(key(r));
        if (x) x.cogs += num(r.amount);
    });
    const out = new Map();
    byLine.forEach(x => {
        if (!(x.cogs - x.sales > 0.5)) return;
        const o = out.get(x.itemKey) || { itemKey: x.itemKey, item: x.item, itemHi: x.itemHi, times: 0, qty: 0, lost: 0 };
        o.times++;
        o.qty = round2(o.qty + x.qty);
        o.lost = round2(o.lost + x.cogs - x.sales);
        out.set(x.itemKey, o);
    });
    return [...out.values()].sort((a, b) => b.lost - a.lost);
}

/**
 * I7: items with enough sales and too little profit per ₹100 (or a loss).
 * @param {Array} items itemSummary rows
 * @param {typeof INSIGHTS_DEFAULTS} [cfg]
 */
export function lowProfitItems(items, cfg = INSIGHTS_DEFAULTS) {
    return (items || []).filter(r => r.itemKey && r.per100 !== null && r.sales >= cfg.lowMarginMinSales && r.per100 < cfg.lowMarginPer100)
        .sort((a, b) => a.per100 - b.per100);
}

/**
 * Purchases per item with labour shared out by line value (#47), so the rows
 * add up to M16 (bill totals after labour). A bill whose lines don't match its
 * total adds a "bill adjustments" row (itemKey '').
 * @param {Array} purchases bills
 * @param {Array} items catalogue
 * @param {{from: number, to: number}} range
 */
export function purchaseItems(purchases, items, { from, to }) {
    const getKey = createItemKeyResolver(items || []);
    const byId = new Map((items || []).map(i => [i.id, i]));
    const rows = new Map();
    const row = (k, raw) => {
        if (!rows.has(k)) {
            const it = byId.get(k);
            rows.set(k, { itemKey: k, item: it?.name || raw || '', itemHi: it?.hindiName || it?.name || raw || '', lineValue: 0, labour: 0, amount: 0, qty: 0 });
        }
        return rows.get(k);
    };
    billsInRange(purchases || [], from, to).forEach(b => {
        const lines = (Array.isArray(b.items) ? b.items : []).map(l => ({ l, v: readLineItem(l) }));
        const value = lines.reduce((a, x) => a + x.v.total, 0);
        const labour = billLabour(b);
        let used = 0;
        lines.forEach(({ l, v }) => {
            const share = value > 0 ? labour * (v.total / value) : 0;
            const r = row(getKey(l), l.name);
            r.lineValue += v.total;
            r.labour += share;
            r.amount += v.total - share;
            r.qty += v.qty;
            used += v.total - share;
        });
        const rest = billTotal(b) - used;
        if (Math.abs(rest) >= 0.005) row('', '').amount += rest;
    });
    return [...rows.values()].map(r => ({
        ...r, lineValue: round2(r.lineValue), labour: round2(r.labour), amount: round2(r.amount), qty: round2(r.qty)
    })).sort((a, b) => b.amount - a.amount);
}

// ------------------------------------------------------------------ Parties (I3, I4)

/**
 * I3 (kind 'sales': retail + wholesale) or I4 (kind 'purchases'): totals per
 * party key (name trimmed, case-folded, single spaces). Unnamed bills form one
 * '' row. Rows add up to M1 / M16.
 * @param {Object} src {purchases, wholesaleSales, retailSales}
 * @param {'sales'|'purchases'} kind
 * @param {{from: number, to: number}} range
 */
export function partySummary(src, kind, { from, to }) {
    const bills = kind === 'purchases'
        ? billsInRange(src.purchases || [], from, to)
        : [...billsInRange(src.retailSales || [], from, to), ...billsInRange(src.wholesaleSales || [], from, to)];
    const rows = new Map();
    bills.forEach(b => {
        const raw = String(b.customerName ?? b.supplierName ?? '').trim().replace(/\s+/g, ' ');
        const key = normalizePartyName(raw);
        const t = billTime(b) ?? 0;
        const r = rows.get(key) || { key, spellings: new Map(), total: 0, count: 0, labour: 0, qty: 0, last: 0 };
        const sp = r.spellings.get(raw) || { count: 0, last: 0 };
        sp.count++;
        sp.last = Math.max(sp.last, t);
        r.spellings.set(raw, sp);
        r.total += billTotal(b);
        r.count++;
        r.labour += billLabour(b);
        r.qty += (Array.isArray(b.items) ? b.items : []).reduce((a, l) => a + readLineItem(l).qty, 0);
        r.last = Math.max(r.last, t);
        rows.set(key, r);
    });
    return [...rows.values()].map(r => ({
        key: r.key, name: pickPartyName(r.spellings), total: round2(r.total), count: r.count,
        labour: round2(r.labour), qty: round2(r.qty), last: r.last || null
    })).sort((a, b) => b.total - a.total);
}

/**
 * Regular buyers who stopped coming: bought in at least 3 of the 3 calendar
 * months around this month last year and have no bill in the last
 * `stoppedComingDays` days.
 * @param {Object} src {wholesaleSales, retailSales}
 * @param {Date} now
 * @param {typeof INSIGHTS_DEFAULTS} [cfg]
 * @returns {Array<{key, name, last}>}
 */
export function stoppedComing(src, now = new Date(), cfg = INSIGHTS_DEFAULTS) {
    return stoppedComingCheck(src, now, cfg).list;
}

/**
 * I4 with honesty about missing data. Last year's three months come from the
 * loaded bills when they are loaded, else from that month's snapshot
 * customer list (its top customers); a month with neither makes the answer
 * unknown (`known: false`), so the page never claims "every regular came".
 * @param {Object} src {wholesaleSales, retailSales}
 * @param {Date} now
 * @param {typeof INSIGHTS_DEFAULTS} [cfg]
 * @param {{loadedFrom?: number, snapshotCustomers?: Object<string, ?Array<{key: string, name: string}>>}} [ctx]
 *   loadedFrom: start of the loaded bills (0 = all); snapshotCustomers: 'YYYY-MM' → customers
 * @returns {{list: Array<{key, name, last: ?number}>, known: boolean}}
 */
export function stoppedComingCheck(src, now = new Date(), cfg = INSIGHTS_DEFAULTS, { loadedFrom = 0, snapshotCustomers = {} } = {}) {
    const y = now.getFullYear() - 1;
    const m = now.getMonth();
    const lyMonths = [-1, 0, 1].map(k => new Date(y, m + k, 1));
    const months = lyMonths.map(d => `${d.getFullYear()}-${d.getMonth()}`);
    const cutoff = now.getTime() - cfg.stoppedComingDays * DAY_MS;
    if (loadedFrom > cutoff) return { list: [], known: false };
    const seen = new Map();
    const rowOf = (key) => seen.get(key) || { key, spellings: new Map(), months: new Set(), last: 0 };
    activityBills([...(src.retailSales || []), ...(src.wholesaleSales || [])]).forEach(b => {
        const raw = String(b.customerName ?? '').trim().replace(/\s+/g, ' ');
        const key = normalizePartyName(raw);
        if (!key) return;
        const t = billTime(b);
        if (t === null) return;
        const r = rowOf(key);
        const d = new Date(t);
        r.months.add(`${d.getFullYear()}-${d.getMonth()}`);
        r.last = Math.max(r.last, t);
        const sp = r.spellings.get(raw) || { count: 0, last: 0 };
        sp.count++;
        sp.last = Math.max(sp.last, t);
        r.spellings.set(raw, sp);
        seen.set(key, r);
    });
    for (let i = 0; i < lyMonths.length; i++) {
        if (lyMonths[i].getTime() >= loadedFrom) continue;
        const pad = String(lyMonths[i].getMonth() + 1).padStart(2, '0');
        const list = snapshotCustomers[`${lyMonths[i].getFullYear()}-${pad}`];
        if (!Array.isArray(list)) return { list: [], known: false };
        list.forEach(p => {
            const key = normalizePartyName(p.key || p.name || '');
            if (!key) return;
            const r = rowOf(key);
            r.months.add(months[i]);
            if (!r.spellings.size && p.name) r.spellings.set(p.name, { count: 1, last: 0 });
            seen.set(key, r);
        });
    }
    const list = [...seen.values()]
        .filter(r => months.every(k => r.months.has(k)) && r.last < cutoff)
        .map(r => ({ key: r.key, name: pickPartyName(r.spellings), last: r.last || null }))
        .sort((a, b) => (b.last || 0) - (a.last || 0));
    return { list, known: true };
}

/**
 * Parties with dues older than `overdueDays` (from Outstanding's rule: BILL-DUE).
 * @param {Array} bills purchases or sales
 * @param {Date} now
 * @param {typeof INSIGHTS_DEFAULTS} [cfg]
 * @returns {{parties: number, total: number, oldestDays: number}}
 */
export function overdueParties(bills, now = new Date(), cfg = INSIGHTS_DEFAULTS) {
    const today = localMidnight(now).getTime();
    const parties = new Map();
    let total = 0;
    let oldest = 0;
    (bills || []).forEach(b => {
        const due = outstandingDue(b);
        if (!(due > 0.005)) return;
        const t = billTime(b);
        if (t === null) return;
        const days = Math.floor((today - localMidnight(new Date(t)).getTime()) / DAY_MS);
        if (days <= cfg.overdueDays) return;
        const key = normalizePartyName(b.customerName);
        parties.set(key, (parties.get(key) || 0) + due);
        total += due;
        oldest = Math.max(oldest, days);
    });
    return { parties: parties.size, total: round2(total), oldestDays: oldest };
}

// ------------------------------------------------------------------ Seasons (I5, I9)

/**
 * I5 input: kg sold (retail + wholesale) per item and 'YYYY-MM' from rateStats
 * year docs (RT4 months).
 * @param {Array<{itemId: string, months: Object}>} docs
 * @returns {Map<string, Object<string, number>>}
 */
export function soldKgByMonth(docs) {
    const out = new Map();
    (docs || []).forEach(d => {
        if (!d || !d.itemId) return;
        const m = out.get(d.itemId) || {};
        Object.entries(d.months || {}).forEach(([k, b]) => {
            const key = String(k).replace(/^m/, '');
            if (!/^\d{4}-\d{2}$/.test(key)) return;
            m[key] = (m[key] || 0) + (Number(b?.retail?.kg) || 0) + (Number(b?.wholesale?.kg) || 0);
        });
        out.set(d.itemId, m);
    });
    return out;
}

/**
 * I5: an item's kg sold over all the months given (orders the season calendar).
 * @param {Object<string, number>} kgByMonth 'YYYY-MM' → kg
 * @returns {number}
 */
export function seasonKgTotal(kgByMonth) {
    return Object.values(kgByMonth || {}).reduce((a, b) => a + b, 0);
}

/**
 * I5: season index per item and calendar month (0–11): kg sold in that month
 * ÷ the item's average monthly kg, over the months given. Needs ≥ 12 months.
 * @param {Object<string, number>} kgByMonth 'YYYY-MM' → kg sold (one item)
 * @returns {?Array<?number>} 12 values (null where no data), null when < 12 months
 */
export function seasonIndex(kgByMonth) {
    const entries = Object.entries(kgByMonth || {}).filter(([k, v]) => /^\d{4}-\d{2}$/.test(k) && Number.isFinite(v));
    if (entries.length < 12) return null;
    const avg = entries.reduce((a, [, v]) => a + v, 0) / entries.length;
    if (!(avg > 0)) return null;
    const by = Array.from({ length: 12 }, () => []);
    entries.forEach(([k, v]) => by[Number(k.slice(5, 7)) - 1].push(v));
    return by.map(list => (list.length ? round2(list.reduce((a, b) => a + b, 0) / list.length / avg) : null));
}

/**
 * I9: items to stock up: a busy month (season index ≥ busy) within the next
 * `weeksAhead` weeks while the stock covers fewer weeks than that.
 * @param {Array<{itemKey, item, itemHi, index: ?Array<?number>, qty: number, weeklyKg: number}>} rows
 * @param {Date} now
 * @param {{weeksAhead?: number}} [opts]
 * @param {typeof INSIGHTS_DEFAULTS} [cfg]
 */
export function stockUpItems(rows, now = new Date(), { weeksAhead = 8 } = {}, cfg = INSIGHTS_DEFAULTS) {
    const out = [];
    (rows || []).forEach(r => {
        if (!r.index) return;
        for (let k = 1; k <= Math.ceil(weeksAhead / 4.345); k++) {
            const mDate = new Date(now.getFullYear(), now.getMonth() + k, 1);
            const idx = r.index[mDate.getMonth()];
            if (idx !== null && idx >= cfg.seasonBusy) {
                const weeksToBusy = Math.max(0, Math.round((mDate.getTime() - now.getTime()) / (7 * DAY_MS)));
                const cover = r.weeklyKg > 0 ? round2(Math.max(0, r.qty) / r.weeklyKg) : null;
                if (cover !== null && cover < weeksToBusy + 4) {
                    out.push({ ...r, busyMonth: mDate.getMonth(), weeksToBusy, coverWeeks: cover });
                }
                break;
            }
        }
    });
    return out.sort((a, b) => a.coverWeeks - b.coverWeeks);
}

/**
 * I9 weekly kg: the window it is read from, the last `weeksBack` weeks up to
 * `now`, starting later when the loaded bills start later.
 * @param {Date|number} now
 * @param {number} [loadedFrom=-Infinity] first loaded bill time (ms); -Infinity = all loaded
 * @param {{weeksBack?: number}} [opts]
 * @returns {?{from: number, to: number, weeks: number}} null under 2 weeks of bills
 */
export function weeklyKgWindow(now, loadedFrom = -Infinity, { weeksBack = 8 } = {}) {
    const end = Number(now);
    const from = Math.max(end - weeksBack * 7 * DAY_MS, loadedFrom);
    const weeks = (end - from) / (7 * DAY_MS);
    if (!(weeks >= 2)) return null;
    return { from, to: end + 1, weeks };
}

/**
 * I9: kg sold per week per item key.
 * @param {Array<{itemKey: string, qty: number}>} itemRows itemSummary() of the window
 * @param {number} weeks weeklyKgWindow().weeks
 * @returns {Map<string, number>}
 */
export function weeklyKgByItem(itemRows, weeks) {
    return new Map((itemRows || []).map(r => [r.itemKey, r.qty / weeks]));
}

// ------------------------------------------------------------------ Shares and checks (I2, I12, AC10, AC11)

/**
 * A figure rounded for display to `digits` decimals (profit per ₹100 and season
 * index to 1, kg to 0).
 * @param {number} value
 * @param {number} [digits=0]
 * @returns {number}
 */
export function roundTo(value, digits = 0) {
    const f = 10 ** digits;
    return Math.round(value * f) / f;
}

/**
 * Whole-number % of `part` in `total` (I2 retail / wholesale split, bar widths);
 * 0 when the total is 0.
 * @param {number} part
 * @param {number} total
 * @returns {number}
 */
export function sharePct(part, total) {
    return total ? Math.round((part / total) * 100) : 0;
}

/**
 * I12: share of the top `n` named parties (Insights › Parties takeaway).
 * @param {Array<{key: string, total: number}>} rows partySummary(), biggest first
 * @param {number} [n=5]
 * @returns {{total: number, top: number, pct: ?number}} pct null when the total is not above 0
 */
export function topShare(rows, n = 5) {
    const list = rows || [];
    const total = list.reduce((a, p) => a + p.total, 0);
    const top = list.filter(p => p.key).slice(0, n).reduce((a, p) => a + p.total, 0);
    return { total, top, pct: total > 0 ? Math.round((top / total) * 100) : null };
}

/**
 * AC10 / AC11: rows add up to a total (within `tolerance` rupees).
 * @param {Array<Object>} rows
 * @param {string} field
 * @param {number} total
 * @param {number} [tolerance=1]
 * @returns {boolean}
 */
export function addsUp(rows, field, total, tolerance = 1) {
    return Math.abs((rows || []).reduce((a, x) => a + x[field], 0) - total) <= tolerance;
}

// ------------------------------------------------------------------ Money › Cash by day (M14)

/**
 * M14 per local day (Money › Cash chart): money in − money out of each day, to paise.
 * @param {Object} detail moneySummary(…, {detail: true}).detail
 * @param {string[]} dayKeys local 'YYYY-MM-DD' days, in chart order
 * @returns {number[]} one value per key
 */
export function netMoneyByDay(detail, dayKeys) {
    const days = {};
    const add = (rows, sign) => (rows || []).forEach(x => {
        if (!Number.isFinite(x.t)) return;
        const k = toLocalISODate(new Date(x.t));
        days[k] = (days[k] || 0) + sign * (Number(x.amount) || 0);
    });
    const d = detail || {};
    add(d.receivedAtSale, 1); add(d.dueReceived, 1); add(d.paidAtPurchase, -1); add(d.duePaid, -1);
    add(d.business, -1); add(d.personal, -1);
    return (dayKeys || []).map(k => round2(days[k] || 0));
}

// ------------------------------------------------------------------ Worth (M15)

/**
 * M15 net worth = the chosen terms − payables (#39 default: stock + receivable
 * + other accounts + drawer cash − payable). Each due counted once.
 * @param {{stock: ?number, receivable: number, payable: number, accounts: ?number, drawer: ?number}} t
 *   accounts null = the shared accounts (#74) are not loaded yet
 * @param {typeof INSIGHTS_DEFAULTS} [cfg]
 * @returns {?number} null when the stock value or the accounts aren't known
 */
export function netWorth(t, cfg = INSIGHTS_DEFAULTS) {
    const terms = cfg.netWorthTerms;
    if (terms.includes('stock') && (t.stock === null || t.stock === undefined)) return null;
    if (terms.includes('accounts') && t.accounts === null) return null;
    let v = -num(t.payable);
    if (terms.includes('stock')) v += num(t.stock);
    if (terms.includes('receivable')) v += num(t.receivable);
    if (terms.includes('accounts')) v += num(t.accounts);
    if (terms.includes('drawer')) v += num(t.drawer);
    return round2(v);
}

/**
 * M15 "other accounts" term: owner-entered assets minus liabilities.
 * @param {Array<{balance: *, type?: string}>} accounts
 * @returns {number}
 */
export function accountsTotal(accounts) {
    return round2((accounts || []).reduce((a, x) => a + (x.type === 'liability' ? -1 : 1) * (Number(x.balance) || 0), 0));
}

/** Most accounts the shared list keeps (firestore.rules: settings/accounts). */
export const MAX_WORTH_ACCOUNTS = 30;
const ACCOUNT_NAME_MAX = 40;
const ACCOUNT_BALANCE_MAX = 1e10;

/**
 * The shared id of an account (#74): a hash of its name (case and spaces ignored),
 * so saving a name again on any phone replaces that account.
 * @param {string} name
 * @returns {string} "a" + 8 hex digits (safe as a Firestore field name)
 */
export function accountId(name) {
    const key = String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i += 1) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `a${h.toString(16).padStart(8, '0')}`;
}

/**
 * One account as stored in settings/accounts (#74), or null when the input is not
 * valid: a name (1–40 characters) and a balance of 0 or more, kept in whole rupees.
 * @param {{name: *, balance: *, type?: string}} input
 * @returns {?{id: string, entry: {name: string, balance: number, type: 'asset'|'liability'}}}
 */
export function accountEntry({ name, balance, type } = {}) {
    const n = String(name ?? '').trim().replace(/\s+/g, ' ');
    const b = Math.round(Number(balance)) + 0; // + 0: no -0 (a decimal in Firestore)
    if (!n || n.length > ACCOUNT_NAME_MAX || balance === '' || balance === null || !Number.isFinite(b) || b < 0 || b > ACCOUNT_BALANCE_MAX) return null;
    return { id: accountId(n), entry: { name: n, balance: b, type: type === 'liability' ? 'liability' : 'asset' } };
}

/**
 * The shared accounts map as a list for the screen and accountsTotal, sorted by
 * name; balances in whole rupees (#74), unreadable entries dropped.
 * @param {?Object<string, {name: *, balance: *, type?: string}>} map
 * @returns {Array<{id: string, name: string, balance: number, type: 'asset'|'liability'}>}
 */
export function accountsList(map) {
    if (!map || typeof map !== 'object') return [];
    return Object.entries(map)
        .filter(([, a]) => a && typeof a === 'object' && String(a.name ?? '').trim())
        .map(([id, a]) => ({ id, name: String(a.name).trim(), balance: Math.round(Number(a.balance) || 0), type: a.type === 'liability' ? 'liability' : 'asset' }))
        .sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
}

/**
 * The accounts saved on this phone before #74 (localStorage), as a shared map for
 * the owner's one-tap move. Names are cut to 40 characters; names that differ only
 * in case or spacing become one account with their total (a negative balance meant
 * the other side); accounts that can't be moved (no name, unreadable or too large
 * balance, more than 30) are returned in `skipped`, to stay on the phone.
 * @param {Array<{name: *, balance: *, type?: string}>} list
 * @returns {{map: Object<string, {name: string, balance: number, type: string}>, skipped: Array<Object>}}
 */
export function accountsFromPhone(list) {
    const groups = new Map();
    const skipped = [];
    (Array.isArray(list) ? list : []).forEach(a => {
        const name = String(a?.name ?? '').trim().replace(/\s+/g, ' ').slice(0, ACCOUNT_NAME_MAX).trim();
        const b = Number(a?.balance);
        if (!name || a?.balance === '' || a?.balance === null || !Number.isFinite(b)) { if (a) skipped.push(a); return; }
        const id = accountId(name);
        const g = groups.get(id) || { name, total: 0, items: [] };
        g.total += (a.type === 'liability' ? -1 : 1) * b;
        g.items.push(a);
        groups.set(id, g);
    });
    const map = {};
    groups.forEach((g, id) => {
        const total = Math.round(g.total);
        const e = accountEntry({ name: g.name, balance: Math.abs(total), type: total < 0 ? 'liability' : 'asset' });
        if (e && Object.keys(map).length < MAX_WORTH_ACCOUNTS) map[id] = e.entry;
        else skipped.push(...g.items);
    });
    return { map, skipped };
}

// ------------------------------------------------------------------ Drivers (I6)

/**
 * I6: the row with the largest absolute change between two keyed lists.
 * @param {Array<{key: string}>} now rows
 * @param {Array<{key: string}>} then rows
 * @param {(r: Object) => number} value
 * @returns {?{key: string, row: Object, diff: number}}
 */
export function biggestChange(now, then, value) {
    const a = new Map((now || []).map(r => [r.key, r]));
    const b = new Map((then || []).map(r => [r.key, r]));
    let best = null;
    new Set([...a.keys(), ...b.keys()]).forEach(k => {
        if (!k) return;
        const diff = (a.has(k) ? value(a.get(k)) : 0) - (b.has(k) ? value(b.get(k)) : 0);
        if (!best || Math.abs(diff) > Math.abs(best.diff)) best = { key: k, row: a.get(k) || b.get(k), diff: round2(diff) };
    });
    return best && best.diff !== 0 ? best : null;
}
