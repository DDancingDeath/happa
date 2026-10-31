/**
 * @fileoverview Pure helpers for JSON data backups (Clear Data "download a
 * backup first"). Firestore special values are converted to plain JSON so the
 * file can be read back by tools/backup restore scripts.
 * @module utils/data-export
 */

/**
 * Converts Firestore values (Timestamp, DocumentReference, GeoPoint, Date) to
 * JSON-safe tagged objects, recursively.
 * @param {*} value
 * @returns {*}
 */
export function serializeForBackup(value) {
    if (value === null || value === undefined) return value ?? null;
    if (value instanceof Date) return { __type: 'timestamp', iso: value.toISOString(), millis: value.getTime() };
    if (Array.isArray(value)) return value.map(serializeForBackup);
    if (typeof value !== 'object') return value;
    if (typeof value.toMillis === 'function' && 'seconds' in value && 'nanoseconds' in value) {
        const millis = value.toMillis();
        return { __type: 'timestamp', iso: new Date(millis).toISOString(), millis };
    }
    if (typeof value.path === 'string' && value.firestore) return { __type: 'ref', path: value.path };
    if (typeof value.latitude === 'number' && typeof value.longitude === 'number' && Object.keys(value).length <= 2) {
        return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
    }
    const out = {};
    Object.keys(value).forEach(k => { out[k] = serializeForBackup(value[k]); });
    return out;
}

/**
 * Builds the backup document.
 * @param {Object.<string, Array<{id: string, data: Object}>>} collections keyed by unprefixed name
 * @param {{env?: string, exportedBy?: string, now?: Date}} [meta]
 * @returns {Object}
 */
export function buildBackup(collections, meta = {}) {
    const now = meta.now || new Date();
    const out = {
        format: 'aadhat-backup-v1',
        exportedAt: now.toISOString(),
        env: meta.env || 'prod',
        exportedBy: meta.exportedBy || null,
        collections: {}
    };
    Object.keys(collections || {}).forEach(name => {
        out.collections[name] = (collections[name] || []).map(d => ({ id: d.id, data: serializeForBackup(d.data) }));
    });
    return out;
}

/** The word a user must type to confirm Clear Data. */
export const DELETE_CONFIRM_WORD = 'DELETE';

/**
 * The business record. On the live data (not `dev_`) Clear Data can't delete
 * these (#63): a wrong bill is voided, and a full wipe is a tools/migrate job.
 */
export const LEDGER_COLLECTIONS = Object.freeze([
    'purchases', 'retailSales', 'wholesaleSales', 'expenses', 'stockAdjustments',
    'withdrawals', 'cashManagement', 'items', 'users'
]);

/**
 * Whether Clear Data may delete a collection.
 * @param {string} id unprefixed collection name
 * @param {'prod'|'dev'} env
 * @returns {boolean}
 */
export function canClearCollection(id, env) {
    return env === 'dev' || !LEDGER_COLLECTIONS.includes(id);
}

/**
 * True when the typed text confirms deletion (surrounding spaces ignored).
 * @param {*} text
 * @returns {boolean}
 */
export function isDeleteConfirmed(text) {
    return String(text ?? '').trim() === DELETE_CONFIRM_WORD;
}
