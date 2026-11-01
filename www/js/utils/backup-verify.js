/**
 * @fileoverview Checks a backup file on the phone, read-only (#63): the JSON of
 * a nightly / weekly backup (after decrypting it, tools/backup/README.md) or
 * the in-app Clear Data backup (`aadhat-backup-v1`). Same checks as the offline
 * verify (tools/backup/verify-lib.js checkBackup): every document has an id
 * (no duplicates) and data, every tagged value (time, reference, place, bytes)
 * is well formed, and the counts agree with the file's own manifest. Nothing is
 * read from or written to Firestore. Pure.
 * @module utils/backup-verify
 */

export const BACKUP_FORMAT = 'aadhat-backup-v1';
/** Problems listed (the count still covers all of them). */
export const MAX_PROBLEMS = 20;
/** Collections whose newest record says how recent the backup's business data is. */
const BILL_COLLECTIONS = ['purchases', 'retailSales', 'wholesaleSales'];

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** True when a tagged value is malformed. */
function tagProblem(v) {
    switch (v.__type) {
        case 'timestamp':
            return finite(v.seconds) ? !finite(v.nanoseconds ?? 0) : !finite(v.millis);
        case 'geopoint':
            return !(finite(v.latitude) && finite(v.longitude));
        case 'ref':
            return !(typeof v.path === 'string' && v.path);
        case 'bytes':
            return typeof v.base64 !== 'string';
        default:
            return false;
    }
}

const TAGS = ['timestamp', 'geopoint', 'ref', 'bytes'];

/** True when a document's data holds a malformed tagged value (or is nested absurdly deep). */
function dataProblem(value, depth = 0) {
    if (depth > 64) return true;
    if (value === null || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(v => dataProblem(v, depth + 1));
    if (TAGS.includes(value.__type)) return tagProblem(value);
    return Object.keys(value).some(k => dataProblem(value[k], depth + 1));
}

/** ms of a document's own time (`timestamp`, else `createdAt`), or NaN. */
function docTime(data) {
    const v = data?.timestamp ?? data?.createdAt;
    if (finite(v)) return v;
    if (v && typeof v === 'object' && v.__type === 'timestamp') return finite(v.seconds) ? v.seconds * 1000 : Number(v.millis);
    return NaN;
}

/**
 * @param {*} backup parsed JSON
 * @param {number} now ms
 * @returns {{ok: boolean, problems: Array<{code: string, coll?: string, at?: number, id?: string, file?: number, manifest?: number}>, problemCount: number, exportedAt: ?string, ageDays: ?number,
 *   source: string, collections: Array<{name: string, docs: number}>, subcollections: Array<{name: string, docs: number}>,
 *   totalDocs: number, newestBillAt: ?number}}
 */
export function verifyBackup(backup, now) {
    const problems = [];
    const out = {
        ok: false, problems, problemCount: 0, exportedAt: null, ageDays: null, source: '',
        collections: [], subcollections: [], totalDocs: 0, newestBillAt: null
    };
    const note = (code, extra = {}) => {
        out.problemCount++;
        if (problems.length < MAX_PROBLEMS) problems.push({ code, ...extra });
    };
    if (!backup || typeof backup !== 'object' || backup.format !== BACKUP_FORMAT) {
        note('not_backup');
        return out;
    }
    if (!backup.collections || typeof backup.collections !== 'object' || Array.isArray(backup.collections)) {
        note('no_collections');
        return out;
    }
    const exported = Date.parse(backup.exportedAt);
    if (Number.isFinite(exported)) {
        out.exportedAt = new Date(exported).toISOString();
        out.ageDays = Math.max(0, Math.floor((now - exported) / 86400000));
    } else note('no_time');
    out.source = backup.mode ? String(backup.mode) : backup.exportedBy !== undefined ? 'app' : '';
    const check = (label, docs, key, list) => {
        if (!Array.isArray(docs)) {
            note('not_list', { coll: label });
            return;
        }
        const seen = new Set();
        docs.forEach((d, i) => {
            const id = d && d[key];
            if (typeof id !== 'string' || !id) note('no_id', { coll: label, at: i });
            else if (seen.has(id)) note('twice', { coll: label, id });
            else seen.add(id);
            if (!d || !d.data || typeof d.data !== 'object' || Array.isArray(d.data)) note('no_data', { coll: label, at: i });
            else if (dataProblem(d.data)) note('bad_value', { coll: label, at: i });
        });
        list.push({ name: label, docs: docs.length });
        out.totalDocs += docs.length;
    };
    Object.keys(backup.collections).sort().forEach(n => check(n, backup.collections[n], 'id', out.collections));
    const subs = backup.subcollections && typeof backup.subcollections === 'object' ? backup.subcollections : {};
    Object.keys(subs).sort().forEach(n => check(n, subs[n], 'path', out.subcollections));
    const m = backup.manifest;
    if (m && typeof m === 'object') {
        [['collections', out.collections], ['subcollections', out.subcollections]].forEach(([kind, list]) => {
            const want = m[kind] || {};
            const got = Object.fromEntries(list.map(c => [c.name, c.docs]));
            new Set([...Object.keys(want), ...Object.keys(got)]).forEach(n => {
                if (want[n] !== got[n]) note('count', { coll: n, file: got[n] ?? 0, manifest: want[n] ?? 0 });
            });
        });
    }
    BILL_COLLECTIONS.forEach(n => (Array.isArray(backup.collections[n]) ? backup.collections[n] : []).forEach(d => {
        const t = docTime(d?.data);
        if (Number.isFinite(t) && (out.newestBillAt === null || t > out.newestBillAt)) out.newestBillAt = t;
    }));
    out.ok = out.problemCount === 0;
    return out;
}

/**
 * Parses the text of a backup file and checks it.
 * @param {string} text
 * @param {number} now
 * @returns {ReturnType<typeof verifyBackup>}
 */
export function verifyBackupText(text, now) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (_) {
        // JSON.parse messages quote the file (shop data): never shown.
        const out = verifyBackup(null, now);
        out.problems[0] = { code: 'not_json' };
        return out;
    }
    return verifyBackup(parsed, now);
}

/** Days after which the owner is reminded to check a backup again (REM-3). */
export const DRILL_DAYS = 30;
const DRILL_KEY = 'happa.restoreDrill';

/**
 * REM-3: the backup-check reminder on Today for the owner: due when this phone has
 * no check recorded for this person, or the last one is DRILL_DAYS or more days old.
 * @param {Storage} store
 * @param {string} uid
 * @param {number} now
 * @returns {{due: boolean, lastAt: ?number, days: ?number}}
 */
export function drillReminder(store, uid, now) {
    let last = null;
    try {
        const s = JSON.parse(store.getItem(DRILL_KEY) || 'null');
        if (s && s.uid === uid && finite(s.at)) last = s.at;
    } catch (_) { last = null; }
    if (last === null) return { due: true, lastAt: null, days: null };
    const days = Math.max(0, Math.floor((now - last) / 86400000));
    return { due: days >= DRILL_DAYS, lastAt: last, days };
}

/**
 * Records a successful backup check for this person on this phone.
 * @param {Storage} store
 * @param {{uid: string, at: number, exportedAt: ?string, docs: number}} drill
 * @returns {boolean} false when the phone's storage refused it
 */
export function recordDrill(store, { uid, at, exportedAt, docs }) {
    try {
        store.setItem(DRILL_KEY, JSON.stringify({ uid, at, exportedAt, docs }));
        return true;
    } catch (_) {
        return false;
    }
}
