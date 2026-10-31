/**
 * @fileoverview The wholesale screen's "Record" payment goes through the same
 * Firestore transaction as the Due screen (OutstandingManager.applyPaymentTransaction)
 * so a payment recorded concurrently on another device is never overwritten.
 */

jest.mock('../firebase/firestore-service.js', () => ({
    FirebaseService: {
        updateWholesaleSale: jest.fn(async () => {}),
        db: null,
        CLIENT_VERSION: 3,
        keptServerPayment: jest.fn(() => false),
        savedOnPhoneOnly: jest.fn(() => false),
        saveUnconfirmed: jest.fn(() => false),
        billHasOpenDue: jest.fn((coll, bill) => !bill.cleared && (bill.payment?.due || 0) > 0)
    }
}));
jest.mock('../services/printer.js', () => ({ PrinterService: {} }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(), ACTIONS: {} } }));
jest.mock('../ui/infinite-scroll.js', () => ({ attachOlderHistoryScroll: jest.fn() }));

import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { WholesaleSalesManager } from '../modules/wholesale-sales.js';
import { Helpers } from '../utils/helpers.js';
import { UIManager } from '../ui/ui-manager.js';
import { readPayment, NAME_REQUIRED_FOR_DUE_KEY } from '../utils/money.js';
import { t } from '../i18n/index.js';

beforeEach(() => {
    document.body.innerHTML = '<div id="salesOutstandingList"></div><div id="salesHistoryList"></div><div id="toast"></div>';
    window.app = { outstanding: { renderDue: jest.fn() } };
    AppState.salesHistory = [];
    AppState.currentUser = { uid: 'owner1', email: 'o@x' };
    AppState.userName = 'Owner';
});

describe('wholesale recordPayment uses the payment transaction', () => {
    function fakeDb(serverDoc) {
        const ref = { id: 's1' };
        const tx = {
            get: jest.fn(async () => ({ exists: true, data: () => serverDoc })),
            update: jest.fn()
        };
        return {
            tx,
            db: {
                collection: jest.fn(() => ({ doc: jest.fn(() => ref), where: jest.fn() })),
                runTransaction: jest.fn(async (fn) => fn(tx))
            }
        };
    }

    test('does not overwrite a payment recorded concurrently on another device', async () => {
        const local = {
            id: 's1', source: 'sales-tab', total: 100, billNumber: 'W-1',
            items: [{ name: 'Rice', rate: 10, qty: 10, total: 100 }],
            payment: { online: 0, cash: 20, due: 80, total: 20 },
            payments: [{ amount: 20 }]
        };
        // Server already has a second payment of 20 recorded elsewhere
        const server = {
            ...local,
            payment: { online: 0, cash: 40, due: 60, total: 40 },
            payments: [{ amount: 20 }, { amount: 20, recordedBy: 'Staff' }]
        };
        const { db, tx } = fakeDb(server);
        FirebaseService.db = db;
        AppState.salesHistory = [local];
        WholesaleSalesManager.renderSalesOutstanding();
        document.getElementById('payment_s1').value = '30';

        await WholesaleSalesManager.recordPayment('s1');

        expect(db.runTransaction).toHaveBeenCalledTimes(1);
        expect(FirebaseService.updateWholesaleSale).not.toHaveBeenCalled();
        const written = tx.update.mock.calls[0][1];
        expect(written.payment).toEqual({ online: 0, cash: 70, due: 30, total: 70 });
        expect(written).toMatchObject({ clientVersion: 3, openDue: true });
        expect(written.payments).toHaveLength(3);
        expect(written.payments[2]).toMatchObject({ amount: 30, recordedBy: 'Owner' });
        expect(local.payment.due).toBe(30);
        expect(document.getElementById('toast').textContent).toBe('✓ Payment of ₹30 recorded');
        expect(window.app.outstanding.renderDue).toHaveBeenCalled();
    });

    test('rejects an amount above the server-side due', async () => {
        const local = {
            id: 's1', source: 'sales-tab', total: 100, items: [],
            payment: { online: 0, cash: 0, due: 100, total: 0 }
        };
        const { db, tx } = fakeDb({ ...local, payment: { online: 0, cash: 90, due: 10, total: 90 } });
        FirebaseService.db = db;
        AppState.salesHistory = [local];
        WholesaleSalesManager.renderSalesOutstanding();
        document.getElementById('payment_s1').value = '50';
        jest.spyOn(console, 'error').mockImplementation(() => {});

        await WholesaleSalesManager.recordPayment('s1');

        expect(tx.update).not.toHaveBeenCalled();
        expect(FirebaseService.updateWholesaleSale).not.toHaveBeenCalled();
        expect(document.getElementById('toast').textContent).toBe('Payment amount exceeds outstanding amount (₹10)');
    });

    test('offline: no write, tells the user', async () => {
        const local = { id: 's1', source: 'sales-tab', total: 100, items: [], payment: { online: 0, cash: 0, due: 100 } };
        const { db } = fakeDb(local);
        FirebaseService.db = db;
        AppState.salesHistory = [local];
        WholesaleSalesManager.renderSalesOutstanding();
        document.getElementById('payment_s1').value = '10';
        const spy = jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);

        await WholesaleSalesManager.recordPayment('s1');

        spy.mockRestore();
        expect(db.runTransaction).not.toHaveBeenCalled();
        expect(document.getElementById('toast').textContent).toBe('Internet required to record payment');
    });
});

