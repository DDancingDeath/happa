/**
 * `apply`: writes a migration bundle into the NEW Firebase project.
 *
 * - Dry run unless the caller passes dryRun: false (CLI: --yes).
 * - Refuses the old project (aadhat-management) and keys for another project.
 * - Idempotent: every document is set() at a fixed id, so a rerun rewrites the
 *   same documents. Opening balances that already have payments recorded in
 *   the new app are never overwritten.
 * - Resumable: the cursor (index of the next write) is saved after every batch;
 *   a run stops at its write budget (Spark: 20,000 writes/day) and the next
 *   run continues from the cursor.
 * - dev_ collections are never written unless dev (then every write goes to dev_<name>).
 */
import { createHash } from 'crypto';
import backupLib from '../../backup/backup-lib.js';
import { BUNDLE_FORMAT, OLD_PROJECT_ID } from './plan.js';

export const DEFAULT_BUDGET = 18000;
export const BATCH_SIZE = 400;
export const CURSOR_VERSION = 1;
const OPENING_COLLS = ['purchases', 'retailSales', 'wholesaleSales'];

export function bundleHash(bundle) {
    return createHash('sha256').update(JSON.stringify(bundle.writes)).digest('hex').slice(0, 32);
}

/** Throws unless `project` is a safe target for the given key. */
export function checkTarget({ project, keyProject }) {
    if (!project || typeof project !== 'string') throw new Error('--project <newProjectId> is required');
    if (project.trim().toLowerCase() === OLD_PROJECT_ID) {
        throw new Error(`Refusing to write to ${OLD_PROJECT_ID}: that is the OLD project. Use the new project's id.`);
    }
    if (keyProject && keyProject.trim().toLowerCase() === OLD_PROJECT_ID) {
        throw new Error(`Refusing: the service-account key belongs to ${OLD_PROJECT_ID} (the OLD project).`);
    }
    if (keyProject && keyProject !== project) {
        throw new Error(`The service-account key is for project ${keyProject}, not ${project}.`);
    }
}

export function targetColl(coll, dev) {
    if (dev) return coll.startsWith('dev_') ? coll : `dev_${coll}`;
    if (coll.startsWith('dev_')) throw new Error(`Refusing to write ${coll}: dev_ collections need --dev`);
    return coll;
}

export function validateBundle(bundle) {
    if (!bundle || bundle.format !== BUNDLE_FORMAT || !Array.isArray(bundle.writes)) {
        throw new Error(`Not a migration bundle (expected format ${BUNDLE_FORMAT}). Run "plan" first.`);
    }
}

export function newCursor(bundle, project) {
    return { v: CURSOR_VERSION, bundleHash: bundleHash(bundle), project, next: 0, written: 0, deleted: 0, skipped: [], runs: [] };
}

/**
 * Resolves the cursor to continue from (null/undefined = fresh start).
 * @returns {Object} cursor
 */
export function resumeCursor(saved, bundle, project, { restart = false } = {}) {
    if (!saved || restart) return newCursor(bundle, project);
    if (saved.v !== CURSOR_VERSION) throw new Error('Cursor file is from another tool version; pass --restart to start over.');
    if (saved.project !== project) throw new Error(`Cursor file is for project ${saved.project}, not ${project}.`);
    if (saved.bundleHash !== bundleHash(bundle)) {
        throw new Error('Cursor file belongs to a different bundle. Pass --restart to write the new bundle from the start (every write is idempotent).');
    }
    return { ...saved, skipped: [...(saved.skipped || [])], runs: [...(saved.runs || [])] };
}

/** What one run would do: [start, end) of bundle.writes within the budget. */
export function planRun(bundle, cursor, budget = DEFAULT_BUDGET) {
    const total = bundle.writes.length;
    const start = Math.min(cursor.next, total);
    const end = Math.min(total, start + Math.max(0, budget));
    const byColl = {};
    bundle.writes.slice(start, end).forEach(w => { byColl[w.coll] = (byColl[w.coll] || 0) + 1; });
    const remainingAfter = total - end;
    return { total, start, end, count: end - start, byColl, remainingAfter, runsLeftAfter: Math.ceil(remainingAfter / Math.max(1, budget)), done: start >= total };
}

/**
 * Existing opening balances in the target: ones with payments/clearing are
 * kept; ones the new bundle no longer has (and nobody touched) are removed.
 */
