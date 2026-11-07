/**
 * `wipe`: empties a NEW project after a rehearsal, before the real migration,
 * EXCEPT the Rentals data, which is real (owner, 7 Nov 2026) and is never
 * deleted (hard-coded, no flag; `dev_` collections are treated like their prod
 * twins):
 * - `rent_*` (and `dev_rent_*`) collections are kept whole;
 * - `auditLogs`: only the entries whose action starts with `RENT_` are kept;
 * - `users`: profiles with a `rentRole` are kept, with their Aadhat `role`
 *   cleared (set to 'none'); every other profile is deleted. apply then
 *   re-creates the old app's people from the final backup and puts Happa's
 *   rentRole back, so Aadhat roles come from the old app only (it removes a
 *   person by deleting the profile) and Rentals roles from Happa only.
 * Every other root collection is deleted with its subcollections. In Auth it
 * deletes the users whose email ends with `--test-domain` (default
 * `@happa.local`, the test logins) and the service-account logins on the
 * denylist (service-accounts.js; a rehearsal may have imported them). Other
 * Auth users are never touched.
 *
 * Dry run unless the caller passes dryRun: false (CLI: --yes). Refuses the
 * old project and keys for another project (checkTarget).
 */
import { checkTarget } from './apply.js';
import { isServiceAccountEmail } from './service-accounts.js';

export const DEFAULT_TEST_DOMAIN = '@happa.local';
/** Rentals collections: never deleted. */
export const RENT_COLLECTION = /^(dev_)?rent_/;
export const RENT_AUDIT_PREFIX = 'RENT_';
const DELETE_BATCH = 400;

/** Auth users that are test logins (email ends with the test domain). */
export function isTestLogin(user, domain = DEFAULT_TEST_DOMAIN) {
    const email = String(user && user.email || '').toLowerCase();
    const d = String(domain || '').toLowerCase();
    return d.startsWith('@') && d.length > 2 && email.endsWith(d);
}

/**
 * How wipe treats a root collection: 'keep' (Rentals), 'audit' (keeps the
 * RENT_* entries), 'users' (keeps the profiles with a rentRole, Aadhat role cleared) or 'delete'.
 */
export function wipeMode(coll) {
    if (RENT_COLLECTION.test(coll)) return 'keep';
    const base = coll.startsWith('dev_') ? coll.slice(4) : coll;
    if (base === 'auditLogs') return 'audit';
    if (base === 'users') return 'users';
    return 'delete';
}

export const isRentAudit = (d) => typeof d?.action === 'string' && d.action.startsWith(RENT_AUDIT_PREFIX);
export const hasRentRole = (u) => u?.rentRole !== undefined && u?.rentRole !== null && u?.rentRole !== '';

/** A profile wipe deletes: every one without a rentals role. */
export const isWipedProfile = (data) => !hasRentRole(data);
const hasAadhatRole = (u) => !!u?.role && u.role !== 'none';

const countOf = async (query) => (await query.count().get()).data().count;

/** Per root collection: what a run deletes and keeps (users: the exact profile ids). */
async function planCollections(db, colls) {
    const plan = [];
    for (const coll of colls) {
        const mode = wipeMode(coll);
        const ref = db.collection(coll);
        if (mode === 'users') {
            const snap = await ref.select('role', 'rentRole').get();
            const ids = snap.docs.filter(d => isWipedProfile(d.data())).map(d => d.id);
            const clear = snap.docs.filter(d => !isWipedProfile(d.data()) && hasAadhatRole(d.data()));
            const owners = snap.docs.filter(d => d.data().role === 'owner').map(d => d.id);
            plan.push({ coll, mode, delete: ids.length, keep: snap.size - ids.length, ids, clear: clear.map(d => d.id), withRole: clear.map(d => `${d.id} (${d.data().role})`), owners });
            continue;
        }
        const total = await countOf(ref);
        if (mode === 'keep') plan.push({ coll, mode, delete: 0, keep: total });
        else if (mode === 'audit') {
            const keep = await countOf(ref.where('action', '>=', RENT_AUDIT_PREFIX).where('action', '<', `${RENT_AUDIT_PREFIX}\uf8ff`));
            plan.push({ coll, mode, delete: total - keep, keep });
        } else plan.push({ coll, mode, delete: total, keep: 0 });
    }
    return plan;
}

const NOTE = { keep: 'Rentals data', audit: 'RENT_* entries', users: 'profiles with a rentRole' };

/**
 * @param {Object} args
 * @param {string} args.project
 * @param {string} [args.keyProject]
 * @param {boolean} [args.emulator] the Firebase emulators (no key)
 * @param {Object} args.db firebase-admin Firestore
 * @param {Object} args.auth firebase-admin Auth
 * @param {boolean} [args.dryRun=true]
 * @param {string} [args.testDomain]
 * @param {(line: string) => void} [args.log]
 */
