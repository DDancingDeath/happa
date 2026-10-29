/**
 * @fileoverview Tests for FirebaseService.setupRealtimeListeners plumbing:
 * initial state comes from the listeners' first snapshots (no .get() when a
 * stock checkpoint is available), later snapshots are applied incrementally
 * via docChanges(), and expensive work (stock recalculation + re-render) is
 * debounced and limited to the visible tab, with hidden tabs refreshed when shown.
 */

import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';
import { defaultWindowStart } from '../utils/history-range.js';
import { itemsSignature } from '../utils/stock-replay.js';

const NOW = Date.now();
const ITEMS = [{ id: 'i1', name: 'Gehu' }];

let fake;

function install(options) {
    fake = createFakeFirestore(options);
    global.firebase = fake.firebase;
    fake.seed('items', ITEMS);
    fake.seed('stockCheckpoints', [{
        id: 'current', formatVersion: 3, asOf: defaultWindowStart(NOW), state: [], resolutions: [],
        itemsSignature: itemsSignature(ITEMS), stale: false, staleCount: 0, builtAt: Date.now(), fullBuiltAt: Date.now()
    }]);
    fake.seed('stockCheckpoints', [{ id: 'legacyScan', ...Object.fromEntries(['purchases', 'retailSales', 'wholesaleSales', 'expenses', 'stockAdjustments', 'withdrawals'].map(c => [c, { v: 2, complete: true, foundAt: 0 }])) }]);
}

const bill = (id, t, extra = {}) => ({ id, timestamp: t, date: new Date(t).toISOString(), ...extra });

