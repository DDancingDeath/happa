/**
 * @fileoverview Restoring an auto-save or loading a draft never saves a bill twice or over a
 * newer copy (#93). An auto-save survives a save when the app closes before it is deleted:
 * an edit goes back on its bill (the server's copy, asked about when it changed since), and
 * a new bill whose id is already saved is offered to open instead of being saved again.
 */
import { FirebaseService } from '../firebase/firestore-service.js';
import * as BillDrafts from '../firebase/repos/bill-drafts.js';
import { BillingManager } from '../modules/billing.js';
import { PurchaseManager } from '../modules/purchase.js';
import { RetailSaleManager } from '../modules/retail-sale.js';
import { AuditService } from '../services/audit.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { AppState } from '../utils/state.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';
import { sampleItems } from '../../../tests/fixtures/sample-items.js';
import fs from 'fs';
import path from 'path';

jest.mock('../firebase/repos/bill-drafts.js', () => ({
    getAutoSave: jest.fn(),
    saveAutoSave: jest.fn().mockResolvedValue(undefined),
    deleteAutoSave: jest.fn().mockResolvedValue(undefined),
    saveDraft: jest.fn().mockResolvedValue(undefined),
    getDraft: jest.fn(),
    deleteDraft: jest.fn().mockResolvedValue(undefined),
    countDrafts: jest.fn().mockResolvedValue(0),
    loadItemFrequency: jest.fn().mockResolvedValue(null),
    addItemFrequency: jest.fn().mockResolvedValue(undefined)
}));

const BILLING_TEMPLATE = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'billing.html'), 'utf8');

const RICE = (weights) => {
    const qty = weights.reduce((a, b) => a + b, 0);
    return { itemId: 'item-rice', name: 'Rice', rate: 10, qty, total: qty * 10, weights };
};
const BILL = {
    id: 'p1', billNumber: 'P20261101-001', type: 'purchase', isPurchase: true, userId: 'u1',
    date: '2026-11-01T10:00:00.000Z', timestamp: 1793527200000,
    items: [RICE([10])], billTotal: 100, grandTotal: 100, amountPayable: 100, laborCharges: 0, customerName: 'Ramesh',
    cashPayment: 0, onlinePayment: 0, dueAmount: 100, payment: { cash: 0, online: 0, due: 100, total: 100 }
};
const PAID = {
    cashPayment: 40, dueAmount: 60, payment: { cash: 40, online: 0, due: 60, total: 100 },
    payments: [{ id: 'pay1', amount: 40, mode: 'cash', at: 1793530000000 }], paidAt: 1793530000000
};

let fake;
let modal;
let toast;
let viewBill;
let savePurchase;

const stored = (over = {}) => fake.raw('purchases').set('p1', { ...BILL, ...over });
const docs = () => fake.raw('purchases');
const settle = () => new Promise(resolve => setTimeout(resolve, 150));
const setVal = (id, v) => { document.getElementById(id).value = String(v); };

/** The app starts again with `autoSave` on the banner and the user taps Restore. */
async function restore(autoSave) {
    BillDrafts.getAutoSave.mockResolvedValue({ userId: 'u1', ...autoSave });
    await BillingManager.checkAutoSave();
    await BillingManager.resolveRecovery(true);
    await settle();
}

/** Pays the purchase on screen in cash and taps Save. */
async function payCashAndSave() {
    ['onlinePayment', 'dueAmount'].forEach(id => setVal(id, ''));
    ['onlineCheckbox', 'dueCheckbox'].forEach(id => { document.getElementById(id).checked = false; });
    setVal('cashPayment', PurchaseManager.computeTotals().grandTotal);
    document.getElementById('cashCheckbox').checked = true;
    return PurchaseManager.saveBillToHistory();
}

function resetForms() {
    BillingManager.editingBillIndex = undefined;
    BillingManager.editingBillId = undefined;
    BillingManager.editingBillType = undefined;
    BillingManager.editingBill = undefined;
    BillingManager.pendingRecovery = null;
    PurchaseManager.setBillItems([]);
    PurchaseManager.setWeights([]);
    PurchaseManager.setPendingBill(null);
    RetailSaleManager.setSaleItems([]);
    RetailSaleManager.setSaleWeights([]);
    RetailSaleManager.setPendingBill(null);
}

