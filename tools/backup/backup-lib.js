/**
 * Pure helpers shared by export-firestore.js and restore-firestore.js.
 * No network access here, so they are unit-tested
 * (www/js/__tests__/firestore-backup.test.js, tests/backup/).
 */
'use strict';

const BACKUP_FORMAT = 'aadhat-backup-v1';

/**
 * Every production root collection that firestore.rules names (explicitly or in
 * businessCollections()). tests/backup/backup-collections.test.js fails when the
 * rules gain a collection that is missing here, so nothing is silently left out.
 * The export itself still backs up every root collection Firestore lists.
 */
const BACKUP_COLLECTIONS = [
    // businessCollections()
    'purchases', 'retailSales', 'wholesaleSales', 'items', 'expenses',
    'stockAdjustments', 'withdrawals', 'cashManagement', 'cashSessions',
    'settings', 'itemFrequency', 'notifications', 'autoSaves', 'drafts', 'counters',
    'personalExpenses', 'personalExpenseDays',
    // own match blocks
    'stockCheckpoints', 'rateHistory', 'anomalies', 'rateStats', 'monthStats',
    'tipHealth', 'tipFailures', 'users', 'auditLogs', 'telemetry', 'deviceLog',
    // Rentals
    'rent_public', 'rent_properties', 'rent_units', 'rent_tenants', 'rent_leases',
    'rent_charges', 'rent_settings', 'rent_receipts', 'rent_counters'
];

/** Sub-collections named in firestore.rules, as `<parent collection>/<sub-collection>` (bill edit records: #121). */
const SUBCOLLECTIONS = ['users/preferences', 'purchases/edits', 'retailSales/edits', 'wholesaleSales/edits'];

/**
 * Left out of the nightly export to save reads (logs and test-in-production
 * counters, most of a run's reads). The weekly (Sunday) export includes them.
 */
const NIGHTLY_EXCLUDE = ['auditLogs', 'telemetry', 'tipHealth', 'tipFailures'];

/** The only collections the BACKUP_EXCLUDE variable may drop; it can't drop business data. */
const OPTIONAL_COLLECTIONS = [...NIGHTLY_EXCLUDE, 'notifications', 'autoSaves', 'drafts'];

const IST_OFFSET_MS = 330 * 60 * 1000;

/**
 * Day of the week in India (0 = Sunday).
 * @param {Date} [now]
 * @returns {number}
 */
function istDayOfWeek(now = new Date()) {
    return new Date(now.getTime() + IST_OFFSET_MS).getUTCDay();
}

/**
 * Which export to take. Scheduled runs take the weekly (full) export on
 * Sundays (IST) and the nightly one otherwise; a manual run picks either.
 * @param {{requested?: string, scheduled: boolean, dayOfWeek: number}} o
 * @returns {'nightly'|'weekly'}
 */
function backupMode({ requested, scheduled, dayOfWeek }) {
    if (requested === 'nightly' || requested === 'weekly') return requested;
    return scheduled && dayOfWeek === 0 ? 'weekly' : 'nightly';
}

/**
 * Collections for one run.
 * @param {string[]} ids root collection ids that exist in Firestore
 * @param {{mode: 'nightly'|'weekly', exclude?: string[]}} o `exclude` = BACKUP_EXCLUDE
 * @returns {{names: string[], excluded: string[], refused: string[], undeclared: string[]}}
 *   refused: BACKUP_EXCLUDE entries ignored because they are business data;
 *   undeclared: exported collections missing from BACKUP_COLLECTIONS.
 */
function planCollections(ids, { mode, exclude = [] }) {
    const extra = exclude.map(s => String(s).trim()).filter(Boolean);
    const refused = extra.filter(n => !OPTIONAL_COLLECTIONS.includes(n) && BACKUP_COLLECTIONS.includes(n));
    const skip = new Set([...(mode === 'weekly' ? [] : NIGHTLY_EXCLUDE), ...extra.filter(n => !refused.includes(n))]);
    const names = selectCollections(ids, [...skip]);
    const excluded = ids.filter(id => !id.startsWith('dev_') && skip.has(id)).sort();
    const undeclared = names.filter(n => !BACKUP_COLLECTIONS.includes(n));
    return { names, excluded, refused, undeclared };
}

/**
 * Document counts of a backup, written next to the encrypted file as
 * manifest.json (counts only, no data) and embedded in the backup itself.
 * @param {{format: string, mode?: string, exportedAt: string, project?: string, collections: Object<string, Array>, subcollections?: Object<string, Array>}} backup
 * @returns {object}
 */
function buildManifest(backup) {
    const collections = {};
    Object.keys(backup.collections || {}).sort().forEach(n => { collections[n] = backup.collections[n].length; });
    const subcollections = {};
    Object.keys(backup.subcollections || {}).sort().forEach(n => { subcollections[n] = backup.subcollections[n].length; });
    const totalDocs = [...Object.values(collections), ...Object.values(subcollections)].reduce((a, b) => a + b, 0);
    return { format: backup.format, mode: backup.mode || 'full', exportedAt: backup.exportedAt, project: backup.project, totalDocs, collections, subcollections };
}

