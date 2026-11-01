/**
 * @fileoverview Deposit ledger data (#157, RENT-14): one document per tenant,
 * rent_deposits/{tenantId} {held, entries[]}. Anyone with a rentals role adds an
 * entry; only the owner edits or removes one (rules). Loaded with rent-deposit.js
 * (import() on first use). Rent and deposits never touch the Aadhat cash drawer.
 * @module rentals/rent-deposit-store
 */

import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { todayLocalISO } from '../utils/dates.js';
import { applyPayment, chargeDue, chargeId as chargeIdOf, depositEntry, depositHeld, MAX_DEPOSIT_ENTRIES } from './rent-math.js';
import { withMonth } from './rent-public.js';
import { rentCol, uid, clip, readPublic } from './rent-store.js';

const coll = (name) => FirebaseService.db.collection(rentCol(name));
const depRef = (tenantId) => coll('rent_deposits').doc(tenantId);

/** A tenant's ledger, or null when nothing was recorded yet (one read). */
export async function loadDeposit(tenantId) {
    const snap = await depRef(tenantId).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

/** Ledgers still holding money (one bounded query; Tenants › Deposits held). */
export async function depositsHeld(max = 2000) {
    const snap = await coll('rent_deposits').where('held', '>', 0).limit(max).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** In a transaction (reads): the tenant link of `leaseId`, so its page shows the new balance. */
async function linkOf(tx, leaseId) {
    if (!leaseId) return null;
    const lease = await tx.get(coll('rent_leases').doc(leaseId));
    return lease.exists ? readPublic(tx, lease.data(), true) : null;
}

/**
 * Adds one entry (transaction). An adjustment pays `chargeId` from the deposit in the same
 * write (a payment entry with mode 'deposit', no receipt), so the rules can match the two.
 * @param {{tenantId: string, tenantName: string, leaseId?: string, kind: string, amount: number,
 *   date: string, mode?: string, note?: string, chargeId?: string}} p
 * @returns {Promise<{amount: number, held: number}>}
 * @throws {Error} 'amount' | 'over' | 'too_many' | 'missing'
 */
export function addDepositEntry({ tenantId, tenantName, leaseId = '', kind, amount, date, mode = 'cash', note = '', chargeId = '' }) {
    return FirebaseService.db.runTransaction(async (tx) => {
        const ref = depRef(tenantId);
        const snap = await tx.get(ref);
        const entries = snap.exists ? snap.data().entries || [] : [];
        const chRef = kind === 'adjust' ? coll('rent_charges').doc(chargeId) : null;
        const chSnap = chRef && await tx.get(chRef);
        if (chRef && !chSnap.exists) throw new Error('missing');
        const ch = chSnap ? chSnap.data() : null;
        // The month's own link (after a change of unit, the new lease's, with the month tagged) and the current lease's.
        const pubM = ch ? await linkOf(tx, ch.leaseId) : null;
        const cur = !ch || leaseId !== ch.leaseId ? await linkOf(tx, leaseId) : null;
        const pubD = cur && cur.ref.path !== pubM?.ref.path ? cur : null;
        const next = depositEntry(entries, kind, amount, ch ? chargeDue(ch) : 0);
        const now = Date.now();
        const who = { at: now, by: uid(), byName: clip(AppState.userName, 80) };
        const e = {
            kind, amount: next.amount, date, note: clip(note, 200), ...who,
            ...(leaseId ? { leaseId } : {}), ...(ch ? { chargeId, month: ch.month } : { mode })
        };
        const doc = { tenantId, tenantName: clip(tenantName, 80), held: next.held, entries: [...entries, e], updatedAt: now, updatedBy: uid() };
        if (snap.exists) tx.update(ref, doc);
        else tx.set(ref, { ...doc, createdAt: now, createdBy: uid() });
        let month = null;
        if (ch) {
            const paid = applyPayment(ch, next.amount);
            month = { ...ch, paid: paid.paid, open: paid.open, payments: [...(ch.payments || []), { amount: next.amount, mode: 'deposit', ref: '', date, ...who }] };
            tx.update(chRef, { paid: month.paid, open: month.open, payments: month.payments, updatedAt: now, updatedBy: uid() });
        }
        if (pubM) tx.set(pubM.ref, { ...withMonth(pubM.data, month, now, pubM.old), dep: next.held, updatedAt: now });
        if (pubD) tx.set(pubD.ref, { ...pubD.data, dep: next.held, updatedAt: now });
        return next;
    });
}

/**
 * Owner: edits (`fields`: amount, date, note) or removes (`fields` null) one received / refunded entry,
 * found (when, who, kind, amount, date) in the ledger as read in the transaction (so an entry
 * added meanwhile is kept); held follows (RENT-14). Adjustments stay as they are (they paid a month).
 * @throws {Error} 'changed' (entry gone or an adjustment) | 'over' (held would go below 0) | 'missing'
 */
export function changeDepositEntry({ tenantId, leaseId = '', entry, fields = null }) {
    return FirebaseService.db.runTransaction(async (tx) => {
        const ref = depRef(tenantId);
        const snap = await tx.get(ref);
        if (!snap.exists) throw new Error('missing');
        const pub = await linkOf(tx, leaseId);
        const old = snap.data().entries || [];
        const i = old.findIndex(e => ['at', 'by', 'kind', 'amount', 'date'].every(k => e[k] === entry[k]));
        if (i < 0 || old[i].kind === 'adjust') throw new Error('changed');
        const entries = fields ? old.map((e, j) => (j === i ? { ...e, ...fields } : e)) : old.filter((_, j) => j !== i);
        const held = depositHeld(entries);
        if (held < 0) throw new Error('over');
        const now = Date.now();
        tx.update(ref, { entries, held, updatedAt: now, updatedBy: uid() });
        if (pub) tx.set(pub.ref, { ...pub.data, dep: held, updatedAt: now });
        return held;
    });
}

/**
 * RENT-16: an advance left on the last month of a lease that ended (move-out, change of unit)
 * goes into the tenant's deposit ledger ('received', mode 'advance'), to be refunded or adjusted
 * with the deposit. Same write: the month's advance becomes 0 (rules match the two).
 * `leaseId` instead of `chId`: the month the lease ended with.
 * @returns {Promise<number>} the amount moved (0 when there is none or the lease is still active)
 */
export function advanceToDeposit(chId, leaseId = '') {
    return FirebaseService.db.runTransaction(async (tx) => {
        const byLease = leaseId ? (await tx.get(coll('rent_leases').doc(leaseId))).data() : null;
        if (leaseId && byLease?.status !== 'ended') return 0;
        const chargeId = leaseId ? chargeIdOf(leaseId, byLease.endMonth) : chId;
        const chRef = coll('rent_charges').doc(chargeId);
        const ch = (await tx.get(chRef)).data();
        if (!(ch?.adv > 0)) return 0;
        const lease = byLease || (await tx.get(coll('rent_leases').doc(ch.leaseId))).data();
        if (lease?.status !== 'ended') return 0;
        const ref = depRef(ch.tenantId);
        const snap = await tx.get(ref);
        const pub = await readPublic(tx, lease, true);
        const entries = snap.exists ? snap.data().entries || [] : [];
        if (entries.length >= MAX_DEPOSIT_ENTRIES) throw new Error('too_many');
        const now = Date.now();
        const all = [...entries, {
            kind: 'received', amount: ch.adv, date: todayLocalISO(), mode: 'advance', chargeId, month: ch.month, leaseId: ch.leaseId,
            note: '', at: now, by: uid(), byName: clip(AppState.userName, 80)
        }];
        const held = depositHeld(all);
        const doc = { tenantId: ch.tenantId, tenantName: clip(snap.exists ? snap.data().tenantName : ch.tenantName, 80), held, entries: all, updatedAt: now, updatedBy: uid() };
        if (snap.exists) tx.update(ref, doc);
        else tx.set(ref, { ...doc, createdAt: now, createdBy: uid() });
        tx.update(chRef, { adv: 0, updatedAt: now, updatedBy: uid() });
        if (pub) tx.set(pub.ref, { ...withMonth(pub.data, { ...ch, adv: 0 }, now, pub.old), dep: held, updatedAt: now });
        return ch.adv;
    });
}

/** Months still carrying an advance (one bounded query; Deposits held lists those of leases that ended). */
export async function advancesLeft(max = 200) {
    const snap = await coll('rent_charges').where('adv', '>', 0).limit(max).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
