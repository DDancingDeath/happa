/**
 * @fileoverview Every stock figure on the Stock page and the stock value used
 * by Money › Worth (M15) and Insights (docs/calculations.md S1–S6, F6). Pure:
 * no DOM, no AppState, no Firestore. Quantities and average costs come from
 * the stock replay (utils/stock-replay.js, AVG-COST); this file only merges,
 * values and rounds them for the pages.
 * @module utils/calc/stock
 */

import { finalizeStock, stateValue } from '../stock-replay.js';

/** Function → its spec ID in docs/calculations.md. */
export const STOCK_SPEC = Object.freeze({
    stockRows: 'S1, S2',
    itemValue: 'S3',
    stockValue: 'S4, F6',
    adjustItemStock: 'S1, S2',
    adjustmentValue: 'S5',
    deadStockValue: 'S6',
    stockSummary: 'S7'
});

const normalize = (s) => (s == null ? '' : String(s).trim().toLowerCase());

/**
 * S1 / S2 per catalogue item: the replay's stock buckets merged onto the
 * catalogue (a bucket matches the first item whose id equals its key or whose
 * trimmed, lower-case English or Hindi name equals it), with the weighted
 * average rate of the merged buckets (AVG-COST). A bucket with no catalogue
 * match is its own "unmatched" row so the data stays visible. Rows: catalogue
 * items with quantity > 0 by name, then unmatched rows with any quantity
 * (|q| > 0.001, negative included).
 * @param {Object<string, {quantity: number, rate: number}>} stock FirebaseService.getStock()
 * @param {Array<{id: string, name: string, hindiName?: string}>} items catalogue
 * @returns {{rows: Array<{itemId: string, name: string, hindiName: string, quantity: number, rate: number, isOrphan?: boolean}>, orphanKeys: string[]}}
 */
export function stockRows(stock, items) {
    const catalogue = items || [];
    // Index the catalogue once; a key resolves to the first item (in array
    // order) whose id equals the key or whose normalized name/hindiName equals
    // the normalized key.
    const indexById = new Map();
    const indexByName = new Map();
    catalogue.forEach((i, idx) => {
        if (!indexById.has(i.id)) indexById.set(i.id, idx);
        const n = normalize(i.name);
        if (!indexByName.has(n)) indexByName.set(n, idx);
        const h = normalize(i.hindiName);
        if (!indexByName.has(h)) indexByName.set(h, idx);
    });
    const findCatalogueItem = (key) => {
        const byId = indexById.has(key) ? indexById.get(key) : Infinity;
        const nk = normalize(key);
        const byName = indexByName.has(nk) ? indexByName.get(nk) : Infinity;
        const idx = Math.min(byId, byName);
        return idx === Infinity ? undefined : catalogue[idx];
    };
    const merged = {};
    const orphanKeys = [];
    Object.keys(stock || {}).forEach(key => {
        const item = findCatalogueItem(key);
        const rowKey = item ? item.id : `__orphan__${key}`;
        if (!merged[rowKey]) {
            merged[rowKey] = item
                ? { itemId: item.id, name: item.name, hindiName: item.hindiName, quantity: 0, totalValue: 0, rate: 0 }
                : { itemId: rowKey, name: key, hindiName: '', quantity: 0, totalValue: 0, rate: 0, isOrphan: true };
        }
        merged[rowKey].quantity += stock[key].quantity || 0;
        merged[rowKey].totalValue += (stock[key].quantity || 0) * (stock[key].rate || 0);
        if (!item) orphanKeys.push(key);
    });
    const rates = finalizeStock(merged);
    const rows = Object.keys(merged).map(k => {
        const row = { ...merged[k], rate: rates[k].rate };
        delete row.totalValue;
        return row;
    })
        .filter(item => item.isOrphan ? Math.abs(item.quantity) > 0.001 : item.quantity > 0)
        .sort((a, b) => {
            if (a.isOrphan !== b.isOrphan) return a.isOrphan ? 1 : -1;
            return a.name.localeCompare(b.name);
        });
    return { rows, orphanKeys };
}

/**
 * S3: value of one item's stock, quantity × average rate (0 when there is no
 * stock on hand).
 * @param {{quantity: *, rate: *}} entry
 * @returns {number}
 */
export function itemValue(entry) {
    const quantity = Number(entry?.quantity) || 0;
    return quantity > 0 ? quantity * (Number(entry?.rate) || 0) : 0;
}

/**
 * S4 = F6: total value of the stock on hand. Takes the replay's running state
 * ({quantity, totalValue}: its value as replayed) or a stock / rows list
 * ({quantity, rate}: S3 of each); items with quantity ≤ 0 carry no value.
 * Money's stock (M15, M17) and the Stock page use this one function.
 * @param {Object|Array} stock
 * @returns {number}
 */
export function stockValue(stock) {
    const state = {};
    Object.keys(stock || {}).forEach(k => {
        const s = stock[k];
        state[k] = s && s.totalValue !== undefined ? s : { quantity: Number(s?.quantity) || 0, totalValue: itemValue(s) };
    });
    return stateValue(state);
}

/**
 * S1 / S2 for the Stock adjustment form: an item's quantity and its average
 * rate (null when nothing is in stock at a known cost).
 * @param {?{quantity: number, rate: number}} entry stock of the item (by catalogue id)
 * @returns {{quantity: number, avgRate: ?number}}
 */
export function adjustItemStock(entry) {
    const stockData = entry || {};
    const quantity = stockData.quantity || 0;
    const totalValue = quantity * (stockData.rate || 0);
    return { quantity, avgRate: quantity > 0 && totalValue > 0 ? totalValue / quantity : null };
}

/**
 * S5: value of a stock adjustment on its history card: its quantity × its own
 * rate, else the item's current average rate. null when the quantity is not
 * recorded or no rate is known.
 * @param {Object} adj stock adjustment
 * @param {Object<string, {rate: number}>} stock current stock (by item id, legacy: name)
 * @returns {{rate: number, value: ?number, rounded: ?number}} rate shown (0 = none), value and its whole rupees
 */
export function adjustmentValue(adj, stock) {
    const quantity = adj.quantity !== undefined ? adj.quantity : 'Unknown';
    const adjustmentRate = adj.rate || 0;
    const stockKey = adj.itemId || adj.itemName;
    const currentStockRate = stock?.[stockKey]?.rate || 0;
    const rate = adjustmentRate > 0 ? adjustmentRate : currentStockRate;
    const value = (quantity !== 'Unknown' && rate > 0) ? quantity * rate : null;
    return { rate, value, rounded: value === null ? null : Math.round(value) };
}

/**
 * S7: the Stock page summary: the rows in stock (S1 > 0, unmatched rows included, as
 * S4 values them) and their total kg.
 * @param {Array<{quantity: number}>} rows stockRows().rows
 * @returns {{items: number, kg: number}}
 */
export function stockSummary(rows) {
    let items = 0;
    let kg = 0;
    (rows || []).forEach(row => {
        const quantity = Number(row?.quantity) || 0;
        if (quantity <= 0) return;
        items += 1;
        kg += quantity;
    });
    return { items, kg };
}

/**
 * S6: value of the dead stock (Stock › Dead stock summary) = S4 of its rows.
 * @param {Array<{quantity: number, rate: number}>} rows findDeadStock()
 * @returns {number}
 */
export function deadStockValue(rows) {
    return stockValue(rows);
}
