// @ts-check
/**
 * @fileoverview Recurring bills (#437 phase 1, docs/calculations.md RB-1 … RB-11): electricity,
 * water, rent and other repeating payments. Each bill item has a cadence; each period has a bill
 * amount, payments and a balance carried to the next period (as worker arrears, WP-5). Pure; whole
 * rupees. Not linked to Money (owner decision pending).
 * @module utils/recurring-bills
 */

import {
    isMonthKey, isDayKey, monthKeyOf, addMonthKey, wholeRupees, balanceParts, ENTRY_MODES, MAX_NAME, MAX_NOTE
} from './worker-pay.js';
import { addLocalDays, toLocalISODate } from './dates.js';

export { isMonthKey, monthKeyOf, addMonthKey, balanceParts, MAX_NAME, MAX_NOTE };

/** Months between bills: monthly, every 2 months, quarterly, half-yearly, yearly. */
export const CADENCES = Object.freeze([1, 2, 3, 6, 12]);
export const MAX_DUE_DAY = 28;
export const MAX_ENTRIES = 3000;
/** Today's line counts a bill due within this many days (RB-11). */
export const SOON_DAYS = 3;
/** A bill more than this many times the item's last one asks "Yes, it's right" (never blocks). */
export const UNUSUAL_FACTOR = 3;

/**
 * @typedef {{id: string, kind: 'bill'|'pay', period: string, date: string, amount: number, mode?: string, note?: string}} BillEntry
 * @typedef {{id?: string, name: string, cadence: number, dueDay: number, startMonth: string, expected: number, active: boolean, endMonth?: string, note?: string, entries?: BillEntry[]}} BillItem
 * @typedef {{period: string, due: string, bill: ?number, source: ?string, paid: number, opening: number, closing: number, owed: number, covered: number, overdue: boolean, state: string}} PeriodRow
 */

const pad2 = (/** @type {number} */ n) => String(n).padStart(2, '0');
const monthIndex = (/** @type {string} */ key) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;

/** @param {BillItem} item */
export const cadenceOf = (item) => (CADENCES.includes(Number(item?.cadence)) ? Number(item.cadence) : 1);

/** 'YYYY-MM-DD' `n` days after `day`. */
export const addDayKey = (/** @type {string} */ day, /** @type {number} */ n) => toLocalISODate(/** @type {Date} */ (addLocalDays(day, n)));

/** RB-1: the due date of the period that starts in `period` (its due day, 1–28, in that month). */
export function dueDateOf(/** @type {BillItem} */ item, /** @type {string} */ period) {
    const day = Math.min(MAX_DUE_DAY, Math.max(1, Math.trunc(Number(item?.dueDay)) || 1));
    return `${period}-${pad2(day)}`;
}

/** The item's last period month (stopped items), or null. @param {BillItem} item */
const lastMonth = (item) => (item?.endMonth && isMonthKey(item.endMonth) ? item.endMonth : null);

/**
 * RB-1: the periods of an item up to `upto`: the start month, then every `cadence` months, none after
 * the month a stopped item's last bill was due.
 * @param {BillItem} item
 * @param {string} upto 'YYYY-MM'
 * @returns {string[]}
 */
export function periodsUpTo(item, upto) {
    /** @type {string[]} */
    const out = [];
    if (!item || !isMonthKey(item.startMonth) || !isMonthKey(upto)) return out;
    const end = lastMonth(item);
    const c = cadenceOf(item);
    for (let p = item.startMonth; p <= upto && (!end || p <= end) && out.length < 2400; p = addMonthKey(p, c)) out.push(p);
    return out;
}

/**
 * The period an entry counts towards: the period its `period` month falls in (before the start: the
 * first; after a stop: the last).
 * @param {BillItem} item
 * @param {string} month
 */
export function periodOf(item, month) {
    const c = cadenceOf(item);
    const end = lastMonth(item);
    const capped = end && month > end ? end : month;
    const k = Math.max(0, Math.floor((monthIndex(capped) - monthIndex(item.startMonth)) / c));
    return addMonthKey(item.startMonth, k * c);
}

/** The next period after `period`, or null when the item stopped before it. */
export function nextPeriod(/** @type {BillItem} */ item, /** @type {?string} */ period) {
    const p = period ? addMonthKey(period, cadenceOf(item)) : item.startMonth;
    const end = lastMonth(item);
    return end && p > end ? null : p;
}

/** @param {BillItem} item @returns {BillEntry[]} */
const entriesOf = (item) => (Array.isArray(item?.entries) ? item.entries : [])
    .filter(e => e && isMonthKey(e.period) && Number.isFinite(Number(e.amount))
        && ((e.kind === 'bill' && Number(e.amount) >= 0) || (e.kind === 'pay' && Number(e.amount) > 0)));

/**
 * RB-2: the bill amount of each period: the newest 'bill' entry for it (entries are appended in
 * order, so a correction is a later entry). A bill for a month after a stopped item's last month is
 * not one of its bills and is ignored (it would otherwise "correct" the last real bill).
 * @param {BillItem} item
 * @returns {Map<string, number>}
 */