beforeEach(() => {
    fake = createFakeFirestore();
    global.firebase = { ...fake.firebase, auth: () => ({ currentUser: { uid: 'u1', email: 'o@x' } }) };
    FirebaseService.cleanup();
    document.body.innerHTML = BILLING_TEMPLATE + '<div id="billDetailsOverlay"></div><div id="draftsOverlay"></div><span id="draftCount"></span>';
    viewBill = jest.fn();
    window.app = { nav: { showTab: jest.fn() }, history: { viewBill }, billing: BillingManager };
    AppState.currentUser = { uid: 'u1' };
    AppState.userRole = 'owner';
    AppState.userName = 'Owner';
    AppState.items = sampleItems();
    AppState.settings = { laborRate: 6, heavyWeightThreshold: 30 };
    AppState.purchaseHistory = [];
    AppState.retailSalesHistory = [];
    BillingManager.init();
    BillingManager.currentMode = 'purchase';
    resetForms();
    jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    jest.spyOn(UIManager, 'withLoading').mockImplementation(async (fn) => fn());
    jest.spyOn(UIManager, 'showLoading').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hideLoading').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
    jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async (html) => {
        const box = document.createElement('div');
        box.innerHTML = html;
        document.body.appendChild(box);
        const reason = document.getElementById('reasonInput');
        if (reason) reason.value = 'Restored lines';
        return true;
    });
    modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
    toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(Helpers, 'generateBillNumber').mockImplementation(async (prefix) => `${prefix}20261102-001`);
    jest.spyOn(AuditService, 'log').mockResolvedValue(undefined);
    jest.spyOn(BillingManager, '_refreshAfterEdit').mockImplementation(() => {});
    // A new bill's save, as the server would store it
    savePurchase = jest.spyOn(FirebaseService, 'savePurchase').mockImplementation(async (bill) => {
        docs().set(String(bill.id), { ...bill });
        return bill;
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    Object.values(BillDrafts).forEach(fn => fn.mockClear?.());
});

afterEach(() => {
    resetForms();
    jest.restoreAllMocks();
    FirebaseService.cleanup();
    delete window.app;
});

describe('an auto-save of an edit (#93 a)', () => {
    const editAutoSave = (over = {}) => ({
        mode: 'purchase',
        editingBillId: 'p1',
        editingBillType: 'purchase',
        editingBase: FirebaseService.billVersion(BILL),
        purchase: { items: [RICE([6, 4])], weights: [], pendingBill: { id: 'tmp9' }, customerName: 'Ramesh', billTotal: 100 },
        sale: { items: [], weights: [] },
        ...over
    });

    test('carries the bill, its type and the version the editor opened', async () => {
        BillingManager.openEditor({ ...BILL }, 'purchase');
        PurchaseManager.setBillItems([RICE([6, 4])]);
        await BillingManager.autoSaveToCloud();
        expect(BillDrafts.saveAutoSave.mock.calls.at(-1)[1]).toMatchObject({
            editingBillId: 'p1', editingBillType: 'purchase', editingBase: FirebaseService.billVersion(BILL)
        });
    });

    test('Restore re-opens it as an edit of that bill: Save edits it, no second bill', async () => {
        stored();
        await restore(editAutoSave());
        expect(PurchaseManager.getBillItems().map(i => i.weights)).toEqual([[6, 4]]);
        await payCashAndSave();
        expect(savePurchase).not.toHaveBeenCalled();
        expect([...docs().keys()]).toEqual(['p1']);
        expect(docs().get('p1')).toMatchObject({ editCount: 1, cashPayment: 100, dueAmount: 0 });
        expect(docs().get('p1').items.map(i => i.weights)).toEqual([[6, 4]]);
        // Unchanged since the auto-save: no question
        expect(modal.mock.calls.map(c => c[1])).not.toContain('Bill changed since');
    });

    test('changed on the server since (a payment): asks with both totals; No keeps it on the banner, Yes edits the latest copy', async () => {
        stored(PAID);
        const autoSave = editAutoSave({ purchase: { items: [RICE([12])], weights: [], billTotal: 120 } });
        modal.mockResolvedValueOnce(false);
        await restore(autoSave);
        expect(modal).toHaveBeenCalledWith(
            'This bill was changed after your unsaved edit (a payment or an edit). Saved bill: ₹100. Your unsaved edit: ₹120. Put your unsaved edit on the latest bill?',
            'Bill changed since', true);
        expect(BillingManager.editingBillIndex).toBeUndefined();
        expect(PurchaseManager.getBillItems()).toEqual([]);
        expect(BillingManager.pendingRecovery).not.toBeNull();
        expect(BillDrafts.deleteAutoSave).not.toHaveBeenCalled();

        await BillingManager.resolveRecovery(true);
        await settle();
        expect(BillingManager.editingBill.payments).toEqual(PAID.payments);
        expect(PurchaseManager.getBillItems().map(i => i.qty)).toEqual([12]);
    });

    test('a name or labour cleared in the unsaved edit stays cleared over the bill\'s own', async () => {
        stored({ laborCharges: 12, grandTotal: 88, amountPayable: 88, comments: 'old note' });
        await restore(editAutoSave({ editingBase: FirebaseService.billVersion({ ...BILL, laborCharges: 12, grandTotal: 88, amountPayable: 88 }),
            purchase: { items: [RICE([6, 4])], weights: [], customerName: '', laborCharges: 0, comments: '', billTotal: 100 } }));
        expect(BillingManager.editingBillId).toBe('p1');
        expect(document.getElementById('customerName').value).toBe('');
        expect(document.getElementById('billComments').value).toBe('');
        expect(document.getElementById('manualLaborCharges').value).toBe('0');
    });

    test('an older auto-save without the version: asked before it is applied', async () => {
        stored();
        await restore(editAutoSave({ editingBillType: undefined, editingBase: undefined }));
        expect(modal).toHaveBeenCalledWith(expect.stringContaining('Saved bill: ₹100. Your unsaved edit: ₹100.'), 'Bill changed since', true);
        expect(BillingManager.editingBillId).toBe('p1');
    });

    test('voided meanwhile: said and dropped; out of reach and not on this phone: kept on the banner', async () => {
        stored({ voided: true, voidReason: 'wrong' });
        await restore(editAutoSave());
        expect(toast).toHaveBeenCalledWith('This bill is already voided.');
        expect(BillingManager.editingBillIndex).toBeUndefined();
        expect(PurchaseManager.getBillItems()).toEqual([]);
        expect(BillDrafts.deleteAutoSave).toHaveBeenCalledWith('u1');

        jest.spyOn(FirebaseService, 'latestBill').mockRejectedValue(Object.assign(new Error('offline'), { code: 'unavailable' }));
        await restore(editAutoSave());
        expect(toast).toHaveBeenLastCalledWith('Connect to the internet to restore this unsaved edit.', 'warning');
        expect(BillingManager.pendingRecovery).not.toBeNull();
        expect(PurchaseManager.getBillItems()).toEqual([]);
    });
});

describe('an auto-save of a new bill whose bill is already saved (#93 b)', () => {
    test('one taken before the first line carries the bill id, so Restore after the save offers to open it', async () => {
        PurchaseManager.setWeights([10]);
        await BillingManager.autoSaveToCloud();
        const autoSave = BillDrafts.saveAutoSave.mock.calls[0][1];
        expect(autoSave.purchase.pendingBill?.id).toBeTruthy();

        // The bill is finished and saved, but the app closes before the auto-save is deleted
        BillingManager.loadItemsDropdown();
        setVal('billItem', AppState.items.findIndex(i => i.id === 'item-rice'));
        setVal('billRate', 10);
        await PurchaseManager.addToBill();
        await payCashAndSave();
        expect(savePurchase.mock.calls[0][0].id).toBe(autoSave.purchase.pendingBill.id);
        resetForms();

        await restore(autoSave);
        expect(modal).toHaveBeenCalledWith(expect.stringContaining('already saved (P20261102-001)'), 'Already saved', true);
        expect(PurchaseManager.getWeights()).toEqual([]);
        expect([...docs().keys()]).toEqual([autoSave.purchase.pendingBill.id]);
    });

    test('an older copy never overwrites the saved bill (fewer lines, a payment recorded since): offered to open instead', async () => {
        stored({ ...PAID, items: [RICE([10]), RICE([5])], billTotal: 150, grandTotal: 150, amountPayable: 150 });
        const before = { ...docs().get('p1') };
        const reads = fake.stats.reads;
        await restore({
            mode: 'purchase',
            purchase: { items: [RICE([10])], weights: [], pendingBill: { id: 'p1', billNumber: null, attempted: false }, billTotal: 100 },
            sale: { items: [] }
        });
        await payCashAndSave();
        expect(savePurchase).not.toHaveBeenCalled();
        expect(docs().get('p1')).toEqual(before);
        expect(fake.stats.reads - reads).toBe(1);
        expect(modal).toHaveBeenCalledWith(
            "This bill is already saved (P20261101-001) and won't be saved again. Saved bill: ₹150. This unsaved copy: ₹100. Open the saved bill to change it?",
            'Already saved', true);
        expect(viewBill).toHaveBeenCalledWith('id:p1', 'purchase');
        expect(PurchaseManager.getBillItems()).toEqual([]);
        expect(BillDrafts.deleteAutoSave).toHaveBeenCalledWith('u1');
    });

    test('the saved bill on this phone: no read', async () => {
        AppState.purchaseHistory = [{ ...BILL }];
        const reads = fake.stats.reads;
        modal.mockResolvedValueOnce(false);
        await restore({ mode: 'purchase', purchase: { items: [RICE([10])], pendingBill: { id: 'p1' } }, sale: { items: [] } });
        expect(fake.stats.reads - reads).toBe(0);
        expect(viewBill).not.toHaveBeenCalled();
        expect(PurchaseManager.getBillItems()).toEqual([]);
    });

    test('not saved: restored with its id, marked restored; offline: this phone\'s copy is checked, else restored with a warning', async () => {
        await restore({ mode: 'purchase', purchase: { items: [RICE([10])], pendingBill: { id: 'n1' } }, sale: { items: [] } });
        expect(modal).not.toHaveBeenCalled();
        expect(PurchaseManager.getPendingBill()).toMatchObject({ id: 'n1', attempted: false, restored: true });
        resetForms();

        jest.spyOn(FirebaseService, 'latestBill').mockRejectedValue(Object.assign(new Error('offline'), { code: 'unavailable' }));
        const onPhone = jest.spyOn(FirebaseService, 'billOnThisPhone').mockResolvedValueOnce({ ...BILL, id: 'n1' });
        await restore({ mode: 'purchase', purchase: { items: [RICE([10])], pendingBill: { id: 'n1' } }, sale: { items: [] } });
        expect(onPhone).toHaveBeenCalledWith('purchases', 'n1');
        expect(modal).toHaveBeenCalledWith(expect.stringContaining('already saved'), 'Already saved', true);
        expect(PurchaseManager.getBillItems()).toEqual([]);

        await restore({ mode: 'purchase', purchase: { items: [RICE([10])], pendingBill: { id: 'n1' } }, sale: { items: [] } });
        expect(toast).toHaveBeenCalledWith("Couldn't check whether this bill was already saved on another phone. Save it when online to have it checked.", 'warning');
        expect(PurchaseManager.getPendingBill()).toMatchObject({ id: 'n1', attempted: false, restored: true });
        expect(PurchaseManager.getBillItems()).toHaveLength(1);
    });

    test('an unconfirmed attempt whose bill was saved with other lines: both totals are shown', async () => {
        stored();
        await restore({ mode: 'purchase', purchase: { items: [RICE([10]), RICE([5])], pendingBill: { id: 'p1', attempted: true } }, sale: { items: [] } });
        expect(modal).toHaveBeenCalledWith(
            "This bill is already saved (P20261101-001) and won't be saved again. Saved bill: ₹100. This unsaved copy: ₹150. Open the saved bill to change it?",
            'Already saved', true);
    });
});

describe('saving a restored new bill (#93)', () => {
    const restored = { mode: 'purchase', purchase: { items: [RICE([10])], pendingBill: { id: 'n1' } }, sale: { items: [] } };

    beforeEach(() => savePurchase.mockRestore());

    test('its id still free: created (in a transaction), one bill', async () => {
        await restore(restored);
        await payCashAndSave();
        expect([...docs().keys()]).toEqual(['n1']);
        expect(docs().get('n1')).toMatchObject({ cashPayment: 100, items: [RICE([10])] });
        expect(PurchaseManager.getBillItems()).toEqual([]);
    });

    test('saved meanwhile under its id (another phone): never written over, offered to open', async () => {
        await restore(restored);
        fake.raw('purchases').set('n1', { ...BILL, id: 'n1', ...PAID });
        const before = { ...docs().get('n1') };
        modal.mockResolvedValue(true);
        expect(await payCashAndSave()).toBeUndefined();
        expect(docs().get('n1')).toEqual(before);
        expect(modal).toHaveBeenCalledWith(expect.stringContaining('already saved (P20261101-001'), 'Already saved', true);
        expect(viewBill).toHaveBeenCalledWith('id:n1', 'purchase');
        expect(PurchaseManager.getBillItems()).toHaveLength(1);
    });

    test('a copy of an earlier (unconfirmed) attempt is restored create-only too', async () => {
        await restore({ mode: 'purchase', purchase: { items: [RICE([10])], pendingBill: { id: 'n1', billNumber: 'P20261102-007', attempted: true } }, sale: { items: [] } });
        expect(PurchaseManager.getPendingBill()).toMatchObject({ id: 'n1', attempted: true, restored: true });
        fake.raw('purchases').set('n1', { ...BILL, id: 'n1' });
        const before = { ...docs().get('n1') };
        modal.mockImplementation(async (_text, title) => title !== 'Already saved');
        await payCashAndSave();
        expect(docs().get('n1')).toEqual(before);
        expect(modal).toHaveBeenCalledWith(expect.stringContaining('already saved'), 'Already saved', true);
    });

    test('a create-only try that failed (network), then offline: a plain first save, not a retry', async () => {
        await restore(restored);
        const save = jest.spyOn(FirebaseService, 'savePurchase')
            .mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'unavailable' }))
            .mockResolvedValue(undefined);
        await expect(payCashAndSave()).rejects.toMatchObject({ code: 'unavailable' });
        expect(save.mock.calls[0][1]).toEqual({ retry: false, createOnly: true });
        jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
        await payCashAndSave();
        expect(save.mock.calls[1][1]).toEqual({ retry: false });
    });

    test('offline: a plain first save (queued), no longer marked restored', async () => {
        await restore(restored);
        jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
        const save = jest.spyOn(FirebaseService, 'savePurchase').mockResolvedValue(undefined);
        await payCashAndSave();
        expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1' }), { retry: false });
    });
});

