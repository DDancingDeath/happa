/**
 * @fileoverview Bill edit save flow (BillingManager.saveEditedBill): edits are
 * transactions, so the UI must only report success / print / clear the editor
 * after the server committed; offline and conflicts keep the editor. Also the
 * client-side edit permission (canEditBill).
 */
import { BillingManager, PurchaseManager, canEditBill, EDIT_NOT_ALLOWED_KEY, EDIT_WINDOW_CLOSED_KEY } from '../modules/billing.js';
import { RetailSaleManager } from '../modules/retail-sale.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { NAME_REQUIRED_FOR_DUE_KEY, round2 } from '../utils/money.js';
import { t } from '../i18n/index.js';

const BILL = { id: 'b1', userId: 'creator', items: [{ itemId: 'x', qty: 1, rate: 1 }], payment: { due: 0 } };

/** Answers the edit-reason dialog (#121) with 	ext; null = Cancel. */
function answerReason(text = 'Typo fix') {
    return jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async (html) => {
        if (text === null) return false;
        const box = document.createElement('div');
        box.innerHTML = html;
        document.body.appendChild(box);
        document.getElementById('reasonInput').value = text;
        return true;
    });
}

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
        answerReason();
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
        for (let i = 0; i < 20 && !commit; i++) await Promise.resolve();
        expect(onWriteIssued).not.toHaveBeenCalled();
        expect(PurchaseManager.clearBill).not.toHaveBeenCalled();
        commit();
        const saved = await saving;
        expect(onWriteIssued).toHaveBeenCalledWith(saved);
        expect(PurchaseManager.clearBill).toHaveBeenCalled();
        expect(AppState.purchaseHistory[0]).toBe(saved);
        expect(BillingManager.editingBillIndex).toBeUndefined();
    });

    it('asks for a reason and passes it with the edit (#121)', async () => {
        const update = jest.spyOn(FirebaseService, 'updatePurchase').mockImplementation(async b => b);
        expect(await BillingManager.saveEditedBill()).toBeDefined();
        expect(UIManager.showModalWithHtml).toHaveBeenCalledWith(expect.stringContaining('reasonInput'), t('ui.edits.reason_title'), true);
        expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }), { reason: 'Typo fix' });
    });

    it('a cancelled or too short reason saves nothing and keeps the editor', async () => {
        const update = jest.spyOn(FirebaseService, 'updatePurchase');
        answerReason(null);
        expect(await BillingManager.saveEditedBill()).toBeUndefined();
        answerReason('no');
        expect(await BillingManager.saveEditedBill()).toBeUndefined();
        expect(toast).toHaveBeenCalledWith(t('msg.edits.reason_required'));
        expect(update).not.toHaveBeenCalled();
        expect(BillingManager.editingBillIndex).toBe(0);
    });

    it('a bill voided on another phone is not changed', async () => {
        jest.spyOn(FirebaseService, 'updatePurchase').mockRejectedValue(Object.assign(new Error('This bill was voided'), { code: 'voided' }));
        expect(await BillingManager.saveEditedBill()).toBeUndefined();
        expect(toast).toHaveBeenCalledWith(t('msg.billing.edit_voided'));
        expect(BillingManager.editingBillIndex).toBe(0);
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
        answerReason();
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
describe('#129: editing a bill saved with paise', () => {
    const PURCHASE_FORM = `
      <select id="billItem"></select><input id="billRate"><input id="newWeight">
      <table id="billTable"><tbody></tbody></table><div id="weightBreakdownSection"></div>
      <span id="billTotal">0</span><span id="totalPacketsInBill">0</span>
      <input type="checkbox" id="autoLaborCharge" checked><input id="manualLaborCharges" value="0"><span id="laborCalculation"></span>
      <span id="amountPayable">0</span><span id="totalPayment">0</span>
      <input id="onlinePayment"><input id="cashPayment"><input id="dueAmount"><strong id="purchaseSplitRemaining"></strong>
      <input type="checkbox" id="onlineCheckbox"><input type="checkbox" id="cashCheckbox"><input type="checkbox" id="dueCheckbox">
      <input id="customerName"><input id="billComments"><input type="checkbox" id="billPrintComments">`;
    const SALE_FORM = `
      <select id="saleItem"></select><input id="saleRate"><input id="saleWeight">
      <table id="saleTable"><tbody></tbody></table><div id="saleWeightBreakdownSection"></div>
      <span id="saleTotal">0</span><span id="totalSalePacketsInBill">0</span><span id="amountReceivable">0</span><span id="totalReceived">0</span>
      <input id="saleOnlinePayment"><input id="saleCashPayment"><input id="saleDueAmount"><strong id="saleSplitRemaining"></strong>
      <input type="checkbox" id="saleOnlineCheckbox"><input type="checkbox" id="saleCashCheckbox"><input type="checkbox" id="saleDueCheckbox">
      <input id="saleCustomerName"><input id="saleComments"><input type="checkbox" id="salePrintComments">`;
    // ₹1,000 of lines, ₹12.50 labour typed by hand: payable ₹987.50 (saved before #129)
    const oldPurchase = (payment) => ({
        id: 'b1', userId: 'creator', customerName: 'Ramesh', date: '2026-10-01T10:00:00.000Z', timestamp: 1,
        items: [{ itemId: 'rice', name: 'Rice', qty: 40, rate: 25, total: 1000, weights: [40] }],
        billTotal: 1000, laborCharges: 12.5, laborCalc: null, totalPackets: 1, grandTotal: 987.5, amountPayable: 987.5,
        cashPayment: payment.cash, onlinePayment: payment.online, dueAmount: payment.due,
        payment: { ...payment, total: round2(payment.cash + payment.online + payment.due) }
    });
    let update;
    const setVal = (id, v) => { document.getElementById(id).value = String(v); };

    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        jest.spyOn(PurchaseManager, 'clearBill').mockImplementation(() => {});
        jest.spyOn(RetailSaleManager, 'clearSale').mockImplementation(() => {});
        jest.spyOn(BillingManager, '_refreshAfterEdit').mockImplementation(() => {});
        jest.spyOn(BillingManager, 'switchMode').mockImplementation(function (mode) { this.currentMode = mode; });
        jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
        answerReason();
        window.app = { nav: { showTab: jest.fn() }, billing: { switchMode: jest.fn() } };
        AppState.currentUser = { uid: 'creator' };
        AppState.userRole = 'owner';
        AppState.settings = {};
        PurchaseManager.init(BillingManager);
        RetailSaleManager.init(BillingManager);
        update = jest.spyOn(FirebaseService, 'updatePurchase').mockImplementation(async b => b);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        BillingManager.editingBillIndex = undefined;
        AppState.purchaseHistory = [];
        AppState.retailSalesHistory = [];
        PurchaseManager.setBillItems([]);
        RetailSaleManager.setSaleItems([]);
        delete window.app;
        document.body.innerHTML = '';
    });

    async function openPurchase(bill) {
        document.body.innerHTML = PURCHASE_FORM;
        AppState.purchaseHistory = [bill];
        window.currentBillId = bill.id;
        BillingManager.currentMode = 'purchase';
        await BillingManager.editBill(0, 'purchase');
    }

    test('a name-only edit keeps every stored money field exactly (paise included)', async () => {
        const bill = oldPurchase({ cash: 487.5, online: 500, due: 0 });
        await openPurchase(bill);
        setVal('customerName', 'Ramesh Kumar');
        const saved = await BillingManager.saveEditedBill();
        expect(update).toHaveBeenCalledTimes(1);
        const money = ['items', 'billTotal', 'laborCharges', 'laborCalc', 'totalPackets', 'grandTotal', 'amountPayable', 'cashPayment', 'onlinePayment', 'dueAmount', 'payment'];
        money.forEach(k => expect(saved[k]).toEqual(bill[k]));
        expect(saved.customerName).toBe('Ramesh Kumar');
    });

    test('2 legs (₹487.50 + ₹500 of ₹987.50): with the labour changed the split adds up to the new payable exactly', async () => {
        await openPurchase(oldPurchase({ cash: 487.5, online: 500, due: 0 }));
        setVal('manualLaborCharges', 12);
        PurchaseManager.updateTotals();
        // ₹988 payable; the legs 488 + 500 already add up to it
        const saved = await BillingManager.saveEditedBill();
        expect(saved).toMatchObject({ laborCharges: 12, grandTotal: 988, cashPayment: 488, onlinePayment: 500, dueAmount: 0 });
        expect(saved.payment).toEqual({ cash: 488, online: 500, due: 0, total: 988 });
    });

    test('2 legs, payable rounded to ₹987 (labour ₹12.50 → ₹13): no ₹1 overpaid', async () => {
        await openPurchase(oldPurchase({ cash: 487.5, online: 500, due: 0 }));
        // The line re-weighed as two packets (same kg and amount): a money edit
        PurchaseManager.setBillItems([{ itemId: 'rice', name: 'Rice', qty: 40, rate: 25, total: 1000, weights: [20, 20] }]);
        PurchaseManager.updateTotals();
        const saved = await BillingManager.saveEditedBill();
        expect(saved).toMatchObject({ laborCharges: 13, grandTotal: 987 });
        expect(saved.payment).toEqual({ cash: 488, online: 499, due: 0, total: 987 });
    });

    test('3 legs (300.50 + 300.50 + 386.50): the split check passes and the due takes the remainder', async () => {
        await openPurchase(oldPurchase({ cash: 300.5, online: 300.5, due: 386.5 }));
        setVal('manualLaborCharges', 13);
        PurchaseManager.updateTotals();
        expect(PurchaseManager.readPaymentSplit()).toEqual({ cash: 301, online: 301, due: 385 });
        const saved = await BillingManager.saveEditedBill();
        expect(update).toHaveBeenCalledTimes(1);
        expect(saved.payment).toEqual({ cash: 301, online: 301, due: 385, total: 987 });
        expect([saved.cashPayment, saved.onlinePayment, saved.dueAmount]).toEqual([301, 301, 385]);
    });

    test('a retail sale with a ₹0.50 old due: a money edit leaves ₹0 due, not ₹1', async () => {
        document.body.innerHTML = SALE_FORM;
        const sale = {
            id: 's1', userId: 'creator', customerName: 'Sita', date: '2026-10-01T10:00:00.000Z', timestamp: 1,
            items: [{ itemId: 'rice', name: 'Rice', qty: 20.01, rate: 50, total: 1000.5, packets: 1 }],
            total: 1000.5, saleTotal: 1000.5, cashPayment: 1000, onlinePayment: 0, dueAmount: 0.5,
            payment: { cash: 1000, online: 0, due: 0.5, total: 1000.5 }
        };
        AppState.retailSalesHistory = [sale];
        window.currentBillId = 's1';
        BillingManager.currentMode = 'sale';
        await BillingManager.editBill(0, 'retail');
        const updateSale = jest.spyOn(FirebaseService, 'updateRetailSale').mockImplementation(async b => b);
        // A name-only edit keeps the stored paise
        setVal('saleCustomerName', 'Sita Devi');
        const kept = await BillingManager.saveEditedBill();
        expect(kept.payment).toEqual(sale.payment);
        expect(kept.total).toBe(1000.5);
        // A money edit: the line is re-entered at 20 kg × ₹50 = ₹1,000
        BillingManager.editingBillIndex = 0;
        BillingManager.editingBillId = 's1';
        BillingManager.editingBillType = 'retail';
        AppState.retailSalesHistory = [sale];
        RetailSaleManager.setSaleItems([{ itemId: 'rice', name: 'Rice', qty: 20, rate: 50, total: 1000, packets: 1 }]);
        setVal('saleCashPayment', 1000);
        setVal('saleDueAmount', 0.5);
        const saved = await BillingManager.saveEditedBill();
        expect(updateSale).toHaveBeenCalledTimes(2);
        expect(saved).toMatchObject({ total: 1000, dueAmount: 0 });
        expect(saved.payment).toEqual({ cash: 1000, online: 0, due: 0, total: 1000 });
    });
});
