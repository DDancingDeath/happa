/**
 * @fileoverview Money paths that create records (#61): new purchase save
 * (items × rate, labour, payment split), new retail sale save, recording a due
 * payment from the Outstanding screen, Finance profit/outstanding and the
 * cash drawer's expected balance.
 *
 * Tests marked `test.skip` pin a known bug (see the referenced issue); unskip
 * them when that issue is fixed.
 */
import { PurchaseManager } from '../modules/purchase.js';
import { RetailSaleManager } from '../modules/retail-sale.js';
import { OutstandingManager } from '../modules/outstanding.js';
import { FinanceManager } from '../modules/finance.js';
import { CashManagementManager } from '../modules/cash-management.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { AppState } from '../utils/state.js';
import { readPayment, NAME_REQUIRED_FOR_DUE_KEY, KEPT_SERVER_PAYMENT_KEY } from '../utils/money.js';
import { t } from '../i18n/index.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';
import { sampleItems } from '../../../tests/fixtures/sample-items.js';

const PURCHASE_DOM = `
  <select id="billItem"><option value=""></option><option value="0">Rice</option><option value="1">Wheat</option></select>
  <input id="billRate"><input id="newWeight"><div id="weightsList"></div>
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
  <input id="saleRate"><input id="saleWeight"><div id="saleWeightsList"></div>
  <table id="saleTable"><tbody></tbody></table>
  <span id="saleTotal">0</span><span id="amountReceivable">0</span><span id="totalReceived">0</span>
  <input id="saleOnlinePayment"><input id="saleCashPayment"><input id="saleDueAmount">
  <input id="saleCustomerName"><input id="saleComments"><input type="checkbox" id="salePrintComments">
  <button id="completeSaleBtn"></button><div id="toast"></div>`;

const setVal = (id, v) => { document.getElementById(id).value = String(v); };

let toast;
beforeEach(() => {
    toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(Helpers, 'generateBillNumber').mockImplementation(async (prefix) => `${prefix}20261021-001`);
    jest.spyOn(AuditService, 'log').mockResolvedValue(undefined);
    AppState.items = sampleItems();
    AppState.stock = {};
    AppState.settings = { laborRate: 6, heavyWeightThreshold: 30 };
    AppState.currentUser = { uid: 'u1', email: 'o@x' };
    AppState.userName = 'Owner';
});

afterEach(() => {
    jest.restoreAllMocks();
    PurchaseManager.setBillItems([]);
    PurchaseManager.setWeights([]);
    PurchaseManager.setPendingBill(null);
    RetailSaleManager.setPendingBill(null);
    RetailSaleManager.setSaleItems([]);
    RetailSaleManager.setSaleWeights([]);
});

