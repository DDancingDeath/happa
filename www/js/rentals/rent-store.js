/**
 * @fileoverview Rentals (#170) Firestore access. Every rent_* read and write
 * goes through here; nothing runs until Rentals is opened. Listeners attach in
 * attach() and are removed in detach() (leaving Rentals, sign-out).
 * @module rentals/rent-store
 */

import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import {
    applyPayment, applyMeter, chargeId, monthsToCharge, newCharge, isMonth, addMonths, monthRange,
    MAX_PROPERTIES, MAX_UNITS_PER_PROPERTY
} from './rent-math.js';

/**
 * Upper bound per rentals listener (design §3.4): sized for 100 properties with
 * up to 20 units each. A listener that comes back full is reported as truncated.
 */
export const LISTEN_LIMITS = {
    properties: MAX_PROPERTIES,
    units: MAX_PROPERTIES * MAX_UNITS_PER_PROPERTY,
    tenants: MAX_PROPERTIES * MAX_UNITS_PER_PROPERTY,
    leases: MAX_PROPERTIES * MAX_UNITS_PER_PROPERTY,
    openCharges: 2 * MAX_PROPERTIES * MAX_UNITS_PER_PROPERTY,
    monthCharges: MAX_PROPERTIES * MAX_UNITS_PER_PROPERTY
};

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
const truncated = new Set();

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
        unsubs.push(query.limit(LISTEN_LIMITS[key]).onSnapshot(opts, (snap) => {
            if (snap.size >= LISTEN_LIMITS[key]) truncated.add(key); else truncated.delete(key);
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

/** Listeners that hit their limit (more data exists than is shown). */
export const truncatedKeys = () => [...truncated];

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

const stamp = (fields) => ({ ...fields, updatedAt: Date.now(), updatedBy: uid() });
const created = (fields) => ({ ...fields, archived: false, createdAt: Date.now(), createdBy: uid(), updatedAt: Date.now(), updatedBy: uid() });

export const addProperty = (p) => coll('rent_properties').doc().set(created(p));
export const updateProperty = (id, fields) => coll('rent_properties').doc(id).update(stamp(fields));
export const addUnit = (u) => coll('rent_units').doc().set(created({ leaseId: null, lastReading: null, meterRate: null, ...u }));
export const updateUnit = (id, fields) => coll('rent_units').doc(id).update(stamp(fields));
export const addTenant = (tn) => coll('rent_tenants').doc().set(created(tn));
export const updateTenant = (id, fields) => coll('rent_tenants').doc(id).update(stamp(fields));
export const updateLease = (id, fields) => coll('rent_leases').doc(id).update(stamp(fields));

/** Moves a tenant into a vacant unit: the lease and the unit's leaseId in one batch. */
export async function startLease({ unit, tenantId, rent, dueDay, startMonth, deposit, increasePct }) {
    const db = FirebaseService.db;
    const leaseRef = coll('rent_leases').doc();
    const now = Date.now();
    const batch = db.batch();
    batch.set(leaseRef, {
        unitId: unit.id, propertyId: unit.propertyId, tenantId,
        rent, dueDay, startMonth, endMonth: null, deposit, increasePct, rentSince: startMonth,
        status: 'active', chargedThrough: null,
        createdAt: now, createdBy: uid(), updatedAt: now, updatedBy: uid()
    });
    batch.update(coll('rent_units').doc(unit.id), { leaseId: leaseRef.id, updatedAt: now, updatedBy: uid() });
    await batch.commit();
    return leaseRef.id;
}

/**
 * Move out (one transaction): charges exist exactly up to the last month.
 * Missing months up to ndMonth are created, unpaid months after it are
 * deleted, and the lease ends with chargedThrough = endMonth. The last month
 * can't be in the future (currentMonth); unpaid earlier months stay due.
 * @throws {Error} 'bad_month' | 'later_paid' (a month after endMonth has payments) | 'missing'
 */
export async function endLease(leaseId, endMonth, currentMonth, names = {}) {
    const db = FirebaseService.db;
    const leaseRef = coll('rent_leases').doc(leaseId);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(leaseRef);
        if (!snap.exists) throw new Error('missing');
        const lease = { id: snap.id, ...snap.data() };
        if (!isMonth(endMonth) || endMonth > currentMonth || endMonth < lease.startMonth) throw new Error('bad_month');
        const later = isMonth(lease.chargedThrough) && lease.chargedThrough > endMonth
            ? monthRange(addMonths(endMonth, 1), lease.chargedThrough) : [];
        const laterSnaps = await Promise.all(later.map(m => tx.get(coll('rent_charges').doc(chargeId(lease.id, m)))));
        if (laterSnaps.some(s => s.exists && ((Number(s.data().paid) || 0) > 0 || (s.data().payments || []).length))) {
            throw new Error('later_paid');
        }
        const now = Date.now();
        for (const m of monthsToCharge(lease, endMonth)) {
            tx.set(coll('rent_charges').doc(chargeId(lease.id, m)), { ...newCharge(lease, m, names), updatedBy: uid() });
        }
        laterSnaps.filter(s => s.exists).forEach(s => tx.delete(s.ref));
        tx.update(leaseRef, { status: 'ended', endMonth, chargedThrough: endMonth, updatedAt: now, updatedBy: uid() });
        tx.update(coll('rent_units').doc(lease.unitId), { leaseId: null, updatedAt: now, updatedBy: uid() });
    });
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
        for (const m of months) tx.set(coll('rent_charges').doc(chargeId(lease.id, m)), { ...newCharge(lease, m, names), updatedBy: uid() });
        tx.update(leaseRef, { chargedThrough: months[months.length - 1], updatedAt: Date.now(), updatedBy: uid() });
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
            updatedAt: Date.now(), updatedBy: uid()
        });
        return next;
    });
}

/**
 * Sets (or corrects) the month's electricity from a sub-meter reading: the
 * charge becomes rent + electricity, and the unit remembers the reading and rate.
 * @param {string} id charge id
 * @param {{prev: number, curr: number, rate: number, units: number, amount: number}} meter from meterBill()
 */
export async function recordMeter(id, unitId, meter) {
    const db = FirebaseService.db;
    const chargeRef = coll('rent_charges').doc(id);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(chargeRef);
        if (!snap.exists) throw new Error('missing');
        const next = applyMeter(snap.data(), meter);
        const now = Date.now();
        tx.update(chargeRef, { rent: next.rent, electricity: meter, amount: next.amount, open: next.open, updatedAt: now, updatedBy: uid() });
        if (unitId) tx.update(coll('rent_units').doc(unitId), { lastReading: meter.curr, meterRate: meter.rate, updatedAt: now, updatedBy: uid() });
        return next;
    });
}

/** Owner: rentals role of a user ('manager' | 'member' | null). */
export const setRentRole = (userId, role) => FirebaseService.updateUser(userId, { rentRole: role || null });
