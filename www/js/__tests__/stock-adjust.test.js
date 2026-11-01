/**
 * @fileoverview Stock adjustment rules (#72): remove capped at stock, reason
 * required, "set to 0" allowed, replay never goes negative, list refreshes.
 */

jest.mock('../firebase/firestore-service.js', () => ({
    FirebaseService: {
        startSaveStockAdjustment: jest.fn(() => ({ record: {}, committed: Promise.resolve() })),
        calculateStock: jest.fn(async () => ({})),
        getStock: jest.fn(async () => ({})),
        setItemLowStock: jest.fn(async () => {})
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
import { planStockAdjustment, adjustReasonText, reversalPlan, canReverseAdjustment, stockCountPlan, restockCost, lastPurchaseRate } from '../utils/stock-adjust.js';
import { lowStockItems, lowStockLevel } from '../utils/stock-check.js';
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
        FirebaseService.startSaveStockAdjustment.mockReset().mockImplementation(() => ({ record: {}, committed: Promise.resolve() }));
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
        const saved = FirebaseService.startSaveStockAdjustment.mock.calls[0][0];
        expect(saved).toMatchObject({ itemId: 'a', adjustType: 'remove', quantity: 10, rawQuantity: 25, previousStock: 10, newStock: 0, reasonCode: 'damage' });
        expect(saved.reason).toMatch(/Damaged/);
    });

    test('no reason → nothing saved', async () => {
        fill('add', '5', '');
        await StockManager.applyStockAdjustment();
        expect(FirebaseService.startSaveStockAdjustment).not.toHaveBeenCalled();
    });

    test('set to 0 works; a blank quantity does not mean 0', async () => {
        fill('set', '');
        await StockManager.applyStockAdjustment();
        expect(FirebaseService.startSaveStockAdjustment).not.toHaveBeenCalled();
        fill('set', '0', 'count');
        await StockManager.applyStockAdjustment();
        expect(FirebaseService.startSaveStockAdjustment.mock.calls[0][0]).toMatchObject({ adjustType: 'set', quantity: 0, newStock: 0 });
    });

    test('the Current Stock list refreshes after saving', async () => {
        const spy = jest.spyOn(StockManager, 'renderStock').mockImplementation(async () => {});
        fill('add', '5');
        await StockManager.applyStockAdjustment();
        expect(spy).toHaveBeenCalled();
    });

    test('a double tap on Apply (also Set opening stock) saves one adjustment (#95)', async () => {
        // Remove more than in stock: both taps read the filled form, then wait for the confirm
        fill('remove', '25');
        await Promise.all([StockManager.applyStockAdjustment(), StockManager.applyStockAdjustment()]);
        expect(UIManager.showModal).toHaveBeenCalledTimes(2);
        expect(FirebaseService.startSaveStockAdjustment).toHaveBeenCalledTimes(1);
    });

    test('offline: each adjustment is saved on the phone at once, so opening stock for several items can be entered (#95)', async () => {
        const online = jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
        AppState.items = [{ id: 'a', name: 'Chana' }, { id: 'b', name: 'Gehu' }];
        document.getElementById('adjustItem').innerHTML = '<option value="a">Chana</option><option value="b">Gehu</option>';
        document.body.insertAdjacentHTML('beforeend', '<button id="applyBtn" data-stock-adjust></button>');
        const never = new Promise(() => {});
        FirebaseService.startSaveStockAdjustment.mockImplementation(() => ({ record: {}, committed: never }));
        FirebaseService.calculateStock.mockImplementation(() => never);
        for (const [id, qty] of [['a', '40'], ['b', '25']]) {
            document.getElementById('adjustItem').value = id;
            fill('set', qty, 'count');
            StockManager.applyStockAdjustment();
            await Promise.resolve();
            await Promise.resolve();
            expect(document.getElementById('adjustQuantity').value).toBe('');
            expect(document.getElementById('applyBtn').disabled).toBe(false);
        }
        expect(FirebaseService.startSaveStockAdjustment.mock.calls.map(c => [c[0].itemId, c[0].quantity])).toEqual([['a', 40], ['b', 25]]);
        expect(UIManager.showToast).toHaveBeenLastCalledWith('Saved on this phone, will sync');
        online.mockRestore();
    });

    test('a refused adjustment says so and redraws the stock', async () => {
        let refuse;
        FirebaseService.startSaveStockAdjustment.mockImplementationOnce(() => ({ record: {}, committed: new Promise((_, r) => { refuse = r; }) }));
        const redraw = jest.spyOn(StockManager, 'refreshAfterAdjustment').mockResolvedValue(undefined);
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        fill('add', '5');
        await StockManager.applyStockAdjustment();
        redraw.mockClear();
        refuse(new Error('denied'));
        await new Promise(r => setTimeout(r));
        expect(UIManager.showToast).toHaveBeenLastCalledWith('Failed to apply adjustment');
        expect(redraw).toHaveBeenCalled();
        redraw.mockRestore();
        err.mockRestore();
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

describe('reverse an adjustment and stock count (#146)', () => {
    const adj = (id, previousStock, newStock, extra = {}) => ({ id, itemId: 'a', itemName: 'Chana', previousStock, newStock, ...extra });

    test('reversal takes back the change from the stock now; a remove stops at the stock on hand', () => {
        expect(reversalPlan(adj('x', 10, 25), 30)).toEqual({ adjustType: 'remove', quantity: 15, previousStock: 30, newStock: 15, capped: false });
        expect(reversalPlan(adj('x', 40, 32, { adjustType: 'set' }), 20)).toEqual({ adjustType: 'add', quantity: 8, previousStock: 20, newStock: 28, capped: false });
        expect(reversalPlan(adj('x', 10, 25), 6)).toMatchObject({ adjustType: 'remove', quantity: 6, newStock: 0, capped: true });
        expect(reversalPlan(adj('x', 10, 10), 6)).toBeNull();
        expect(reversalPlan({ id: 'old', quantity: 5 }, 6)).toBeNull();
    });

    test('cost of kg put back: own rate, else average cost, else latest purchase, else Rates page; voided bills ignored', () => {
        expect(restockCost({ ownRate: 0, stockRate: 0, lastPurchaseRate: 42, catalogueRate: 40 })).toBe(42);
        expect(restockCost({ ownRate: 45, stockRate: 30 })).toBe(45);
        expect(restockCost({ catalogueRate: '38' })).toBe(38);
        expect(restockCost({})).toBe(0);
        const item = { id: 'a', name: 'Chana' };
        expect(lastPurchaseRate(item, [
            { timestamp: 1, items: [{ itemId: 'a', rate: 40 }] },
            { timestamp: 3, items: [{ itemId: 'a', rate: 44 }], voided: true },
            { timestamp: 2, items: [{ name: 'Chana', rate: 41 }, { itemId: 'b', rate: 99 }] }
        ])).toBe(41);
    });

    test('Reverse is offered once, never on a reversal or an adjustment that changed nothing', () => {
        const a1 = adj('a1', 0, 5);
        const r1 = adj('r1', 5, 0, { reversesId: 'a1' });
        expect(canReverseAdjustment(a1, [a1])).toBe(true);
        expect(canReverseAdjustment(a1, [a1, r1])).toBe(false);
        expect(canReverseAdjustment(r1, [a1, r1])).toBe(false);
        expect(canReverseAdjustment(adj('a2', 5, 5), [])).toBe(false);
    });

    test('count: blank boxes skipped, same kg skipped, negative refused', () => {
        expect(stockCountPlan([
            { itemId: 'a', counted: '12.5', current: 10 },
            { itemId: 'b', counted: '', current: 4 },
            { itemId: 'c', counted: '4', current: 4 },
            { itemId: 'd', counted: '0', current: -3 }
        ])).toEqual({ changes: [{ itemId: 'a', previousStock: 10, newStock: 12.5 }, { itemId: 'd', previousStock: -3, newStock: 0 }], invalid: [] });
        expect(stockCountPlan([{ itemId: 'a', counted: '-1', current: 1 }]).invalid).toEqual(['a']);
    });

    test('low stock uses each item\'s own level (0 = never), else 10 kg', () => {
        const items = [{ id: 'a', name: 'Chana' }, { id: 'b', name: 'Gehu', lowStockKg: 50 }, { id: 'c', name: 'Moong', lowStockKg: 0 }];
        const stock = { a: { quantity: 8 }, b: { quantity: 40 }, c: { quantity: 1 } };
        expect(lowStockLevel(items[0])).toBe(10);
        expect(lowStockItems(stock, items, new Set(['a', 'b', 'c']))).toEqual([
            { key: 'a', name: 'Chana', quantity: 8, level: 10 }, { key: 'b', name: 'Gehu', quantity: 40, level: 50 }
        ]);
    });

    test('Reverse on a row saves the opposite adjustment linked by reversesId; Count saves "set" adjustments', async () => {
        document.body.innerHTML = '<div id="adjustmentHistory"></div><input id="adjustQuantity"><input id="adjustRate"><input id="adjustReason"><select id="adjustReasonCode"></select>';
        AppState.userRole = 'manager';
        AppState.items = [{ id: 'a', name: 'Chana' }, { id: 'b', name: 'Gehu' }];
        AppState.stock = { a: { quantity: 30, rate: 50 }, b: { quantity: 4, rate: 20 } };
        AppState.stockAdjustments = [adj('a1', 10, 25, { adjustType: 'add', quantity: 15, date: '1/10/2026', timestamp: 1 })];
        FirebaseService.startSaveStockAdjustment.mockClear();
        await StockManager.renderAdjustmentHistory();
        expect(document.querySelector('#adjustmentHistory button').textContent).toBe('Reverse');
        await StockManager.reverseAdjustment('a1');
        expect(FirebaseService.startSaveStockAdjustment).toHaveBeenCalledWith(expect.objectContaining({
            itemId: 'a', adjustType: 'remove', quantity: 15, previousStock: 30, newStock: 15, reasonCode: 'reverse', reversesId: 'a1'
        }), { id: 'rev_a1' });

        // Reversing a removal puts the kg back at the average cost now, so the cost per kg holds
        AppState.stock = { a: { quantity: 20, rate: 50 }, b: { quantity: 4, rate: 20 } };
        AppState.stockAdjustments = [adj('d1', 30, 20, { adjustType: 'remove', quantity: 10, reasonCode: 'damage', date: '2/10/2026', timestamp: 2 })];
        FirebaseService.startSaveStockAdjustment.mockClear();
        await StockManager.reverseAdjustment('d1');
        const reversal = FirebaseService.startSaveStockAdjustment.mock.calls[0][0];
        expect(reversal).toMatchObject({ adjustType: 'add', quantity: 10, rate: 50, newStock: 30, reversesId: 'd1' });
        const stock = computeStock({
            purchases: [{ timestamp: 1, items: [{ itemId: 'a', name: 'Chana', qty: 30, rate: 50 }] }],
            stockAdjustments: [{ ...AppState.stockAdjustments[0], itemId: 'a', timestamp: 2 }, { ...reversal, timestamp: 3 }]
        }, AppState.items);
        expect(stock.a).toMatchObject({ quantity: 30, rate: 50 });

        // A mistaken "remove everything" (stock 0, average cost 0): the kg come back at the last purchase rate
        AppState.purchaseHistory = [{ timestamp: 1, items: [{ itemId: 'a', name: 'Chana', qty: 50, rate: 40 }] }];
        AppState.stock = { a: { quantity: 0, rate: 0 }, b: { quantity: 4, rate: 20 } };
        AppState.stockAdjustments = [adj('z1', 50, 0, { adjustType: 'remove', quantity: 50, rate: 0, date: '3/10/2026', timestamp: 3 })];
        FirebaseService.startSaveStockAdjustment.mockClear();
        await StockManager.reverseAdjustment('z1');
        expect(FirebaseService.startSaveStockAdjustment.mock.calls[0][0]).toMatchObject({ adjustType: 'add', quantity: 50, rate: 40 });
        AppState.purchaseHistory = [];

        UIManager.showModalWithHtml = jest.fn(async (html) => {
            document.body.insertAdjacentHTML('beforeend', html);
            document.querySelector('[data-count-item="a"]').value = '28';
            document.querySelector('[data-count-item="b"]').value = '4';
            return true;
        });
        AppState.stock = { a: { quantity: 30, rate: 50 }, b: { quantity: 4, rate: 20 } };
        FirebaseService.startSaveStockAdjustment.mockClear();
        await StockManager.openStockCount();
        expect(FirebaseService.startSaveStockAdjustment).toHaveBeenCalledTimes(1);
        expect(FirebaseService.startSaveStockAdjustment).toHaveBeenCalledWith(expect.objectContaining({
            itemId: 'a', adjustType: 'set', quantity: 28, newStock: 28, reasonCode: 'count'
        }));
    });
});

describe('low-stock card and alert level on Current stock (#146)', () => {
    test('items below their level are listed; owner/manager set a level per item', async () => {
        document.body.innerHTML = '<div id="currentStockSection"></div><input id="stockSearchInput"><div id="stockList"></div>';
        AppState.userRole = 'owner';
        AppState.settings = { showHindi: false };
        AppState.stockReady = true;
        AppState.purchaseHistory = [];
        AppState.stockAdjustments = [{ id: 'o1', itemId: 'a', adjustType: 'set', quantity: 8, timestamp: 1 }];
        AppState.items = [{ id: 'a', name: 'Chana' }, { id: 'b', name: 'Gehu', lowStockKg: 0 }];
        FirebaseService.getStock.mockResolvedValue({ a: { quantity: 8, rate: 50 }, b: { quantity: 2, rate: 20 } });
        await StockManager.renderStock();
        const card = document.querySelector('.stock-low-card');
        expect(card.textContent).toContain('Low stock (1)');
        expect(card.textContent).toContain('Chana');
        expect(card.textContent).toContain('8.0 kg (alert below 10.0 kg)');
        expect([...document.querySelectorAll('.stock-alert-link')].map(b => b.textContent.trim())).toEqual(['Alert below 10.0 kg ✎', 'No low-stock alert ✎']);

        UIManager.showModalWithHtml = jest.fn(async (html) => {
            document.body.insertAdjacentHTML('beforeend', html);
            document.getElementById('lowStockInput').value = '5';
            return true;
        });
        await StockManager.editLowStock('a');
        expect(FirebaseService.setItemLowStock).toHaveBeenCalledWith('a', 5);
        expect(AppState.items[0].lowStockKg).toBe(5);
    });
});
