/**
 * @fileoverview Diagnostics → Number checks (#216). Runs the accounting checks
 * from docs/calculations.md (AC1–AC6, AC8) on the data already loaded on this
 * device and lists every difference. Pure functions only: no DOM, no
 * Firestore, no extra reads.
 * @module utils/number-checks
 */

import { readPayment, billTotal, round2, isOpeningRecord, activeBills } from './money.js';
import { saleTimePayment, entryParts } from './due-payments.js';
import { collectEvents, createItemKeyResolver, purchaseLineValue, replayEvents } from './stock-replay.js';
import { parseAnyBillDate } from './dates.js';
import { sessionTotals } from './cash-session.js';

/** Allowed gap (₹) before a check fails. */
export const NUMBER_CHECK_TOLERANCE = 1;
/** Rows kept per failing check (the count still covers all of them). */
export const MAX_ROWS = 20;

const BILL_KINDS = [['purchases', 'purchase'], ['wholesaleSales', 'wholesale'], ['retailSales', 'retail']];

/** Short reference for a bill: kind, number, party, date. */
export function billRef(bill, kind) {
    const d = parseAnyBillDate(bill?.date);
    const day = d ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` : String(bill?.date ?? '?');
    const party = String(bill?.customerName || bill?.customer || bill?.supplierName || '').trim();
    return { kind, id: bill?.id != null ? String(bill.id) : '', number: String(bill?.billNumber || bill?.id || ''), party, day };
}

function result(id, key, rows, checked, extra = {}) {
    return { id, key, status: rows.length ? 'fail' : 'pass', checked, problems: rows.length, rows: rows.slice(0, MAX_ROWS), ...extra };
}

const eachBill = (data, fn) => BILL_KINDS.forEach(([field, kind]) => activeBills(data[field]).forEach(b => fn(b, kind)));
/** Bills that are activity: opening records (old-app dues, no total) are balances only. */
const eachActivityBill = (data, fn) => eachBill(data, (b, kind) => { if (!isOpeningRecord(b)) fn(b, kind); });

/** AC2: cash + online + due (+ written off) = bill total, within ₹1. */
export function checkBillSplit(data) {
    const rows = [];
    let checked = 0;
    eachActivityBill(data, (bill, kind) => {
        checked++;
        const p = readPayment(bill);
        const total = billTotal(bill);
        const writtenOff = Number(bill?.payment?.writtenOff) || 0;
        const entered = round2(p.cash + p.online + p.due + writtenOff);
        if (Math.abs(total - entered) > NUMBER_CHECK_TOLERANCE) {
            rows.push({ ref: billRef(bill, kind), expected: total, actual: entered, diff: round2(total - entered) });
        }
    });
    return result('AC2', 'ui.numchecks.ac2', rows, checked);
}

/** AC3: paid when saved + later payments in payments[] = cash and online on the bill. */
export function checkPayments(data) {
    const rows = [];
    let checked = 0;
    eachBill(data, (bill, kind) => {
        if (!Array.isArray(bill?.payments) || !bill.payments.length) return;
        checked++;
        const p = readPayment(bill);
        const at = saleTimePayment(bill);
        const later = bill.payments.map(entryParts).reduce((a, e) => ({ cash: a.cash + e.cash, online: a.online + e.online }), { cash: 0, online: 0 });
        const sum = round2(at.cash + at.online + later.cash + later.online);
        const onBill = round2(p.cash + p.online);
        if (Math.abs(sum - onBill) > 0.01) rows.push({ ref: billRef(bill, kind), expected: onBill, actual: sum, diff: round2(onBill - sum) });
    });
    return result('AC3', 'ui.numchecks.ac3', rows, checked);
}

/**
 * AC1 + AC8: replays all loaded records. Per item, purchases (their saved line
 * amounts, AVG-COST) − cost of goods sold (qty × average cost at the time) ± adjustments must equal
 * the closing stock value; a gap means stock went below zero (goods sold
 * before their purchase was recorded). Needs the full history: without it the
 * replay starts mid-way and every item would look wrong.
 * @returns {Array} two results: AC1 (value gap per item), AC8 (items below zero now)
 */
export function checkStock(data, { fullHistory = true } = {}) {
    if (!fullHistory) {
        return [
            { id: 'AC1', key: 'ui.numchecks.ac1', status: 'skip', note: 'ui.numchecks.needs_full_history', checked: 0, problems: 0, rows: [] },
            { id: 'AC8', key: 'ui.numchecks.ac8', status: 'skip', note: 'ui.numchecks.needs_full_history', checked: 0, problems: 0, rows: [] }
        ];
    }
    const getKey = createItemKeyResolver(data.items || []);
    const events = collectEvents({
        purchases: data.purchases, wholesaleSales: data.wholesaleSales, retailSales: data.retailSales, stockAdjustments: data.stockAdjustments
    });
    const state = {};
    const flow = {};
    const f = (k) => flow[k] || (flow[k] = { purchases: 0, cogs: 0, adjustments: 0 });
    for (const ev of events) {
        const key = ev.kind === 'adjustment' ? getKey({ itemId: ev.adj.itemId, name: ev.adj.itemName }) : getKey(ev.item);
        const s = state[key] || { quantity: 0, totalValue: 0 };
        const before = s.quantity > 0 ? s.totalValue : 0;
        const avg = s.quantity > 0 ? s.totalValue / s.quantity : 0;
        const qty = ev.kind === 'adjustment' ? 0 : (parseFloat(ev.item.qty || ev.item.quantity) || 0);
        replayEvents(state, [ev], getKey);
        const after = state[key].quantity > 0 ? state[key].totalValue : 0;
        if (ev.kind === 'purchase') f(key).purchases += purchaseLineValue(ev.item).value;
        else if (ev.kind === 'sale') f(key).cogs += qty * avg;
        else f(key).adjustments += after - before;
    }
    const names = new Map((data.items || []).map(i => [i.id, i.name]));
    const gapRows = [];
    const negRows = [];
    Object.keys(flow).forEach(key => {
        const s = state[key];
        const closing = s.quantity > 0 ? s.totalValue : 0;
        const fl = flow[key];
        const expected = round2(fl.purchases - fl.cogs + fl.adjustments);
        const item = names.get(key) || key;
        if (Math.abs(expected - closing) > NUMBER_CHECK_TOLERANCE) {
            gapRows.push({ ref: { item }, expected, actual: round2(closing), diff: round2(expected - closing) });
        }
        if (s.quantity < -1e-9) negRows.push({ ref: { item }, expected: 0, actual: round2(s.quantity), diff: round2(-s.quantity), unit: 'qty' });
    });
    return [
        result('AC1', 'ui.numchecks.ac1', gapRows, Object.keys(flow).length),
        result('AC8', 'ui.numchecks.ac8', negRows, Object.keys(flow).length)
    ];
}

/** AC4: every bill has a readable date, so the months add up to all time. */
export function checkDates(data) {
    const rows = [];
    let checked = 0;
    let all = 0;
    let months = 0;
    eachActivityBill(data, (bill, kind) => {
        checked++;
        const total = billTotal(bill);
        all += total;
        if (parseAnyBillDate(bill?.date)) months += total;
        else rows.push({ ref: billRef(bill, kind), expected: total, actual: 0, diff: total });
    });
    return result('AC4', 'ui.numchecks.ac4', rows, checked, { totals: { all: round2(all), months: round2(months) } });
}

/** AC5: the due stored on the bill agrees in both places (top-level dueAmount and payment.due). */
export function checkDueFields(data) {
    const rows = [];
    let checked = 0;
    eachBill(data, (bill, kind) => {
        const nested = bill?.payment && typeof bill.payment === 'object' ? bill.payment.due : undefined;
        if (bill?.cleared || nested === undefined || nested === null || bill.dueAmount === undefined || bill.dueAmount === null) return;
        checked++;
        const a = round2(Number(nested) || 0);
        const b = round2(Number(bill.dueAmount) || 0);
        if (Math.abs(a - b) > 0.01) rows.push({ ref: billRef(bill, kind), expected: a, actual: b, diff: round2(a - b) });
    });
    return result('AC5', 'ui.numchecks.ac5', rows, checked);
}

/**
 * AC6: for a closed session, the expected cash saved at close must equal
 * opening + cash in − cash out recomputed from today's loaded bills (a
 * difference means a bill or payment of that day changed after closing).
 * @param {?Object} session today's cash session
 * @param {Function} transactionsFor (dateStr, session) → drawer totals
 */
export function checkDrawer(session, transactionsFor) {
    if (!session) return { id: 'AC6', key: 'ui.numchecks.ac6', status: 'skip', note: 'ui.numchecks.no_session', checked: 0, problems: 0, rows: [] };
    const live = sessionTotals(session, transactionsFor(session.date, session));
    const stored = Number(session.expectedBalance);
    const rows = [];
    if (session.signedOut && Number.isFinite(stored) && Math.abs(stored - live.expected) > NUMBER_CHECK_TOLERANCE) {
        rows.push({ ref: { day: session.date }, expected: live.expected, actual: round2(stored), diff: round2(live.expected - stored) });
    }
    return result('AC6', 'ui.numchecks.ac6', rows, 1, { expected: live.expected });
}

/**
 * Every check on the loaded data.
 * @param {Object} data {items, purchases, wholesaleSales, retailSales, stockAdjustments}
 * @param {{fullHistory?: boolean, session?: Object, transactionsFor?: Function}} [opts]
 * @returns {Array<{id, key, status: 'pass'|'fail'|'skip', checked, problems, rows, note?}>}
 */
export function runNumberChecks(data, { fullHistory = true, session = null, transactionsFor = null } = {}) {
    return [
        ...checkStock(data, { fullHistory }),
        checkBillSplit(data),
        checkPayments(data),
        checkDates(data),
        checkDueFields(data),
        transactionsFor ? checkDrawer(session, transactionsFor)
            : { id: 'AC6', key: 'ui.numchecks.ac6', status: 'skip', note: 'ui.numchecks.no_session', checked: 0, problems: 0, rows: [] }
    ];
}
