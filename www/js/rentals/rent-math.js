/**
 * @fileoverview Rentals (#170) pure logic: months, monthly charges, payment
 * checks, totals, pro-rating, form checks and the WhatsApp reminder text. No DOM,
 * Firestore or AppState. Number definitions: docs/calculations.md (RENT-*).
 * @module rentals/rent-math
 */

import { round2 } from '../utils/money.js';
import { meterAmount, validateDuePayment, entryAmount } from '../utils/calc/billing.js';
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
export const MAX_RECEIPT_ADDRESS = 200;

/** Settings › Rentals defaults (rent_settings/default) used when they are not set. */
export const RENT_SETTINGS_DEFAULTS = Object.freeze({
    dueDay: DEFAULT_DUE_DAY, increasePct: DEFAULT_INCREASE_PCT, meterRate: null, tenantLink: false, receiptHeader: '', receiptAddress: ''
});

/**
 * Rentals defaults for NEW leases; missing or invalid values fall back to the
 * defaults (existing leases keep their own values).
 * @param {*} raw rent_settings/default data
 * @returns {{dueDay: number, increasePct: number, meterRate: ?number, tenantLink: boolean, receiptHeader: string, receiptAddress: string}}
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
        receiptHeader: cleanText(r.receiptHeader).slice(0, MAX_RECEIPT_HEADER),
        receiptAddress: cleanText(r.receiptAddress).slice(0, MAX_RECEIPT_ADDRESS)
    };
}

/** Electricity per lease: included in rent / sub-meter billed by us / tenant's own meter. */
export const ELEC_MODES = ['included', 'meter', 'own'];

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HI_MONTHS = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];
const pad2 = (n) => String(n).padStart(2, '0');

export const isMonth = (key) => typeof key === 'string' && MONTH_RE.test(key);

