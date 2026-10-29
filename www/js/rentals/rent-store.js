/**
 * @fileoverview Rentals (#170) Firestore access. Every rent_* read and write
 * goes through here; nothing runs until Rentals is opened. Listeners attach in
 * attach() and are removed in detach() (leaving Rentals, sign-out).
 * @module rentals/rent-store
 */

import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { round2 } from '../utils/money.js';
import {
    applyPayment, applyMeter, chargeId, monthsToCharge, newCharge, isMonth, addMonths, monthRange, normalizeRentSettings, firstMonthRent,
    receiptNo, istYear, MAX_PROPERTIES, MAX_UNITS_PER_PROPERTY, MAX_BACKFILL_MONTHS
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

/**
 * Move-in in ONE batch (also "Add unit" with its tenant): the unit (new, or an
 * existing vacant one), the tenant (new, or an existing one), the lease and, when
 * the start month has begun, the first month's charge (full or pro-rated,
 * RENT-11) with chargedThrough set. Same rules as every move-in; all or nothing.
 * @param {Object} p
 * @param {Object} p.unit existing unit {id, propertyId, ...} or new unit fields when p.newUnit
 * @param {boolean} [p.newUnit]
 * @param {?Object} [p.tenant] new tenant {name, phone, phone2?, notes?}
 * @param {?string} [p.tenantId] existing tenant
 * @param {Object} p.lease {rent, dueDay, startDate, proRate, deposit, increasePct, elecMode, meterNo?}
 * @param {?{reading: number, rate: number}} [p.meter] opening reading / rate (new units)
 * @param {string} p.currentMonth
 * @returns {Promise<{unitId: string, tenantId: string, leaseId: string, charged: boolean}>}
 */
export async function moveIn({ unit, newUnit = false, tenant = null, tenantId = null, tenantName = '', lease, meter = null, currentMonth }) {
    const db = FirebaseService.db;
    const now = Date.now();
    const batch = db.batch();
    const unitRef = newUnit ? coll('rent_units').doc() : coll('rent_units').doc(unit.id);
    const leaseRef = coll('rent_leases').doc();
    let tid = tenantId;
    if (!tid) {
        const tenantRef = coll('rent_tenants').doc();
        tid = tenantRef.id;
        batch.set(tenantRef, created({ name: tenant.name, phone: tenant.phone, ...(tenant.phone2 ? { phone2: tenant.phone2 } : {}), notes: tenant.notes || '' }));
    }
    const startMonth = lease.startDate.slice(0, 7);
    const doc = {
        unitId: unitRef.id, propertyId: unit.propertyId, tenantId: tid,
        rent: lease.rent, dueDay: lease.dueDay, startMonth, startDate: lease.startDate,
        proRate: !!lease.proRate, endMonth: null, deposit: lease.deposit || 0, increasePct: lease.increasePct,
        rentSince: startMonth, elecMode: lease.elecMode, status: 'active', chargedThrough: null,
        createdAt: now, createdBy: uid(), updatedAt: now, updatedBy: uid()
    };
    if (lease.proRate) doc.firstRent = firstMonthRent(lease.rent, lease.startDate, true);
    if (lease.elecMode === 'own' && lease.meterNo) doc.meterNo = String(lease.meterNo).slice(0, 40);
    const charged = startMonth <= currentMonth;
    if (charged) {
        doc.chargedThrough = startMonth;
        const names = { tenantName: tenant?.name || tenantName || '', unitLabel: unit.label || '' };
        batch.set(coll('rent_charges').doc(chargeId(leaseRef.id, startMonth)),
            { ...newCharge({ id: leaseRef.id, ...doc }, startMonth, names), updatedBy: uid() });
    }
    batch.set(leaseRef, doc);
    if (newUnit) {
        batch.set(unitRef, created({
            propertyId: unit.propertyId, label: unit.label, rent: unit.rent, type: unit.type,
            ...(unit.area != null ? { area: unit.area } : {}), ...(unit.floor ? { floor: unit.floor } : {}),
            leaseId: leaseRef.id,
            lastReading: meter && Number.isFinite(meter.reading) ? meter.reading : null,
            meterRate: meter && Number.isFinite(meter.rate) ? meter.rate : null,
            meterCharge: null
        }));
    } else {
        batch.update(unitRef, { leaseId: leaseRef.id, updatedAt: now, updatedBy: uid() });
    }
    await batch.commit();
    return { unitId: unitRef.id, tenantId: tid, leaseId: leaseRef.id, charged };
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
 * A charge written moments ago (e.g. by a move-in) may not have reached the
 * server yet, and a transaction reads the server: wait (briefly) for this
 * device's pending writes and try once more.
 */
async function withPendingRetry(run) {
    try {
        return await run();
    } catch (e) {
        const db = FirebaseService.db;
        if (e?.message !== 'missing' || typeof db.waitForPendingWrites !== 'function') throw e;
        await Promise.race([db.waitForPendingWrites(), new Promise(r => setTimeout(r, 8000))]);
        return run();
    }
}

/**
 * Records a payment on one month's charge (transaction; never more than is due).
 * With `rc` (names for the receipt) the same transaction issues its receipt:
 * the next number of the year's counter, rent_receipts/{chargeId}_{i}, and the
 * number on the payment entry (rules check all three together).
 * @param {string} id charge id
 * @param {{amount: number, mode: string, ref?: string, date: string}} entry
 * @param {?{tenantName?: string, place?: string, ut?: ?string, biz?: string, bizAddr?: string}} [rc]
 * @returns {Promise<{amount: number, paid: number, open: boolean, receipt: ?Object}>}
 */
export async function recordPayment(id, entry, rc = null) {
    // Someone else took the next number first (the rules refuse the stale one): read again.
    // Still refused (e.g. rules not yet deployed): the payment is saved without a receipt.
    for (let i = 0; rc && i < 3; i++) {
        try {
            return await withPendingRetry(() => recordPaymentOnce(id, entry, rc));
        } catch (e) {
            if (!['permission-denied', 'aborted', 'failed-precondition'].includes(e?.code)) throw e;
            console.warn('Receipt not issued, trying again:', e.code);
        }
    }
    return withPendingRetry(() => recordPaymentOnce(id, entry, null));
}

const clip = (v, n) => String(v || '').slice(0, n);

async function recordPaymentOnce(id, { amount, mode, ref, date }, rc) {
    const db = FirebaseService.db;
    const chargeRef = coll('rent_charges').doc(id);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(chargeRef);
        if (!snap.exists) throw new Error('missing');
        const charge = snap.data();
        const next = applyPayment(charge, amount);
        const leaseSnap = await tx.get(coll('rent_leases').doc(charge.leaseId));
        const pub = leaseSnap.exists ? await readPublic(tx, leaseSnap.data()) : null;
        const year = istYear();
        const ctrRef = rc && Number.isFinite(charge.rent) ? coll('rent_counters').doc(`receipts_${year}`) : null;
        const seq = ctrRef ? (Number((await tx.get(ctrRef)).data()?.last) || 0) + 1 : 0;
        const pi = (charge.payments || []).length;
        const now = Date.now();
        const e = {
            amount: next.amount, mode, ref: clip(ref, 60), date,
            at: now, by: uid(), byName: clip(AppState.userName, 80),
            ...(seq ? { rno: receiptNo(year, seq) } : {})
        };
        const payments = [...(charge.payments || []), e];
        tx.update(chargeRef, { paid: next.paid, open: next.open, payments, updatedAt: now, updatedBy: uid() });
        let receipt = null;
        if (seq) {
            const rid = `${id}_${pi}`;
            receipt = {
                no: e.rno, year, seq, chargeId: id, pi,
                leaseId: charge.leaseId, tenantId: charge.tenantId, unitId: charge.unitId, propertyId: charge.propertyId,
                tenantName: clip(rc.tenantName || charge.tenantName, 80), place: clip(rc.place, 150),
                ...(rc.ut ? { ut: rc.ut } : {}),
                months: [charge.month], rent: charge.rent, elec: charge.electricity || null, total: charge.amount,
                paid: e.amount, mode, ref: e.ref, date, balance: Math.max(0, round2(charge.amount - next.paid)),
                by: e.by, byName: e.byName, biz: clip(rc.biz, 80), bizAddr: clip(rc.bizAddr, 200),
                createdAt: now, void: false
            };
            tx.set(coll('rent_receipts').doc(rid), receipt);
            tx.set(ctrRef, { last: seq, rid, updatedAt: now, updatedBy: uid() });
            receipt = { id: rid, ...receipt };
        }
        if (pub) tx.set(pub.ref, withMonth(pub.data, { ...charge, paid: next.paid, open: next.open, payments }));
        return { ...next, receipt };
    });
}

