/**
 * @fileoverview Review flags for misuse (#124), the pure part: which refused
 * writes to record, how often, whether a sign-in is from a new phone, and the
 * anomaly rules the owner's daily scan runs over the audit log (utils/anomalies.js).
 * No Firestore, AppState or DOM.
 * @module utils/security-flags
 */

/** Audit actions written by services/security-monitor.js. */
export const SECURITY_ACTIONS = Object.freeze({
    DENIED: 'PERMISSION_DENIED',
    NEW_DEVICE: 'NEW_DEVICE',
    OLD_BILL_TRY: 'OLD_BILL_EDIT_TRY'
});

/** Different bills past their edit window one person tries in a day before a (low) flag. */
export const OLD_BILL_TRIES_PER_DAY = 3;

/** Audit entries the owner's daily scan reads per scanned day at most (paged). */
export const AUDIT_PER_DAY = 1000;

/**
 * How many audit entries the daily scan may read for [from, to).
 * @param {number} from - ms
 * @param {number} to - ms
 * @returns {number}
 */
export const auditScanCap = (from, to) => Math.max(1, Math.ceil((to - from) / 86400000)) * AUDIT_PER_DAY;

// "x (doc) transaction" is a read inside a transaction; the transaction itself is "transaction"
const WRITE_OPS = ['set', 'update', 'delete', 'add'];

/**
 * Collections whose refused writes are expected or can't be recorded: the audit
 * log itself (would loop), error reports and app health (written by every phone,
 * refused for removed users), and the stock checkpoint's scan state (members'
 * phones try it and are refused by design).
 */
const IGNORED = new Set(['auditLogs', 'telemetry', 'tipHealth', 'tipFailures', 'stockCheckpoints', 'deviceLog']);

/**
 * The write a refused Firestore call was, as "collection op" (dev_ dropped), or
 * null when it is a read or should not be recorded.
 * @param {string} source - firestore-meter sourceLabel(), e.g. "purchases (doc) update", "batch commit"
 * @returns {string|null}
 */
export function deniedWriteSource(source) {
    const s = String(source || '').trim();
    // Batches and transactions carry no collection, and several of the app's own are
    // refused by design (backfill, stale marks, checkpoint leases): not recorded.
    const m = /^(\S+)(?: \(doc\))? (\w+)$/.exec(s);
    if (!m || !WRITE_OPS.includes(m[2])) return null;
    const coll = m[1].replace(/^dev_/, '').split('/')[0];
    if (IGNORED.has(coll)) return null;
    return `${m[1].replace(/^dev_/, '')} ${m[2]}`.slice(0, 100);
}

/**
 * The same kind at most once per `perSourceMs`, and at most `maxPerWindow` entries in
 * `windowMs` in all: a repeated refusal still reaches the default flag (3 in 10 min).
 */
export const DENIED_NOTE_LIMITS = Object.freeze({ windowMs: 10 * 60 * 1000, perSourceMs: 2 * 60 * 1000, maxPerWindow: 5 });

/**
 * Whether to write an audit entry for this refused write (so a looping refusal
 * can't flood the log or the write quota).
 * @param {Array<{source: string, at: number}>} recent - entries written by this phone
 * @param {string} source
 * @param {number} now
 * @returns {{note: boolean, recent: Array<{source: string, at: number}>}}
 */
export function planDeniedNote(recent, source, now, limits = DENIED_NOTE_LIMITS) {
    const kept = (recent || []).filter(r => now - r.at < limits.windowMs && r.at <= now);
    const sameSoon = kept.some(r => r.source === source && now - r.at < limits.perSourceMs);
    if (kept.length >= limits.maxPerWindow || sameSoon) return { note: false, recent: kept };
    return { note: true, recent: [...kept, { source, at: now }] };
}

/** Phones remembered per person (users/{uid}.devices; the rules allow 10). */
export const MAX_DEVICES = 10;

/** New phones are only remembered, not flagged, during the first days of a person's list. */
export const DEVICE_GRACE_DAYS = 14;

/** A list entry: the device id and the day it was first seen ("abc123xyz:20261101"). */
export const deviceEntry = (deviceId, dayKey) => `${deviceId}:${String(dayKey || '').replace(/-/g, '')}`;

const entryId = (e) => String(e).split(':')[0];
const entryDay = (e) => {
    const m = /:(\d{4})(\d{2})(\d{2})$/.exec(String(e));
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
};

/**
 * Sign-in on this phone: is it new for this person, and is that worth a flag?
 * Phones are only remembered (no flag) until the person's list is
 * DEVICE_GRACE_DAYS old, so the phones everyone already uses when this starts
 * are not flagged.
 * @param {*} devices - the profile's `devices`
 * @param {string} deviceId
 * @param {string} dayKey - today, YYYY-MM-DD
 * @returns {{isNew: boolean, flag: boolean, entry: string, full: boolean, next: string[]}}
 */
export function deviceCheck(devices, deviceId, dayKey) {
    const list = Array.isArray(devices) ? devices.filter(d => typeof d === 'string') : [];
    const entry = deviceEntry(deviceId, dayKey);
    if (!deviceId || list.some(e => entryId(e) === deviceId)) return { isNew: false, flag: false, entry, full: false, next: list };
    const oldest = Math.min(...list.map(entryDay).filter(Number.isFinite));
    const today = entryDay(entry);
    const flag = Number.isFinite(oldest) && Number.isFinite(today) && today - oldest >= DEVICE_GRACE_DAYS * 86400000;
    return { isNew: true, flag, entry, full: list.length >= MAX_DEVICES, next: [...list, entry].slice(-MAX_DEVICES) };
}

/**
 * Clusters of refused writes: `count` or more entries by one person within
 * `windowMin` minutes. One cluster per run of entries (anchored on its first).
 * @param {Array<Object>} logs - audit entries ({id, action, userId, userName, timestamp, details})
 * @param {{deniedCount: number, deniedWindowMin: number}} t
 * @returns {Array<{first: Object, entries: Array<Object>}>}
 */
export function deniedClusters(logs, t) {
    const count = Math.max(1, Math.round(Number(t?.deniedCount) || 3));
    const windowMs = Math.max(1, Number(t?.deniedWindowMin) || 10) * 60000;
    const byUser = new Map();
    (logs || []).filter(l => l && l.action === SECURITY_ACTIONS.DENIED && l.id != null && Number.isFinite(Number(l.timestamp)))
        .forEach(l => {
            const k = String(l.userId || '');
            if (!byUser.has(k)) byUser.set(k, []);
            byUser.get(k).push(l);
        });
    const out = [];
    byUser.forEach(list => {
        list.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
        let i = 0;
        while (i < list.length) {
            const start = Number(list[i].timestamp);
            let j = i;
            while (j + 1 < list.length && Number(list[j + 1].timestamp) - start <= windowMs) j++;
            if (j - i + 1 >= count) {
                out.push({ first: list[i], entries: list.slice(i, j + 1) });
                i = j + 1;
            } else {
                i++;
            }
        }
    });
    return out;
}