describe('new purchase save', () => {
    let savePurchase;
    beforeEach(() => {
        document.body.innerHTML = PURCHASE_DOM;
        savePurchase = jest.spyOn(FirebaseService, 'savePurchase').mockResolvedValue(undefined);
    });

    async function addLine(index, rate, weights) {
        setVal('billItem', index);
        setVal('billRate', rate);
        PurchaseManager.setWeights(weights);
        await PurchaseManager.addToBill();
    }

    /** Rice 40+20 kg @ 25.5 = 1530, Wheat 35 kg @ 30 = 1050; 2 packets > 30 kg → labour 2 × ₹6. */
    async function buildBill() {
        await addLine(0, 25.5, [40, 20]);
        await addLine(1, 30, [35]);
    }

    test('Hindi item names: the bill line keeps the catalogue name + itemId, Hindi only on screen (#143)', async () => {
        AppState.settings.showHindi = true;
        await addLine(0, 25.5, [40]);
        expect(PurchaseManager.getBillItems()[0]).toMatchObject({ itemId: 'item-rice', name: 'Rice' });
        expect(document.querySelector('#billTable tbody td').textContent).toBe('चावल');
    });

    test('items × rate, auto labour and grand total are computed from the lines', async () => {
        await buildBill();
        expect(document.getElementById('billTotal').textContent).toBe('2580');
        expect(document.getElementById('totalPacketsInBill').textContent).toBe('3');
        expect(document.getElementById('manualLaborCharges').value).toBe('12');
        expect(document.getElementById('laborCalculation').textContent).toBe('6 × 2');
        expect(document.getElementById('amountPayable').textContent).toBe('2568');
    });

    test('saves a split payment with payment.due equal to dueAmount', async () => {
        await buildBill();
        setVal('cashPayment', 1000);
        setVal('onlinePayment', 500);
        setVal('dueAmount', 1068);
        setVal('customerName', 'Ramesh');

        const bill = await PurchaseManager.saveBillToHistory();

        expect(savePurchase).toHaveBeenCalledTimes(1);
        const saved = savePurchase.mock.calls[0][0];
        expect(saved).toBe(bill);
        expect(saved).toMatchObject({
            billNumber: 'P20261021-001', type: 'purchase', isPurchase: true,
            billTotal: 2580, laborCharges: 12, totalPackets: 3,
            grandTotal: 2568, amountPayable: 2568,
            cashPayment: 1000, onlinePayment: 500, dueAmount: 1068,
            customerName: 'Ramesh',
            payment: { cash: 1000, online: 500, due: 1068, total: 2568 }
        });
        expect(saved.items.map(i => [i.itemId, i.qty, i.total])).toEqual([['item-rice', 60, 1530], ['item-wheat', 35, 1050]]);
        expect(saved.payment.due).toBe(saved.dueAmount);
        expect(readPayment(saved)).toEqual({ total: 2568, cash: 1000, online: 500, due: 1068, paid: 1500 });
        // The editor is cleared after a successful save
        expect(PurchaseManager.getBillItems()).toEqual([]);
    });

    test('labour can be switched off: grand total equals the item total', async () => {
        document.getElementById('autoLaborCharge').checked = false;
        await buildBill();
        setVal('cashPayment', 2580);
        const saved = await PurchaseManager.saveBillToHistory();
        expect(saved).toMatchObject({ billTotal: 2580, laborCharges: 0, grandTotal: 2580 });
    });

    test('the shared labour rate is used; blank or invalid falls back to ₹6 (#20)', async () => {
        AppState.settings.laborRate = 8; // shared value from settings/app
        await buildBill();
        expect(document.getElementById('manualLaborCharges').value).toBe('16');
        expect(document.getElementById('laborCalculation').textContent).toBe('8 × 2');
        expect(document.getElementById('amountPayable').textContent).toBe('2564');

        for (const bad of ['', 'abc', 0, -3, null]) {
            AppState.settings.laborRate = bad;
            PurchaseManager.renderBill();
            expect(document.getElementById('manualLaborCharges').value).toBe('12');
        }
    });

    test('with Labour unticked no labour is charged, whatever the rate (#20)', async () => {
        AppState.settings.laborRate = 8;
        document.getElementById('autoLaborCharge').checked = false;
        await buildBill();
        expect(document.getElementById('manualLaborCharges').value).toBe('0');
        expect(document.getElementById('amountPayable').textContent).toBe('2580');
    });

    test('refuses a purchase with Due but no supplier name; fully paid saves without one (#68)', async () => {
        await buildBill();
        setVal('dueAmount', 2568);
        expect(await PurchaseManager.saveBillToHistory()).toBeUndefined();
        expect(savePurchase).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith(t(NAME_REQUIRED_FOR_DUE_KEY));

        setVal('dueAmount', 0);
        setVal('cashPayment', 2568);
        expect(await PurchaseManager.saveBillToHistory()).toMatchObject({ customerName: '', dueAmount: 0 });
        expect(savePurchase).toHaveBeenCalledTimes(1);
    });

    test('refuses to save without any payment', async () => {
        await buildBill();
        expect(await PurchaseManager.saveBillToHistory()).toBeUndefined();
        expect(savePurchase).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith(expect.stringContaining('at least one payment method'));
    });

    test('refuses to save when cash + online + due does not equal the grand total (#23)', async () => {
        await buildBill();
        setVal('cashPayment', 100);
        expect(await PurchaseManager.saveBillToHistory()).toBeUndefined();
        expect(savePurchase).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith(expect.stringContaining('₹2,468 less than the bill total'));
        expect(document.getElementById('purchaseSplitRemaining').textContent).toBe('₹2,468 left');

        setVal('cashPayment', 3000);
        expect(await PurchaseManager.saveBillToHistory()).toBeUndefined();
        expect(toast).toHaveBeenCalledWith(expect.stringContaining('₹432 more than the bill total'));
        expect(savePurchase).not.toHaveBeenCalled();
    });

    test('"Rest → Due" fills only the unpaid part; within ₹1 of the total saves (#23)', async () => {
        await buildBill();
        setVal('cashPayment', 1000);
        setVal('customerName', 'Ramesh');
        PurchaseManager.putRestInDue();
        expect(document.getElementById('dueAmount').value).toBe('1568');
        expect(document.getElementById('purchaseSplitRemaining').textContent).toBe('✓ ₹0');
        setVal('dueAmount', 1567.5);
        expect(await PurchaseManager.saveBillToHistory()).toMatchObject({ cashPayment: 1000, dueAmount: 1567.5, payment: { due: 1567.5 } });
    });

    test('saved totals come from the items even if the on-screen total is stale', async () => {
        await buildBill();
        document.getElementById('billTotal').textContent = '9999';
        document.getElementById('amountPayable').textContent = '9999';
        setVal('cashPayment', 2568);
        const saved = await PurchaseManager.saveBillToHistory();
        expect(saved).toMatchObject({ billTotal: 2580, grandTotal: 2568 });
    });

    test('a double tap saves only one bill', async () => {
        await buildBill();
        setVal('cashPayment', 2568);
        let release;
        savePurchase.mockImplementation(() => new Promise(r => { release = r; }));
        const first = PurchaseManager.saveBillToHistory();
        const second = PurchaseManager.saveBillToHistory();
        await Promise.resolve();
        await Promise.resolve();
        release();
        await Promise.all([first, second]);
        expect(savePurchase).toHaveBeenCalledTimes(1);
        expect(await second).toBeUndefined();
    });

    test('a retry after a timeout writes the same bill id and number again — one bill (#70)', async () => {
        await buildBill();
        setVal('cashPayment', 2568);
        savePurchase.mockRejectedValueOnce(new Error('Timed out'));
        await expect(PurchaseManager.saveBillToHistory()).rejects.toThrow('Timed out');
        const saved = await PurchaseManager.saveBillToHistory();
        expect(savePurchase).toHaveBeenCalledTimes(2);
        const [first, second] = savePurchase.mock.calls;
        expect(second[0].id).toBe(first[0].id);
        expect(second[0].billNumber).toBe(first[0].billNumber);
        expect(first[1]).toEqual({ retry: false });
        expect(second[1]).toEqual({ retry: true });
        // Same time as the first attempt, so an unchanged retry is identical on the server
        expect(second[0].timestamp).toBe(first[0].timestamp);
        expect(second[0].date).toBe(first[0].date);
        expect(Helpers.generateBillNumber).toHaveBeenCalledTimes(1);
        expect(saved.id).toBe(first[0].id);
        // The next bill gets a new id
        await buildBill();
        setVal('cashPayment', 2568);
        expect((await PurchaseManager.saveBillToHistory()).id).not.toBe(saved.id);
    });

    test('a retry that kept a payment recorded elsewhere says so (#70)', async () => {
        await buildBill();
        setVal('cashPayment', 2568);
        savePurchase.mockRejectedValueOnce(new Error('Timed out'));
        await expect(PurchaseManager.saveBillToHistory()).rejects.toThrow('Timed out');
        jest.spyOn(FirebaseService, 'keptServerPayment').mockReturnValue(true);
        await PurchaseManager.saveBillToHistory();
        expect(toast).toHaveBeenCalledWith(t(KEPT_SERVER_PAYMENT_KEY));
    });

    test('a bill restored from auto-save/draft keeps its id (#70)', async () => {
        PurchaseManager.setPendingBill({ id: 'restored-1', billNumber: 'P20261021-007' });
        await buildBill();
        setVal('cashPayment', 2568);
        expect(await PurchaseManager.saveBillToHistory()).toMatchObject({ id: 'restored-1', billNumber: 'P20261021-007' });
        expect(Helpers.generateBillNumber).not.toHaveBeenCalled();
        expect(PurchaseManager.getPendingBill()).toBeNull();
    });

    test('a failed write keeps the bill in the editor', async () => {
        await buildBill();
        setVal('cashPayment', 2568);
        savePurchase.mockRejectedValue(new Error('quota'));
        await expect(PurchaseManager.saveBillToHistory()).rejects.toThrow('quota');
        expect(PurchaseManager.getBillItems()).toHaveLength(2);
        expect(toast).toHaveBeenCalledWith('Failed to save bill: quota');
    });
});

