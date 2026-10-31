/**
 * @fileoverview window.debugStock (console diagnostic) shows the item ledger of
 * the shared stock replay (ST4 / AVG-COST), not a copy of the average-cost rules.
 */
import { AppState } from '../utils/state.js';
import { FirebaseService } from '../firebase/firestore-service.js';

beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await import('../main.js');
});

test('debugStock lists the replay with running kg and average cost, and matches calculateStock', async () => {
    Object.assign(AppState, {
        items: [{ id: 'rice', name: 'Rice' }],
        purchaseHistory: [
            { id: 'p1', date: '2026-10-01', timestamp: 1, items: [{ itemId: 'rice', name: 'Rice', qty: 100, rate: 30, total: 3000 }] },
            { id: 'p2', date: '2026-10-03', timestamp: 3, items: [{ name: 'rice ', qty: 50, rate: 36, total: 1800 }] }
        ],
        salesHistory: [{ id: 's1', date: '2026-10-02', timestamp: 2, items: [{ name: 'Rice', qty: 40, rate: 40, total: 1600 }] }],
        retailSalesHistory: [],
        stockAdjustments: [{ id: 'a1', date: '2026-10-04', timestamp: 4, itemId: 'rice', itemName: 'Rice', adjustType: 'remove', quantity: 10 }]
    });
    jest.spyOn(FirebaseService, 'calculateStock').mockResolvedValue({ rice: { quantity: 100, rate: 32 } });
    jest.spyOn(FirebaseService, 'ensureHistoryFrom').mockResolvedValue(undefined);
    const table = jest.spyOn(console, 'table').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    jest.spyOn(console, 'groupEnd').mockImplementation(() => {});

    await window.debugStock('rice');

    expect(table.mock.calls[0][0].map(r => [r.kind, r.qty, r.runningQty, r.runningRate])).toEqual([
        ['purchase', 100, 100, 30], ['wholesale', -40, 60, 30], ['purchase', 50, 110, 32.73], ['adjustment', -10, 100, 32.73]
    ]);
    expect(warn).not.toHaveBeenCalled();
});
