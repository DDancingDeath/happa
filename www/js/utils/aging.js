// @ts-check
/**
 * @fileoverview Pure dues-aging helpers for Outstanding (#46): bucket each
 * open bill by its age in local (IST) calendar days, total the buckets, group
 * bills by party (normalized name) and pick who to chase first.
 * No DOM, Firestore or AppState access.
 * @module utils/aging
 */

import { openingAmount, outstandingDue, readPayment, round2 } from './money.js';
import { billDateOf } from './history-filters.js';
import { partyNameKey, partyNameSpelling, pickPartyName } from './parties.js';

/** OVERDUE (OD-08): a bill with a due is overdue when it is more than this many days old. */
export const OVERDUE_DAYS = 30;

/** Days after which a party's oldest due gets the "Over 90 days" badge. */
export const LONG_OVERDUE_DAYS = 90;

export const AGING_BUCKETS = [
    { key: '0-30', label: '0–30', max: OVERDUE_DAYS },
    { key: '31-60', label: '31–60', max: 60 },
    { key: '61-90', label: '61–90', max: 90 },
    { key: '90+', label: '90+', max: Infinity }
];

const DAY_MS = 86400000;
const DUE_EPSILON = 0.005;

/**
 * Outstanding's lists (#125): `purchase` = payables (O1, O3); receivables: `sale` = retail
 * and wholesale together (O2, O4: the same total as Money's "to receive"), `retail`, `wholesale`.
 */
export const DUE_FILTERS = Object.freeze(['purchase', 'sale', 'retail', 'wholesale']);

/**
 * The open bills of one Outstanding list, each with its BILL-DUE (`outstanding`, > ₹0.005,
 * as the aging panel and Money count it), total and paid. Voided and cleared bills owe
 * nothing (`outstandingDue`); OPENING records are kept (a balance only).
 * @param {{purchases?: Array<Rec>, retailSales?: Array<Rec>, wholesaleSales?: Array<Rec>}} src
 * @param {string} filter one of DUE_FILTERS (anything else = `purchase`)
 * @param {{wholesale?: boolean}} [opts] wholesale false: the role can't open Wholesale, so `sale` is retail only
 * @returns {Array<Rec>} copies of the bills with transactionType, outstanding, totalAmount, paidAmount
 */
export function dueRows(src, filter, { wholesale = true } = {}) {
    const lists = /** @type {Array<[string, Array<Rec>|undefined]>} */ (filter === 'retail' ? [['retail', src.retailSales]]
        : filter === 'wholesale' ? (wholesale ? [['wholesale', src.wholesaleSales]] : [])
            : filter === 'sale' ? [['retail', src.retailSales], ...(wholesale ? [['wholesale', src.wholesaleSales]] : [])]
                : [['purchase', src.purchases]]);
    /** @type {Array<Rec>} */
    const rows = [];
    lists.forEach(([type, bills]) => (bills || []).forEach(bill => {
        const due = round2(outstandingDue(bill));
        if (!(due > DUE_EPSILON)) return;
        const pay = readPayment(bill);
        rows.push({
            ...bill,
            transactionType: type,
            outstanding: due,
            totalAmount: (type === 'retail' ? bill.total : pay.total) || openingAmount(bill),
            paidAmount: pay.paid
        });
    }));
    return rows;
}

/**
 * Whole local calendar days from `billDate` to `today` (0 = same day).
 * Uses each date's local Y/M/D so the time of day never shifts the count.
 * @param {Date} billDate
 * @param {Date} [today=new Date()]
 * @returns {number} never negative (future-dated bills count as 0)
 */
export function ageInDays(billDate, today = new Date()) {
    const a = Date.UTC(billDate.getFullYear(), billDate.getMonth(), billDate.getDate());
    const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    return Math.max(0, Math.round((b - a) / DAY_MS));
}

/**
 * Bucket index (0..3) for an age. Unknown age (no usable bill date) goes to
 * the oldest bucket so it is never hidden from the chase list.
 * @param {?number} days
 * @returns {number}
 */
export function bucketIndex(days) {
    if (days === null || days === undefined || !Number.isFinite(days)) return AGING_BUCKETS.length - 1;
    return AGING_BUCKETS.findIndex(b => days <= b.max);
}

// The PARTY rule lives in utils/parties.js; these names stay for existing importers.
export { partyNameKey as normalizePartyName, pickPartyName, partyDisplayNames } from './parties.js';

/**
 * Phone stored on a bill, if any.
 * @param {Rec} bill
 * @returns {string}
 */
function billPhone(bill) {
    const p = bill.customerPhone || bill.phone || bill.mobile || '';
    return String(p).trim();
}

/**
 * @typedef {{key: string, name: string, phone: string, total: number, overdue: number, oldestDays: ?number, bucket: number, longOverdue: boolean,
 *   bills: Array<{id: *, billNumber: string, date: ?Date, days: ?number, bucket: number, due: number}>}} AgingParty
 */

/**
 * Age every open bill and group by party.
 * @param {Array<Rec>} bills Bills of ONE kind (receivables or payables)
 * @param {{today?: Date}} [opts]
 * @returns {{
 *   total: number, count: number, overdue: number, overdueCount: number,
 *   buckets: Array<{key: string, label: string, total: number, count: number}>,
 *   parties: Array<AgingParty>
 * }}
 */