describe('new retail sale save', () => {
    let saveRetailSale;
    beforeEach(() => {
        document.body.innerHTML = SALE_DOM;
        saveRetailSale = jest.spyOn(FirebaseService, 'saveRetailSale').mockResolvedValue(undefined);
        // Enough stock so the oversell confirmation does not appear
        AppState.stock = { 'item-rice': { quantity: 500 }, 'item-wheat': { quantity: 500 } };
    });

    async function addLine(index, rate, weights) {
        setVal('saleItem', index);
        setVal('saleRate', rate);
        RetailSaleManager.setSaleWeights(weights);
        await RetailSaleManager.addToSalesBill();
    }

    test('Hindi item names: the sale line keeps the catalogue name + itemId (#143)', async () => {
        AppState.settings.showHindi = true;
        await addLine(1, 30, [10]);
        expect(RetailSaleManager.getSaleItems()[0]).toMatchObject({ itemId: 'item-wheat', name: 'Wheat' });
        expect(document.querySelector('#saleTable tbody td').textContent).toBe('गेहूं');
    });

    test('saves item totals and a cash + due split; payment.due equals dueAmount', async () => {
        await addLine(0, 36, [12.5]);     // 450
        await addLine(1, 28.75, [9, 3]);  // 345
        expect(document.getElementById('saleTotal').textContent).toBe('795');
        setVal('saleCashPayment', 300);
        setVal('saleDueAmount', 495);
        setVal('saleCustomerName', 'Sita');

        const sale = await RetailSaleManager.completeSale();

        expect(saveRetailSale).toHaveBeenCalledTimes(1);
        expect(sale).toMatchObject({
            billNumber: 'S20261021-001', type: 'retail', isPurchase: false,
            total: 795, totalPackets: 3, cashPayment: 300, onlinePayment: 0, dueAmount: 495,
            customerName: 'Sita',
            payment: { cash: 300, online: 0, due: 495, total: 795 }
        });
        expect(sale.items.map(i => [i.itemId, i.qty, i.total])).toEqual([['item-rice', 12.5, 450], ['item-wheat', 12, 345]]);
        expect(readPayment(sale).due).toBe(sale.dueAmount);
    });

    test('asks before overselling and cancels when declined', async () => {
        AppState.stock = { 'item-rice': { quantity: 5 } };
        const modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(false);
        await addLine(0, 36, [10]);
        setVal('saleCashPayment', 360);
        expect(await RetailSaleManager.completeSale()).toBeUndefined();
        expect(modal).toHaveBeenCalledWith(expect.stringContaining('Rice: selling 10.0 kg, only 5.0 kg'), 'Check before saving', true);
        expect(saveRetailSale).not.toHaveBeenCalled();
    });

    test('retry after a failed save: the bill already in history/stock is not counted twice (no false oversell)', async () => {
        AppState.stock = { 'item-rice': { quantity: 50 } };
        AppState.retailSalesHistory = [];
        const modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        // First attempt reaches local history (and the listener deducts it) but the save then fails
        saveRetailSale.mockImplementationOnce(async (sale) => {
            AppState.retailSalesHistory.unshift(sale);
            AppState.stock = { 'item-rice': { quantity: 20 } };
            throw new Error('timeout');
        });
        await addLine(0, 36, [30]);
        setVal('saleCashPayment', 1080);
        await expect(RetailSaleManager.completeSale()).rejects.toThrow('timeout');

        const sale = await RetailSaleManager.completeSale();
        expect(modal).not.toHaveBeenCalled();
        expect(saveRetailSale).toHaveBeenCalledTimes(2);
        expect(sale.flags).toBeUndefined();
        AppState.retailSalesHistory = [];
    });

    test('retail oversell far beyond the limit still only warns (#33: retail reduces stock, no block limit); accepted warning saved as a flag (#37)', async () => {
        AppState.stock = { 'item-rice': { quantity: 1 } };
        jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        await addLine(0, 36, [10]);
        setVal('saleCashPayment', 360);
        const sale = await RetailSaleManager.completeSale();
        expect(saveRetailSale).toHaveBeenCalledTimes(1);
        expect(sale.flags).toEqual([expect.objectContaining({ rule: 'oversell' })]);
        expect(sale.overrides).toBeUndefined();
    });

    test('refuses a credit sale without a customer name (#68)', async () => {
        await addLine(0, 36, [10]);
        setVal('saleDueAmount', 360);
        setVal('saleCustomerName', '   ');
        expect(await RetailSaleManager.completeSale()).toBeUndefined();
        expect(saveRetailSale).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith(t(NAME_REQUIRED_FOR_DUE_KEY));
    });

    test('a fully paid walk-in sale still saves without a name (#68)', async () => {
        await addLine(0, 36, [10]);
        setVal('saleCashPayment', 360);
        expect(await RetailSaleManager.completeSale()).toMatchObject({ customerName: '', dueAmount: 0 });
        expect(saveRetailSale).toHaveBeenCalledTimes(1);
    });

    test('refuses a sale whose payment split does not add up (#23)', async () => {
        await addLine(0, 36, [10]);
        setVal('saleCashPayment', 100);
        expect(await RetailSaleManager.completeSale()).toBeUndefined();
        expect(saveRetailSale).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith(expect.stringContaining('₹260 less than the bill total'));
    });
});

