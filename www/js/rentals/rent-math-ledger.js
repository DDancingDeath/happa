/**
 * @fileoverview Rentals (#157) maths used only by screens loaded on use: the
 * deposit ledger (RENT-14 / RENT-15), the expense form (RENT-17), the receipt's
 * amounts (RENT-12 / RENT-16) and the change of unit's move month (RENT-13, RENT-16). Pure (no DOM, Firestore or
 * AppState); not precached (LAZY_ASSETS), imported only by the lazy rentals files.
 * Number definitions: docs/calculations.md.
 * @module rentals/rent-math-ledger
 */

import { round2 } from '../utils/money.js';
import { validateDuePayment, entryAmount } from '../utils/calc/billing.js';
import {
    PAYMENT_MODES, isDate, daysIn, proRateRent, firstMonthRent, addMonths, elecMode, addAdvance, advanceBack
} from './rent-math.js';

const pad2 = (n) => String(n).padStart(2, '0');

/** RENT-12, RENT-16: received with a receipt = paid for the month + advance carried. */
export const receiptReceived = (r) => round2((Number(r.paid) || 0) + (Number(r.adv) || 0));

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

/** Property expenses (RENT-17): what was paid for a property or one of its units. Never Aadhat cash. */
export const EXPENSE_CATEGORIES = ['repairs', 'tax', 'maintenance', 'insurance', 'broker', 'other'];

/** Error key for an expense form ('' when fine): a category, a whole-rupee amount > 0, a real date. */
export function expenseError(e) {
    if (!EXPENSE_CATEGORIES.includes(e?.category) || !PAYMENT_MODES.includes(e.mode)) return 'msg.rent.bad_amount';
    if (!(entryAmount(e.amount) > 0)) return 'msg.rent.bad_amount';
    return isDate(e.date) ? '' : 'msg.rent.bad_date';
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

/** RENT-12: paid before this payment = total − paid now − balance (never below 0). */
export const paidEarlier = (r) => Math.max(0, round2((Number(r.total) || 0) - (Number(r.paid) || 0) - (Number(r.balance) || 0)));

/** RENT-16: the advance a lease ending with `endMonth` leaves (its last month's, plus one later month given back). */
export function advanceLeft(charges, leaseId, endMonth) {
    const mine = charges.filter(c => c.leaseId === leaseId);
    return addAdvance(mine.find(c => c.month === endMonth)?.adv, advanceBack(mine.filter(c => c.month > endMonth)));
}
