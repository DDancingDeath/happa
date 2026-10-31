/**
 * @fileoverview Void (#75) and edit records (#121) through FirebaseService against
 * an in-memory Firestore: the void write, what blocks it, voided bills kept out of
 * AppState (so no figure counts them) but listed for History, stock and month
 * snapshots marked as for a delete, edit records written in the edit's
 * transaction and read on demand, and the owner's delete for good.
 */
import { FirebaseService } from '../firebase/firestore-service.js';
import { OutstandingManager } from '../modules/outstanding.js';
import { AppState } from '../utils/state.js';
import { editLines } from '../utils/bill-edits.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

const NOW = new Date(2026, 9, 21, 15).getTime();
const DAY = 24 * 60 * 60 * 1000;
const line = (qty) => ({ itemId: 'rice', name: 'Rice', qty, rate: 10, total: qty * 10 });
const sale = (id, time, over = {}) => ({
    id, billNumber: id.toUpperCase(), date: new Date(time).toISOString(), timestamp: time, userId: 'u1', clientVersion: 3,
    customerName: 'Ramesh', items: [line(10)], total: 100, saleTotal: 100,
    payment: { cash: 40, online: 0, due: 60, total: 100 }, cashPayment: 40, onlinePayment: 0, dueAmount: 60, openDue: true, ...over
});

let fake;
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await fake.settle(); };
const retail = (id) => AppState.retailSalesHistory.find(b => b.id === id);

async function open() {
    FirebaseService.cleanup();
    await FirebaseService.setupRealtimeListeners();
    await FirebaseService.getStock();
    await settle();
}

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(new Date(NOW));
    fake = createFakeFirestore();
    global.firebase = fake.firebase;
    AppState.currentUser = { uid: 'u1' };
    AppState.userName = 'Ravi';
    AppState.userRole = 'owner';
    AppState.stock = {};
    jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    ['info', 'log', 'warn'].forEach(k => jest.spyOn(console, k).mockImplementation(() => {}));
    fake.seed('items', [{ id: 'rice', name: 'Rice' }]);
    fake.seed('stockCheckpoints', [{ id: 'legacyScan', ...Object.fromEntries(['purchases', 'retailSales', 'wholesaleSales', 'stockAdjustments', 'expenses', 'withdrawals'].map(c => [c, { v: 2, complete: true, foundAt: 0 }])) }]);
    fake.seed('purchases', [{ id: 'p1', date: new Date(NOW - 5 * DAY).toISOString(), timestamp: NOW - 5 * DAY, items: [line(50)], billTotal: 500, grandTotal: 500, payment: { cash: 500, online: 0, due: 0 }, openDue: false }]);
    fake.seed('retailSales', [sale('r1', NOW - DAY), sale('r2', NOW - DAY, { customerName: 'Shyam' })]);
});

afterEach(() => {
    FirebaseService.cleanup();
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete global.firebase;
    AppState.currentUser = null;
});

describe('void (#75)', () => {
    test('one update: who, server time, reason, openDue off; the bill leaves AppState (no figure counts it) and is listed as voided', async () => {
        await open();
        expect(AppState.stock.rice.quantity).toBe(30);
        await FirebaseService.voidBill('retailSales', retail('r1'), '  Entered twice ');
        await settle();
        expect(fake.raw('retailSales').get('r1')).toMatchObject({
            voided: true, voidedAt: NOW, voidedBy: 'u1', voidedByName: 'Ravi', voidReason: 'Entered twice', openDue: false,
            total: 100, items: [line(10)], payment: { cash: 40, online: 0, due: 60, total: 100 }
        });
        expect(AppState.retailSalesHistory.map(b => b.id)).toEqual(['r2']);
        expect(FirebaseService.voidedBills('retailSales').map(b => [b.id, b.voidReason])).toEqual([['r1', 'Entered twice']]);
        AppState.stock = await FirebaseService.calculateStock();
        expect(AppState.stock.rice.quantity).toBe(40);
    });

    test('refused: no reason, payments recorded after the save, already voided; nothing written', async () => {
        fake.seed('retailSales', [sale('r3', NOW - DAY, { payments: [{ id: 'x', amount: 10, cash: 10, online: 0, at: NOW - 1000 }] })]);
        await open();
        await expect(FirebaseService.voidBill('retailSales', retail('r1'), 'no')).rejects.toMatchObject({ code: 'reason-required' });
        await expect(FirebaseService.voidBill('retailSales', retail('r3'), 'Entered twice')).rejects.toMatchObject({ code: 'has-payments' });
        await FirebaseService.voidBill('retailSales', retail('r1'), 'Entered twice');
        await settle();
        const voided = FirebaseService.voidedBills('retailSales')[0];
        await expect(FirebaseService.voidBill('retailSales', voided, 'Again please')).rejects.toMatchObject({ code: 'already-voided' });
        expect(fake.raw('retailSales').get('r3').voided).toBeUndefined();
        expect(fake.raw('retailSales').get('r1').voidReason).toBe('Entered twice');
    });

    test('an older bill: the stock checkpoint and its month snapshots are marked stale, as for a delete', async () => {
        fake.seed('retailSales', [sale('old', new Date(2026, 6, 10, 10).getTime())]);
        await open();
        // A member's phone marks; only owner / manager phones rebuild.
        AppState.userRole = 'staff';
        const old = { ...fake.raw('retailSales').get('old'), id: 'old' };
        await FirebaseService.voidBill('retailSales', old, 'Wrong party');
        const months = await FirebaseService.monthMarksIssued();
        await settle();
        expect(months).toEqual(['2026-07', '2026-08', '2026-09']);
        expect(fake.raw('stockCheckpoints').get('current')).toMatchObject({ stale: true });
    });

    test('no payment can be recorded on a voided bill', async () => {
        await open();
        await FirebaseService.voidBill('retailSales', retail('r1'), 'Entered twice');
        await expect(OutstandingManager.applyPaymentTransaction('retail', { id: 'r1' }, 20, { recordedBy: 'S' }))
            .rejects.toMatchObject({ code: 'voided' });
        expect(fake.raw('retailSales').get('r1').payments).toBeUndefined();
    });

    test('delete for good: only a voided bill, with its edit records', async () => {
        await open();
        await expect(FirebaseService.deleteVoidedBill('retailSales', retail('r2'))).rejects.toMatchObject({ code: 'not-voided' });
        await FirebaseService.updateRetailSale({ ...retail('r1'), customerName: 'Ramesh K' }, { reason: 'Spelling' });
        await settle();
        await FirebaseService.voidBill('retailSales', retail('r1'), 'Entered twice');
        await settle();
        expect(fake.raw('retailSales/r1/edits').size).toBe(1);
        await FirebaseService.deleteVoidedBill('retailSales', FirebaseService.voidedBills('retailSales')[0]);
        await settle();
        expect(fake.raw('retailSales').has('r1')).toBe(false);
        expect(fake.raw('retailSales/r1/edits').size).toBe(0);
        expect(FirebaseService.voidedBills('retailSales')).toEqual([]);
    });
});