describe('recording a due payment (Outstanding)', () => {
    let fake;
    beforeEach(() => {
        fake = createFakeFirestore();
        jest.spyOn(FirebaseService, 'db', 'get').mockReturnValue(fake.db);
        window.getCollection = (n) => n;
        jest.spyOn(OutstandingManager, 'renderDue').mockImplementation(() => {});
        jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
        document.body.innerHTML = '<input id="payment_r1"><input id="payment_p1"><div id="toast"></div>';
    });
    afterEach(() => {
        delete window.getCollection;
        AppState.retailSalesHistory = [];
        AppState.purchaseHistory = [];
    });

    const RETAIL = {
        id: 'r1', billNumber: 'S1', customerName: 'Sita', total: 795,
        cashPayment: 300, onlinePayment: 0, dueAmount: 495,
        payment: { cash: 300, online: 0, due: 495, total: 795 }
    };

    test('a partial payment updates payment.due and the top-level dueAmount together', async () => {
        fake.seed('retailSales', [RETAIL]);
        AppState.retailSalesHistory = [{ ...RETAIL }];
        setVal('payment_r1', 200);

        await OutstandingManager.recordPayment('r1', 'retail');

        const doc = fake.raw('retailSales').get('r1');
        expect(doc.payment).toEqual({ cash: 500, online: 0, due: 295, total: 500 });
        expect(doc.dueAmount).toBe(295);
        expect(doc.payments).toEqual([expect.objectContaining({ amount: 200, recordedBy: 'Owner' })]);
        expect(doc.openDue).toBe(true);
        expect(AppState.retailSalesHistory[0].dueAmount).toBe(295);
        expect(toast).toHaveBeenCalledWith('✓ Payment of ₹200 recorded');
    });

    test('a double tap on Record saves one payment; a retried payment id is not added twice (#70)', async () => {
        fake.seed('retailSales', [RETAIL]);
        AppState.retailSalesHistory = [{ ...RETAIL }];
        setVal('payment_r1', 100);
        await Promise.all([
            OutstandingManager.recordPayment('r1', 'retail'),
            OutstandingManager.recordPayment('r1', 'retail')
        ]);
        let doc = fake.raw('retailSales').get('r1');
        expect(doc.payments).toHaveLength(1);
        expect(doc.payment.due).toBe(395);

        // The server already has this entry (the first attempt committed but the phone saw a timeout)
        const entry = doc.payments[0];
        await OutstandingManager.applyPaymentTransaction('retail', { id: 'r1' }, 100, { ...entry });
        doc = fake.raw('retailSales').get('r1');
        expect(doc.payments).toHaveLength(1);
        expect(doc.payment.due).toBe(395);
        expect(doc.dueAmount).toBe(395);
    });

    test('a full payment clears the due on both fields and closes openDue', async () => {
        fake.seed('retailSales', [RETAIL]);
        AppState.retailSalesHistory = [{ ...RETAIL }];
        setVal('payment_r1', 495);
        await OutstandingManager.recordPayment('r1', 'retail');
        const doc = fake.raw('retailSales').get('r1');
        expect(doc.payment.due).toBe(0);
        expect(doc.dueAmount).toBe(0);
        expect(doc.openDue).toBe(false);
    });

    test('rejects more than the local due without writing', async () => {
        fake.seed('retailSales', [RETAIL]);
        AppState.retailSalesHistory = [{ ...RETAIL }];
        setVal('payment_r1', 496);
        await OutstandingManager.recordPayment('r1', 'retail');
        expect(fake.stats.writes).toBe(0);
        expect(toast).toHaveBeenCalledWith('Payment amount exceeds outstanding amount');
    });

    test('two phones paying the same bill: the second payment builds on the first', async () => {
        // Phone A already recorded ₹400; this phone still shows the old due of ₹495
        fake.seed('retailSales', [{
            ...RETAIL, dueAmount: 95,
            payment: { cash: 700, online: 0, due: 95, total: 700 },
            payments: [{ amount: 400, recordedBy: 'Staff' }]
        }]);
        AppState.retailSalesHistory = [{ ...RETAIL }];

        setVal('payment_r1', 200);
        await OutstandingManager.recordPayment('r1', 'retail');
        expect(toast).toHaveBeenCalledWith('Payment amount exceeds outstanding amount (₹95)');
        expect(fake.raw('retailSales').get('r1').payment.due).toBe(95);

        setVal('payment_r1', 95);
        await OutstandingManager.recordPayment('r1', 'retail');
        const doc = fake.raw('retailSales').get('r1');
        expect(doc.payment).toEqual({ cash: 795, online: 0, due: 0, total: 795 });
        expect(doc.payments.map(p => p.amount)).toEqual([400, 95]);
    });

    test('legacy purchase with only top-level fields: payment object is created, dueAmount kept in sync', async () => {
        const legacy = { id: 'p1', billNumber: 'P1', grandTotal: 1000, cashPayment: 400, dueAmount: 600 };
        fake.seed('purchases', [legacy]);
        AppState.purchaseHistory = [{ ...legacy }];
        setVal('payment_p1', 600);
        await OutstandingManager.recordPayment('p1', 'purchase');
        const doc = fake.raw('purchases').get('p1');
        expect(doc.payment).toEqual({ online: 0, cash: 1000, due: 0, total: 1000 });
        expect(doc.dueAmount).toBe(0);
    });
});

