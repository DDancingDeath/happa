/**
 * @fileoverview Diagnostics › Status (#119): the rows shown for this phone and
 * the "Copy status" text. Only codes, counts, states and times: no names,
 * phone numbers or amounts. Pure; the page passes everything in.
 * @module utils/status-report
 */

import { t } from '../i18n/index.js';
import { formatDateTimeIN } from './dates.js';

/** Bill kinds in a trace id. */
const TRACE_KIND = { purchase: 'P', retail: 'R', wholesale: 'W' };

/**
 * Trace id of a bill for support (#119): kind letter and document id, nothing else.
 * @param {Object} bill
 * @param {'purchase'|'retail'|'wholesale'} type
 * @returns {string} '' without an id
 */
export function billTraceId(bill, type) {
    const id = bill?.id;
    if (id === undefined || id === null || id === '') return '';
    return `${TRACE_KIND[type] || 'X'}-${String(id)}`;
}

/**
 * @typedef {Object} PhoneStatus
 * @property {string} appVersion
 * @property {string} buildId
 * @property {string} deviceId
 * @property {boolean} online
 * @property {?string} connection effectiveType ('4g', …) or null
 * @property {number} pending changes not yet on the server
 * @property {?number} lastSyncAt ms
 * @property {{state: string, lastErrorKind: ?string, mayHavePrinted: boolean}} printer
 * @property {number} reads
 * @property {number} writes
 * @property {number} writeErrors
 * @property {number} readErrors
 * @property {number} errors
 * @property {?number} openedAt ms (reads are counted from here)
 */

/**
 * Status rows in the app language. `code: true` rows are ids/versions (shown as codes).
 * @param {PhoneStatus} s
 * @returns {Array<{key: string, label: string, value: string, code?: boolean}>}
 */
export function statusRows(s) {
    const num = (v) => String(Math.max(0, Math.round(Number(v) || 0)));
    const network = s.online
        ? (s.connection ? t('ui.status.online_type', { type: s.connection }) : t('ui.status.online'))
        : t('ui.status.offline');
    const printer = t(`ui.status.printer_${s.printer?.state || 'none'}`)
        + (s.printer?.mayHavePrinted ? ` · ${t('ui.status.printer_uncertain')}` : '')
        + (s.printer?.lastErrorKind ? ` · ${t('ui.status.printer_had_error')}` : '');
    const rows = [
        { key: 'version', label: t('ui.status.version'), value: String(s.appVersion || ''), code: true },
        { key: 'build', label: t('ui.status.build'), value: String(s.buildId || ''), code: true },
        { key: 'device', label: t('ui.status.device'), value: String(s.deviceId || ''), code: true },
        { key: 'network', label: t('ui.status.network'), value: network },
        { key: 'pending', label: t('ui.status.pending'), value: num(s.pending) },
        { key: 'last_sync', label: t('ui.status.last_sync'), value: s.lastSyncAt ? formatDateTimeIN(new Date(s.lastSyncAt)) : t('ui.status.not_this_session') },
        { key: 'printer', label: t('ui.status.printer'), value: printer },
        { key: 'reads', label: t('ui.status.reads'), value: num(s.reads) },
        { key: 'writes', label: t('ui.status.writes'), value: num(s.writes) },
        { key: 'write_errors', label: t('ui.status.write_errors'), value: num(s.writeErrors) },
        { key: 'read_errors', label: t('ui.status.read_errors'), value: num(s.readErrors) },
        { key: 'errors', label: t('ui.status.errors'), value: num(s.errors) }
    ];
    if (s.openedAt) rows.push({ key: 'opened', label: t('ui.status.opened'), value: formatDateTimeIN(new Date(s.openedAt)) });
    return rows;
}

/** One line per suspect: title, then what to do. */
export function speedLines(speed) {
    if (!speed) return [];
    const lines = [t('ui.speed.score', { score: speed.score })];
    if (!speed.suspects.length) lines.push(t('ui.speed.all_clear'));
    speed.suspects.slice(0, 3).forEach(s => {
        const params = s.params?.list ? { ...s.params, list: t(`ui.speed.list_${s.params.list}`) } : s.params;
        lines.push(`- ${t(`ui.speed.${s.id}`, params)}: ${t(`ui.speed.${s.id}_fix`, params)}`);
    });
    return lines;
}

/**
 * Plain text for "Copy status" (support), app language.
 * @param {PhoneStatus} s
 * @param {?{score: number, suspects: Array}} [speed] last speed check
 * @param {number} [now]
 * @returns {string}
 */
export function statusText(s, speed = null, now = Date.now()) {
    const lines = [t('ui.status.copy_title', { at: formatDateTimeIN(new Date(now)) })];
    statusRows(s).forEach(r => lines.push(`${r.label}: ${r.value}`));
    if (speed) {
        lines.push('', t('ui.speed.title'));
        speedLines(speed).forEach(l => lines.push(l));
    }
    lines.push('', t('ui.status.copy_note'));
    return lines.join('\n');
}
