/**
 * @fileoverview Rentals (#170) Firestore access. Every rent_* read and write
 * goes through here; nothing runs until Rentals is opened. Listeners attach in
 * attach() and are removed in detach() (leaving Rentals, sign-out).
 * @module rentals/rent-store
 */

import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import {
    applyPayment, applyMeter, chargeId, monthsToCharge, newCharge, isMonth, addMonths, monthRange, normalizeRentSettings,
    MAX_PROPERTIES, MAX_UNITS_PER_PROPERTY, MAX_BACKFILL_MONTHS
} from './rent-math.js';
import { buildPublicSnapshot, isShareToken, newShareToken, withLease, withMonth, withNames, PUBLIC_MONTHS } from './rent-public.js';

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
    linked: 2 * MAX_PROPERTIES * MAX_UNITS_PER_PROPERTY,
    monthCharges: MAX_PROPERTIES * MAX_UNITS_PER_PROPERTY
};

/** Environment-prefixed collection name (window.getCollection adds the dev prefix in development). */
export const rentCol = (name) => (typeof window !== 'undefined' && typeof window.getCollection === 'function'
    ? window.getCollection(name) : name);

const coll = (name) => FirebaseService.db.collection(rentCol(name));
const uid = () => AppState.currentUser?.uid || null;

const data = {
    properties: new Map(), units: new Map(), tenants: new Map(), leases: new Map(),
    openCharges: new Map(), monthCharges: new Map(), linked: new Map()
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
        // One more than the limit, so "full" is reported only when there really is more.
        unsubs.push(query.limit(LISTEN_LIMITS[key] + 1).onSnapshot(opts, (snap) => {
            if (snap.size > LISTEN_LIMITS[key]) truncated.add(key); else truncated.delete(key);
            const next = new Map();
            snap.docs.slice(0, LISTEN_LIMITS[key])
                .forEach(doc => next.set(doc.id, { id: doc.id, ...doc.data(), _pending: !!doc.metadata?.hasPendingWrites }));
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
    // Leases with a tenant link (also moved-out ones, so their link can be turned off).
    listen('linked', coll('rent_leases').where('shareToken', '>', ''));
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
        linked: [...data.linked.values()],
        charges: [...charges.values()]
    };
}

const stamp = (fields) => ({ ...fields, updatedAt: Date.now(), updatedBy: uid() });
const created = (fields) => ({ ...fields, archived: false, createdAt: Date.now(), createdBy: uid(), updatedAt: Date.now(), updatedBy: uid() });

export const addProperty = (p) => coll('rent_properties').doc().set(created(p));
export const updateProperty = (id, fields) => coll('rent_properties').doc(id).update(stamp(fields));
export const addUnit = (u) => coll('rent_units').doc().set(created({ leaseId: null, lastReading: null, meterRate: null, meterCharge: null, ...u }));
export const updateUnit = (id, fields) => coll('rent_units').doc(id).update(stamp(fields));
export const addTenant = (tn) => coll('rent_tenants').doc().set(created(tn));
export const updateTenant = (id, fields) => coll('rent_tenants').doc(id).update(stamp(fields));

// ---------- tenant rent-history link (rent_public/{token}) ----------

const publicRef = (token) => coll('rent_public').doc(token);

/**
 * Inside a transaction: the lease's link snapshot (if the lease has a link).
 * Reads must come before writes, so call this before any tx.set/update.
 * @returns {Promise<?{ref: Object, data: Object}>}
 */
async function readPublic(tx, lease) {
    if (!isShareToken(lease?.shareToken)) return null;
    const ref = publicRef(lease.shareToken);
    const snap = await tx.get(ref);
    return snap.exists ? { ref, data: snap.data() } : null;
}

/** Changes rent / due day / yearly %; the link snapshot follows in the same transaction. */
export async function updateLease(id, fields) {
    const db = FirebaseService.db;
    const leaseRef = coll('rent_leases').doc(id);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(leaseRef);
        if (!snap.exists) throw new Error('missing');
        const lease = { id, ...snap.data() };
        const pub = await readPublic(tx, lease);
        tx.update(leaseRef, stamp(fields));
        if (pub) tx.set(pub.ref, withLease(pub.data, { ...lease, ...fields }));
    });
}

