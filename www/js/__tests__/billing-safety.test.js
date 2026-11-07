/**
 * @fileoverview Billing safety (staff review S-1, S-10, S-12; dev review D-5):
 * a line typed but not added is never dropped on Save / Print (BF-PENDING); Billing
 * opened from the menu never switches back a mode tapped right after; Print without
 * a printer says "Not printed"; the bill-form WhatsApp share says it is an unsaved draft.
 */
import fs from 'fs';
import path from 'path';
import { PurchaseManager } from '../modules/purchase.js';
import { RetailSaleManager } from '../modules/retail-sale.js';
import { WholesaleSalesManager } from '../modules/wholesale-sales.js';
import { BillingManager } from '../modules/billing.js';
import { NavigationManager } from '../ui/navigation.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { PrinterService } from '../services/printer.js';
import { AuditService } from '../services/audit.js';
import { BillChecksUI } from '../ui/bill-highlight.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { AppState } from '../utils/state.js';
import { buildDraftShareText } from '../utils/bill-share.js';
import { sampleItems } from '../../../tests/fixtures/sample-items.js';

const PURCHASE_DOM = `
  <select id="billItem"><option value=""></option><option value="0">Rice</option><option value="1">Wheat</option></select>
  <input id="billRate"><input id="newWeight"><div id="weightsDisplay"></div>
  <span id="totalWeights">0</span><span id="totalPackets">0</span>
  <table id="billTable"><tbody></tbody></table><div id="weightBreakdownSection"></div>
  <span id="billTotal">0</span><span id="totalPacketsInBill">0</span>
  <input type="checkbox" id="autoLaborCharge"><input id="manualLaborCharges" value="0"><span id="laborCalculation"></span>
  <span id="amountPayable">0</span><span id="totalPayment">0</span>
  <input id="onlinePayment"><input id="cashPayment"><input id="dueAmount"><strong id="purchaseSplitRemaining"></strong>
  <input type="checkbox" id="onlineCheckbox"><input type="checkbox" id="cashCheckbox"><input type="checkbox" id="dueCheckbox">
  <input id="customerName"><input id="billComments"><input type="checkbox" id="billPrintComments">
  <button id="saveBillBtn"></button><button id="printBillBtn"></button>`;

const SALE_DOM = `
  <select id="saleItem"><option value=""></option><option value="0">Rice</option><option value="1">Wheat</option></select>
  <input id="saleRate"><input id="saleWeight"><div id="saleWeightsDisplay"></div>
  <span id="saleRunningTotal">0</span><span id="salePacketCount">0</span>
  <table id="saleTable"><tbody></tbody></table><div id="saleWeightBreakdownSection"></div>
  <span id="saleTotal">0</span><span id="totalSalePacketsInBill">0</span><span id="amountReceivable">0</span><span id="totalReceived">0</span>
  <input id="saleOnlinePayment"><input id="saleCashPayment"><input id="saleDueAmount"><strong id="saleSplitRemaining"></strong>
  <input type="checkbox" id="saleOnlineCheckbox"><input type="checkbox" id="saleCashCheckbox"><input type="checkbox" id="saleDueCheckbox">
  <input id="saleCustomerName"><input id="saleComments"><input type="checkbox" id="salePrintComments">
  <button id="saveSaleBtn"></button><button id="printSaleBtn"></button>`;