export function buildAging(bills, { today = new Date() } = {}) {
    const buckets = AGING_BUCKETS.map(b => ({ key: b.key, label: b.label, total: 0, count: 0 }));
    /** @type {Map<string, Rec>} */
    const byKey = new Map();
    let total = 0;
    let count = 0;
    let overdue = 0;
    let overdueCount = 0;

    (bills || []).forEach(bill => {
        // BILL-DUE: 0 for cleared and voided bills (#75)
        const due = round2(outstandingDue(bill));
        if (!(due > DUE_EPSILON)) return;
        const date = billDateOf(bill);
        const days = date ? ageInDays(date, today) : null;
        const bucket = bucketIndex(days);

        buckets[bucket].total = round2(buckets[bucket].total + due);
        buckets[bucket].count++;
        total = round2(total + due);
        count++;
        const late = bucket > 0;
        if (late) {
            overdue = round2(overdue + due);
            overdueCount++;
        }

        const rawName = partyNameSpelling(bill.customerName);
        const key = partyNameKey(rawName);
        let party = byKey.get(key);
        if (!party) {
            party = { key, name: rawName, phone: '', total: 0, overdue: 0, oldestDays: 0, bucket: 0, longOverdue: false, bills: [], _latest: -Infinity, _names: new Map() };
            byKey.set(key, party);
        }
        // Most used spelling is the display name (pickPartyName); newest bill decides the phone
        const t = date ? date.getTime() : -Infinity;
        if (rawName) {
            const seen = party._names.get(rawName) || { count: 0, last: -Infinity };
            party._names.set(rawName, { count: seen.count + 1, last: Math.max(seen.last, t) });
        }
        if (t >= party._latest) {
            party._latest = t;
            if (billPhone(bill)) party.phone = billPhone(bill);
        } else if (!party.phone && billPhone(bill)) {
            party.phone = billPhone(bill);
        }
        party.total = round2(party.total + due);
        if (late) party.overdue = round2(party.overdue + due);
        party.bills.push({ id: bill.id, billNumber: String(bill.billNumber || ''), date, days, bucket, due });
    });

    const parties = /** @type {AgingParty[]} */ ([...byKey.values()].map(p => {
        // Oldest first; undated bills (unknown age) lead
        p.bills.sort((/** @type {Rec} */ a, /** @type {Rec} */ b) => (a.date ? a.date.getTime() : -Infinity) - (b.date ? b.date.getTime() : -Infinity));
        const oldest = p.bills[0];
        p.oldestDays = oldest.days;
        p.bucket = oldest.bucket;
        p.longOverdue = oldest.days === null || oldest.days > LONG_OVERDUE_DAYS;
        if (p._names.size) p.name = pickPartyName(p._names);
        delete p._latest;
        delete p._names;
        return p;
    }));

    return { total, count, overdue, overdueCount, buckets, parties };
}

/** Age used for sorting: unknown counts as oldest. */
const sortAge = (/** @type {Rec} */ p) => (p.oldestDays === null ? Infinity : p.oldestDays);

/**
 * Parties sorted by 'amount' (largest due first) or 'age' (oldest due first).
 * Ties fall back to the other measure, then name. Returns a new array.
 * @param {Array<Rec>} parties
 * @param {'amount'|'age'} [by='amount']
 * @returns {Array<Rec>}
 */
export function sortParties(parties, by = 'amount') {
    /** @type {(a: Rec, b: Rec) => number} */
    const byName = (a, b) => a.name.localeCompare(b.name);
    /** @type {(a: Rec, b: Rec) => number} */
    const byAmount = (a, b) => b.total - a.total;
    /** @type {(a: Rec, b: Rec) => number} */
    const byAge = (a, b) => sortAge(b) - sortAge(a);
    const order = by === 'age' ? [byAge, byAmount, byName] : [byAmount, byAge, byName];
    return [...(parties || [])].sort((a, b) => {
        for (const cmp of order) {
            const r = cmp(a, b);
            if (r) return r;
        }
        return 0;
    });
}

/**
 * Who to chase first: parties with an OVERDUE bill (oldest due older than 30 days), oldest
 * bucket first, then the biggest amount.
 * @param {Array<Rec>} parties
 * @param {number} [limit=5]
 * @returns {Array<Rec>}
 */
export function chaseFirst(parties, limit = 5) {
    return [...(parties || [])]
        .filter(p => p.bucket > 0)
        .sort((a, b) => (b.bucket - a.bucket) || (b.total - a.total) || (sortAge(b) - sortAge(a)))
        .slice(0, limit);
}

/**
 * Bills (any shape with a date) that fall in one bucket; all when key is falsy.
 * @param {Array<Rec>} bills
 * @param {?string} bucketKey
 * @param {Date} [today=new Date()]
 * @returns {Array<Rec>}
 */
export function filterBillsByBucket(bills, bucketKey, today = new Date()) {
    const idx = AGING_BUCKETS.findIndex(b => b.key === bucketKey);
    if (idx < 0) return bills || [];
    return (bills || []).filter(bill => {
        const date = billDateOf(bill);
        return bucketIndex(date ? ageInDays(date, today) : null) === idx;
    });
}
