// @ts-check
/**
 * @fileoverview Worker pay (#373 phase 1, docs/calculations.md WP-1 … WP-10): monthly pay per
 * worker, what was paid for each month, and the balance carried from month to month (arrears
 * and advances). Pure; whole rupees. Not linked to Money (owner decision pending).
 * @module utils/worker-pay
 */

export const ENTRY_KINDS = Object.freeze(['pay', 'advance']);
export const ENTRY_MODES = Object.freeze(['cash', 'online']);
export const MAX_AMOUNT = 10000000;
export const MAX_NAME = 60;
export const MAX_NOTE = 120;
export const MAX_PAY_STEPS = 24;

/**
 * @typedef {{from: string, amount: number}} PayStep
 * @typedef {{id: string, month: string, date: string, amount: number, kind: string, mode: string, note?: string}} PayEntry
 * @typedef {{id?: string, name: string, startMonth: string, active: boolean, pays: PayStep[], entries?: PayEntry[]}} Worker
 * @typedef {{month: string, pay: number, paid: number, opening: number, recovered: number, closing: number, state: ?string, covered: number, owed: number}} MonthRow
 */

const pad2 = (/** @type {number} */ n) => String(n).padStart(2, '0');

/** @param {*} v */
export const isMonthKey = (v) => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
/** @param {*} v */
export const isDayKey = (v) => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v);

/** 'YYYY-MM' of a local date. */
export function monthKeyOf(date = new Date()) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

/**
 * @param {string} key 'YYYY-MM'
 * @param {number} n months to add (may be negative)
 */
