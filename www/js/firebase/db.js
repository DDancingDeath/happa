/**
 * @fileoverview What every part of the data layer shares: the Firestore instance,
 * collection names with the environment prefix, and the version stamp on writes of
 * figures built from bills. Moved out of firestore-service.js (docs/architecture.md,
 * phase 5).
 * @module firebase/db
 */

/**
 * Gets the Firestore database reference.
 * Attempts to get firebase.firestore() first, falls back to global db.
 * @returns {firebase.firestore.Firestore} The Firestore database instance
 * @throws {Error} If Firestore is not initialized
 */
export const getDb = () => {
    if (typeof firebase !== 'undefined' && firebase.firestore) {
        return firebase.firestore();
    }
    // Fallback to global db if available
    if (typeof db !== 'undefined') {
        return db;
    }
    throw new Error('Firestore not initialized');
};

/**
 * Gets the prefixed collection name based on environment
 * (window.COLLECTION_PREFIX: empty in production, the dev prefix on localhost).
 * @param {string} name - The base collection name
 * @returns {string} The prefixed collection name
 */
export const col = (name) => {
    const prefix = window.COLLECTION_PREFIX || '';
    return prefix + name;
};

/** Written on every stock-record write; firestore.rules rejects writes without it (blocks outdated apps). 4: knows voided bills (#75); 5: voided expenses (#99). */
export const CLIENT_VERSION = 5;

/**
 * `createdAt` of a new bill as written: the server time (firestore.rules
 * checks it for the 2-day edit window, #87); a plain time where the SDK has no
 * FieldValue (tests).
 */
export function serverCreatedAt() {
    const fv = typeof firebase !== 'undefined' ? firebase.firestore?.FieldValue : null;
    return typeof fv?.serverTimestamp === 'function' ? fv.serverTimestamp() : Date.now();
}

/**
 * Fields on every write of a figure built from bills (stock checkpoint, month snapshots, rate
 * stats): this app's version and the server time of the write. firestore.rules accept such a
 * write only from clientVersion >= 4 (knows voided bills, #75), stamped by that same write, so
 * an older app can't write one (not even a merge riding on a newer app's stored version).
 */
export function voidAwareStamp() {
    return { clientVersion: CLIENT_VERSION, writtenAt: serverCreatedAt() };
}
