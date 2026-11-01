/**
 * @fileoverview Anomalies module (#187, #40): daily scan runs once per day on
 * owner/manager devices, never writes when stored records can't be read from
 * the server, writes only new ids, and the Day report card is hidden for
 * other users and escapes stored text.
 */
jest.mock('../firebase/firestore-service.js', () => ({
    FirebaseService: {
        loadCashSessionsBetween: jest.fn(async () => []),
        loadAuditLogsSince: jest.fn(async () => []),
        loadAnomalies: jest.fn(async () => ({ docs: [], last: null, more: false })),
        saveAnomalies: jest.fn(async () => {}),
        loadPeople: jest.fn(async () => [])
    }
}));
jest.mock('../services/printer.js', () => ({ PrinterService: { showImagePreview: jest.fn(() => true) } }));

import { AnomaliesManager } from '../modules/anomalies.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';

// Fixed midday IST clock (Date only): the night-entry rule would otherwise also
// fire when CI happens to run late at night.
jest.useFakeTimers({
    now: new Date('2026-10-21T12:00:00+05:30'),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
        'setTimeout', 'clearTimeout']
});
afterAll(() => jest.useRealTimers());

const now = Date.now();
const badBill = {
    id: 'b1', billNumber: 'R1', customerName: '<img src=x onerror=alert(1)>', userId: 'u1', userName: 'Amit',
    items: [{ name: 'Rice', rate: 40, qty: 10, total: 400 }], total: 400,
    payment: { cash: 100, online: 0, due: 0 }, date: new Date(now).toISOString(), timestamp: now
};

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.clear();
    AppState.userRole = 'owner';
    AppState.currentUser = { uid: 'own1' };
    AppState.historyLoadedFrom = 0;
    AppState.retailSalesHistory = [badBill];
    AppState.purchaseHistory = [];
    AppState.salesHistory = [];
    AppState.stockAdjustments = [];
    AppState.items = [];
    AnomaliesManager.stored = null;
    AnomaliesManager.reportList = [];
    AnomaliesManager.refreshing = null;
    AnomaliesManager.scanQueue = null;
    AnomaliesManager.owners = null;
    document.body.innerHTML = '<div id="dayReportCard" style="display:none"></div>';
});

describe('daily scan', () => {
    test('#147: back-dated bills are flagged from 1 day for anyone but an owner (owners read once from the team)', async () => {
        const dated = (id, userId) => ({ ...badBill, id, userId, payment: { cash: 400, online: 0, due: 0 }, timestamp: now - 86400000, date: new Date(now - 86400000).toISOString(), enteredAt: now });
        // Nothing dated back by someone else: no read of the team
        AppState.retailSalesHistory = [dated('mine', 'own1')];
        await AnomaliesManager.scan('2026-10-21', '2026-10-21');
        expect(FirebaseService.loadPeople).not.toHaveBeenCalled();
        AppState.retailSalesHistory = [dated('s1', 'staff1'), dated('o2', 'own2')];
        FirebaseService.loadPeople.mockResolvedValue([{ id: 'own2', role: 'owner' }, { id: 'staff1', role: 'staff' }]);
        const { detected } = await AnomaliesManager.scan('2026-10-21', '2026-10-21');
        expect(detected.map(a => [a.type, a.refId])).toEqual([['date-backdated', 's1']]);
        await AnomaliesManager.scan('2026-10-21', '2026-10-21');
        expect(FirebaseService.loadPeople).toHaveBeenCalledTimes(1);
        // A bill without enteredAt that reached the server a day after its date also needs the owners
        AnomaliesManager.owners = null;
        FirebaseService.loadPeople.mockClear();
        AppState.retailSalesHistory = [{ ...dated('s2', 'staff1'), enteredAt: undefined, createdAt: { seconds: Math.floor(now / 1000), nanoseconds: 0 } }];
        expect((await AnomaliesManager.scan('2026-10-21', '2026-10-21')).detected.map(a => [a.type, a.refId])).toEqual([['date-backdated', 's2']]);
        expect(FirebaseService.loadPeople).toHaveBeenCalledTimes(1);
        AppState.retailSalesHistory = [dated('s1', 'staff1'), dated('o2', 'own2')];
        // Not known (read failed): Q20 for all
        AnomaliesManager.owners = null;
        FirebaseService.loadPeople.mockRejectedValueOnce(new Error('offline'));
        expect((await AnomaliesManager.scan('2026-10-21', '2026-10-21')).detected).toEqual([]);
    });

    test('writes new records once per day; a second run the same day reads and writes nothing', async () => {
        await AnomaliesManager.dailyScan();
        expect(FirebaseService.loadAnomalies).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ server: true }));
        expect(FirebaseService.saveAnomalies).toHaveBeenCalledTimes(1);
        const writes = FirebaseService.saveAnomalies.mock.calls[0][0];
        expect(writes.map(w => w.id)).toEqual(['payment-split~bill~b1']);
        expect(writes[0].data.status).toBe('open');

        await AnomaliesManager.dailyScan();
        expect(FirebaseService.loadAnomalies).toHaveBeenCalledTimes(1);
        expect(FirebaseService.saveAnomalies).toHaveBeenCalledTimes(1);
    });

    test('already stored records are not rewritten (review status kept)', async () => {
        FirebaseService.loadAnomalies.mockResolvedValueOnce({ docs: [], last: null, more: false });
        await AnomaliesManager.scan('2000-01-01', '2100-01-01');
        const stored = FirebaseService.saveAnomalies.mock.calls[0][0].map(w => ({ id: w.id, ...w.data, status: 'ok' }));
        FirebaseService.loadAnomalies.mockResolvedValueOnce({ docs: stored, last: null, more: false });
        FirebaseService.saveAnomalies.mockClear();
        await AnomaliesManager.scan('2000-01-01', '2100-01-01');
        expect(FirebaseService.saveAnomalies).not.toHaveBeenCalled();
    });

    test('offline (server read fails): nothing is written and the day is not marked scanned', async () => {
        FirebaseService.loadAnomalies.mockRejectedValueOnce(new Error('unavailable'));
        await AnomaliesManager.dailyScan();
        expect(FirebaseService.saveAnomalies).not.toHaveBeenCalled();
        expect(localStorage.getItem('aadhatAnomalyScanDay')).toBeNull();
    });

    test('other users never scan; managers do not read the audit log', async () => {
        AppState.userRole = 'staff';
        await AnomaliesManager.dailyScan();
        expect(FirebaseService.loadAnomalies).not.toHaveBeenCalled();
        AppState.userRole = 'manager';
        await AnomaliesManager.dailyScan();
        expect(FirebaseService.loadAuditLogsSince).not.toHaveBeenCalled();
        expect(FirebaseService.saveAnomalies).toHaveBeenCalled();
    });
});

