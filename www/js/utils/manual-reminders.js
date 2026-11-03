// @ts-check
/**
 * @fileoverview Manual reminders on Today (#86): checks before saving and
 * how they are grouped. Pure: no DOM, no Firestore. "Today" is the phone's
 * local day (India); due dates are 'YYYY-MM-DD'. Spec: docs/calculations.md REM-5.
 * @module utils/manual-reminders
 */

import { parseLocalDate, addLocalDays, toLocalISODate, monthStart, daysInMonth } from './dates.js';

export const REMINDER_TITLE_MAX = 120;
export const REMINDER_PARTY_MAX = 80;
/** Reminders listed as "coming up" this many days ahead; later ones are only counted. */
export const REMINDER_AHEAD_DAYS = 7;
/** Furthest a due date may be set (firestore.rules allow a little more). */
export const REMINDER_MAX_DAYS_AHEAD = 730;
/** Open reminders the app keeps listening to. */
export const REMINDER_LISTEN_LIMIT = 50;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** How a reminder repeats once marked done (absent = once). */
export const REMINDER_REPEATS = Object.freeze(['daily', 'weekly', 'monthly']);
/**
 * @param {*} r
 * @returns {r is string}
 */
export const isReminderRepeat = (r) => REMINDER_REPEATS.includes(r);

/**
 * Day of the month a monthly reminder keeps (1–31), from its due date; null otherwise.
 * @param {string} dueIso
 * @param {?string} repeat
 * @returns {?number}
 */
export function repeatDayFor(dueIso, repeat) {
    if (repeat !== 'monthly') return null;
    const d = parseLocalDate(dueIso);
    return d ? d.getDate() : null;
}

/**
 * Checks a new or edited reminder; the trimmed fields to save, or the i18n key of what is wrong.
 * An edit may keep a due date that has passed meanwhile (`keepDueDate`); a new date can't be in the past.
 * @param {{title?: string, dueDate?: string, party?: string, repeat?: string}} input
 * @param {string} todayIso the phone's local date
 * @param {{keepDueDate?: string, keepRepeatDay?: ?number}} [opts] an edit: the stored date and day of the month,
 *   kept while the date and the monthly repeat stay (a Feb 28 copy of a 31st reminder keeps 31)
 * @returns {{ok: true, value: {title: string, dueDate: string, party: string, repeat: ?string, repeatDay: ?number}} | {ok: false, error: string}}
 */
export function checkReminder({ title, dueDate, party, repeat } = {}, todayIso, { keepDueDate, keepRepeatDay } = {}) {
    const t = String(title || '').trim().replace(/\s+/g, ' ');
    const p = String(party || '').trim().replace(/\s+/g, ' ');
    if (!t) return { ok: false, error: 'msg.reminders.title_needed' };
    if (t.length > REMINDER_TITLE_MAX) return { ok: false, error: 'msg.reminders.title_long' };
    if (p.length > REMINDER_PARTY_MAX) return { ok: false, error: 'msg.reminders.party_long' };
    if (!ISO.test(String(dueDate || '')) || !parseLocalDate(dueDate) || toLocalISODate(/** @type {Date} */ (parseLocalDate(dueDate))) !== dueDate) {
        return { ok: false, error: 'msg.reminders.date_needed' };
    }
    const kept = keepDueDate !== undefined && dueDate === keepDueDate;
    if (!kept && dueDate < todayIso) return { ok: false, error: 'msg.reminders.date_past' };
    if (!kept && dueDate > toLocalISODate(/** @type {Date} */ (addLocalDays(parseLocalDate(todayIso), REMINDER_MAX_DAYS_AHEAD)))) return { ok: false, error: 'msg.reminders.date_far' };
    const r = isReminderRepeat(repeat) ? repeat : null;
    const day = kept && r === 'monthly' && Number.isInteger(keepRepeatDay) && /** @type {number} */ (keepRepeatDay) >= 1 && /** @type {number} */ (keepRepeatDay) <= 31
        ? /** @type {number} */ (keepRepeatDay) : repeatDayFor(/** @type {string} */ (dueDate), r);
    return { ok: true, value: { title: t, dueDate: /** @type {string} */ (dueDate), party: p, repeat: r, repeatDay: day } };
}

/**
 * REM-6: due date of the next copy of a repeating reminder marked done. One period after
 * its due date (daily +1 day, weekly +7 days, monthly the next month on `repeatDay`, or the
 * month's last day when it is shorter), stepping on until it is today or later, so a late
 * one makes one new reminder, not a pile of late ones.
 * @param {string} dueIso
 * @param {?string} repeat
 * @param {string} todayIso
 * @param {?number} [repeatDay] monthly: the day of the month to keep (default: the due date's)
 * @returns {?string} 'YYYY-MM-DD', or null when it does not repeat
 */
export function nextDueDate(dueIso, repeat, todayIso, repeatDay = null) {
    if (!isReminderRepeat(repeat) || !ISO.test(String(dueIso || '')) || !ISO.test(String(todayIso || ''))) return null;
    const due = parseLocalDate(dueIso);
    if (!due) return null;
    const day = Number.isInteger(repeatDay) && /** @type {number} */ (repeatDay) >= 1 && /** @type {number} */ (repeatDay) <= 31 ? /** @type {number} */ (repeatDay) : due.getDate();
    const step = (/** @type {number} */ k) => {
        if (repeat === 'daily') return addLocalDays(due, k);
        if (repeat === 'weekly') return addLocalDays(due, 7 * k);
        const first = /** @type {Date} */ (monthStart(due, k));
        return new Date(first.getFullYear(), first.getMonth(), Math.min(day, daysInMonth(first)));
    };
    const late = Math.max(0, daysUntil(todayIso, dueIso) || 0);
    let k = repeat === 'daily' ? Math.max(1, late) : repeat === 'weekly' ? Math.max(1, Math.floor(late / 7)) : Math.max(1, Math.floor(late / 31));
    for (let i = 0; i < 64; i++, k++) {
        const iso = toLocalISODate(/** @type {Date} */ (step(k)));
        if (iso > dueIso && iso >= todayIso) return iso;
    }
    return null;
}

/**
 * Whole local days from `todayIso` to `dueIso` (negative = late).
 * @param {string} dueIso
 * @param {string} todayIso
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
 * @returns {{due: Array<Rec>, soon: Array<Rec>, later: number}} rows carry `days` (daysUntil)
 */
export function groupReminders(list, todayIso) {
    const open = (list || []).filter(r => r && (r.status === undefined || r.status === 'open') && ISO.test(String(r.dueDate || '')))
        .map(r => ({ ...r, days: /** @type {number} */ (daysUntil(r.dueDate, todayIso)) }))
        .filter(r => r.days !== null)
        .sort((a, b) => a.days - b.days || String(a.title).localeCompare(String(b.title)));
    return {
        due: open.filter(r => r.days <= 0),
        soon: open.filter(r => r.days > 0 && r.days <= REMINDER_AHEAD_DAYS),
        later: open.filter(r => r.days > REMINDER_AHEAD_DAYS).length
    };
}
