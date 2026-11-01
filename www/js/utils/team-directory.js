/**
 * @fileoverview The team directory, `settings/team` (#87): names and roles of the
 * approved people, written by the owner's phone from the profiles it reads. Managers
 * read this one document (App health device names, notification fan-out) instead of
 * every profile, so emails and other profile fields stay owner-only.
 * Pure: no Firestore, AppState or DOM.
 * @module utils/team-directory
 */

const ROLES = ['owner', 'manager', 'staff'];
const GONE = ['pending', 'rejected', 'disabled'];

/** A profile that may use the shop: a known role and not pending, rejected or removed. */
export const isTeamMember = (u) => !!u && ROLES.includes(u.role) && !GONE.includes(u.status);

/**
 * The directory document for these profiles.
 * @param {Array<{id: string, name?: string, role?: string, status?: string}>} users
 * @returns {{people: Object<string, {name: string, role: string}>}}
 */
export function buildTeamDirectory(users) {
    const people = {};
    (users || []).filter(u => u && u.id && isTeamMember(u))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .forEach(u => { people[u.id] = { name: String(u.name || '').slice(0, 100), role: u.role }; });
    return { people };
}

/** The directory as the list the pages use: `[{ id, name, role }]`. */
export function teamPeople(doc) {
    const people = doc && typeof doc.people === 'object' && doc.people ? doc.people : {};
    return Object.entries(people)
        .filter(([, p]) => p && ROLES.includes(p.role))
        .map(([id, p]) => ({ id, name: String(p.name || ''), role: p.role }));
}

/** True when two directories list the same people with the same names and roles. */
export function sameTeam(a, b) {
    const key = (d) => JSON.stringify(teamPeople(d).sort((x, y) => x.id.localeCompare(y.id)));
    return key(a) === key(b);
}
