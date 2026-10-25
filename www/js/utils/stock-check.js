/**
 * @fileoverview Stock availability check used before completing a sale.
 *
 * The check is intentionally informational rather than a hard block — an
 * aadhat will occasionally legitimately sell stock that has not yet
 * physically arrived (broker scenario), and we don't want to surprise the
 * user with a blocking error in that case. Instead we surface the shortfall
 * in a confirmation dialog so the user can decide explicitly.
 *
 * Aggregating by the same key-resolution rules used in calculateStock()
 * matters because a bill may have multiple line items for the same item
 * (e.g. two weight groups). Otherwise we would miss the case where each
 * individual line fits within stock but the sum does not.
 */
import { AppState } from '../utils/state.js';
import { formatDayTime } from './dates.js';
import { eventTime } from './stock-replay.js';

/**
 * "≈ approximate stock (updated <time>)" label (member device, stale stock
 * checkpoint; #129), shared by the Stock screen, wholesale and the bill checks.
 * @param {?{builtAt: number}} approx AppState.stockApprox
 * @returns {?{en: string, hi: string}} null when stock is exact
 */
export function approxStockNote(approx) {
    if (!approx) return null;
    const when = (lang) => (approx.builtAt > 0 ? formatDayTime(approx.builtAt, { lang }) : '—');
    return { en: `≈ approximate stock (updated ${when('en')})`, hi: `≈ अनुमानित स्टॉक (अपडेट ${when('hi')})` };
}

const normalize = (s) => (s == null ? '' : String(s).trim().toLowerCase());
// Legacy bill lines store the name as `item`.
const lineName = (item) => item.name || item.item;

/**
 * Find the catalogue entry for a line item: itemId first, then name or
 * Hindi name (same precedence calculateStock() uses). Null when unknown.
 *
 * @param {Object} item - sale line item ({ itemId?, name? })
 * @param {Array<Object>} items - item catalogue
 * @returns {Object | null}
 */
function findCatalogueEntry(item, items) {
    if (item.itemId) {
        const byId = items.find((i) => i.id === item.itemId);
        if (byId) return byId;
    }
    const target = normalize(lineName(item));
    if (!target) return null;
    return items.find((i) => normalize(i.name) === target || normalize(i.hindiName) === target) || null;
}

/**
 * Canonical stock key for a line item; unknown items bucket under their
 * normalized name so they still aggregate together.
 *
 * @param {Object} item
 * @param {Array<Object>} items
 * @returns {string}
 */
function resolveKey(item, items) {
    const found = findCatalogueEntry(item, items);
    if (found) return found.id;
    return normalize(lineName(item)) || (item.itemId || '__unknown__');
}

/**
 * On-hand quantity for an item across legacy keys (itemId, name, hindiName)
 * so stock still bucketed under an old key is not missed.
 *
 * @param {Object|null} catalogueEntry - resolved catalogue item or null
 * @param {string} fallbackName - the line item's name (for legacy buckets)
 * @param {Object} stock - stock map
 * @returns {number}
 */
function lookupAvailable(catalogueEntry, fallbackName, stock) {
    let qty = 0;
    if (catalogueEntry?.id && stock[catalogueEntry.id]) {
        qty += stock[catalogueEntry.id].quantity || 0;
    }
    const nameKey = fallbackName || catalogueEntry?.name;
    if (nameKey && stock[nameKey]) {
        qty += stock[nameKey].quantity || 0;
    }
    if (catalogueEntry?.hindiName && stock[catalogueEntry.hindiName]) {
        qty += stock[catalogueEntry.hindiName].quantity || 0;
    }
    return qty;
}

/**
 * Stock bucket key for a line item (catalogue id, else normalized name).
 * @param {Object} item
 * @param {Array<Object>} [items] - item catalogue
 * @returns {string}
 */
export function stockKeyFor(item, items = []) {
    return resolveKey(item || {}, Array.isArray(items) ? items : []);
}

const lineQty = (item) => parseFloat(item.qty ?? item.quantity) || 0;

/**
 * Per-item shortfalls for sale lines against a given stock snapshot (pure).
 * A bill may have several lines for the same item (e.g. two weight groups),
 * so quantities are aggregated per item before comparing.
 *
 * @param {Array<{itemId?: string, name?: string, qty?: number, quantity?: number}>} saleItems
 * @param {{items?: Array<Object>, stock?: Object, stockReady?: boolean}} snapshot
 * @param {Array<Object>} [credit] - lines already deducted from `stock` (the
 *   saved copy of a bill being edited); their quantities count as available
 * @returns {Array<{key: string, name: string, requested: number, available: number, shortfall: number}>}
 */
export function computeShortfallsFrom(saleItems, { items = [], stock = {}, stockReady = true } = {}, credit = []) {
    if (!Array.isArray(saleItems) || saleItems.length === 0) return [];
    // Stock is still being computed from full history: no reliable figure to warn against.
    if (stockReady === false) return [];
    const catalogue = Array.isArray(items) ? items : [];
    const stockMap = stock || {};

    const requestedByKey = new Map();
    for (const item of saleItems) {
        if (!item) continue;
        const key = resolveKey(item, catalogue);
        const prev = requestedByKey.get(key);
        if (prev) {
            prev.requested += lineQty(item);
        } else {
            const catalogueEntry = findCatalogueEntry(item, catalogue);
            requestedByKey.set(key, {
                key,
                name: lineName(item) || catalogueEntry?.name || key,
                catalogueEntry,
                requested: lineQty(item),
            });
        }
    }

    const credited = new Map();
    for (const item of Array.isArray(credit) ? credit : []) {
        if (!item) continue;
        const key = resolveKey(item, catalogue);
        credited.set(key, (credited.get(key) || 0) + lineQty(item));
    }

    const shortfalls = [];
    for (const row of requestedByKey.values()) {
        const available = lookupAvailable(row.catalogueEntry, row.name, stockMap) + (credited.get(row.key) || 0);
        if (row.requested > available + 1e-6) {
            shortfalls.push({
                key: row.key,
                name: row.name,
                requested: row.requested,
                available,
                shortfall: row.requested - available,
            });
        }
    }
    return shortfalls;
}