/**
 * Converts Firestore values to JSON-safe tagged objects (recursively).
 * Timestamps keep seconds + nanoseconds so a restore is exact.
 * @param {*} value
 * @returns {*}
 */
function serialize(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) {
        return { __type: 'timestamp', iso: value.toISOString(), millis: value.getTime() };
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return { __type: 'bytes', base64: Buffer.from(value).toString('base64') };
    }
    if (Array.isArray(value)) return value.map(serialize);
    if (typeof value !== 'object') return value;
    if (typeof value.toMillis === 'function' && 'seconds' in value && 'nanoseconds' in value) {
        const millis = value.toMillis();
        return { __type: 'timestamp', iso: new Date(millis).toISOString(), millis, seconds: value.seconds, nanoseconds: value.nanoseconds };
    }
    if (typeof value.path === 'string' && value.firestore) return { __type: 'ref', path: value.path };
    if (typeof value.latitude === 'number' && typeof value.longitude === 'number' && Object.keys(value).length <= 2) {
        return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
    }
    const out = {};
    for (const k of Object.keys(value)) out[k] = serialize(value[k]);
    return out;
}

/**
 * Reverses serialize(). `types` supplies the Firestore constructors so this
 * stays testable without firebase-admin.
 * @param {*} value
 * @param {{Timestamp: any, GeoPoint: any, doc: (path: string) => any}} types
 * @returns {*}
 */
function deserialize(value, types) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => deserialize(v, types));
    switch (value.__type) {
        case 'timestamp':
            return typeof value.seconds === 'number'
                ? new types.Timestamp(value.seconds, value.nanoseconds || 0)
                : types.Timestamp.fromMillis(value.millis);
        case 'geopoint':
            return new types.GeoPoint(value.latitude, value.longitude);
        case 'ref':
            return types.doc(value.path);
        case 'bytes':
            return Buffer.from(value.base64, 'base64');
        default: {
            const out = {};
            for (const k of Object.keys(value)) out[k] = deserialize(value[k], types);
            return out;
        }
    }
}

/**
 * Production collections to back up: everything except dev_* (local testing
 * data) and anything listed in `exclude`.
 * @param {string[]} ids root collection ids
 * @param {string[]} [exclude]
 * @returns {string[]}
 */
function selectCollections(ids, exclude = []) {
    const skip = new Set(exclude.map(s => s.trim()).filter(Boolean));
    return ids.filter(id => !id.startsWith('dev_') && !skip.has(id)).sort();
}

/**
 * Free-quota guard. The Spark plan allows 50,000 document reads per day and a
 * full export reads every document once, so:
 *  - above `hardMax` documents nothing runs unless forced (the job fails so
 *    the owner gets an email);
 *  - above `weeklyAbove` documents the scheduled run only happens on Sundays;
 *  - a manual run (workflow_dispatch) always runs under `hardMax`.
 * @param {{totalDocs: number, scheduled: boolean, dayOfWeek: number, weeklyAbove: number, hardMax: number, force: boolean}} o
 * @returns {{run: boolean, fail: boolean, reason: string}}
 */
function decideRun({ totalDocs, scheduled, dayOfWeek, weeklyAbove, hardMax, force }) {
    if (force) return { run: true, fail: false, reason: 'forced' };
    if (totalDocs > hardMax) {
        return { run: false, fail: true, reason: `${totalDocs} documents is above the ${hardMax} safety limit (free quota is 50,000 reads/day). Run manually with force=true, or raise BACKUP_HARD_MAX.` };
    }
    if (scheduled && totalDocs > weeklyAbove && dayOfWeek !== 0) {
        return { run: false, fail: false, reason: `${totalDocs} documents is above ${weeklyAbove}; scheduled backups run weekly (Sundays) at this size.` };
    }
    return { run: true, fail: false, reason: 'ok' };
}

/**
 * Restore target collection name. Defaults to the dev_ copy so a restore
 * drill never touches production by accident.
 * @param {string} name
 * @param {'dev'|'prod'} target
 * @returns {string}
 */
function targetCollection(name, target) {
    if (target === 'prod') return name;
    return name.startsWith('dev_') ? name : `dev_${name}`;
}

/**
 * Restore target for a sub-collection document path (`users/u1/preferences/p`):
 * only the root collection gets the dev_ prefix.
 * @param {string} docPath
 * @param {'dev'|'prod'} target
 * @returns {string}
 */
function targetDocPath(docPath, target) {
    const [root, ...rest] = docPath.split('/');
    return [targetCollection(root, target), ...rest].join('/');
}

module.exports = {
    BACKUP_FORMAT, BACKUP_COLLECTIONS, SUBCOLLECTIONS, NIGHTLY_EXCLUDE, OPTIONAL_COLLECTIONS,
    serialize, deserialize, selectCollections, planCollections, backupMode, istDayOfWeek, buildManifest,
    decideRun, targetCollection, targetDocPath
};
