/**
 * @fileoverview Repository of user profiles for the Users / Admin pages, the people
 * lists (owner: every profile; managers: the team directory, #87) and the profile cache
 * the notification fan-out reads. Moved verbatim out of firestore-service.js
 * (docs/architecture.md, phase 5); still called as FirebaseService.loadUsers() etc.
 * @module firebase/repos/user-profiles
 */

import { AppState } from '../../utils/state.js';
import { getDb, col } from '../db.js';
import { isOffline, needsInternetError } from '../../utils/write-conflict.js';
import { localISODaysAgo } from '../../utils/dates.js';
import { safeSetItem } from '../../utils/storage-full.js';
import { backgroundReadsAllowed } from '../firestore-meter.js';
import { readTeamDirectory, writeTeamDirectory } from './users.js';
import { buildTeamDirectory, isTeamMember, sameTeam, teamPeople } from '../../utils/team-directory.js';

/** Users list cache for notification fan-out (avoids a query per edit). */
const USERS_CACHE_TTL_MS = 10 * 60 * 1000;
let usersCache = null;
/** Every profile, for naming audit entries (owner; Diagnostics, Settings, the anomaly scan). */
let auditPeopleCache = null;

// Owner: every profile; managers: the team directory (#87), never other profiles.
export const getUsersForNotifications = async () => {
    if (usersCache && Date.now() - usersCache.at < USERS_CACHE_TTL_MS) {
        return usersCache.users;
    }
    let users;
    if (AppState.userRole === 'owner') {
        const snapshot = await getDb().collection(col('users')).get();
        const profiles = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        // Only from the server: a cached list could undo another owner device's change
        if (!snapshot.metadata?.fromCache) queueTeamSync(profiles);
        users = profiles.filter(isTeamMember).map(u => ({ id: u.id, role: u.role }));
    } else {
        users = teamPeople(await readTeamDirectory()).map(p => ({ id: p.id, role: p.role }));
    }
    usersCache = { at: Date.now(), users };
    return users;
};

/** The team directory as last read or written on this phone (undefined: not read yet). */
let knownTeam;
/** Syncs run one after another, so two reads of the profiles never write twice. */
let teamSync = Promise.resolve(false);

/** Owner only: rewrites settings/team when the profiles say something else (#87). */
async function syncTeamDirectory(users) {
    const next = buildTeamDirectory(users);
    if (knownTeam === undefined) knownTeam = await readTeamDirectory();
    if (knownTeam && sameTeam(knownTeam, next)) return false;
    await writeTeamDirectory(next);
    knownTeam = next;
    return true;
}

/** Queues a sync after any running one; never rejects. @returns {Promise<boolean>} true when it wrote */
function queueTeamSync(users) {
    teamSync = teamSync.catch(() => false).then(() => syncTeamDirectory(users))
        .catch(e => {
            console.warn('Team directory not updated:', e?.code || e);
            return false;
        });
    return teamSync;
}