describe('edit records (#121)', () => {
    test('an edit writes edits/{n} in its transaction: changed fields before/after (the item list whole), who and why; editCount counts', async () => {
        await open();
        const edited = { ...retail('r2'), items: [line(9)], total: 90, saleTotal: 90, payment: { cash: 40, online: 0, due: 50, total: 90 }, dueAmount: 50 };
        await FirebaseService.updateRetailSale(edited, { reason: ' Wrong weight ' });
        await settle();
        expect(fake.raw('retailSales').get('r2').editCount).toBe(1);
        expect(fake.raw('retailSales/r2/edits').get('1')).toEqual({
            n: 1, at: NOW, by: 'u1', byName: 'Ravi', reason: 'Wrong weight',
            fields: {
                items: { before: [{ ...line(10) }], after: [{ ...line(9) }] },
                total: { before: 100, after: 90 }, saleTotal: { before: 100, after: 90 }, dueAmount: { before: 60, after: 50 },
                payment: { before: { cash: 40, online: 0, due: 60, total: 100 }, after: { cash: 40, online: 0, due: 50, total: 90 } }
            }
        });
        expect(editLines(fake.raw('retailSales/r2/edits').get('1'))).toEqual([{ name: 'Rice', before: { qty: 10, rate: 10, total: 100 }, after: { qty: 9, rate: 10, total: 90 } }]);
        await FirebaseService.updateRetailSale({ ...retail('r2'), customerName: 'Shyam Lal' }, { reason: 'Full name' });
        await settle();
        expect(retail('r2').editCount).toBe(2);
        const edits = await FirebaseService.loadBillEdits('retailSales', retail('r2'));
        expect(edits.map(e => [e.n, e.reason, Object.keys(e.fields)])).toEqual([
            [1, 'Wrong weight', ['items', 'total', 'saleTotal', 'payment', 'dueAmount']], [2, 'Full name', ['customerName']]
        ]);
    });

    test('a change without a reason is refused; a save that changes nothing recorded writes no record', async () => {
        await open();
        await expect(FirebaseService.updateRetailSale({ ...retail('r2'), total: 90 }, {})).rejects.toMatchObject({ code: 'reason-required' });
        expect(fake.raw('retailSales').get('r2').total).toBe(100);
        await FirebaseService.updateRetailSale({ ...retail('r2'), editedAt: 'now' });
        await settle();
        expect(fake.raw('retailSales').get('r2').editCount).toBeUndefined();
        expect(fake.raw('retailSales/r2/edits').size).toBe(0);
    });

    test('a bill voided on another phone is not overwritten by an edit (it would un-void it)', async () => {
        await open();
        const stale = { ...retail('r2') };
        await FirebaseService.voidBill('retailSales', retail('r2'), 'Entered twice');
        await expect(FirebaseService.updateRetailSale({ ...stale, customerName: 'X' }, { reason: 'Name fix' })).rejects.toMatchObject({ code: 'voided' });
        expect(fake.raw('retailSales').get('r2')).toMatchObject({ voided: true, customerName: 'Shyam' });
    });

    test('edit records are not loaded with the bills: one read per record, only when asked', async () => {
        await open();
        await FirebaseService.updateRetailSale({ ...retail('r2'), customerName: 'Shyam Lal' }, { reason: 'Full name' });
        await settle();
        fake.stats.reads = 0;
        await open();
        expect(fake.stats.queryLog.concat(fake.stats.listenLog).some(q => String(q.coll || q).includes('/edits'))).toBe(false);
        const before = fake.stats.reads;
        await FirebaseService.loadBillEdits('retailSales', retail('r2'));
        expect(fake.stats.reads - before).toBe(1);
    });
});