describe('Finance profit and outstanding (fixed dataset, all time)', () => {
    beforeEach(() => {
        AppState.historyLoadedFrom = 0;
        FinanceManager.currentDateFilter = 'all';
        AppState.salesHistory = [
            { id: 'w1', date: '2026-10-01T10:00:00', total: 5000, payment: { cash: 3000, online: 0, due: 2000 } }
        ];
        AppState.retailSalesHistory = [
            { id: 'r1', date: '02/10/2026', total: 795, cashPayment: 300, dueAmount: 495, payment: { cash: 300, online: 0, due: 495 } },
            { id: 'r2', date: '2026-10-03T10:00:00', total: 205, cleared: true, payment: { cash: 0, online: 0, due: 205 } }
        ];
        AppState.purchaseHistory = [
            { id: 'p1', date: '2026-09-30T09:00:00', billTotal: 2580, laborCharges: 12, grandTotal: 2568, payment: { cash: 1500, online: 0, due: 1068 } }
        ];
        AppState.expensesHistory = [
            { id: 'e1', date: '2026-10-01', amount: 150, category: 'business' },
            { id: 'e2', date: '2026-10-02', amount: 80, category: 'personal' }
        ];
        AppState.withdrawalsHistory = [{ id: 'x1', date: '2026-10-02', amount: 1000 }];
        document.body.innerHTML = `
          <div id="financeDashboardSection">
            <span id="financeNetProfit"></span><span id="financeRevenue"></span><span id="financeCogs"></span>
            <span id="financeBusinessExp"></span><span id="financePersonalExp"></span>
            <span id="financeTotalWithdrawn"></span><span id="financeAvailableBalance"></span>
          </div>`;
    });
    afterEach(() => {
        ['salesHistory', 'retailSalesHistory', 'purchaseHistory', 'expensesHistory', 'withdrawalsHistory'].forEach(k => { AppState[k] = []; });
    });

    test('dashboard (#215): profit = sales − cost of goods sold − business expenses; personal and withdrawals below it', () => {
        jest.spyOn(FinanceManager, 'renderMonthlyChart').mockImplementation(() => {});
        jest.spyOn(FinanceManager, 'renderProfitBreakdown').mockImplementation(() => {});
        FinanceManager.renderDashboard();
        const text = (id) => document.getElementById(id).textContent;
        // No item lines, so nothing to cost: 6000 − 0 − 150; unsold purchases are stock, not a loss
        expect(text('financeRevenue')).toBe('₹6,000');
        expect(text('financeCogs')).toBe('₹0');
        expect(text('financeNetProfit')).toBe('₹5,850');
        expect(text('financePersonalExp')).toBe('₹80');
        expect(text('financeTotalWithdrawn')).toBe('₹1,000');
        // 5850 − 80 personal − 1000 withdrawn
        expect(text('financeAvailableBalance')).toBe('₹4,770');
    });

    test('outstanding: receivable from wholesale + retail (cleared excluded), payable from purchases', () => {
        expect(FinanceManager.calculateOutstanding()).toEqual({ dueToReceive: 2495, dueToPay: 1068 });
    });

    test('business balance = all-time revenue − costs − withdrawals', () => {
        expect(FinanceManager.calculateBusinessBalance()).toBe(6000 - 2568 - 230 - 1000);
    });
});