describe('FirebaseService.setupRealtimeListeners', () => {
    beforeEach(() => {
        AppState.currentUser = null;
        AppState.stock = {};
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
    });

    afterEach(() => {
        FirebaseService.cleanup();
        jest.useRealTimers();
        jest.restoreAllMocks();
        delete global.firebase;
        delete window.app;
        document.body.innerHTML = '';
    });

    it('populates AppState from first snapshots without any .get()', async () => {
        install();
        fake.seed('purchases', [bill('p1', NOW - 2000), bill('p2', NOW - 1000)]);
        await FirebaseService.setupRealtimeListeners();
        await FirebaseService.getStock();

        expect(fake.stats.gets).toBe(0);
        expect(AppState.items).toEqual([{ id: 'i1', name: 'Gehu' }]);
        expect(AppState.purchaseHistory.map(p => p.id)).toEqual(['p2', 'p1']);
        expect(AppState.historyLoadedFrom).toBe(defaultWindowStart(NOW));
    });

    it('waits for server data when the first snapshot comes from cache', async () => {
        install({ holdServer: true });
        let resolved = false;
        const ready = FirebaseService.setupRealtimeListeners().then(() => { resolved = true; });
        await fake.settle();
        expect(resolved).toBe(false);

        fake.releaseServer();
        await fake.settle();
        fake.releaseServer();
        await ready;
        expect(resolved).toBe(true);
    });

    it('with cached data, startup waits only the short grace for the server (#13)', async () => {
        install({ holdServer: true });
        fake.seed('purchases', [bill('p1', NOW - 2000)]);
        jest.useFakeTimers();
        let resolved = false;
        const ready = FirebaseService.setupRealtimeListeners().then(() => { resolved = true; });
        for (let i = 0; i < 5 && !resolved; i++) {
            await fake.settle();
            jest.advanceTimersByTime(2600);
            await fake.settle();
        }
        expect(resolved).toBe(true);
        await ready;
        expect(AppState.purchaseHistory.map(p => p.id)).toEqual(['p1']);
        expect(FirebaseService.getStartupListenerInfo().Purchases).toMatchObject({ first: 'cache', docs: 1, readyBy: 'cache-timeout' });
    });

    it('historyServerSynced() is false while bills come only from the offline cache (#65 roll-forward)', async () => {
        install({ holdServer: true });
        fake.seed('purchases', [bill('p1', NOW - 2000)]);
        jest.useFakeTimers();
        let resolved = false;
        const ready = FirebaseService.setupRealtimeListeners().then(() => { resolved = true; });
        for (let i = 0; i < 5 && !resolved; i++) {
            await fake.settle();
            jest.advanceTimersByTime(2600);
            await fake.settle();
        }
        await ready;
        expect(FirebaseService.historyServerSynced()).toBe(false);
        fake.releaseServer();
        await fake.settle();
        expect(FirebaseService.historyServerSynced()).toBe(true);
    });

    it('rejects when a required listener fails first, but tolerates withdrawals failing', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        install({
            failures: {
                withdrawals: new Error('withdrawals down'),
                purchases: Object.assign(new Error('Quota exceeded.'), { code: 'resource-exhausted' })
            }
        });
        await expect(FirebaseService.setupRealtimeListeners()).rejects.toThrow('Quota exceeded.');
    });

    it('applies docChanges incrementally and keeps date-desc order', async () => {
        install();
        fake.seed('purchases', [bill('a', NOW - 3000, { v: 1 }), bill('b', NOW - 2000, { v: 1 }), bill('c', NOW - 1000, { v: 1 })]);
        await FirebaseService.setupRealtimeListeners();
        expect(AppState.purchaseHistory.map(p => p.id)).toEqual(['c', 'b', 'a']);

        const db = fake.db;
        await db.collection('purchases').doc('d').set(bill('d', NOW - 500, { v: 1 }));
        await db.collection('purchases').doc('b').set(bill('b', NOW - 100, { v: 2 }));
        await db.collection('purchases').doc('c').delete();
        await fake.settle();

        expect(AppState.purchaseHistory.map(p => [p.id, p.v])).toEqual([['b', 2], ['d', 1], ['a', 1]]);
    });

    it('debounces stock recalculation and renders only the visible tab, deferring hidden tabs until shown', async () => {
        install();
        document.body.innerHTML = '<div id="stock" class="tab active"></div><div id="history" class="tab"></div>';
        window.app = {
            stock: { render: jest.fn() },
            history: { refresh: jest.fn() }
        };
        await FirebaseService.setupRealtimeListeners();
        await fake.settle();
        jest.useFakeTimers();
        const calcSpy = jest.spyOn(FirebaseService, 'calculateStock');

        await fake.db.collection('purchases').doc('p1').set(bill('p1', NOW, { items: [{ name: 'Gehu', qty: 5, rate: 10 }] }));
        await fake.db.collection('wholesaleSales').doc('s1').set(bill('s1', NOW + 1, { items: [{ name: 'Gehu', qty: 3, rate: 10 }] }));
        await fake.settle();

        expect(calcSpy).not.toHaveBeenCalled();
        jest.advanceTimersByTime(200);
        await fake.settle();

        expect(calcSpy).toHaveBeenCalledTimes(1);
        expect(AppState.stock.i1.quantity).toBe(2);
        expect(window.app.stock.render).toHaveBeenCalledTimes(1);
        expect(window.app.history.refresh).not.toHaveBeenCalled();

        document.getElementById('stock').classList.remove('active');
        document.getElementById('history').classList.add('active');
        window.dispatchEvent(new CustomEvent('aadhat:tabshown', { detail: { tabId: 'history' } }));
        await fake.settle();

        expect(window.app.history.refresh).toHaveBeenCalledTimes(1);
        expect(calcSpy).toHaveBeenCalledTimes(1);
    });

    it('a bill or withdrawal change refreshes an open Money page; Insights and Statements wait until shown', async () => {
        install();
        AppState.userRole = 'owner';
        document.body.innerHTML = '<div id="money" class="tab active"></div><div id="insights" class="tab"></div><div id="statements" class="tab"></div>';
        window.app = { money: { render: jest.fn() }, insights: { render: jest.fn() }, statements: { render: jest.fn() } };
        await FirebaseService.setupRealtimeListeners();
        await fake.settle();
        jest.useFakeTimers();

        await fake.db.collection('retailSales').doc('r1').set(bill('r1', NOW, { total: 50, items: [{ name: 'Gehu', qty: 1, rate: 50 }] }));
        await fake.settle();
        jest.advanceTimersByTime(200);
        await fake.settle();
        expect(window.app.money.render).toHaveBeenCalledTimes(1);
        expect(window.app.insights.render).not.toHaveBeenCalled();

        await fake.db.collection('withdrawals').doc('w1').set({ id: 'w1', amount: 100, person: 'A', date: new Date(NOW).toISOString(), timestamp: NOW });
        await fake.settle();
        jest.advanceTimersByTime(200);
        await fake.settle();
        expect(window.app.money.render).toHaveBeenCalledTimes(2);

        document.getElementById('money').classList.remove('active');
        document.getElementById('statements').classList.add('active');
        window.dispatchEvent(new CustomEvent('aadhat:tabshown', { detail: { tabId: 'statements' } }));
        await fake.settle();
        expect(window.app.statements.render).toHaveBeenCalledTimes(1);
        expect(window.app.insights.render).not.toHaveBeenCalled();
    });

    it('getStock reuses the listener-computed stock until data changes', async () => {
        install();
        fake.seed('purchases', [bill('p1', NOW, { items: [{ name: 'Gehu', qty: 5, rate: 10 }] })]);
        await FirebaseService.setupRealtimeListeners();
        const calcSpy = jest.spyOn(FirebaseService, 'calculateStock');

        const first = await FirebaseService.getStock();
        const second = await FirebaseService.getStock();
        expect(second).toBe(first);
        expect(calcSpy).toHaveBeenCalledTimes(1);

        await fake.db.collection('purchases').doc('p2').set(bill('p2', NOW + 5, { items: [{ name: 'Gehu', qty: 1, rate: 10 }] }));
        await fake.settle();
        const third = await FirebaseService.getStock();
        expect(calcSpy).toHaveBeenCalledTimes(2);
        expect(third.i1.quantity).toBe(6);
    });
});

