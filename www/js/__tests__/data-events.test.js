/**
 * @fileoverview The data layer tells pages what changed through utils/events.js
 * (docs/architecture.md, phase 4) instead of calling them via window.app: each
 * refresh event re-renders the same page method the old VIEWS table called, the
 * item-order listener reloads the same dropdowns, every event has a subscriber, and
 * firebase/ no longer names window.app.
 */
import fs from 'fs';
import path from 'path';
import { on, off, emit, REFRESH, ITEM_FREQUENCY_CHANGED } from '../utils/events.js';
import { ItemsManager } from '../modules/items.js';
import { BillingManager } from '../modules/billing.js';
import { WholesaleSalesManager } from '../modules/wholesale-sales.js';
import { HistoryManager } from '../modules/history.js';
import { OutstandingManager } from '../modules/outstanding.js';
import { StockManager } from '../modules/stock.js';
import { ExpensesManager } from '../modules/miscellaneous.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

const JS = path.resolve(__dirname, '..');

describe('utils/events.js', () => {
    test('handlers run in subscription order with the payload; off() and the returned unsubscribe stop them', () => {
        const calls = [];
        const a = (x) => calls.push(['a', x]);
        const stopB = on('t:1', (x) => calls.push(['b', x]));
        on('t:1', a);
        expect(emit('t:1', 7)).toBe(2);
        stopB();
        off('t:1', a);
        expect(emit('t:1', 8)).toBe(0);
        expect(calls).toEqual([['b', 7], ['a', 7]]);
    });

    test('a handler that throws is logged; the others still run', () => {
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        const later = jest.fn();
        const offs = [on('t:2', () => { throw new Error('boom'); }), on('t:2', later)];
        emit('t:2');
        expect(later).toHaveBeenCalledTimes(1);
        expect(err).toHaveBeenCalledWith('Event handler error (t:2):', expect.any(Error));
        offs.forEach(o => o());
        err.mockRestore();
    });
});

describe('pages re-render on the same data changes as before (old VIEWS → window.app calls)', () => {
    afterEach(() => jest.restoreAllMocks());

    test.each([
        ['itemsList', 'ItemsManager', 'renderItems', ItemsManager],
        ['itemsTable', 'ItemsManager', 'refreshTable', ItemsManager],
        ['billingDropdown', 'BillingManager', 'loadItemsDropdown', BillingManager],
        ['salesDropdown', 'WholesaleSalesManager', 'loadItemsDropdown', WholesaleSalesManager],
        ['wholesaleHistory', 'WholesaleSalesManager', 'renderSalesHistory', WholesaleSalesManager],
        ['wholesaleOutstanding', 'WholesaleSalesManager', 'renderSalesOutstanding', WholesaleSalesManager],
        ['history', 'HistoryManager', 'refreshHistory', HistoryManager],
        ['due', 'OutstandingManager', 'renderDue', OutstandingManager],
        ['stockAdjustmentHistory', 'StockManager', 'renderAdjustmentHistory', StockManager],
        ['stockView', 'StockManager', 'renderStock', StockManager],
        ['expensesHistory', 'ExpensesManager', 'renderexpensesHistory', ExpensesManager]
    ])('%s → %s.%s()', (view, _name, method, manager) => {
        const spy = jest.spyOn(manager, method).mockImplementation(() => {});
        emit(REFRESH[view]);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    test('Money, Insights and Statements (imported on first use) are subscribed in main.js through their loaders', () => {
        const main = fs.readFileSync(path.join(JS, 'main.js'), 'utf8');
        expect(main).toContain('on(REFRESH.money, () => loadMoney().then(m => m.render()));');
        expect(main).toContain('on(REFRESH.insights, () => loadInsights().then(m => m.render()));');
        expect(main).toContain('on(REFRESH.statements, () => loadStatements().then(m => m.render()));');
    });

    test('every refresh event has a subscriber', () => {
        const files = [];
        const visit = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== '__tests__') visit(p); } else if (e.name.endsWith('.js')) files.push(p);
        });
        visit(JS);
        const subscribed = new Set(files.flatMap(f => [...fs.readFileSync(f, 'utf8').matchAll(/\bon\(REFRESH\.(\w+)/g)].map(m => m[1])));
        expect([...subscribed].sort()).toEqual(Object.keys(REFRESH).sort());
    });

    test('the data layer (firebase/) never calls pages through window.app', () => {
        const dir = path.join(JS, 'firebase');
        const list = (d) => fs.readdirSync(d, { withFileTypes: true })
            .flatMap(e => (e.isDirectory() ? list(path.join(d, e.name)) : [path.join(d, e.name)]));
        const offenders = list(dir).filter(f => f.endsWith('.js') && /window\.app\b/.test(fs.readFileSync(f, 'utf8')));
        expect(offenders.map(f => path.relative(JS, f))).toEqual([]);
    });
});

describe('the shared item order changed on another phone', () => {
    let fake;
    beforeEach(() => {
        fake = createFakeFirestore();
        global.firebase = fake.firebase;
        AppState.currentUser = { uid: 'u1' };
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
    });
    afterEach(() => {
        FirebaseService.cleanup();
        jest.restoreAllMocks();
        AppState.currentUser = null;
        delete global.firebase;
    });

    test('the bill and wholesale item dropdowns reload (in that order), with the document as payload', async () => {
        const order = [];
        jest.spyOn(BillingManager, 'loadItemsDropdown').mockImplementation(() => order.push('billing.items'));
        jest.spyOn(BillingManager, 'loadSaleItemsDropdown').mockImplementation(() => order.push('billing.saleItems'));
        jest.spyOn(WholesaleSalesManager, 'loadItemsDropdown').mockImplementation(() => order.push('wholesale.items'));
        const payload = jest.fn();
        const stop = on(ITEM_FREQUENCY_CHANGED, payload);
        await FirebaseService.setupRealtimeListeners();
        await fake.settle();
        order.length = 0;

        await fake.db.collection('itemFrequency').doc('global').set({ purchase: { Rice: { score: 1 } } });
        await fake.settle();
        stop();
        expect(order).toEqual(['billing.items', 'billing.saleItems', 'wholesale.items']);
        expect(payload).toHaveBeenLastCalledWith({ purchase: { Rice: { score: 1 } } });
    });
});