/** FirebaseService methods for user profiles; spread into FirebaseService (`this` is FirebaseService). */
export const userProfileMethods = {
    /** Server timestamp sentinel for user-profile writes. */
    serverTimestamp() {
        return firebase.firestore.FieldValue.serverTimestamp();
    },

    /**
     * All user profiles, newest `createdAt` first (sorted client-side so legacy
     * profiles without `createdAt` are kept, at the end). On the owner's phone the
     * team directory (`settings/team`, #87) is brought in line with them.
     * @returns {Promise<Object[]>} `{ id, ...data }` per profile
     */
    async loadUsers() {
        const snapshot = await getDb().collection(col('users')).get();
        const createdMs = (u) => {
            const c = u.createdAt;
            return c?.toMillis ? c.toMillis() : (c ? new Date(c).getTime() || 0 : 0);
        };
        const users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
            .sort((a, b) => createdMs(b) - createdMs(a));
        if (AppState.userRole === 'owner' && !snapshot.metadata?.fromCache) {
            queueTeamSync(users);
        }
        return users;
    },

    /**
     * The people of the team as `[{ id, name, role, ... }]`: the owner reads the
     * profiles; managers read only the team directory (#87, one read).
     * @returns {Promise<Object[]>}
     */
    async loadPeople() {
        if (AppState.userRole === 'owner') return this.loadUsers();
        return teamPeople(await readTeamDirectory());
    },

    /**
     * Every profile (owner), to name the writer of audit entries (#85); reused for 10 minutes.
     * @returns {Promise<Object[]>}
     */
    async loadAuditPeople() {
        if (auditPeopleCache && Date.now() - auditPeopleCache.at < USERS_CACHE_TTL_MS) return auditPeopleCache.users;
        const users = await this.loadUsers();
        auditPeopleCache = { at: Date.now(), users };
        return users;
    },

    /** Forgets the cached people lists (sign-out: the next user may have another role). */
    forgetPeopleCaches() {
        usersCache = null;
        auditPeopleCache = null;
        knownTeam = undefined;
    },

    /**
     * Owner only, at most once a day per phone: reads the profiles (one read each,
     * plus the directory) and rewrites the team directory when it is missing or
     * says something else, e.g. a name changed in Settings › account.
     * @returns {Promise<boolean>} true when it wrote the directory
     */
    async ensureTeamDirectory() {
        const uid = AppState.currentUser?.uid;
        if (AppState.userRole !== 'owner' || !uid) return false;
        const key = 'happaTeamDirectoryDay';
        const mark = `${uid}|${localISODaysAgo(0)}`;
        if (localStorage.getItem(key) === mark) return false;
        // Offline the profiles come from the cache, which must not overwrite the directory;
        // a heavy session skips this background read (read guard)
        if ((typeof navigator !== 'undefined' && navigator.onLine === false) || !backgroundReadsAllowed()) return false;
        await this.loadUsers();
        const wrote = await teamSync;
        safeSetItem(key, mark);
        return wrote;
    },

    /** Partial update of a user profile (role/status/approval fields). Needs the internet (#113). */
    async updateUser(userId, fields) {
        if (isOffline()) throw needsInternetError();
        await getDb().collection(col('users')).doc(userId).update(fields);
        usersCache = null;
        auditPeopleCache = null;
    },

    /**
     * Rejects a registration (#84): the profile stays as `status: 'rejected'`, so
     * the person can't register again as pending; the owner can restore it.
     */
    async rejectUserProfile(userId, byUid) {
        if (isOffline()) throw needsInternetError();
        await getDb().collection(col('users')).doc(userId).update({
            status: 'rejected',
            rejectedAt: firebase.firestore.FieldValue.serverTimestamp(),
            rejectedBy: byUid || null
        });
        usersCache = null;
        auditPeopleCache = null;
    },

    /**
     * Restores a removed or rejected person as a pending registration (#84): the
     * owner then approves them with a role like any new registration.
     */
    async restoreUserProfile(userId) {
        if (isOffline()) throw needsInternetError();
        const del = firebase.firestore.FieldValue.delete();
        await getDb().collection(col('users')).doc(userId).update({
            status: 'pending',
            role: 'staff',
            disabledAt: del,
            disabledBy: del,
            rejectedAt: del,
            rejectedBy: del
        });
        usersCache = null;
        auditPeopleCache = null;
    },

    /**
     * Removes a user's access (#74): role and approval are cleared and the profile
     * is kept as `status: 'disabled'`, so the rules refuse it and the person can't
     * re-register as pending. The Auth account itself needs the Admin SDK.
     */
    async disableUserProfile(userId, byUid) {
        if (isOffline()) throw needsInternetError();
        const del = firebase.firestore.FieldValue.delete();
        await getDb().collection(col('users')).doc(userId).update({
            status: 'disabled',
            role: del,
            rentRole: del,
            approvedAt: del,
            approvedBy: del,
            disabledAt: firebase.firestore.FieldValue.serverTimestamp(),
            disabledBy: byUid || null
        });
        usersCache = null;
        auditPeopleCache = null;
    }
};
