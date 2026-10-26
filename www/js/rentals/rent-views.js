/**
 * @fileoverview Rentals property-wise / unit-wise views (#170 follow-up): unit
 * types and ONE calculation for the unit rows and every total built from them
 * (property cards, property detail, unit list, page totals). Pure: no DOM,
 * Firestore or AppState. Number definitions: docs/calculations.md RENT-9, RENT-10.
 * @module rentals/rent-views
 */

import { round2 } from '../utils/money.js';
import { chargeDue, chargeStatus } from './rent-math.js';

export const UNIT_TYPES = ['flat', 'commercial', 'office', 'godown', 'other'];
export const MAX_UNIT_AREA = 1000000;
export const VIEW_KEY = 'happa.rentView';
export const UNIT_STATUSES = ['occupied', 'vacant', 'late', 'due'];

/** A unit's type; units saved before types existed count as flats until set. */
export const unitType = (u) => (UNIT_TYPES.includes(u?.type) ? u.type : 'flat');

/**
 * RENT-10: one row per unit for `month`. Charges are attributed by their unitId,
 * so a tenant who moved out this month still counts on the unit they rented.
 * @returns {Array<Object>} rows
 */
export function unitRows({ properties = [], units = [], leases = [], tenants = [], charges = [] }, month, today = new Date()) {
    const props = new Map(properties.map(p => [p.id, p]));
    const tenantsById = new Map(tenants.map(x => [x.id, x]));
    const leaseByUnit = new Map(leases.filter(l => l.status === 'active').map(l => [l.unitId, l]));
    return units.filter(u => !u.archived).map(u => {
        const lease = leaseByUnit.get(u.id) || null;
        const mine = charges.filter(c => c.unitId === u.id && c.month <= month);
        const thisMonth = mine.filter(c => c.month === month);
        const expected = round2(thisMonth.reduce((s, c) => s + (Number(c.amount) || 0), 0));
        const collected = round2(thisMonth.reduce((s, c) => s + (Number(c.paid) || 0), 0));
        const open = mine.filter(c => chargeDue(c) > 0);
        // due keeps everything owed on the unit (also a former tenant's months);
        // Late / Paid / Part paid describe only the tenant living there now.
        const due = round2(open.reduce((s, c) => s + chargeDue(c), 0));
        const ownOpen = lease ? open.filter(c => c.leaseId === lease.id) : [];
        const ownDue = round2(ownOpen.reduce((s, c) => s + chargeDue(c), 0));
        const late = ownOpen.some(c => chargeStatus(c, today).late);
        const current = lease ? thisMonth.find(c => c.leaseId === lease.id) || null : null;
        const status = !lease ? 'vacant'
            : late ? 'late'
            : ownDue <= 0 ? (current ? 'paid' : 'due')
            : (current && (Number(current.paid) || 0) > 0) ? 'partial' : 'due';
        return {
            unitId: u.id,
            propertyId: u.propertyId,
            propertyName: props.get(u.propertyId)?.name || '',
            label: u.label || '',
            type: unitType(u),
            area: Number.isFinite(u.area) ? u.area : null,
            floor: u.floor || '',
            leaseId: lease?.id || null,
            tenantName: lease ? (tenantsById.get(lease.tenantId)?.name || '') : '',
            rent: round2(Number(lease ? lease.rent : u.rent) || 0),
            occupied: !!lease,
            status,
            late,
            expected,
            collected,
            pending: round2(Math.max(0, expected - collected)),
            due
        };
    });
}

/**
 * RENT-9: totals of a set of unit rows (a property, or all). Every total on the
 * Rent page is this sum, so property cards add up to the page totals.
 */
export function summarize(rows) {
    const byType = Object.fromEntries(UNIT_TYPES.map(k => [k, 0]));
    let expected = 0; let collected = 0; let due = 0; let occupied = 0; let late = 0;
    for (const r of rows) {
        byType[r.type] = (byType[r.type] || 0) + 1;
        expected += r.expected;
        collected += r.collected;
        due += r.due;
        if (r.occupied) occupied++;
        if (r.late) late++;
    }
    return {
        units: rows.length,
        byType,
        occupied,
        vacant: rows.length - occupied,
        expected: round2(expected),
        collected: round2(collected),
        pending: round2(Math.max(0, expected - collected)),
        due: round2(due),
        late
    };
}

/** Property cards: one summary per property (properties without units too), in name order. */
export function propertySummaries(properties, rows) {
    return [...properties].sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map(p => ({ property: p, summary: summarize(rows.filter(r => r.propertyId === p.id)) }));
}

/** Rows of one property grouped by unit type (types in UNIT_TYPES order, empty groups left out). */
export function groupByType(rows) {
    return UNIT_TYPES.map(type => ({ type, rows: rows.filter(r => r.type === type).sort((a, b) => a.label.localeCompare(b.label)) }))
        .filter(g => g.rows.length);
}

/**
 * Unit list filters: property, type, status (occupied / vacant / late / due) and a
 * search over unit and tenant names; sorted by amount due (desc by default).
 */
export function filterRows(rows, { propertyId = '', type = '', status = '', q = '', sort = 'desc' } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    const out = rows.filter(r => (!propertyId || r.propertyId === propertyId)
        && (!type || r.type === type)
        && (!status || (status === 'occupied' ? r.occupied
            : status === 'vacant' ? !r.occupied
            : status === 'late' ? r.late
            : status === 'due' ? r.due > 0 : true))
        && (!needle || r.label.toLowerCase().includes(needle) || r.tenantName.toLowerCase().includes(needle)
            || r.propertyName.toLowerCase().includes(needle)));
    const dir = sort === 'asc' ? 1 : -1;
    return out.sort((a, b) => (dir * (a.due - b.due)) || a.propertyName.localeCompare(b.propertyName) || a.label.localeCompare(b.label));
}

/** "2B, Gupta Bhawan" — the unit label and property, without the type word (added per language). */
export function placeText(label, propertyName) {
    return [String(label || '').trim(), String(propertyName || '').trim()].filter(Boolean).join(', ');
}

/**
 * The unit as people say it: "Flat 2B, Gupta Bhawan". The type word is skipped
 * when the label already starts with it ("Shop 3").
 */
export function typedPlace(typeWord, label, propertyName) {
    const l = String(label || '').trim();
    const word = String(typeWord || '').trim();
    const withType = word && !l.toLowerCase().startsWith(word.toLowerCase()) ? `${word} ${l}` : l;
    return placeText(withType, propertyName);
}

/** Size / floor checks for the unit form: '' when fine, else a msg.rent.* key. */
export function unitExtraError({ type, area, floor }) {
    if (type !== undefined && !UNIT_TYPES.includes(type)) return 'msg.rent.bad_unit_type';
    if (area !== null && area !== undefined && area !== '' && (!Number.isFinite(Number(area)) || Number(area) <= 0 || Number(area) > MAX_UNIT_AREA)) {
        return 'msg.rent.bad_area';
    }
    if (floor && String(floor).length > 20) return 'msg.rent.too_long';
    return '';
}
