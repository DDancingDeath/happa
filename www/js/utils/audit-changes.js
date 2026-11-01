/**
 * @fileoverview Before → after lines for audit entries (#85): which fields of a
 * shared setting changed, as short text the owner reads in Diagnostics › Audit,
 * and the one-line summary of an entry's details shown there and in Settings.
 * No Firestore, AppState or DOM.
 * @module utils/audit-changes
 */

import { t, getLang } from '../i18n/index.js';

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

const has = (v) => v !== undefined && v !== null && v !== '';

/** Labels of an EXPORT entry's kind and format (#103). */
const EXPORT_KIND_KEYS = {
    day: 'ui.statements.day_book', month: 'ui.statements.month', party: 'ui.statements.party', item: 'ui.statements.item',
    csv: 'ui.statements.csv', accountant: 'ui.statements.accountant', audit: 'ui.admin.col_audit_logs', errors: 'ui.diag.tab_errors'
};
const EXPORT_FORMAT_KEYS = { csv: 'ui.statements.download_csv', whatsapp: 'ui.statements.whatsapp', print: 'ui.statements.print', json: 'ui.export.format_file' };

/**
 * An audit entry's details as one line in the app language (plain text; escape it).
 * @param {Object} details
 * @param {string} [action] - the entry's action code (a refused write's `source` reads "Refused")
 * @returns {string}
 */
export function formatAuditDetails(details, action, lang = getLang()) {
    const tl = (k, p) => t(k, p, lang);
    if (!details || typeof details !== 'object') return '';
    const d = details;
    const parts = [];
    if (d.outcome === 'refused' || d.refused === true) parts.push(tl('ui.settings.audit_refused'));
    if (d.billNumber) parts.push(tl('ui.settings.audit_bill', { value: d.billNumber }));
    if (d.amount) parts.push(tl('ui.settings.audit_amount', { value: d.amount }));
    if (d.customer) parts.push(tl('ui.settings.audit_customer', { value: d.customer }));
    if (d.itemName) parts.push(tl('ui.settings.audit_item', { value: d.itemName }));
    if (d.paymentAmount) parts.push(tl('ui.settings.audit_payment', { value: d.paymentAmount }));
    if (Array.isArray(d.collections)) parts.push(tl('ui.settings.audit_collections', { value: d.collections.join(', ') }));
    if (d.recordsDeleted) parts.push(tl('ui.settings.audit_records', { value: d.recordsDeleted }));
    if (has(d.person)) parts.push(tl('ui.settings.audit_person', { value: d.person }));
    if (has(d.date)) parts.push(tl('ui.settings.audit_date', { value: d.date }));
    if (has(d.openingBalance)) parts.push(tl('ui.settings.audit_opening', { value: d.openingBalance }));
    if (has(d.counted)) parts.push(tl('ui.settings.audit_counted', { counted: d.counted, expected: has(d.expected) ? d.expected : '—' }));
    if (has(d.from) || has(d.to)) parts.push(tl('ui.settings.audit_from_to', { from: has(d.from) ? d.from : '—', to: has(d.to) ? d.to : '—' }));
    if (has(d.reason)) parts.push(tl('ui.settings.audit_reason', { value: d.reason }));
    if (has(d.changes)) parts.push(tl('ui.settings.audit_changes', { value: d.changes }));
    if (has(d.reports)) parts.push(tl('ui.settings.audit_reports', { value: d.reports }));
    if (has(d.recordsChecked)) parts.push(tl('ui.settings.audit_records', { value: d.recordsChecked }));
    // #103 exports
    if (has(d.exportKind)) parts.push(tl('ui.settings.audit_export', { kind: tl(EXPORT_KIND_KEYS[d.exportKind] || 'ui.export.kind_other'), format: tl(EXPORT_FORMAT_KEYS[d.format] || 'ui.export.format_file') }));
    if (has(d.rows)) parts.push(tl('ui.settings.audit_rows', { value: d.rows }));
    if (['started', 'done', 'cancelled', 'failed'].includes(d.exportStatus)) parts.push(tl(`ui.export.status_${d.exportStatus}`));
    // #124 security entries
    if (has(d.source)) parts.push(tl(action === 'PERMISSION_DENIED' ? 'ui.settings.audit_source' : 'ui.settings.audit_from', { value: d.source }));
    if (d.what === 'edit' || d.what === 'void') parts.push(tl(d.what === 'void' ? 'ui.settings.audit_tried_void' : 'ui.settings.audit_tried_edit'));
    if (has(d.billId) && !d.billNumber) parts.push(tl('ui.settings.audit_bill', { value: d.billId }));
    if (has(d.device)) parts.push(tl('ui.settings.audit_device', { value: d.device }));
    return parts.join(' • ');
}

/**
 * Profiles by user id: `{id, name, role}` list (or a Map) → Map(id → {name, role}).
 * @param {Array<Object>|Map} people
 * @returns {Map<string, {name: string, role: string}>}
 */
export function peopleById(people) {
    if (people instanceof Map) return people;
    const m = new Map();
    (Array.isArray(people) ? people : []).forEach(p => {
        if (p && p.id) {
            m.set(String(p.id), {
                name: String(p.name || '').trim(), role: String(p.role || ''), email: String(p.email || '').trim(),
                removed: ['disabled', 'rejected'].includes(p.status) || !p.role
            });
        }
    });
    return m;
}

/**
 * Who wrote an audit entry. The rules make `userId` the writer's own uid, but the
 * stored `userName` / `userRole` are whatever the phone sent (#85): the profile's
 * name, role and email are shown (a person may rename themselves, but not change their email
 * or role); the stored ones only when they differ or there is no profile (or it has no name).
 * @param {Object} log
 * @param {Map<string, {name: string, role: string, email?: string}>} people
 * @returns {{name: string, role: string, email: string, removed: boolean, verified: boolean, sent: string}}
 *   `role` is the person's role now; `removed`: removed or rejected since; `sent`: the stored name when
 *   it is not the profile's ('' otherwise)
 */
export function auditWho(log, people) {
    const stored = String(log?.userName || '').trim();
    const profile = people instanceof Map ? people.get(String(log?.userId || '')) : null;
    if (profile && profile.name) {
        return {
            name: profile.name, role: profile.role, email: profile.email || '', removed: !!profile.removed,
            verified: true, sent: stored && stored !== profile.name ? stored : ''
        };
    }
    return { name: stored, role: String(log?.userRole || ''), email: '', removed: false, verified: false, sent: stored };
}

/**
 * The "who" line of an audit card as plain text (escape it): `main` = profile name
 * (role) email, or the stored name marked as not checked; `note` = the stored name when it
 * differs from the profile's.
 * @param {{name: string, role: string, verified: boolean, sent: string}} who - auditWho()
 * @param {function(string): string} roleLabel
 * @returns {{main: string, note: string}}
 */
export function auditWhoText(who, roleLabel, lang = getLang()) {
    const tl = (k, p) => t(k, p, lang);
    const role = who.verified && who.removed ? tl('ui.settings.audit_removed') : roleLabel(who.role);
    if (!who.verified) return { main: tl('ui.settings.audit_unverified', { name: `${who.name || '—'} (${role})` }), note: '' };
    const email = who.email ? ` ${who.email}` : '';
    return { main: `${who.name} (${role})${email}`, note: who.sent ? tl('ui.settings.audit_unverified', { name: who.sent }) : '' };
}
