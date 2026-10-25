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
        saveRateStats: jest.fn(async () => {})
    }
}));
jest.mock('../modules/reports.js', () => ({ chartScaleMax: (v) => Math.max(1, ...v) }));

import { RateTrendsManager } from '../modules/rate-trends.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { aggregateBills, finalizeStats, istMonthKey } from '../utils/rate-trends.js';

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
