/**
 * @fileoverview Local usage counters (#136): which features are used on this
 * phone, per day. Event names come from the fixed list below, never from user
 * text, so a counter can't hold a name, phone number or amount. Pure: the
 * store (services/usage.js) keeps the rows in IndexedDB on the phone only.
 * Spec: docs/calculations.md USE-1.
 * @module utils/usage-stats
 */

/**
 * Event names (documented; anything else is dropped):
 * - `page.<page id>`: a page was opened (`aadhat:tabshown`, e.g. `page.billing`)
 * - `bill.save.purchases|retailSales|wholesaleSales`: a new bill was saved
 * - `payment.record`: a due payment was recorded on Outstanding
 * - `cash.close`: the cash day was closed
 * - `print.bill`: a bill was sent to the printer
 * - `share.whatsapp`: a bill was shared on WhatsApp
 * - `perf.diagnostic_run`: Diagnostics › Status speed check (#83)
 */
export const USAGE_EVENTS = Object.freeze([
    'bill.save.purchases', 'bill.save.retailSales', 'bill.save.wholesaleSales',
    'payment.record', 'cash.close', 'print.bill', 'share.whatsapp', 'perf.diagnostic_run'
]);

const PAGE_EVENT = /^page\.[a-z][a-z0-9-]{0,39}$/;

/** Days kept on the phone. */
export const USAGE_KEEP_DAYS = 90;

/** @returns {boolean} true for a documented event name */
export function isUsageEvent(name) {
    return typeof name === 'string' && (USAGE_EVENTS.includes(name) || PAGE_EVENT.test(name));
}

/** Store key of one counter. */
export const usageKey = (day, event) => `${day}|${event}`;

/**
 * Adds pending counts into stored rows.
 * @param {Array<{day: string, event: string, count: number}>} rows
 * @param {Map<string, number>} pending usageKey → count
 * @returns {Array} new rows (input untouched)
 */
export function mergeUsage(rows, pending) {
    const byKey = new Map((rows || []).map(r => [usageKey(r.day, r.event), { ...r }]));
    pending.forEach((n, key) => {
        const [day, event] = key.split('|');
        const row = byKey.get(key) || { day, event, count: 0 };
        row.count += n;
        byKey.set(key, row);
    });
    return [...byKey.values()];
}

/**
 * USE-1: uses per event from `fromDay` to `toDay` (YYYY-MM-DD, inclusive), most used first
 * (ties by name), at most `limit`.
 * @param {Array<{day: string, event: string, count: number}>} rows
 * @param {{fromDay: string, toDay: string, limit?: number}} range
 * @returns {Array<{event: string, count: number}>}
 */
export function topUsage(rows, { fromDay, toDay, limit = 10 }) {
    const totals = new Map();
    (rows || []).forEach(r => {
        if (!r || r.day < fromDay || r.day > toDay || !isUsageEvent(r.event)) return;
        totals.set(r.event, (totals.get(r.event) || 0) + (Number(r.count) || 0));
    });
    return [...totals.entries()]
        .map(([event, count]) => ({ event, count }))
        .filter(r => r.count > 0)
        .sort((a, b) => b.count - a.count || (a.event < b.event ? -1 : 1))
        .slice(0, limit);
}

/** Rows older than `oldestDay` (to drop). */
export function expiredUsage(rows, oldestDay) {
    return (rows || []).filter(r => r.day < oldestDay);
}
