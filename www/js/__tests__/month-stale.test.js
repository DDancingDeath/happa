/**
 * @fileoverview Month snapshots (monthStats) go stale when a record of an older month is
 * saved, edited or deleted later: which months, the merge write, and the guarded rebuild.
 */
import { FirebaseService } from '../firebase/firestore-service.js';
import { OutstandingManager } from '../modules/outstanding.js';
import { AppState } from '../utils/state.js';
import { staleMonthsFor, staleOlderMonths, staleToRebuild, snapshotsFrom } from '../utils/month-snapshots.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

/** Bill edits carry a reason (#121). */
const EDIT_REASON = { reason: 'Test edit' };

const NOW = new Date(2026, 9, 21, 15).getTime();
const at = (y, m, d = 10) => new Date(y, m - 1, d, 10).getTime();

let fake;

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(new Date(NOW));
    fake = createFakeFirestore();
    global.firebase = fake.firebase;
    FirebaseService.cleanup();
    AppState.currentUser = { uid: 'u1' };
    AppState.userName = 'Owner';
    AppState.userRole = 'staff';
    AppState.purchaseHistory = [];
    AppState.salesHistory = [];
    AppState.retailSalesHistory = [];
    AppState.expensesHistory = [];
    jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
});

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    FirebaseService.cleanup();
});

const purchase = (time, over = {}) => ({
    id: 'p1', billNumber: 'P-1', type: 'purchase', isPurchase: true,
    date: new Date(time).toISOString(), timestamp: time,
    items: [{ itemId: 'rice', name: 'Rice', qty: 10, rate: 10, total: 100, weights: [10] }],
    billTotal: 100, laborCharges: 0, grandTotal: 100, amountPayable: 100,
    cashPayment: 40, onlinePayment: 0, dueAmount: 60, customerName: 'Ramesh',
    payment: { cash: 40, online: 0, due: 60, total: 100 },
    ...over
});
const marks = async () => {
    const months = await FirebaseService.monthMarksIssued();
    await fake.settle();
    return months;
};
const stats = () => Object.fromEntries([...fake.raw('monthStats').entries()]);

describe('which months a change makes stale', () => {
    test('the months of the old and new date before this month; with a stock change every later month through the previous one', () => {
        expect(staleMonthsFor([null, at(2026, 3)], { now: NOW, cascade: true }))
            .toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
        expect(staleMonthsFor([at(2026, 7), at(2026, 7, 20)], { now: NOW })).toEqual(['2026-07']);
        expect(staleMonthsFor([at(2026, 5), at(2026, 10)], { now: NOW })).toEqual(['2026-05']);
        expect(staleMonthsFor([at(2026, 9), null], { now: NOW })).toEqual(['2026-09']);
        expect(staleMonthsFor([at(2026, 10, 1), at(2026, 10, 21)], { now: NOW, cascade: true })).toEqual([]);
        expect(staleMonthsFor([null, null], { now: NOW, cascade: true })).toEqual([]);
    });

    test('only months the app reads (two years back)', () => {
        expect(snapshotsFrom(NOW)).toBe('2024-10');
        expect(staleMonthsFor([at(2024, 9)], { now: NOW })).toEqual([]);
        expect(staleMonthsFor([at(2024, 8)], { now: NOW, cascade: true })[0]).toBe('2024-10');
    });

    test('which stale months a device rebuilds: older than the previous month, read after the mark was seen', () => {
        const docs = { '2026-05': { stale: true }, '2026-09': { stale: true }, '2026-04': { v: 1 } };
        expect(staleOlderMonths(docs, NOW)).toEqual(['2026-05']);
        expect(staleToRebuild(docs, { now: NOW, fetchedAt: 10, seenAt: { '2026-05': 9 } })).toEqual(['2026-05']);
        expect(staleToRebuild(docs, { now: NOW, fetchedAt: 10, seenAt: { '2026-05': 10 } })).toEqual([]);
        expect(staleToRebuild(docs, { now: NOW, fetchedAt: 10, seenAt: {} })).toEqual([]);
    });
});