const WHOLESALE_DOM = `
  <select id="sellItem"><option value=""></option><option value="Rice">Rice</option><option value="Wheat">Wheat</option></select>
  <div id="wholesaleItemStats"><span id="availableStock">-</span><span id="availableStockUnit"></span>
  <div id="avgPurchaseRateRow"><span id="avgPurchaseRate">-</span></div></div><div id="availableStockApprox"></div>
  <input id="sellRate"><input id="sellQuantity">
  <table id="salesTable"><tbody></tbody></table>
  <span id="salesTotalAmount">0</span><input id="salesExpensesAmount" value="0">
  <span id="salesProfitAmount">0</span><span id="salesProfitPercent">0</span>
  <input id="wholesaleOnlinePayment"><input id="wholesaleCashPayment"><input id="wholesaleDueAmount">
  <strong id="wholesaleSplitRemaining"></strong><span id="wholesaleTotalReceived">0</span>
  <input type="checkbox" id="wholesaleOnlineCheckbox"><input type="checkbox" id="wholesaleCashCheckbox"><input type="checkbox" id="wholesaleDueCheckbox">
  <input id="wholesaleCustomerName"><input id="salesComments"><datalist id="wholesaleCustomerOptions"></datalist>
  <div id="salesRecentList"></div><div id="salesHistoryList"></div><div id="salesOutstandingList"></div>`;

const $ = (id) => document.getElementById(id);
const setVal = (id, v) => { $(id).value = String(v); };
const dialog = () => document.querySelector('.pending-line-dialog');
const toasts = () => UIManager.showToast.mock.calls.map(c => c[0]);

/** Waits for the "Line not added" dialog, answers it and returns its message. */
async function answer(choice) {
    for (let i = 0; i < 50 && !dialog(); i++) await new Promise(r => setTimeout(r, 0));
    expect(dialog()).not.toBeNull();
    const message = dialog().querySelector('#pendingLineMessage').textContent;
    dialog().querySelector(`[data-choice="${choice}"]`).click();
    return message;
}

beforeEach(() => {
    jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
    jest.spyOn(UIManager, 'showLoading').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hideLoading').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Helpers, 'generateBillNumber').mockImplementation(async (prefix) => `${prefix}20261108-001`);
    jest.spyOn(AuditService, 'log').mockResolvedValue(undefined);
    // Payment and the other bill checks are covered elsewhere: here every bill passes them
    jest.spyOn(BillChecksUI, 'confirmSave').mockResolvedValue({ ok: true, flags: [], overrides: [] });
    jest.spyOn(FirebaseService, 'savePurchase').mockImplementation(async (b) => b);
    jest.spyOn(FirebaseService, 'saveRetailSale').mockImplementation(async (b) => b);
    jest.spyOn(FirebaseService, 'saveWholesaleSale').mockImplementation(async (b) => b);
    AppState.items = sampleItems();
    AppState.stock = { 'item-rice': { quantity: 500, rate: 30 }, 'item-wheat': { quantity: 500, rate: 24 } };
    AppState.stockReady = true;
    AppState.stockApprox = null;
    AppState.settings = { laborRate: 6, heavyWeightThreshold: 30 };
    AppState.currentUser = { uid: 'u1', email: 'o@x' };
    AppState.userRole = 'owner';
    AppState.salesHistory = [];
    AppState.purchaseHistory = [];
    AppState.retailSalesHistory = [];
    window.app = { outstanding: { renderDue: jest.fn() } };
});

afterEach(() => {
    dialog()?.remove();
    jest.restoreAllMocks();
    PurchaseManager.setBillItems([]);
    PurchaseManager.setWeights([]);
    PurchaseManager.setPendingBill(null);
    RetailSaleManager.setSaleItems([]);
    RetailSaleManager.setSaleWeights([]);
    RetailSaleManager.setPendingBill(null);
    WholesaleSalesManager.setItems([]);
});

