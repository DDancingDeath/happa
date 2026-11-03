/**
 * @fileoverview Resumable stock-checkpoint rebuild (#159): a rebuild cut short carries on from the
 * pages it already read (taken from this phone's cache) and stores the same checkpoint as one
 * uninterrupted build; progress that may be out of date is dropped; a stock change during the
 * build is refused as before.
 */
import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';
import { ITEMS, generateHistory } from './__mocks__/history-data.js';
import { defaultWindowStart, dateDescComparator } from '../utils/history-range.js';
import { buildCheckpointState, computeStock, eventTime, serializeState, STOCK_REPLAY_FORMAT } from '../utils/stock-replay.js';
import { outstandingDue } from '../utils/money.js';
import { needsLegacyFields, PROGRESS_MAX_AGE_MS, PROGRESS_VERSION, REBUILD_PAGING, usableProgress } from '../firebase/core/rebuild-progress.js';
import { HISTORY_SPEC } from '../firebase/core/records.js';

const NOW = Date.now();
const W = defaultWindowStart(NOW);
const COLLS = ['purchases', 'wholesaleSales', 'retailSales', 'stockAdjustments', 'expenses', 'withdrawals'];
const STOCK_COLLS = ['purchases', 'wholesaleSales', 'retailSales', 'stockAdjustments'];
const PROGRESS_KEY = 'happa.rebuildProgress:stockCheckpoints:u1';

let fake;
let hook = null;
const { deleteCount } = REBUILD_PAGING;

const settle = async (rounds = 10) => {
    for (let i = 0; i < rounds; i++) await fake.settle();
};

const docsOf = (name) => [...fake.raw(name).entries()]
    .map(([id, d]) => ({ ...d, id }))
    .filter(d => d.date !== undefined)
    .sort(dateDescComparator(r => r.id));

const serverSources = () => Object.fromEntries(STOCK_COLLS.map(c => [c, docsOf(c)]));

const isPage = (q) => q.order[0]?.field === '__name__' && q.limitN > 0;

/** The fields the timestamp backfill gives old documents (a shop whose legacy documents were all backfilled). */
const backfilled = (key, doc) => {
    const spec = HISTORY_SPEC[key];
    if (doc.date === undefined) return doc;
    const out = { ...doc };
    if (typeof out.timestamp !== 'number' && (spec.stock || eventTime(out) !== Number.MAX_SAFE_INTEGER)) out.timestamp = eventTime(out);
    if (spec.dues) out.openDue = outstandingDue(out) > 0;
    return out;
};

/** The generated shop; `legacy: false` = after the backfill (no document needs it). */
function install(seed, { legacy = false } = {}) {
    fake = createFakeFirestore({ beforeGet: (q, stats) => (hook ? hook(q, stats) : undefined) });
    global.firebase = fake.firebase;
    fake.seed('items', ITEMS);
    const h = generateHistory(seed, NOW);
    COLLS.forEach(c => fake.seed(c, legacy ? h[c] : h[c].map(doc => backfilled(c, doc))));
}

async function open() {
    FirebaseService.cleanup();
    await FirebaseService.setupRealtimeListeners();
    await FirebaseService.runLegacyScanNow();
    await FirebaseService.getStock();
    await settle();
}

const cpDoc = () => fake.raw('stockCheckpoints').get('current');

/** The checkpoint without who / when it was built and the backfill tally (a resumed build has less left to backfill). */
const comparable = (cp) => {
    const { builtAt, builtBy, fullBuiltAt, writtenAt, backfill, ...rest } = cp;
    return rest;
};

const pageGets = () => fake.stats.queryLog.filter(isPage).length;

/**
 * Stored pages the next rebuild can take from this phone's cache: in order, up to the first one
 * with a document missing there or still needing the timestamp backfill (read again).
 */
function usablePages() {
    const progress = JSON.parse(localStorage.getItem(PROGRESS_KEY));
    let n = 0;
    Object.entries(progress.colls).forEach(([key, c]) => {
        for (const page of c.pages) {
            if (!page.ids.every(id => fake.cached(key).has(id) && !needsLegacyFields(HISTORY_SPEC[key], fake.cached(key).get(id)))) break;
            n++;
        }
    });
    return n;
}

