/**
 * @fileoverview Rate trends roll-forward (#65): only from server-synced bills
 * while online (never from a stale offline cache), and compared with the
 * server copy of the months so a wrong doc written elsewhere is repaired.
 */
jest.mock('../firebase/firestore-service.js', () => ({
    FirebaseService: {
        historyServerSynced: jest.fn(() => true),
        loadRateStatsMeta: jest.fn(async () => ({ backfillDone: true })),
        loadServerRateStatsFromYear: jest.fn(async () => ({ docs: [], more: false })),
        saveRateStats: jest.fn(async () => {}),
        saveRateStatsMeta: jest.fn(async () => {}),
        ensureHistoryFrom: jest.fn(async () => {})
    }
}));

import { RateTrendsManager } from '../modules/rate-trends.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { aggregateBills, finalizeStats, istDayStartMs, istMonthKey, istMonthStartMs } from '../utils/rate-trends.js';

// A fixed day, mid-month and mid-week (IST). Weeks are stored under their Monday's year, so on
// 1–3 January a bill's week goes to last year's doc and "one doc for the item" would depend on today.
jest.useFakeTimers({
    now: new Date('2026-10-21T12:00:00+05:30'),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
        'setTimeout', 'clearTimeout']
});
afterAll(() => jest.useRealTimers());

const now = Date.now();
const month = istMonthKey(now);
const id = `wheat_${month.slice(0, 4)}`;
const bills = { purchase: [{ id: 'p1', timestamp: now, items: [{ itemId: 'wheat', rate: 25, qty: 100 }] }], retail: [], wholesale: [] };
const items = [{ id: 'wheat', name: 'Wheat' }];
const correct = finalizeStats(aggregateBills(bills, items))[id];
let online;

beforeAll(() => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
});

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.clear();
    online = true;
    FirebaseService.historyServerSynced.mockReturnValue(true);
    FirebaseService.loadServerRateStatsFromYear.mockResolvedValue({ docs: [], more: false });
    AppState.userRole = 'owner';
    AppState.currentUser = { uid: 'own1' };
    AppState.historyLoadedFrom = 0;
    AppState.items = items;
    AppState.purchaseHistory = bills.purchase;
    AppState.retailSalesHistory = [];
    AppState.salesHistory = [];
    RateTrendsManager.meta = undefined;
    RateTrendsManager.metaError = null;
    RateTrendsManager.rolling = null;
});

test('skips (and retries later) while offline or before the bill listeners have server data', async () => {
    online = false;
    await expect(RateTrendsManager.rollForward()).resolves.toBe('not-synced');
    online = true;
    FirebaseService.historyServerSynced.mockReturnValue(false);
    await expect(RateTrendsManager.rollForward()).resolves.toBe('not-synced');
    expect(FirebaseService.loadServerRateStatsFromYear).not.toHaveBeenCalled();
    expect(FirebaseService.saveRateStats).not.toHaveBeenCalled();
    expect(localStorage.getItem('aadhatRateStatsRoll')).toBeNull();

    FirebaseService.historyServerSynced.mockReturnValue(true);
    await expect(RateTrendsManager.rollForward()).resolves.toBe('written');
    expect(localStorage.getItem('aadhatRateStatsRoll')).not.toBeNull();
});

test('repairs a wrong month doc on the server; writes nothing when the server copy is right', async () => {
    FirebaseService.loadServerRateStatsFromYear.mockResolvedValue({
        docs: [{ id, ...correct, months: { [`m${month}`]: { ...correct.months[`m${month}`], purchase: { kg: 40, amount: 1200, min: 30, max: 30, avg: 30, bills: 1 } } } }], more: false
    });
    await expect(RateTrendsManager.rollForward({ force: true })).resolves.toBe('written');
    expect(FirebaseService.saveRateStats).toHaveBeenCalledWith([{ id, data: correct }]);

    FirebaseService.saveRateStats.mockClear();
    FirebaseService.loadServerRateStatsFromYear.mockResolvedValue({ docs: [{ id, ...correct, updatedAt: 1 }], more: false });
    await expect(RateTrendsManager.rollForward({ force: true })).resolves.toBe('current');
    expect(FirebaseService.saveRateStats).not.toHaveBeenCalled();
});