/**
 * Owner/manager: make (or replace) the tenant's read-only link. Builds the
 * snapshot from the lease's charges (one bounded query), writes it under a new
 * random token, points the lease at it and removes the old snapshot.
 * @returns {Promise<string>} the new token
 */
export async function makeShareLink(lease, { tenantName, place, unitType, shopName }) {
    const db = FirebaseService.db;
    const token = newShareToken();
    const names = { tenantName, place, unitType, shopName };
    const batch = db.batch();
    batch.set(publicRef(token), buildPublicSnapshot({ lease, ...names, charges: await latestCharges(lease.id) }));
    batch.update(coll('rent_leases').doc(lease.id), stamp({ shareToken: token }));
    if (isShareToken(lease.shareToken)) batch.delete(publicRef(lease.shareToken));
    await batch.commit();
    // A payment or new month between the read above and the commit didn't see the
    // link yet: rebuild once now (later writes keep it current themselves).
    await rebuildShareSnapshot(lease.id, token, names);
    return token;
}

/** The newest PUBLIC_MONTHS charges of a lease (one bounded query; index leaseId + month desc). */
async function latestCharges(leaseId) {
    const snap = await coll('rent_charges').where('leaseId', '==', leaseId).orderBy('month', 'desc').limit(PUBLIC_MONTHS).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Rewrites a link snapshot from the lease and its charges, if the lease still points at `token`. */
export async function rebuildShareSnapshot(leaseId, token, names) {
    const db = FirebaseService.db;
    const charges = await latestCharges(leaseId);
    const leaseRef = coll('rent_leases').doc(leaseId);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(leaseRef);
        if (!snap.exists || snap.data().shareToken !== token) return false;
        tx.set(publicRef(token), buildPublicSnapshot({ lease: { id: leaseId, ...snap.data() }, ...names, charges }));
        return true;
    });
}

/** After a tenant/property/unit rename: new display names in a lease's link snapshot. */
export async function renameInLink(lease, { tenantName, place, unitType }) {
    const db = FirebaseService.db;
    const leaseRef = coll('rent_leases').doc(lease.id);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(leaseRef);
        const pub = snap.exists ? await readPublic(tx, snap.data()) : null;
        if (!pub) return false;
        tx.set(pub.ref, withNames(pub.data, { tenantName, place, unitType }));
        return true;
    });
}

/** Owner/manager: turn the link off (snapshot deleted, lease token cleared). */
export async function removeShareLink(lease) {
    const batch = FirebaseService.db.batch();
    if (isShareToken(lease.shareToken)) batch.delete(publicRef(lease.shareToken));
    batch.update(coll('rent_leases').doc(lease.id), stamp({ shareToken: null }));
    await batch.commit();
}

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
 * Creates the missing monthly charges of one lease up to `month`, one month per
 * transaction (the rules let chargedThrough move one month at a time, so no
 * month can be skipped). Each transaction re-reads the lease, so two phones
 * never create the same month twice.
 * @returns {Promise<number>} charges created
 */
export async function chargeLease(leaseId, month, names, maxMonths = MAX_BACKFILL_MONTHS) {
    const db = FirebaseService.db;
    const leaseRef = coll('rent_leases').doc(leaseId);
    let created = 0;
    while (created < maxMonths) {
        const made = await db.runTransaction(async (tx) => {
            const snap = await tx.get(leaseRef);
            if (!snap.exists) return false;
            const lease = { id: snap.id, ...snap.data() };
            const [m] = monthsToCharge(lease, month);
            if (!m) return false;
            const pub = await readPublic(tx, lease);
            const charge = { ...newCharge(lease, m, names), updatedBy: uid() };
            tx.set(coll('rent_charges').doc(chargeId(lease.id, m)), charge);
            tx.update(leaseRef, { chargedThrough: m, updatedAt: Date.now(), updatedBy: uid() });
            if (pub) tx.set(pub.ref, withMonth(pub.data, charge));
            return true;
        });
        if (!made) break;
        created++;
    }
    return created;
}

/**
 * Move out. Charges are first brought up to the last month, then one
 * transaction ends the lease with chargedThrough = endMonth, frees the unit and
 * deletes unpaid months after the last month (a back-dated move-out; rules allow
 * that for owner/manager only). The last month can't be in the future.
 * @throws {Error} 'bad_month' | 'later_paid' (a later month has payments) | 'not_charged' | 'missing'
 */
