/**
 * @fileoverview Stock adjustment rules (#72): remove capped at stock, reason
 * required, "set to 0" allowed, replay never goes negative, list refreshes.
 */

jest.mock('../firebase/firestore-service.js', () => ({
    FirebaseService: {
        saveStockAdjustment: jest.fn(async () => {}),
        calculateStock: jest.fn(async () => ({})),
        getStock: jest.fn(async () => ({}))
    }
}));
jest.mock('../ui/ui-manager.js', () => ({
    UIManager: {
        showToast: jest.fn(),
        showModal: jest.fn(async () => true),
        withLoading: jest.fn(async (fn) => fn())
    }
}));
jest.mock('../ui/infinite-scroll.js', () => ({ attachOlderHistoryScroll: jest.fn() }));

import { FirebaseService } from '../firebase/firestore-service.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { StockManager } from '../modules/stock.js';
import { planStockAdjustment, adjustReasonText } from '../utils/stock-adjust.js';
import { computeStock } from '../utils/stock-replay.js';

describe('planStockAdjustment', () => {
    const base = { currentStock: 10, reasonCode: 'damage' };

    test('remove more than stock is capped at the stock on hand', () => {
        const p = planStockAdjustment({ ...base, adjustType: 'remove', quantity: 25 });
        expect(p).toMatchObject({ ok: true, quantity: 10, rawQuantity: 25, newStock: 0, capped: true });
    });

    test('remove with no stock is refused', () => {
        expect(planStockAdjustment({ ...base, currentStock: 0, adjustType: 'remove', quantity: 1 }).ok).toBe(false);
    });

    test('set to 0 is allowed; add/remove of 0 and negatives are not', () => {
        expect(planStockAdjustment({ ...base, adjustType: 'set', quantity: 0 })).toMatchObject({ ok: true, newStock: 0 });
        expect(planStockAdjustment({ ...base, adjustType: 'add', quantity: 0 }).ok).toBe(false);
        expect(planStockAdjustment({ ...base, adjustType: 'set', quantity: -1 }).ok).toBe(false);
        expect(planStockAdjustment({ ...base, adjustType: 'set', quantity: NaN }).ok).toBe(false);
    });

    test('reason is required and "other" needs a note', () => {
        expect(planStockAdjustment({ ...base, reasonCode: '', adjustType: 'add', quantity: 1 }).ok).toBe(false);
        expect(planStockAdjustment({ ...base, reasonCode: 'other', reasonNote: ' ', adjustType: 'add', quantity: 1 }).ok).toBe(false);
        const p = planStockAdjustment({ ...base, reasonCode: 'other', reasonNote: 'gift', adjustType: 'add', quantity: 1 });
        expect(p).toMatchObject({ ok: true, newStock: 11 });
        expect(p.reason).toMatch(/Other.*: gift$/);
    });

    test('a saved reason shows in the app language, also for old "English / Hindi" records', () => {
        const old = { reasonCode: 'other', reason: 'Other / अन्य: recount' };
        expect(adjustReasonText(old, 'en')).toBe('Other: recount');
        expect(adjustReasonText(old, 'hi')).toBe('अन्य: recount');
        expect(adjustReasonText({ reasonCode: 'damage', reason: 'Damaged' }, 'hi')).toBe('खराब');
        expect(adjustReasonText({ reason: 'Physical count / गिनती' }, 'en')).toBe('Physical count');
        expect(adjustReasonText({ reason: 'typed by hand' }, 'hi')).toBe('typed by hand');
    });
});

describe('stock replay', () => {
    const items = [{ id: 'a', name: 'Chana' }];
    const purchase = (t, qty) => ({ timestamp: t, items: [{ itemId: 'a', name: 'Chana', qty, rate: 50 }] });
    const adj = (t, adjustType, quantity) => ({ timestamp: t, itemId: 'a', itemName: 'Chana', adjustType, quantity });

    test('a remove larger than stock stops at 0 (legacy raw quantities too)', () => {
        const stock = computeStock({ purchases: [purchase(1, 10), purchase(3, 5)], stockAdjustments: [adj(2, 'remove', 25)] }, items);
        expect(stock.a.quantity).toBe(5);
    });

    test('a normal remove keeps the average rate', () => {
        const stock = computeStock({ purchases: [purchase(1, 10)], stockAdjustments: [adj(2, 'remove', 4)] }, items);
        expect(stock.a.quantity).toBe(6);
        expect(stock.a.rate).toBe(50);
    });
});

