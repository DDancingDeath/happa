/**
 * @fileoverview Rent receipts data used only from the receipt screens (#170):
 * the tenant's receipts, payments still without one, issuing one later, and
 * cancel. Loaded with rent-receipt.js (import() on first use); the receipt
 * written with a payment is in rent-store.js recordPayment().
 * @module rentals/rent-receipt-store
 */

import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { receiptNo } from './rent-math.js';
import { withMonth } from './rent-public.js';
import { rentCol, uid, clip, readPublic, receiptRetry, nextSeq, putReceipt, latestCharges, snapshot } from './rent-store.js';

const coll = (name) => FirebaseService.db.collection(rentCol(name));

/** Months of each current lease searched for payments without a receipt. */
export const ISSUE_MONTHS = 12;

/** The newest receipts of a tenant (payment history; index tenantId + createdAt desc). */
export async function listReceipts(tenantId, max = 60) {
    const snap = await coll('rent_receipts').where('tenantId', '==', tenantId).orderBy('createdAt', 'desc').limit(max).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Payments of a tenant without a receipt that this user may issue one for (own,
 * or any for owner/manager): the loaded months plus the last ISSUE_MONTHS of each
 * current lease (one bounded query per lease). Newest first.
 * @returns {Promise<Array<{charge: Object, pi: number, entry: Object}>>}
 */
export async function withoutReceipt(tenantId, manager) {
    const d = snapshot();
    const lists = await Promise.all(d.leases.filter(l => l.tenantId === tenantId).map(l => latestCharges(l.id, ISSUE_MONTHS)));
    const charges = new Map([...d.charges.filter(c => c.tenantId === tenantId), ...lists.flat()].map(c => [c.id, c]));
    return [...charges.values()]
        .flatMap(charge => (charge.payments || []).map((entry, pi) => ({ charge, pi, entry })))
        // Paid from the deposit or an advance (#157) gets no receipt: no money changed hands then.
        .filter(x => !x.entry.rno && !['deposit', 'advance'].includes(x.entry.mode) && Number.isFinite(x.charge.rent) && (manager || x.entry.by === uid()))
        .sort((a, b) => b.charge.month.localeCompare(a.charge.month) || b.pi - a.pi);
}

/**
 * The receipt of a payment saved without one (entry `pi` of charge `id`), by its
 * writer or an owner/manager: same number series and checks as with a payment.
 * @returns {Promise<?Object>} the receipt, or null when the entry already has one
 */
export function issueReceipt(id, pi, rc) {
    return receiptRetry((year) => FirebaseService.db.runTransaction(async (tx) => {
        const chargeRef = coll('rent_charges').doc(id);
        const charge = (await tx.get(chargeRef)).data();
        if (!charge?.payments?.[pi] || charge.payments[pi].rno || ['deposit', 'advance'].includes(charge.payments[pi].mode) || !Number.isFinite(charge.rent)) return null;
        const lease = await tx.get(coll('rent_leases').doc(charge.leaseId));
        const pub = lease.exists ? await readPublic(tx, lease.data(), true) : null;
        const seq = await nextSeq(tx, year);
        const ch = { ...charge, payments: charge.payments.map((p, i) => (i === pi ? { ...p, rno: receiptNo(year, seq) } : p)) };
        tx.update(chargeRef, { payments: ch.payments, updatedAt: Date.now(), updatedBy: uid() });
        if (pub) tx.set(pub.ref, withMonth(pub.data, ch, Date.now(), pub.old));
        return putReceipt(tx, id, ch, pi, rc, year, seq, { issuedBy: uid() });
    }));
}

/**
 * Owner/manager: marks a receipt void (it stays, never edited otherwise). The
 * charge lists the payment as voided so the tenant link drops its number.
 * @returns {Promise<boolean>} false when it was already void
 */
export async function voidReceipt(rid, reason) {
    const ref = coll('rent_receipts').doc(rid);
    return FirebaseService.db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new Error('missing');
        const r = snap.data();
        if (r.void) return false;
        const chargeRef = coll('rent_charges').doc(r.chargeId);
        const ch = await tx.get(chargeRef);
        const lease = ch.exists ? await tx.get(coll('rent_leases').doc(r.leaseId)) : null;
        const pub = lease?.exists ? await readPublic(tx, lease.data(), true) : null;
        const now = Date.now();
        tx.update(ref, { void: true, voidBy: uid(), voidByName: clip(AppState.userName, 80), voidAt: now, voidReason: clip(reason, 200) });
        if (ch.exists) {
            const voided = [...(ch.data().voided || []).filter(i => i !== r.pi), r.pi];
            tx.update(chargeRef, { voided, updatedAt: now, updatedBy: uid() });
            if (pub) tx.set(pub.ref, withMonth(pub.data, { ...ch.data(), voided }, now, pub.old));
        }
        return true;
    });
}