describe('loading a draft (#93)', () => {
    test('its bill already saved: offered to open; Yes deletes the draft, No keeps it; never put in the form', async () => {
        stored();
        BillDrafts.getDraft.mockResolvedValue({ id: 'd1', userId: 'u1', mode: 'purchase', items: [RICE([10])], weights: [], pendingBill: { id: 'p1' } });
        modal.mockResolvedValueOnce(false);
        await BillingManager.loadDraft('d1');
        expect(BillDrafts.deleteDraft).not.toHaveBeenCalled();
        expect(viewBill).not.toHaveBeenCalled();
        await BillingManager.loadDraft('d1');
        expect(BillDrafts.deleteDraft).toHaveBeenCalledWith('d1');
        expect(viewBill).toHaveBeenCalledWith('id:p1', 'purchase');
        expect(PurchaseManager.getBillItems()).toEqual([]);
    });

    test('a draft saved while editing loads back as that edit', async () => {
        stored();
        AppState.purchaseHistory = [{ ...BILL }];
        BillingManager.openEditor(AppState.purchaseHistory[0], 'purchase');
        PurchaseManager.setBillItems([RICE([6, 4])]);
        await BillingManager.saveDraft();
        const draft = BillDrafts.saveDraft.mock.calls[0][0];
        expect(draft).toMatchObject({ editingBillId: 'p1', editingBillType: 'purchase', pendingBill: null });
        resetForms();

        BillDrafts.getDraft.mockResolvedValue(draft);
        await BillingManager.loadDraft(draft.id);
        expect(BillingManager.editingBillId).toBe('p1');
        expect(PurchaseManager.getBillItems().map(i => i.weights)).toEqual([[6, 4]]);
        await payCashAndSave();
        expect(savePurchase).not.toHaveBeenCalled();
        expect([...docs().keys()]).toEqual(['p1']);
    });
});
