/**
 * @fileoverview The error report the owner can export from Diagnostics (#83):
 * the listed error groups with personal data and secrets scrubbed again
 * (#116; reports stored before the scrub existed may still hold some), no
 * user names or ids, plus this phone's status text. Pure.
 * @module utils/error-report
 */

import { scrubText, scrubUrl } from './scrub.js';

/** Characters kept of a stack trace. */
export const STACK_MAX = 1500;

const iso = (v) => {
    const ms = typeof v === 'number' ? v : (v && typeof v.toMillis === 'function' ? v.toMillis() : Date.parse(v));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/**
 * @param {Array<Object>} errors grouped telemetry entries (TelemetryService.getTelemetryData)
 * @param {{status?: string, appVersion?: string, buildId?: string}} [ctx]
 * @returns {{format: string, appVersion: string, buildId: string, status: string, errors: Array<Object>}}
 */
export function buildErrorReport(errors, { status = '', appVersion = '', buildId = '' } = {}) {
    return {
        format: 'happa-error-report-v1',
        appVersion: String(appVersion),
        buildId: String(buildId),
        status: scrubText(String(status)),
        errors: (Array.isArray(errors) ? errors : []).map(e => ({
            type: String(e?.type || ''),
            count: Math.max(1, Number(e?.count) || 1),
            firstSeen: iso(e?.firstSeen ?? e?.lastSeen),
            lastSeen: iso(e?.lastSeen),
            message: scrubText(String(e?.message || '')),
            source: e?.source ? `${scrubUrl(String(e.source))}:${e.line ?? '?'}` : '',
            stack: e?.stack ? scrubText(String(e.stack)).slice(0, STACK_MAX) : ''
        }))
    };
}

/**
 * [oldest, newest] local day (YYYY-MM-DD) of the errors' last-seen times, or nulls.
 * @param {Array<Object>} errors
 * @param {(ms: number) => string} dayOf
 * @returns {{from: ?string, to: ?string}}
 */
export function errorReportPeriod(errors, dayOf) {
    const times = (errors || []).map(e => Date.parse(iso(e?.lastSeen) || '')).filter(Number.isFinite);
    if (!times.length) return { from: null, to: null };
    return { from: dayOf(Math.min(...times)), to: dayOf(Math.max(...times)) };
}