export function addMonthKey(key, n) {
    const [y, m] = key.split('-').map(Number);
    const idx = y * 12 + (m - 1) + n;
    return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`;
}

/** A whole number of rupees from a form value, or null (blank, not whole, ≤ 0 or too big). */
export function wholeRupees(/** @type {*} */ value) {
    const s = String(value ?? '').trim();
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return n > 0 && n <= MAX_AMOUNT ? n : null;
}

/** Pay steps sorted by month, amounts as numbers. @param {*} pays @returns {PayStep[]} */
function steps(pays) {
    return (Array.isArray(pays) ? pays : [])
        .filter(p => p && isMonthKey(p.from))
        .map(p => ({ from: p.from, amount: Math.max(0, Number(p.amount) || 0) }))
        .sort((a, b) => a.from.localeCompare(b.from));
}

/**
 * WP-1: the monthly pay for `month`: the amount of the last pay step starting on or before it;
 * 0 before the start month (and from a step of 0: the worker left).
 * @param {Worker} worker
 * @param {string} month
 */
export function payFor(worker, month) {
    if (!worker || !isMonthKey(month) || month < worker.startMonth) return 0;
    let amount = 0;
    for (const p of steps(worker.pays)) if (p.from <= month) amount = p.amount;
    return amount;
}

/**
 * New pay steps: `amount` from `from` on (later steps are replaced). From the start month or
 * earlier, it is the pay from the start. amount 0 = left from that month.
 * @param {PayStep[]} pays
 * @param {string} startMonth
 * @param {string} from
 * @param {number} amount
 * @returns {PayStep[]}
 */
export function withPay(pays, startMonth, from, amount) {
    const at = from <= startMonth ? startMonth : from;
    return [...steps(pays).filter(p => p.from < at), { from: at, amount }];
}

/**
 * Pay steps for a new start month: the pay in effect then becomes the first step.
 * @param {PayStep[]} pays
 * @param {string} startMonth
 * @returns {PayStep[]}
 */
export function withStart(pays, startMonth) {
    const all = steps(pays);
    const first = all.filter(p => p.from <= startMonth).pop() || all[0] || { from: startMonth, amount: 0 };
    return [{ from: startMonth, amount: first.amount }, ...all.filter(p => p.from > startMonth)];
}

/**
 * The month a worker who left stops being paid (their newest pay step is 0), else null.
 * @param {PayStep[]} pays
 */
export function leftFrom(pays) {
    const last = steps(pays).pop();
    return last && last.amount === 0 ? last.from : null;
}

/** The newest pay above 0, or 0. @param {PayStep[]} pays */
export const lastPay = (pays) => steps(pays).filter(p => p.amount > 0).map(p => p.amount).pop() || 0;

/** @param {Worker} worker @returns {PayEntry[]} */
const entriesOf = (worker) => (Array.isArray(worker?.entries) ? worker.entries : [])
    .filter(e => e && isMonthKey(e.month) && Number(e.amount) > 0);

/**
 * What a balance (WP-5) means: still to pay (> 0) or an advance carried to the next month (< 0).
 * @param {number} balance
 */
export const balanceParts = (balance) => ({ left: Math.max(0, balance), advance: Math.max(0, -balance) });

/**
 * WP-2 … WP-6, month by month from the start month (or an earlier entry) to `upto`:
 * pay (WP-1), paid = Σ entries for the month (WP-2), opening = the month before's closing (WP-3:
 * > 0 still owed from before, < 0 an advance carried in), recovered = the part of the pay covered
 * by that advance (WP-4), closing = opening + pay − paid (WP-5: > 0 still to pay, < 0 advance
 * carried to the next month), and the month's state (WP-6). Entries after `upto` are not counted.
 * @param {Worker} worker
 * @param {string} upto 'YYYY-MM'
 * @returns {{months: MonthRow[], balance: number}}
 */
export function workerLedger(worker, upto) {
    const entries = entriesOf(worker);
    const first = [worker?.startMonth, ...entries.map(e => e.month)].filter(isMonthKey).sort()[0];
    /** @type {MonthRow[]} */
    const months = [];
    if (!first || !isMonthKey(upto)) return { months, balance: 0 };
    const paidBy = new Map();
    for (const e of entries) paidBy.set(e.month, (paidBy.get(e.month) || 0) + Number(e.amount));
    let opening = 0;
    for (let m = first; m <= upto; m = addMonthKey(m, 1)) {
        const pay = payFor(worker, m);
        const paid = paidBy.get(m) || 0;
        const recovered = Math.min(pay, Math.max(0, -opening));
        const closing = opening + pay - paid;
        months.push({ month: m, pay, paid, opening, recovered, closing, ...monthState(pay, opening, closing) });
        opening = closing;
    }
    return { months, balance: opening };
}

/**
 * WP-6: paid (nothing left: closing ≤ 0), part-paid (X of Y) or due (Y). Y = owed = the month's
 * pay + what was still owed from before; X = covered = Y − closing (paid this month plus advance
 * recovered). No state when nothing is owed for the month (Y = 0).
 * @param {number} pay
 * @param {number} opening
 * @param {number} closing
 * @returns {{state: ?string, owed: number, covered: number}}
 */
export function monthState(pay, opening, closing) {
    const owed = pay + Math.max(0, opening);
    if (owed <= 0) return { state: null, owed: 0, covered: 0 };
    if (closing <= 0) return { state: 'paid', owed, covered: owed };
    const covered = owed - closing;
    return { state: covered > 0 ? 'part' : 'due', owed, covered };
}

/**
 * Page summary for `month` (WP-7 … WP-10) and each worker's row for it.
 * WP-7 pay this month = Σ WP-1 of every worker; WP-8 paid out this month = Σ every entry whose
 * `date` is in the month, whatever month it pays (money out, as OD-07); WP-9 still to pay =
 * Σ positive balances (WP-5) at the end of the month; WP-10 advances carried = Σ negative ones.
 * @param {Worker[]} workers
 * @param {string} month
 */
export function paySummary(workers, month) {
    let pay = 0;
    let paidOut = 0;
    let toPay = 0;
    let advances = 0;
    const counts = { paid: 0, part: 0, due: 0 };
    const rows = (workers || []).map((w) => {
        const { months, balance } = workerLedger(w, month);
        const row = months.length && months[months.length - 1].month === month ? months[months.length - 1] : null;
        pay += row ? row.pay : 0;
        for (const e of entriesOf(w)) if (String(e.date || '').slice(0, 7) === month) paidOut += Number(e.amount);
        if (balance > 0) toPay += balance;
        else advances -= balance;
        if (row?.state) counts[/** @type {'paid'|'part'|'due'} */ (row.state)]++;
        return { worker: w, row, balance, months };
    });
    return { pay, paidOut, toPay, advances, counts, rows };
}

/**
 * WP-11: salaries due for `month` (Today). A month's pay counts as due from the 1st of that month,
 * as rent does: the workers whose balance at the end of the month (WP-5) is above 0, and Σ of those
 * balances (= WP-9 of the month).
 * @param {Worker[]} workers
 * @param {string} month
 * @returns {{count: number, due: number}}
 */
export function payDue(workers, month) {
    let count = 0;
    let due = 0;
    for (const w of workers || []) {
        const { balance } = workerLedger(w, month);
        if (balance > 0) { count++; due += balance; }
    }
    return { count, due };
}

/**
 * WP-11 for `month` and the `n - 1` months after it, kept for Today. No entry can be for a later
 * month than the current one, so these hold until something new is recorded.
 * @param {Worker[]} workers
 * @param {string} month
 * @param {number} [n]
 * @returns {Record<string, {count: number, due: number}>}
 */
export function payDueMonths(workers, month, n = 3) {
    /** @type {Record<string, {count: number, due: number}>} */
    const out = {};
    for (let i = 0; i < n; i++) out[addMonthKey(month, i)] = payDue(workers, addMonthKey(month, i));
    return out;
}

/**
 * A new entry from the form, or the i18n key of what is wrong.
 * @param {{amount: *, month: string, date: string, kind: string, mode: string, note?: string}} f
 * @param {string} thisMonth
 * @returns {{entry?: Omit<PayEntry, 'id'>, error?: string}}
 */
export function checkEntry(f, thisMonth) {
    const amount = wholeRupees(f.amount);
    if (amount === null) return { error: 'msg.workers.bad_amount' };
    if (!isMonthKey(f.month) || f.month > thisMonth) return { error: 'msg.workers.bad_month' };
    if (!isDayKey(f.date) || f.date.slice(0, 7) > thisMonth) return { error: 'msg.workers.bad_date' };
    const kind = ENTRY_KINDS.includes(f.kind) ? f.kind : 'pay';
    const mode = ENTRY_MODES.includes(f.mode) ? f.mode : 'cash';
    const note = String(f.note || '').trim().slice(0, MAX_NOTE);
    return { entry: { month: f.month, date: f.date, amount, kind, mode, ...(note ? { note } : {}) } };
}

/**
 * A worker from the form, or the i18n key of what is wrong.
 * @param {{name: string, pay: *, startMonth: string}} f
 * @param {string} thisMonth
 * @returns {{worker?: {name: string, startMonth: string, pay: number}, error?: string}}
 */
export function checkWorker(f, thisMonth) {
    const name = String(f.name || '').trim().slice(0, MAX_NAME);
    if (!name) return { error: 'msg.workers.need_name' };
    const pay = wholeRupees(f.pay);
    if (pay === null) return { error: 'msg.workers.bad_pay' };
    if (!isMonthKey(f.startMonth) || f.startMonth > addMonthKey(thisMonth, 1)) return { error: 'msg.workers.bad_month' };
    return { worker: { name, startMonth: f.startMonth, pay } };
}