describe('Day report card', () => {
    test('owner sees counts and the review queue with escaped text', async () => {
        AnomaliesManager.renderDayReport({ sales: 400, saleCount: 1 }, null);
        await AnomaliesManager.refreshing;
        const card = document.getElementById('dayReportCard');
        expect(card.style.display).toBe('block');
        expect(card.textContent).toContain('Day report');
        expect(card.textContent).not.toContain('आज की रिपोर्ट');
        expect(card.textContent).toContain('Payment does not match total');
        expect(card.querySelector('img')).toBeNull();
        expect(card.innerHTML).toContain('&lt;img');
        expect(card.textContent).not.toMatch(/staff/i);
        expect(AnomaliesManager.dayReportText()).toContain('Sales: ₹400 (1 bill)');
    });

    test("only today's anomalies on the card and in the share text; older open ones are a count on All anomalies", async () => {
        const yAt = now - 86400000;
        AppState.retailSalesHistory = [badBill, {
            ...badBill, id: 'b0', billNumber: 'R0', customerName: 'Yesterday Party',
            date: new Date(yAt).toISOString(), timestamp: yAt
        }];
        AnomaliesManager.renderDayReport({ sales: 400, saleCount: 1 }, null);
        await AnomaliesManager.refreshing;
        const card = document.getElementById('dayReportCard');
        expect(AnomaliesManager.reportList.map(a => a.dayKey)).toEqual(expect.arrayContaining(['2026-10-20', '2026-10-21']));
        expect(card.textContent).not.toContain('Yesterday Party');
        expect(card.textContent).not.toContain('R0');
        expect(card.textContent).not.toContain('Yesterday');
        expect(card.textContent).toContain('Needs review (1)');
        expect(card.querySelector('.anomaly-count-badge').textContent).toBe('1');
        expect(card.textContent).toContain('All anomalies · 1 pending');
        const text = AnomaliesManager.dayReportText();
        expect(text).toContain('Anomalies: 1 (High 1, Medium 0, Low 0)');
        expect(text).not.toContain('R0');
        expect(text).not.toContain('Yesterday');
    });

    test('no pending count when nothing older is open', async () => {
        AnomaliesManager.renderDayReport({}, null);
        await AnomaliesManager.refreshing;
        const card = document.getElementById('dayReportCard');
        expect(card.textContent).toContain('All anomalies');
        expect(card.textContent).not.toContain('pending');
    });

    test('hidden for other users', () => {
        AppState.userRole = 'staff';
        AnomaliesManager.renderDayReport({}, null);
        expect(document.getElementById('dayReportCard').style.display).toBe('none');
        expect(FirebaseService.loadAnomalies).not.toHaveBeenCalled();
    });

    describe('voids (#75): no approval, but a void by anyone but an owner is flagged on Today', () => {
        const voidedBill = (id, voidedBy) => ({
            ...badBill, id, billNumber: `V${id}`, payment: { cash: 400, online: 0, due: 0 },
            voided: true, voidedBy, voidedByName: 'Ravi', voidedAt: { toDate: () => new Date(now - 60000) }, voidReason: 'Entered twice'
        });
        beforeEach(() => {
            AppState.retailSalesHistory = [];
            FirebaseService.voidedBills = jest.fn(coll => (coll === 'retailSales' ? [voidedBill('1', 'staff1'), voidedBill('2', 'own1')] : []));
        });
        afterEach(() => { delete FirebaseService.voidedBills; });

        test('owner: a member\'s void shows at once (medium, with the reason) from the bills already loaded; the owner\'s own does not', async () => {
            FirebaseService.loadPeople.mockResolvedValue([{ id: 'own1', role: 'owner' }, { id: 'staff1', role: 'staff' }]);
            AnomaliesManager.renderDayReport({}, null);
            expect(AnomaliesManager.reportList.map(a => [a.id, a.severity])).toEqual([['bill-voided~bill~1', 'medium']]);
            const card = document.getElementById('dayReportCard');
            expect(card.textContent).toContain('Bill #V1 voided (₹400) — Entered twice');
            await AnomaliesManager.refreshing;
            expect(FirebaseService.loadAuditLogsSince).not.toHaveBeenCalled();
            expect(FirebaseService.saveAnomalies.mock.calls[0][0].map(w => w.id)).toEqual(['bill-voided~bill~1']);
        });

        test('manager: the owner\'s void is told apart by the team list, read once', async () => {
            AppState.userRole = 'manager';
            AppState.currentUser = { uid: 'man1' };
            FirebaseService.loadPeople.mockResolvedValue([{ id: 'own1', role: 'owner' }, { id: 'staff1', role: 'staff' }]);
            AnomaliesManager.renderDayReport({}, null);
            await AnomaliesManager.refreshing;
            expect(AnomaliesManager.reportList.map(a => a.id)).toEqual(['bill-voided~bill~1']);
            expect(FirebaseService.saveAnomalies.mock.calls[0][0].map(w => w.id)).toEqual(['bill-voided~bill~1']);
            AnomaliesManager.stored = null;
            await AnomaliesManager.refreshDayReport();
            expect(FirebaseService.loadPeople).toHaveBeenCalledTimes(1);
        });
    });
});

