/**
 * @fileoverview Rentals (#170) Firestore access. Every rent_* read and write
 * goes through here; nothing runs until Rentals is opened. Listeners attach in
 * attach() and are removed in detach() (leaving Rentals, sign-out).
 * @module rentals/rent-store
 */

import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { applyPayment, chargeId, monthsToCharge, newCharge } from './rent-math.js';

/** Upper bound for every rentals listener (design §3.4). */
export const LISTEN_LIMIT = 500;

/** Environment-prefixed collection name (window.getCollection adds the dev prefix in development). */
export const rentCol = (name) => (typeof window !== 'undefined' && typeof window.getCollection === 'function'
    ? window.getCollection(name) : name);

const coll = (name) => FirebaseService.db.collection(rentCol(name));
const uid = () => AppState.currentUser?.uid || null;

const data = {
    properties: new Map(), units: new Map(), tenants: new Map(), leases: new Map(),
    openCharges: new Map(), monthCharges: new Map()
};
let unsubs = [];

/**
 * Starts the rentals listeners (no-op when already attached).
 * @param {string} month current 'YYYY-MM'
 * @param {(key: string, error?: Error) => void} onChange
 */
export function attach(month, onChange) {
    if (unsubs.length) return;
    // Leases also report when a local write is acknowledged, so charges are only
    // generated for a lease the server already has (no transaction contention).
    const listen = (key, query, opts = {}) => {
        unsubs.push(query.limit(LISTEN_LIMIT).onSnapshot(opts, (snap) => {
            const next = new Map();
            snap.forEach(doc => next.set(doc.id, { id: doc.id, ...doc.data(), _pending: !!doc.metadata?.hasPendingWrites }));
            data[key] = next;
            onChange(key);
        }, (error) => {
            console.warn(`Rentals ${key} listener failed:`, error?.code || error);
            onChange(key, error);
        }));
    };
    listen('properties', coll('rent_properties').where('archived', '==', false));
    listen('units', coll('rent_units').where('archived', '==', false));
    listen('tenants', coll('rent_tenants').where('archived', '==', false));
    listen('leases', coll('rent_leases').where('status', '==', 'active'), { includeMetadataChanges: true });
    listen('openCharges', coll('rent_charges').where('open', '==', true));
    listen('monthCharges', coll('rent_charges').where('month', '==', month));
}

export function detach() {
    unsubs.forEach(u => { try { u(); } catch (_) { /* already gone */ } });
    unsubs = [];
}

export const isAttached = () => unsubs.length > 0;

/** Current data as plain arrays; charges from both listeners merged by id. */
export function snapshot() {
    const charges = new Map([...data.openCharges, ...data.monthCharges]);
    return {
        properties: [...data.properties.values()],
        units: [...data.units.values()],
        tenants: [...data.tenants.values()],
        leases: [...data.leases.values()],
        charges: [...charges.values()]
    };
}

const stamp = (fields) => ({ ...fields, updatedAt: Date.now() });
const created = (fields) => ({ ...fields, archived: false, createdAt: Date.now(), createdBy: uid(), updatedAt: Date.now() });

export const addProperty = (p) => coll('rent_properties').doc().set(created(p));
export const updateProperty = (id, fields) => coll('rent_properties').doc(id).update(stamp(fields));
export const addUnit = (u) => coll('rent_units').doc().set(created({ leaseId: null, ...u }));
export const updateUnit = (id, fields) => coll('rent_units').doc(id).update(stamp(fields));
export const addTenant = (tn) => coll('rent_tenants').doc().set(created(tn));
export const updateTenant = (id, fields) => coll('rent_tenants').doc(id).update(stamp(fields));

/** Moves a tenant into a vacant unit: the lease and the unit's leaseId in one batch. */
export async function startLease({ unit, tenantId, rent, dueDay, startMonth, deposit }) {
    const db = FirebaseService.db;
    const leaseRef = coll('rent_leases').doc();
    const now = Date.now();
    const batch = db.batch();
    batch.set(leaseRef, {
        unitId: unit.id, propertyId: unit.propertyId, tenantId,
        rent, dueDay, startMonth, endMonth: null, deposit,
        status: 'active', chargedThrough: null,
        createdAt: now, createdBy: uid(), updatedAt: now
    });
    batch.update(coll('rent_units').doc(unit.id), { leaseId: leaseRef.id, updatedAt: now });
    await batch.commit();
    return leaseRef.id;
}

/** Ends a lease (move out); unpaid months stay open. */
export async function endLease(lease, endMonth) {
    const db = FirebaseService.db;
    const now = Date.now();
    const batch = db.batch();
    batch.update(coll('rent_leases').doc(lease.id), { status: 'ended', endMonth, updatedAt: now });
    batch.update(coll('rent_units').doc(lease.unitId), { leaseId: null, updatedAt: now });
    await batch.commit();
}

/**
 * Creates the missing monthly charges of one lease up to `month`. The lease is
 * re-read inside the transaction, so two phones never create the same month
 * twice (and the charge id is fixed per lease and month anyway).
 * @returns {Promise<number>} charges created
 */
export async function chargeLease(leaseId, month, names) {
    const db = FirebaseService.db;
    const leaseRef = coll('rent_leases').doc(leaseId);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(leaseRef);
        if (!snap.exists) return 0;
        const lease = { id: snap.id, ...snap.data() };
        const months = monthsToCharge(lease, month);
        if (!months.length) return 0;
        for (const m of months) tx.set(coll('rent_charges').doc(chargeId(lease.id, m)), newCharge(lease, m, names));
        tx.update(leaseRef, { chargedThrough: months[months.length - 1], updatedAt: Date.now() });
        return months.length;
    });
}

/**
 * Records a payment on one month's charge (transaction; never more than is due).
 * @returns {Promise<{amount: number, paid: number, open: boolean}>}
 */
export async function recordPayment(id, { amount, mode, ref, date }) {
    const db = FirebaseService.db;
    const chargeRef = coll('rent_charges').doc(id);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(chargeRef);
        if (!snap.exists) throw new Error('missing');
        const charge = snap.data();
        const next = applyPayment(charge, amount);
        const entry = {
            amount: next.amount, mode, ref: String(ref || '').slice(0, 60), date,
            at: Date.now(), by: uid(), byName: String(AppState.userName || '').slice(0, 80)
        };
        tx.update(chargeRef, {
            paid: next.paid, open: next.open,
            payments: [...(charge.payments || []), entry],
            updatedAt: Date.now()
        });
        return next;
    });
}

/** Owner: rentals role of a user ('manager' | 'member' | null). */
export const setRentRole = (userId, role) => FirebaseService.updateUser(userId, { rentRole: role || null });
