/**
 * @fileoverview Server confirmation of a session's data (#59, utils/data-freshness.js): the
 * state is 'cache' while any data listener has only answered from the phone's cache, 'server' once
 * every one heard from the server (a failed one counts as answered); writers of derived data wait
 * for it.
 */

import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';
import { defaultWindowStart } from '../utils/history-range.js';
import { itemsSignature, STOCK_REPLAY_FORMAT } from '../utils/stock-replay.js';
import { on, DATA_FRESHNESS_CHANGED } from '../utils/events.js';

const NOW = Date.now();
const ITEMS = [{ id: 'i1', name: 'Gehu' }];
let fake;

function install(options) {
    fake = createFakeFirestore(options);
    global.firebase = fake.firebase;
    fake.seed('items', ITEMS);
    fake.seed('stockCheckpoints', [{
        id: 'current', formatVersion: STOCK_REPLAY_FORMAT, asOf: defaultWindowStart(NOW), state: [], resolutions: [],
        itemsSignature: itemsSignature(ITEMS), stale: false, staleCount: 0, builtAt: NOW, fullBuiltAt: NOW
    }]);
    fake.seed('purchases', [{ id: 'p1', timestamp: NOW - 1000, date: new Date(NOW - 1000).toISOString() }]);
}

/** Starts the listeners while the server is held back: startup goes on from the cache after its grace. */
async function startFromCache() {
    jest.useFakeTimers();
    let ready = false;
    const started = FirebaseService.setupRealtimeListeners().then(() => { ready = true; });
    for (let i = 0; i < 8 && !ready; i++) {
        await fake.settle();
        jest.advanceTimersByTime(2600);
    }
    await started;
    jest.useRealTimers();
}

describe('data freshness (#59)', () => {
    let events;
    let off;
    beforeEach(() => {
        AppState.currentUser = null;
        AppState.userRole = 'owner';
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        events = [];
        off = on(DATA_FRESHNESS_CHANGED, s => events.push(s));
    });

    afterEach(() => {
        off();
        FirebaseService.cleanup();
        jest.useRealTimers();
        jest.restoreAllMocks();
        delete global.firebase;
        AppState.userRole = null;
    });

    it('stays "cache" while figures come only from the phone, then turns "server" once', async () => {
        install({ holdServer: true });
        await startFromCache();
        expect(AppState.purchaseHistory.map(p => p.id)).toEqual(['p1']);
        expect(FirebaseService.dataFreshness()).toBe('cache');
        let confirmed = null;
        FirebaseService.whenServerConfirmed().then(v => { confirmed = v; });
        await fake.settle();
        expect(confirmed).toBeNull();

        fake.releaseServer();
        await fake.settle();
        expect(FirebaseService.dataFreshness()).toBe('server');
        expect(confirmed).toBe(true);
        expect(events.filter(s => s === 'server')).toHaveLength(1);
        await expect(FirebaseService.whenServerConfirmed()).resolves.toBe(true);
    });

    it('a session that ends first tells the waiters false; with no session there is no state', async () => {
        install({ holdServer: true });
        await startFromCache();
        const waiting = FirebaseService.whenServerConfirmed();
        FirebaseService.cleanup();
        await expect(waiting).resolves.toBe(false);
        expect(FirebaseService.dataFreshness()).toBeNull();
    });

    it('a failed optional listener counts as answered', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        install({ failures: { withdrawals: new Error('withdrawals down') } });
        await FirebaseService.setupRealtimeListeners();
        await fake.settle();
        expect(FirebaseService.dataFreshness()).toBe('server');
    });

    it('stock checkpoint maintenance waits for the server', async () => {
        const maintain = jest.spyOn(FirebaseService, 'maintainStockCheckpoint').mockResolvedValue('current');
        install({ holdServer: true });
        await startFromCache();
        await fake.settle();
        expect(maintain).not.toHaveBeenCalled();
        fake.releaseServer();
        await fake.settle();
        expect(maintain).toHaveBeenCalledTimes(1);
    });
});
