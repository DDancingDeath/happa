/**
 * @fileoverview Before → after lines for audit entries (#85): which fields of a
 * shared setting changed, as short text the owner reads in Diagnostics › Audit.
 * Pure: no Firestore, AppState or DOM.
 * @module utils/audit-changes
 */

const show = (v) => {
    if (v === undefined || v === null || v === '') return '—';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

/**
 * The fields that differ, as "field: before → after" (at most 20, each short).
 * @param {Object} before
 * @param {Object} after
 * @param {string[]} [keys] - fields to compare (default: every key of either)
 * @returns {string[]}
 */
export function changedFields(before = {}, after = {}, keys) {
    const b = before || {};
    const a = after || {};
    const list = keys || [...new Set([...Object.keys(b), ...Object.keys(a)])];
    return list
        .filter(k => JSON.stringify(b[k] ?? null) !== JSON.stringify(a[k] ?? null))
        .slice(0, 20)
        .map(k => `${k}: ${show(b[k])} → ${show(a[k])}`);
}
