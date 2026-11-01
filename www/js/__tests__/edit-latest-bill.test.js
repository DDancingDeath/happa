/**
 * @fileoverview Editing an older bill starts from the server's copy (#127). Bills
 * outside the live window are loaded once and never updated, so before an edit the
 * bill is read again (one read, never the cache); a copy changed on another phone
 * asks "Load the latest copy?" instead of editing stale figures.
 */
import { FirebaseService } from '../firebase/firestore-service.js';
import { BillingManager } from '../modules/billing.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';
import fs from 'fs';
import path from 'path';

const BILLING_TEMPLATE = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'billing.html'), 'utf8');

let fake;
const BILL = {
    id: 'p1', billNumber: 'P20261001-001', type: 'purchase', isPurchase: true,
    date: '2026-10-01T10:00:00.000Z', timestamp: 1790848800000,
    items: [{ itemId: 'rice', name: 'Rice', qty: 10, rate: 10, total: 100, weights: [10] }],
    billTotal: 100, grandTotal: 100, amountPayable: 100, customerName: 'Ramesh',
    cashPayment: 0, onlinePayment: 0, dueAmount: 100, payment: { cash: 0, online: 0, due: 100, total: 100 }
};
const stored = (over = {}) => fake.raw('purchases').set('p1', { ...BILL, ...over });

beforeEach(() => {
    fake = createFakeFirestore();
    global.firebase = fake.firebase;
    FirebaseService.cleanup();
    AppState.currentUser = { uid: 'u1' };
    AppState.userRole = 'owner';
    jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
});

afterEach(() => {
    jest.restoreAllMocks();
    FirebaseService.cleanup();
});

describe('FirebaseService.latestBill', () => {
    test('the same copy: not changed, one read from the server', async () => {
        stored();
        const reads = fake.stats.reads;
        const res = await FirebaseService.latestBill('purchases', { ...BILL });
        expect(res.changed).toBe(false);
        expect(fake.stats.reads - reads).toBe(1);
    });

    test.each([
        ['a payment', { cashPayment: 100, dueAmount: 0, payment: { cash: 100, online: 0, due: 0, total: 100 }, payments: [{ id: 'x', amount: 100 }] }],
        ['an edit', { editCount: 1, customerName: 'Ramesh Kumar' }],
        ['a void', { voided: true, voidReason: 'wrong' }]
    ])('%s made on another phone: changed, with the server copy', async (_what, over) => {
        stored(over);
        const res = await FirebaseService.latestBill('purchases', { ...BILL });
        expect(res.changed).toBe(true);
        expect(res.bill).toMatchObject({ id: 'p1', ...over });
    });

    test('only the notes changed elsewhere: no question, but the editor gets the latest copy', async () => {
        stored({ comments: 'GPay 98xxxx' });
        const res = await FirebaseService.latestBill('purchases', { ...BILL });
        expect(res.changed).toBe(false);
        expect(res.bill.comments).toBe('GPay 98xxxx');
    });

    test('gone from the server: no bill', async () => {
        await expect(FirebaseService.latestBill('purchases', { ...BILL })).resolves.toEqual({ bill: null, changed: true });
    });

    test('never answered from the cache', async () => {
        stored();
        const get = jest.fn(() => Promise.reject(Object.assign(new Error('offline'), { code: 'unavailable' })));
        global.firebase = { ...fake.firebase, firestore: () => ({ collection: () => ({ doc: () => ({ get }) }) }) };
        await expect(FirebaseService.latestBill('purchases', { ...BILL })).rejects.toMatchObject({ code: 'unavailable' });
        expect(get).toHaveBeenCalledWith({ source: 'server' });
    });
});

describe('BillingManager.latestCopyForEdit', () => {
    let modal;
    let toast;
    beforeEach(() => {
        jest.spyOn(UIManager, 'withLoading').mockImplementation(async (fn) => fn());
        modal = jest.spyOn(UIManager, 'showModal');
        toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    });

    test('unchanged: edits the copy it has, no question', async () => {
        const bill = { ...BILL };
        jest.spyOn(FirebaseService, 'latestBill').mockResolvedValue({ bill, changed: false });
        await expect(BillingManager.latestCopyForEdit('purchase', bill)).resolves.toBe(bill);
        const latest = { ...BILL, comments: 'new note' };
        FirebaseService.latestBill.mockResolvedValueOnce({ bill: latest, changed: false });
        await expect(BillingManager.latestCopyForEdit('purchase', bill)).resolves.toBe(latest);
        expect(modal).not.toHaveBeenCalled();
    });

    test('changed on another phone: asks; Yes edits the latest copy, No stops', async () => {
        const fresh = { ...BILL, editCount: 1, customerName: 'Ramesh Kumar' };
        jest.spyOn(FirebaseService, 'latestBill').mockResolvedValue({ bill: fresh, changed: true });
        modal.mockResolvedValueOnce(true);
        await expect(BillingManager.latestCopyForEdit('purchase', { ...BILL })).resolves.toBe(fresh);
        expect(modal).toHaveBeenCalledWith(expect.stringContaining('changed on another phone'), 'Changed on another phone', true);
        modal.mockResolvedValueOnce(false);
        await expect(BillingManager.latestCopyForEdit('purchase', { ...BILL })).resolves.toBeNull();
    });

    test('voided or deleted meanwhile: says so and stops', async () => {
        jest.spyOn(FirebaseService, 'latestBill')
            .mockResolvedValueOnce({ bill: { ...BILL, voided: true }, changed: true })
            .mockResolvedValueOnce({ bill: null, changed: true });
        await expect(BillingManager.latestCopyForEdit('retail', { ...BILL })).resolves.toBeNull();
        expect(toast).toHaveBeenLastCalledWith('This bill is already voided.');
        await expect(BillingManager.latestCopyForEdit('retail', { ...BILL })).resolves.toBeNull();
        expect(toast).toHaveBeenLastCalledWith('Bill not found');
        expect(modal).not.toHaveBeenCalled();
    });

    test('server out of reach: edits the copy it has (the save checks again)', async () => {
        const bill = { ...BILL };
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(FirebaseService, 'latestBill').mockRejectedValue(Object.assign(new Error('offline'), { code: 'unavailable' }));
        await expect(BillingManager.latestCopyForEdit('purchase', bill)).resolves.toBe(bill);
    });

    test('editBill does not open the editor when the user keeps the old copy closed', async () => {
        AppState.purchaseHistory = [{ ...BILL, createdAt: { toMillis: () => Date.now() } }];
        window.currentBillId = 'p1';
        BillingManager.editingBillIndex = undefined;
        jest.spyOn(BillingManager, 'latestCopyForEdit').mockResolvedValue(null);
        await BillingManager.editBill(0, 'purchase');
        expect(BillingManager.latestCopyForEdit).toHaveBeenCalledTimes(1);
        expect(BillingManager.editingBillIndex).toBeUndefined();
    });
});

