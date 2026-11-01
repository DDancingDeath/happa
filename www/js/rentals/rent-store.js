/**
 * @fileoverview Rentals (#170) Firestore access. Every rent_* read and write
 * goes through here; nothing runs until Rentals is opened. Listeners attach in
 * attach() and are removed in detach() (leaving Rentals, sign-out).
 * @module rentals/rent-store
 */

import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { todayLocalISO } from '../utils/dates.js';
import {
    applyPayment, withAdvance, applyMeter, chargeId, monthsToCharge, newCharge, isMonth, addMonths, monthRange, normalizeRentSettings, firstMonthRent,
    receiptNo, receiptAmounts, istYear, MAX_PROPERTIES, MAX_UNITS_PER_PROPERTY, MAX_BACKFILL_MONTHS
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

/** Raw collection reference: repository-internal (rent-receipt-store.js has its own), never exported to screens. */
const coll = (name) => FirebaseService.db.collection(rentCol(name));
export const uid = () => AppState.currentUser?.uid || null;

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
 * Inside a transaction: the lease's link snapshot (if the lease has a link; `follow`: or
 * the one it took along to another unit, `old`). Call before any tx.set/update.
 * @returns {Promise<?{ref: Object, data: Object, old?: boolean}>}
 */
export async function readPublic(tx, lease, follow = false) {
    if (!isShareToken(lease?.shareToken)) {
        if (!follow || !lease?.movedTo) return null;
        const pub = await readPublic(tx, (await tx.get(coll('rent_leases').doc(lease.movedTo))).data(), true);
        return pub && { ...pub, old: true };
    }
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

/** The newest `max` charges of a lease (one bounded query; index leaseId + month desc). */
export async function latestCharges(leaseId, max = PUBLIC_MONTHS) {
    const snap = await coll('rent_charges').where('leaseId', '==', leaseId).orderBy('month', 'desc').limit(max).get();
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
        // RENT-14: the deposit held (every deposit write after this keeps it current).
        const dep = (await tx.get(coll('rent_deposits').doc(snap.data().tenantId))).data()?.held;
        tx.set(publicRef(token), buildPublicSnapshot({ lease: { id: leaseId, ...snap.data() }, ...names, dep, charges }));
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

const hasPayment = (s) => s.exists && ((Number(s.data().paid) || 0) > 0 || (s.data().payments || []).length > 0);

/**
 * Move-in, all or nothing: unit (new or vacant), tenant (new or without a lease), lease and the
 * first charge. An existing tenant (or a change) is re-read in a transaction that writes the tenant
 * (or the old lease), so racing phones conflict; a new tenant is a batch (offline; a vacant unit is
 * checked against the listener's copy, the rules refuse a taken one). `change`: rent-unit.js changeUnit.
 * @throws {Error} 'unit_taken' | 'tenant_changed' | 'missing'
 */
export async function moveIn({ unit, newUnit = false, tenant = null, tenantId = null, tenantName = '', lease, meter = null, currentMonth, change = null }) {
    const db = FirebaseService.db;
    const unitRef = newUnit ? coll('rent_units').doc() : coll('rent_units').doc(unit.id);
    const tenantRef = tenantId ? coll('rent_tenants').doc(tenantId) : coll('rent_tenants').doc();
    const leaseRef = coll('rent_leases').doc();
    const names = { tenantName: tenant?.name || tenantName || '' };
    const tx = !!(tenantId || change);
    const run = async (w) => {
        let u = unit;
        if (!newUnit) {
            // A new tenant needs no re-read (a batch, works offline): this copy is checked, the rules refuse a taken unit.
            if (tx) u = (await w.get(unitRef)).data();
            if (!u || u.archived) throw new Error('missing');
            if (u.leaseId) throw new Error('unit_taken');
        }
        if (tenantId) {
            if (!change && !(await w.get(tenantRef)).exists) throw new Error('missing');
            // Outside the transaction but re-run on each retry.
            const q = await coll('rent_leases').where('tenantId', '==', tenantId).where('status', '==', 'active').limit(2).get();
            if (q.size > 1 || (q.docs[0]?.id || null) !== (change?.from || null)) throw new Error('tenant_changed');
        }
        const end = change && await change.read(w, leaseRef.id);
        const now = Date.now();
        const by = { updatedAt: now, updatedBy: uid() };
        if (end) end.write();
        else if (tenantId) w.update(tenantRef, by);
        else w.set(tenantRef, created({ name: tenant.name, phone: tenant.phone, ...(tenant.phone2 ? { phone2: tenant.phone2 } : {}), notes: tenant.notes || '' }));
        names.unitLabel = u.label || '';
        const startMonth = lease.startDate.slice(0, 7);
        const doc = {
            unitId: unitRef.id, propertyId: u.propertyId, tenantId: tenantRef.id,
            rent: lease.rent, dueDay: lease.dueDay, startMonth, startDate: lease.startDate,
            proRate: !!lease.proRate, endMonth: null, deposit: lease.deposit || 0, increasePct: lease.increasePct,
            rentSince: startMonth, elecMode: lease.elecMode, status: 'active', chargedThrough: null,
            ...end?.lease, createdAt: now, createdBy: uid(), updatedAt: now, updatedBy: uid()
        };
        if (lease.proRate) doc.firstRent = lease.firstRent ?? firstMonthRent(lease.rent, lease.startDate, true);
        if (lease.elecMode === 'own' && lease.meterNo) doc.meterNo = String(lease.meterNo).slice(0, 40);
        const charged = !end && startMonth <= currentMonth;
        if (charged) {
            doc.chargedThrough = startMonth;
            w.set(coll('rent_charges').doc(chargeId(leaseRef.id, startMonth)), { ...newCharge({ id: leaseRef.id, ...doc }, startMonth, names), updatedBy: uid() });
        }
        w.set(leaseRef, doc);
        if (!newUnit) w.update(unitRef, { leaseId: leaseRef.id, ...by });
        else {
            w.set(unitRef, created({
                propertyId: u.propertyId, label: u.label, rent: u.rent, type: u.type,
                ...(u.area != null ? { area: u.area } : {}), ...(u.floor ? { floor: u.floor } : {}),
                leaseId: leaseRef.id,
                lastReading: meter && Number.isFinite(meter.reading) ? meter.reading : null,
                meterRate: meter && Number.isFinite(meter.rate) ? meter.rate : null,
                meterCharge: null
            }));
        }
        return { unitId: unitRef.id, tenantId: tenantRef.id, leaseId: leaseRef.id, charged };
    };
    let res;
    if (!tx) {
        const batch = db.batch();
        res = await run(batch);
        await batch.commit();
    } else res = await db.runTransaction(run);
    if (change) res.charged = (await chargeLease(res.leaseId, currentMonth, names).catch(() => 0)) > 0;
    return res;
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
            // RENT-16: the advance carried on the month before pays this one first (the rules require it).
            const prevRef = isMonth(lease.chargedThrough) ? coll('rent_charges').doc(chargeId(lease.id, lease.chargedThrough)) : null;
            const prev = prevRef ? (await tx.get(prevRef)).data() : null;
            const adv = prev?.adv;
            const pub = await readPublic(tx, lease);
            const now = Date.now();
            const charge = withAdvance({ ...newCharge(lease, m, names), updatedBy: uid() }, adv,
                { ref: '', date: todayLocalISO(), at: now, by: uid(), byName: clip(AppState.userName, 80) });
            tx.set(coll('rent_charges').doc(chargeId(lease.id, m)), charge);
            tx.update(leaseRef, { chargedThrough: m, updatedAt: now, updatedBy: uid() });
            if (adv > 0) tx.update(prevRef, { adv: 0, updatedAt: now, updatedBy: uid() });
            if (pub) tx.set(pub.ref, withMonth(adv > 0 ? withMonth(pub.data, { ...prev, adv: 0 }, now) : pub.data, charge, now));
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
        return (await endInTx(tx, lease, endMonth))();
    });
}

