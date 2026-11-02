/**
 * @fileoverview Stock for the screens: the replay of the stock checkpoint's state plus the
 * loaded window, or of all history when no checkpoint is usable (and then the rebuild), the
 * approximate stock members get from a stale checkpoint, and its cache. Moved verbatim out of
 * firestore-service.js (docs/architecture.md, phase 5, #69).
 * @module firebase/core/stock
 */

import { S } from './session.js';
import {
    approximateCheckpoint, FRESH_CHECKPOINT_WAIT_MS, FULL_LOAD_RETRY_MS, leaseWaitedMs, pendingStocks,
    REBUILD_LEASE_MS, requestRebuild, usableCheckpoint, waitForCheckpoint
} from './stock-checkpoint.js';
import { AppState } from '../../utils/state.js';
import { markDirty, unsubscribeFunctions } from './realtime.js';
import { afterFirstPaint } from '../../utils/background-tasks.js';
import { computeStock, computeStockFrom } from '../../utils/stock-replay.js';
import { currentSources } from './history-window.js';
import { decideStockRebuild, LEASE_MAX_WAIT_MS } from '../../utils/rebuild-lease.js';
import { canManageCheckpoint } from './records.js';

/** FirebaseService stock methods; spread into FirebaseService (`this` is FirebaseService). */
export const stockMethods = {
    /**
     * Startup: computes stock if that needs no full-history read; otherwise
     * starts it in the background (AppState.stockReady stays false until the
     * exact stock is available; screens show "Stock updating…").
     * With `defer`, stock is always computed right after the first screen is
     * painted (#13); the returned promise resolves once that is done.
     * @param {{defer?: boolean}} [opts]
     * @returns {Promise<void>}
     */
    async prepareStock({ defer = false } = {}) {
        if (!defer && (!S.windowState || usableCheckpoint() || AppState.historyLoadedFrom === 0)) {
            await this.getStock();
            return;
        }
        AppState.stockReady = false;
        const gen = S.sessionGen;
        const run = () => this.getStock()
            .then(() => {
                if (gen === S.sessionGen) markDirty(['stockView', 'itemsList', 'billingDropdown', 'salesDropdown'], false);
            })
            .catch(e => console.error('Background stock calculation failed:', e));
        if (!defer) {
            run();
            return;
        }
        await new Promise(resolve => afterFirstPaint(() => run().then(resolve)));
    },

    /**
     * Calculates current stock levels from purchases, sales and adjustments.
     *
     * All events are merged into one timeline and applied in strict
     * chronological order (weighted-average cost with deficit rules; see
     * utils/stock-replay.js). While listeners are active and a valid stock
     * checkpoint is available, only events with t >= checkpoint.asOf are
     * replayed on top of the checkpoint's running state, which gives exactly
     * the same result as a full replay. Without a usable checkpoint the full
     * history is loaded once (ensureHistoryFrom(null)) and replayed, and a
     * checkpoint rebuild is requested in the background.
     *
     * @async
     * @returns {Promise<Object.<string, {quantity: number, rate: number}>>} Stock object keyed by item ID
     */
    async calculateStock() {
        S.lastStockApprox = null;
        if (!S.windowState) {
            return computeStock(currentSources(), AppState.items);
        }
        let cp = usableCheckpoint();
        if (cp) {
            return computeStockFrom(cp.state, cp.asOf, currentSources(), AppState.items);
        }
        if (AppState.historyLoadedFrom !== 0) {
            // One device rebuilds (lease) and does the only full-history read;
            // the others wait for its checkpoint instead of each reading everything (#194).
            // Members use the last (stale) checkpoint as approximate stock instead (#129).
            const approx = approximateCheckpoint();
            const plan = decideStockRebuild({
                canManage: canManageCheckpoint(),
                leaseUntil: S.checkpointDoc?.rebuildingUntil || 0,
                leaseBy: S.checkpointDoc?.rebuildingBy || null,
                uid: AppState.currentUser?.uid || null,
                now: Date.now(),
                waitedMs: leaseWaitedMs(),
                inFlight: !!S.rebuildPromise,
                attempted: S.rebuildAttempted,
                approxAvailable: !!approx
            });
            if (plan === 'approximate') {
                S.lastStockApprox = { builtAt: approx.builtAt || 0, asOf: approx.asOf };
                return computeStockFrom(approx.state, approx.asOf, currentSources(), AppState.items);
            }
            if (plan === 'wait') return waitForCheckpoint(S.checkpointDoc.rebuildingUntil);
            if (plan === 'join' || plan === 'rebuild') {
                let result = null;
                try {
                    result = await (plan === 'join' ? S.rebuildPromise : this.rebuildStockCheckpoint());
                } catch (e) {
                    console.error('Stock checkpoint rebuild failed:', e);
                }
                if (!S.windowState) return computeStock(currentSources(), AppState.items);
                cp = usableCheckpoint();
                if (cp) {
                    return computeStockFrom(cp.state, cp.asOf, currentSources(), AppState.items);
                }
                if (leaseWaitedMs() < LEASE_MAX_WAIT_MS) {
                    if (result?.status === 'leased') return waitForCheckpoint(S.checkpointDoc?.rebuildingUntil || Date.now() + REBUILD_LEASE_MS);
                    // Built elsewhere moments ago: the checkpoint listener delivers it shortly.
                    if (result?.status === 'fresh') return waitForCheckpoint(Date.now() + FRESH_CHECKPOINT_WAIT_MS);
                }
            }
        }
        if (AppState.historyLoadedFrom !== 0) {
            try {
                await this.ensureHistoryFrom(null);
            } catch (e) {
                console.error('Loading full history for stock failed:', e);
            }
            if (AppState.historyLoadedFrom !== 0 && S.windowState) {
                // Not exact without full history: retry and recompute shortly.
                const gen = S.sessionGen;
                setTimeout(() => {
                    if (gen === S.sessionGen) markDirty(['stockView'], true);
                }, FULL_LOAD_RETRY_MS);
            }
            cp = usableCheckpoint();
            if (cp) {
                return computeStockFrom(cp.state, cp.asOf, currentSources(), AppState.items);
            }
        }
        // The rebuild reuses the full history just loaded.
        if (!S.rebuildAttempted) requestRebuild();
        return computeStock(currentSources(), AppState.items);
    },

    /**
     * Returns the cached stock when it was computed from the current listener
     * data (and nobody has replaced AppState.stock since); otherwise
     * recalculates it, stores it in AppState.stock and returns it.
     * @async
     * @returns {Promise<Object.<string, {quantity: number, rate: number}>>}
     */
    async getStock() {
        if (unsubscribeFunctions.length > 0 && S.stockCache.stock && S.stockCache.stock === AppState.stock && S.stockCache.version === S.dataVersion) {
            // Only ready stock is cached (pending results clear the cache).
            AppState.stockReady = true;
            return AppState.stock;
        }
        const version = S.dataVersion;
        const stock = await this.calculateStock();
        AppState.stock = stock;
        AppState.stockApprox = S.lastStockApprox;
        if (pendingStocks.has(stock)) {
            // Last known stock is shown as "updating" until the checkpoint arrives.
            AppState.stockReady = false;
            S.stockCache = {};
            return stock;
        }
        AppState.stockReady = true;
        S.stockCache = { stock, version };
        return stock;
    }
};
