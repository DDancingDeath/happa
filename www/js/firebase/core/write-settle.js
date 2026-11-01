/**
 * @fileoverview When a write counts as saved (#70, #153): the server acknowledged
 * it, or this phone confirmed it stored it (offline at once, online after a short
 * wait), never when the phone refused it. Moved verbatim out of
 * firestore-service.js (docs/architecture.md, phase 5, #69).
 * @module firebase/core/write-settle
 */

import { getDb, col } from '../db.js';
import { isQuotaExhaustedError } from '../../utils/quota-guard.js';
import { isStorageFullError, STORAGE_FULL_KEY } from '../../utils/storage-full.js';
import { t } from '../../i18n/index.js';

/** Max time a bill save waits for the server to acknowledge a write. */
const WRITE_ACK_TIMEOUT_MS = 1500;
/** Max time a bill save waits for this phone to confirm it stored the write. */
export const LOCAL_STORE_WAIT_MS = 10000;
/** Same for a new expense (shown at once, so a shorter wait behind the spinner). */
export const EXPENSE_STORE_WAIT_MS = 4000;

/**
 * Resolves true once a write issued before this call is in this device's local
 * cache, false if the device refused it (e.g. storage full, #153), null if that
 * is still unknown after `timeoutMs`. The SDK runs its operations in order, so a
 * cache-only read queued after the write ends only after the write was stored.
 * Reads nothing from the server.
 * @param {Promise} writePromise
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean|null>}
 */
export function whenStoredLocally(writePromise, timeoutMs = LOCAL_STORE_WAIT_MS) {
    let refused = false;
    let timer = null;
    const outcome = Promise.resolve(writePromise).then(() => true, () => { refused = true; return false; });
    let barrier;
    try {
        barrier = Promise.resolve(getDb().collection(col('items')).doc('__localWriteBarrier').get({ source: 'cache' }));
    } catch (e) {
        barrier = Promise.reject(e);
    }
    const afterBarrier = barrier.catch(() => null).then(() => !refused);
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
    return Promise.race([outcome, afterBarrier, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Waits for a Firestore write without blocking the UI on the server round trip.
 * With offline persistence the write is applied to the local cache and queued as
 * soon as it is issued, so this resolves when the server acknowledges it, or once
 * this device has confirmed it stored the write: offline at once, online after
 * WRITE_ACK_TIMEOUT_MS (the write keeps syncing in the background). If that is
 * not confirmed within LOCAL_STORE_WAIT_MS it resolves with stored=false, and
 * the caller must not report the write as saved. Errors before resolving reject
 * (a write the device refused is never reported as saved); errors after it are
 * logged and surfaced as a toast so a rejected write is never silent.
 * @param {Promise<void>} writePromise - Promise returned by set()/update()/add()
 * @param {string} label - Name used in logs
 * @returns {Promise<{pending: boolean, stored: boolean}>} pending=true if not yet
 *   acknowledged; stored=false if not even confirmed on this device
 */
export function settleWrite(writePromise, label = 'write') {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return new Promise((resolve, reject) => {
        let released = false;
        let storedHere = false;
        let ackWindowOver = offline;
        let ackTimer = null;
        const finish = (result) => {
            if (released) return;
            released = true;
            clearTimeout(ackTimer);
            resolve(result);
        };
        const releaseIfStored = () => {
            if (ackWindowOver && storedHere) finish({ pending: true, stored: true });
        };
        writePromise.then(
            () => finish({ pending: false, stored: true }),
            (error) => {
                clearTimeout(ackTimer);
                if (!released) {
                    released = true;
                    reject(error);
                    return;
                }
                console.error(`[${label}] write failed after it was queued:`, error);
                // The quota banner already explains this one (#194).
                if (isQuotaExhaustedError(error)) return;
                const text = isStorageFullError(error)
                    ? t(STORAGE_FULL_KEY)
                    : t('msg.sync.save_failed_on_server', { value: error?.message || error });
                import('../../ui/ui-manager.js')
                    .then(({ UIManager }) => UIManager.showToast(text, 'error'))
                    .catch(() => {});
            }
        );
        whenStoredLocally(writePromise, LOCAL_STORE_WAIT_MS).then(stored => {
            if (stored) {
                storedHere = true;
                releaseIfStored();
            } else if (stored === null) {
                finish({ pending: true, stored: false });
            }
        });
        if (!offline) {
            ackTimer = setTimeout(() => {
                ackWindowOver = true;
                releaseIfStored();
            }, WRITE_ACK_TIMEOUT_MS);
        }
    });
}
