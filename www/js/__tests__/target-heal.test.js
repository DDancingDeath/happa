/**
 * @fileoverview Healing the listeners' stored queries (#59, firebase/core/target-heal.js): each
 * history listener is re-subscribed once when its stored query is new or its collection was
 * read since, its first snapshot is diffed against what the app has (no change → nothing
 * re-published), and the fake SDK resumes it without new reads.
 */

import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';
import { defaultWindowStart } from '../utils/history-range.js';
import { itemsSignature, STOCK_REPLAY_FORMAT } from '../utils/stock-replay.js';
import { resyncSnapshot } from '../firebase/core/realtime.js';
import { docIds } from '../firebase/core/records.js';
import {
    HEAL_STORE_KEY, loadHealRecord, needsHeal, noteCollectionRead, saveHealRecord
} from '../firebase/core/target-heal.js';

const NOW = Date.now();
const W = defaultWindowStart(NOW);
const ITEMS = [{ id: 'i1', name: 'Gehu' }];
const bill = (id, t, extra = {}) => ({ id, timestamp: t, date: new Date(t).toISOString(), openDue: false, ...extra });

describe('resyncSnapshot', () => {
    const doc = (id, data) => ({ id, data: () => ({ ...data }), isEqual: (o) => o.id === id && o.raw === data, raw: data });
    const snap = (...docs) => ({ docs, size: docs.length });
    const mapFn = (d) => {
        const rec = { id: d.id, ...d.data() };
        docIds.set(rec, d.id);
        return rec;
    };

    it('keeps the records of unchanged documents and reports no change', () => {
        const a = { v: 1 };
        const b = { v: 2 };
        const prev = snap(doc('a', a), doc('b', b));
        const live = { docs: prev.docs.map(mapFn), initialized: true };
        const recs = live.docs.slice();
        const out = resyncSnapshot(live, prev, snap(doc('a', a), doc('b', b)), mapFn);
        expect(out).toEqual({ changed: false, changes: [] });
        expect(live.docs[0]).toBe(recs[0]);
        expect(live.docs[1]).toBe(recs[1]);
    });

    it('reports what changed meanwhile as added, modified and removed, in the new order', () => {
        const a = { v: 1 };
        const b = { v: 2 };
        const prev = snap(doc('a', a), doc('b', b));
        const live = { docs: prev.docs.map(mapFn), initialized: true };
        const [recA, recB] = live.docs;
        const out = resyncSnapshot(live, prev, snap(doc('c', { v: 3 }), doc('a', { v: 9 })), mapFn);
        expect(out.changed).toBe(true);
        expect(out.changes).toEqual([
            { type: 'added', docId: 'c', oldRec: null, newRec: { id: 'c', v: 3 } },
            { type: 'modified', docId: 'a', oldRec: recA, newRec: { id: 'a', v: 9 } },
            { type: 'removed', docId: 'b', oldRec: recB, newRec: null }
        ]);
        expect(live.docs.map(r => [r.id, r.v])).toEqual([['c', 3], ['a', 9]]);
    });

    it('falls back to a full refresh when its records do not line up with the last snapshot', () => {
        const a = { v: 1 };
        const prev = snap(doc('a', a));
        const live = { docs: [], initialized: true };
        expect(resyncSnapshot(live, prev, snap(doc('a', a)), mapFn)).toEqual({ changed: true, changes: null });
        expect(live.docs.map(r => r.id)).toEqual(['a']);
    });
});

describe('heal record', () => {
    beforeEach(() => localStorage.removeItem(HEAL_STORE_KEY));

    it('a query needs healing when new or when its collection was read from the server since', () => {
        const record = { reads: { purchases: 100 }, synced: { 'purchases|from|1': 200, 'purchases|openDue|1': 50 } };
        expect(needsHeal(record, 'purchases|from|1', 'purchases')).toBe(false);
        expect(needsHeal(record, 'purchases|openDue|1', 'purchases')).toBe(true);
        expect(needsHeal(record, 'purchases|from|2', 'purchases')).toBe(true);
    });

    it('keeps this session\'s keys and the most recent others; survives bad storage', () => {
        const synced = {};
        for (let i = 0; i < 200; i++) synced[`k${i}`] = i;
        saveHealRecord({ reads: {}, synced }, localStorage, new Set(['k0']));
        const kept = loadHealRecord().synced;
        expect(Object.keys(kept)).toHaveLength(150);
        expect(kept.k0).toBe(0);
        expect(kept.k199).toBe(199);
        expect(kept.k51).toBe(51);
        expect(kept.k50).toBeUndefined();
        noteCollectionRead('purchases', 5);
        expect(loadHealRecord().reads.purchases).toBe(5);
        localStorage.setItem(HEAL_STORE_KEY, '{oops');
        expect(loadHealRecord()).toEqual({ reads: {}, synced: {} });
    });
});