/** The newest receipts of a tenant (payment history; index tenantId + createdAt desc). */
export async function listReceipts(tenantId, max = 60) {
    const snap = await coll('rent_receipts').where('tenantId', '==', tenantId).orderBy('createdAt', 'desc').limit(max).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Owner/manager: marks a receipt void (it stays, never edited otherwise). The
 * charge lists the payment as voided so the tenant link drops its number.
 * @returns {Promise<boolean>} false when it was already void
 */
export async function voidReceipt(rid, reason) {
    const db = FirebaseService.db;
    const ref = coll('rent_receipts').doc(rid);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new Error('missing');
        const r = snap.data();
        if (r.void) return false;
        const chargeRef = coll('rent_charges').doc(r.chargeId);
        const ch = await tx.get(chargeRef);
        const lease = ch.exists ? await tx.get(coll('rent_leases').doc(r.leaseId)) : null;
        const pub = lease?.exists ? await readPublic(tx, lease.data()) : null;
        const now = Date.now();
        tx.update(ref, { void: true, voidBy: uid(), voidByName: clip(AppState.userName, 80), voidAt: now, voidReason: clip(reason, 200) });
        if (ch.exists) {
            const voided = [...(ch.data().voided || []).filter(i => i !== r.pi), r.pi];
            tx.update(chargeRef, { voided, updatedAt: now, updatedBy: uid() });
            if (pub) tx.set(pub.ref, withMonth(pub.data, { ...ch.data(), voided }));
        }
        return true;
    });
}

/**
 * Sets (or corrects) the month's electricity from a sub-meter reading: the
 * charge becomes rent + electricity, and the unit remembers the reading and rate.
 * @param {string} id charge id
 * @param {{prev: number, curr: number, rate: number, units: number, amount: number}} meter from meterBill()
 */
export function recordMeter(id, unitId, meter) {
    return withPendingRetry(() => recordMeterOnce(id, unitId, meter));
}

async function recordMeterOnce(id, unitId, meter) {
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
