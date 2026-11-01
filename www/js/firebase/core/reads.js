/**
 * @fileoverview One-shot Firestore reads that cannot hang (getWithRetry), shared by
 * the data layer. Moved verbatim out of firestore-service.js (docs/architecture.md,
 * phase 5, #69).
 * @module firebase/core/reads
 */

/** Per-attempt timeout of one-shot history reads (see getWithRetry). */
const GET_TIMEOUT_MS = 15000;

/**
 * One-shot read that cannot hang. query.get() is served through the watch
 * stream and resolves only once its target is CURRENT; when the backend never
 * marks it current (reproduced on the emulator: ADD without CURRENT) the
 * promise never settles, and a plain retry of the same query would join the
 * same stuck target. So each attempt times out and the retry uses a
 * different-but-equivalent query (`makeQuery(attempt)`), i.e. a new target.
 * @param {Object|Function} query query/doc ref, or attempt => query
 * @private
 */
export async function getWithRetry(query, label, { attempts = 4, timeoutMs = GET_TIMEOUT_MS } = {}) {
    const makeQuery = typeof query === 'function' ? query : () => query;
    let lastError = null;
    for (let i = 0; i < attempts; i++) {
        let timer = null;
        try {
            return await Promise.race([
                makeQuery(i).get(),
                new Promise((_, reject) => {
                    // Escalating timeout so a slow (not stuck) connection isn't charged repeated reads.
                    timer = setTimeout(() => reject(Object.assign(new Error(`${label}: read timed out`), { code: 'deadline-exceeded' })), timeoutMs * 2 ** i);
                })
            ]);
        } catch (e) {
            lastError = e;
            if (e?.code !== 'deadline-exceeded' && e?.code !== 'unavailable') throw e;
            console.warn(`${label}: one-shot read attempt ${i + 1} failed (${e.code}), retrying`);
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastError;
}
