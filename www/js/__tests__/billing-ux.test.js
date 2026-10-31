/**
 * @fileoverview Billing UX (#117): the unsaved-bill banner replaces the blocking
 * confirm(), a fresh bill focuses the Item box on a desktop, and the bill number
 * is shown before save.
 */
import { BillingManager } from '../modules/billing.js';
import { PurchaseManager } from '../modules/purchase.js';
import { RetailSaleManager } from '../modules/retail-sale.js';
import * as BillDrafts from '../firebase/repos/bill-drafts.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { autoSaveSummary, nextBillNumberHint } from '../utils/calc/billing.js';

jest.mock('../firebase/repos/bill-drafts.js', () => ({
    getAutoSave: jest.fn(),
    saveAutoSave: jest.fn().mockResolvedValue(undefined),
    deleteAutoSave: jest.fn().mockResolvedValue(undefined)
}));

const DOM = `
  <div id="billing" class="tab active">
  <div id="autoSaveBanner" hidden><span id="autoSaveBannerText"></span></div>
  <button id="purchaseModeBtn"></button><button id="saleModeBtn"></button>
  <div id="purchaseSection">
    <input id="customerName"><select id="billItem"><option value=""></option></select>
    <input id="billRate"><input id="newWeight"><div id="weightsDisplay"></div>
    <table id="billTable"><tbody></tbody></table><div id="weightBreakdownSection"></div>
    <span id="billTotal"></span><span id="totalPacketsInBill"></span>
    <input id="manualLaborCharges" value="0"><input id="billComments"><input type="checkbox" id="billPrintComments">
    <div id="purchaseBillNo"></div>
  </div>
  <div id="saleSection" style="display: none;">
    <select id="saleItem"><option value=""></option></select>
    <table id="saleTable"><tbody></tbody></table><div id="saleWeightBreakdownSection"></div>
    <div id="saleBillNo"></div>
  </div>
  <div id="modalOverlay"></div>
  </div>`;

const today = new Date();
const day = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
const desktop = (matches) => { window.matchMedia = jest.fn(() => ({ matches })); };

beforeEach(() => {
    document.body.innerHTML = DOM;
    jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    AppState.currentUser = { uid: 'u1' };
    AppState.items = [];
    AppState.purchaseHistory = [];
    AppState.retailSalesHistory = [];
    BillingManager.init();
    BillingManager.currentMode = 'purchase';
    BillingManager.pendingRecovery = null;
    BillDrafts.saveAutoSave.mockClear();
    BillDrafts.deleteAutoSave.mockClear();
    desktop(false);
});

afterEach(() => {
    jest.restoreAllMocks();
    PurchaseManager.setBillItems([]);
    PurchaseManager.setPendingBill(null);
    RetailSaleManager.setSaleItems([]);
    RetailSaleManager.setPendingBill(null);
    BillingManager.editingBillIndex = undefined;
});

describe('unsaved-bill banner (#117)', () => {
    const saved = {
        mode: 'purchase',
        lastSaved: new Date(2026, 9, 31, 10, 42),
        purchase: { items: [{ name: 'Rice', qty: 10, rate: 25, total: 250 }, { name: 'Wheat', qty: 40, rate: 25, total: 1000 }], billTotal: 1250 },
        sale: { items: [] }
    };

    test('shows the time, items and total without blocking; no confirm()', async () => {
        const confirm = jest.spyOn(window, 'confirm');
        BillDrafts.getAutoSave.mockResolvedValue(saved);
        await BillingManager.checkAutoSave();
        expect(confirm).not.toHaveBeenCalled();
        expect(document.getElementById('autoSaveBanner').hidden).toBe(false);
        expect(document.getElementById('autoSaveBannerText').textContent)
            .toMatch(/^Unsaved purchase bill from 31 Oct.*10:42 am · Items: 2 · ₹1,250$/);
        expect(BillDrafts.deleteAutoSave).not.toHaveBeenCalled();
    });

    test('while it waits, typing a new bill neither overwrites nor deletes the saved one', async () => {
        BillDrafts.getAutoSave.mockResolvedValue(saved);
        await BillingManager.checkAutoSave();
        PurchaseManager.setBillItems([{ name: 'Maize', qty: 1, rate: 1, total: 1 }]);
        await BillingManager.autoSaveToCloud();
        await BillingManager.deleteAutoSave();
        expect(BillDrafts.saveAutoSave).not.toHaveBeenCalled();
        expect(BillDrafts.deleteAutoSave).not.toHaveBeenCalled();
    });

    test('Discard deletes the auto-save and hides the banner', async () => {
        BillDrafts.getAutoSave.mockResolvedValue(saved);
        await BillingManager.checkAutoSave();
        await BillingManager.resolveRecovery(false);
        expect(BillDrafts.deleteAutoSave).toHaveBeenCalledWith('u1');
        expect(document.getElementById('autoSaveBanner').hidden).toBe(true);
        expect(BillingManager.pendingRecovery).toBeNull();
    });

    test('Restore puts the bill back', async () => {
        BillDrafts.getAutoSave.mockResolvedValue(saved);
        await BillingManager.checkAutoSave();
        jest.useFakeTimers();
        const done = BillingManager.resolveRecovery(true);
        await jest.advanceTimersByTimeAsync(200);
        await done;
        jest.useRealTimers();
        expect(PurchaseManager.getBillItems().map(i => i.name)).toEqual(['Rice', 'Wheat']);
        expect(BillDrafts.deleteAutoSave).not.toHaveBeenCalled();
        expect(document.getElementById('autoSaveBanner').hidden).toBe(true);
    });
});