export async function endLease(leaseId, endMonth, currentMonth, names = {}) {
    const db = FirebaseService.db;
    const leaseRef = coll('rent_leases').doc(leaseId);
    if (!isMonth(endMonth) || endMonth > currentMonth) throw new Error('bad_month');
    await chargeLease(leaseId, endMonth, names, MAX_BACKFILL_MONTHS);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(leaseRef);
        if (!snap.exists) throw new Error('missing');
        const lease = { id: snap.id, ...snap.data() };
        if (lease.status !== 'active' || endMonth < lease.startMonth) throw new Error('bad_month');
        if (!isMonth(lease.chargedThrough) || lease.chargedThrough < endMonth) throw new Error('not_charged');
        const later = lease.chargedThrough > endMonth ? monthRange(addMonths(endMonth, 1), lease.chargedThrough) : [];
        const laterSnaps = await Promise.all(later.map(m => tx.get(coll('rent_charges').doc(chargeId(lease.id, m)))));
        if (laterSnaps.some(s => s.exists && ((Number(s.data().paid) || 0) > 0 || (s.data().payments || []).length))) {
            throw new Error('later_paid');
        }
        const pub = await readPublic(tx, lease);
        const now = Date.now();
        laterSnaps.filter(s => s.exists).forEach(s => tx.delete(s.ref));
        tx.update(leaseRef, { status: 'ended', endMonth, chargedThrough: endMonth, updatedAt: now, updatedBy: uid() });
        if (pub) tx.set(pub.ref, withLease(pub.data, { ...lease, status: 'ended', endMonth }));
        tx.update(coll('rent_units').doc(lease.unitId), { leaseId: null, updatedAt: now, updatedBy: uid() });
        return later.length;
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
        const leaseSnap = await tx.get(coll('rent_leases').doc(charge.leaseId));
        const pub = leaseSnap.exists ? await readPublic(tx, leaseSnap.data()) : null;
        const entry = {
            amount: next.amount, mode, ref: String(ref || '').slice(0, 60), date,
            at: Date.now(), by: uid(), byName: String(AppState.userName || '').slice(0, 80)
        };
        tx.update(chargeRef, {
            paid: next.paid, open: next.open,
            payments: [...(charge.payments || []), entry],
            updatedAt: Date.now(), updatedBy: uid()
        });
        if (pub) tx.set(pub.ref, withMonth(pub.data, { ...charge, paid: next.paid, open: next.open, payments: [...(charge.payments || []), entry] }));
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
        const charge = snap.data();
        const next = applyMeter(charge, meter);
        const leaseSnap = await tx.get(coll('rent_leases').doc(charge.leaseId));
        const pub = leaseSnap.exists ? await readPublic(tx, leaseSnap.data()) : null;
        const now = Date.now();
        tx.update(chargeRef, { electricity: meter, amount: next.amount, open: next.open, updatedAt: now, updatedBy: uid() });
        tx.update(coll('rent_units').doc(unitId), { lastReading: meter.curr, meterRate: meter.rate, meterCharge: id, updatedAt: now, updatedBy: uid() });
        if (pub) tx.set(pub.ref, withMonth(pub.data, { ...charge, electricity: meter, amount: next.amount, open: next.open }));
        return next;
    });
}

/** Owner: rentals role of a user ('manager' | 'member' | null). */
export const setRentRole = (userId, role) => FirebaseService.updateUser(userId, { rentRole: role || null });

// ---------- Settings › Rentals (rent_settings/default) ----------

let settingsPromise = null;

/** Rentals defaults, read once per session (only when Settings › Rentals or a move-in needs them). */
export function loadSettings({ refresh = false } = {}) {
    if (!settingsPromise || refresh) {
        settingsPromise = coll('rent_settings').doc('default').get()
            .then(snap => normalizeRentSettings(snap.exists ? snap.data() : null));
        settingsPromise.catch(() => { settingsPromise = null; });
    }
    return settingsPromise;
}

/** Owner/manager: saves the defaults for new leases (rules check the shape). */
export async function saveSettings(values) {
    const next = normalizeRentSettings(values);
    await coll('rent_settings').doc('default').set(stamp(next));
    settingsPromise = Promise.resolve(next);
    return next;
}

export const _resetSettingsCache = () => { settingsPromise = null; };