export async function wipeProject({ project, keyProject, emulator = false, db, auth, dryRun = true, testDomain = DEFAULT_TEST_DOMAIN, log = () => {} }) {
    checkTarget({ project, keyProject });
    if (!keyProject && !emulator) throw new Error('wipe needs a service-account key for the project (--key)');
    testDomain = testDomain || DEFAULT_TEST_DOMAIN;
    const testUsers = [];
    const serviceUsers = [];
    let pageToken;
    do {
        const page = await auth.listUsers(1000, pageToken);
        page.users.filter(u => isTestLogin(u, testDomain)).forEach(u => testUsers.push(u));
        page.users.filter(u => isServiceAccountEmail(u.email)).forEach(u => serviceUsers.push(u));
        pageToken = page.pageToken;
    } while (pageToken);

    const colls = (await db.listCollections()).map(c => c.id).sort();
    const plan = await planCollections(db, colls);
    plan.forEach(p => {
        if (p.mode === 'delete') log(`  ${p.coll}: delete ${p.delete} docs`);
        else if (p.mode === 'keep') log(`  ${p.coll}: KEEP ${p.keep} docs (${NOTE.keep})`);
        else log(`  ${p.coll}: delete ${p.delete} docs, KEEP ${p.keep} (${NOTE[p.mode]})`);
        if (p.withRole?.length) log(`    Aadhat role cleared on kept profiles (role 'none'; apply sets it again from the final backup): ${p.withRole.join(', ')}`);
        if (p.owners?.length) log(`    owner profiles deleted or cleared (apply must re-create them: check each uid is in the final backup): ${p.owners.join(', ')}`);
    });
    const docs = plan.reduce((n, p) => n + p.delete, 0);
    const kept = plan.reduce((n, p) => n + p.keep, 0);
    log(`Firestore: delete ${docs} docs (+ their subcollections), keep ${kept} docs (Rentals data, RENT_* audit entries, profiles).`);
    log(`Auth test logins (*${testDomain}): ${testUsers.length}: ${testUsers.map(u => u.email).join(', ') || 'none'}`);
    log(`Auth service accounts (denylist, never carried): ${serviceUsers.length}: ${serviceUsers.map(u => u.email).join(', ') || 'none'}`);
    log(`Cost: about ${docs} deletes (+ subcollection docs) and as many reads; Spark allows 20,000 deletes and 50,000 reads a day.`);
    const summary = { docs, kept, collections: colls, plan: plan.map(({ ids, clear, withRole, owners, ...p }) => p), testUsers: testUsers.length, serviceUsers: serviceUsers.length };
    if (dryRun) {
        log('Dry run: nothing was deleted. Add --yes to delete.');
        return { ...summary, deleted: false };
    }
    for (const p of plan) {
        if (RENT_COLLECTION.test(p.coll) || p.mode === 'keep') {
            log(`Kept ${p.coll}`);
        } else if (p.mode === 'delete') {
            await db.recursiveDelete(db.collection(p.coll));
            log(`Deleted ${p.coll}`);
        } else if (p.mode === 'users') {
            for (const id of p.ids) await db.recursiveDelete(db.collection(p.coll).doc(id));
            for (let i = 0; i < p.clear.length; i += DELETE_BATCH) {
                const batch = db.batch();
                p.clear.slice(i, i + DELETE_BATCH).forEach(id => batch.update(db.collection(p.coll).doc(id), { role: 'none' }));
                await batch.commit();
            }
            log(`${p.coll}: deleted ${p.ids.length} profiles, kept ${p.keep} (Aadhat role cleared on ${p.clear.length})`);
        } else {
            const snap = await db.collection(p.coll).select('action').get();
            const gone = snap.docs.filter(d => !isRentAudit(d.data()));
            for (let i = 0; i < gone.length; i += DELETE_BATCH) {
                const batch = db.batch();
                gone.slice(i, i + DELETE_BATCH).forEach(d => batch.delete(d.ref));
                await batch.commit();
            }
            log(`${p.coll}: deleted ${gone.length}, kept ${snap.size - gone.length} RENT_* entries`);
        }
    }
    if (testUsers.length) {
        const r = await auth.deleteUsers(testUsers.map(u => u.uid));
        log(`Deleted ${r.successCount} test logins (${r.failureCount} failed)`);
    }
    if (serviceUsers.length) {
        const r = await auth.deleteUsers(serviceUsers.map(u => u.uid));
        log(`Deleted ${r.successCount} service-account logins (${r.failureCount} failed)`);
    }
    return { ...summary, deleted: true };
}
