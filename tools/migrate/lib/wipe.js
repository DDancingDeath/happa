/**
 * `wipe`: empties a NEW project after a rehearsal, before the real migration.
 * Deletes every document of every root collection (with subcollections) and
 * the Auth users whose email ends with `--test-domain` (default
 * `@happa.local`, the test logins). Other Auth users are never touched.
 *
 * Dry run unless the caller passes dryRun: false (CLI: --yes). Refuses the
 * old project and keys for another project (checkTarget).
 */
import { checkTarget } from './apply.js';

export const DEFAULT_TEST_DOMAIN = '@happa.local';

/** Auth users that are test logins (email ends with the test domain). */
export function isTestLogin(user, domain = DEFAULT_TEST_DOMAIN) {
    const email = String(user && user.email || '').toLowerCase();
    const d = String(domain || '').toLowerCase();
    return d.startsWith('@') && d.length > 2 && email.endsWith(d);
}

/**
 * @param {Object} args
 * @param {string} args.project
 * @param {string} [args.keyProject]
 * @param {Object} args.db firebase-admin Firestore
 * @param {Object} args.auth firebase-admin Auth
 * @param {boolean} [args.dryRun=true]
 * @param {string} [args.testDomain]
 * @param {(line: string) => void} [args.log]
 */
export async function wipeProject({ project, keyProject, db, auth, dryRun = true, testDomain = DEFAULT_TEST_DOMAIN, log = () => {} }) {
    checkTarget({ project, keyProject });
    if (!keyProject) throw new Error('wipe needs a service-account key for the project (--key)');
    const colls = (await db.listCollections()).map(c => c.id).sort();
    let docs = 0;
    for (const c of colls) {
        const n = (await db.collection(c).count().get()).data().count;
        docs += n;
        log(`  ${c}: ${n} docs`);
    }
    const testUsers = [];
    let pageToken;
    do {
        const page = await auth.listUsers(1000, pageToken);
        page.users.filter(u => isTestLogin(u, testDomain)).forEach(u => testUsers.push(u));
        pageToken = page.pageToken;
    } while (pageToken);
    log(`Auth test logins (*${testDomain}): ${testUsers.length}: ${testUsers.map(u => u.email).join(', ') || 'none'}`);
    log(`Cost: about ${docs} deletes (+ subcollection docs) and as many reads; Spark allows 20,000 deletes and 50,000 reads a day.`);
    if (dryRun) {
        log('Dry run: nothing was deleted. Add --yes to delete.');
        return { docs, collections: colls, testUsers: testUsers.length, deleted: false };
    }
    for (const c of colls) {
        await db.recursiveDelete(db.collection(c));
        log(`Deleted ${c}`);
    }
    if (testUsers.length) {
        const r = await auth.deleteUsers(testUsers.map(u => u.uid));
        log(`Deleted ${r.successCount} test logins (${r.failureCount} failed)`);
    }
    return { docs, collections: colls, testUsers: testUsers.length, deleted: true };
}
