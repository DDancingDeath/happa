/**
 * @fileoverview Before → after lines for audit entries (#85): which fields of a
 * shared setting changed, as short text the owner reads in Diagnostics › Audit,
 * and the one-line summary of an entry's details shown there and in Settings.
 * No Firestore, AppState or DOM.
 * @module utils/audit-changes
 */

import { t } from '../i18n/index.js';

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

/**
 * An audit entry's details as one line in the app language (plain text; escape it).
 * @param {Object} details
 * @returns {string}
 */
export function formatAuditDetails(details) {
    if (!details || typeof details !== 'object') return '';
    const d = details;
    const parts = [];
    if (d.refused === true) parts.push(t('ui.settings.audit_refused'));
    if (d.billNumber) parts.push(t('ui.settings.audit_bill', { value: d.billNumber }));
    if (d.amount) parts.push(t('ui.settings.audit_amount', { value: d.amount }));
    if (d.customer) parts.push(t('ui.settings.audit_customer', { value: d.customer }));
    if (d.itemName) parts.push(t('ui.settings.audit_item', { value: d.itemName }));
    if (d.paymentAmount) parts.push(t('ui.settings.audit_payment', { value: d.paymentAmount }));
    if (Array.isArray(d.collections)) parts.push(t('ui.settings.audit_collections', { value: d.collections.join(', ') }));
    if (d.recordsDeleted) parts.push(t('ui.settings.audit_records', { value: d.recordsDeleted }));
    if (has(d.person)) parts.push(t('ui.settings.audit_person', { value: d.person }));
    if (has(d.date)) parts.push(t('ui.settings.audit_date', { value: d.date }));
    if (has(d.openingBalance)) parts.push(t('ui.settings.audit_opening', { value: d.openingBalance }));
    if (has(d.counted)) parts.push(t('ui.settings.audit_counted', { counted: d.counted, expected: has(d.expected) ? d.expected : '—' }));
    if (has(d.from) || has(d.to)) parts.push(t('ui.settings.audit_from_to', { from: has(d.from) ? d.from : '—', to: has(d.to) ? d.to : '—' }));
    if (has(d.reason)) parts.push(t('ui.settings.audit_reason', { value: d.reason }));
    if (has(d.changes)) parts.push(t('ui.settings.audit_changes', { value: d.changes }));
    if (has(d.reports)) parts.push(t('ui.settings.audit_reports', { value: d.reports }));
    return parts.join(' • ');
}