describe('wholesale sale save: payment split (#113, #23, #68, #26)', () => {
    const DOM = `
      <input id="wholesaleCustomerName"><select id="sellItem"><option value="Rice">Rice</option></select><input id="sellQuantity"><input id="sellRate"><input id="salesComments">
      <input id="salesExpensesAmount" value="0"><span id="availableStock"></span><span id="avgPurchaseRate"></span>
      <table id="salesTable"><tbody></tbody></table><span id="salesTotalAmount">0</span>
      <span id="salesProfitAmount">0</span><span id="salesProfitPercent">0</span>
      <input type="checkbox" id="wholesaleOnlineCheckbox"><input id="wholesaleOnlinePayment">
      <input type="checkbox" id="wholesaleCashCheckbox"><input id="wholesaleCashPayment">
      <input type="checkbox" id="wholesaleDueCheckbox"><input id="wholesaleDueAmount">
      <span id="wholesaleTotalReceived"></span><strong id="wholesaleSplitRemaining"></strong>
      <div id="salesHistoryList"></div><datalist id="wholesaleCustomerOptions"></datalist><div id="toast"></div>`;
    const setVal = (id, v) => { document.getElementById(id).value = String(v); };
    let saved;

    beforeEach(async () => {
        document.body.innerHTML = DOM;
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(Helpers, 'generateBillNumber').mockResolvedValue('W20261022-001');
        saved = [];
        FirebaseService.saveWholesaleSale = jest.fn(async (sale) => { saved.push(sale); return sale; });
        AppState.items = [{ id: 'rice', name: 'Rice' }];
        AppState.stock = { rice: { quantity: 500, rate: 30.5 } };
        AppState.stockReady = true;
        AppState.settings = { showHindi: false };
        setVal('sellRate', 40.25);
        setVal('sellQuantity', 100);
        await WholesaleSalesManager.addToWholesaleBill(); // 4025
    });
    afterEach(() => {
        WholesaleSalesManager.setItems([]);
        jest.restoreAllMocks();
    });
    const toast = () => document.getElementById('toast').textContent;

    test('cash + online + due is saved nested and top-level; total and profit come from the lines', async () => {
        document.getElementById('salesTotalAmount').textContent = '9999';
        document.getElementById('salesProfitAmount').textContent = '9999';
        setVal('salesExpensesAmount', 25);
        setVal('wholesaleCustomerName', 'Gupta Traders');
        setVal('wholesaleCashPayment', 2000);
        setVal('wholesaleOnlinePayment', 1000);
        WholesaleSalesManager.putRestInDue();
        expect(document.getElementById('wholesaleDueAmount').value).toBe('1025');

        const sale = await WholesaleSalesManager.completeSale();

        expect(sale).toMatchObject({
            total: 4025, expenses: 25, profit: 950, profitPercent: 23.6,
            cashPayment: 2000, onlinePayment: 1000, dueAmount: 1025,
            payment: { cash: 2000, online: 1000, due: 1025, total: 4025 }
        });
        expect(readPayment(sale)).toEqual({ total: 4025, cash: 2000, online: 1000, due: 1025, paid: 3000 });
        expect(saved).toHaveLength(1);
    });

    test('a mismatched split, a Due without a name, or no payment is refused', async () => {
        setVal('wholesaleCashPayment', 4000);
        expect(await WholesaleSalesManager.completeSale()).toBeUndefined();
        expect(toast()).toContain('₹25 less than the bill total');

        setVal('wholesaleCashPayment', 0);
        setVal('wholesaleDueAmount', 4025);
        expect(await WholesaleSalesManager.completeSale()).toBeUndefined();
        expect(toast()).toBe(t(NAME_REQUIRED_FOR_DUE_KEY));

        setVal('wholesaleDueAmount', 0);
        expect(await WholesaleSalesManager.completeSale()).toBeUndefined();
        expect(toast()).toContain('at least one payment method');
        expect(saved).toHaveLength(0);
    });

    test('oversell: same limit at add and save — up to 5 kg warns, beyond blocks (#37, Q18/Q57)', async () => {
        AppState.stock = { rice: { quantity: 103, rate: 30.5 } };
        setVal('sellQuantity', 6); // 106 kg vs 103 → 3 kg short: allowed with a warning
        await WholesaleSalesManager.addToWholesaleBill();
        expect(WholesaleSalesManager.getItems()).toHaveLength(2);
        setVal('sellQuantity', 3); // 109 kg → 6 kg short: blocked at add
        await WholesaleSalesManager.addToWholesaleBill();
        expect(WholesaleSalesManager.getItems()).toHaveLength(2);
        expect(toast()).toBe('Insufficient stock! Available: 103.0kg');

        setVal('wholesaleCashPayment', 4267);
        const modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        const sale = await WholesaleSalesManager.completeSale();
        expect(modal).toHaveBeenCalledWith(expect.stringContaining('short 3.0 kg'), expect.any(String), true);
        expect(sale.flags).toEqual([expect.objectContaining({ rule: 'oversell', by: 'owner1' })]);

        // Stock fell meanwhile: now 9 kg short → blocked for a member, toast names the item
        WholesaleSalesManager.setItems([{ itemId: 'rice', name: 'Rice', rate: 40, qty: 12, total: 480 }]);
        AppState.stock = { rice: { quantity: 3, rate: 30.5 } };
        AppState.userRole = 'staff';
        setVal('wholesaleCashPayment', 480);
        expect(await WholesaleSalesManager.completeSale()).toBeUndefined();
        expect(toast()).toContain('Rice: selling 12.0 kg, only 3.0 kg in stock');
        expect(saved).toHaveLength(1);
    });

    test('retry after a failed save: own quantities already deducted from stock are credited back (no block, no warn)', async () => {
        WholesaleSalesManager.setItems([]);
        AppState.stock = { rice: { quantity: 50, rate: 30.5 } };
        AppState.salesHistory = [];
        AppState.userRole = 'staff';
        setVal('sellRate', 40);
        setVal('sellQuantity', 30);
        await WholesaleSalesManager.addToWholesaleBill(); // 1200
        setVal('wholesaleCashPayment', 1200);
        const modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        FirebaseService.saveWholesaleSale = jest.fn(async (sale) => {
            AppState.salesHistory.unshift(sale);
            AppState.stock = { rice: { quantity: 20, rate: 30.5 } };
            throw new Error('timeout');
        });
        expect(await WholesaleSalesManager.completeSale()).toBeUndefined();
        expect(toast()).toBe('Error: timeout');

        // Adding another 5 kg on the retry bill: 35 of 50 kg, the add check must credit the 30 kg too
        setVal('sellQuantity', 5);
        await WholesaleSalesManager.addToWholesaleBill();
        expect(WholesaleSalesManager.getItems()).toHaveLength(2);
        setVal('wholesaleCashPayment', 1400);

        FirebaseService.saveWholesaleSale = jest.fn(async (sale) => sale);
        const sale = await WholesaleSalesManager.completeSale();
        expect(modal).not.toHaveBeenCalled();
        expect(sale).toMatchObject({ total: 1400 });
        expect(sale.flags).toBeUndefined();
        expect(sale.overrides).toBeUndefined();
        AppState.salesHistory = [];
    });

    test('a fully paid cash sale needs no name and its cash reaches the drawer', async () => {
        setVal('wholesaleCashPayment', 4025);
        const sale = await WholesaleSalesManager.completeSale();
        expect(sale).toMatchObject({ customerName: '', cashPayment: 4025, dueAmount: 0, payment: { due: 0 } });
        expect(readPayment(sale).cash).toBe(4025);
    });
});

