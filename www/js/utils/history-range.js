// @ts-check
/**
 * @fileoverview Pure helpers for the recent-history window.
 * @module utils/history-window
 */

/**
 * Default start of the window loaded on app open: local midnight of the 1st
 * day of the previous calendar month (covers "this month" and "last month").
 * @param {number|Date} [now=Date.now()]
 * @returns {number} ms epoch
 */
export function defaultWindowStart(now = Date.now()) {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
}

/**
 * Local midnight of the 1st day of the month `months` calendar months before
 * the month containing `from`.
 * @param {number} from ms epoch
 * @param {number} months
 * @returns {number}
 */
export function monthsBefore(from, months) {
    const d = new Date(from);
    const n = Math.max(1, Math.floor(Number(months) || 1));
    return new Date(d.getFullYear(), d.getMonth() - n, 1).getTime();
}

/**
 * Normalises an ensureHistoryFrom() argument to ms (0 = all history).
 * @param {number|Date|null|undefined} from
 * @returns {number}
 */
export function normalizeFrom(from) {
    if (from === null || from === undefined) return 0;
    const ms = from instanceof Date ? from.getTime() : Number(from);
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

// Firestore cross-type ordering: null < boolean < number < timestamp < string < others.
/** @param {*} v */
const typeRank = (v) => {
    if (v === null) return 0;
    if (typeof v === 'boolean') return 1;
    if (typeof v === 'number') return 2;
    if (v && typeof v === 'object' && (typeof v.toMillis === 'function' || (typeof v.seconds === 'number' && typeof v.nanoseconds === 'number'))) return 3;
    if (v instanceof Date) return 3;
    if (typeof v === 'string') return 4;
    return 5;
};

/**
 * @param {*} v
 * @returns {number[]}
 */
const timestampParts = (v) => {
    if (v instanceof Date) return [Math.floor(v.getTime() / 1000), (v.getTime() % 1000) * 1e6];
    if (typeof v.seconds === 'number') return [v.seconds, v.nanoseconds || 0];
    const ms = v.toMillis();
    return [Math.floor(ms / 1000), (ms % 1000) * 1e6];
};

const cmp = (/** @type {*} */ a, /** @type {*} */ b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Compares two Firestore field values in Firestore's ascending query order.
 * @param {*} a
 * @param {*} b
 * @returns {number}
 */
export function compareFirestoreValues(a, b) {
    const ra = typeRank(a);
    const rb = typeRank(b);
    if (ra !== rb) return ra - rb;
    switch (ra) {
        case 1: return cmp(a ? 1 : 0, b ? 1 : 0);
        case 2: {
            if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : -1;
            if (Number.isNaN(b)) return 1;
            return cmp(a, b);
        }
        case 3: {
            const [sa, na] = timestampParts(a);
            const [sb, nb] = timestampParts(b);
            return cmp(sa, sb) || cmp(na, nb);
        }
        case 4: return cmp(a, b);
        default: return 0;
    }
}

/**
 * Comparator reproducing `orderBy('date', 'desc')` (ties: document id desc),
 * the order AppState history arrays have always had.
 * @param {(record: Rec) => string} docIdOf
 * @returns {(a: Rec, b: Rec) => number}
 */
export function dateDescComparator(docIdOf) {
    return (a, b) => compareFirestoreValues(b.date, a.date) || cmp(docIdOf(b), docIdOf(a));
}
