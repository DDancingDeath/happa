/**
 * @fileoverview Pure builders for reprinting / sharing a saved bill from
 * History (#136): the printer payload (bill's own date + COPY mark) and the
 * WhatsApp text in the app language. No DOM, Firestore or AppState access.
 * @module utils/bill-share
 */

import { billTotal, outstandingDue, readPayment, readLineItem } from './money.js';
import { billDateOf } from './history-filters.js';
import { t } from '../i18n/index.js';

/** "COPY" mark on a reprinted slip / shared text, in the app language. */
export const copyMark = () => t('ui.bill.copy_mark');

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * "DD/MM/YYYY hh:mm am" in device local time (IST), the receipt format.
 * @param {Date} date
 * @returns {string}
 */
export function formatReceiptDateTime(date) {
    const h = date.getHours();
    const h12 = h % 12 || 12;
    return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()} ` +
        `${pad2(h12)}:${pad2(date.getMinutes())} ${h >= 12 ? 'pm' : 'am'}`;
}

/**
 * Date/time printed on the slip: the bill's own date, `now` only when the
 * bill has no usable date (e.g. a test print).
 * @param {Object} billData
 * @param {Date} [now=new Date()]
 * @returns {string}
 */
export function receiptDateTime(billData, now = new Date()) {
    return formatReceiptDateTime(billDateOf(billData) || now);
}

/**
 * History bill type of a stored record.
 * @param {Object} bill
 * @param {string} [type] - explicit type from the caller (wins)
 * @returns {'purchase'|'retail'|'wholesale'}
 */
export function reprintType(bill, type) {
    const t = type || bill?.type;
    if (t === 'retail' || t === 'wholesale' || t === 'purchase') return t;
    return bill?.isPurchase === false ? 'retail' : 'purchase';
}

/**
 * Printer payload for reprinting a saved bill. Never mutates `bill`.
 * @param {Object} bill
 * @param {string} [type]
 * @returns {Object}
 */
export function buildReprintPayload(bill, type) {
    const kind = reprintType(bill, type);
    const pay = readPayment(bill);
    const due = outstandingDue(bill);
    const items = (bill?.items || []).map(item => {
        const line = readLineItem(item);
        return { ...item, name: line.name, qty: line.qty, rate: line.rate, total: line.total };
    });
    const payload = {
        ...bill,
        items,
        type: kind,
        isPurchase: kind === 'purchase',
        isCopy: true,
        payment: { ...(bill?.payment || {}), cash: pay.cash, online: pay.online, due },
        dueAmount: due
    };
    if (kind === 'wholesale') {
        const total = billTotal(bill);
        Object.assign(payload, { total, saleTotal: total, grandTotal: total, amountPayable: total });
    }
    return payload;
}

const TITLES = {
    purchase: 'ui.bill.title_purchase',
    retail: 'ui.bill.title_retail',
    wholesale: 'ui.bill.title_wholesale'
};

const money = (n) => `₹${Math.round(Number(n) || 0)}`;

/**
 * WhatsApp text for a saved bill, in the app language, dated with the bill's own date.
 * Internal figures (expenses, profit, who created it) are never included.
 * @param {Object} bill
 * @param {string} [type]
 * @param {{copy?: boolean}} [opts]
 * @returns {string}
 */
export function buildBillShareText(bill, type, { copy = true } = {}) {
    const p = buildReprintPayload(bill, type);
    const kind = p.type;
    const date = billDateOf(bill);
    const lines = [`*${t(TITLES[kind])}*${copy ? ` (${copyMark()})` : ''}`, ''];
    if (p.billNumber) lines.push(`${t('ui.bill.bill_no')}: #${p.billNumber}`);
    if (date) lines.push(`${t('ui.bill.date')}: ${formatReceiptDateTime(date)}`);
    if (p.customerName) lines.push(`${t('ui.bill.customer')}: ${p.customerName}`);
    if (p.printComments && String(p.comments || '').trim()) lines.push(`${t('ui.bill.note')}: ${String(p.comments).trim()}`);
    lines.push('', `*${t('ui.bill.items')}:*`);
    p.items.forEach(item => {
        lines.push(item.name);
        lines.push(`  ${money(item.rate)} × ${Number(item.qty || 0).toFixed(1)}kg = ${money(item.total)}`);
    });
    lines.push('');

    if (kind === 'purchase') {
        const subtotal = p.billTotal || p.grandTotal || p.amountPayable || p.total || 0;
        const labor = Number(p.laborCharges) || 0;
        const payable = billTotal(p) || (subtotal - labor);
        lines.push(`*${t('ui.bill.total')}: ${money(subtotal)}*`);
        if (labor > 0) {
            lines.push(`${t('ui.bill.labour')}: ${money(labor)}`);
            lines.push(`*${t('ui.bill.payable')}: ${money(payable)}*`);
        }
    } else {
        lines.push(`*${t('ui.bill.total')}: ${money(billTotal(p))}*`);
    }
    const paid = p.payment.cash + p.payment.online;
    if (paid > 0) lines.push(`${t(kind === 'purchase' ? 'ui.bill.paid' : 'ui.bill.received')}: ${money(paid)}`);
    if (p.payment.due > 0) lines.push(`${t('ui.bill.due')}: ${money(p.payment.due)}`);
    return lines.join('\n');
}

const fixed2 = (n) => (Number(n) || 0).toFixed(2);

/**
 * WhatsApp text for a bill still being entered (Billing / Sales "Share" before saving), in the app language.
 * @param {Object} draft
 * @param {'purchase'|'retail'|'wholesale'} draft.kind
 * @param {string} [draft.customer]
 * @param {Date} [draft.date]
 * @param {string} [draft.note]
 * @param {Array<{name: string, rate: number, qty: number, total: number}>} draft.items
 * @param {number} draft.total
 * @param {number} [draft.labour] - purchase only
 * @param {number} [draft.expenses] - wholesale only
 * @param {number} [draft.profit] - wholesale only
 * @returns {string}
 */
export function buildDraftShareText({ kind, customer, date = new Date(), note, items = [], total, labour = 0, expenses = 0, profit = 0 }) {
    const lines = [`*${t(TITLES[kind] || TITLES.retail)}*`, ''];
    lines.push(`${t('ui.bill.customer')}: ${customer || t('ui.bill.customer_default')}`);
    lines.push(`${t('ui.bill.date')}: ${date.toLocaleDateString('en-IN')}`);
    if (note) lines.push(`${t('ui.bill.note')}: ${note}`);
    lines.push('', `*${t('ui.bill.items')}:*`);
    items.forEach(item => {
        lines.push(item.name);
        lines.push(`  ${t('ui.bill.rate')}: ₹${fixed2(item.rate)} × ${fixed2(item.qty)}kg = ₹${fixed2(item.total)}`);
    });
    lines.push('', `*${t('ui.bill.total')}: ${money(total)}*`);
    if (kind === 'purchase' && labour > 0) {
        lines.push(`${t('ui.bill.labour')}: ${money(labour)}`);
        lines.push(`*${t('ui.bill.payable')}: ${money(total - labour)}*`);
    }
    if (kind === 'wholesale' && expenses > 0) lines.push(`${t('ui.bill.expenses')}: ${money(expenses)}`);
    if (kind === 'wholesale' && profit !== 0) lines.push(`${t('ui.bill.profit')}: ${money(profit)}`);
    return lines.join('\n');
}