function billsByPeriod(item) {
    const out = new Map();
    const end = lastMonth(item);
    for (const e of entriesOf(item)) {
        if (e.kind === 'bill' && !(end && e.period > end)) out.set(periodOf(item, e.period), Number(e.amount));
    }
    return out;
}

/**
 * The months of bill entries after `last` (a stop there would leave them out), oldest first.
 * @param {BillItem} item
 * @param {string} last 'YYYY-MM'
 */
export const billsAfter = (item, last) => [...new Set(entriesOf(item).filter(e => e.kind === 'bill' && e.period > last).map(e => e.period))].sort();

/**
 * RB-2 … RB-7, period by period up to `upto` (periods whose due month is after it are not counted
 * yet): the bill (RB-2: entered, else the expected amount, else none), paid (RB-3), carried in (RB-4),
 * balance (RB-5: carried in + bill − paid; > 0 still to pay, < 0 a credit), state (RB-6) and overdue
 * (RB-7) on `today`.
 * @param {BillItem} item
 * @param {string} upto 'YYYY-MM'
 * @param {string} today 'YYYY-MM-DD'
 * @returns {{periods: PeriodRow[], balance: number}}
 */
export function billLedger(item, upto, today) {
    const list = periodsUpTo(item, upto);
    const bills = billsByPeriod(item);
    const paidBy = new Map();
    for (const e of entriesOf(item)) {
        if (e.kind !== 'pay') continue;
        const p = periodOf(item, e.period);
        paidBy.set(p, (paidBy.get(p) || 0) + Number(e.amount));
    }
    const expected = Number(item?.expected) > 0 ? Number(item.expected) : 0;
    /** @type {PeriodRow[]} */
    const periods = [];
    let opening = 0;
    for (const period of list) {
        const entered = bills.has(period);
        const bill = entered ? /** @type {number} */ (bills.get(period)) : expected > 0 ? expected : null;
        const paid = paidBy.get(period) || 0;
        const closing = opening + (bill ?? 0) - paid;
        const due = dueDateOf(item, period);
        const owed = (bill ?? 0) + Math.max(0, opening);
        const covered = closing <= 0 ? owed : owed - closing;
        const overdue = closing > 0 && (today > due || paid < opening);
        const state = bill === null ? 'nobill' : closing <= 0 ? 'paid' : overdue ? 'overdue' : covered > 0 ? 'part' : 'due';
        periods.push({ period, due, bill, source: entered ? 'entered' : bill === null ? null : 'expected', paid, opening, closing, owed, covered, overdue, state });
        opening = closing;
    }
    return { periods, balance: opening };
}

/**
 * The item on `today`: its ledger to this month, the current period (the newest one due this month or
 * earlier; null before the first) and RB-10, the next due date: the current period's while it is not
 * paid, else the next period's (null when the item stopped).
 * @param {BillItem} item
 * @param {string} today 'YYYY-MM-DD'
 */
export function itemView(item, today) {
    const { periods, balance } = billLedger(item, today.slice(0, 7), today);
    const current = periods.length ? periods[periods.length - 1] : null;
    let nextDue = null;
    if (current && current.state !== 'paid') nextDue = current.due;
    else {
        const p = nextPeriod(item, current ? current.period : null);
        nextDue = p ? dueDateOf(item, p) : null;
    }
    return { item, periods, balance, current, nextDue };
}

/**
 * The page on `today` (RB-8, RB-9 and the counts): RB-8 Due now = Σ balances above 0 (RB-5 at the end
 * of this month: every bill due this month or earlier, still unpaid), credit = Σ balances below 0,
 * RB-9 Paid this month = Σ payments whose date is in this month, whatever period they pay.
 * @param {BillItem[]} items
 * @param {string} today 'YYYY-MM-DD'
 */
export function billsSummary(items, today) {
    const month = today.slice(0, 7);
    let dueNow = 0;
    let credit = 0;
    let paidMonth = 0;
    const counts = { paid: 0, part: 0, due: 0, overdue: 0, nobill: 0 };
    const rows = (items || []).map((item) => {
        const v = itemView(item, today);
        if (v.balance > 0) dueNow += v.balance;
        else credit -= v.balance;
        for (const e of entriesOf(item)) if (e.kind === 'pay' && String(e.date || '').slice(0, 7) === month) paidMonth += Number(e.amount);
        if (v.current) counts[/** @type {'paid'|'part'|'due'|'overdue'|'nobill'} */ (v.current.state)]++;
        return v;
    });
    return { dueNow, credit, paidMonth, counts, rows };
}

/**
 * RB-11: bills due on Today, on `day`: items whose newest period due by `day` + 3 days still owes
 * something that is due by then (the whole balance once its due date is within 3 days or past, else
 * only what was carried in and not yet paid), or has no amount entered and is due by then.
 * @param {BillItem[]} items
 * @param {string} day 'YYYY-MM-DD'
 * @returns {{count: number, due: number, nobill: number}}
 */
