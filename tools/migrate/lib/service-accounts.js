/**
 * Service and test logins of the old project that must NOT move to the new one
 * (#101). Matched by email (trimmed, case-insensitive), never by name.
 *
 * - staging-readonly@aadhat.local: the archived staging clone's reader. Server-side
 *   it is an ordinary approved member with write access (no rule ever limited it).
 * - staging-owner@aadhat.local: the same clone's owner login (role owner).
 *
 * `plan` leaves their `users/{uid}` docs (and their per-user `itemFrequency/{uid}`)
 * out of the bundle, `auth:import` / `auth:filter` leave their logins out, and
 * `wipe` deletes them from the new project's Auth (an earlier rehearsal may have
 * imported them).
 */
export const SERVICE_ACCOUNT_EMAILS = Object.freeze([
    'staging-readonly@aadhat.local',
    'staging-owner@aadhat.local'
]);

const normEmail = (email) => String(email ?? '').trim().toLowerCase();
const DENY = new Set(SERVICE_ACCOUNT_EMAILS.map(normEmail));

/** Whether `email` is on the service-account denylist. */
export function isServiceAccountEmail(email) {
    const e = normEmail(email);
    return e !== '' && DENY.has(e);
}

/** Collections keyed by the user's uid: a skipped account's doc there is left out too. */
export const PER_USER_COLLECTIONS = Object.freeze(['users', 'itemFrequency']);

/**
 * uids of the denylisted accounts in a backup's `users` collection (by the doc's email).
 * @param {Array<{id: string, data: Object}>} userDocs
 * @returns {Set<string>}
 */
export function serviceAccountUids(userDocs) {
    return new Set((userDocs || []).filter(d => isServiceAccountEmail(d?.data?.email)).map(d => String(d.id)));
}

/**
 * Auth export (`{users: [...]}`) without the denylisted logins.
 * @param {{users: Array<Object>}} exported
 * @returns {{exported: {users: Array<Object>}, skipped: number}}
 */
export function filterAuthExport(exported) {
    const users = Array.isArray(exported?.users) ? exported.users : null;
    if (!users) throw new Error('Not an Auth export: expected {"users": [...]} (firebase auth:export --format=json)');
    const kept = users.filter(u => !isServiceAccountEmail(u?.email));
    return { exported: { ...exported, users: kept }, skipped: users.length - kept.length };
}
