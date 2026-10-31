/**
 * @fileoverview Repository of user profiles (`users/{uid}`, docs/architecture.md
 * phase 4) for sign-in and registration: the profile read (cache first, or from
 * the server) and the pending profile made on registration. The Users admin page
 * goes through FirebaseService (loadUsers, updateUser…).
 * @module firebase/repos/users
 */

const userRef = (uid) => firebase.firestore()
    .collection(window.getCollection ? window.getCollection('users') : 'users').doc(uid);

/**
 * Replaces the person's own list of phones (#124; rules: only `name` and `devices`).
 * @param {string} uid
 * @param {string[]} devices
 * @returns {Promise<void>}
 */
export function setOwnDevices(uid, devices) {
    return userRef(uid).update({ devices });
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
