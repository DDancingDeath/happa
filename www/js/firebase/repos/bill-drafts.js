/**
 * @fileoverview Repository of the bill editor's unsaved state (docs/architecture.md,
 * phase 4): drafts (`drafts/{id}`), the per-user auto-save (`autoSaves/{uid}`) and
 * the shared item order (`itemFrequency/global`). The only code that touches those
 * collections from the app; billing.js gets plain data back. Uses the `db` global
 * from firebaseConfig.js, as the page did.
 * @module firebase/repos/bill-drafts
 */

const name = (n) => (window.getCollection ? window.getCollection(n) : n);

// -------------------- DRAFTS --------------------

/**
 * Stores a draft under its client-made id. Not async: the write is queued on the
 * phone at once (also offline) and a failure to start it throws here.
 * @param {Object} draft - with `id`
 * @returns {Promise<void>} the server acknowledgement
 */
export function saveDraft(draft) {
    return db.collection(name('drafts')).doc(draft.id).set(draft);
}

/**
 * This user's drafts (one query, unordered).
 * @param {string} uid
 * @returns {Promise<Object[]>} `{ id, ...data }`
 */
export async function listDrafts(uid) {
    const snapshot = await db.collection(name('drafts'))
        .where('userId', '==', uid)
        .get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

/**
 * How many drafts this user has (the same query as listDrafts).
 * @param {string} uid
 * @returns {Promise<number>}
 */
export async function countDrafts(uid) {
    const snapshot = await db.collection(name('drafts'))
        .where('userId', '==', uid)
        .get();
    return snapshot.size;
}

/**
 * @param {string} draftId
 * @returns {Promise<?Object>} the draft's data, or null when it is gone
 */
export async function getDraft(draftId) {
    const draftDoc = await db.collection(name('drafts')).doc(draftId).get();
    return draftDoc.exists ? draftDoc.data() : null;
}

/** @param {string} draftId */
export async function deleteDraft(draftId) {
    await db.collection(name('drafts')).doc(draftId).delete();
}

// -------------------- AUTO-SAVE --------------------

/**
 * Replaces this user's auto-save; `lastSaved` is the server time.
 * @param {string} uid
 * @param {Object} fields - userId, userName, mode, deviceInfo, purchase, sale
 */
export async function saveAutoSave(uid, { userId, userName, mode, deviceInfo, ...rest }) {
    await db.collection(name('autoSaves')).doc(uid).set({
        userId,
        userName,
        mode,
        lastSaved: firebase.firestore.FieldValue.serverTimestamp(),
        deviceInfo,
        ...rest
    });
}

/** @param {string} uid */
export async function deleteAutoSave(uid) {
    await db.collection(name('autoSaves')).doc(uid).delete();
}

/**
 * @param {string} uid
 * @returns {Promise<?Object>} the auto-save (`lastSaved` is a Firestore timestamp), or null
 */
export async function getAutoSave(uid) {
    const autoSaveDoc = await db.collection(name('autoSaves')).doc(uid).get();
    return autoSaveDoc.exists ? autoSaveDoc.data() : null;
}

// -------------------- ITEM FREQUENCY --------------------

/**
 * The shared item order (one document for every user).
 * @returns {Promise<?Object>} `{ purchase, sale }` or null when there is none yet
 */
export async function loadItemFrequency() {
    const doc = await db.collection(name('itemFrequency')).doc('global').get();
    return doc.exists ? doc.data() : null;
}

/**
 * Adds a bill's items to the shared order: score and count are atomic increments
 * (devices never overwrite each other), lastUsed / effectiveScore are plain values.
 * A nested object with merge (not dotted paths), so item ids with '.' or '/' stay
 * literal map keys.
 * @param {'purchase'|'sale'} mode
 * @param {Object<string, {score: number, count: number, lastUsed: number, effectiveScore: number}>} added
 *   per item: the score and count to add, and the new lastUsed / effectiveScore
 */
export async function addItemFrequency(mode, added) {
    const FieldValue = firebase.firestore.FieldValue;
    const modeUpdate = {};
    Object.entries(added).forEach(([itemId, a]) => {
        modeUpdate[itemId] = {
            score: FieldValue.increment(a.score),
            count: FieldValue.increment(a.count),
            lastUsed: a.lastUsed,
            effectiveScore: a.effectiveScore
        };
    });
    await db.collection(name('itemFrequency')).doc('global')
        .set({ [mode]: modeUpdate }, { merge: true });
}