describe('bill number before save (#117, BF-NO)', () => {
    test('a new bill shows the likely next number; a bill that already got one shows it', () => {
        AppState.purchaseHistory = [{ billNumber: `P${day}-003` }, { billNumber: `P${day}-ABC-007` }, { billNumber: 'P20200101-050' }];
        PurchaseManager.renderBill();
        expect(document.getElementById('purchaseBillNo').textContent).toBe(`Next bill no. (given on save): P${day}-004`);
        PurchaseManager.setPendingBill({ id: 'b1', billNumber: `P${day}-009` });
        PurchaseManager.renderBill();
        expect(document.getElementById('purchaseBillNo').textContent).toBe(`Bill no.: P${day}-009`);
        expect(document.getElementById('saleBillNo').textContent).toBe(`Next bill no. (given on save): S${day}-001`);
    });

    test('an edited bill shows its own number', () => {
        AppState.retailSalesHistory = [{ id: 'r1', billNumber: 'S20261020-002' }];
        BillingManager.editingBillIndex = 0;
        BillingManager.editingBillId = 'r1';
        BillingManager.editingBillType = 'retail';
        RetailSaleManager.renderSalesBill();
        expect(document.getElementById('saleBillNo').textContent).toBe('Bill no.: S20261020-002');
        expect(document.getElementById('purchaseBillNo').textContent).toBe(`Next bill no. (given on save): P${day}-001`);
    });
});

describe('fresh bill focuses the Item box (#117)', () => {
    test('desktop: switching to a fresh bill focuses Item; phone: no focus (keyboard)', () => {
        BillingManager.switchMode('purchase');
        expect(document.activeElement).not.toBe(document.getElementById('billItem'));
        desktop(true);
        BillingManager.switchMode('sale');
        expect(document.activeElement).toBe(document.getElementById('saleItem'));
    });

    test('no focus when the bill has items, while editing, or when typing elsewhere', () => {
        desktop(true);
        PurchaseManager.setBillItems([{ name: 'Rice', qty: 1, rate: 1, total: 1 }]);
        BillingManager.focusFirstItem();
        expect(document.activeElement).not.toBe(document.getElementById('billItem'));
        PurchaseManager.setBillItems([]);
        BillingManager.editingBillIndex = 0;
        BillingManager.focusFirstItem();
        expect(document.activeElement).not.toBe(document.getElementById('billItem'));
        BillingManager.editingBillIndex = undefined;
        document.getElementById('customerName').focus();
        BillingManager.focusFirstItem();
        expect(document.activeElement).toBe(document.getElementById('customerName'));
    });

    test('after a save the form resets onto Item', () => {
        desktop(true);
        PurchaseManager.resetForm();
        expect(document.activeElement).toBe(document.getElementById('billItem'));
    });
});

describe('calc (BF-RECOVER, BF-NO)', () => {
    test('autoSaveSummary: the mode form, its lines and saved total; old single-form shape; plain sum fallback', () => {
        expect(autoSaveSummary({ mode: 'sale', sale: { items: [{ total: 10 }], saleTotal: 10.4 }, purchase: { items: [] } }))
            .toEqual({ mode: 'sale', lines: 1, total: 10 });
        expect(autoSaveSummary({ mode: 'purchase', items: [{ total: 100.5 }, { total: 20 }] }))
            .toEqual({ mode: 'purchase', lines: 2, total: 121 });
        expect(autoSaveSummary(null)).toEqual({ mode: 'purchase', lines: 0, total: 0 });
    });

    test('nextBillNumberHint: highest of today + 1, other days and device numbers ignored', () => {
        const now = new Date(2026, 10, 1, 9);
        expect(nextBillNumberHint('S', [], now)).toBe('S20261101-001');
        expect(nextBillNumberHint('S', [{ billNumber: 'S20261101-012' }, { billNumber: 'S20261101-002' },
            { billNumber: 'S20261101-K7P-030' }, { billNumber: 'P20261101-040' }, {}], now)).toBe('S20261101-013');
    });
});
