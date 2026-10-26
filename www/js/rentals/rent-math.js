/**
 * @fileoverview Rentals (#170) pure logic: months, monthly charges, payment
 * checks, totals and the WhatsApp reminder text. No DOM, Firestore or AppState.
 * Number definitions: docs/calculations.md (RENT-1 … RENT-5).
 * @module rentals/rent-math
 */

import { round2 } from '../utils/money.js';
import { cleanText, formatINR } from '../utils/due-reminder.js';

/** Oldest start month allowed (months back) and most months charged per visit. */
export const MAX_BACKFILL_MONTHS = 24;
/** Most payment entries on one month's charge (the rules add them up without loops). */
export const MAX_PAYMENTS_PER_CHARGE = 12;
export const PROPERTY_KINDS = ['house', 'shop', 'flat', 'plot', 'godown', 'other'];
export const PAYMENT_MODES = ['cash', 'upi', 'bank', 'cheque'];
export const DEFAULT_DUE_DAY = 10;
/** Yearly rent increase the app reminds about (never applied automatically). */
export const DEFAULT_INCREASE_PCT = 5;
export const MAX_PROPERTIES = 100;
export const MAX_UNITS_PER_PROPERTY = 20;
export const MAX_RECEIPT_HEADER = 80;

/** Settings › Rentals defaults (rent_settings/default) used when they are not set. */
export const RENT_SETTINGS_DEFAULTS = Object.freeze({
    dueDay: DEFAULT_DUE_DAY, increasePct: DEFAULT_INCREASE_PCT, meterRate: null, tenantLink: false, receiptHeader: ''
});

/**
 * Rentals defaults for NEW leases; missing or invalid values fall back to the
 * defaults (existing leases keep their own values).
 * @param {*} raw rent_settings/default data
 * @returns {{dueDay: number, increasePct: number, meterRate: ?number, tenantLink: boolean, receiptHeader: string}}
 */
export function normalizeRentSettings(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
    const day = num(r.dueDay);
    const pct = num(r.increasePct);
    const rate = num(r.meterRate);
    return {
        dueDay: Number.isInteger(day) && day >= 1 && day <= 28 ? day : DEFAULT_DUE_DAY,
        increasePct: Number.isFinite(pct) && pct >= 0 && pct <= 100 ? round2(pct) : DEFAULT_INCREASE_PCT,
        meterRate: Number.isFinite(rate) && rate >= 0 ? round2(rate) : null,
        tenantLink: r.tenantLink === true,
        receiptHeader: cleanText(r.receiptHeader).slice(0, MAX_RECEIPT_HEADER)
    };
}

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
 * Months still to be charged for a lease up to `currentMonth`, oldest first:
 * from the month after `chargedThrough` (or `startMonth`) to the current or end
 * month. Charges are created one month per write, in this order (rules).
 */
