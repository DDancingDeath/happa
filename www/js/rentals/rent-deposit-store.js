/**
 * @fileoverview Deposit ledger data (#157, RENT-14): one document per tenant,
 * rent_deposits/{tenantId} {held, entries[]}. Anyone with a rentals role adds an
 * entry; only the owner edits or removes one (rules). Loaded with rent-deposit.js
 * (import() on first use). Rent and deposits never touch the Aadhat cash drawer.
 * @module rentals/rent-deposit-store
 */

import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { applyPayment, chargeDue, depositEntry, depositHeld, MAX_DEPOSIT_ENTRIES } from './rent-math.js';
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
        const pub = await linkOf(tx, leaseId || ch?.leaseId);
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
        if (pub) tx.set(pub.ref, { ...(month ? withMonth(pub.data, month, now, pub.old) : pub.data), dep: next.held, updatedAt: now });
        return next;
    });
}

/**
 * Owner: replaces the entries (an entry edited or removed); held follows (RENT-14).
 * Adjustments are kept as they are (they paid a month).
 * @throws {Error} 'over' (held would go below 0) | 'too_many'
 */
export function setDepositEntries({ tenantId, leaseId = '', entries }) {
    return FirebaseService.db.runTransaction(async (tx) => {
        const ref = depRef(tenantId);
        const snap = await tx.get(ref);
        if (!snap.exists) throw new Error('missing');
        const pub = await linkOf(tx, leaseId);
        const held = depositHeld(entries);
        if (held < 0) throw new Error('over');
        if (entries.length > MAX_DEPOSIT_ENTRIES) throw new Error('too_many');
        const now = Date.now();
        tx.update(ref, { entries, held, updatedAt: now, updatedBy: uid() });
        if (pub) tx.set(pub.ref, { ...pub.data, dep: held, updatedAt: now });
        return held;
    });
}
