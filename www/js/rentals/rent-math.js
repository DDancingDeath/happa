/**
 * @fileoverview Rentals (#170) pure logic: months, monthly charges, payment
 * checks, totals and the WhatsApp reminder text. No DOM, Firestore or AppState.
 * Number definitions: docs/calculations.md (RENT-1 … RENT-5).
 * @module rentals/rent-math
 */

import { round2 } from '../utils/money.js';
import { cleanText, formatINR } from '../utils/due-reminder.js';

/** Most months created for one lease in one go (start month far in the past). */
export const MAX_BACKFILL_MONTHS = 24;
export const PROPERTY_KINDS = ['house', 'shop', 'flat', 'plot', 'godown', 'other'];
export const PAYMENT_MODES = ['cash', 'upi', 'bank', 'cheque'];
export const DEFAULT_DUE_DAY = 5;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HI_MONTHS = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];
const pad2 = (n) => String(n).padStart(2, '0');

export const isMonth = (key) => typeof key === 'string' && MONTH_RE.test(key);

/** 'YYYY-MM' of a date in local time. */
export function monthKey(date = new Date()) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

export function addMonths(key, n) {
    const [y, m] = key.split('-').map(Number);
    const idx = y * 12 + (m - 1) + n;
    return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`;
}

/** Inclusive list of months from `from` to `to` ([] when from > to). */
export function monthRange(from, to) {
    const out = [];
    for (let k = from; k <= to; k = addMonths(k, 1)) out.push(k);
    return out;
}

/** 'Oct 2026' / 'अक्टूबर 2026'. */
export function monthLabel(key, lang = 'en') {
    if (!isMonth(key)) return String(key ?? '');
    const [y, m] = key.split('-').map(Number);
    return `${(lang === 'hi' ? HI_MONTHS : EN_MONTHS)[m - 1]} ${y}`;
}

export const chargeId = (leaseId, month) => `${leaseId}_${month}`;

/**
 * Months still to be charged for a lease up to `currentMonth`: from the month
 * after `chargedThrough` (or `startMonth`) to the current or end month, at most
 * MAX_BACKFILL_MONTHS (the newest ones).
 */
export function monthsToCharge(lease, currentMonth) {
    if (!lease || lease.status !== 'active' || !isMonth(lease.startMonth) || !isMonth(currentMonth)) return [];
    const from = isMonth(lease.chargedThrough) ? addMonths(lease.chargedThrough, 1) : lease.startMonth;
    const to = isMonth(lease.endMonth) && lease.endMonth < currentMonth ? lease.endMonth : currentMonth;
    const months = from <= to ? monthRange(from, to) : [];
    return months.slice(-MAX_BACKFILL_MONTHS);
}

/** New charge document for one month of a lease. */
export function newCharge(lease, month, { tenantName = '', unitLabel = '', now = Date.now() } = {}) {
    const amount = round2(Number(lease.rent) || 0);
    return {
        leaseId: lease.id,
        unitId: lease.unitId,
        propertyId: lease.propertyId,
        tenantId: lease.tenantId,
        tenantName: String(tenantName).slice(0, 80),
        unitLabel: String(unitLabel).slice(0, 60),
        month,
        dueDay: lease.dueDay,
        amount,
        paid: 0,
        open: amount > 0,
        payments: [],
        createdAt: now,
        updatedAt: now
    };
}

export const chargeDue = (c) => Math.max(0, round2((Number(c?.amount) || 0) - (Number(c?.paid) || 0)));

/** Local date the month's rent falls due. */
export function dueDate(month, dueDay = DEFAULT_DUE_DAY) {
    const [y, m] = month.split('-').map(Number);
    return new Date(y, m - 1, Math.min(Math.max(Number(dueDay) || DEFAULT_DUE_DAY, 1), 28));
}

/** 'paid' | 'partial' | 'due', and whether it is past its due day (RENT-5). */
export function chargeStatus(charge, today = new Date()) {
    const due = chargeDue(charge);
    const status = due <= 0 ? 'paid' : (Number(charge.paid) || 0) > 0 ? 'partial' : 'due';
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const late = status !== 'paid' && isMonth(charge.month) && start > dueDate(charge.month, charge.dueDay);
    return { status, late, due };
}

/**
 * Validates a payment against a charge and returns the new totals.
 * @throws {Error} message 'amount' (not > 0) or 'over' (more than is due)
 */
export function applyPayment(charge, amount) {
    const amt = round2(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount');
    if (amt > chargeDue(charge) + 0.001) throw new Error('over');
    const total = round2(Number(charge.amount) || 0);
    const paid = round2((Number(charge.paid) || 0) + amt);
    return { amount: amt, paid, open: paid < total - 0.001 };
}

/**
 * RENT-1 … RENT-4 for `month` over the loaded charges.
 * @returns {{expected: number, collected: number, pending: number, outstanding: number}}
 */
export function monthSummary(charges, month) {
    let expected = 0;
    let collected = 0;
    let outstanding = 0;
    for (const c of charges) {
        if (c.month === month) {
            expected += Number(c.amount) || 0;
            collected += Number(c.paid) || 0;
        }
        if (c.month <= month) outstanding += chargeDue(c);
    }
    return {
        expected: round2(expected),
        collected: round2(collected),
        pending: round2(Math.max(0, expected - collected)),
        outstanding: round2(outstanding)
    };
}

/** Open charges of one lease, oldest first, and their total (RENT-5). */
export function leaseDues(charges, leaseId) {
    const open = charges.filter(c => c.leaseId === leaseId && chargeDue(c) > 0)
        .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
    return { charges: open, total: round2(open.reduce((s, c) => s + chargeDue(c), 0)) };
}

/** Error key (msg.rent.*) for a property form, or ''. */
export function propertyError(p) {
    if (!cleanText(p?.name)) return 'msg.rent.name_required';
    if (String(p.name).length > 80 || String(p.address || '').length > 200) return 'msg.rent.too_long';
    return '';
}

export function unitError(u) {
    if (!cleanText(u?.label)) return 'msg.rent.name_required';
    if (String(u.label).length > 60) return 'msg.rent.too_long';
    const rent = Number(u.rent);
    if (!Number.isFinite(rent) || rent < 0) return 'msg.rent.bad_amount';
    return '';
}

export function tenantError(tn) {
    if (!cleanText(tn?.name)) return 'msg.rent.name_required';
    if (String(tn.name).length > 80 || String(tn.phone || '').length > 20) return 'msg.rent.too_long';
    return '';
}

export function leaseError(l) {
    const rent = Number(l?.rent);
    const deposit = Number(l?.deposit || 0);
    if (!Number.isFinite(rent) || rent < 0 || !Number.isFinite(deposit) || deposit < 0) return 'msg.rent.bad_amount';
    if (!Number.isInteger(Number(l.dueDay)) || l.dueDay < 1 || l.dueDay > 28) return 'msg.rent.bad_due_day';
    if (!isMonth(l.startMonth)) return 'msg.rent.bad_month';
    return '';
}

/**
 * Bilingual WhatsApp rent reminder: the open months oldest first and the total.
 * @param {{tenantName: string, place?: string, charges: Array<{month: string, amount: number, paid: number}>, upiId?: string}} p
 * @returns {string}
 */
export function buildRentReminderText({ tenantName, place = '', charges = [], upiId = '' }) {
    const name = cleanText(tenantName);
    const where = cleanText(place);
    const rows = charges.filter(c => chargeDue(c) > 0);
    const total = round2(rows.reduce((s, c) => s + chargeDue(c), 0));
    const lines = [name ? `Namaste ${name} ji / नमस्ते ${name} जी 🙏` : 'Namaste / नमस्ते 🙏'];
    lines.push('This is a gentle reminder about your rent.');
    lines.push('आपका किराया बाकी है, कृपया ध्यान दें।');
    if (where) lines.push(`🏠 ${where}`);
    lines.push('', '*Rent due / बकाया किराया:*');
    rows.forEach((c, i) => {
        lines.push(`${i + 1}. ${monthLabel(c.month)} / ${monthLabel(c.month, 'hi')} · ${formatINR(chargeDue(c))}`);
    });
    lines.push('', `*Total due / कुल बकाया: ${formatINR(total)}*`, '');
    lines.push('Please pay by cash or online (UPI) at your convenience.');
    lines.push('कृपया सुविधा अनुसार नकद या ऑनलाइन (UPI) से भुगतान करें।');
    const upi = cleanText(upiId);
    if (upi) lines.push(`UPI: ${upi}`);
    lines.push('', 'Thank you / धन्यवाद');
    return lines.join('\n');
}
