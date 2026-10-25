/**
 * @fileoverview Money helpers shared by finance/outstanding/reports screens.
 * Bills exist in several schemas:
 *   - payment: { cash, online, due, total }        (current; payment.total may be bill total or amount paid)
 *   - cashPayment / onlinePayment / dueAmount      (top-level, written alongside payment by newer bills)
 *   - amountPaid                                   (legacy, non-online amount paid)
 *   - grandTotal / amountPayable / total / billTotal / saleTotal for the bill total
 * @module utils/money
 */

import { t } from '../i18n/index.js';

/**
 * Round to 2 decimals (paise), avoiding 1.005 -> 1.00 style float errors.
 * @param {*} x
 * @returns {number}
 */
export function round2(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Parse a stored money value; returns null when absent/unparseable
 * (so an explicit 0 is distinguishable from a missing field).
 * @param {*} v
 * @returns {number|null}
 */
export function toMoney(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
}

/** First value that is present and numeric (0 counts as present). */
function firstPresent(...values) {
    for (const v of values) {
        const n = toMoney(v);
        if (n !== null) return n;
    }
    return null;
}

/**
 * Sum values (optionally mapped) with paise rounding.
 * @param {Array} items
 * @param {Function} [fn] mapper item -> number
 * @returns {number}
 */
export function sumMoney(items, fn) {
    if (!Array.isArray(items)) return 0;
    let total = 0;
    for (const item of items) {
        total += toMoney(fn ? fn(item) : item) || 0;
    }
    return round2(total);
}

/**
 * Bill total payable/receivable (net of labour for purchases).
 * @param {Object} bill
 * @returns {number}
 */
export function billTotal(bill) {
    if (!bill) return 0;
    return round2(
        toMoney(bill.grandTotal) || toMoney(bill.amountPayable) || toMoney(bill.total) ||
        toMoney(bill.billTotal) || toMoney(bill.saleTotal) || 0
    );
}

/**
 * Normalised payment view of a bill across all known schemas.
 * The payment object wins over top-level fields because outstanding/wholesale
 * payment recording only updates payment.*.
 * @param {Object} bill
 * @returns {{total: number, cash: number, online: number, due: number, paid: number}}
 */
export function readPayment(bill) {
    if (!bill || typeof bill !== 'object') {
        return { total: 0, cash: 0, online: 0, due: 0, paid: 0 };
    }
    const p = bill.payment && typeof bill.payment === 'object' ? bill.payment : {};
    const total = billTotal(bill);
    const cash = firstPresent(p.cash, bill.cashPayment, bill.amountPaid);
    const online = firstPresent(p.online, bill.onlinePayment);
    const paid = round2((cash || 0) + (online || 0));

    let due = firstPresent(p.due, bill.dueAmount, bill.due);
    if (due === null) {
        // Legacy docs with only amountPaid/cash/online: derive due from total.
        due = (cash !== null || online !== null) ? Math.max(0, total - paid) : 0;
    }

    return {
        total,
        cash: round2(cash || 0),
        online: round2(online || 0),
        due: round2(due),
        paid
    };
}

/**
 * Outstanding amount still owed on a bill (0 when cleared or overpaid).
 * @param {Object} bill
 * @returns {number}
 */
export function outstandingDue(bill) {
    if (!bill || bill.cleared) return 0;
    const due = readPayment(bill).due;
    return due > 0 ? due : 0;
}

/**
 * Opening balance carried from the old Firebase project (tools/migrate): one
 * record per old unpaid bill, with no lines and no bill total, so sales and
 * profit are never counted twice; the open amount is `openingBalance.amount`.
 * @param {Object} bill
 * @returns {boolean}
 */
export function isOpeningBalance(bill) {
    return !!(bill && bill.openingBalance && typeof bill.openingBalance === 'object');
}

/**
 * Carried amount of an opening-balance record (0 for ordinary bills).
 * @param {Object} bill
 * @returns {number}
 */
export function openingAmount(bill) {
    return isOpeningBalance(bill) ? round2(toMoney(bill.openingBalance.amount) || 0) : 0;
}

/**
 * The old bill's total and what was paid on it before the move, for display.
 * @param {Object} bill
 * @returns {?{total: number, paid: number}} null for ordinary bills
 */
export function openingOldTotals(bill) {
    if (!isOpeningBalance(bill)) return null;
    const o = bill.openingBalance;
    return { total: round2(toMoney(o.billTotal) || 0), paid: round2(toMoney(o.paidBefore) || 0) };
}
/**
 * Still due on a wholesale sale as the Wholesale page's Outstanding list
 * computes it: payment.due, or total − received when payment.due is 0/absent.
 * @param {Object} sale
 * @returns {number}
 */
export function wholesaleOutstanding(sale) {
    if (!sale || sale.cleared) return 0;
    const p = sale.payment || {};
    const received = (p.online || 0) + (p.cash || 0);
    return p.due || ((sale.total || 0) - received);
}

/**
 * Normalised view of a bill line item across schemas: legacy bills (and some
 * wholesale lines) store `item`/`quantity`/`amount` instead of `name`/`qty`/`total`.
 * @param {Object} item
 * @returns {{name: string, qty: number, rate: number, total: number}}
 */
export function readLineItem(item) {
    if (!item || typeof item !== 'object') return { name: '', qty: 0, rate: 0, total: 0 };
    const qty = firstPresent(item.qty, item.quantity) || 0;
    const rate = firstPresent(item.rate) || 0;
    let total = firstPresent(item.total, item.amount);
    if (total === null) total = qty * rate;
    return {
        name: String(item.name || item.item || '').trim(),
        qty,
        rate: round2(rate),
        total: round2(total)
    };
}

/**
 * Purchase bill totals computed from the line items (never from on-screen text).
 * @param {Array<Object>} items - bill lines ({ total, weights })
 * @param {number} laborCharges - labour deducted from the item total (0 when Labour is unticked)
 * @param {number} [heavyWeightThreshold=30] - packets heavier than this (kg) count as heavy
 * @returns {{billTotal: number, laborCharges: number, grandTotal: number, totalPackets: number, heavyPackets: number}}
 */
export function computePurchaseTotals(items, laborCharges = 0, heavyWeightThreshold = 30) {
    const list = Array.isArray(items) ? items : [];
    const billTotal = sumMoney(list, item => readLineItem(item).total);
    let totalPackets = 0;
    let heavyPackets = 0;
    for (const item of list) {
        const weights = Array.isArray(item?.weights) ? item.weights : [];
        totalPackets += weights.length;
        heavyPackets += weights.filter(w => Number(w) > heavyWeightThreshold).length;
    }
    const labour = round2(toMoney(laborCharges) || 0);
    return { billTotal, laborCharges: labour, grandTotal: round2(billTotal - labour), totalPackets, heavyPackets };
}

/**
 * Wholesale sale total, cost (from stock average rates) and profit computed
 * from the line data.
 * @param {Array<Object>} items - sale lines ({ itemId, qty|quantity, total })
 * @param {Object} stock - AppState.stock ({ [itemId]: { rate } })
 * @param {number} [expenses=0]
 * @returns {{total: number, cost: number, profit: number, profitPercent: number}}
 */
export function computeWholesaleTotals(items, stock = {}, expenses = 0) {
    const list = Array.isArray(items) ? items : [];
    const total = sumMoney(list, item => readLineItem(item).total);
    const cost = sumMoney(list, item => {
        const rate = toMoney(stock?.[item?.itemId]?.rate);
        return rate ? rate * readLineItem(item).qty : 0;
    });
    const profit = round2(total - cost - (toMoney(expenses) || 0));
    const profitPercent = total > 0 ? Math.round((profit / total) * 1000) / 10 : 0;
    return { total, cost, profit, profitPercent };
}

/** Allowed gap (₹) between cash + online + due and the bill total. */
export const SPLIT_TOLERANCE = 1;

/**
 * Checks that cash + online + due adds up to the bill total (within ₹1).
 * @param {number} total - bill total
 * @param {{cash?: number, online?: number, due?: number}} split
 * @returns {{ok: boolean, entered: number, difference: number}} difference = total − entered
 *   (positive: amount still to allocate; negative: entered too much)
 */
export function checkPaymentSplit(total, { cash = 0, online = 0, due = 0 } = {}) {
    const entered = round2((toMoney(cash) || 0) + (toMoney(online) || 0) + (toMoney(due) || 0));
    const difference = round2((toMoney(total) || 0) - entered);
    return { ok: Math.abs(difference) <= SPLIT_TOLERANCE, entered, difference };
}

/**
 * Message for a payment split that does not match the bill total.
 * @param {{difference: number}} check - result of checkPaymentSplit
 * @param {'en'|'hi'} [lang] - defaults to the app language
 * @returns {string}
 */
export function paymentSplitMessage({ difference }, lang) {
    const amount = Math.abs(round2(difference)).toLocaleString('en-IN');
    return t(difference > 0 ? 'msg.money.split_less' : 'msg.money.split_more', { amount }, lang);
}

/** Shown when a retried save found a payment recorded on the bill since the first attempt (#70). */
export const KEPT_SERVER_PAYMENT_KEY = 'msg.money.kept_server_payment';

/** Message key for a bill with an unpaid part and no party name. */
export const NAME_REQUIRED_FOR_DUE_KEY = 'msg.money.name_required_for_due';

/**
 * Whether a bill must carry a party name: anything left due must be
 * attributable to someone.
 * @param {number} due
 * @param {string} name
 * @returns {boolean} true when the save must be blocked
 */
export function dueNeedsName(due, name) {
    return round2(due) > 0 && !String(name ?? '').trim();
}

/** Default labour charge per heavy packet (₹) and heavy-packet weight (kg). */
export const DEFAULT_LABOUR_RATE = 6;
export const DEFAULT_HEAVY_WEIGHT = 30;

/**
 * Labour settings with blank / invalid / non-positive values replaced by the
 * defaults (owner decision on #20: 6 is intended; to skip labour, untick Labour).
 * @param {{laborRate?: *, heavyWeightThreshold?: *}} [raw]
 * @returns {{laborRate: number, heavyWeightThreshold: number}}
 */
export function normalizeLabourSettings(raw = {}) {
    const positive = (v, fallback) => {
        const n = toMoney(v);
        return n !== null && n > 0 ? round2(n) : fallback;
    };
    return {
        laborRate: positive(raw?.laborRate, DEFAULT_LABOUR_RATE),
        heavyWeightThreshold: positive(raw?.heavyWeightThreshold, DEFAULT_HEAVY_WEIGHT)
    };
}

/**
 * Average price per unit, or null when the quantity is 0/invalid
 * (callers show "—" instead of Infinity/NaN).
 * @param {number} value
 * @param {number} qty
 * @returns {number|null}
 */
export function perUnitRate(value, qty) {
    const v = Number(value);
    const q = Number(qty);
    if (!Number.isFinite(v) || !Number.isFinite(q) || q <= 0) return null;
    return round2(v / q);
}
