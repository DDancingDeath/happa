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
    deleteAutoSave: jest.fn().mockResolvedValue(undefined),
    saveDraft: jest.fn().mockResolvedValue(undefined),
    countDrafts: jest.fn().mockResolvedValue(0)
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
    BillDrafts.saveDraft.mockClear();
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

    test('nothing typed: auto-save keeps the unsaved bill; typing a new one moves it to Drafts first', async () => {
        BillDrafts.getAutoSave.mockResolvedValue(saved);
        await BillingManager.checkAutoSave();
        await BillingManager.autoSaveToCloud();
        expect(BillDrafts.deleteAutoSave).not.toHaveBeenCalled();
        expect(BillingManager.pendingRecovery).not.toBeNull();

        PurchaseManager.setBillItems([{ name: 'Maize', qty: 1, rate: 1, total: 1 }]);
        await BillingManager.autoSaveToCloud();
        expect(BillDrafts.saveDraft).toHaveBeenCalledTimes(1);
        expect(BillDrafts.saveDraft.mock.calls[0][0]).toMatchObject({
            userId: 'u1', mode: 'purchase', billTotal: 1250, items: saved.purchase.items
        });
        expect(BillDrafts.saveDraft.mock.invocationCallOrder[0]).toBeLessThan(BillDrafts.saveAutoSave.mock.invocationCallOrder[0]);
        expect(BillDrafts.saveAutoSave.mock.calls[0][1].purchase.items.map(i => i.name)).toEqual(['Maize']);
        expect(document.getElementById('autoSaveBanner').hidden).toBe(true);
        expect(BillingManager.pendingRecovery).toBeNull();
    });

    test('saving or clearing a bill before picking also keeps it in Drafts', async () => {
        BillDrafts.getAutoSave.mockResolvedValue(saved);
        await BillingManager.checkAutoSave();
        await BillingManager.deleteAutoSave();
        expect(BillDrafts.saveDraft).toHaveBeenCalledTimes(1);
        expect(BillDrafts.saveDraft.mock.invocationCallOrder[0]).toBeLessThan(BillDrafts.deleteAutoSave.mock.invocationCallOrder[0]);
        expect(UIManager.showToast).not.toHaveBeenCalled();
    });

    test('an unfinished edit of a saved bill never becomes a draft (it would save as a second bill)', async () => {
        BillDrafts.getAutoSave.mockResolvedValue({ ...saved, editingBillId: 'p9' });
        await BillingManager.checkAutoSave();
        PurchaseManager.setBillItems([{ name: 'Maize', qty: 1, rate: 1, total: 1 }]);
        await BillingManager.autoSaveToCloud();
        expect(BillDrafts.saveDraft).not.toHaveBeenCalled();
        BillingManager.editingBillIndex = 0;
        BillingManager.editingBillId = 'p1';
        await BillingManager.autoSaveToCloud();
        expect(BillDrafts.saveAutoSave.mock.calls.at(-1)[1].editingBillId).toBe('p1');
    });

    test('Restore never replaces a bill on screen or one opened for editing', async () => {
        BillDrafts.getAutoSave.mockResolvedValue(saved);
        await BillingManager.checkAutoSave();
        PurchaseManager.setBillItems([{ name: 'Maize', qty: 1, rate: 1, total: 1 }]);
        await BillingManager.resolveRecovery(true);
        expect(PurchaseManager.getBillItems().map(i => i.name)).toEqual(['Maize']);
        expect(UIManager.showToast).toHaveBeenCalledWith(expect.stringMatching(/Save or clear/), 'warning');
        PurchaseManager.setBillItems([]);
        BillingManager.editingBillIndex = 0;
        await BillingManager.resolveRecovery(true);
        expect(BillingManager.pendingRecovery).not.toBeNull();
        expect(document.getElementById('autoSaveBanner').hidden).toBe(false);
    });

    test("another user's banner is dropped, never restored or kept as their draft", async () => {
        BillDrafts.getAutoSave.mockResolvedValue(saved);
        await BillingManager.checkAutoSave();
        AppState.currentUser = { uid: 'u2' };
        PurchaseManager.setBillItems([{ name: 'Maize', qty: 1, rate: 1, total: 1 }]);
        await BillingManager.autoSaveToCloud();
        expect(BillDrafts.saveDraft).not.toHaveBeenCalled();
        expect(BillingManager.pendingRecovery).toBeNull();
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
        AppState.retailSalesHistory = [{ id: 'r1', billNumber: 'S20261020-002' }, { id: 'r2' }];
        BillingManager.editingBillIndex = 0;
        BillingManager.editingBillId = 'r1';
        BillingManager.editingBillType = 'retail';
        RetailSaleManager.renderSalesBill();
        expect(document.getElementById('saleBillNo').textContent).toBe('Bill no.: S20261020-002');
        expect(document.getElementById('purchaseBillNo').textContent).toBe(`Next bill no. (given on save): P${day}-001`);
        BillingManager.editingBillIndex = 1;
        BillingManager.editingBillId = 'r2';
        RetailSaleManager.renderSalesBill();
        expect(document.getElementById('saleBillNo').textContent).toBe('');
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

describe('archived items (#123)', () => {
    test('the item pickers leave archived items out; editing a line of one adds it back', () => {
        AppState.settings = { ...(AppState.settings || {}), showHindi: false };
        AppState.items = [{ id: 'a', name: 'Rice', rates: [10] }, { id: 'b', name: 'Old Dal', archived: true, rates: [5] }];
        BillingManager.loadItemsDropdown();
        BillingManager.loadSaleItemsDropdown();
        const names = (id) => [...document.getElementById(id).options].map(o => o.textContent);
        expect(names('billItem')).toEqual(['Rice']);
        expect(names('saleItem')).toEqual(['Rice']);
        BillingManager.ensureItemOption('billItem', 1);
        BillingManager.ensureItemOption('billItem', 1);
        expect(names('billItem')).toEqual(['Rice', 'Old Dal']);
        // A picker rebuild (another phone saved a bill) keeps the archived line selected
        document.getElementById('billItem').value = '1';
        BillingManager.loadItemsDropdown();
        expect(document.getElementById('billItem').value).toBe('1');
        expect(names('billItem')).toEqual(['Rice', 'Old Dal']);
        document.getElementById('billItem').value = '0';
        BillingManager.loadItemsDropdown();
        expect(names('billItem')).toEqual(['Rice']);
    });

    test('adding a line of an archived item ends with the archived warning, not "added"', async () => {
        AppState.settings = { ...(AppState.settings || {}), showHindi: false };
        AppState.items = [{ id: 'a', name: 'Rice', rates: [10] }, { id: 'b', name: 'Old Dal', archived: true, rates: [5] }];
        BillingManager.loadItemsDropdown();
        BillingManager.ensureItemOption('billItem', 1);
        document.getElementById('billItem').value = '1';
        document.getElementById('billRate').value = '5';
        document.getElementById('newWeight').value = '20';
        await PurchaseManager.addToBill();
        expect(PurchaseManager.getBillItems().map(i => i.itemId)).toEqual(['b']);
        expect(UIManager.showToast.mock.calls.at(-1)[0]).toMatch(/"Old Dal" is archived/);
    });
});