describe('purchase: a line typed but not added (S-1, BF-PENDING)', () => {
    beforeEach(async () => {
        document.body.innerHTML = PURCHASE_DOM;
        setVal('billItem', 0);
        setVal('billRate', 25);
        setVal('newWeight', 10);
        await PurchaseManager.addToBill(); // Rice 10 kg on the bill
        setVal('billItem', 1);
        setVal('billRate', 30);
        setVal('newWeight', 4); // Wheat 4 kg typed, not added
    });

    test('"Add this line and save" saves both lines', async () => {
        const saving = PurchaseManager.saveBillToHistory();
        expect(await answer('add')).toBe('Wheat 4 kg × ₹30.00 = ₹120 is typed but not on the bill.');
        const bill = await saving;
        expect(bill.items.map(i => [i.name, i.qty, i.total])).toEqual([['Rice', 10, 250], ['Wheat', 4, 120]]);
        expect(bill.billTotal).toBe(370);
    });

    test('"Discard line and save" saves the added lines only and empties the weight box', async () => {
        const saving = PurchaseManager.saveBillToHistory();
        await answer('discard');
        const bill = await saving;
        expect(bill.items.map(i => i.name)).toEqual(['Rice']);
        expect($('newWeight').value).toBe('');
        expect(PurchaseManager.getWeights()).toEqual([]);
    });

    test('Cancel saves nothing and keeps the typed line', async () => {
        const saving = PurchaseManager.saveBillToHistory();
        await answer('cancel');
        expect(await saving).toBeUndefined();
        expect(FirebaseService.savePurchase).not.toHaveBeenCalled();
        expect(dialog()).toBeNull();
        expect($('newWeight').value).toBe('4');
        expect(PurchaseManager.getBillItems()).toHaveLength(1);
    });

    test('Print with only a typed line asks too (it no longer says "no items")', async () => {
        PurchaseManager.setBillItems([]);
        jest.spyOn(PrinterService, 'printBill').mockResolvedValue(false);
        const printing = PurchaseManager.printBill();
        await answer('add');
        await printing;
        expect(FirebaseService.savePurchase).toHaveBeenCalledWith(expect.objectContaining({ billTotal: 120 }), expect.any(Object));
    });

    test('a half-typed line (no rate) is named and focused, and nothing is saved', async () => {
        setVal('billRate', '');
        expect(await PurchaseManager.saveBillToHistory()).toBeUndefined();
        expect(dialog()).toBeNull();
        expect(toasts()).toContain('Wheat is not on the bill yet: type its rate and tap Add to Bill, or clear it.');
        expect(document.activeElement.id).toBe('billRate');
        expect(FirebaseService.savePurchase).not.toHaveBeenCalled();
    });

    test('a weight of 0 counts as half-typed, never as an empty box', async () => {
        setVal('newWeight', 0);
        expect(await PurchaseManager.saveBillToHistory()).toBeUndefined();
        expect(document.activeElement.id).toBe('newWeight');
        expect(FirebaseService.savePurchase).not.toHaveBeenCalled();
    });

    test('the item and rate that stay after Add, with no weight, are not a line: saved at once', async () => {
        setVal('newWeight', '');
        const bill = await PurchaseManager.saveBillToHistory();
        expect(dialog()).toBeNull();
        expect(bill.items).toHaveLength(1);
    });
});

describe('retail sale: a line typed but not added (S-1)', () => {
    beforeEach(async () => {
        document.body.innerHTML = SALE_DOM;
        setVal('saleItem', 1);
        setVal('saleRate', 28);
        setVal('saleWeight', 2);
        await RetailSaleManager.addToSalesBill(); // Wheat 2 kg; Add empties the boxes
    });

    test('the staff case: Rice 4 kg @ ₹36 left in the boxes is added on "Add this line and save"', async () => {
        setVal('saleItem', 0);
        setVal('saleRate', 36);
        setVal('saleWeight', 4);
        const saving = RetailSaleManager.completeSale();
        expect(await answer('add')).toBe('Rice 4 kg × ₹36.00 = ₹144 is typed but not on the bill.');
        const sale = await saving;
        expect(sale.items.map(i => [i.name, i.qty])).toEqual([['Wheat', 2], ['Rice', 4]]);
        expect(sale.total).toBe(200);
    });

    test('discarding empties the item, rate and weight boxes', async () => {
        setVal('saleItem', 0);
        setVal('saleRate', 36);
        RetailSaleManager.setSaleWeights([4]);
        const saving = RetailSaleManager.completeSale();
        await answer('discard');
        expect((await saving).items).toHaveLength(1);
        expect([$('saleItem').value, $('saleRate').value, $('saleWeight').value]).toEqual(['', '', '']);
        expect(RetailSaleManager.getSaleWeights()).toEqual([]);
    });

    test('a weight with no rate is named; the sale waits', async () => {
        setVal('saleItem', 0);
        setVal('saleWeight', 4);
        expect(await RetailSaleManager.completeSale()).toBeUndefined();
        expect(toasts()).toContain('Rice is not on the bill yet: type its rate and tap Add to Bill, or clear it.');
        expect(document.activeElement.id).toBe('saleRate');
        expect(FirebaseService.saveRetailSale).not.toHaveBeenCalled();
    });

    test('the picker\'s item and its filled rate, with no weight, are not a line: saved without asking', async () => {
        setVal('saleItem', 0);
        setVal('saleRate', 36);
        expect((await RetailSaleManager.completeSale()).items).toHaveLength(1);
        expect(dialog()).toBeNull();
    });
});