test('never writes when the server copy cannot be read', async () => {
    FirebaseService.loadServerRateStatsFromYear.mockRejectedValue(Object.assign(new Error('offline'), { code: 'unavailable' }));
    await expect(RateTrendsManager.rollForward()).resolves.toBe('server-unreadable');
    expect(FirebaseService.saveRateStats).not.toHaveBeenCalled();
    expect(localStorage.getItem('aadhatRateStatsRoll')).toBeNull();
});

describe('history carried from the old app (#15)', () => {
    const carried = { backfillDone: true, backfillAt: Date.UTC(2026, 9, 26, 9, 30), bills: 1200, reads: 0, months: 30, by: 'migration', byUserId: '' };

    beforeEach(() => {
        document.body.innerHTML = '<div id="rtStatus"></div>';
        FirebaseService.loadRateStatsMeta.mockResolvedValue(carried);
    });

    test('shows a note instead of Rebuild', async () => {
        await RateTrendsManager.loadMeta(true);
        RateTrendsManager.renderStatus();
        const html = document.getElementById('rtStatus').innerHTML;
        expect(html).not.toContain('startBackfill');
        expect(html).toMatch(/carried from the old app|पुराने ऐप से/);
    });

    test('Rebuild never runs: _meta.by and backfillAt stay, nothing is written', async () => {
        await RateTrendsManager.startBackfill();
        expect(FirebaseService.saveRateStatsMeta).not.toHaveBeenCalled();
        expect(FirebaseService.saveRateStats).not.toHaveBeenCalled();
        expect(localStorage.getItem('aadhatRateStatsBackfill')).toBeNull();
    });

    test('an ordinary history still offers Rebuild', async () => {
        FirebaseService.loadRateStatsMeta.mockResolvedValue({ ...carried, by: 'Owner' });
        await RateTrendsManager.loadMeta(true);
        RateTrendsManager.renderStatus();
        expect(document.getElementById('rtStatus').innerHTML).toContain('startBackfill');
    });
});

test('#147: loads the first week of the window when the loaded bills start inside it, so a bill dated back into it is counted', async () => {
    // Loaded from 1 Sep (a Tuesday): the week of Mon 31 Aug would be left as stored
    AppState.historyLoadedFrom = istMonthStartMs('2026-09');
    const gap = istDayStartMs('2026-08-31');
    const sep1 = { id: 'p0', timestamp: istDayStartMs('2026-09-01') + 3600000, items: [{ itemId: 'wheat', rate: 24, qty: 50 }] };
    // Entered today, dated 2 Sep: in the loaded part of that week
    const sep2 = { id: 'p2', timestamp: istDayStartMs('2026-09-02') + 3600000, enteredAt: now, items: [{ itemId: 'wheat', rate: 26, qty: 10 }] };
    // No bill dated back into that week: nothing loaded
    await expect(RateTrendsManager.rollForward({ force: true })).resolves.toBe('written');
    expect(FirebaseService.ensureHistoryFrom).not.toHaveBeenCalled();
    FirebaseService.saveRateStats.mockClear();
    AppState.purchaseHistory = [...bills.purchase, sep2];
    FirebaseService.ensureHistoryFrom.mockImplementation(async (from) => {
        AppState.historyLoadedFrom = from;
        AppState.purchaseHistory = [...bills.purchase, sep2, sep1];
    });
    await expect(RateTrendsManager.rollForward({ force: true })).resolves.toBe('written');
    expect(FirebaseService.ensureHistoryFrom).toHaveBeenCalledWith(gap);
    const doc = FirebaseService.saveRateStats.mock.calls[0][0].find(w => w.id === id).data;
    expect(doc.weeks['w2026-08-31'].purchase.kg).toBe(60);

    // Not loaded (offline cache, error): the week stays as stored, the rest is still written
    FirebaseService.saveRateStats.mockClear();
    AppState.historyLoadedFrom = istMonthStartMs('2026-09');
    AppState.purchaseHistory = [...bills.purchase, sep2];
    FirebaseService.ensureHistoryFrom.mockRejectedValueOnce(new Error('unavailable'));
    await expect(RateTrendsManager.rollForward({ force: true })).resolves.toBe('written');
    expect(FirebaseService.saveRateStats.mock.calls[0][0][0].data.weeks['w2026-08-31']).toBeUndefined();
});