describe('#129 approximate stock: adding a wholesale line warns instead of blocking', () => {
    const DOM = `
      <select id="sellItem"><option value="Rice">Rice</option></select><input id="sellQuantity"><input id="sellRate">
      <input id="salesExpensesAmount" value="0"><span id="availableStock"></span><span id="avgPurchaseRate"></span>
      <div id="availableStockApprox" style="display:none"></div>
      <table id="salesTable"><tbody></tbody></table><span id="salesTotalAmount">0</span>
      <span id="salesProfitAmount">0</span><span id="salesProfitPercent">0</span><div id="toast"></div>`;
    beforeEach(() => {
        document.body.innerHTML = DOM;
        AppState.items = [{ id: 'rice', name: 'Rice' }];
        AppState.stock = { rice: { quantity: 20, rate: 30 } };
        AppState.stockReady = true;
        AppState.settings = { showHindi: false };
        document.getElementById('sellRate').value = '40';
        document.getElementById('sellQuantity').value = '100';
    });
    afterEach(() => {
        WholesaleSalesManager.setItems([]);
        AppState.stockApprox = null;
    });

    test('exact stock: an oversell beyond the limit is refused', async () => {
        AppState.stockApprox = null;
        await WholesaleSalesManager.addToWholesaleBill();
        expect(WholesaleSalesManager.getItems()).toHaveLength(0);
        expect(document.getElementById('toast').textContent).toContain('Insufficient stock');
    });

    test('approximate stock: the line is added with a warning naming the approximate stock', async () => {
        AppState.stockApprox = { builtAt: Date.now() - 3600000, asOf: 0 };
        await WholesaleSalesManager.addToWholesaleBill();
        expect(WholesaleSalesManager.getItems()).toHaveLength(1);
        expect(document.getElementById('toast').textContent).toContain('approximate stock (updated');
    });

    test('item details show the approximate-stock note only while stock is approximate', () => {
        document.getElementById('sellItem').value = 'Rice';
        AppState.stockApprox = { builtAt: Date.now(), asOf: 0 };
        WholesaleSalesManager.loadItemDetails();
        const note = document.getElementById('availableStockApprox');
        expect(note.style.display).toBe('block');
        expect(note.textContent).toContain('≈ approximate stock (updated');
        expect(note.textContent).not.toMatch(/[\u0900-\u097F]/); // app language only (#143)
        AppState.stockApprox = null;
        WholesaleSalesManager.loadItemDetails();
        expect(note.style.display).toBe('none');
    });
});