describe('wholesale: a quantity typed but not added (S-1)', () => {
    beforeEach(async () => {
        document.body.innerHTML = WHOLESALE_DOM;
        setVal('sellItem', 'Rice');
        setVal('sellRate', 34);
        setVal('sellQuantity', 10);
        await WholesaleSalesManager.addToWholesaleBill(); // Rice 10 kg; item and rate stay
        setVal('sellQuantity', 5);
    });

    test('"Add this line and save" adds the 5 kg', async () => {
        const saving = WholesaleSalesManager.completeSale();
        expect(await answer('add')).toBe('Rice 5 kg × ₹34.00 = ₹170 is typed but not on the bill.');
        expect((await saving).items.map(i => i.quantity)).toEqual([10, 5]);
    });

    test('a line the stock check refuses is not added, and the sale is not saved', async () => {
        AppState.stock = { 'item-rice': { quantity: 4, rate: 30 } }; // 15 kg vs 4: beyond the 5 kg that only warns
        const saving = WholesaleSalesManager.completeSale();
        await answer('add');
        expect(await saving).toBeUndefined();
        expect(toasts()).toContain('Insufficient stock! Available: 4kg');
        expect(FirebaseService.saveWholesaleSale).not.toHaveBeenCalled();
    });

    test('discarding clears the quantity and saves the added line', async () => {
        const saving = WholesaleSalesManager.completeSale();
        await answer('discard');
        expect((await saving).items).toHaveLength(1);
        expect($('sellQuantity').value).toBe('');
    });
});

describe('Print with no printer (S-12)', () => {
    test('the service reports a picture shown, not a print', async () => {
        jest.spyOn(PrinterService, 'canPrint').mockReturnValue(false);
        jest.spyOn(PrinterService, 'showBillPreview').mockResolvedValue(true);
        const report = {};
        expect(await PrinterService.printBill({ billNumber: 'P-1', items: [] }, report)).toBe(true);
        expect(report.outcome).toBe('preview');
    });

    test.each([
        ['purchase', () => { document.body.innerHTML = PURCHASE_DOM; PurchaseManager.setBillItems([{ name: 'Rice', qty: 1, rate: 10, total: 10 }]); return PurchaseManager.printBill(); },
            'Bill saved successfully! · Not printed: no printer connected.', 'Bill saved and printed!'],
        ['retail', () => { document.body.innerHTML = SALE_DOM; RetailSaleManager.setSaleItems([{ name: 'Rice', qty: 1, rate: 10, total: 10 }]); return RetailSaleManager.printSale(); },
            'Sale completed successfully! · Not printed: no printer connected.', 'Sale saved and printed!'],
        ['wholesale', () => { document.body.innerHTML = WHOLESALE_DOM; WholesaleSalesManager.setItems([{ itemId: 'item-rice', name: 'Rice', qty: 1, rate: 10, total: 10 }]); return WholesaleSalesManager.printWholesaleSale(); },
            '✓ Sale completed successfully · Not printed: no printer connected.', 'Sale saved and printed!']
    ])('%s: "saved" and "not printed", never "saved and printed"', async (_kind, print, want, wrong) => {
        jest.spyOn(PrinterService, 'canPrint').mockReturnValue(false);
        jest.spyOn(PrinterService, 'showBillPreview').mockResolvedValue(true);
        await print();
        expect(toasts()).toContain(want);
        expect(toasts()).not.toContain(wrong);
    });

    test('a failed print says saved, and why it was not printed', async () => {
        document.body.innerHTML = PURCHASE_DOM;
        PurchaseManager.setBillItems([{ name: 'Rice', qty: 1, rate: 10, total: 10 }]);
        jest.spyOn(PrinterService, 'printBill').mockImplementation(async (bill, report) => {
            Object.assign(report, { outcome: 'failed', error: 'Printer not connected' });
            return false;
        });
        await PurchaseManager.printBill();
        expect(toasts()).toContain('Bill saved successfully! · Not printed: Printer not connected');
    });
});

