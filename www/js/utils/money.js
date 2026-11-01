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

/**
 * Labour deducted on a purchase bill (T-LAB-1, M7): `laborCharges`, older bills
 * `labour`; 0 when Labour was unticked. The only reader of a bill's labour.
 * @param {Object} bill
 * @returns {number}
 */
export function billLabour(bill) {
    const v = toMoney(bill?.laborCharges) ?? toMoney(bill?.labour);
    return round2(v || 0);
}

/**
 * Amount with Indian digit grouping and no ₹ sign ("2,50,000"), for texts whose
 * template already has the ₹. Whole rupees unless `decimals` is set;
 * `small: true` shows paise below ₹100 so ₹0.40 is not shown as ₹0.
 * @param {*} amount
 * @param {{decimals?: number, small?: boolean}} [opts]
 * @returns {string}
 */
export function formatAmount(amount, { decimals = 0, small = false } = {}) {
    const n = Number(amount);
    const v = Number.isFinite(n) ? n : 0;
    let digits = decimals;
    if (small && !decimals && Math.abs(v) < 100 && Math.abs(round2(v) - Math.round(v)) >= 0.005) digits = 2;
    const shown = digits ? round2(v) : Math.round(v);
    return (Object.is(shown, -0) ? 0 : shown).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * The app's one currency format: "₹2,50,000", "-₹500" (options as formatAmount).
 * @param {*} amount
 * @param {{decimals?: number, small?: boolean}} [opts]
 * @returns {string}
 */
export function formatRupees(amount, opts) {
    const text = formatAmount(amount, opts);
    return text.startsWith('-') ? `-₹${text.slice(1)}` : `₹${text}`;
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
 * BILL-TOTAL: bill total payable/receivable (net of labour for purchases), the
 * first of these fields that is present; a present 0 counts (labour equal to
 * the line value makes the payable ₹0).
 * @param {Object} bill
 * @returns {number}
 */
export function billTotal(bill) {
    if (!bill) return 0;
    return round2(firstPresent(bill.grandTotal, bill.amountPayable, bill.total, bill.billTotal, bill.saleTotal) || 0);
}

/**
 * BILL-LINES: what a bill's lines come to before labour ("Total" on the slip, the
 * WhatsApp text and a purchase's bill details). Purchases: `billTotal`, else
 * BILL-TOTAL + labour; sales: the first present of `billTotal`, `saleTotal`, `total`,
 * else BILL-TOTAL. A present 0 counts.
 * @param {Bill|null|undefined} bill
 * @param {boolean} isPurchase
 * @returns {number}
 */
export function billLineTotal(bill, isPurchase) {
    if (!bill) return 0;
    const saved = isPurchase ? firstPresent(bill.billTotal) : firstPresent(bill.billTotal, bill.saleTotal, bill.total);
    if (saved !== null) return round2(saved);
    return isPurchase ? round2(billTotal(bill) + billLabour(bill)) : billTotal(bill);
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
    if (!isActiveBill(bill) || bill.cleared) return 0;
    const due = readPayment(bill).due;
    return due > 0 ? due : 0;
}

/**
 * EXP-KIND: personal only when tagged personal: its `category`, or `type` on an
 * expense with no category, in any case. Anything else is business (#36).
 * @param {Object} expense
 * @returns {boolean}
 */
export function isPersonalExpense(expense) {
    return String(expense?.category || expense?.type || '').trim().toLowerCase() === 'personal';
}

/** EXP-MODE: the ways an expense can be paid (#118). */
export const EXPENSE_MODES = Object.freeze(['cash', 'online']);

/**
 * EXP-MODE: how an expense was paid. Online only when `paymentMode` is
 * "online" (any case); anything else, including every expense saved before
 * #118 (no mode), is cash.
 * @param {Object} expense
 * @returns {'cash'|'online'}
 */
export function expenseMode(expense) {
    return String(expense?.paymentMode || '').trim().toLowerCase() === 'online' ? 'online' : 'cash';
}

/**
 * EXP-MODE: the expense was paid online, so it never leaves the cash drawer.
 * @param {Object} expense
 * @returns {boolean}
 */
export function isOnlineExpense(expense) {
    return expenseMode(expense) === 'online';
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
 * Opening record carried from the old app (see isOpeningBalance). It is a
 * balance, not activity: it counts only in dues (Outstanding, aging,
 * reminders, all-time due totals, Finance receivables / payables) and never
 * in a period or activity figure (Today, Reports, Finance period, Analytics,
 * bill counts, stock, rate trends, anomaly scans, number checks).
 * @param {Object} bill
 * @returns {boolean}
 */
export function isOpeningRecord(bill) {
    return isOpeningBalance(bill);
}

/**
 * VOID (#75): the one rule for which bills count anywhere. A voided bill
 * (`voided: true`, with voidedAt / voidedBy / voidReason) stays stored so
 * History can show it, but counts in no figure: stock, dues, Today, the cash
 * drawer, Money, Insights, Statements, rate stats, month snapshots, labour.
 * FirebaseService keeps voided bills out of AppState's bill lists, and every
 * calculation that reads bills checks this too.
 * @param {Object} bill
 * @returns {boolean}
 */
export function isActiveBill(bill) {
    return !!bill && typeof bill === 'object' && bill.voided !== true;
}

/**
 * The bills of a list that count (isActiveBill).
 * @param {Array<Object>} bills
 * @returns {Array<Object>}
 */
export function activeBills(bills) {
    return (Array.isArray(bills) ? bills : []).filter(isActiveBill);
}

/**
 * Bills that count as activity: drops voided bills (isActiveBill) and opening
 * records (isOpeningRecord). Every period / activity aggregation filters its
 * bills through this.
 * @param {Array<Object>} bills
 * @returns {Array<Object>}
 */
export function activityBills(bills) {
    // Missing entries pass through as before (callers skip them); voided and opening records do not.
    return (Array.isArray(bills) ? bills : []).filter(b => (b == null || isActiveBill(b)) && !isOpeningRecord(b));
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
 * Still due on a wholesale sale as the OLD app's Wholesale page computed it:
 * payment.due, or total − received when payment.due is 0/absent. Only
 * tools/migrate uses it, to carry what that page showed; the app uses
 * outstandingDue() (BILL-DUE) everywhere.
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
 * Message for a payment split that does not match the bill total.
 * @param {{difference: number}} check - result of validatePaymentSplit (utils/calc/billing.js)
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
/** Package weight (kg) used to work out what to pay the labour (T-LAB-2), and its allowed range. */
export const DEFAULT_LABOUR_PACKAGE_KG = 35;
export const LABOUR_PACKAGE_KG_MIN = 1;
export const LABOUR_PACKAGE_KG_MAX = 200;

/**
 * Package weight within 1–200 kg; anything else (blank, invalid, out of range) is 35.
 * @param {*} v
 * @returns {number}
 */
export function normalizePackageKg(v) {
    const n = toMoney(v);
    return n !== null && n >= LABOUR_PACKAGE_KG_MIN && n <= LABOUR_PACKAGE_KG_MAX ? round2(n) : DEFAULT_LABOUR_PACKAGE_KG;
}

/**
 * Labour settings with blank / invalid / non-positive values replaced by the
 * defaults (owner decision on #20: 6 is intended; to skip labour, untick Labour).
 * @param {{laborRate?: *, heavyWeightThreshold?: *, labourPackageKg?: *}} [raw]
 * @returns {{laborRate: number, heavyWeightThreshold: number, labourPackageKg: number}}
 */
export function normalizeLabourSettings(raw = {}) {
    const positive = (v, fallback) => {
        const n = toMoney(v);
        return n !== null && n > 0 ? round2(n) : fallback;
    };
    return {
        laborRate: positive(raw?.laborRate, DEFAULT_LABOUR_RATE),
        heavyWeightThreshold: positive(raw?.heavyWeightThreshold, DEFAULT_HEAVY_WEIGHT),
        labourPackageKg: normalizePackageKg(raw?.labourPackageKg)
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
