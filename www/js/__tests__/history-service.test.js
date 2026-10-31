/**
 * @fileoverview FirebaseService recent-window + stock checkpoint behaviour
 * against an in-memory Firestore: startup reads, full rebuild + backfill,
 * checkpoint replay equivalence, ensureHistoryFrom/loadOlderHistory merging,
 * invalidation and roll-forward.
 */
import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';
import { ITEMS, generateHistory } from './__mocks__/history-data.js';
import { defaultWindowStart, monthsBefore, dateDescComparator } from '../utils/history-range.js';
import { computeStock, eventTime, buildCheckpointState, serializeState, itemsSignature } from '../utils/stock-replay.js';
import { outstandingDue } from '../utils/money.js';
import { LEASE_MAX_WAIT_MS } from '../utils/rebuild-lease.js';

/** Bill edits carry a reason (#121). */
const EDIT_REASON = { reason: 'Test edit' };

const NOW = Date.now();
const W = defaultWindowStart(NOW);
const COLLS = ['purchases', 'wholesaleSales', 'retailSales', 'stockAdjustments', 'expenses', 'withdrawals'];
const STATE_KEY = {
    purchases: 'purchaseHistory', wholesaleSales: 'salesHistory', retailSales: 'retailSalesHistory',
    stockAdjustments: 'stockAdjustments', expenses: 'expensesHistory', withdrawals: 'withdrawalsHistory'
};

let fake;

const settle = async (rounds = 10) => {
    for (let i = 0; i < rounds; i++) await fake.settle();
};

/** Documents of a collection as the app sees them, in orderBy('date','desc') order. */
const docsOf = (name) => [...fake.raw(name).entries()]
    .map(([id, d]) => ({ ...d, id }))
    .filter(d => d.date !== undefined)
    .sort(dateDescComparator(r => r.id));

const fullStock = () => computeStock({
    purchases: docsOf('purchases'),
    wholesaleSales: docsOf('wholesaleSales'),
    retailSales: docsOf('retailSales'),
    stockAdjustments: docsOf('stockAdjustments')
}, ITEMS);

function install(seed = 3) {
    fake = createFakeFirestore();
    global.firebase = fake.firebase;
    fake.seed('items', ITEMS);
    const h = generateHistory(seed, NOW);
    COLLS.forEach(c => fake.seed(c, h[c]));
    return h;
}

async function open() {
    FirebaseService.cleanup();
    await FirebaseService.setupRealtimeListeners();
    // The legacy-timestamp scan runs in the background after the first screen (#13).
    await FirebaseService.runLegacyScanNow();
    await FirebaseService.getStock();
    await settle();
}

async function rebuildSettled() {
    let r;
    for (let i = 0; i < 5; i++) {
        await settle();
        r = await FirebaseService.rebuildStockCheckpoint();
        if (r.status === 'fresh') return r;
    }
    return r;
}

const cpDoc = () => fake.raw('stockCheckpoints').get('current');

