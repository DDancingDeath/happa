/**
 * @fileoverview Dead stock (#48): items with stock and no sale in N days,
 * computed from the loaded bills only (IST day boundaries, window edges).
 */
import { findDeadStock, lastActivityByItem, localDaysBetween, daysSinceLabel } from '../utils/dead-stock.js';

// Jest pins TZ=Asia/Kolkata; local Date constructors are IST wall-clock times.
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 10, 22, 0, 30);

const items = [
    { id: 'wheat', name: 'Wheat', hindiName: 'गेहूं' },
    { id: 'chana', name: 'Chana', hindiName: 'चना' },
    { id: 'moong', name: 'Moong', hindiName: '' },
    { id: 'rice', name: 'Rice', hindiName: '' }
];
const stock = {
    wheat: { quantity: 100, rate: 30 },
    chana: { quantity: 10, rate: 60 },
    moong: { quantity: 0, rate: 90 },
    rice: { quantity: 50, rate: 40 }
};

describe('localDaysBetween (IST calendar days)', () => {
    test('23:59 yesterday is 1 day before 00:30 today', () => {
        expect(localDaysBetween(at(2026, 10, 21, 23, 59), NOW)).toBe(1);
        expect(localDaysBetween(at(2026, 10, 22, 0, 1), NOW)).toBe(0);
    });
    test('UTC date differs from IST date near midnight; IST wins', () => {
        // 2026-10-21 18:45 UTC = 2026-10-22 00:15 IST → same IST day as NOW
        expect(localDaysBetween(Date.UTC(2026, 9, 21, 18, 45), NOW)).toBe(0);
    });
});

describe('lastActivityByItem', () => {
    test('wholesale and retail both count as sales; resolves Hindi names; keeps the latest', () => {
        const res = lastActivityByItem({
            purchases: [{ timestamp: at(2026, 8, 1), items: [{ itemId: 'wheat' }] }],
            wholesaleSales: [{ timestamp: at(2026, 9, 1), items: [{ itemId: 'wheat', quantity: 5 }] }],
            retailSales: [
                { timestamp: at(2026, 9, 10), items: [{ name: 'गेहूं' }] },
                { timestamp: at(2026, 9, 5), items: [{ itemId: 'wheat' }] }
            ]
        }, items);
        expect(res.sale.wheat).toBe(at(2026, 9, 10));
        expect(res.purchase.wheat).toBe(at(2026, 8, 1));
    });
});

describe('findDeadStock', () => {
    const sources = (saleTime) => ({
        purchases: [{ timestamp: at(2026, 9, 1), items: [{ itemId: 'chana' }] }],
        wholesaleSales: [{ timestamp: saleTime, items: [{ itemId: 'wheat' }] }],
        retailSales: [{ timestamp: at(2026, 10, 20), items: [{ itemId: 'rice' }] }]
    });

    test('last sale exactly N days ago (IST) is dead; N-1 days is not', () => {
        const dead = findDeadStock({ stock, items, sources: sources(at(2026, 9, 22, 23, 59)), now: NOW, minDays: 30 });
        expect(dead.find(r => r.itemId === 'wheat')).toMatchObject({ daysSinceSale: 30, value: 3000 });
        const alive = findDeadStock({ stock, items, sources: sources(at(2026, 9, 23, 0, 1)), now: NOW, minDays: 30 });
        expect(alive.find(r => r.itemId === 'wheat')).toBeUndefined();
    });

    test('zero stock excluded, recently sold excluded, sorted by ₹ value', () => {
        const rows = findDeadStock({ stock, items, sources: sources(at(2026, 8, 1)), now: NOW, minDays: 30 });
        expect(rows.map(r => r.itemId)).toEqual(['wheat', 'chana']);
        expect(rows[1]).toMatchObject({ quantity: 10, rate: 60, value: 600, lastSaleAt: null, daysSincePurchase: 51 });
    });

    test('no sale inside a partial window → "> window", not "never"; uncertain when window < N', () => {
        const windowStart = at(2026, 9, 1, 0, 0); // 51 days loaded
        const rows = findDeadStock({ stock, items, sources: sources(at(2026, 8, 1)), now: NOW, minDays: 60, windowStart });
        const chana = rows.find(r => r.itemId === 'chana');
        expect(chana).toMatchObject({ saleBeyondWindow: true, neverSold: false, uncertain: true });
        expect(daysSinceLabel(chana.daysSinceSale, chana.saleBeyondWindow, localDaysBetween(windowStart, NOW))).toBe('> 51 days');
        const rows30 = findDeadStock({ stock, items, sources: sources(at(2026, 8, 1)), now: NOW, minDays: 30, windowStart });
        expect(rows30.find(r => r.itemId === 'chana').uncertain).toBe(false);
    });

    test('full history loaded and no sale → never sold', () => {
        const rows = findDeadStock({ stock, items, sources: sources(at(2026, 8, 1)), now: NOW, minDays: 30, windowStart: 0 });
        expect(rows.find(r => r.itemId === 'chana')).toMatchObject({ neverSold: true, saleBeyondWindow: false });
        expect(daysSinceLabel(null, false, Infinity)).toBe('never');
    });

    test('never sold but all stock bought less than N days ago → not dead yet', () => {
        const src = { purchases: [{ timestamp: at(2026, 10, 17), items: [{ itemId: 'chana', qty: 10 }] }] };
        expect(findDeadStock({ stock, items, sources: src, now: NOW, minDays: 30 }).find(r => r.itemId === 'chana')).toBeUndefined();
        // Partial window: 10 kg in stock but only 4 kg bought inside it → older stock is sitting there
        const partial = { purchases: [{ timestamp: at(2026, 10, 17), items: [{ itemId: 'chana', qty: 4 }] }] };
        expect(findDeadStock({ stock, items, sources: partial, now: NOW, minDays: 30, windowStart: at(2026, 9, 1, 0, 0) })
            .find(r => r.itemId === 'chana')).toMatchObject({ saleBeyondWindow: true, daysSincePurchase: 5 });
    });

    test('bills without a usable date are ignored', () => {
        const rows = findDeadStock({
            stock, items, now: NOW, minDays: 30,
            sources: { wholesaleSales: [{ items: [{ itemId: 'chana' }] }] }
        });
        expect(rows.find(r => r.itemId === 'chana').lastSaleAt).toBeNull();
    });
});