describe('StockManager.applyStockAdjustment', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="currentStockSection"><div id="stockList"></div></div>
            <select id="adjustItem"><option value="a">Chana</option></select>
            <span id="currentStockDisplay"></span>
            <select id="adjustType"><option value="add">add</option><option value="remove">remove</option><option value="set">set</option></select>
            <input id="adjustQuantity"><input id="adjustRate" value="0">
            <select id="adjustReasonCode"><option value=""></option><option value="count">count</option><option value="damage">damage</option><option value="other">other</option></select>
            <input id="adjustReason">
            <div id="adjustmentHistory"></div>`;
        AppState.items = [{ id: 'a', name: 'Chana' }];
        AppState.stock = { a: { quantity: 10, rate: 50 } };
        AppState.stockAdjustments = [];
        AppState.settings = { showHindi: false };
        AppState.userRole = 'owner';
        FirebaseService.saveStockAdjustment.mockClear();
        FirebaseService.getStock.mockImplementation(async () => AppState.stock);
        FirebaseService.calculateStock.mockImplementation(async () => ({ a: { quantity: 0, rate: 0 } }));
        UIManager.showModal.mockImplementation(async () => true);
    });
    const fill = (type, qty, reason = 'damage') => {
        document.getElementById('adjustType').value = type;
        document.getElementById('adjustQuantity').value = qty;
        document.getElementById('adjustReasonCode').value = reason;
    };

    test('remove beyond stock saves the effective quantity and the raw one', async () => {
        fill('remove', '25');
        await StockManager.applyStockAdjustment();
        expect(UIManager.showModal).toHaveBeenCalled();
        const saved = FirebaseService.saveStockAdjustment.mock.calls[0][0];
        expect(saved).toMatchObject({ itemId: 'a', adjustType: 'remove', quantity: 10, rawQuantity: 25, previousStock: 10, newStock: 0, reasonCode: 'damage' });
        expect(saved.reason).toMatch(/Damaged/);
    });

    test('no reason → nothing saved', async () => {
        fill('add', '5', '');
        await StockManager.applyStockAdjustment();
        expect(FirebaseService.saveStockAdjustment).not.toHaveBeenCalled();
    });

    test('set to 0 works; a blank quantity does not mean 0', async () => {
        fill('set', '');
        await StockManager.applyStockAdjustment();
        expect(FirebaseService.saveStockAdjustment).not.toHaveBeenCalled();
        fill('set', '0', 'count');
        await StockManager.applyStockAdjustment();
        expect(FirebaseService.saveStockAdjustment.mock.calls[0][0]).toMatchObject({ adjustType: 'set', quantity: 0, newStock: 0 });
    });

    test('the Current Stock list refreshes after saving', async () => {
        const spy = jest.spyOn(StockManager, 'renderStock').mockImplementation(async () => {});
        fill('add', '5');
        await StockManager.applyStockAdjustment();
        expect(spy).toHaveBeenCalled();
    });

    test('a double tap on Apply (also Set opening stock) saves one adjustment (#95)', async () => {
        document.body.insertAdjacentHTML('beforeend', '<button id="applyBtn" data-stock-adjust></button>');
        const btn = document.getElementById('applyBtn');
        btn.addEventListener('click', () => { StockManager.applyStockAdjustment(); });
        let release;
        FirebaseService.saveStockAdjustment.mockImplementationOnce(() => new Promise(r => { release = r; }));
        fill('set', '40', 'count');
        btn.click();
        btn.click();
        await Promise.resolve();
        expect(btn.disabled).toBe(true);
        await StockManager.applyStockAdjustment();
        expect(FirebaseService.saveStockAdjustment).toHaveBeenCalledTimes(1);
        release();
        await new Promise(r => setTimeout(r));
        expect(btn.disabled).toBe(false);
    });
});

describe('StockManager.renderStock while stock is not ready (#194)', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="currentStockSection"><div id="stockList"></div></div>';
        AppState.items = [{ id: 'a', name: 'Chana' }];
        AppState.userRole = 'owner';
    });
    afterEach(() => { AppState.stockReady = true; });

    test.each([
        ['empty', {}],
        ['stale quantities', { a: { quantity: 7, rate: 50 } }]
    ])('keeps the "Stock updating" placeholder when getStock returns %s and stock is still pending', async (_, pending) => {
        AppState.stockReady = true;
        FirebaseService.getStock.mockImplementation(async () => { AppState.stockReady = false; return pending; });
        await StockManager.renderStock();
        const html = document.getElementById('stockList').innerHTML;
        expect(html).toContain('Stock updating…');
        expect(html).not.toContain('No stock data available');
        expect(html).not.toContain('Chana');
    });

    test('draws the stock once it is ready', async () => {
        AppState.stockReady = false;
        FirebaseService.getStock.mockImplementation(async () => { AppState.stockReady = true; return { a: { quantity: 7, rate: 50 } }; });
        await StockManager.renderStock();
        expect(document.getElementById('stockList').innerHTML).not.toContain('Stock updating');
        expect(document.getElementById('stockList').textContent).toContain('Chana');
    });
});