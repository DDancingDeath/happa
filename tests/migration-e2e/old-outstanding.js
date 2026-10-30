/**
 * What the OLD app's Outstanding pages showed, worked out from the old backup
 * independently of tools/migrate and of the app's aging code (only the spec
 * oracle's bill readers, tests/oracle/oracle.js, which import nothing from www/):
 *
 * - Outstanding (retail): every retail bill not cleared with a due left
 *   (nested payment.due, else dueAmount; overpaid = nothing due);
 * - Wholesale › Outstanding: bills made on the Wholesale page (source
 *   'sales-tab') not cleared, due = payment.due, or total − received when
 *   payment.due is 0 or missing;
 * - parties grouped by name ignoring case, extra spaces and Unicode form;
 * - age in IST calendar days from the bill's time (timestamp, else date, else
 *   createdAt) to `today`, in the groups 0–30, 31–60, 61–90 and 90+ (no date = 90+).
 */
import { openDue, r2, timeOf } from '../oracle/oracle.js';

const DUE_EPSILON = 0.005;
export const BUCKETS = [['0-30', 30], ['31-60', 60], ['61-90', 90], ['90+', Infinity]];

export const partyKey = (name) => String(name ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

/** Bill time in ms (timestamp, date, createdAt; tagged backup timestamps too). */
export function billTime(bill) {
    for (const v of [bill.timestamp, bill.date, bill.createdAt]) {
        if (v === undefined || v === null || v === '') continue;
        if (typeof v === 'object') {
            const ms = typeof v.millis === 'number' ? v.millis : typeof v.toMillis === 'function' ? v.toMillis() : (v.seconds ?? v._seconds) * 1000;
            if (Number.isFinite(ms)) return ms;
            continue;
        }
        const t = timeOf(v);
        if (Number.isFinite(t)) return t;
    }
    return null;
}

/** Whole local (IST) calendar days from `ms` to `today`; null when unknown. */
export function ageDays(ms, today) {
    if (ms === null) return null;
    const a = new Date(ms);
    const b = new Date(today);
    const d = Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
    return Math.max(0, d);
}

export const bucketOf = (days) => (days === null ? '90+' : BUCKETS.find(([, max]) => days <= max)[0]);

function wholesaleDue(b) {
    if (b.cleared) return 0;
    const p = b.payment || {};
    return Number(p.due) || (Number(b.total) || 0) - (Number(p.online) || 0) - (Number(p.cash) || 0);
}

/** Totals, parties and age groups of a list of {due, name, time}. */
export function summarize(entries, today) {
    const buckets = Object.fromEntries(BUCKETS.map(([k]) => [k, { total: 0, count: 0 }]));
    const parties = {};
    let total = 0;
    entries.forEach(e => {
        const days = ageDays(e.time, today);
        const b = buckets[bucketOf(days)];
        b.total = r2(b.total + e.due);
        b.count++;
        const k = partyKey(e.name);
        parties[k] = r2((parties[k] || 0) + e.due);
        total = r2(total + e.due);
    });
    return { total, count: entries.length, parties, buckets };
}

/**
 * @param {{retailSales: Array, wholesaleSales: Array}} bills plain bill objects with `id`
 * @param {number} today ms
 * @returns {{retail: Object, wholesale: Object, bills: Array<Object>}}
 */
export function oldOutstanding(bills, today) {
    const retail = (bills.retailSales || []).filter(b => !b.cleared && openDue(b) > DUE_EPSILON)
        .map(b => ({ id: b.id, billType: 'retail', due: r2(openDue(b)), name: b.customerName, time: billTime(b), billNumber: String(b.billNumber || ''), date: b.date ?? null }));
    const wholesale = (bills.wholesaleSales || []).filter(b => b.source === 'sales-tab' && wholesaleDue(b) > DUE_EPSILON)
        .map(b => ({ id: b.id, billType: 'wholesale', due: r2(wholesaleDue(b)), name: b.customerName, time: billTime(b), billNumber: String(b.billNumber || ''), date: b.date ?? null }));
    return {
        retail: summarize(retail, today),
        wholesale: summarize(wholesale, today),
        bills: [...retail, ...wholesale].map(e => ({ ...e, partyKey: partyKey(e.name), days: ageDays(e.time, today), bucket: bucketOf(ageDays(e.time, today)) }))
    };
}