describe('recent history window + stock checkpoint', () => {
    beforeEach(() => {
        AppState.currentUser = { uid: 'u1' };
        AppState.userRole = 'owner';
        AppState.stock = {};
        jest.spyOn(console, 'info').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        FirebaseService.cleanup();
        jest.restoreAllMocks();
        delete global.firebase;
        AppState.currentUser = null;
    });

    it('first open without a checkpoint: full replay, then rebuild + backfill; next open reads only the window', async () => {
        install();
        const expected = fullStock();
        await open();
        expect(AppState.stock).toEqual(expected);
        expect(FirebaseService.isFullHistoryLoaded()).toBe(true);

        await rebuildSettled();
        const cp = cpDoc();
        expect(cp).toMatchObject({ stale: false, asOf: W, formatVersion: 3 });
        expect(cp.backfill.complete).toBe(true);
        // Every dated stock document now has a numeric timestamp.
        ['purchases', 'wholesaleSales', 'retailSales', 'stockAdjustments'].forEach(c => {
            docsOf(c).forEach(d => expect(typeof d.timestamp).toBe('number'));
        });
        // Legacy due bills got openDue backfilled, so nothing needs pinning by id.
        expect(cp.pinned).toEqual({ purchases: [], retailSales: [], wholesaleSales: [] });
        ['purchases', 'wholesaleSales', 'retailSales'].forEach(c => docsOf(c).forEach(d => {
            expect(d.openDue).toBe(outstandingDue(d) > 0);
        }));

        // Second open: no .get(), stock identical, window + dues only.
        // 14+ days after outdated apps last wrote timestamp-less docs: no legacy scans.
        await fake.db.collection('stockCheckpoints').doc('legacyScan').set(Object.fromEntries(COLLS.map(c => [c, { v: 2, complete: true, foundAt: 0 }])));
        fake.stats.gets = 0;
        fake.stats.reads = 0;
        await open();
        expect(fake.stats.gets).toBe(0);
        expect(FirebaseService.getStockCheckpointInfo()).toMatchObject({ asOf: W });
        expect(AppState.stock).toEqual(expected);
        expect(AppState.historyLoadedFrom).toBe(W);

        let windowDocs = 0;
        let olderLoaded = 0;
        COLLS.forEach(c => {
            const ids = new Set(AppState[STATE_KEY[c]].map(r => r.id));
            expect(ids.size).toBe(AppState[STATE_KEY[c]].length);
            docsOf(c).forEach(d => {
                if (eventTime(d) >= W && eventTime(d) !== Number.MAX_SAFE_INTEGER) {
                    windowDocs++;
                    expect(ids.has(d.id)).toBe(true);
                } else if (ids.has(d.id)) {
                    olderLoaded++;
                }
                const due = outstandingDue(d) > 0;
                if (due) expect(ids.has(d.id)).toBe(true);
            });
            expect(AppState[STATE_KEY[c]]).toEqual(AppState[STATE_KEY[c]].slice().sort(dateDescComparator(r => r.id)));
        });
        const totalDocs = COLLS.reduce((n, c) => n + fake.raw(c).size, 0);
        // items + checkpoint + window + old dues (+ empty-query minimums).
        expect(fake.stats.reads).toBeLessThan(ITEMS.length + 1 + windowDocs * 1.2 + olderLoaded * 2 + 30);
        expect(fake.stats.reads).toBeLessThan(totalDocs / 2);
    });

    it('ensureHistoryFrom merges older ranges (deduped, date desc), shares concurrent calls and updates the window start before resolving', async () => {
        install(5);
        await open();
        await rebuildSettled();
        await open();
        const from = monthsBefore(W, 3);
        const events = [];
        const onExt = (e) => events.push(e.detail.from);
        window.addEventListener('aadhat:historyextended', onExt);
        fake.stats.gets = 0;
        const a = FirebaseService.ensureHistoryFrom(from);
        const b = FirebaseService.ensureHistoryFrom(new Date(from));
        await Promise.all([a, b]);
        expect(FirebaseService.getHistoryWindowStart()).toBe(from);
        // one range query per history collection (personal expenses too, #98)
        expect(fake.stats.gets).toBe(7);
        expect(events).toEqual([from]);

        COLLS.forEach(c => {
            const arr = AppState[STATE_KEY[c]];
            const ids = arr.map(r => r.id);
            expect(new Set(ids).size).toBe(ids.length);
            docsOf(c).filter(d => typeof d.timestamp === 'number' && d.timestamp >= from)
                .forEach(d => expect(ids).toContain(d.id));
            expect(arr).toEqual(arr.slice().sort(dateDescComparator(r => r.id)));
        });

        await FirebaseService.ensureHistoryFrom(from + 1000);
        expect(fake.stats.gets).toBe(7);

        // Infinite scroll to the end: month-aligned steps, then full history.
        let res;
        let guard = 0;
        do {
            const before = FirebaseService.getHistoryWindowStart();
            res = await FirebaseService.loadOlderHistory(1);
            if (!res.reachedEnd) {
                expect(res.loadedFrom).toBe(monthsBefore(before, 1));
                expect(new Date(res.loadedFrom).getDate()).toBe(1);
                expect(new Date(res.loadedFrom).getHours()).toBe(0);
            }
            expect(FirebaseService.getHistoryWindowStart()).toBe(res.loadedFrom);
        } while (!res.reachedEnd && ++guard < 40);
        expect(res).toEqual({ loadedFrom: 0, reachedEnd: true });
        expect(FirebaseService.isFullHistoryLoaded()).toBe(true);
        COLLS.forEach(c => expect(AppState[STATE_KEY[c]].map(r => r.id).sort()).toEqual(docsOf(c).map(d => d.id).sort()));
        window.removeEventListener('aadhat:historyextended', onExt);
    });

    it('editing an old bill invalidates the checkpoint and a rebuild keeps stock exact; payment-only edits do not', async () => {
        install(8);
        await open();
        await rebuildSettled();
        await open();
        await FirebaseService.ensureHistoryFrom(monthsBefore(W, 4));
        const old = AppState.purchaseHistory.find(p => p.timestamp < W - 40 * 86400000 && Array.isArray(p.items) && p.items.length);
        expect(old).toBeTruthy();

        await FirebaseService.updatePurchase({ ...old, payment: { online: 0, cash: 1, due: 0, total: 1 } }, EDIT_REASON);
        await settle();
        expect(cpDoc().stale).toBe(false);

        const builtBefore = cpDoc().builtAt;
        const current = AppState.purchaseHistory.find(p => p.id === old.id);
        const edited = { ...current, items: [...old.items, { itemId: 'gehu', name: 'Gehu', qty: 777, rate: 3 }] };
        await FirebaseService.updatePurchase(edited, EDIT_REASON);
        await settle(3);
        expect(cpDoc().staleCount).toBe(1);

        const r = await rebuildSettled();
        expect(r.status).toBe('fresh');
        expect(cpDoc()).toMatchObject({ stale: false, staleCount: 1 });
        expect(cpDoc().builtAt).not.toBe(builtBefore);
        const stock = await FirebaseService.getStock();
        expect(stock).toEqual(fullStock());
        expect(FirebaseService.getStockCheckpointInfo()).not.toBeNull();

        // A new sale updates stock live through the checkpoint path.
        await FirebaseService.saveRetailSale({ date: new Date().toISOString(), items: [{ itemId: 'gehu', name: 'Gehu', qty: 2, rate: 30 }] });
        await settle();
        expect(await FirebaseService.getStock()).toEqual(fullStock());
        expect(cpDoc().staleCount).toBe(1);
    });

    it('a one-shot history read that never completes is retried instead of hanging startup', async () => {
        install(17);
        await FirebaseService.setupRealtimeListeners();
        jest.useFakeTimers();
        // The next two get() calls (the first collection of the full load) never settle.
        let hang = 2;
        const origCollection = fake.db.collection;
        fake.db.collection = (name) => {
            const c = origCollection(name);
            return { ...c, get: () => (hang-- > 0 ? new Promise(() => {}) : c.get()) };
        };
        let done = false;
        const p = FirebaseService.getStock().then(() => { done = true; });
        for (let i = 0; i < 10 && !done; i++) {
            jest.advanceTimersByTime(20000);
            for (let k = 0; k < 50; k++) await Promise.resolve();
        }
        jest.useRealTimers();
        await p;
        fake.db.collection = origCollection;
        expect(hang).toBeLessThan(2);
        expect(FirebaseService.isFullHistoryLoaded()).toBe(true);
        expect(AppState.stock).toEqual(fullStock());
    });

    it('rolls an old checkpoint forward from in-memory data without changing stock', async () => {
        install(11);
        await open();
        await rebuildSettled();
        const asOf = monthsBefore(W, 2);
        const all = {
            purchases: docsOf('purchases'), wholesaleSales: docsOf('wholesaleSales'),
            retailSales: docsOf('retailSales'), stockAdjustments: docsOf('stockAdjustments')
        };
        const built = buildCheckpointState(all, asOf, ITEMS);
        const cp = cpDoc();
        fake.seed('stockCheckpoints', [{
            ...cp, id: 'current', asOf, state: serializeState(built.state),
            resolutions: built.resolutions.map(r => ({ i: r[0], n: r[1], k: r[2] })),
            itemsSignature: itemsSignature(ITEMS), builtAt: 123
        }]);
        await fake.db.collection('stockCheckpoints').doc('legacyScan').set(Object.fromEntries(COLLS.map(c => [c, { v: 2, complete: true, foundAt: 0 }])));
        const expected = fullStock();
        fake.stats.gets = 0;
        await open();
        expect(AppState.historyLoadedFrom).toBe(asOf);
        await settle();
        const result = await FirebaseService.maintainStockCheckpoint();
        expect(['rolled', 'current']).toContain(result);
        expect(cpDoc()).toMatchObject({ asOf: W, rolledForwardFrom: asOf, stale: false });
        expect(fake.stats.gets).toBe(0);
        FirebaseService.cleanup();
        await open();
        expect(AppState.historyLoadedFrom).toBe(W);
        expect(AppState.stock).toEqual(expected);
    });

    it('keeps an old due bill after it is paid off elsewhere (fresh copy) and drops it when deleted', async () => {
        install(13);
        await open();
        await rebuildSettled();
        await open();
        const oldDue = AppState.salesHistory.find(s => eventTime(s) < W && typeof s.payment?.due === 'number' && s.payment.due > 0 && !s.cleared);
        expect(oldDue).toBeTruthy();
        // Paid off on another device (current app: openDue becomes false): it leaves the
        // dues query and, being older than the loaded range, leaves AppState too.
        await fake.db.collection('wholesaleSales').doc(oldDue.id).update({ 'payment.due': 0, 'payment.cash': oldDue.total, openDue: false });
        await settle();
        expect(AppState.salesHistory.find(s => s.id === oldDue.id)).toBeUndefined();
        // Within the loaded range a paid-off bill stays, with fresh data.
        await FirebaseService.ensureHistoryFrom(null);
        const kept = AppState.salesHistory.find(s => s.id === oldDue.id);
        expect(kept.payment.due).toBe(0);

        const another = AppState.purchaseHistory.find(s => eventTime(s) < W && typeof s.payment?.due === 'number' && s.payment.due > 0 && !s.cleared && s.items?.length);
        expect(another).toBeTruthy();
        await fake.db.collection('purchases').doc(another.id).delete();
        await settle();
        expect(AppState.purchaseHistory.find(s => s.id === another.id)).toBeUndefined();
        // A direct delete of an old stock record is detected and invalidates the checkpoint.
        expect(cpDoc().staleCount).toBeGreaterThanOrEqual(1);
    });
});

