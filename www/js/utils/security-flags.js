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

// "x (doc) transaction" is a read inside a transaction; the transaction itself is "transaction"
const WRITE_OPS = ['set', 'update', 'delete', 'add'];

/**
 * Collections whose refused writes are expected or can't be recorded: the audit
 * log itself (would loop), error reports and app health (written by every phone,
 * refused for removed users), and the stock checkpoint's scan state (members'
 * phones try it and are refused by design).
 */
const IGNORED = new Set(['auditLogs', 'telemetry', 'tipHealth', 'tipFailures', 'stockCheckpoints']);

/**
 * The write a refused Firestore call was, as "collection op" (dev_ dropped), or
 * null when it is a read or should not be recorded.
 * @param {string} source - firestore-meter sourceLabel(), e.g. "purchases (doc) update", "batch commit"
 * @returns {string|null}
 */
export function deniedWriteSource(source) {
    const s = String(source || '').trim();
    if (s === 'batch commit' || s === 'transaction') return s;
    const m = /^(\S+)(?: \(doc\))? (\w+)$/.exec(s);
    if (!m || !WRITE_OPS.includes(m[2])) return null;
    const coll = m[1].replace(/^dev_/, '').split('/')[0];
    if (IGNORED.has(coll)) return null;
    return `${m[1].replace(/^dev_/, '')} ${m[2]}`.slice(0, 100);
}

/** At most one entry per write kind per window, and at most `maxPerWindow` in all. */
export const DENIED_NOTE_LIMITS = Object.freeze({ windowMs: 10 * 60 * 1000, maxPerWindow: 5 });

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
    if (kept.length >= limits.maxPerWindow || kept.some(r => r.source === source)) return { note: false, recent: kept };
    return { note: true, recent: [...kept, { source, at: now }] };
}

/** Phones remembered per person (users/{uid}.devices; the rules allow 10). */
export const MAX_DEVICES = 10;

/**
 * Sign-in on this phone: is it new for this person, and is that worth a flag?
 * The first phone ever (no list yet, e.g. everyone right after this change) is
 * recorded without a flag.
 * @param {*} devices - the profile's `devices`
 * @param {string} deviceId
 * @returns {{isNew: boolean, flag: boolean, next: string[]}}
 */
export function deviceCheck(devices, deviceId) {
    const list = Array.isArray(devices) ? devices.filter(d => typeof d === 'string') : [];
    if (!deviceId || list.includes(deviceId)) return { isNew: false, flag: false, next: list };
    return { isNew: true, flag: list.length > 0, next: [...list, deviceId].slice(-MAX_DEVICES) };
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