describe('cash drawer expected balance', () => {
    const DAY = '2026-10-21';
    beforeEach(() => {
        AppState.salesHistory = [{ id: 'w1', date: '2026-10-21T11:00:00', cashPayment: 1000, payment: { cash: 1000 } }];
        AppState.retailSalesHistory = [
            { id: 'r1', date: '21/10/2026', cashPayment: 300, payment: { cash: 300 } },
            { id: 'r2', date: '2026-10-20T23:30:00', cashPayment: 999, payment: { cash: 999 } } // yesterday
        ];
        AppState.purchaseHistory = [{ id: 'p1', date: '2026-10-21T09:00:00', cashPayment: 1500, payment: { cash: 1500 } }];
        AppState.expensesHistory = [
            { id: 'e1', date: '2026-10-21', amount: 150, category: 'business' },
            { id: 'e2', date: '2026-10-21', amount: 80, category: 'personal' }
        ];
    });
    afterEach(() => {
        ['salesHistory', 'retailSalesHistory', 'purchaseHistory', 'expensesHistory'].forEach(k => { AppState[k] = []; });
        CashManagementManager.todaySession = null;
    });

    const session = {
        date: DAY, openingBalance: 2000,
        duePayments: [
            { method: 'cash', type: 'received', amount: 250 },
            { method: 'online', type: 'received', amount: 999 },
            { method: 'cash', type: 'paid', amount: 100 }
        ],
        cashDeposits: [{ amount: 500 }]
    };

    test('per-day cash movements only count that local day', () => {
        expect(CashManagementManager.calculateTransactionsForDate(DAY, session)).toEqual({
            cashSales: 1300, cashPurchases: 1500, businessExpenses: 150, personalExpenses: 80,
            dueReceived: 250, duePaid: 100, cashDeposits: 500
        });
    });

    test('expected = opening + sales − purchases − expenses + due received − due paid + deposits', () => {
        CashManagementManager.todaySession = session;
        CashManagementManager.todayTransactions = CashManagementManager.calculateTransactionsForDate(DAY, session);
        expect(CashManagementManager.calculateExpectedCash()).toBe(2000 + 1300 - 1500 - 150 - 80 + 250 - 100 + 500);
    });

    test('no open session → expected 0', () => {
        CashManagementManager.todaySession = null;
        expect(CashManagementManager.calculateExpectedCash()).toBe(0);
    });

    // #98: payment.cash (raised by a due collected later) wins over the stale top-level cashPayment.
    test('a due collected in cash today raises the expected drawer balance', () => {
        AppState.retailSalesHistory = [{ id: 'r1', date: '21/10/2026', cashPayment: 300, dueAmount: 0, payment: { cash: 795, due: 0 } }];
        AppState.salesHistory = [];
        AppState.purchaseHistory = [];
        AppState.expensesHistory = [];
        const t = CashManagementManager.calculateTransactionsForDate(DAY, { duePayments: [] });
        expect(t.cashSales + t.dueReceived).toBe(795);
    });
});