describe('review fixes', () => {
    beforeEach(() => {
        AppState.currentUser = { uid: 'u1' };
        AppState.userRole = 'owner';
        AppState.stock = {};
        jest.spyOn(console, 'info').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        FirebaseService.cleanup();
        jest.restoreAllMocks();
        delete global.firebase;
        AppState.currentUser = null;
        AppState.userRole = 'staff';
    });

    const nudgeWindow = async () => {
        // Any window change republishes every array of that collection.
        await fake.db.collection('purchases').doc('nudge').set({ id: 'nudge', timestamp: Date.now(), date: new Date().toISOString(), items: [] });
        await settle();
    };

    it('#1 edits of one-shot (extended) records persist in memory and the rebuild uses fresh server data', async () => {
        install(21);
        await open();
        await rebuildSettled();
        await open();
        await FirebaseService.ensureHistoryFrom(null);
        const old = AppState.purchaseHistory.find(p => p.timestamp < W - 60 * 86400000 && !(p.payment?.due > 0) && !(p.dueAmount > 0) && p.items?.length);
        expect(old).toBeTruthy();
        const edited = { ...old, items: [...old.items, { name: 'Zeera Edit', qty: 555, rate: 7 }] };
        await FirebaseService.updatePurchase(edited, EDIT_REASON);
        await nudgeWindow();
        expect(AppState.purchaseHistory.find(p => p.id === old.id).items).toHaveLength(edited.items.length);
        await rebuildSettled();
        expect(await FirebaseService.getStock()).toEqual(fullStock());
        await open();
        expect(AppState.stock).toEqual(fullStock());

        const oldExpense = AppState.expensesHistory.length ? null : null;
        expect(oldExpense).toBeNull();
    });

    it('#1 expense edit-in-place through FirebaseService.updateExpense persists in memory', async () => {
        install(22);
        await open();
        await rebuildSettled();
        await open();
        await FirebaseService.ensureHistoryFrom(null);
        const exp = AppState.expensesHistory.find(e => eventTime(e) < W);
        expect(exp).toBeTruthy();
        await FirebaseService.updateExpense(exp.id, { amount: 98765 });
        await nudgeWindow();
        expect(AppState.expensesHistory.find(e => e.id === exp.id).amount).toBe(98765);
        expect(fake.raw('expenses').get(exp.id).amount).toBe(98765);
    });

    it('#2 recent expenses written without timestamp (old clients) are loaded and backfilled', async () => {
        install(23);
        await open();
        await rebuildSettled();
        // Old APK writes after the checkpoint/backfill exist.
        const today = new Date();
        const enIN = `${today.getDate()}/${today.getMonth() + 1}/${today.getFullYear()}, 9:15:00 am`;
        fake.seed('expenses', [{ id: 'oldapk1', date: enIN, amount: 111, type: 'tea', category: 'business' }]);
        await fake.db.collection('stockCheckpoints').doc('legacyScan').set({ expenses: { v: 2, complete: false, foundAt: Date.now() } }, { merge: true });
        await open();
        expect(AppState.expensesHistory.some(e => e.id === 'oldapk1')).toBe(true);
        await settle();
        expect(typeof fake.raw('expenses').get('oldapk1').timestamp).toBe('number');
        // Once complete and nothing new was found, later opens skip the unfiltered read.
        await fake.db.collection('stockCheckpoints').doc('legacyScan').set({ expenses: { v: 2, complete: true, foundAt: 0 } }, { merge: true });
        fake.stats.queryLog.length = 0;
        await open();
        expect(fake.stats.queryLog.filter(q => q.coll === 'expenses' && q.filters.length === 0)).toHaveLength(0);
        expect(AppState.expensesHistory.some(e => e.id === 'oldapk1')).toBe(true);
    });

    it('#2 a first open scans every collection for docs without timestamp only until they are complete', async () => {
        install(24);
        await open();
        await rebuildSettled();
        const scan = fake.raw('stockCheckpoints').get('legacyScan');
        COLLS.forEach(c => expect(scan[c]).toMatchObject({ complete: true }));
        COLLS.forEach(c => docsOf(c).forEach(d => {
            if (eventTime(d) !== Number.MAX_SAFE_INTEGER) expect(typeof d.timestamp).toBe('number');
        }));
    });

    it('#3/#129 a stale mark stops exact use of the checkpoint; members show approximate stock without reading all history', async () => {
        install(25);
        await open();
        await rebuildSettled();
        await open();
        expect(FirebaseService.getStockCheckpointInfo()).not.toBeNull();
        AppState.userRole = 'staff';
        const fullReads = () => fake.stats.queryLog.filter(q => ['purchases', 'retailSales', 'wholesaleSales', 'stockAdjustments'].includes(q.coll) &&
            !q.filters.some(f => f.field === 'timestamp' || f.field === 'openDue')).length;
        const beforeEdit = fullStock();
        // Another device edits an old bill and marks the checkpoint stale.
        const old = docsOf('purchases').find(p => p.timestamp < W - 60 * 86400000 && p.items?.length && !(p.payment?.due > 0) && !(p.dueAmount > 0));
        await fake.db.collection('purchases').doc(old.id).set({ ...old, items: [...old.items, { name: 'Zeera Stale', qty: 321, rate: 2 }] });
        await fake.db.collection('stockCheckpoints').doc('current').set({ stale: true, staleCount: (cpDoc().staleCount || 0) + 1 }, { merge: true });
        await settle();
        expect(FirebaseService.getStockCheckpointInfo()).toBeNull();

        const reads = fullReads();
        const approx = await FirebaseService.getStock();
        expect(fullReads()).toBe(reads);
        expect(FirebaseService.isFullHistoryLoaded()).toBe(false);
        expect(AppState.stockReady).toBe(true);
        expect(AppState.stockApprox).toMatchObject({ asOf: W });
        // Exact except for the older edit that made the checkpoint stale.
        expect(approx).toEqual(beforeEdit);
        expect(approx).not.toEqual(fullStock());

        // Opening the app again as a member while it is still stale: no full read either.
        fake.stats.queryLog.length = 0;
        await open();
        expect(fullReads()).toBe(0);
        expect(AppState.stockApprox).not.toBeNull();
        expect(AppState.stock).toEqual(beforeEdit);

        // An owner/manager device rebuilds the checkpoint: it is adopted and stock is exact.
        const all = {
            purchases: docsOf('purchases'), wholesaleSales: docsOf('wholesaleSales'),
            retailSales: docsOf('retailSales'), stockAdjustments: docsOf('stockAdjustments')
        };
        const built = buildCheckpointState(all, W, ITEMS);
        await fake.db.collection('stockCheckpoints').doc('current').set({
            ...cpDoc(), asOf: W, stale: false, state: serializeState(built.state),
            resolutions: built.resolutions.map(r => ({ i: r[0], n: r[1], k: r[2] })),
            itemsSignature: itemsSignature(ITEMS), builtAt: Date.now()
        });
        await settle();
        expect(await FirebaseService.getStock()).toEqual(fullStock());
        expect(AppState.stockApprox).toBeNull();
        expect(fullReads()).toBe(0);
    });

    it('#129 once this member device edits an older bill itself, approximate stock is not used: exact via full history', async () => {
        install(42);
        await open();
        await rebuildSettled();
        await open();
        AppState.userRole = 'staff';
        await fake.db.collection('stockCheckpoints').doc('current').set({ stale: true, staleCount: (cpDoc().staleCount || 0) + 1 }, { merge: true });
        await settle();
        await FirebaseService.getStock();
        expect(AppState.stockApprox).not.toBeNull();

        await FirebaseService.ensureHistoryFrom(monthsBefore(W, 3));
        const bill = AppState.purchaseHistory.find(p => p.timestamp < W && p.items?.length && !(p.payment?.due > 0) && !(p.dueAmount > 0));
        await FirebaseService.updatePurchase({ ...bill, items: [...bill.items, { name: 'Zeera Own', qty: 77, rate: 1 }] }, EDIT_REASON);
        await settle();
        expect(await FirebaseService.getStock()).toEqual(fullStock());
        expect(AppState.stockApprox).toBeNull();
        expect(FirebaseService.isFullHistoryLoaded()).toBe(true);
    }, 30000);

    it('#3 roll-forward discards its payload when a stock record changes meanwhile', async () => {
        install(26);
        await open();
        await rebuildSettled();
        const asOf = monthsBefore(W, 2);
        const all = {
            purchases: docsOf('purchases'), wholesaleSales: docsOf('wholesaleSales'),
            retailSales: docsOf('retailSales'), stockAdjustments: docsOf('stockAdjustments')
        };
        const built = buildCheckpointState(all, asOf, ITEMS);
        fake.seed('stockCheckpoints', [{
            ...cpDoc(), id: 'current', asOf, state: serializeState(built.state),
            resolutions: built.resolutions.map(r => ({ i: r[0], n: r[1], k: r[2] })),
            itemsSignature: itemsSignature(ITEMS), builtAt: 123
        }]);
        // Another device edits a record in [asOf, W) right when this device rolls forward.
        const victim = docsOf('purchases').find(p => p.timestamp >= asOf && p.timestamp < W && p.items?.length);
        const runTx = fake.db.runTransaction;
        let injected = false;
        fake.db.runTransaction = (fn) => runTx(async (tx) => {
            if (!injected) {
                injected = true;
                await fake.db.collection('purchases').doc(victim.id).set({ ...victim, items: [...victim.items, { name: 'Zeera Race', qty: 999, rate: 1 }] });
                await settle();
            }
            return fn(tx);
        });
        await open();
        await FirebaseService.maintainStockCheckpoint();
        expect(injected).toBe(true);
        fake.db.runTransaction = runTx;
        await settle();
        await rebuildSettled();
        await open();
        expect(AppState.stock).toEqual(fullStock());
    });

    it('#4 staff devices never rebuild or roll forward; they fall back to full history and stay exact', async () => {
        install(27);
        AppState.userRole = 'staff';
        await open();
        await settle();
        expect(cpDoc()).toBeUndefined();
        expect(FirebaseService.isFullHistoryLoaded()).toBe(true);
        expect(AppState.stock).toEqual(fullStock());
        expect(await FirebaseService.rebuildStockCheckpoint()).toMatchObject({ status: 'not-allowed' });
    });

    it('#4 permission-denied on rebuild is handled without errors surfacing', async () => {
        install(28);
        const runTx = fake.db.runTransaction;
        fake.db.runTransaction = async () => { throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }); };
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        await open();
        await settle();
        const r = await FirebaseService.rebuildStockCheckpoint();
        expect(r.status).toBe('not-allowed');
        expect(AppState.stock).toEqual(fullStock());
        expect(err.mock.calls.filter(c => /rebuild/i.test(String(c[0])))).toHaveLength(0);
        fake.db.runTransaction = runTx;
    });
});