describe('the stale mark on a late save, edit or delete', () => {
    test('a new bill dated in March marks March through September (stock changed), merged into existing snapshots', async () => {
        fake.seed('monthStats', [{ id: '2026-05', month: '2026-05', v: 1, m: { M1: 900 }, builtAt: 1 }]);
        const events = [];
        const on = (e) => events.push(e.detail);
        window.addEventListener('aadhat:monthstale', on);
        await FirebaseService.savePurchase(purchase(at(2026, 3)), { retry: false });
        window.removeEventListener('aadhat:monthstale', on);
        expect(await marks()).toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
        const s = stats();
        expect(Object.keys(s).sort()).toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
        expect(s['2026-03']).toEqual({ month: '2026-03', stale: true, staleAt: NOW });
        expect(s['2026-05']).toEqual({ month: '2026-05', v: 1, m: { M1: 900 }, builtAt: 1, stale: true, staleAt: NOW });
        expect(events).toEqual([{ months: Object.keys(s).sort(), at: NOW }]);
    });

    test('a payment-only edit of a July bill marks July only; deleting it marks July', async () => {
        const july = purchase(at(2026, 7));
        fake.seed('purchases', [july]);
        AppState.purchaseHistory = [{ ...july }];
        await FirebaseService.updatePurchase(purchase(at(2026, 7), { cashPayment: 100, dueAmount: 0, payment: { cash: 100, online: 0, due: 0, total: 100 } }), EDIT_REASON);
        expect(await marks()).toEqual(['2026-07']);
        expect(Object.keys(stats())).toEqual(['2026-07']);
        fake.raw('monthStats').clear();
        await FirebaseService.deletePurchase('p1');
        expect(await marks()).toEqual(['2026-07', '2026-08', '2026-09']);
    });

    test('moving a bill from August to today marks August (and the months its stock touched)', async () => {
        const aug = purchase(at(2026, 8));
        fake.seed('purchases', [aug]);
        AppState.purchaseHistory = [{ ...aug }];
        await FirebaseService.updatePurchase(purchase(NOW, { date: new Date(NOW).toISOString() }), EDIT_REASON);
        expect(await marks()).toEqual(['2026-08', '2026-09']);
    });

    test('a bill of this month, or a payment on an old bill (counted on its own day, today), marks nothing', async () => {
        await FirebaseService.savePurchase(purchase(at(2026, 10, 2)), { retry: false });
        expect(await marks()).toEqual([]);
        fake.seed('retailSales', [{ id: 'r1', date: '2026-03-10', timestamp: at(2026, 3), total: 100, payment: { cash: 0, online: 0, due: 100 }, dueAmount: 100, openDue: true }]);
        await OutstandingManager.applyPaymentTransaction('retail', { id: 'r1' }, 40, { recordedBy: 'S' });
        await fake.settle();
        expect(fake.raw('retailSales').get('r1').paidAt).toBe(NOW);
        expect(fake.raw('monthStats').size).toBe(0);
    });

    test('a back-dated expense or withdrawal marks its own month only', async () => {
        await FirebaseService.saveExpense({ date: '2026-06-15', amount: 50, category: 'business' });
        expect(await marks()).toEqual(['2026-06']);
        await FirebaseService.saveWithdrawal({ date: '2026-08-02', amount: 500, person: 'Owner' });
        expect(await marks()).toEqual(['2026-08']);
        fake.seed('expenses', [{ id: 'e9', date: '2026-04-03', amount: 20 }]);
        AppState.expensesHistory = [{ id: 'e9', date: '2026-04-03', amount: 20 }];
        await FirebaseService.deleteExpense('e9');
        expect(await marks()).toEqual(['2026-04']);
        expect(Object.keys(stats()).sort()).toEqual(['2026-04', '2026-06', '2026-08']);
    });
});

describe('the guarded rebuild write', () => {
    const doc = { month: '2026-05', v: 1, m: { M1: 1000 }, builtAt: NOW };
    // as stored: stamped by an app that knows voided bills (#75)
    const written = { ...doc, clientVersion: 5, writtenAt: NOW };

    test('replaces the stale mark it saw; keeps a newer mark; skips a month already rebuilt', async () => {
        fake.seed('monthStats', [{ id: '2026-05', month: '2026-05', v: 1, m: { M1: 900 }, stale: true, staleAt: 5 }]);
        expect(await FirebaseService.rebuildMonthStat(doc, 5)).toEqual({ status: 'written', doc });
        expect(fake.raw('monthStats').get('2026-05')).toEqual(written);
        expect((await FirebaseService.rebuildMonthStat({ ...doc, m: { M1: 1 } }, 5)).status).toBe('fresh');
        expect(fake.raw('monthStats').get('2026-05')).toEqual(written);
        fake.seed('monthStats', [{ id: '2026-05', month: '2026-05', stale: true, staleAt: 6 }]);
        const r = await FirebaseService.rebuildMonthStat(doc, 5);
        expect(r).toEqual({ status: 'newer', doc: { month: '2026-05', stale: true, staleAt: 6 } });
        expect(fake.raw('monthStats').get('2026-05')).toEqual({ month: '2026-05', stale: true, staleAt: 6 });
    });

    test('Build month history\'s write: over a fresh or missing month; over a stale one only when this phone handled that mark', async () => {
        expect((await FirebaseService.saveMonthStatGuarded(doc)).status).toBe('written');
        expect(fake.raw('monthStats').get('2026-05')).toEqual(written);
        expect((await FirebaseService.saveMonthStatGuarded({ ...doc, builtAt: 1 })).status).toBe('written');
        fake.seed('monthStats', [{ id: '2026-05', month: '2026-05', stale: true, staleAt: 7 }]);
        expect(await FirebaseService.saveMonthStatGuarded(doc)).toEqual({ status: 'newer', doc: { month: '2026-05', stale: true, staleAt: 7 } });
        expect((await FirebaseService.saveMonthStatGuarded(doc, { staleAt: 6 })).status).toBe('newer');
        expect(fake.raw('monthStats').get('2026-05')).toEqual({ month: '2026-05', stale: true, staleAt: 7 });
        expect((await FirebaseService.saveMonthStatGuarded(doc, { staleAt: 7 })).status).toBe('written');
        expect(fake.raw('monthStats').get('2026-05')).toEqual(written);
    });
});
