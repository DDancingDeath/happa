/**
 * @fileoverview Characterisation of the three bill forms (purchase, retail,
 * wholesale) before their maths moves to utils/calc/billing.js
 * (docs/architecture.md §5, plan step 2f). Each test drives the form the way the
 * page does and pins what the screen shows, the saved bill document and the
 * payment split, rounding included. Recorded against the code before the move
 * (step 2f: whole-rupee lines, paise totals). Re-recorded for #129 (owner
 * decision: rates keep paise, every money amount is a whole rupee, half-up):
 * totals, labour, payments, Rest → Due, wholesale cost / profit / expenses are
 * now whole rupees; each changed value says so where it is pinned.
 */
jest.mock('../utils/bill-share.js', () => {
    const actual = jest.requireActual('../utils/bill-share.js');
    return { ...actual, buildDraftShareText: jest.fn(actual.buildDraftShareText) };
});

import { PurchaseManager } from '../modules/purchase.js';
import { RetailSaleManager } from '../modules/retail-sale.js';
import { WholesaleSalesManager } from '../modules/wholesale-sales.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
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
  <input type="checkbox" id="autoLaborCharge" checked><input id="manualLaborCharges" value="0"><span id="laborCalculation"></span>
  <span id="amountPayable">0</span><span id="totalPayment">0</span>
  <input id="onlinePayment"><input id="cashPayment"><input id="dueAmount"><strong id="purchaseSplitRemaining"></strong>
  <input type="checkbox" id="onlineCheckbox"><input type="checkbox" id="cashCheckbox"><input type="checkbox" id="dueCheckbox">
  <input id="customerName"><input id="billComments"><input type="checkbox" id="billPrintComments">
  <button id="saveBillBtn"></button><button id="printBillBtn"></button><div id="toast"></div>`;

const SALE_DOM = `
  <select id="saleItem"><option value=""></option><option value="0">Rice</option><option value="1">Wheat</option></select>
  <input id="saleRate"><input id="saleWeight"><div id="saleWeightsDisplay"></div>
  <span id="saleRunningTotal">0</span><span id="salePacketCount">0</span>
  <table id="saleTable"><tbody></tbody></table><div id="saleWeightBreakdownSection"></div>
  <span id="saleTotal">0</span><span id="totalSalePacketsInBill">0</span><span id="amountReceivable">0</span><span id="totalReceived">0</span>
  <input id="saleOnlinePayment"><input id="saleCashPayment"><input id="saleDueAmount"><strong id="saleSplitRemaining"></strong>
  <input type="checkbox" id="saleOnlineCheckbox"><input type="checkbox" id="saleCashCheckbox"><input type="checkbox" id="saleDueCheckbox">
  <input id="saleCustomerName"><input id="saleComments"><input type="checkbox" id="salePrintComments">
  <button id="saveSaleBtn"></button><button id="printSaleBtn"></button><div id="toast"></div>`;

const WHOLESALE_DOM = `
  <select id="sellItem"><option value=""></option><option value="Rice">Rice</option><option value="Wheat">Wheat</option><option value="Maize">Maize</option></select>
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
  <button onclick="window.app.wholesaleSales.completeSale()"></button>
  <div id="salesRecentList"></div><div id="salesHistoryList"></div><div id="salesOutstandingList"></div><div id="toast"></div>`;

const $ = (id) => document.getElementById(id);
const text = (id) => $(id).textContent;
const setVal = (id, v) => { $(id).value = String(v); };
const tick = (id) => { $(id).checked = true; };
const rows = (selector) => [...document.querySelectorAll(`${selector} tbody tr`)]
    .map(tr => [...tr.querySelectorAll('td')].slice(0, 4).map(td => td.textContent.trim()));
const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k]]));

/** Money fields of a saved bill document that the move must not change. */
const PURCHASE_KEYS = ['billTotal', 'laborCharges', 'laborCalc', 'totalPackets', 'grandTotal', 'amountPayable',
    'onlinePayment', 'cashPayment', 'dueAmount', 'payment', 'type', 'isPurchase', 'customerName'];
const RETAIL_KEYS = ['total', 'totalPackets', 'onlinePayment', 'cashPayment', 'dueAmount', 'payment', 'type', 'isPurchase', 'customerName'];
const WHOLESALE_KEYS = ['total', 'expenses', 'profit', 'profitPercent', 'onlinePayment', 'cashPayment', 'dueAmount', 'payment',
    'type', 'source', 'customerName', 'comments'];
const lineKeys = (items) => items.map(i => pick(i, Object.keys(i).filter(k => k !== 'timestamp')));

let toast;
beforeEach(() => {
    toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
    jest.spyOn(UIManager, 'showLoading').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hideLoading').mockImplementation(() => {});
    jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(Helpers, 'generateBillNumber').mockImplementation(async (prefix) => `${prefix}20261031-001`);
    jest.spyOn(AuditService, 'log').mockResolvedValue(undefined);
    jest.spyOn(window, 'open').mockImplementation(() => null);
    buildDraftShareText.mockClear();
    AppState.items = sampleItems();
    AppState.stock = {};
    AppState.stockReady = true;
    AppState.stockApprox = null;
    AppState.settings = { laborRate: 6, heavyWeightThreshold: 30 };
    AppState.currentUser = { uid: 'u1', email: 'o@x' };
    AppState.userName = 'Owner';
    AppState.userRole = 'owner';
    AppState.salesHistory = [];
    AppState.purchaseHistory = [];
    AppState.retailSalesHistory = [];
    window.app = { outstanding: { renderDue: jest.fn() } };
});

afterEach(() => {
    jest.restoreAllMocks();
    PurchaseManager.setBillItems([]);
    PurchaseManager.setWeights([]);
    PurchaseManager.setPendingBill(null);
    RetailSaleManager.setPendingBill(null);
    RetailSaleManager.setSaleItems([]);
    RetailSaleManager.setSaleWeights([]);
    WholesaleSalesManager.setItems([]);
});

describe('purchase form', () => {
    let savePurchase;
    beforeEach(() => {
        document.body.innerHTML = PURCHASE_DOM;
        savePurchase = jest.spyOn(FirebaseService, 'savePurchase').mockResolvedValue(undefined);
    });

    /** Rice 40 + 20.3 kg @ ₹25.50 (typed one by one), Wheat 12.4 kg @ ₹33.50 (left in the box). */
    async function buildBill() {
        setVal('billItem', 0);
        setVal('billRate', 25.5);
        setVal('newWeight', 40);
        await PurchaseManager.addWeight();
        setVal('newWeight', 20.3);
        await PurchaseManager.addWeight();
        expect([text('totalWeights'), text('totalPackets')]).toEqual(['60.3', '2']);
        expect([...document.querySelectorAll('#weightsDisplay .weight-chip span')].map(s => s.textContent)).toEqual(['40.0', '20.3']);
        await PurchaseManager.addToBill();
        setVal('billItem', 1);
        setVal('billRate', 33.5);
        setVal('newWeight', 12.4);
        await PurchaseManager.addToBill();
    }

    test('line weights, line amounts (whole rupees), bill total, auto labour and payable', async () => {
        await buildBill();
        expect(lineKeys(PurchaseManager.getBillItems())).toEqual([
            { itemId: 'item-rice', name: 'Rice', rate: 25.5, qty: 60.3, total: 1538, weights: [40, 20.3] },
            { itemId: 'item-wheat', name: 'Wheat', rate: 33.5, qty: 12.4, total: 415, weights: [12.4] }
        ]);
        expect(rows('#billTable')).toEqual([
            ['Rice', '₹25.50', '60.3 kg', '₹1538'],
            ['Wheat', '₹33.50', '12.4 kg', '₹415']
        ]);
        expect($('weightBreakdownSection').textContent.replace(/\s+/g, ' ').trim()).toBe('Rice (2 packets, 60.3 kg) 40.0 20.3');
        expect([text('totalWeights'), text('totalPackets')]).toEqual(['0', '0']);
        expect(text('billTotal')).toBe('1953');
        expect(text('totalPacketsInBill')).toBe('3');
        expect($('manualLaborCharges').value).toBe('6');
        expect(text('laborCalculation')).toBe('6 × 1');
        expect(text('amountPayable')).toBe('1947');
        expect(text('totalPayment')).toBe('0');
        expect(text('purchaseSplitRemaining')).toBe('₹1,947 left');
        expect(PurchaseManager.computeTotals()).toEqual({ billTotal: 1953, laborCharges: 6, grandTotal: 1947, totalPackets: 3, heavyPackets: 1 });
        expect(PurchaseManager.getCheckDraft()).toMatchObject({ kind: 'purchase', total: 1947, payment: { cash: 0, online: 0, due: 0 } });
    });

    test('paise labour typed by hand is saved rounded half-up (₹12.50 → ₹13): screen, Cash tick and saved total agree (#129)', async () => {
        await buildBill();
        setVal('manualLaborCharges', '12.50');
        $('manualLaborCharges').dataset.manuallySet = 'true';
        PurchaseManager.updateTotals();
        expect($('manualLaborCharges').value).toBe('12.50');
        // #129: was 1941 (1953 − 12.50 = 1940.50 shown half-up) while 1940.50 was saved
        expect(text('amountPayable')).toBe('1940');
        tick('cashCheckbox');
        PurchaseManager.fillPayableAmount('cash');
        expect([$('cashPayment').value, $('onlinePayment').value, $('dueAmount').value]).toEqual(['1940', '0', '0']);
        expect(text('totalPayment')).toBe('1940');
        expect(text('purchaseSplitRemaining')).toBe('✓ ₹0');

        const bill = await PurchaseManager.saveBillToHistory();

        expect(savePurchase).toHaveBeenCalledTimes(1);
        expect(pick(bill, PURCHASE_KEYS)).toEqual({
            // #129: was laborCharges 12.5, grandTotal / amountPayable 1940.5, cash 1941
            billTotal: 1953, laborCharges: 13, laborCalc: null, totalPackets: 3,
            grandTotal: 1940, amountPayable: 1940,
            onlinePayment: 0, cashPayment: 1940, dueAmount: 0,
            payment: { online: 0, cash: 1940, due: 0, total: 1940 },
            type: 'purchase', isPurchase: true, customerName: ''
        });
        expect(lineKeys(bill.items).map(l => [l.qty, l.total])).toEqual([[60.3, 1538], [12.4, 415]]);
        expect([text('billTotal'), text('amountPayable'), $('manualLaborCharges').value]).toEqual(['0', '0', '0']);
    });

    test('auto labour at a paise rate: the box gets whole rupees and the working is saved', async () => {
        AppState.settings.laborRate = 6.25;
        setVal('billItem', 0);
        setVal('billRate', 20);
        PurchaseManager.setWeights([31, 45.5, 30]);
        await PurchaseManager.addToBill();
        expect(text('billTotal')).toBe('2130');
        expect($('manualLaborCharges').value).toBe('13');
        expect(text('laborCalculation')).toBe('6.25 × 2');
        expect(text('amountPayable')).toBe('2117');
        setVal('cashPayment', 2000);
        setVal('customerName', 'Ramesh');
        PurchaseManager.putRestInDue();
        expect([$('dueAmount').value, $('dueCheckbox').checked]).toEqual(['117', true]);
        const bill = await PurchaseManager.saveBillToHistory();
        expect(pick(bill, PURCHASE_KEYS)).toEqual({
            billTotal: 2130, laborCharges: 13, laborCalc: '6.25 × 2', totalPackets: 3,
            grandTotal: 2117, amountPayable: 2117,
            onlinePayment: 0, cashPayment: 2000, dueAmount: 117,
            payment: { online: 0, cash: 2000, due: 117, total: 2117 },
            type: 'purchase', isPurchase: true, customerName: 'Ramesh'
        });
    });

    test('split payment: Online / Due ticks, Rest → Due with paise labour, overpaid rest', async () => {
        await buildBill();
        tick('onlineCheckbox');
        PurchaseManager.fillPayableAmount('online');
        expect([$('onlinePayment').value, $('cashPayment').value, $('dueAmount').value]).toEqual(['1947', '0', '0']);
        tick('dueCheckbox');
        PurchaseManager.fillPayableAmount('due');
        expect([$('onlinePayment').value, $('cashPayment').value, $('dueAmount').value]).toEqual(['0', '0', '1947']);
        expect([$('onlineCheckbox').checked, $('cashCheckbox').checked]).toEqual([false, false]);
        expect(text('totalPayment')).toBe('0');

        setVal('manualLaborCharges', '7.25');
        $('manualLaborCharges').dataset.manuallySet = 'true';
        PurchaseManager.updateTotals();
        expect(text('amountPayable')).toBe('1946');
        setVal('cashPayment', 1000.4);
        setVal('onlinePayment', 500.35);
        setVal('dueAmount', '');
        PurchaseManager.putRestInDue();
        // #129: cash ₹1,000.40 → ₹1,000 and online ₹500.35 → ₹500 as saved, labour ₹7.25 → ₹7,
        // so the rest is 1946 − 1500 = 446 (was 445 in paise) and paid shows 1500 (was 1501)
        expect([$('dueAmount').value, $('dueCheckbox').checked]).toEqual(['446', true]);
        expect(text('totalPayment')).toBe('1500');
        expect(text('purchaseSplitRemaining')).toBe('✓ ₹0');

        setVal('customerName', 'Ramesh');
        const bill = await PurchaseManager.saveBillToHistory();
        expect(pick(bill, PURCHASE_KEYS)).toMatchObject({
            billTotal: 1953, laborCharges: 7, grandTotal: 1946, amountPayable: 1946,
            onlinePayment: 500, cashPayment: 1000, dueAmount: 446,
            payment: { online: 500, cash: 1000, due: 446, total: 1946 }
        });

        await buildBill();
        setVal('cashPayment', 2000);
        PurchaseManager.putRestInDue();
        expect(toast).toHaveBeenLastCalledWith('Cash + Online + Due is ₹53 more than the bill total. Reduce it by ₹53.');
        PurchaseManager.updatePaymentTotal();
        expect(text('purchaseSplitRemaining')).toBe('₹53 extra');
    });

    test('Labour unticked: no labour, payable is the bill total', async () => {
        $('autoLaborCharge').checked = false;
        await buildBill();
        expect([$('manualLaborCharges').value, $('manualLaborCharges').disabled, text('laborCalculation')]).toEqual(['0', true, '']);
        expect(text('amountPayable')).toBe('1953');
        expect(PurchaseManager.computeTotals()).toMatchObject({ laborCharges: 0, grandTotal: 1953 });
    });

    test('WhatsApp text: plain line sum and the labour as saved (whole rupees, half-up)', async () => {
        await buildBill();
        setVal('manualLaborCharges', '12.75');
        await PurchaseManager.shareWhatsApp();
        // #129: was 12 (the box cut to an integer) while the bill saved 12.75
        expect(buildDraftShareText).toHaveBeenCalledWith(expect.objectContaining({ kind: 'purchase', total: 1953, labour: 13 }));
    });
});

describe('retail sale form', () => {
    let saveRetailSale;
    beforeEach(() => {
        document.body.innerHTML = SALE_DOM;
        saveRetailSale = jest.spyOn(FirebaseService, 'saveRetailSale').mockResolvedValue(undefined);
        AppState.stock = { 'item-rice': { quantity: 500, rate: 30 }, 'item-wheat': { quantity: 500, rate: 24 } };
    });

    /** Rice 25.5 + 24.7 (added) + 10.15 (left in the box) kg @ ₹41.75; Wheat 7 kg @ ₹33.33. */
    async function buildSale() {
        setVal('saleWeight', 25.5);
        await RetailSaleManager.addSaleWeight();
        setVal('saleWeight', 24.7);
        await RetailSaleManager.addSaleWeight();
        expect([text('saleRunningTotal'), text('salePacketCount')]).toEqual(['50.2', '2']);
        setVal('saleWeight', 10.15);
        setVal('saleItem', 0);
        setVal('saleRate', 41.75);
        await RetailSaleManager.addToSalesBill();
        setVal('saleItem', 1);
        setVal('saleRate', 33.33);
        setVal('saleWeight', 7);
        await RetailSaleManager.addToSalesBill();
    }

    test('line weights, packets, amounts (whole rupees), totals and running kg', async () => {
        await buildSale();
        expect(lineKeys(RetailSaleManager.getSaleItems())).toEqual([
            { itemId: 'item-rice', name: 'Rice', rate: 41.75, qty: 60.35, packets: 3, weights: [25.5, 24.7, 10.15], total: 2520 },
            { itemId: 'item-wheat', name: 'Wheat', rate: 33.33, qty: 7, packets: 1, weights: [7], total: 233 }
        ]);
        expect(rows('#saleTable')).toEqual([
            ['Rice', '₹41.75', '60.4 kg', '₹2520'],
            ['Wheat', '₹33.33', '7.0 kg', '₹233']
        ]);
        expect($('saleWeightBreakdownSection').textContent.replace(/\s+/g, ' ').trim()).toBe('Rice (3 packets, 60.4 kg) 25.5 24.7 10.2');
        expect(text('saleTotal')).toBe('2753');
        expect(text('amountReceivable')).toBe('2753');
        expect(text('totalSalePacketsInBill')).toBe('4');
        expect([text('saleRunningTotal'), text('salePacketCount')]).toEqual(['0', '0']);
        RetailSaleManager.renderSalesBill();
        expect([text('saleRunningTotal'), text('salePacketCount')]).toEqual(['67.3', '2']);
        expect(text('totalReceived')).toBe('0');
        expect(text('saleSplitRemaining')).toBe('₹2,753 left');
        expect(RetailSaleManager.getCheckDraft()).toMatchObject({ kind: 'retail', total: 2753 });
    });

    test('split payment: ticks, Rest → Due, save', async () => {
        await buildSale();
        tick('saleOnlineCheckbox');
        RetailSaleManager.fillReceivableAmount('online');
        expect([$('saleOnlinePayment').value, $('saleCashPayment').value, $('saleDueAmount').value]).toEqual(['2753', '0', '0']);
        expect(text('totalReceived')).toBe('2753');
        tick('saleCashCheckbox');
        RetailSaleManager.fillReceivableAmount('cash');
        expect([$('saleOnlinePayment').value, $('saleCashPayment').value, $('saleOnlineCheckbox').checked]).toEqual(['0', '2753', false]);
        tick('saleDueCheckbox');
        RetailSaleManager.fillReceivableAmount('due');
        expect([$('saleCashPayment').value, $('saleDueAmount').value, $('saleCashCheckbox').checked]).toEqual(['0', '2753', false]);

        setVal('saleCashPayment', 1000.5);
        setVal('saleOnlinePayment', 999.25);
        setVal('saleDueAmount', '');
        RetailSaleManager.putRestInDue();
        // #129: cash ₹1,000.50 → ₹1,001, online ₹999.25 → ₹999, rest 753 (was 753.25)
        expect([$('saleDueAmount').value, $('saleDueCheckbox').checked]).toEqual(['753', true]);
        expect(text('totalReceived')).toBe('2000');
        expect(text('saleSplitRemaining')).toBe('✓ ₹0');
        setVal('saleCustomerName', 'Sita');

        const sale = await RetailSaleManager.completeSale();

        expect(saveRetailSale).toHaveBeenCalledTimes(1);
        expect(pick(sale, RETAIL_KEYS)).toEqual({
            total: 2753, totalPackets: 4, onlinePayment: 999, cashPayment: 1001, dueAmount: 753,
            payment: { online: 999, cash: 1001, due: 753, total: 2753 },
            type: 'retail', isPurchase: false, customerName: 'Sita'
        });
        expect(lineKeys(sale.items).map(l => [l.qty, l.packets, l.total])).toEqual([[60.35, 3, 2520], [7, 1, 233]]);
        expect([text('saleTotal'), text('totalReceived')]).toEqual(['0', '0']);
    });

    test('paise line totals (a draft or bill from before #129): screen, tick and saved total are whole rupees', async () => {
        RetailSaleManager.setSaleItems([
            { itemId: 'item-rice', name: 'Rice', rate: 40.1, qty: 2.504, total: 100.4 },
            { itemId: 'item-wheat', name: 'Wheat', rate: 30.1, qty: 1.671, packets: 2, total: 50.3 }
        ]);
        RetailSaleManager.renderSalesBill();
        expect([text('saleTotal'), text('amountReceivable'), text('totalSalePacketsInBill')]).toEqual(['151', '151', '3']);
        tick('saleCashCheckbox');
        RetailSaleManager.fillReceivableAmount('cash');
        expect($('saleCashPayment').value).toBe('151');
        expect(text('saleSplitRemaining')).toBe('✓ ₹0');
        const sale = await RetailSaleManager.completeSale();
        expect(pick(sale, RETAIL_KEYS)).toMatchObject({
            // #129: was 150.7
            total: 151, totalPackets: 2, cashPayment: 151, payment: { online: 0, cash: 151, due: 0, total: 151 }
        });
    });

    test('Rest → Due when more is received than the total', async () => {
        await buildSale();
        setVal('saleCashPayment', 3000);
        RetailSaleManager.putRestInDue();
        expect(toast).toHaveBeenLastCalledWith('Cash + Online + Due is ₹247 more than the bill total. Reduce it by ₹247.');
        expect($('saleDueAmount').value).toBe('');
    });

    test('editing a line puts its weights back (even split when only kg and packets are known)', () => {
        RetailSaleManager.setSaleItems([
            { itemId: 'item-rice', name: 'Rice', rate: 40, qty: 50, packets: 2, total: 2000 },
            { itemId: 'item-wheat', name: 'Wheat', rate: 30, qty: 9, packets: 2, weights: [4, 5], total: 270 },
            { itemId: 'item-rice', name: 'Rice', rate: 40, qty: 7.5, total: 300 }
        ]);
        RetailSaleManager.editSaleItem(0);
        expect(RetailSaleManager.getSaleWeights()).toEqual([25, 25]);
        RetailSaleManager.setSaleWeights([]);
        RetailSaleManager.editSaleItem(0);
        expect(RetailSaleManager.getSaleWeights()).toEqual([4, 5]);
        RetailSaleManager.setSaleWeights([]);
        RetailSaleManager.editSaleItem(0);
        expect(RetailSaleManager.getSaleWeights()).toEqual([7.5]);
        expect([text('saleRunningTotal'), text('salePacketCount')]).toEqual(['7.5', '1']);
    });

    test('WhatsApp text: plain line sum', async () => {
        await buildSale();
        await RetailSaleManager.shareSaleWhatsApp();
        expect(buildDraftShareText).toHaveBeenCalledWith(expect.objectContaining({ kind: 'retail', total: 2753 }));
    });
});

describe('wholesale sale form', () => {
    let saveWholesaleSale;
    beforeEach(() => {
        document.body.innerHTML = WHOLESALE_DOM;
        saveWholesaleSale = jest.spyOn(FirebaseService, 'saveWholesaleSale').mockResolvedValue(undefined);
        // Both average costs known; tests that need an unknown cost (#102) remove Wheat's rate.
        AppState.stock = { 'item-rice': { quantity: 500, rate: 22.4 }, 'item-wheat': { quantity: 300, rate: 30 } };
    });

    async function addLine(name, rate, qty) {
        setVal('sellItem', name);
        setVal('sellRate', rate);
        setVal('sellQuantity', qty);
        await WholesaleSalesManager.addToWholesaleBill();
    }

    /** Rice 12.4 kg @ ₹33.50 (cost ₹22.40), Wheat 7.25 kg @ ₹40.10 (cost ₹30), ₹20.50 expenses. */
    async function buildSale() {
        await addLine('Rice', 33.5, 12.4);
        await addLine('Wheat', 40.1, 7.25);
        setVal('salesExpensesAmount', 20.5);
        WholesaleSalesManager.updateProfitCalculation();
    }

    test('line amounts (whole rupees), total, live profit and margin with an unknown cost', async () => {
        await addLine('Rice', 33.5, 12.4);
        // #129: cost 12.4 × ₹22.40 = 277.76 → ₹278, so profit 137 and 137 ÷ 415 = 33.0% (was 137.24, 33.1%)
        expect([text('salesTotalAmount'), text('salesProfitAmount'), text('salesProfitPercent')]).toEqual(['415', '137', '33.0']);
        await addLine('Wheat', 40.1, 7.25);
        expect(lineKeys(WholesaleSalesManager.getItems())).toEqual([
            { itemId: 'item-rice', name: 'Rice', rate: 33.5, qty: 12.4, total: 415 },
            { itemId: 'item-wheat', name: 'Wheat', rate: 40.1, qty: 7.25, total: 291 }
        ]);
        expect(rows('#salesTable')).toEqual([
            ['Rice', '₹33.50', '12.4 kg', '₹415'],
            ['Wheat', '₹40.10', '7.3 kg', '₹291']
        ]);
        // #129 whole rupees: cost 277.76 + 217.50 = 495.26 → 495; expenses ₹20.50 count as saved, ₹21
        expect([text('salesTotalAmount'), text('salesProfitAmount'), text('salesProfitPercent')]).toEqual(['706', '211', '29.9']);
        setVal('salesExpensesAmount', 20.5);
        WholesaleSalesManager.updateProfitCalculation();
        expect([text('salesProfitAmount'), text('salesProfitPercent')]).toEqual(['190', '26.9']);
        expect(WholesaleSalesManager.computeTotals()).toEqual({ total: 706, cost: 495, profit: 190, profitPercent: 26.9, unknownCost: [] });
        // #102: Wheat's cost not known → no profit (it used to count Wheat at cost ₹0: 407, 57.6 %)
        delete AppState.stock['item-wheat'].rate;
        WholesaleSalesManager.updateProfitCalculation();
        expect([text('salesProfitAmount'), text('salesProfitPercent')]).toEqual(['—', '—']);
        expect(WholesaleSalesManager.computeTotals()).toEqual({ total: 706, cost: 278, profit: null, profitPercent: null, unknownCost: [1] });
        expect(text('wholesaleSplitRemaining')).toBe('₹706 left');
        expect(WholesaleSalesManager.getCheckDraft()).toMatchObject({ kind: 'wholesale', total: 706 });
    });

    test('no line with a known cost: no profit (it used to be the total less expenses, #102)', () => {
        WholesaleSalesManager.setItems([
            { itemId: 'item-maize', name: 'Maize', rate: 25.4, qty: 9.9, total: 251 },
            { name: 'Loose', rate: 10, qty: 3, total: 30.4 }
        ]);
        setVal('salesExpensesAmount', 1.25);
        WholesaleSalesManager.renderWholesaleBill();
        expect([text('salesTotalAmount'), text('salesProfitAmount'), text('salesProfitPercent')]).toEqual(['281', '—', '—']);
        expect(WholesaleSalesManager.computeTotals()).toEqual({ total: 281, cost: 0, profit: null, profitPercent: null, unknownCost: [0, 1] });
    });

    test('a loss shows a negative profit and margin; no lines resets the figures', async () => {
        await addLine('Rice', 20.15, 3.3);
        setVal('salesExpensesAmount', 10);
        WholesaleSalesManager.updateProfitCalculation();
        // #129: cost 73.92 → ₹74, profit −18 → −18 ÷ 66 = −27.3% (was −17.92, −27.2%)
        expect([text('salesTotalAmount'), text('salesProfitAmount'), text('salesProfitPercent')]).toEqual(['66', '-18', '-27.3']);
        WholesaleSalesManager.removeWholesaleItem(0);
        expect([text('salesTotalAmount'), $('salesExpensesAmount').value, text('salesProfitAmount'), text('salesProfitPercent')])
            .toEqual(['0', '0', '0', '0']);
    });

    test('split payment: ticks, Rest → Due, save with profit and expenses', async () => {
        await buildSale();
        tick('wholesaleCashCheckbox');
        WholesaleSalesManager.fillReceivableAmount('cash');
        expect([$('wholesaleOnlinePayment').value, $('wholesaleCashPayment').value, $('wholesaleDueAmount').value]).toEqual(['0', '706', '0']);
        expect(text('wholesaleTotalReceived')).toBe('706');
        tick('wholesaleOnlineCheckbox');
        WholesaleSalesManager.fillReceivableAmount('online');
        expect([$('wholesaleOnlinePayment').value, $('wholesaleCashPayment').value, $('wholesaleCashCheckbox').checked]).toEqual(['706', '0', false]);

        setVal('wholesaleOnlinePayment', 100.25);
        setVal('wholesaleCashPayment', 300);
        setVal('wholesaleDueAmount', '');
        WholesaleSalesManager.putRestInDue();
        // #129: online ₹100.25 → ₹100, rest 306 (was 305.75)
        expect([$('wholesaleDueAmount').value, $('wholesaleDueCheckbox').checked]).toEqual(['306', true]);
        expect(text('wholesaleTotalReceived')).toBe('400');
        expect(text('wholesaleSplitRemaining')).toBe('✓ ₹0');
        setVal('wholesaleCustomerName', 'Mohan');
        setVal('salesComments', 'truck 2');

        const sale = await WholesaleSalesManager.completeSale();

        expect(saveWholesaleSale).toHaveBeenCalledTimes(1);
        expect(pick(sale, WHOLESALE_KEYS)).toEqual({
            // #129: was expenses 20.5, online 100.25, due 305.75
            total: 706, expenses: 21, profit: 190, profitPercent: 26.9,
            onlinePayment: 100, cashPayment: 300, dueAmount: 306,
            payment: { online: 100, cash: 300, due: 306, total: 706 },
            type: 'wholesale', source: 'sales-tab', customerName: 'Mohan', comments: 'truck 2'
        });
        expect(sale.items).toEqual([
            { itemId: 'item-rice', name: 'Rice', rate: 33.5, quantity: 12.4, total: 415 },
            { itemId: 'item-wheat', name: 'Wheat', rate: 40.1, quantity: 7.25, total: 291 }
        ]);
        expect([text('salesTotalAmount'), text('salesProfitAmount'), text('wholesaleTotalReceived')]).toEqual(['0', '0', '0']);
    });

    test('Rest → Due when more is received than the total', async () => {
        await buildSale();
        setVal('wholesaleCashPayment', 800);
        WholesaleSalesManager.putRestInDue();
        expect(toast).toHaveBeenLastCalledWith('Cash + Online + Due is ₹94 more than the bill total. Reduce it by ₹94.');
        WholesaleSalesManager.updatePaymentTotal();
        expect(text('wholesaleSplitRemaining')).toBe('₹94 extra');
    });

    test('WhatsApp text: plain line sum, expenses as saved (whole rupees, half-up), the profit shown', async () => {
        await buildSale();
        WholesaleSalesManager.shareViaWhatsApp();
        expect(buildDraftShareText).toHaveBeenCalledWith(expect.objectContaining({ kind: 'wholesale', total: 706, expenses: 21, profit: 190 }));
    });

    describe('with opening records (old-app dues) in the history', () => {
        const SALES = [
            { id: 'w1', billNumber: 'W-1', source: 'sales-tab', customerName: 'Mohan', date: '2026-10-30', timestamp: 2,
                total: 1000.5, items: [{ name: 'Rice', rate: 50, quantity: 20.01, total: 1000.5 }],
                payment: { cash: 400.25, online: 100, due: 500.25, total: 500.25 } },
            { id: 'opening-x', billNumber: 'W-OLD', source: 'sales-tab', customerName: 'Mohan', date: '2026-01-10', timestamp: 1,
                total: 0, items: [], payment: { cash: 0, online: 0, due: 2000 },
                openingBalance: { amount: 2000, billTotal: 3500.6, paidBefore: 1500.4 } }
        ];
        beforeEach(() => { AppState.salesHistory = JSON.parse(JSON.stringify(SALES)); });

        test('Wholesale › Outstanding: total, received and due of each open bill', () => {
            WholesaleSalesManager.renderSalesOutstanding();
            const cards = [...$('salesOutstandingList').querySelectorAll('.history-item')].map(c => c.textContent.replace(/\s+/g, ' ').trim());
            expect(cards).toHaveLength(2);
            expect(cards[0]).toContain('Due: ₹500');
            expect(cards[0]).toMatch(/Total Receivable:? ₹1001 .*Received:? ₹500 .*Outstanding:? ₹500/);
            expect(cards[1]).toContain('Due: ₹2000');
            expect(cards[1]).toContain('₹3501');
            expect(cards[1]).toContain('₹1500');
            expect(cards[1]).toMatch(/Total Receivable:? ₹2000 .*Received:? ₹0 .*Outstanding:? ₹2000/);
        });

        test('recent sales leave the opening record out; the form figures ignore the history', async () => {
            WholesaleSalesManager.renderRecentSales();
            expect($('salesRecentList').querySelectorAll('[data-bill-id], .history-item, .bill-row').length).toBeGreaterThan(0);
            expect($('salesRecentList').textContent).not.toContain('W-OLD');
            await buildSale();
            expect([text('salesTotalAmount'), text('salesProfitAmount'), text('salesProfitPercent')]).toEqual(['706', '190', '26.9']);
        });

        test('recording a due payment checks the amount against the bill\'s due', async () => {
            WholesaleSalesManager.renderSalesOutstanding();
            const apply = jest.fn();
            const { OutstandingManager } = await import('../modules/outstanding.js');
            jest.spyOn(OutstandingManager, 'applyPaymentTransaction').mockImplementation(async (kind, sale, amount) => { apply(amount); return {}; });
            setVal('payment_w1', 0);
            await WholesaleSalesManager.recordPayment('w1');
            expect(toast).toHaveBeenLastCalledWith('Please enter a valid payment amount');
            setVal('payment_w1', -5);
            await WholesaleSalesManager.recordPayment('w1');
            expect(toast).toHaveBeenLastCalledWith('Please enter a valid payment amount');
            setVal('payment_w1', 501);
            await WholesaleSalesManager.recordPayment('w1');
            expect(toast).toHaveBeenLastCalledWith('Payment amount exceeds outstanding amount');
            // #129: an amount that is not the due is saved in whole rupees (500.27 was refused as above the due)
            setVal('payment_w1', 500.27);
            await WholesaleSalesManager.recordPayment('w1');
            expect(apply).toHaveBeenLastCalledWith(500);
            // The exact due of a bill saved with paise (₹500.25, within a paisa) pays it off: only its paise remainder carries paise
            setVal('payment_w1', 500.26);
            await WholesaleSalesManager.recordPayment('w1');
            expect(apply).toHaveBeenLastCalledWith(500.25);
            setVal('payment_opening-x', 2000.004);
            await WholesaleSalesManager.recordPayment('opening-x');
            expect(apply).toHaveBeenLastCalledWith(2000);
        });
    });
});