describe('wholesale item stats hide their placeholders until an item is picked (F31)', () => {
    beforeEach(() => {
        document.body.innerHTML = `
          <select id="sellItem"><option value="">Select item</option><option value="Rice">Rice</option></select><input id="sellRate">
          <div id="wholesaleItemStats" hidden>
            <span id="availableStock">-</span><span id="availableStockUnit"> kg</span>
            <span id="avgPurchaseRateRow">₹<span id="avgPurchaseRate">-</span>/kg</span>
          </div>`;
        AppState.items = [{ id: 'rice', name: 'Rice' }];
        AppState.stock = { rice: { quantity: 20, rate: 30 } };
        AppState.stockReady = true;
        AppState.stockApprox = null;
        AppState.settings = { showHindi: false };
    });

    test('no item: the stats box stays hidden; an item shows stock and rate with units', () => {
        const box = document.getElementById('wholesaleItemStats');
        WholesaleSalesManager.loadItemDetails();
        expect(box.hidden).toBe(true);
        document.getElementById('sellItem').value = 'Rice';
        WholesaleSalesManager.loadItemDetails();
        expect(box.hidden).toBe(false);
        expect(document.getElementById('availableStock').textContent).toBe('20.00');
        expect(document.getElementById('availableStockUnit').hidden).toBe(false);
        expect(document.getElementById('avgPurchaseRateRow').hidden).toBe(false);
    });

    test('an item with no recorded stock hides the "₹-/kg" rate row', () => {
        AppState.stock = {};
        document.getElementById('sellItem').value = 'Rice';
        WholesaleSalesManager.loadItemDetails();
        expect(document.getElementById('avgPurchaseRateRow').hidden).toBe(true);
    });
});