/**
 * Compute per-item shortfalls for a list of sale items against AppState.
 *
 * @param {Array<{itemId?: string, name?: string, qty?: number, quantity?: number}>} saleItems
 * @returns {Array<{name: string, requested: number, available: number, shortfall: number}>}
 *   list of items whose requested quantity exceeds on-hand stock (empty if all fit)
 */
export function computeStockShortfalls(saleItems) {
    return computeShortfallsFrom(saleItems, {
        items: AppState.items || [],
        stock: AppState.stock || {},
        stockReady: AppState.stockReady,
    }).map(({ name, requested, available, shortfall }) => ({ name, requested, available, shortfall }));
}

/**
 * Build a human-readable confirmation message describing all shortfalls.
 * Returns null when there are none.
 *
 * @param {ReturnType<typeof computeStockShortfalls>} shortfalls
 * @returns {string | null}
 */
export function formatShortfallMessage(shortfalls) {
    if (!shortfalls || shortfalls.length === 0) return null;
    const lines = shortfalls.map((s) => {
        const avail = s.available <= 0 ? '0' : s.available.toFixed(1);
        return `• ${s.name}: selling ${s.requested.toFixed(1)} kg, only ${avail} kg in stock (short ${s.shortfall.toFixed(1)} kg)`;
    });
    return (
        'This sale exceeds your recorded stock:\n\n' +
        lines.join('\n') +
        '\n\nSelling more than you have on record will push stock into negative ' +
        'and may distort future rate calculations. Continue anyway?'
    );
}

/**
 * When each item first had stock: its first purchase line or add / set stock
 * adjustment with a quantity > 0 (opening stock counts). An item that was only
 * ever sold has never had its stock set, so "low stock" and "sold more than
 * stock" mean nothing for it yet. Opening records (old-app dues) carry no goods.
 * @param {{purchases?: Array, stockAdjustments?: Array}} sources
 * @param {Array<Object>} [items] catalogue
 * @returns {Map<string, number>} stock key → earliest time (ms)
 */
export function firstStockTimes({ purchases = [], stockAdjustments = [] } = {}, items = []) {
    const catalogue = Array.isArray(items) ? items : [];
    const out = new Map();
    const note = (key, t) => {
        const ms = Number.isFinite(t) ? t : -Infinity;
        if (!out.has(key) || ms < out.get(key)) out.set(key, ms);
    };
    (purchases || []).forEach(bill => {
        if (!bill || bill.openingBalance) return;
        const t = eventTime(bill);
        (Array.isArray(bill.items) ? bill.items : []).forEach(line => {
            if (line && lineQty(line) > 0) note(resolveKey(line, catalogue), t);
        });
    });
    (stockAdjustments || []).forEach(adj => {
        if (!adj || !['add', 'set'].includes(adj.adjustType) || !(parseFloat(adj.quantity) > 0)) return;
        note(resolveKey({ itemId: adj.itemId, name: adj.itemName }, catalogue), eventTime(adj));
    });
    return out;
}

/**
 * Stock keys of items that have ever had stock (see firstStockTimes). Items with
 * stock on hand or a cost in `stock` count too: their purchase may be older
 * than the history loaded on this device.
 * @param {{purchases?: Array, stockAdjustments?: Array}} sources
 * @param {Array<Object>} [items]
 * @param {Object} [stock] AppState.stock
 * @returns {Set<string>}
 */
export function stockedItemKeys(sources, items = [], stock = {}) {
    const keys = new Set(firstStockTimes(sources, items).keys());
    Object.entries(stock || {}).forEach(([key, s]) => {
        if ((Number(s?.quantity) || 0) > 0 || (Number(s?.rate) || 0) > 0) keys.add(key);
    });
    return keys;
}
/**
 * Low-stock alert rows: catalogue items whose stock has been set at some
 * point and is now below `threshold` kg, named in the app language. Stock
 * buckets that match no catalogue item are left out (no raw ids on screen).
 * @param {Object} stock AppState.stock ({ [key]: { quantity } })
 * @param {Array<Object>} items catalogue
 * @param {Set<string>} stocked from stockedItemKeys()
 * @param {{lang?: string, threshold?: number}} [opts]
 * @returns {Array<{key: string, name: string, quantity: number}>} lowest first
 */
export function lowStockItems(stock, items, stocked, { lang = 'en', threshold = 10 } = {}) {
    const catalogue = Array.isArray(items) ? items : [];
    const out = [];
    Object.entries(stock || {}).forEach(([key, data]) => {
        const item = catalogue.find(i => i.id === key)
            || catalogue.find(i => normalize(i.name) === normalize(key) || normalize(i.hindiName) === normalize(key));
        if (!item) return;
        const q = Number(data?.quantity) || 0;
        if (q >= threshold || !(stocked.has(item.id) || stocked.has(key))) return;
        out.push({ key: item.id, name: (lang === 'hi' && item.hindiName) ? item.hindiName : item.name, quantity: q });
    });
    return out.sort((a, b) => a.quantity - b.quantity || a.name.localeCompare(b.name));
}