describe('review fixes (2)', () => {
    beforeEach(() => {
        AppState.currentUser = { uid: 'u1' };
        AppState.userRole = 'owner';
        AppState.stock = {};
        jest.spyOn(console, 'info').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        FirebaseService.cleanup();
        jest.restoreAllMocks();
        delete global.firebase;
        AppState.currentUser = null;
        AppState.userRole = 'staff';
        AppState.stockReady = true;
    });

    const quietScans = () => fake.db.collection('stockCheckpoints').doc('legacyScan')
        .set(Object.fromEntries(COLLS.map(c => [c, { v: 2, complete: true, foundAt: 0 }])));

    it('#5 stock writes carry clientVersion and bills carry openDue', async () => {
        install(31);
        await open();
        await rebuildSettled();
        await FirebaseService.saveRetailSale({ date: new Date().toISOString(), items: [{ itemId: 'gehu', qty: 1, rate: 5 }], total: 5, payment: { cash: 2, online: 0, due: 3, total: 2 } });
        await FirebaseService.saveStockAdjustment({ itemId: 'gehu', itemName: 'Gehu', adjustType: 'add', quantity: 1, rate: 0, date: new Date().toISOString() });
        await settle();
        const sale = [...fake.raw('retailSales').values()].find(d => d.total === 5 && d.payment?.due === 3);
        expect(sale).toMatchObject({ clientVersion: 3, openDue: true });
        expect(typeof sale.timestamp).toBe('number');
        expect([...fake.raw('stockAdjustments').values()].some(d => d.clientVersion === 3 && d.quantity === 1 && d.itemName === 'Gehu')).toBe(true);
    });

    it('#6 an edit based on a stale copy does not overwrite a payment recorded elsewhere', async () => {
        install(32);
        await open();
        await rebuildSettled();
        await quietScans();
        await open();
        await FirebaseService.ensureHistoryFrom(null);
        const bill = AppState.purchaseHistory.find(p => typeof p.payment?.due === 'number' && p.payment.due > 0 && !p.cleared && p.items?.length);
        const editCopy = { ...bill, comments: 'edited' };
        // Another device records a payment.
        await fake.db.collection('purchases').doc(bill.id).update({ 'payment.due': 0, payments: [{ amount: bill.payment.due }], openDue: false, clientVersion: 3 });
        await settle();
        await expect(FirebaseService.updatePurchase(editCopy, EDIT_REASON)).rejects.toThrow('changed on another device');
        expect(fake.raw('purchases').get(bill.id).payment.due).toBe(0);
        // Starting from the current copy works.
        const fresh = AppState.purchaseHistory.find(p => p.id === bill.id);
        await FirebaseService.updatePurchase({ ...fresh, comments: 'edited' }, EDIT_REASON);
        expect(fake.raw('purchases').get(bill.id)).toMatchObject({ comments: 'edited', payment: { due: 0 } });
    });

    it('#6b an editor that re-reads the live copy at save time still detects a payment made after it opened', async () => {
        install(36);
        await open();
        await rebuildSettled();
        await quietScans();
        await open();
        const bill = AppState.purchaseHistory.find(p => typeof p.payment?.due === 'number' && p.payment.due > 1 && !p.cleared && p.items?.length);
        // Editor opens: capture the payment state, as BillingManager.editBill does.
        const openedSig = FirebaseService.loadedPaymentSignature(bill);
        // Another device records a payment; the live listener refreshes the in-memory bill.
        // Partial payment: the bill stays due, so it stays live in memory.
        await fake.db.collection('purchases').doc(bill.id).update({ 'payment.due': 1, payments: [{ amount: bill.payment.due - 1 }], openDue: true, clientVersion: 3 });
        await settle();
        const live = AppState.purchaseHistory.find(p => p.id === bill.id);
        expect(live.payment.due).toBe(1);
        // Save builds the update from the live copy (as saveEditedBill does) with the form's old payment values.
        const updated = FirebaseService.withLoadedPaymentSignature({ ...live, comments: 'edited', payment: { ...bill.payment } }, openedSig);
        await expect(FirebaseService.updatePurchase(updated, EDIT_REASON)).rejects.toThrow('changed on another device');
        expect(fake.raw('purchases').get(bill.id).payment.due).toBe(1);
    });

    it('B editing the same bill twice (edit copies spread from the saved bill) is not a false conflict', async () => {
        install(35);
        await open();
        await rebuildSettled();
        await quietScans();
        await open();
        await FirebaseService.ensureHistoryFrom(null);
        const bill = AppState.purchaseHistory.find(p => typeof p.payment?.due === 'number' && p.items?.length);
        // billing.js: updatedBill = {...bill}; after success it replaces the AppState entry with updatedBill.
        const first = { ...bill, comments: 'first' };
        const saved = await FirebaseService.updatePurchase(first, EDIT_REASON);
        const idx = AppState.purchaseHistory.findIndex(p => p.id === bill.id);
        AppState.purchaseHistory[idx] = saved;
        const second = { ...AppState.purchaseHistory[idx], comments: 'second', payment: { ...saved.payment, cash: (saved.payment.cash || 0) + 1 } };
        await FirebaseService.updatePurchase(second, EDIT_REASON);
        const third = { ...second, comments: 'third' };
        await FirebaseService.updatePurchase(third, EDIT_REASON);
        expect(fake.raw('purchases').get(bill.id).comments).toBe('third');
    });

    it('C clearing a wholesale sale applies locally only after the transaction commits', async () => {
        install(36);
        await open();
        await rebuildSettled();
        await quietScans();
        await open();
        const { WholesaleSalesManager } = await import('../modules/wholesale-sales.js');
        jest.spyOn(WholesaleSalesManager, 'renderSalesOutstanding').mockImplementation(() => {});
        window.app = { outstanding: { renderDue: () => {} } };
        const { readPayment } = await import('../utils/money.js');
        const sale = AppState.salesHistory.find(s => !s.cleared && readPayment(s).due > 0);
        const { UIManager } = await import('../ui/ui-manager.js');
        const toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        // #104: clearing asks how; answer "write off" with a reason
        document.body.insertAdjacentHTML('beforeend', '<div id="clearDialogHost"></div>');
        jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async (html) => {
            document.getElementById('clearDialogHost').innerHTML = html;
            document.querySelector('input[name="clearMethod"][value="writeOff"]').checked = true;
            document.getElementById('clearReason').value = 'Settled by discount';
            return true;
        });
        const runTx = fake.db.runTransaction;
        fake.db.runTransaction = async () => { throw Object.assign(new Error('offline'), { code: 'unavailable' }); };
        await WholesaleSalesManager.markSaleAsCleared(sale.id);
        expect(sale.cleared).toBeFalsy();
        expect(toast).toHaveBeenCalledWith('Internet required to clear a due');
        fake.db.runTransaction = runTx;
        await WholesaleSalesManager.markSaleAsCleared(sale.id);
        expect(sale.cleared).toBe(true);
        expect(fake.raw('wholesaleSales').get(sale.id)).toMatchObject({ cleared: true, openDue: false, payment: expect.objectContaining({ due: 0 }) });
        delete window.app;
    });

    it('#7 startup does not wait for the full-history read when the checkpoint is missing', async () => {
        install(33);
        FirebaseService.cleanup();
        await FirebaseService.setupRealtimeListeners();
        let release;
        const gate = new Promise(r => { release = r; });
        const origCollection = fake.db.collection;
        fake.db.collection = (name) => {
            const c = origCollection(name);
            return { ...c, get: () => gate.then(() => c.get()) };
        };
        await FirebaseService.prepareStock();
        expect(AppState.stockReady).toBe(false);
        const { computeStockShortfalls } = await import('../utils/stock-check.js');
        expect(computeStockShortfalls([{ itemId: 'gehu', qty: 1e9 }])).toEqual([]);
        release();
        fake.db.collection = origCollection;
        for (let i = 0; i < 30 && !AppState.stockReady; i++) await settle(2);
        expect(AppState.stockReady).toBe(true);
        expect(AppState.stock).toEqual(fullStock());
    });

    it('#194 while another device holds the rebuild lease, this one waits for its checkpoint instead of reading all history', async () => {
        install(37);
        await open();
        await rebuildSettled();
        const built = { ...cpDoc() };
        // Calculation version changed and another owner device took the lease.
        await fake.db.collection('stockCheckpoints').doc('current')
            .set({ ...built, formatVersion: 2, rebuildingUntil: Date.now() + 60000, rebuildingBy: 'other' });
        const fullReads = () => fake.stats.queryLog.filter(q => ['purchases', 'retailSales', 'wholesaleSales', 'stockAdjustments'].includes(q.coll) &&
            !q.filters.some(f => f.field === 'timestamp' || f.field === 'openDue')).length;
        const before = fullReads();
        FirebaseService.cleanup();
        await FirebaseService.setupRealtimeListeners();
        await FirebaseService.prepareStock();
        await settle();
        expect(AppState.stockReady).toBe(false);
        expect(fullReads()).toBe(before);
        // The other device finishes: its checkpoint is adopted, still without a full read here.
        await fake.db.collection('stockCheckpoints').doc('current').set({ ...built, builtAt: built.builtAt + 1 });
        for (let i = 0; i < 30 && !AppState.stockReady; i++) {
            await settle(2);
            await new Promise(r => setTimeout(r, 50));
        }
        expect(AppState.stockReady).toBe(true);
        expect(AppState.stock).toEqual(fullStock());
        expect(fullReads()).toBe(before);
        expect(FirebaseService.isFullHistoryLoaded()).toBe(false);
    }, 30000);

    const oldVersionLease = async (rebuildingBy, rebuildingUntil) => {
        await open();
        await rebuildSettled();
        const built = { ...cpDoc() };
        await fake.db.collection('stockCheckpoints').doc('current').set({ ...built, formatVersion: 2, rebuildingUntil, rebuildingBy });
        FirebaseService.cleanup();
        await FirebaseService.setupRealtimeListeners();
    };

    it('#194 a dead or clock-skewed lease of another user blocks stock for at most the wait cap, then full history is used', async () => {
        install(38);
        // Holder's clock is a year ahead / holder closed the app: the lease looks valid for ages.
        await oldVersionLease('other-user:1:x', Date.now() + 365 * 86400000);
        const realNow = Date.now;
        await FirebaseService.prepareStock();
        await settle();
        expect(AppState.stockReady).toBe(false);
        jest.spyOn(Date, 'now').mockImplementation(() => realNow() + LEASE_MAX_WAIT_MS + 1000);
        await FirebaseService.getStock();
        await settle();
        expect(AppState.stockReady).toBe(true);
        expect(AppState.stock).toEqual(fullStock());
    }, 30000);

    it("#194 a lease left by the same user (reload mid-rebuild) does not make them wait", async () => {
        install(39);
        await oldVersionLease('u1:123:previous-tab', Date.now() + 9 * 60000);
        await FirebaseService.getStock();
        await settle();
        expect(AppState.stockReady).toBe(true);
        expect(AppState.stock).toEqual(fullStock());
        expect(cpDoc()).toMatchObject({ formatVersion: 3, rebuildingUntil: 0, stale: false });
    }, 30000);

    it('#13 deferred stock: not ready at the first screen, computed right after the first paint', async () => {
        install(41);
        await open();
        await rebuildSettled();
        FirebaseService.cleanup();
        await FirebaseService.setupRealtimeListeners();
        const prepared = FirebaseService.prepareStock({ defer: true });
        expect(AppState.stockReady).toBe(false);
        await prepared;
        expect(AppState.stockReady).toBe(true);
        expect(AppState.stock).toEqual(fullStock());
    }, 30000);

    it('#13 startup does not wait for the legacy-scan read; the scan runs after the first screen, owner/manager only', async () => {
        install(40);
        await open();
        await rebuildSettled();
        await fake.db.collection('stockCheckpoints').doc('legacyScan').set({ expenses: { v: 2, complete: false, foundAt: Date.now() } }, { merge: true });
        const unfiltered = () => fake.stats.queryLog.filter(q => q.coll === 'expenses' && q.filters.length === 0).length;
        // The legacyScan doc read hangs (slow network): startup must not wait for it.
        let release;
        const gate = new Promise(r => { release = r; });
        const origCollection = fake.db.collection;
        fake.db.collection = (name) => {
            const c = origCollection(name);
            if (name !== 'stockCheckpoints') return c;
            return { ...c, doc: (id) => {
                const d = c.doc(id);
                return id === 'legacyScan' ? { ...d, get: (...a) => gate.then(() => d.get(...a)) } : d;
            } };
        };
        FirebaseService.cleanup();
        fake.stats.queryLog.length = 0;
        await FirebaseService.setupRealtimeListeners();
        expect(unfiltered()).toBe(0);
        fake.db.collection = origCollection;
        release();
        await FirebaseService.runLegacyScanNow();
        expect(unfiltered()).toBe(1);

        // Member devices never run the unfiltered scan.
        AppState.userRole = 'staff';
        FirebaseService.cleanup();
        fake.stats.queryLog.length = 0;
        await FirebaseService.setupRealtimeListeners();
        await FirebaseService.runLegacyScanNow();
        await settle();
        expect(unfiltered()).toBe(0);
    });

    it('#8 one dues listener per bill collection, bounded to before the window; older bills paid inside it once more (paidAt, #163)', async () => {
        install(34);
        await open();
        await rebuildSettled();
        await quietScans();
        fake.stats.reads = 0;
        await open();
        const counts = {};
        ['purchases', 'retailSales', 'wholesaleSales'].forEach(c => {
            const due = docsOf(c).filter(d => d.timestamp < W && d.openDue === true).length;
            const win = docsOf(c).filter(d => d.timestamp >= W).length;
            const paid = docsOf(c).filter(d => typeof d.paidAt === 'number' && d.paidAt >= W).length;
            counts[c] = { due, win, paid };
            // every bill delivered at most once: window + older open dues (+ empty-query minimum)
            const ids = new Set(AppState[STATE_KEY[c]].map(r => r.id));
            expect(ids.size).toBe(AppState[STATE_KEY[c]].length);
        });
        const expected = ITEMS.length + 1 /* checkpoint */ + 1 /* legacyScan */ +
            Object.values(counts).reduce((n, x) => n + Math.max(1, x.due) + Math.max(1, x.win) + Math.max(1, x.paid), 0) +
            ['expenses', 'stockAdjustments', 'withdrawals'].reduce((n, c) => n + Math.max(1, docsOf(c).filter(d => d.timestamp >= W).length), 0);
        expect(fake.stats.reads).toBeLessThanOrEqual(expected + 3);
    });

    it('#163 older bills paid or written off inside the window stay loaded on the next open (paidAt, or pinned when paid by an older app)', async () => {
        install(37);
        const DAY = 86400000;
        const old = W - 20 * DAY;
        const paidIn = W + 2 * DAY;
        const bill = (id, extra) => ({ id, date: new Date(old).toISOString(), timestamp: old, customerName: 'Test Customer', items: [{ itemId: 'gehu', qty: 1, rate: 100, total: 100 }],
            total: 100, payment: { cash: 100, online: 0, due: 0, total: 100 }, openDue: false, clientVersion: 3, ...extra });
        fake.seed('retailSales', [
            bill('paid-new-app', { payments: [{ id: 'p1', amount: 60, cash: 60, online: 0, at: paidIn }], paidAt: paidIn }),
            bill('paid-old-app', { payments: [{ id: 'p2', amount: 60, cash: 60, online: 0, at: paidIn }] }),
            bill('paid-long-ago', { payments: [{ id: 'p3', amount: 60, cash: 60, online: 0, at: old + DAY }], paidAt: old + DAY })
        ]);
        await open();
        await rebuildSettled();
        await quietScans();
        expect(cpDoc().pinned.retailSales).toEqual(['paid-old-app']);
        await open();
        expect(FirebaseService.isFullHistoryLoaded()).toBe(false);
        const ids = AppState.retailSalesHistory.map(r => r.id);
        expect(ids).toEqual(expect.arrayContaining(['paid-new-app', 'paid-old-app']));
        expect(ids).not.toContain('paid-long-ago');
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('#132 on-demand history reports its age and Refresh re-reads it (edits and deletes from other devices)', async () => {
        install(35);
        await open();
        await rebuildSettled();
        await open();
        expect(FirebaseService.getOnDemandHistoryInfo()).toBeNull();

        const from = monthsBefore(W, 3);
        const before = Date.now();
        await FirebaseService.ensureHistoryFrom(from);
        const info = FirebaseService.getOnDemandHistoryInfo();
        expect(info).toMatchObject({ from, liveFrom: W });
        expect(info.asOf).toBeGreaterThanOrEqual(before);

        const old = AppState.purchaseHistory.filter(p => p.timestamp >= from && p.timestamp < W && !p.openDue);
        expect(old.length).toBeGreaterThan(1);
        const [edited, removed] = old;
        // Another device edits one old bill and deletes another (no listener sees it).
        await fake.db.collection('purchases').doc(edited.id).set({ ...fake.raw('purchases').get(edited.id), customerName: 'Edited elsewhere' });
        await fake.db.collection('purchases').doc(removed.id).delete();
        await settle();
        expect(AppState.purchaseHistory.find(p => p.id === edited.id).customerName).not.toBe('Edited elsewhere');

        await expect(FirebaseService.refreshOnDemandHistory()).resolves.toBe(true);
        expect(AppState.purchaseHistory.find(p => p.id === edited.id).customerName).toBe('Edited elsewhere');
        expect(AppState.purchaseHistory.some(p => p.id === removed.id)).toBe(false);
        expect(FirebaseService.getOnDemandHistoryInfo().asOf).toBeGreaterThanOrEqual(info.asOf);
        const ids = AppState.purchaseHistory.map(p => p.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