/** Opens the app (a rebuild starts: no checkpoint) and closes it once `pages` pages of the rebuild's read are in. */
async function openAndCloseAfter(pages) {
    let seen = 0;
    hook = (q) => {
        if (isPage(q) && ++seen === pages) {
            hook = null;
            FirebaseService.cleanup();
        }
    };
    await open();
    hook = null;
    expect(cpDoc()?.asOf).toBeUndefined();
}

/** One uninterrupted first build of the shop of `seed`: its checkpoint and how many pages it read. */
async function referenceBuild(seed, opts) {
    install(seed, opts);
    await open();
    const cp = cpDoc();
    expect(cp).toMatchObject({ stale: false, asOf: W, formatVersion: STOCK_REPLAY_FORMAT });
    return { cp: comparable(cp), pages: pageGets(), stock: AppState.stock };
}

describe('resumable stock checkpoint rebuild (#159)', () => {
    beforeEach(() => {
        AppState.currentUser = { uid: 'u1' };
        AppState.userRole = 'owner';
        AppState.stock = {};
        localStorage.clear();
        REBUILD_PAGING.pageSize = 7;
        hook = null;
        jest.spyOn(console, 'info').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        FirebaseService.cleanup();
        jest.restoreAllMocks();
        REBUILD_PAGING.pageSize = 500;
        REBUILD_PAGING.deleteCount = deleteCount;
        delete global.firebase;
        AppState.currentUser = null;
    });

    it('closed at several points and reopened, it reads only the pages left and stores the same checkpoint', async () => {
        const ref = await referenceBuild(21);
        expect(ref.pages).toBeGreaterThan(12);
        expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();

        for (const cut of [1, 5, Math.floor(ref.pages / 2), ref.pages - 1]) {
            localStorage.clear();
            install(21);
            await openAndCloseAfter(cut);
            expect(usablePages()).toBe(cut);

            fake.stats.queryLog.length = 0;
            await open();
            expect(pageGets()).toBe(ref.pages - cut);
            expect(comparable(cpDoc())).toEqual(ref.cp);
            expect(AppState.stock).toEqual(ref.stock);
            expect(FirebaseService.isFullHistoryLoaded()).toBe(true);
            expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
        }
    });

    it('closed twice in a row, it still carries on and stores the same checkpoint', async () => {
        const ref = await referenceBuild(22);
        localStorage.clear();
        install(22);
        await openAndCloseAfter(3);
        fake.stats.queryLog.length = 0;
        await openAndCloseAfter(4);
        expect(pageGets()).toBe(4);
        fake.stats.queryLog.length = 0;
        await open();
        expect(pageGets()).toBe(ref.pages - 7);
        expect(comparable(cpDoc())).toEqual(ref.cp);
    });

    it('with documents still needing the timestamp backfill, their pages are read from the server again (same checkpoint)', async () => {
        const ref = await referenceBuild(27, { legacy: true });
        for (const cut of [3, Math.floor(ref.pages / 2)]) {
            localStorage.clear();
            install(27, { legacy: true });
            await openAndCloseAfter(cut);
            const usable = usablePages();
            // The collection being read when the app closed was not backfilled yet
            expect(usable).toBeLessThan(cut);
            fake.stats.queryLog.length = 0;
            await open();
            expect(pageGets()).toBe(ref.pages - usable);
            expect(comparable(cpDoc())).toEqual(ref.cp);
            expect(AppState.stock).toEqual(ref.stock);
        }
    });

    it('a page read while this phone deleted a document of that collection is read again', async () => {
        const ref = await referenceBuild(28);
        localStorage.clear();
        install(28);
        let deletes = 0;
        REBUILD_PAGING.deleteCount = (path) => (path === 'purchases' ? deletes : 0);
        let seen = 0;
        hook = (q) => {
            if (isPage(q) && ++seen === 2) deletes++;
        };
        fake.stats.queryLog.length = 0;
        await open();
        hook = null;
        expect(pageGets()).toBe(ref.pages + 1);
        expect(comparable(cpDoc())).toEqual(ref.cp);
    });

    it('progress left after the checkpoint was built on another phone is dropped', async () => {
        const ref = await referenceBuild(29);
        const built = cpDoc();
        localStorage.clear();
        install(29);
        await openAndCloseAfter(3);
        expect(localStorage.getItem(PROGRESS_KEY)).not.toBeNull();
        await fake.db.collection('stockCheckpoints').doc('current').set(built);
        await open();
        expect(await FirebaseService.rebuildStockCheckpoint()).toMatchObject({ status: 'fresh' });
        expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
        expect(comparable(cpDoc())).toEqual(ref.cp);
    });

    it('a recent document deleted on another phone does not come back from a cached page', async () => {
        await referenceBuild(30);
        const purchasePages = fake.stats.queryLog.filter(q => isPage(q) && q.coll === 'purchases').length;
        localStorage.clear();
        install(30);
        await openAndCloseAfter(purchasePages + 1);
        const read = JSON.parse(localStorage.getItem(PROGRESS_KEY)).colls.purchases.pages.flatMap(p => p.ids);
        const id = read.find(i => fake.raw('purchases').get(i).timestamp >= W);
        expect(id).toBeTruthy();
        // Deleted on the server only: this phone's cache keeps its copy
        fake.raw('purchases').delete(id);
        expect(fake.cached('purchases').has(id)).toBe(true);
        await open();
        expect(cpDoc()).toMatchObject({ stale: false, asOf: W });
        expect(AppState.purchaseHistory.some(p => p.id === id)).toBe(false);
        expect(AppState.stock).toEqual(computeStock(serverSources(), ITEMS));
    });

    it('a stored page whose documents left the cache is read again, with the pages after it', async () => {
        const ref = await referenceBuild(23);
        localStorage.clear();
        install(23);
        await openAndCloseAfter(6);
        const progress = JSON.parse(localStorage.getItem(PROGRESS_KEY));
        const first = Object.keys(progress.colls)[0];
        expect(progress.colls[first].pages.length).toBeGreaterThan(2);
        // Evicted from the phone's cache (the SDK's cache has a size limit)
        fake.cached(first).delete(progress.colls[first].pages[1].ids[0]);
        expect(usablePages()).toBe(1);

        fake.stats.queryLog.length = 0;
        await open();
        expect(pageGets()).toBe(ref.pages - 1);
        expect(comparable(cpDoc())).toEqual(ref.cp);
    });

    it('progress is dropped after a stock change before the window (staleCount): the build reads everything again', async () => {
        const ref = await referenceBuild(24);
        localStorage.clear();
        install(24);
        await openAndCloseAfter(5);
        // Another phone edits an old purchase this phone already read (its cache keeps the old copy) and marks the checkpoint stale
        const read = new Set(JSON.parse(localStorage.getItem(PROGRESS_KEY)).colls.purchases.pages.flatMap(p => p.ids));
        // No due: no listener refreshes this phone's copy
        const [id, old] = [...fake.raw('purchases').entries()].find(([i, d]) => read.has(i) && typeof d.timestamp === 'number' && d.timestamp < W
            && outstandingDue(d) === 0 && !d.paidAt && Array.isArray(d.items) && d.items.length);
        fake.raw('purchases').set(id, { ...old, items: [...old.items, { itemId: 'gehu', name: 'Gehu', qty: 333, rate: 4 }] });
        await fake.db.collection('stockCheckpoints').doc('current').set({ stale: true, staleCount: fake.firebase.firestore.FieldValue.increment(1) }, { merge: true });
        // No legacy scan on this open (its unfiltered read would refresh the cache)
        await fake.db.collection('stockCheckpoints').doc('legacyScan').set(Object.fromEntries(COLLS.map(c => [c, { v: 2, complete: true, foundAt: 0 }])));

        fake.stats.queryLog.length = 0;
        await open();
        expect(AppState.purchaseHistory.find(p => p.id === id).items).toHaveLength(old.items.length + 1);
        const cp = cpDoc();
        expect(cp).toMatchObject({ stale: false, asOf: W, staleCount: 1 });
        const expected = buildCheckpointState(serverSources(), W, ITEMS);
        expect(cp.state).toEqual(serializeState(expected.state));
        expect(AppState.stock).toEqual(computeStock(serverSources(), ITEMS));
        // Every page from the server again
        expect(pageGets()).toBe(ref.pages);
    });

    it('a stock change during the resumed build is refused like today (conflict), then built from fresh data', async () => {
        install(25);
        await openAndCloseAfter(4);
        const [id, old] = [...fake.raw('purchases').entries()].find(([, d]) => typeof d.timestamp === 'number' && d.timestamp < W - 40 * 86400000 && Array.isArray(d.items) && d.items.length);
        let seen = 0;
        hook = async (q) => {
            if (isPage(q) && ++seen === 2) {
                hook = null;
                fake.raw('purchases').set(id, { ...old, items: [...old.items, { itemId: 'gehu', name: 'Gehu', qty: 222, rate: 4 }] });
                await fake.db.collection('stockCheckpoints').doc('current').set({ stale: true, staleCount: fake.firebase.firestore.FieldValue.increment(1) }, { merge: true });
            }
        };
        await open();
        hook = null;
        // The commit saw the new staleCount: nothing stored, progress dropped
        expect(cpDoc()).toMatchObject({ staleCount: 1, rebuildingUntil: 0 });
        expect(cpDoc().asOf).toBeUndefined();
        expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();

        const r = await FirebaseService.rebuildStockCheckpoint();
        expect(r.status).toBe('built');
        expect(cpDoc().state).toEqual(serializeState(buildCheckpointState(serverSources(), W, ITEMS).state));
        expect(await FirebaseService.getStock()).toEqual(computeStock(serverSources(), ITEMS));
    });

    describe('usableProgress', () => {
        const ctx = { uid: 'u1', env: 'stockCheckpoints', windowStart: W, staleCount: 2, now: NOW };
        const good = { v: PROGRESS_VERSION, format: STOCK_REPLAY_FORMAT, uid: 'u1', env: 'stockCheckpoints', windowStart: W, staleCount: 2, startedAt: NOW - 1000, colls: {} };

        it('accepts progress of the same user, data set, window month and staleCount, up to a day old', () => {
            expect(usableProgress(good, ctx)).toBe(true);
            expect(usableProgress({ ...good, startedAt: NOW - PROGRESS_MAX_AGE_MS }, ctx)).toBe(true);
        });

        it.each([
            ['missing', null],
            ['another version', { ...good, v: PROGRESS_VERSION + 1 }],
            ['another replay format', { ...good, format: STOCK_REPLAY_FORMAT - 1 }],
            ['another user', { ...good, uid: 'u2' }],
            ['the other data set (dev_ / live)', { ...good, env: 'dev_stockCheckpoints' }],
            ['another window month', { ...good, windowStart: W - 1 }],
            ['a stock change since (staleCount)', { ...good, staleCount: 3 }],
            ['older than a day', { ...good, startedAt: NOW - PROGRESS_MAX_AGE_MS - 1 }],
            ['from the future (clock change)', { ...good, startedAt: NOW + 60000 }],
            ['no collections', { ...good, colls: null }]
        ])('drops %s', (_, p) => {
            expect(usableProgress(p, ctx)).toBe(false);
        });

        it('drops unreadable stored progress and builds from the server', async () => {
            const ref = await referenceBuild(26);
            localStorage.clear();
            install(26);
            localStorage.setItem(PROGRESS_KEY, '{not json');
            fake.stats.queryLog.length = 0;
            await open();
            expect(pageGets()).toBe(ref.pages);
            expect(comparable(cpDoc())).toEqual(ref.cp);
        });
    });
});
