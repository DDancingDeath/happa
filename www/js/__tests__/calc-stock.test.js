/**
 * @fileoverview utils/calc/stock.js: the Stock page's figures (S1–S6) and the
 * one stock value (S4 = F6) that Money › Worth and the Stock page share.
 */
import fs from 'fs';
import path from 'path';
import { STOCK_SPEC, stockRows, itemValue, stockValue, adjustItemStock, adjustmentValue, deadStockValue } from '../utils/calc/stock.js';
import { stateValue } from '../utils/stock-replay.js';

const ITEMS = [
    { id: 'i-rice', name: 'Rice', hindiName: 'चावल' },
    { id: 'i-wheat', name: 'Wheat', hindiName: 'गेहूं' },
    { id: 'i-zero', name: 'Zero' }
];

describe('stockRows (S1, S2): buckets merged onto the catalogue', () => {
    test('id and legacy name buckets merge with a weighted average rate', () => {
        const { rows, orphanKeys } = stockRows({
            'i-rice': { quantity: 100, rate: 30 },
            ' RICE ': { quantity: 50, rate: 36 },
            'गेहूं': { quantity: 40, rate: 26 }
        }, ITEMS);
        expect(orphanKeys).toEqual([]);
        expect(rows).toEqual([
            { itemId: 'i-rice', name: 'Rice', hindiName: 'चावल', quantity: 150, rate: 32 },
            { itemId: 'i-wheat', name: 'Wheat', hindiName: 'गेहूं', quantity: 40, rate: 26 }
        ]);
    });

    test('empty items are hidden; unmatched buckets stay (negative too), after the catalogue rows', () => {
        const { rows, orphanKeys } = stockRows({
            ghost: { quantity: -3.5, rate: 0 },
            'i-zero': { quantity: 0, rate: 50 },
            'i-wheat': { quantity: 10, rate: 0 },
            dust: { quantity: 0.0005, rate: 9 },
            'old name': { quantity: 7, rate: 12 }
        }, ITEMS);
        expect(rows.map(r => [r.name, r.quantity, r.rate, !!r.isOrphan])).toEqual([
            ['Wheat', 10, 0, false], ['ghost', -3.5, 0, true], ['old name', 7, 12, true]
        ]);
        expect(rows[1].itemId).toBe('__orphan__ghost');
        expect(orphanKeys).toEqual(['ghost', 'dust', 'old name']);
    });

    test('no stock, no catalogue', () => {
        expect(stockRows({}, ITEMS)).toEqual({ rows: [], orphanKeys: [] });
        expect(stockRows(null, null)).toEqual({ rows: [], orphanKeys: [] });
    });
});

describe('itemValue (S3) and stockValue (S4 = F6)', () => {
    test('S3 = quantity × rate, nothing for no stock', () => {
        expect(itemValue({ quantity: 12.4, rate: 33.5 })).toBeCloseTo(415.4, 10);
        expect([itemValue({ quantity: 0, rate: 9 }), itemValue({ quantity: -2, rate: 9 }), itemValue({ quantity: 5 }), itemValue(null)]).toEqual([0, 0, 0, 0]);
        expect(itemValue({ quantity: '3', rate: '2.5' })).toBe(7.5);
    });

    test('S4 of a stock map is Σ S3 of the items on hand', () => {
        const stock = { a: { quantity: 10, rate: 3 }, b: { quantity: -1, rate: 5 }, c: { quantity: 2.5, rate: 4 } };
        expect(stockValue(stock)).toBe(40);
        expect(stockValue([{ quantity: 1, rate: 2 }, { quantity: 3, rate: 0 }])).toBe(2);
        expect(stockValue(null)).toBe(0);
    });

    test('S4 of the replay\'s running state is its replayed value (same as the replay\'s stateValue)', () => {
        const state = { a: { quantity: 3, rate: 0, totalValue: 100.07 }, b: { quantity: 0, rate: 0, totalValue: 50 }, c: { quantity: 2, rate: 0, totalValue: -1 } };
        expect(stockValue(state)).toBe(100.07);
        expect(stockValue(state)).toBe(stateValue(state));
    });

    test('S6 dead stock value = S4 of its rows', () => {
        expect(deadStockValue([{ quantity: 120.5, rate: 31.333333 }, { quantity: 3.333, rate: 7.777 }])).toBeCloseTo(120.5 * 31.333333 + 3.333 * 7.777, 8);
        expect(deadStockValue([])).toBe(0);
    });
});

describe('adjustment form and history (S1, S2, S5)', () => {
    test('adjustItemStock: quantity and average rate only with stock at a known cost', () => {
        expect(adjustItemStock({ quantity: 120.5, rate: 31.25 })).toEqual({ quantity: 120.5, avgRate: 31.25 });
        expect(adjustItemStock({ quantity: 4, rate: 0 })).toEqual({ quantity: 4, avgRate: null });
        expect(adjustItemStock({ quantity: -2, rate: 10 })).toEqual({ quantity: -2, avgRate: null });
        expect(adjustItemStock(undefined)).toEqual({ quantity: 0, avgRate: null });
    });

    test('adjustmentValue: its own rate, else the item\'s current rate; whole rupees shown', () => {
        const stock = { 'i-rice': { rate: 32 }, 'old name': { rate: 12.75 } };
        expect(adjustmentValue({ itemId: 'i-rice', quantity: 10, rate: 30 }, stock)).toEqual({ rate: 30, value: 300, rounded: 300 });
        expect(adjustmentValue({ itemId: 'i-rice', quantity: 2, rate: 0 }, stock)).toEqual({ rate: 32, value: 64, rounded: 64 });
        expect(adjustmentValue({ itemName: 'old name', quantity: '3' }, stock)).toEqual({ rate: 12.75, value: 38.25, rounded: 38 });
        expect(adjustmentValue({ itemId: 'i-rice', quantity: 0.01, rate: 30 }, stock)).toEqual({ rate: 30, value: 0.3, rounded: 0 });
        expect(adjustmentValue({ itemId: 'i-rice', rate: 30 }, stock)).toEqual({ rate: 30, value: null, rounded: null });
        expect(adjustmentValue({ itemId: 'i-dal', quantity: 5, rate: 0 }, stock)).toEqual({ rate: 0, value: null, rounded: null });
        expect(adjustmentValue({ itemId: 'i-dal', quantity: 5 }, undefined)).toEqual({ rate: 0, value: null, rounded: null });
    });
});

test('every function has a spec ID that docs/calculations.md defines', () => {
    const doc = fs.readFileSync(path.resolve(__dirname, '../../../docs/calculations.md'), 'utf8');
    const ids = new Set(Object.values(STOCK_SPEC).flatMap(v => v.split(', ')));
    ids.forEach(id => expect(doc).toMatch(new RegExp(`^\\| ${id} \\|`, 'm')));
});