describe('edit and save when another phone recorded a payment (#127)', () => {
    // This phone's copy (a listener still on cache data, or loaded on demand) has no payment;
    // the server has one recorded on another phone.
    const OLD = { ...BILL, createdAt: { toMillis: () => Date.now() - 60 * 1000 } };
    const PAID = {
        cashPayment: 40, dueAmount: 60, payment: { cash: 40, online: 0, due: 60, total: 100 },
        payments: [{ id: 'pay1', amount: 40, mode: 'cash', at: 1790850000000 }], paidAt: 1790850000000
    };
    let modal;
    let toast;

    beforeEach(() => {
        document.body.innerHTML = BILLING_TEMPLATE + '<div id="billDetailsOverlay"></div>';
        window.app = { nav: { showTab: jest.fn() } };
        stored(PAID);
        AppState.purchaseHistory = [{ ...OLD }];
        window.currentBillId = 'p1';
        BillingManager.currentMode = 'purchase';
        BillingManager.editingBillIndex = undefined;
        BillingManager.editingBill = undefined;
        jest.spyOn(UIManager, 'withLoading').mockImplementation(async (fn) => fn());
        jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async (html) => {
            const box = document.createElement('div');
            box.innerHTML = html;
            document.body.appendChild(box);
            document.getElementById('reasonInput').value = 'Name fix';
            return true;
        });
        modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        jest.spyOn(BillingManager, '_refreshAfterEdit').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        BillingManager.editingBillIndex = undefined;
        BillingManager.editingBill = undefined;
        AppState.purchaseHistory = [];
        delete window.app;
    });

    test('loaded the latest copy: the save builds on it and keeps the payment, even with the old copy still in memory', async () => {
        await BillingManager.editBill(0, 'purchase');
        expect(BillingManager.editingBill).toMatchObject({ payments: PAID.payments });
        expect(AppState.purchaseHistory[0].payments).toBeUndefined();
        document.getElementById('customerName').value = 'Ramesh Kumar';
        await BillingManager.saveEditedBill();
        const doc = fake.raw('purchases').get('p1');
        expect(doc.customerName).toBe('Ramesh Kumar');
        expect(doc.payments).toEqual(PAID.payments);
        expect(doc.payment).toMatchObject({ cash: 40, due: 60 });
    });

    test('opened offline on the old copy: the save checks again, asks, and the payment is not overwritten (conflict)', async () => {
        const realLatest = FirebaseService.latestBill.bind(FirebaseService);
        jest.spyOn(FirebaseService, 'latestBill')
            .mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'unavailable' }))
            .mockImplementation(realLatest);
        await BillingManager.editBill(0, 'purchase');
        expect(toast).toHaveBeenCalledWith("Couldn't check for changes from other phones — editing this phone's copy.", 'warning');
        expect(BillingManager.editingBill.payments).toBeUndefined();
        document.getElementById('customerName').value = 'Ramesh Kumar';
        await BillingManager.saveEditedBill();
        expect(modal).toHaveBeenCalledWith(expect.stringContaining('changed on another phone while you were editing'), 'Changed on another phone', true);
        const doc = fake.raw('purchases').get('p1');
        expect(doc.customerName).toBe('Ramesh');
        expect(doc.payments).toEqual(PAID.payments);
        expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('changed on another device'));
        expect(BillingManager.editingBillIndex).toBe(0);
    });

    test('changed while editing, the user says No: nothing is written, the editor stays open', async () => {
        const realLatest = FirebaseService.latestBill.bind(FirebaseService);
        jest.spyOn(FirebaseService, 'latestBill')
            .mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'unavailable' }))
            .mockImplementation(realLatest);
        await BillingManager.editBill(0, 'purchase');
        const writes = fake.stats.writes;
        modal.mockResolvedValueOnce(false);
        expect(await BillingManager.saveEditedBill()).toBeUndefined();
        expect(fake.stats.writes).toBe(writes);
        expect(BillingManager.editingBillIndex).toBe(0);
    });
});