export function monthsToCharge(lease, currentMonth) {
    if (!lease || lease.status !== 'active' || !isMonth(lease.startMonth) || !isMonth(currentMonth)) return [];
    const from = isMonth(lease.chargedThrough) ? addMonths(lease.chargedThrough, 1) : lease.startMonth;
    const to = isMonth(lease.endMonth) && lease.endMonth < currentMonth ? lease.endMonth : currentMonth;
    return from <= to ? monthRange(from, to) : [];
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
        rent: amount,
        electricity: null,
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
    if ((charge.payments || []).length >= MAX_PAYMENTS_PER_CHARGE) throw new Error('too_many');
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

/**
 * Yearly rent-increase reminder (RENT-6): due once 12 months have passed since
 * the rent was last set (rentSince, else the start month). Only a suggestion:
 * the new rent is saved only when someone confirms it.
 * @returns {{due: boolean, pct: number, newRent: number, from: string}}
 */
export function increaseDue(lease, month) {
    const base = isMonth(lease?.rentSince) ? lease.rentSince : lease?.startMonth;
    const pct = Number.isFinite(lease?.increasePct) ? lease.increasePct : DEFAULT_INCREASE_PCT;
    const rent = Number(lease?.rent) || 0;
    if (!isMonth(base) || !isMonth(month) || lease.status !== 'active') return { due: false, pct, newRent: rent, from: '' };
    const from = addMonths(base, 12);
    return { due: month >= from && pct > 0, pct, newRent: Math.round(rent * (1 + pct / 100)), from };
}

/**
 * Electricity from a sub-meter reading (RENT-7): units = current − previous,
 * amount = units × rate per unit.
 * @throws {Error} 'reading' when a number is missing/negative or current < previous
 */
export function meterBill({ prev, curr, rate }) {
    const p = Number(prev);
    const c = Number(curr);
    const r = Number(rate);
    if (![p, c, r].every(Number.isFinite) || p < 0 || r < 0 || c < p) throw new Error('reading');
    const units = round2(c - p);
    return { prev: p, curr: c, rate: r, units, amount: round2(units * r) };
}

/**
 * The month's charge with an electricity bill set (or replaced): amount = rent + electricity.
 * @throws {Error} 'below_paid' when more than the new amount is already paid
 */
export function applyMeter(charge, meter) {
    const rent = Number.isFinite(charge?.rent) ? charge.rent
        : round2((Number(charge?.amount) || 0) - (Number(charge?.electricity?.amount) || 0));
    const amount = round2(rent + meter.amount);
    const paid = Number(charge?.paid) || 0;
    if (paid > amount + 0.001) throw new Error('below_paid');
    return { rent, amount, open: paid < amount - 0.001 };
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

export function leaseError(l, currentMonth = '') {
    const rent = Number(l?.rent);
    const deposit = Number(l?.deposit || 0);
    if (!Number.isFinite(rent) || rent < 0 || !Number.isFinite(deposit) || deposit < 0) return 'msg.rent.bad_amount';
    if (!Number.isInteger(Number(l.dueDay)) || l.dueDay < 1 || l.dueDay > 28) return 'msg.rent.bad_due_day';
    if (!isMonth(l.startMonth)) return 'msg.rent.bad_month';
    if (isMonth(currentMonth) && (l.startMonth < addMonths(currentMonth, -(MAX_BACKFILL_MONTHS - 1)) || l.startMonth > addMonths(currentMonth, 1))) {
        return 'msg.rent.start_too_old';
    }
    const pct = Number(l.increasePct ?? DEFAULT_INCREASE_PCT);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return 'msg.rent.bad_percent';
    return '';
}

const REMINDER_TEXT = {
    en: {
        hello: (n) => (n ? `Namaste ${n} ji 🙏` : 'Namaste 🙏'),
        intro: 'This is a gentle reminder about your rent.',
        heading: '*Rent due:*',
        total: (a) => `*Total due: ${a}*`,
        pay: 'Please pay by cash or online (UPI) at your convenience.',
        upi: 'UPI',
        link: (u) => `See your rent history: ${u}`,
        thanks: 'Thank you'
    },
    hi: {
        hello: (n) => (n ? `नमस्ते ${n} जी 🙏` : 'नमस्ते 🙏'),
        intro: 'आपका किराया बाकी है, कृपया ध्यान दें।',
        heading: '*बकाया किराया:*',
        total: (a) => `*कुल बकाया: ${a}*`,
        pay: 'कृपया सुविधा अनुसार नकद या ऑनलाइन (यूपीआई) से भुगतान करें।',
        upi: 'यूपीआई',
        link: (u) => `अपने किराये का हिसाब देखें: ${u}`,
        thanks: 'धन्यवाद'
    }
};

/**
 * WhatsApp rent reminder in one language (never English and Hindi mixed):
 * the open months up to `lastMonth` (a tenant who moved out is never asked for
 * later months), oldest first, and the total.
 * @param {{tenantName: string, place?: string, charges: Array<{month: string, amount: number, paid: number}>,
 *   lastMonth?: string, upiId?: string, lang?: 'en'|'hi', link?: string}} p
 * @returns {string}
 */
export function buildRentReminderText({ tenantName, place = '', charges = [], lastMonth = '', upiId = '', lang = 'en', link = '' }) {
    const L = REMINDER_TEXT[lang === 'hi' ? 'hi' : 'en'];
    const rows = charges.filter(c => chargeDue(c) > 0 && (!isMonth(lastMonth) || c.month <= lastMonth))
        .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
    const total = round2(rows.reduce((s, c) => s + chargeDue(c), 0));
    const where = cleanText(place);
    const lines = [L.hello(cleanText(tenantName)), L.intro];
    if (where) lines.push(`🏠 ${where}`);
    lines.push('', L.heading);
    rows.forEach((c, i) => lines.push(`${i + 1}. ${monthLabel(c.month, lang)} · ${formatINR(chargeDue(c))}`));
    lines.push('', L.total(formatINR(total)), '', L.pay);
    const upi = cleanText(upiId);
    if (upi) lines.push(`${L.upi}: ${upi}`);
    if (link) lines.push('', L.link(link));
    lines.push('', L.thanks);
    return lines.join('\n');
}
