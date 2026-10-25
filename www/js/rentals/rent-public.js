/**
 * @fileoverview Tenant rent-history link (#170 follow-up): pure builders for the
 * public snapshot `rent_public/{token}` that the read-only page /r/<token> shows.
 * Only what the tenant needs: shop name, their name and unit, and their months.
 * No phone numbers, no other tenants, no ids except the lease id the rules need.
 * @module rentals/rent-public
 */

import { round2 } from '../utils/money.js';
import { chargeDue, chargeStatus, isMonth } from './rent-math.js';

/** Months kept in the snapshot (newest). */
export const PUBLIC_MONTHS = 36;
export const SNAPSHOT_VERSION = 1;
const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;

export const isShareToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);

/** 144 random bits, base64url (24 characters). */
export function newShareToken(cryptoObj = globalThis.crypto) {
    const bytes = new Uint8Array(18);
    cryptoObj.getRandomValues(bytes);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** One month as the tenant sees it (RENT-8). */
export function publicMonth(charge, today = new Date()) {
    const e = charge.electricity;
    const rent = round2(Number.isFinite(charge.rent) ? charge.rent : (Number(charge.amount) || 0) - (Number(e?.amount) || 0));
    const total = round2(Number(charge.amount) || 0);
    const paid = round2(Number(charge.paid) || 0);
    const s = chargeStatus(charge, today);
    const dates = [...new Set((charge.payments || []).map(p => p.date).filter(d => typeof d === 'string'))].sort().slice(-12);
    return {
        m: charge.month,
        rent,
        elec: e ? round2(Number(e.amount) || 0) : 0,
        units: e ? round2(Number(e.units) || 0) : 0,
        total,
        paid,
        due: chargeDue(charge),
        st: s.status === 'paid' ? 'paid' : s.late ? 'late' : s.status,
        pd: dates
    };
}

const byMonth = (a, b) => (a.m < b.m ? -1 : a.m > b.m ? 1 : 0);

/** The lease-level part of the snapshot. */
function leasePart(lease) {
    return {
        rent: round2(Number(lease.rent) || 0),
        dueDay: Number.isInteger(lease.dueDay) ? lease.dueDay : 10,
        ended: lease.status === 'ended',
        endMonth: isMonth(lease.endMonth) ? lease.endMonth : null
    };
}

/** A full snapshot from the lease and its charges (used when a link is made). */
export function buildPublicSnapshot({ lease, tenantName = '', place = '', shopName = '', charges = [], now = Date.now() }) {
    const months = charges.filter(c => c.leaseId === lease.id).map(c => publicMonth(c, new Date(now)))
        .sort(byMonth).slice(-PUBLIC_MONTHS);
    return {
        lid: lease.id,
        v: SNAPSHOT_VERSION,
        shop: String(shopName || '').slice(0, 80),
        tenant: String(tenantName || '').slice(0, 80),
        place: String(place || '').slice(0, 150),
        ...leasePart(lease),
        months,
        updatedAt: now
    };
}

/** Snapshot with one month added or replaced (payment, meter reading, new charge). */
export function withMonth(snap, charge, now = Date.now()) {
    const month = publicMonth(charge, new Date(now));
    const months = (snap.months || []).filter(x => x.m !== month.m).concat(month).sort(byMonth).slice(-PUBLIC_MONTHS);
    return { ...snap, months, updatedAt: now };
}

/** Snapshot after a lease change (rent, due day, move-out: later months dropped). */
export function withLease(snap, lease, now = Date.now()) {
    const part = leasePart(lease);
    const months = (snap.months || []).filter(x => !part.endMonth || x.m <= part.endMonth);
    return { ...snap, ...part, months, updatedAt: now };
}

/**
 * Link for the tenant. Development data (dev_) is marked with ?d=1 so the page
 * reads the dev_ collection; ?emulator=1 is carried for local tests.
 */
export function publicLink(origin, token, { dev = false, emulator = false } = {}) {
    const q = [dev ? 'd=1' : '', emulator ? 'emulator=1' : ''].filter(Boolean).join('&');
    return `${origin}/r/${token}${q ? `?${q}` : ''}`;
}
