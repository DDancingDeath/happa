/**
 * @fileoverview The stamp every exported file carries (#103): shop, period,
 * export time and who exported it, in the file name and at the top of the
 * file, plus the audit-row details of an export. Pure: no DOM, no Firestore.
 * @module utils/export-stamp
 */

import { csvCell, isoMinute } from './statements.js';
import { t } from '../i18n/index.js';

/** Export kinds written in the audit row (`details.exportKind`). */
export const EXPORT_KINDS = Object.freeze(['day', 'month', 'party', 'item', 'csv', 'accountant', 'audit', 'errors']);

const text = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

/**
 * @param {{shop?: string, period?: {from?: ?string, to?: ?string, label?: string}, at: number, user?: string}} s
 * @returns {{shop: string, from: string, to: string, label: string, at: number, user: string}}
 */
export function exportStamp({ shop, period = {}, at, user }) {
    return {
        shop: text(shop, 80),
        from: text(period.from, 10),
        to: text(period.to, 10),
        label: text(period.label, 120),
        at: Number(at),
        user: text(user, 80)
    };
}

/**
 * The stamp as label / value pairs, in `lang`.
 * @param {ReturnType<typeof exportStamp>} stamp
 * @param {'en'|'hi'} [lang]
 * @returns {Array<[string, string]>}
 */
export function stampPairs(stamp, lang) {
    const tl = (k) => t(k, null, lang);
    // No from day: everything loaded up to the to day.
    const period = stamp.label || (stamp.from || stamp.to ? `${stamp.from || '…'} – ${stamp.to || '…'}` : '');
    return [
        [tl('ui.export.stamp_shop'), stamp.shop],
        [tl('ui.export.stamp_period'), period],
        [tl('ui.export.stamp_at'), isoMinute(stamp.at)],
        [tl('ui.export.stamp_by'), stamp.user]
    ];
}

/** The stamp as one line ("Shop: … · Period: … · …"), for a shared text or a printed page. */
export function stampLine(stamp, lang) {
    return stampPairs(stamp, lang).map(([k, v]) => `${k}: ${v}`).join(' · ');
}

/**
 * CSV text with the stamp rows on top, a blank row, then the header and rows
 * (RFC 4180 quoting, formulas neutralised, UTF-8 BOM for Excel).
 * @param {string[]} header
 * @param {Array<Array>} rows
 * @param {ReturnType<typeof exportStamp>} stamp
 * @param {'en'|'hi'} [lang]
 * @returns {string}
 */
export function stampedCsv(header, rows, stamp, lang) {
    const lines = [...stampPairs(stamp, lang), [], header, ...rows];
    return `\uFEFF${lines.map(r => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const slug = (s, max) => String(s ?? '').normalize('NFC').replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, max);

/**
 * File name: shop_kind_period_YYYYMMDD-HHmm.ext (letters of any script kept).
 * @param {ReturnType<typeof exportStamp>} stamp
 * @param {string} kind
 * @param {string} ext
 * @returns {string}
 */
export function exportFilename(stamp, kind, ext) {
    const at = isoMinute(stamp.at).replace(/[-:]/g, '').replace(' ', '-');
    const period = [stamp.from, stamp.to].filter(Boolean);
    const span = period.length === 2 && period[0] === period[1] ? [period[0]] : period;
    return [slug(stamp.shop, 40) || 'happa', slug(kind, 20), ...span, at].filter(Boolean).join('_') + `.${ext}`;
}

/** How an export ended (#103): written before the file goes out, then once more when it has. */
export const EXPORT_STATUSES = Object.freeze(['started', 'done', 'cancelled', 'failed']);

/**
 * Audit details of an export (bounded: the rules allow 40 keys).
 * @param {{kind: string, format: string, period?: {from?: ?string, to?: ?string}, rows?: number, status?: string, ref?: string}} e
 *   ref ties the 'started' row to its outcome row
 * @returns {{exportKind: string, format: string, from: ?string, to: ?string, rows: number, exportStatus: string, exportRef: string}}
 */
export function exportAuditDetails({ kind, format, period = {}, rows = 0, status = 'done', ref = '' }) {
    return {
        exportKind: EXPORT_KINDS.includes(kind) ? kind : 'other',
        format: text(format, 16),
        from: text(period.from, 10) || null,
        to: text(period.to, 10) || null,
        rows: Math.max(0, Math.floor(Number(rows) || 0)),
        exportStatus: EXPORT_STATUSES.includes(status) ? status : 'done',
        exportRef: text(ref, 24)
    };
}
