/**
 * @fileoverview Bill edit save flow (BillingManager.saveEditedBill): edits are
 * transactions, so the UI must only report success / print / clear the editor
 * after the server committed; offline and conflicts keep the editor. Also the
 * client-side edit permission (canEditBill).
 */
import { BillingManager, PurchaseManager, canEditBill, EDIT_NOT_ALLOWED_KEY, EDIT_WINDOW_CLOSED_KEY } from '../modules/billing.js';
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
    const recent = { ...BILL, createdAt: { toMillis: () => Date.now() - 60 * 60 * 1000 } };
    const old = { ...BILL, createdAt: { toMillis: () => Date.now() - 49 * 60 * 60 * 1000 }, timestamp: Date.now() };

    afterEach(() => {
        AppState.userRole = 'staff';
        AppState.currentUser = null;
        delete AppState.settings.roleAccess;
    });

    it('owner any bill; manager any recent bill; member only recent bills they created (#87: 2 days)', () => {
        AppState.currentUser = { uid: 'creator' };
        AppState.userRole = 'staff';
        expect(canEditBill(recent)).toBe(true);
        expect(canEditBill(old)).toBe(false);
        expect(canEditBill({ ...recent, userId: 'someone' })).toBe(false);
        expect(canEditBill({ ...recent, userId: undefined })).toBe(false);
        AppState.userRole = 'manager';
        expect(canEditBill({ ...recent, userId: undefined })).toBe(true);
        expect(canEditBill(old)).toBe(false);
        expect(canEditBill(BILL)).toBe(false);
        AppState.userRole = 'owner';
        expect(canEditBill({ ...old, userId: 'someone' })).toBe(true);
        expect(canEditBill(BILL)).toBe(true);
    });

    it('uses the edit days the owner set in Roles & access (#84)', () => {
        AppState.currentUser = { uid: 'creator' };
        AppState.userRole = 'staff';
        AppState.settings.roleAccess = { staff: { editDays: 5 }, manager: { editDays: 0 } };
        expect(canEditBill(old)).toBe(true);
        AppState.userRole = 'manager';
        expect(canEditBill(recent)).toBe(false);
    });

    it('editBill refuses with the policy message', async () => {
        AppState.currentUser = { uid: 'other' };
        AppState.userRole = 'staff';
        AppState.purchaseHistory = [{ ...recent }];
        window.currentBillId = 'b1';
        const toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        BillingManager.editingBillIndex = undefined;
        await BillingManager.editBill(0, 'purchase');
        expect(toast).toHaveBeenCalledWith(t(EDIT_NOT_ALLOWED_KEY));
        expect(BillingManager.editingBillIndex).toBeUndefined();
        toast.mockRestore();
    });

    it('editBill on the creator\'s old bill says the edit window has closed', async () => {
        AppState.currentUser = { uid: 'creator' };
        AppState.userRole = 'staff';
        AppState.purchaseHistory = [{ ...old }];
        window.currentBillId = 'b1';
        const toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        BillingManager.editingBillIndex = undefined;
        await BillingManager.editBill(0, 'purchase');
        expect(toast).toHaveBeenCalledWith(t(EDIT_WINDOW_CLOSED_KEY, { days: 2 }));
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