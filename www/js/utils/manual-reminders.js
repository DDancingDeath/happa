/**
 * @fileoverview Manual reminders on Today (#86): checks before saving and
 * how they are grouped. Pure: no DOM, no Firestore. "Today" is the phone's
 * local day (India); due dates are 'YYYY-MM-DD'. Spec: docs/calculations.md REM-5.
 * @module utils/manual-reminders
 */

import { parseLocalDate, addLocalDays, toLocalISODate } from './dates.js';

export const REMINDER_TITLE_MAX = 120;
export const REMINDER_PARTY_MAX = 80;
/** Reminders listed as "coming up" this many days ahead; later ones are only counted. */
export const REMINDER_AHEAD_DAYS = 7;
/** Furthest a due date may be set (firestore.rules allow a little more). */
export const REMINDER_MAX_DAYS_AHEAD = 730;
/** Open reminders the app keeps listening to. */
export const REMINDER_LISTEN_LIMIT = 50;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Checks a new reminder; the trimmed fields to save, or the i18n key of what is wrong.
 * @param {{title?: string, dueDate?: string, party?: string}} input
 * @param {string} todayIso the phone's local date
 * @returns {{ok: true, value: {title: string, dueDate: string, party: string}} | {ok: false, error: string}}
 */
export function checkReminder({ title, dueDate, party } = {}, todayIso) {
    const t = String(title || '').trim().replace(/\s+/g, ' ');
    const p = String(party || '').trim().replace(/\s+/g, ' ');
    if (!t) return { ok: false, error: 'msg.reminders.title_needed' };
    if (t.length > REMINDER_TITLE_MAX) return { ok: false, error: 'msg.reminders.title_long' };
    if (p.length > REMINDER_PARTY_MAX) return { ok: false, error: 'msg.reminders.party_long' };
    if (!ISO.test(String(dueDate || '')) || !parseLocalDate(dueDate) || toLocalISODate(parseLocalDate(dueDate)) !== dueDate) {
        return { ok: false, error: 'msg.reminders.date_needed' };
    }
    if (dueDate < todayIso) return { ok: false, error: 'msg.reminders.date_past' };
    if (dueDate > toLocalISODate(addLocalDays(parseLocalDate(todayIso), REMINDER_MAX_DAYS_AHEAD))) return { ok: false, error: 'msg.reminders.date_far' };
    return { ok: true, value: { title: t, dueDate, party: p } };
}

/**
 * Whole local days from `todayIso` to `dueIso` (negative = late).
 * @returns {?number}
 */
export function daysUntil(dueIso, todayIso) {
    const a = parseLocalDate(todayIso);
    const b = parseLocalDate(dueIso);
    if (!a || !b) return null;
    return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
}

/**
 * REM-5: open reminders split into due (date today or earlier: most late first),
 * coming up (next 7 days, soonest first) and the count of later ones.
 * @param {Array<{id: string, title: string, dueDate: string, status?: string}>} list
 * @param {string} todayIso
 * @returns {{due: Array<Object>, soon: Array<Object>, later: number}} rows carry `days` (daysUntil)
 */
export function groupReminders(list, todayIso) {
    const open = (list || []).filter(r => r && (r.status === undefined || r.status === 'open') && ISO.test(String(r.dueDate || '')))
        .map(r => ({ ...r, days: daysUntil(r.dueDate, todayIso) }))
        .filter(r => r.days !== null)
        .sort((a, b) => a.days - b.days || String(a.title).localeCompare(String(b.title)));
    return {
        due: open.filter(r => r.days <= 0),
        soon: open.filter(r => r.days > 0 && r.days <= REMINDER_AHEAD_DAYS),
        later: open.filter(r => r.days > REMINDER_AHEAD_DAYS).length
    };
}
