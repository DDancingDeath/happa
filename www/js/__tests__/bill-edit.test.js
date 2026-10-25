/**
 * @fileoverview Bill edit save flow (BillingManager.saveEditedBill): edits are
 * transactions, so the UI must only report success / print / clear the editor
 * after the server committed; offline and conflicts keep the editor. Also the
 * client-side edit permission (canEditBill).
 */
import { BillingManager, PurchaseManager, canEditBill, EDIT_NOT_ALLOWED_KEY } from '../modules/billing.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { NAME_REQUIRED_FOR_DUE_KEY } from '../utils/money.js';
import { t } from '../i18n/index.js';

const BILL = { id: 'b1', userId: 'creator', items: [{ itemId: 'x', qty: 1, rate: 1 }], payment: { due: 0 } };

function startEditing() {
    AppState.purchaseHistory = [{ ...BILL }];
    BillingManager.currentMode = 'purchase';
    BillingManager.editingBillIndex = 0;
    BillingManager.editingBillId = 'b1';
    BillingManager.editingBillType = 'purchase';
}

describe('saveEditedBill', () => {
    let toast;
    let onLine;

    beforeEach(() => {
        toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(PurchaseManager, 'clearBill').mockImplementation(() => {});
        jest.spyOn(BillingManager, '_refreshAfterEdit').mockImplementation(() => {});
        onLine = jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
        startEditing();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        BillingManager.editingBillIndex = undefined;
        AppState.purchaseHistory = [];
    });

    it('refuses up front when offline and keeps the editor', async () => {
        onLine.mockReturnValue(false);
        const update = jest.spyOn(FirebaseService, 'updatePurchase');
        const onWriteIssued = jest.fn();
        expect(await BillingManager.saveEditedBill({ onWriteIssued })).toBeUndefined();
        expect(update).not.toHaveBeenCalled();
        expect(onWriteIssued).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith('Internet required to edit a bill');
        expect(BillingManager.editingBillIndex).toBe(0);
    });

    it('on a conflict shows the message, does not print/replace/clear', async () => {
        jest.spyOn(FirebaseService, 'updatePurchase').mockRejectedValue(
            Object.assign(new Error('This bill was changed on another device — reopen it and try again'), { code: 'conflict' }));
        const onWriteIssued = jest.fn();
        expect(await BillingManager.saveEditedBill({ onWriteIssued })).toBeUndefined();
        expect(onWriteIssued).not.toHaveBeenCalled();
        expect(PurchaseManager.clearBill).not.toHaveBeenCalled();
        expect(AppState.purchaseHistory[0]).toEqual(BILL);
        expect(toast).toHaveBeenCalledWith(expect.stringContaining('changed on another device'));
        expect(BillingManager.editingBillIndex).toBe(0);
    });

    it('refuses an edit that leaves a Due without a name (#68)', async () => {
        document.body.innerHTML = '<input id="dueAmount" value="50"><input id="customerName" value=" ">';
        const update = jest.spyOn(FirebaseService, 'updatePurchase');
        expect(await BillingManager.saveEditedBill()).toBeUndefined();
        expect(update).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith(t(NAME_REQUIRED_FOR_DUE_KEY));
        expect(BillingManager.editingBillIndex).toBe(0);
        document.body.innerHTML = '';
    });

    it('refuses an edit whose payment split does not match the new total (#23)', async () => {
        document.body.innerHTML = '<input id="cashPayment" value="50">';
        const update = jest.spyOn(FirebaseService, 'updatePurchase');
        expect(await BillingManager.saveEditedBill()).toBeUndefined();
        expect(update).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith(expect.stringContaining('₹50 more than the bill total'));
        document.body.innerHTML = '';
    });

    it('prints, replaces and clears only after the transaction committed', async () => {
        let commit;
        const onWriteIssued = jest.fn();
        jest.spyOn(FirebaseService, 'updatePurchase').mockImplementation(b => new Promise(r => { commit = () => r(b); }));
        const saving = BillingManager.saveEditedBill({ onWriteIssued });
        await Promise.resolve();
        await Promise.resolve();
        expect(onWriteIssued).not.toHaveBeenCalled();
        expect(PurchaseManager.clearBill).not.toHaveBeenCalled();
        commit();
        const saved = await saving;
        expect(onWriteIssued).toHaveBeenCalledWith(saved);
        expect(PurchaseManager.clearBill).toHaveBeenCalled();
        expect(AppState.purchaseHistory[0]).toBe(saved);
        expect(BillingManager.editingBillIndex).toBeUndefined();
    });
});