describe('withdrawals follow Roles & access (firestore.rules, #57)', () => {
    const W = { id: 'w1', amount: 100, person: 'A', date: new Date(NOW).toISOString(), timestamp: NOW };
    const OLD = NOW - 400 * 24 * 60 * 60 * 1000;

    beforeEach(() => {
        AppState.currentUser = null;
        AppState.stock = {};
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
    });

    afterEach(() => {
        FirebaseService.cleanup();
        jest.restoreAllMocks();
        delete global.firebase;
        AppState.userRole = null;
        delete AppState.settings.roleAccess;
    });

    const start = async (role, roleAccess) => {
        install();
        AppState.userRole = role;
        if (roleAccess) AppState.settings.roleAccess = roleAccess;
        else delete AppState.settings.roleAccess;
        fake.seed('withdrawals', [W, { ...W, id: 'w0', timestamp: OLD, date: new Date(OLD).toISOString() }]);
        fake.seed('purchases', [bill('p1', NOW - 1000), bill('p0', OLD)]);
        await FirebaseService.setupRealtimeListeners();
        await FirebaseService.loadOlderHistory(1);
        await FirebaseService.ensureHistoryFrom(null);
        return {
            listened: fake.stats.listenLog,
            queried: fake.stats.queryLog.map(q => q.coll)
        };
    };

    it('a member without Money, Statements or Insights never listens to or queries withdrawals', async () => {
        for (const roleAccess of [null, { staff: { finance: false, reports: false, analytics: false } }]) {
            const { listened, queried } = await start('staff', roleAccess);
            expect(listened).toContain('purchases');
            expect(listened).not.toContain('withdrawals');
            expect(queried).toContain('purchases');
            expect(queried).not.toContain('withdrawals');
            expect(AppState.withdrawalsHistory).toEqual([]);
            expect(AppState.purchaseHistory.map(p => p.id)).toEqual(['p1', 'p0']);
            FirebaseService.cleanup();
        }
    });

    it('members with one of those pages on, managers by default and the owner read withdrawals', async () => {
        const cases = [
            ['staff', { staff: { finance: true } }],
            ['staff', { staff: { reports: true } }],
            ['staff', { staff: { analytics: true } }],
            ['manager', null],
            ['owner', { manager: { finance: false, reports: false, analytics: false } }]
        ];
        for (const [role, roleAccess] of cases) {
            const { listened, queried } = await start(role, roleAccess);
            expect(listened).toContain('withdrawals');
            expect(queried).toContain('withdrawals');
            expect(AppState.withdrawalsHistory.map(w => w.id)).toEqual(['w1', 'w0']);
            FirebaseService.cleanup();
        }
    });

    it('a manager with Money, Statements and Insights off does not read withdrawals', async () => {
        const { listened, queried } = await start('manager', { manager: { finance: false, reports: false, analytics: false } });
        expect(listened).not.toContain('withdrawals');
        expect(queried).not.toContain('withdrawals');
        expect(AppState.withdrawalsHistory).toEqual([]);
    });
});