/** A lease's data read in a transaction (change of unit). */
export const leaseInTx = async (tx, leaseId) => (await tx.get(coll('rent_leases').doc(leaseId))).data();

/** A charge's data read in a transaction (change of unit: the old unit's move month). */
export const chargeInTx = async (tx, id) => (await tx.get(coll('rent_charges').doc(id))).data();

/** Updates a charge in a transaction (change of unit: the old unit's pro-rated month). */
export const updateChargeInTx = (tx, id, fields) => tx.update(coll('rent_charges').doc(id), fields);

/** Move-out reads in a transaction; returns the writes (+ `fields`, `snap`: the link). @throws {Error} 'later_paid' */
export async function endInTx(tx, lease, endMonth) {
    const later = await Promise.all(monthRange(addMonths(endMonth, 1), lease.chargedThrough).map(m => tx.get(coll('rent_charges').doc(chargeId(lease.id, m)))));
    if (later.some(hasPayment)) throw new Error('later_paid');
    const pub = await readPublic(tx, lease);
    return (fields = {}, snap = (s) => withLease(s, { ...lease, status: 'ended', endMonth })) => {
        const by = { updatedAt: Date.now(), updatedBy: uid() };
        later.filter(s => s.exists).forEach(s => tx.delete(s.ref));
        tx.update(coll('rent_leases').doc(lease.id), { status: 'ended', endMonth, chargedThrough: endMonth, ...fields, ...by });
        if (pub) tx.set(pub.ref, snap(pub.data));
        tx.update(coll('rent_units').doc(lease.unitId), { leaseId: null, ...by });
        return later.length;
    };
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

const REFUSED = ['permission-denied', 'aborted', 'failed-precondition'];
let skew = 0;

/** Server clock − device clock from the hosting response's Date header (kept when unavailable). */
async function syncClock() {
    try {
        const at = Date.parse((await fetch('/', { method: 'HEAD', cache: 'no-store' })).headers.get('date'));
        if (at) skew = at - Date.now();
    } catch (_) { /* offline */ }
}

/**
 * Runs a receipt write `run(year)` up to 3 times. Refused: someone took the number
 * first, or the device's year isn't the server's IST year (the rules'): read the
 * server's clock once and try again.
 */
export async function receiptRetry(run) {
    for (let i = 0; ; i++) {
        try {
            return await withPendingRetry(() => run(istYear(Date.now() + skew)));
        } catch (e) {
            if (!REFUSED.includes(e?.code) || i === 2) throw e;
            console.warn('Receipt not issued, trying again:', e.code);
            if (!i) await syncClock();
        }
    }
}

/**
 * Records a payment on one month's charge (transaction; never more than is due).
 * With `rc` ({place, ut} for the receipt) the same transaction issues its receipt.
 * Still refused after the retries: saved without one (`noReceipt`, `receiptError` = the
 * last error code; issueReceipt later).
 * @returns {Promise<{amount: number, paid: number, open: boolean, receipt: ?Object, noReceipt?: boolean, receiptError?: string}>}
 */
export async function recordPayment(id, entry, rc = null) {
    let refused = '';
    if (rc) {
        try {
            return await receiptRetry((year) => recordPaymentOnce(id, entry, rc, year));
        } catch (e) {
            if (!REFUSED.includes(e?.code)) throw e;
            refused = e.code;
        }
    }
    const res = await withPendingRetry(() => recordPaymentOnce(id, entry, null));
    return { ...res, noReceipt: !!rc, ...(refused ? { receiptError: refused } : {}) };
}

export const clip = (v, n) => String(v || '').slice(0, n);

/** In a transaction: the year's next receipt number (read before any write). */
export const nextSeq = async (tx, year) => (Number((await tx.get(coll('rent_counters').doc(`receipts_${year}`))).data()?.last) || 0) + 1;

/** In a transaction, after its reads: receipt of entry `pi` of charge `ch` (as written) and the counter move. */
export function putReceipt(tx, id, ch, pi, rc, year, seq, extra = {}) {
    const e = ch.payments[pi];
    const rid = `${id}_${pi}`;
    const now = Date.now();
    const r = {
        no: e.rno, year, seq, chargeId: id, pi,
        leaseId: ch.leaseId, tenantId: ch.tenantId, unitId: ch.unitId, propertyId: ch.propertyId,
        tenantName: ch.tenantName || '', place: clip(rc.place, 150), ...(rc.ut ? { ut: rc.ut } : {}),
        ...receiptAmounts(ch, e), mode: e.mode, ref: e.ref || '', date: e.date,
        by: e.by, byName: e.byName || '', ...extra, createdAt: FirebaseService.serverTimestamp(), void: false
    };
    tx.set(coll('rent_receipts').doc(rid), r);
    tx.set(coll('rent_counters').doc(`receipts_${year}`), { last: seq, rid, updatedAt: now, updatedBy: uid() });
    return { id: rid, ...r, createdAt: now };
}

async function recordPaymentOnce(id, { amount, mode, ref, date }, rc, year) {
    const db = FirebaseService.db;
    const chargeRef = coll('rent_charges').doc(id);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(chargeRef);
        if (!snap.exists) throw new Error('missing');
        const charge = snap.data();
        const leaseSnap = await tx.get(coll('rent_leases').doc(charge.leaseId));
        // RENT-16: more than is due on the lease's latest month is carried to the next month.
        const l = leaseSnap.data();
        const next = applyPayment(charge, amount, l?.status === 'active' && l.chargedThrough === charge.month);
        const pub = leaseSnap.exists ? await readPublic(tx, leaseSnap.data(), true) : null;
        const seq = rc && Number.isFinite(charge.rent) ? await nextSeq(tx, year) : 0;
        const now = Date.now();
        const e = {
            amount: next.amount, ...(next.adv ? { adv: next.adv } : {}), mode, ref: clip(ref, 60), date,
            at: now, by: uid(), byName: clip(AppState.userName, 80),
            ...(seq ? { rno: receiptNo(year, seq) } : {})
        };
        const ch = { ...charge, paid: next.paid, open: next.open, payments: [...(charge.payments || []), e], ...(next.adv ? { adv: next.carried } : {}) };
        tx.update(chargeRef, { paid: ch.paid, open: ch.open, payments: ch.payments, ...(next.adv ? { adv: ch.adv } : {}), updatedAt: now, updatedBy: uid() });
        if (pub) tx.set(pub.ref, withMonth(pub.data, ch, now, pub.old));
        return { ...next, receipt: seq ? putReceipt(tx, id, ch, ch.payments.length - 1, rc, year, seq) : null };
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
        const pub = leaseSnap.exists ? await readPublic(tx, leaseSnap.data(), true) : null;
        const now = Date.now();
        tx.update(chargeRef, { electricity: meter, amount: next.amount, open: next.open, updatedAt: now, updatedBy: uid() });
        tx.update(coll('rent_units').doc(unitId), { lastReading: meter.curr, meterRate: meter.rate, meterCharge: id, updatedAt: now, updatedBy: uid() });
        if (pub) tx.set(pub.ref, withMonth(pub.data, { ...charge, electricity: meter, amount: next.amount, open: next.open }, now, pub.old));
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
