/**
 * @fileoverview Repository of user profiles (`users/{uid}`, docs/architecture.md
 * phase 4) for sign-in and registration: the profile read (cache first, or from
 * the server) and the pending profile made on registration; and each person's
 * phone list (`deviceLog/{uid}`, #124). The Users admin page goes through
 * FirebaseService (loadUsers, updateUser…).
 * @module firebase/repos/users
 */

const userRef = (uid) => firebase.firestore()
    .collection(window.getCollection ? window.getCollection('users') : 'users').doc(uid);

const deviceLogRef = (uid) => firebase.firestore()
    .collection(window.getCollection ? window.getCollection('deviceLog') : 'deviceLog').doc(uid);

/**
 * The person's own list of phones (#124, `deviceLog/{uid}`: read by that person and the owner).
 * @param {string} uid
 * @returns {Promise<string[]|null>} null when nothing was saved yet
 */
export async function readOwnDevices(uid) {
    const doc = await deviceLogRef(uid).get();
    return doc.exists ? (doc.data().devices || []) : null;
}

/**
 * Adds a phone to the person's own list (rules: `devices` only, at most 10
 * "id:YYYYMMDD" entries): arrayUnion, so two phones adding themselves never lose
 * each other; a full list is replaced by `replaceWith` (oldest dropped).
 * @param {string} uid
 * @param {string} entry
 * @param {string[]|null} replaceWith
 * @returns {Promise<void>}
 */
export function addOwnDevice(uid, entry, replaceWith) {
    return deviceLogRef(uid).set({
        devices: replaceWith || firebase.firestore.FieldValue.arrayUnion(entry)
    }, { merge: true });
}

/**
 * One user's profile; read() reads it (with the same document reference each time).
 * @param {string} uid
 * @returns {{read: function({source?: 'server'|'cache'}=): Promise<{exists: boolean, data: (Object|undefined), fromCache: boolean}>}}
 *   read() without options: the SDK default (the offline cache when there is no connection)
 */
export function userProfile(uid) {
    const ref = userRef(uid);
    return {
        async read(options) {
            const doc = await (options ? ref.get(options) : ref.get());
            return { exists: doc.exists, data: doc.data(), fromCache: !!doc.metadata?.fromCache };
        }
    };
}

/**
 * Creates the pending profile of a new account in a transaction (which reads from
 * the server, never the offline cache), so an existing - possibly already
 * approved - profile is never overwritten. `createdAt` is the server time.
 * @param {string} uid
 * @param {{name: string, email: string, role: string, status: string}} profile
 * @returns {Promise<boolean>} true if created, false if a profile already existed
 */
export function createProfileIfMissing(uid, profile) {
    const db = firebase.firestore();
    const ref = db.collection(window.getCollection ? window.getCollection('users') : 'users').doc(uid);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists) {
            return false;
        }
        tx.set(ref, { ...profile, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
        return true;
    });
}