describe('Billing mode (D-5)', () => {
    const DOM = `<div class="side-nav"><nav class="nav-menu"></nav></div><div class="overlay"></div>
        <div class="tab" id="billing">
          <button class="filter-btn active" id="purchaseModeBtn"></button><button class="filter-btn" id="saleModeBtn"></button>
          <div id="purchaseSection" style="display: block;"></div><div id="saleSection" style="display: none;"></div>
        </div><div class="tab" id="day"></div>`;

    beforeEach(() => {
        jest.useFakeTimers();
        document.body.innerHTML = DOM;
        window.app = { billing: { startFromNav: () => BillingManager.startFromNav() } };
        BillingManager.autoSaveEnabled = false;
        BillingManager.currentMode = 'purchase';
    });
    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        BillingManager.editingBillIndex = undefined;
    });

    test('opening Billing starts on Purchase at once; a Retail sale tap right after is kept', () => {
        BillingManager.switchMode('sale', { currentTarget: $('saleModeBtn') });
        NavigationManager.showTabFromNav('billing');
        expect(BillingManager.currentMode).toBe('purchase');
        BillingManager.switchMode('sale', { currentTarget: $('saleModeBtn') });
        jest.advanceTimersByTime(1000);
        expect(BillingManager.currentMode).toBe('sale');
        expect($('saleSection').style.display).toBe('block');
        expect($('saleModeBtn').classList.contains('active')).toBe(true);
    });

    test('a bill being edited keeps its mode when Billing is opened again', () => {
        BillingManager.switchMode('sale', { currentTarget: $('saleModeBtn') });
        BillingManager.editingBillIndex = 0;
        NavigationManager.showTabFromNav('billing');
        jest.advanceTimersByTime(1000);
        expect(BillingManager.currentMode).toBe('sale');
    });
});

describe('WhatsApp on the bill form shares a draft (S-10)', () => {
    test('the message says it is not saved', () => {
        const text = buildDraftShareText({ kind: 'retail', items: [{ name: 'Rice', rate: 36, qty: 4, total: 144 }], total: 144 });
        expect(text.split('\n')[0]).toBe('*Sale Bill* (DRAFT, not saved)');
    });

    test('every bill-form share button is labelled "Share draft (not saved)"', () => {
        const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'templates', f), 'utf8');
        const buttons = [read('billing.html'), read('wholesale-sales.html')].join('\n')
            .match(/<button data-onclick="(?:billing\.share\w+|wholesaleSales\.shareViaWhatsApp)\(\)"[\s\S]*?<\/button>/g);
        expect(buttons).toHaveLength(3);
        buttons.forEach(b => expect(b).toContain('<span data-i18n="ui.billing.share_draft">Share draft (not saved)</span>'));
    });
});