describe('healing the data listeners', () => {
    let fake;

    const install = () => {
        fake = createFakeFirestore();
        global.firebase = fake.firebase;
        fake.seed('items', ITEMS);
        fake.seed('stockCheckpoints', [{
            id: 'current', formatVersion: STOCK_REPLAY_FORMAT, asOf: W, state: [], resolutions: [],
            itemsSignature: itemsSignature(ITEMS), stale: false, staleCount: 0, builtAt: NOW, fullBuiltAt: NOW
        }]);
        fake.seed('stockCheckpoints', [{ id: 'legacyScan', ...Object.fromEntries(['purchases', 'retailSales', 'wholesaleSales', 'expenses', 'stockAdjustments', 'withdrawals'].map(c => [c, { v: 2, complete: true, foundAt: 0 }])) }]);
        fake.seed('purchases', [bill('p1', NOW - 2000), bill('p2', NOW - 1000)]);
    };

    const openAndHeal = async () => {
        const ready = FirebaseService.setupRealtimeListeners();
        for (let i = 0; i < 10; i++) await fake.settle();
        await ready;
        for (let i = 0; i < 200 && FirebaseService.listenerHealPending(); i++) {
            jest.advanceTimersByTime(1000);
            await fake.settle();
        }
        expect(FirebaseService.listenerHealPending()).toBe(false);
    };

    beforeEach(() => {
        localStorage.removeItem(HEAL_STORE_KEY);
        AppState.currentUser = null;
        AppState.userRole = 'owner';
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        jest.useFakeTimers();
        install();
    });

    afterEach(() => {
        FirebaseService.cleanup();
        jest.useRealTimers();
        jest.restoreAllMocks();
        delete global.firebase;
        AppState.userRole = null;
    });

    it('re-subscribes every history listener once, with no new read and the same records', async () => {
        await openAndHeal();
        const recs = AppState.purchaseHistory.slice();
        expect(recs.map(r => r.id)).toEqual(['p2', 'p1']);
        const healed = fake.stats.resumes;
        // window + openDue + paidAt for the 3 bill collections, the window of the other history collections
        expect(healed).toBeGreaterThanOrEqual(9);
        expect(Object.keys(loadHealRecord().synced)).toEqual(expect.arrayContaining([
            `purchases|from|${W}`, `purchases|openDue|${W}`, `purchases|paidAt|${W}`, `retailSales|from|${W}`
        ]));
        expect(AppState.purchaseHistory[0]).toBe(recs[0]);

        // Next open: nothing to heal
        FirebaseService.cleanup();
        await openAndHeal();
        expect(fake.stats.resumes).toBe(healed);

        // A server read of purchases since: only its three listeners again
        noteCollectionRead('purchases', Date.now() + 1);
        FirebaseService.cleanup();
        await openAndHeal();
        expect(fake.stats.resumes).toBe(healed + 3);
    });

    it('a bill changed or added while the old subscription missed it reaches the pages through the heal', async () => {
        const ready = FirebaseService.setupRealtimeListeners();
        for (let i = 0; i < 10; i++) await fake.settle();
        await ready;
        // Changed in the store without the listeners being told (as if between the two subscriptions)
        fake.seed('purchases', [bill('p1', NOW - 2000, { total: 50 }), bill('p3', NOW - 500)]);
        fake.raw('purchases').delete('p2');
        for (let i = 0; i < 200 && FirebaseService.listenerHealPending(); i++) {
            jest.advanceTimersByTime(1000);
            await fake.settle();
        }
        expect(AppState.purchaseHistory.map(r => [r.id, r.total])).toEqual([['p3', undefined], ['p1', 50]]);
    });
});