describe('read budget (free plan)', () => {
    const serverCalls = () => FirebaseService.loadAnomalies.mock.calls.filter(c => !c[2]?.cacheOnly);

    test('Today refresh never reads the audit log; the daily scan does, capped', async () => {
        await AnomaliesManager.refreshDayReport();
        expect(FirebaseService.loadAuditLogsSince).not.toHaveBeenCalled();
        expect(serverCalls()[0][2]).toEqual(expect.objectContaining({ limit: 200, server: true }));
        await AnomaliesManager.dailyScan();
        expect(FirebaseService.loadAuditLogsSince).toHaveBeenCalledTimes(1);
        // paged by FirebaseService, at most 1,000 entries per scanned day
        expect(FirebaseService.loadAuditLogsSince.mock.calls[0][1]).toBe(7 * 1000);
    });

    test('repeated Today refreshes within the TTL (even after reopening the app) use the cache only', async () => {
        await AnomaliesManager.refreshDayReport();
        expect(serverCalls()).toHaveLength(1);
        for (let i = 0; i < 3; i++) {
            AnomaliesManager.stored = null; // app reopened: in-memory copy gone, TTL kept in localStorage
            await AnomaliesManager.refreshDayReport();
        }
        expect(serverCalls()).toHaveLength(1);
        expect(FirebaseService.loadCashSessionsBetween).toHaveBeenCalledTimes(1);
        expect(FirebaseService.loadAnomalies.mock.calls.filter(c => c[2]?.cacheOnly)).toHaveLength(3);
        expect(FirebaseService.saveAnomalies).toHaveBeenCalledTimes(1);

        await AnomaliesManager.refreshNow(); // the card's refresh button reads the server
        expect(serverCalls()).toHaveLength(2);
    });

    test('after the daily scan the Today card needs no server read of its own', async () => {
        await AnomaliesManager.dailyScan();
        FirebaseService.loadAnomalies.mockClear();
        AnomaliesManager.stored = null;
        await AnomaliesManager.refreshDayReport();
        expect(serverCalls()).toHaveLength(0);
    });
});