const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** A real calendar date 'YYYY-MM-DD'. */
export function isDate(v) {
    const m = typeof v === 'string' && DATE_RE.exec(v);
    if (!m) return false;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

/** 'DD/MM/YYYY' for 'YYYY-MM-DD' ('' otherwise). */
export function dateLabel(v) {
    return isDate(v) ? v.split('-').reverse().join('/') : '';
}

/** Electricity mode of a lease; leases saved before modes existed bill by meter. */
export const elecMode = (lease) => (ELEC_MODES.includes(lease?.elecMode) ? lease.elecMode : 'meter');

/**
 * 10-digit Indian mobile from what was typed ("+91 98765 43210", "098765 43210"),
 * or '' when it isn't one.
 */
export function mobile10(v) {
    let d = String(v ?? '').replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    return /^[6-9]\d{9}$/.test(d) ? d : '';
}

const daysIn = (y, m) => new Date(y, m, 0).getDate();

/** RENT-11, RENT-13: rent × days ÷ the days it is for, rounded to the rupee. */
export const proRateRent = (rent, days, of) => Math.round(rent * days / of);

/**
 * RENT-11: first month's rent. Full rent by default (the usual practice); with
 * "pro-rate first month", rent × days from the start date to the month's end ÷
 * days in that month, rounded to the rupee.
 */
export function firstMonthRent(rent, startDate, proRate) {
    const r = round2(Number(rent) || 0);
    if (!proRate || !isDate(startDate)) return r;
    const [y, m, d] = startDate.split('-').map(Number);
    const days = daysIn(y, m);
    return proRateRent(r, days - d + 1, days);
}

/** RENT-13: old unit's move month = full × (move day − s) ÷ (days in month − s + 1); s = 1, or a pro-rated first month's start day. */
export function moveMonthRent(full, lease, month, moveDate) {
    const s = month === lease?.startMonth && lease?.firstRent != null && isDate(lease.startDate) ? Number(lease.startDate.slice(8)) : 1;
    const [y, m, d] = moveDate.split('-').map(Number);
    return Math.max(0, proRateRent(Number(full) || 0, d - s, daysIn(y, m) - s + 1));
}

/** RENT-13: old month `ch` at rent `rent`; more than rent + electricity paid closes it at what is paid (capped), fully paid stays (kept). */
export function oldMonth(ch, rent) {
    const e = Number(ch?.electricity?.amount) || 0;
    const paid = Number(ch?.paid) || 0;
    const over = paid > rent + e + 0.001;
    const r = over ? round2(paid - e) : rent;
    const amount = round2(r + e);
    return { rent: r, amount, open: paid < amount - 0.001, capped: over && r < ch.rent, kept: over && r >= ch.rent };
}

/** RENT-13, move on `date`: old unit's last month, its charge, full rent and share (null on the 1st) till oldEnd; new unit's first month. */
export function moveMonthSplit(from, charges, date, rent) {
    const month = date.slice(0, 7);
    const prev = addMonths(month, -1);
    const endMonth = date.endsWith('-01') && prev >= from.startMonth ? prev : month;
    const ch = charges.find(x => x.leaseId === from.id && x.month === month);
    const full = Number.isFinite(ch?.rent) ? ch.rent : month === from.startMonth && from.firstRent != null ? from.firstRent : from.rent;
    const old = endMonth === month ? moveMonthRent(full, from, month, date) : null;
    return { month, endMonth, ch, full, old, oldEnd: `${month}-${pad2(Number(date.slice(8)) - 1)}`, next: firstMonthRent(rent, date, true) };
}

/** Change of unit (RENT-13): {error}, or split s, firstRent, oldRent ('auto': worked out when saved; null: full) and paidOld. Members: worked-out amounts. */
export function changeUnitPlan(from, charges, lease, { mgr = false, on = true, typed = {} } = {}) {
    const s = moveMonthSplit(from, charges, lease.startDate, lease.rent);
    if (!mgr && from.chargedThrough > addMonths(s.endMonth, 1)) return { error: 'msg.rent.change_backdate' };
    if (!on) return { s, oldRent: null, paidOld: null };
    const next = mgr ? Number(typed.next) : s.next;
    const old = s.old === null ? null : mgr ? Number(typed.old) : s.old;
    if (!Number.isFinite(next) || next < 0 || next > lease.rent || (old !== null && !(old >= 0 && old <= s.full))) return { error: 'msg.rent.bad_split' };
    return { s, firstRent: round2(next), oldRent: old === null ? null : old === s.old ? 'auto' : round2(old), paidOld: old !== null && s.ch ? oldMonth(s.ch, old) : null };
}

/** A change of unit keeps the old lease's due day, yearly %, deposit and electricity mode. */
export const keptTerms = (l, defs) => ({ defs: { ...defs, dueDay: l.dueDay, increasePct: l.increasePct ?? defs.increasePct }, deposit: l.deposit || 0, elec: elecMode(l) });

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

/** 'R-2026-0001': the business's receipt sequence of that year (RENT-12). */
export const receiptNo = (year, seq) => `R-${year}-${String(seq).padStart(4, '0')}`;

/** This year in India (IST); receipt numbers restart each year. */
export const istYear = (now = Date.now()) => new Date(now + 330 * 60000).getUTCFullYear();

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
    const first = month === lease.startMonth && Number.isFinite(lease.firstRent);
    const amount = round2(Number(first ? lease.firstRent : lease.rent) || 0);
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

/** RENT-1 … RENT-4: Σ amount (expected), Σ paid (collected) of `month`'s charges, pending, Σ due up to `month` (of all without one). */
export function rentTotals(charges, month = '') {
    let expected = 0; let collected = 0; let due = 0;
    for (const c of charges) {
        if (c.month === month) {
            expected += Number(c.amount) || 0;
            collected += Number(c.paid) || 0;
        }
        if (!month || c.month <= month) due += chargeDue(c);
    }
    return { expected: round2(expected), collected: round2(collected), pending: round2(Math.max(0, expected - collected)), due: round2(due) };
}

/** RENT-12: receipt amounts of payment `e` on charge `ch` as written (balance = due after it; adv = RENT-16 carried). */
export const receiptAmounts = (ch, e) => ({ months: [ch.month], rent: ch.rent, elec: ch.electricity || null, total: ch.amount, paid: e.amount, balance: chargeDue(ch), ...(e.adv > 0 ? { adv: e.adv } : {}) });

/** RENT-12, RENT-16: received with a receipt = paid for the month + advance carried. */
export const receiptReceived = (r) => round2((Number(r.paid) || 0) + (Number(r.adv) || 0));

/** RENT-12: paid before this payment = total − paid now − balance (never below 0). */
export const paidEarlier = (r) => Math.max(0, round2((Number(r.total) || 0) - (Number(r.paid) || 0) - (Number(r.balance) || 0)));

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
 * Validates a payment against a charge and returns the new totals. Whole
 * rupees, except exactly a due with paise (DUE-CHECK, #129). RENT-16, `advance`
 * (the lease's latest month): more than is due pays the month off and the rest
 * (adv) is carried to the next month; `carried` = the month's advance after it (both only then).
 * @throws {Error} message 'amount' (not > 0) or 'over' (more than is due)
 */
export function applyPayment(charge, amount, advance = false) {
    const due = chargeDue(charge);
    const check = validateDuePayment(amount, 0, due, 0.001);
    if (!check.ok && check.error !== 'exceeds-due') throw new Error('amount');
    if ((charge.payments || []).length >= MAX_PAYMENTS_PER_CHARGE) throw new Error('too_many');
    if (!check.ok && !(advance && due > 0)) throw new Error('over');
    const amt = check.ok ? check.total : due;
    const adv = check.ok ? 0 : round2(entryAmount(amount) - due);
    const total = round2(Number(charge.amount) || 0);
    const paid = round2((Number(charge.paid) || 0) + amt);
    return { amount: amt, paid, open: paid < total - 0.001, ...(adv > 0 ? { adv, carried: round2((Number(charge.adv) || 0) + adv) } : {}) };
}

/**
 * RENT-16: a new month's charge starts paid from the advance carried on the month before
 * (at most its amount; a payment with mode 'advance', no receipt); the rest is carried on.
 */
export function withAdvance(charge, adv, entry) {
    const a = round2(Number(adv) || 0);
    if (!(a > 0)) return charge;
    const paid = Math.min(a, charge.amount);
    const left = round2(a - paid);
    return { ...charge, paid, open: paid < charge.amount - 0.001, payments: paid > 0 ? [{ ...entry, amount: paid, mode: 'advance' }] : [], ...(left > 0 ? { adv: left } : {}) };
}

/** Deposit ledger (RENT-14): received from the tenant, adjusted against a month's rent, refunded. */
export const DEPOSIT_KINDS = ['received', 'adjust', 'refund'];
export const MAX_DEPOSIT_ENTRIES = 24;

/** RENT-14: deposit held = Σ received − Σ adjusted − Σ refunded. */
export function depositHeld(entries) {
    let s = 0;
    for (const e of entries || []) s += (e.kind === 'received' ? 1 : -1) * (Number(e.amount) || 0);
    return round2(s);
}

/**
 * RENT-14: a new entry's amount and the deposit held after it. Whole rupees, except exactly a due
 * with paise (adjust, as RENT-5's applyPayment) or exactly a held with paise (refund). Adjusted ≤ the
 * month's due and ≤ held; refunded ≤ held.
 * @throws {Error} 'amount' | 'over' | 'too_many'
 */
export function depositEntry(entries, kind, amount, due = 0) {
    if ((entries || []).length >= MAX_DEPOSIT_ENTRIES) throw new Error('too_many');
    const held = depositHeld(entries);
    const c = kind === 'received' ? { ok: true, total: entryAmount(amount) } : validateDuePayment(amount, 0, kind === 'adjust' ? due : held, 0.001);
    if (!DEPOSIT_KINDS.includes(kind) || (!c.ok && c.error !== 'exceeds-due') || !(c.total > 0 || !c.ok)) throw new Error('amount');
    if (!c.ok || (kind !== 'received' && c.total > held + 0.001)) throw new Error('over');
    return { amount: c.total, held: round2(held + (kind === 'received' ? c.total : -c.total)) };
}

/** RENT-15: Σ deposit held over the tenants' ledgers. */
export const depositsTotal = (ledgers) => depositHeld((ledgers || []).map(l => ({ kind: 'received', amount: l.held })));

/** RENT-14: amount filled in: received = the agreed deposit while nothing is held; refund = all held; adjust = the due, else held in whole rupees. */
export const depositFill = (kind, held, due = 0, agreed = 0) => (kind === 'received' ? (held > 0 ? '' : agreed || '') : kind === 'refund' ? held : due <= held ? due : Math.floor(held));

/** Open charges of one lease, oldest first, and their total (RENT-5). */
export function leaseDues(charges, leaseId) {
    const open = charges.filter(c => c.leaseId === leaseId && chargeDue(c) > 0)
        .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
    return { charges: open, total: rentTotals(open).due };
}

/**
 * Yearly rent-increase reminder (RENT-6): due once 12 months have passed since
 * the rent was last set (rentSince, else the start month). Only a suggestion:
 * the new rent is saved only when someone confirms it.
 * @returns {{due: boolean, pct: number, newRent: number, from: string}}
 */
export function increaseDue(lease, month, today = new Date()) {
    const pct = Number.isFinite(lease?.increasePct) ? lease.increasePct : DEFAULT_INCREASE_PCT;
    const rent = Number(lease?.rent) || 0;
    const newRent = Math.round(rent * (1 + pct / 100));
    const off = { due: false, pct, newRent: rent, from: '' };
    if (!lease || lease.status !== 'active' || !isMonth(month)) return off;
    // Rent changed since move-in: a year from that month. Otherwise a year from the start date.
    if (isMonth(lease.rentSince) && isMonth(lease.startMonth) && lease.rentSince > lease.startMonth) {
        const from = addMonths(lease.rentSince, 12);
        return { due: month >= from && pct > 0, pct, newRent, from };
    }
    if (isDate(lease.startDate)) {
        const [y, m, d] = lease.startDate.split('-').map(Number);
        const anniversary = new Date(y + 1, m - 1, d);
        const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        return { due: start >= anniversary && pct > 0, pct, newRent, from: monthKey(anniversary) };
    }
    const base = isMonth(lease.rentSince) ? lease.rentSince : lease.startMonth;
    if (!isMonth(base)) return off;
    const from = addMonths(base, 12);
    return { due: month >= from && pct > 0, pct, newRent, from };
}

const okNum = (v) => Number.isFinite(v) && v >= 0;

/**
 * Electricity from a sub-meter reading (RENT-7): units = current − previous,
 * amount = units × rate per unit, whole rupees (#129).
 * @throws {Error} 'reading' when a number is missing/negative or current < previous
 */
export function meterBill({ prev, curr, rate }) {
    const p = Number(prev);
    const c = Number(curr);
    const r = Number(rate);
    if (![p, c, r].every(okNum) || c < p) throw new Error('reading');
    const units = round2(c - p);
    return { prev: p, curr: c, rate: r, units, amount: meterAmount(units, r) };
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
    if (!mobile10(tn.phone)) return 'msg.rent.bad_phone';
    if (tn.phone2 && !mobile10(tn.phone2)) return 'msg.rent.bad_phone';
    if (String(tn.name).length > 80 || String(tn.phone || '').length > 20) return 'msg.rent.too_long';
    return '';
}

export function leaseError(l, currentMonth = '') {
    const rent = Number(l?.rent);
    const deposit = Number(l?.deposit || 0);
    if (!Number.isFinite(rent) || rent < 0 || !Number.isFinite(deposit) || deposit < 0) return 'msg.rent.bad_amount';
    if (!Number.isInteger(Number(l.dueDay)) || l.dueDay < 1 || l.dueDay > 28) return 'msg.rent.bad_due_day';
    if (l.startDate !== undefined && (!isDate(l.startDate) || l.startDate.slice(0, 7) !== l.startMonth)) return 'msg.rent.bad_date';
    if (!isMonth(l.startMonth)) return 'msg.rent.bad_month';
    if (l.elecMode !== undefined && !ELEC_MODES.includes(l.elecMode)) return 'msg.rent.bad_elec_mode';
    if (isMonth(currentMonth) && (l.startMonth < addMonths(currentMonth, -(MAX_BACKFILL_MONTHS - 1)) || l.startMonth > addMonths(currentMonth, 1))) {
        return 'msg.rent.start_too_old';
    }
    const pct = Number(l.increasePct ?? DEFAULT_INCREASE_PCT);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return 'msg.rent.bad_percent';
    return '';
}

/** Error key for a move-in ('' when fine): lease, opening meter {reading, rate} (or null) and a start not before `earliest` (when set). */
export const moveInError = (lease, meter, currentMonth, earliest = '') => leaseError(lease, currentMonth)
    || (earliest && lease.startDate < earliest ? 'msg.rent.move_date_window' : '')
    || (meter && ![meter.reading, meter.rate].every(v => v === null || okNum(v)) ? 'msg.rent.bad_reading' : '');

const REMINDER_TEXT = {
    en: {
        hello: (n) => (n ? `Namaste ${n} ji 🙏` : 'Namaste 🙏'),
        intro: 'This is a gentle reminder about your rent.',
        heading: '*Rent due:*',
        total: (a) => `*Total due: ${a}*`,
        pay: 'Please pay by cash or online (UPI) at your convenience.',
        upi: 'UPI',
        link: (u) => `See your rent history: ${u}`,
        since: (d) => `Tenant since ${d}`,
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
        since: (d) => `${d} से किरायेदार`,
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
export function buildRentReminderText({ tenantName, place = '', charges = [], lastMonth = '', upiId = '', lang = 'en', link = '', since = '' }) {
    const L = REMINDER_TEXT[lang === 'hi' ? 'hi' : 'en'];
    const rows = charges.filter(c => chargeDue(c) > 0 && (!isMonth(lastMonth) || c.month <= lastMonth))
        .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
    const total = rentTotals(rows).due;
    const where = cleanText(place);
    const lines = [L.hello(cleanText(tenantName)), L.intro];
    if (where) lines.push(`🏠 ${where}`);
    if (isDate(since)) lines.push(L.since(dateLabel(since)));
    lines.push('', L.heading);
    rows.forEach((c, i) => lines.push(`${i + 1}. ${monthLabel(c.month, lang)} · ${formatINR(chargeDue(c))}`));
    lines.push('', L.total(formatINR(total)), '', L.pay);
    const upi = cleanText(upiId);
    if (upi) lines.push(`${L.upi}: ${upi}`);
    if (link) lines.push('', L.link(link));
    lines.push('', L.thanks);
    return lines.join('\n');
}