describe('canEditBill', () => {
    afterEach(() => {
        AppState.userRole = 'staff';
        AppState.currentUser = null;
    });

    const HOUR = 3600000;
    const saved = (msAgo) => ({ ...BILL, createdAt: { toMillis: () => Date.now() - msAgo } });

    it('owner any bill; manager any bill and staff own bills within 2 days of saving (#87)', () => {
        AppState.currentUser = { uid: 'creator' };
        AppState.userRole = 'staff';
        expect(canEditBill(saved(47 * HOUR))).toBe(true);
        expect(canEditBill(saved(49 * HOUR))).toBe(false);
        expect(canEditBill(BILL)).toBe(false);
        expect(canEditBill({ ...saved(HOUR), userId: 'someone' })).toBe(false);
        expect(canEditBill({ ...saved(HOUR), userId: undefined })).toBe(false);
        AppState.userRole = 'manager';
        expect(canEditBill({ ...saved(HOUR), userId: undefined })).toBe(true);
        expect(canEditBill({ ...saved(49 * HOUR), userId: 'someone' })).toBe(false);
        AppState.userRole = 'owner';
        expect(canEditBill({ ...BILL, userId: 'someone' })).toBe(true);
    });

    it('editBill on an own bill past the window explains the 2-day limit', async () => {
        AppState.currentUser = { uid: 'creator' };
        AppState.userRole = 'staff';
        AppState.purchaseHistory = [saved(3 * 24 * HOUR)];
        window.currentBillId = 'b1';
        const toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        BillingManager.editingBillIndex = undefined;
        await BillingManager.editBill(0, 'purchase');
        expect(toast).toHaveBeenCalledWith(t('msg.billing.edit_window_passed'));
        expect(BillingManager.editingBillIndex).toBeUndefined();
        toast.mockRestore();
    });

    it('editBill refuses with the policy message', async () => {
        AppState.currentUser = { uid: 'other' };
        AppState.userRole = 'staff';
        AppState.purchaseHistory = [{ ...BILL }];
        window.currentBillId = 'b1';
        const toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        BillingManager.editingBillIndex = undefined;
        await BillingManager.editBill(0, 'purchase');
        expect(toast).toHaveBeenCalledWith(t(EDIT_NOT_ALLOWED_KEY));
        expect(BillingManager.editingBillIndex).toBeUndefined();
        toast.mockRestore();
    });
});

describe('Print comments toggle survives edit (#86)', () => {
    beforeEach(() => {
        document.body.innerHTML = '<input id="billComments"><input type="checkbox" id="billPrintComments">';
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        jest.spyOn(PurchaseManager, 'renderBill').mockImplementation(() => {});
        jest.spyOn(PurchaseManager, 'updateTotals').mockImplementation(() => {});
        jest.spyOn(PurchaseManager, 'clearBill').mockImplementation(() => {});
        jest.spyOn(BillingManager, '_refreshAfterEdit').mockImplementation(() => {});
        jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
        window.app = { nav: { showTab: jest.fn() } };
        AppState.currentUser = { uid: 'creator' };
        AppState.userRole = 'owner';
    });

    afterEach(() => {
        jest.restoreAllMocks();
        BillingManager.editingBillIndex = undefined;
        AppState.purchaseHistory = [];
        AppState.currentUser = null;
        AppState.userRole = 'staff';
        delete window.app;
    });

    it('editBill restores the toggle from the bill', async () => {
        AppState.purchaseHistory = [{ ...BILL, comments: 'Paid via GPay', printComments: true }];
        window.currentBillId = 'b1';
        BillingManager.currentMode = 'purchase';
        await BillingManager.editBill(0, 'purchase');
        expect(document.getElementById('billPrintComments').checked).toBe(true);
    });

    it('saving a purchase edit stores the toggle instead of dropping it', async () => {
        startEditing();
        document.getElementById('billPrintComments').checked = true;
        jest.spyOn(FirebaseService, 'updatePurchase').mockImplementation(async b => b);
        const saved = await BillingManager.saveEditedBill();
        expect(saved.printComments).toBe(true);
    });
});