async function reconcileOpenings(db, bundle, dev) {
    const wanted = new Set(bundle.writes.filter(w => w.group === 'opening').map(w => `${w.coll}/${w.id}`));
    const keep = new Set();
    const stale = [];
    for (const coll of OPENING_COLLS) {
        const snap = await db.collection(targetColl(coll, dev)).where('openingBalance.migrated', '==', true).get();
        snap.docs.forEach(doc => {
            const d = doc.data() || {};
            const touched = (Array.isArray(d.payments) && d.payments.length > 0) || d.cleared === true;
            const key = `${coll}/${doc.id}`;
            if (touched) keep.add(key);
            else if (!wanted.has(key)) stale.push({ coll, id: doc.id });
        });
    }
    return { keep, stale };
}

/**
 * Runs (or dry-runs) one budgeted pass.
 * @param {Object} args
 * @param {Object} args.bundle
 * @param {Object} args.cursor from resumeCursor()
 * @param {boolean} [args.dryRun=true]
 * @param {Object} [args.db] Firestore (admin API subset: collection/doc/batch/where/get)
 * @param {Object} [args.types] {Timestamp, GeoPoint} for tagged backup values
 * @param {number} [args.budget]
 * @param {boolean} [args.dev]
 * @param {(cursor: Object) => void} [args.saveCursor]
 * @param {(line: string) => void} [args.log]
 * @param {number} [args.batchSize]
 * @param {() => number} [args.now]
 * @returns {Promise<{status: 'dry-run'|'done'|'budget', run: Object, cursor: Object, writes: number}>}
 */
export async function applyBundle({
    bundle, cursor, dryRun = true, db = null, types = null, budget = DEFAULT_BUDGET, dev = false,
    saveCursor = () => {}, log = () => {}, batchSize = BATCH_SIZE, now = () => Date.now()
}) {
    validateBundle(bundle);
    bundle.writes.forEach(w => targetColl(w.coll, dev));
    const run = planRun(bundle, cursor, budget);
    if (dryRun) {
        log(`Dry run: ${run.total} writes in the bundle; ${run.start} already done.`);
        log(`This run would write ${run.count} (#${run.start}–#${run.end}); ${run.remainingAfter} left after it (${run.runsLeftAfter} more run(s)).`);
        Object.entries(run.byColl).sort().forEach(([c, n]) => log(`  ${targetColl(c, dev)}: ${n}`));
        log('Nothing was written. Add --yes to write.');
        return { status: 'dry-run', run, cursor, writes: 0 };
    }
    if (!db || !types) throw new Error('A Firestore connection is needed to write');
    if (run.done) {
        log('Everything in this bundle is already written.');
        return { status: 'done', run, cursor, writes: 0 };
    }

    let left = budget;
    let keep = new Set();
    const firstOpening = bundle.writes.findIndex(w => w.group === 'opening');
    if (firstOpening !== -1 && firstOpening < run.end) {
        const r = await reconcileOpenings(db, bundle, dev);
        keep = r.keep;
        for (let i = 0; i < r.stale.length && left > 0; i += batchSize) {
            const chunk = r.stale.slice(i, Math.min(i + batchSize, i + left));
            const batch = db.batch();
            chunk.forEach(s => batch.delete(db.collection(targetColl(s.coll, dev)).doc(s.id)));
            await batch.commit();
            left -= chunk.length;
            cursor.deleted += chunk.length;
            log(`Removed ${chunk.length} opening balances that are no longer due.`);
        }
    }

    const docRef = (path) => db.doc(dev ? `dev_${path}` : path);
    const deser = (data) => backupLib.deserialize(data, { Timestamp: types.Timestamp, GeoPoint: types.GeoPoint, doc: docRef });
    const startedAt = now();
    let written = 0;
    const stop = Math.min(run.end, cursor.next + left);
    while (cursor.next < stop) {
        const slice = bundle.writes.slice(cursor.next, Math.min(stop, cursor.next + batchSize));
        const batch = db.batch();
        let n = 0;
        slice.forEach(w => {
            if (w.group === 'opening' && keep.has(`${w.coll}/${w.id}`)) {
                cursor.skipped.push(`${w.coll}/${w.id}`);
                return;
            }
            batch.set(db.collection(targetColl(w.coll, dev)).doc(w.id), deser(w.data));
            n++;
        });
        if (n) await batch.commit();
        cursor.next += slice.length;
        cursor.written += n;
        written += n;
        saveCursor(cursor);
        log(`Wrote ${cursor.next}/${run.total}`);
    }
    if (keep.size) log(`Kept ${keep.size} opening balances that already have payments in the new app.`);
    cursor.runs.push({ at: startedAt, writes: written, upTo: cursor.next });
    saveCursor(cursor);
    const status = cursor.next >= run.total ? 'done' : 'budget';
    if (status === 'budget') log(`Stopped at the write budget. ${run.total - cursor.next} writes left: run again tomorrow (same command).`);
    return { status, run, cursor, writes: written };
}
