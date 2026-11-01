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

/** Shortest name replaced: shorter ones ("Ra") would cut through ordinary words. */
export const MIN_NAME_LENGTH = 3;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A replacer for the shop's people's names (#83): each name, whole words only
 * (any script), any case, becomes <person>; longest names first.
 * @param {Array<string>} names
 * @returns {(text: string) => string}
 */
export function nameScrubber(names) {
    // Each word of a longer name too ("Ram Kumar" → also "Kumar"), when it is long enough to be a name.
    const full = (names || []).map(n => String(n ?? '').trim());
    const words = full.flatMap(n => n.split(/\s+/)).filter(w => w.length > MIN_NAME_LENGTH);
    const list = [...new Set([...full, ...words].filter(n => n.length >= MIN_NAME_LENGTH))]
        .sort((a, b) => b.length - a.length);
    if (!list.length) return (text) => text;
    const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${list.map(escapeRe).join('|')})(?![\\p{L}\\p{M}\\p{N}])`, 'giu');
    return (text) => (typeof text === 'string' ? text.replace(re, '<person>') : text);
}

/**
 * Names found in the reports themselves (who saw each error): scrubbed out even
 * when the team list can't be read.
 * @param {Array<Object>} errors
 * @returns {string[]}
 */
export function reportNames(errors) {
    const out = [];
    (Array.isArray(errors) ? errors : []).forEach(e => {
        if (e?.userName) out.push(e.userName);
        (Array.isArray(e?.occurrences) ? e.occurrences : []).forEach(o => { if (o?.userName) out.push(o.userName); });
    });
    return out;
}

/**
 * @param {Array<Object>} errors grouped telemetry entries (TelemetryService.getTelemetryData)
 * @param {{status?: string, appVersion?: string, buildId?: string, names?: string[]}} [ctx] names: the shop's people, replaced with <person>
 * @returns {{format: string, appVersion: string, buildId: string, status: string, errors: Array<Object>}}
 */
export function buildErrorReport(errors, { status = '', appVersion = '', buildId = '', names = [] } = {}) {
    const people = nameScrubber([...names, ...reportNames(errors)]);
    const clean = (s) => people(scrubText(s));
    return {
        format: 'happa-error-report-v1',
        appVersion: String(appVersion),
        buildId: String(buildId),
        status: clean(String(status)),
        errors: (Array.isArray(errors) ? errors : []).map(e => ({
            type: String(e?.type || ''),
            count: Math.max(1, Number(e?.count) || 1),
            firstSeen: iso(e?.firstSeen ?? e?.lastSeen),
            lastSeen: iso(e?.lastSeen),
            message: clean(String(e?.message || '')),
            source: e?.source ? `${people(scrubUrl(String(e.source)))}:${e.line ?? '?'}` : '',
            stack: e?.stack ? clean(String(e.stack)).slice(0, STACK_MAX) : ''
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
