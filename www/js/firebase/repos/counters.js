/**
 * @fileoverview Repository of the daily bill-number counters (`counters/{P|S|W}{YYYYMMDD}`,
 * docs/architecture.md phase 4). Helpers.generateBillNumber decides between this
 * shared counter and the per-device offline number (#41). Uses the `db` global from
 * firebaseConfig.js, as before.
 * @module firebase/repos/counters
 */

/**
 * Today's counter for one bill type.
 * @param {{prefix: string, dateStr: string, billsCollection: string, dayStart: number, dayEnd: number}} day
 *   billsCollection and [dayStart, dayEnd) (ms) find today's bills, used once to seed a new counter
 * @returns {{transactional: boolean, next: function(): Promise<number>}}
 *   transactional: the SDK can run the counter transaction;
 *   next(): atomically raises the counter and returns the new sequence number
 * @throws when Firestore is not available
 */
export function dayCounter({ prefix, dateStr, billsCollection, dayStart, dayEnd }) {
    const getCol = window.getCollection || ((name) => name);
    const todaysBills = db.collection(getCol(billsCollection))
        .where('timestamp', '>=', dayStart)
        .where('timestamp', '<', dayEnd);
    const counterRef = db.collection(getCol('counters')).doc(`${prefix}${dateStr}`);
    return {
        get transactional() {
            return typeof db.runTransaction === 'function';
        },
        next: () => nextCounterValue(counterRef, todaysBills, prefix, dateStr)
    };
}

/** Atomically increments and returns the day's bill counter. */
async function nextCounterValue(counterRef, todaysBills, prefix, dateStr) {
    let existingCount = null;
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(counterRef);
        const data = snap.exists ? (snap.data() || {}) : {};
        let current = Number(data.next) || 0;
        if (!data.initialized) {
            // Bills may already exist today (counter introduced mid-day or
            // numbers reserved offline): never issue a number below them.
            if (existingCount === null) {
                existingCount = (await todaysBills.get()).size;
            }
            current = Math.max(current, existingCount);
        }
        const next = current + 1;
        tx.set(counterRef, {
            next,
            initialized: true,
            prefix,
            date: dateStr,
            updatedAt: Date.now()
        }, { merge: true });
        return next;
    });
}
