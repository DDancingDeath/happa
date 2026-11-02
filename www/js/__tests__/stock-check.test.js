/**
 * @fileoverview Tests for the stock-availability check used by retail and
 * wholesale sale flows.
 *
 * The helper has to (a) resolve each sale line to the canonical catalogue
 * key the same way calculateStock does, (b) aggregate quantity across
 * multi-line bills, and (c) look up on-hand stock across legacy keys
 * (itemId, name, hindiName). These tests pin each of those behaviours
 * against scenarios drawn from real bills.
 */

import { AppState } from '../utils/state.js';
import {
    computeStockShortfalls,
    formatShortfallMessage,
} from '../utils/stock-check.js';

const GEHU = { id: 'item_gehu', name: 'Gehu', hindiName: 'गेहूं' };
const DAAL = { id: 'item_daal', name: 'Daal', hindiName: 'दाल' };

function resetState() {
    AppState.items = [GEHU, DAAL];
    AppState.stock = {};
}

describe('computeStockShortfalls', () => {
    beforeEach(resetState);

    test('returns empty when sale fits within stock', () => {
        AppState.stock = { [GEHU.id]: { quantity: 100, rate: 23 } };
        const shortfalls = computeStockShortfalls([
            { itemId: GEHU.id, name: GEHU.name, qty: 50 },
        ]);
        expect(shortfalls).toEqual([]);
    });

    test('flags a single oversold line', () => {
        AppState.stock = { [GEHU.id]: { quantity: 30, rate: 23 } };
        const shortfalls = computeStockShortfalls([
            { itemId: GEHU.id, name: GEHU.name, qty: 50 },
        ]);
        expect(shortfalls).toEqual([
            { name: 'Gehu', requested: 50, available: 30, shortfall: 20 },
        ]);
    });

    test('aggregates multiple lines for the same item before comparing', () => {
        AppState.stock = { [GEHU.id]: { quantity: 60, rate: 23 } };
        // Each line fits within stock individually, but together they overshoot.
        const shortfalls = computeStockShortfalls([
            { itemId: GEHU.id, name: GEHU.name, qty: 40 },
            { itemId: GEHU.id, name: GEHU.name, qty: 40 },
        ]);
        expect(shortfalls).toHaveLength(1);
        expect(shortfalls[0]).toMatchObject({
            requested: 80,
            available: 60,
            shortfall: 20,
        });
    });

    test('sums stock across itemId, name and Hindi name buckets', () => {
        AppState.stock = {
            [GEHU.id]: { quantity: 30, rate: 23 },
            [GEHU.name]: { quantity: 10, rate: 23 },
            [GEHU.hindiName]: { quantity: 5, rate: 23 },
        };
        const shortfalls = computeStockShortfalls([
            { itemId: GEHU.id, name: GEHU.name, qty: 40 },
        ]);
        expect(shortfalls).toEqual([]); // 30 + 10 + 5 = 45 ≥ 40
    });

    test('falls back to name resolution when itemId is missing', () => {
        AppState.stock = { [GEHU.id]: { quantity: 20, rate: 23 } };
        const shortfalls = computeStockShortfalls([
            { name: 'gehu', qty: 30 }, // case-insensitive match
        ]);
        expect(shortfalls).toHaveLength(1);
        expect(shortfalls[0].shortfall).toBe(10);
    });

    test('resolves to catalogue by Hindi name when name field is Hindi', () => {
        AppState.stock = { [GEHU.id]: { quantity: 20, rate: 23 } };
        const shortfalls = computeStockShortfalls([
            { name: 'गेहूं', qty: 30 },
        ]);
        expect(shortfalls).toHaveLength(1);
        expect(shortfalls[0].shortfall).toBe(10);
    });

    test('treats missing stock entry as zero available', () => {
        // No stock for GEHU at all
        const shortfalls = computeStockShortfalls([
            { itemId: GEHU.id, name: GEHU.name, qty: 5 },
        ]);
        expect(shortfalls).toEqual([
            { name: 'Gehu', requested: 5, available: 0, shortfall: 5 },
        ]);
    });

    test('reports per-item when multiple items are short', () => {
        AppState.stock = {
            [GEHU.id]: { quantity: 10, rate: 23 },
            [DAAL.id]: { quantity: 5, rate: 100 },
        };
        const shortfalls = computeStockShortfalls([
            { itemId: GEHU.id, name: 'Gehu', qty: 12 },
            { itemId: DAAL.id, name: 'Daal', qty: 8 },
        ]);
        expect(shortfalls).toHaveLength(2);
        expect(shortfalls.find((s) => s.name === 'Gehu').shortfall).toBe(2);
        expect(shortfalls.find((s) => s.name === 'Daal').shortfall).toBe(3);
    });

    test('accepts wholesale-style { quantity } as well as retail { qty }', () => {
        AppState.stock = { [GEHU.id]: { quantity: 10, rate: 23 } };
        const shortfalls = computeStockShortfalls([
            { itemId: GEHU.id, name: 'Gehu', quantity: 15 },
        ]);
        expect(shortfalls[0].shortfall).toBe(5);
    });

    test('ignores micro float noise (no spurious shortfall at exact match)', () => {
        AppState.stock = { [GEHU.id]: { quantity: 100, rate: 23 } };
        // floating sum equal to exactly 100 in the limit
        const shortfalls = computeStockShortfalls([
            { itemId: GEHU.id, name: 'Gehu', qty: 33.3 },
            { itemId: GEHU.id, name: 'Gehu', qty: 33.3 },
            { itemId: GEHU.id, name: 'Gehu', qty: 33.4 },
        ]);
        expect(shortfalls).toEqual([]);
    });

    test('handles empty / invalid input safely', () => {
        expect(computeStockShortfalls([])).toEqual([]);
        expect(computeStockShortfalls(null)).toEqual([]);
        expect(computeStockShortfalls(undefined)).toEqual([]);
    });

    test('does not flag when no stock entry exists but qty is zero', () => {
        const shortfalls = computeStockShortfalls([
            { itemId: GEHU.id, name: 'Gehu', qty: 0 },
        ]);
        expect(shortfalls).toEqual([]);
    });
});

describe('formatShortfallMessage', () => {
    test('returns null for an empty shortfall list', () => {
        expect(formatShortfallMessage([])).toBeNull();
        expect(formatShortfallMessage(null)).toBeNull();
    });

    test('includes item name, requested, available, and short amount', () => {
        const msg = formatShortfallMessage([
            { name: 'Gehu', requested: 50, available: 30, shortfall: 20 },
        ]);
        expect(msg).toContain('Gehu');
        expect(msg).toContain('selling 50 kg');
        expect(msg).toContain('only 30 kg');
        expect(msg).toContain('short 20 kg');
        expect(msg).toContain('Continue anyway?');
    });

    test('lists every shortfall on its own bullet', () => {
        const msg = formatShortfallMessage([
            { name: 'Gehu', requested: 50, available: 30, shortfall: 20 },
            { name: 'Daal', requested: 10, available: 5, shortfall: 5 },
        ]);
        expect(msg).toMatch(/Gehu/);
        expect(msg).toMatch(/Daal/);
        // Two bullet lines.
        expect(msg.match(/^•/gm)).toHaveLength(2);
    });
});
