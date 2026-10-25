/**
 * `convert`: Firestore REST-style documents -> the backup format written by
 * tools/backup/export-firestore.js (`aadhat-backup-v1`), so `plan` can read a
 * copy of the data that was not made by the backup workflow (for example
 * documents taken from a browser's offline cache).
 *
 * Input: an object keyed by full document name
 * (`projects/<p>/databases/(default)/documents/<coll>/<id>`), or an array, of
 * `{ name, fields: { <typed values> }, createTime, updateTime }`.
 * Pure and offline.
 */
import backupLib from '../../backup/backup-lib.js';

const NAME_RE = /^projects\/([^/]+)\/databases\/([^/]+)\/documents\/(.+)$/;

/** RFC 3339 time (up to nanoseconds) -> the backup's tagged timestamp. */
export function toTimestamp(text) {
    const m = /^(.*?)(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(String(text));
    if (!m) throw new Error(`Bad timestampValue: ${text}`);
    const secondsMs = Date.parse(`${m[1]}${m[3]}`);
    if (!Number.isFinite(secondsMs)) throw new Error(`Bad timestampValue: ${text}`);
    const seconds = Math.floor(secondsMs / 1000);
    const nanoseconds = Number((m[2] || '').padEnd(9, '0')) || 0;
    const millis = seconds * 1000 + Math.floor(nanoseconds / 1e6);
    return { __type: 'timestamp', iso: new Date(millis).toISOString(), millis, seconds, nanoseconds };
}

/** One REST typed value -> the value export-firestore.js would have stored. */
export function fromRestValue(value) {
    if (!value || typeof value !== 'object') throw new Error('Bad Firestore value');
    const [type] = Object.keys(value);
    const v = value[type];
    switch (type) {
        case 'nullValue': return null;
        case 'booleanValue': return Boolean(v);
        case 'stringValue': return String(v);
        case 'integerValue': {
            const n = Number(v);
            if (!Number.isSafeInteger(n)) throw new Error(`integerValue out of safe range: ${v}`);
            return n;
        }
        case 'doubleValue': return typeof v === 'number' ? v : Number(v);
        case 'timestampValue': return toTimestamp(v);
        case 'mapValue': return fromRestFields(v && v.fields);
        case 'arrayValue': return ((v && v.values) || []).map(fromRestValue);
        case 'referenceValue': {
            const m = NAME_RE.exec(String(v));
            return { __type: 'ref', path: m ? m[3] : String(v) };
        }
        case 'geoPointValue': return { __type: 'geopoint', latitude: v.latitude || 0, longitude: v.longitude || 0 };
        case 'bytesValue': return { __type: 'bytes', base64: String(v) };
        default: throw new Error(`Unknown Firestore value type: ${type}`);
    }
}

export function fromRestFields(fields) {
    const out = {};
    Object.keys(fields || {}).forEach(k => { out[k] = fromRestValue(fields[k]); });
    return out;
}

/**
 * @param {Object|Array} docs REST documents
 * @param {{exclude?: string[], exportedAt?: string}} [opts]
 *   exportedAt defaults to the newest updateTime (when the copy was current).
 * @returns {{backup: Object, summary: Object}}
 */
export function convertRestDocs(docs, { exclude = [], exportedAt } = {}) {
    const list = Array.isArray(docs) ? docs : Object.entries(docs || {}).map(([key, d]) => {
        if (d && d.name && d.name !== key) throw new Error('Document key and name differ');
        return { ...d, name: key };
    });
    const skip = new Set(exclude.map(s => s.trim()).filter(Boolean));
    const projects = new Set();
    const collections = {};
    const skipped = { excluded: {}, dev: {}, subcollection: 0 };
    let newest = '';
    list.forEach(d => {
        const m = NAME_RE.exec(String(d && d.name || ''));
        if (!m) throw new Error(`Not a Firestore document name: ${String(d && d.name).slice(0, 80)}`);
        projects.add(m[1]);
        const parts = m[3].split('/');
        if (parts.length !== 2) { skipped.subcollection++; return; } // the export reads root collections only
        const [coll, id] = parts.map(decodeURIComponent);
        if (coll.startsWith('dev_')) { skipped.dev[coll] = (skipped.dev[coll] || 0) + 1; return; }
        if (skip.has(coll)) { skipped.excluded[coll] = (skipped.excluded[coll] || 0) + 1; return; }
        if (d.updateTime && d.updateTime > newest) newest = d.updateTime;
        (collections[coll] || (collections[coll] = [])).push({ id, data: fromRestFields(d.fields) });
    });
    if (projects.size > 1) throw new Error(`Documents from more than one project: ${[...projects].join(', ')}`);
    const at = exportedAt || (newest ? toTimestamp(newest).iso : null);
    if (!at || !Number.isFinite(Date.parse(at))) throw new Error('No exportedAt: pass --exported-at <ISO time>');
    const sorted = {};
    Object.keys(collections).sort().forEach(c => {
        const seen = new Set();
        collections[c].forEach(doc => {
            if (seen.has(doc.id)) throw new Error(`Duplicate document ${c}/${doc.id}`);
            seen.add(doc.id);
        });
        // export-firestore.js pages in document-id order
        sorted[c] = collections[c].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    });
    const backup = {
        format: backupLib.BACKUP_FORMAT,
        exportedAt: new Date(Date.parse(at)).toISOString(),
        env: 'prod',
        project: [...projects][0] || null,
        collections: sorted
    };
    const summary = {
        project: backup.project,
        exportedAt: backup.exportedAt,
        collections: Object.fromEntries(Object.entries(sorted).map(([c, d]) => [c, d.length])),
        skipped
    };
    return { backup, summary };
}