export function billsDue(items, day) {
    const soon = addDayKey(day, SOON_DAYS);
    let count = 0;
    let due = 0;
    let nobill = 0;
    for (const item of items || []) {
        const { periods } = billLedger(item, soon.slice(0, 7), day);
        const cur = periods[periods.length - 1];
        if (!cur) continue;
        const amount = cur.due <= soon ? Math.max(0, cur.closing) : Math.max(0, Math.min(cur.closing, cur.opening - cur.paid));
        const missing = cur.bill === null && cur.due <= soon;
        if (amount <= 0 && !missing) continue;
        count++;
        due += amount;
        if (missing) nobill++;
    }
    return { count, due, nobill };
}

/**
 * RB-11 for `day` and the `n - 1` days after it, kept for Today.
 * @param {BillItem[]} items
 * @param {string} day
 * @param {number} [n]
 */
export function billsDueDays(items, day, n = 7) {
    /** @type {Record<string, {count: number, due: number, nobill: number}>} */
    const out = {};
    for (let i = 0; i < n; i++) out[addDayKey(day, i)] = billsDue(items, addDayKey(day, i));
    return out;
}

/** The periods an entry may be for on `today`: every period so far and the next one. */
export function entryPeriods(/** @type {BillItem} */ item, /** @type {string} */ today) {
    const list = periodsUpTo(item, today.slice(0, 7));
    const next = nextPeriod(item, list.length ? list[list.length - 1] : null);
    return next && !list.includes(next) ? [...list, next] : list;
}

/** Whole rupees, 0 allowed (a bill of nothing), or null. */
function wholeOrZero(/** @type {*} */ v) {
    return String(v ?? '').trim() === '0' ? 0 : wholeRupees(v);
}

/**
 * A bill item from the form, or the i18n key of what is wrong.
 * @param {{name: string, cadence: *, dueDay: *, startMonth: string, expected: *, note?: string}} f
 * @param {string} thisMonth
 */
export function checkItem(f, thisMonth) {
    const name = String(f.name || '').trim().slice(0, MAX_NAME);
    if (!name) return { error: 'msg.rbills.need_name' };
    const cadence = Number(f.cadence);
    if (!CADENCES.includes(cadence)) return { error: 'msg.rbills.bad_cadence' };
    const dueDay = String(f.dueDay ?? '').trim();
    if (!/^\d+$/.test(dueDay) || Number(dueDay) < 1 || Number(dueDay) > MAX_DUE_DAY) return { error: 'msg.rbills.bad_due_day' };
    if (!isMonthKey(f.startMonth) || f.startMonth > addMonthKey(thisMonth, 12)) return { error: 'msg.rbills.bad_month' };
    const blank = String(f.expected ?? '').trim() === '';
    const expected = blank ? 0 : wholeOrZero(f.expected);
    if (expected === null) return { error: 'msg.rbills.bad_amount' };
    const note = String(f.note || '').trim().slice(0, MAX_NOTE);
    return { item: { name, cadence, dueDay: Number(dueDay), startMonth: f.startMonth, expected, note } };
}

/**
 * A bill amount (kind 'bill') or a payment (kind 'pay') from the form, or the i18n key of what is wrong.
 * @param {{kind: string, amount: *, period: string, date: string, mode?: string, note?: string}} f
 * @param {BillItem} item
 * @param {string} today 'YYYY-MM-DD'
 * @returns {{entry?: Omit<BillEntry, 'id'>, error?: string}}
 */
export function checkEntry(f, item, today) {
    const bill = f.kind === 'bill';
    const amount = bill ? wholeOrZero(f.amount) : wholeRupees(f.amount);
    if (amount === null) return { error: bill ? 'msg.rbills.bad_bill' : 'msg.rbills.bad_amount' };
    if (!entryPeriods(item, today).includes(f.period)) return { error: 'msg.rbills.bad_period' };
    if (!isDayKey(f.date) || f.date > today) return { error: 'msg.rbills.bad_date' };
    if (bill) return { entry: { kind: 'bill', period: f.period, date: f.date, amount } };
    const mode = ENTRY_MODES.includes(String(f.mode)) ? String(f.mode) : 'cash';
    const note = String(f.note || '').trim().slice(0, MAX_NOTE);
    return { entry: { kind: 'pay', period: f.period, date: f.date, amount, mode, ...(note ? { note } : {}) } };
}

/**
 * The item's last bill before `period` (the newest entered for an earlier period, else the expected
 * amount) when `amount` is more than 3 times it, else null: the form then asks "Yes, it's right".
 * @param {BillItem} item
 * @param {string} period
 * @param {number} amount
 * @returns {?number}
 */
export function unusualBill(item, period, amount) {
    const earlier = [...billsByPeriod(item)].filter(([p]) => p < period).sort((a, b) => a[0].localeCompare(b[0]));
    const last = earlier.length ? earlier[earlier.length - 1][1] : Number(item?.expected) || 0;
    return last > 0 && amount > UNUSUAL_FACTOR * last ? last : null;
}
