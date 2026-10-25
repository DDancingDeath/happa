/**
 * @fileoverview Pure stock replay (weighted-average cost with deficit rules).
 *
 * Stock is computed by replaying every purchase, sale (wholesale + retail) and
 * stock adjustment in chronological order. The replay can start from a saved
 * running state (a "stock checkpoint" taken at time `asOf`) and only replay the
 * events with t >= asOf; because events are applied strictly in order and the
 * running state is exactly what the full replay holds at that point, the result
 * is identical to a full replay over all history.
 *
 * Nothing here touches Firestore or AppState.
 * @module utils/stock-replay
 */

import { Helpers } from './helpers.js';
import { isOpeningRecord } from './money.js';

/** Bump when the replay rules or the checkpoint layout change. */
export const STOCK_REPLAY_FORMAT = 3;

const normalize = (s) => (s == null ? '' : String(s).trim().toLowerCase());

/**
 * Resolve a sortable timestamp (ms since epoch) for a record. Prefers the
 * numeric `timestamp` field, then a Firestore Timestamp with `.toMillis()`,
 * then the `date` field parsed via Helpers.parseDate. Records with no
 * resolvable time sort last (Number.MAX_SAFE_INTEGER).
 * @param {Object} record
 * @returns {number}
 */
export function eventTime(record) {
    if (!record) return Number.MAX_SAFE_INTEGER;
    if (typeof record.timestamp === 'number') return record.timestamp;
    if (record.timestamp && typeof record.timestamp.toMillis === 'function') {
        return record.timestamp.toMillis();
    }
    const parsed = Helpers.parseDate(record.date);
    return parsed ? parsed.getTime() : Number.MAX_SAFE_INTEGER;
}

/**
 * Builds the item-key resolver used by the replay. Resolves to a canonical
 * catalogue id whenever possible, falling back to a case-insensitive,
 * whitespace-trimmed match on `name`/`hindiName` (first catalogue entry wins),
 * and finally to the normalized name itself.
 * @param {Array<{id: string, name?: string, hindiName?: string}>} items
 * @returns {(item: {itemId?: *, name?: string}) => string}
 */
export function createItemKeyResolver(items) {
    const catalogueIds = new Set();
    const idByName = new Map();
    (items || []).forEach(i => {
        catalogueIds.add(i.id);
        const n = normalize(i.name);
        if (!idByName.has(n)) idByName.set(n, i.id);
        const h = normalize(i.hindiName);
        if (!idByName.has(h)) idByName.set(h, i.id);
    });
    return (item) => {
        if (item.itemId) {
            if (catalogueIds.has(item.itemId)) return item.itemId;
            // itemId points to a deleted catalogue entry — fall through to name matching.
        }
        const target = normalize(item.name);
        if (target && idByName.has(target)) {
            return idByName.get(target);
        }
        return target || (item.itemId || '__unknown__');
    };
}

/**
 * Signature of the catalogue fields that affect key resolution (ids and
 * normalized names, in order). Equal signatures => identical resolution.
 * @param {Array<Object>} items
 * @returns {string}
 */
export function itemsSignature(items) {
    const text = JSON.stringify((items || []).map(i => [i.id, normalize(i.name), normalize(i.hindiName)]));
    // FNV-1a (two lanes) keeps the stored value short.
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    return `${(items || []).length}:${h1.toString(36)}:${h2.toString(36)}:${text.length}`;
}

/**
 * Builds the chronological event list. Insertion order (purchases, wholesale
 * sales, retail sales, adjustments; each in array order) breaks timestamp ties
 * via the stable sort, exactly like the historical calculateStock().
 * @param {{purchases?: Array, wholesaleSales?: Array, retailSales?: Array, stockAdjustments?: Array}} sources
 * @param {{from?: number, to?: number}} [range] include events with from <= t < to
 * @returns {Array<{t: number, kind: string, item?: Object, bill?: Object, source?: string, adj?: Object}>}
 */
export function collectEvents(sources, { from = -Infinity, to = Infinity } = {}) {
    const events = [];
    const inRange = (t) => t >= from && t < to;
    const addBills = (bills, kind, source) => (bills || []).forEach(bill => {
        if (!Array.isArray(bill.items) || isOpeningRecord(bill)) return;
        const t = eventTime(bill);
        if (!inRange(t)) return;
        bill.items.forEach(item => events.push({ t, kind, item, bill, source }));
    });
    addBills(sources.purchases, 'purchase', 'purchase');
    addBills(sources.wholesaleSales, 'sale', 'wholesale');
    addBills(sources.retailSales, 'sale', 'retail');
    (sources.stockAdjustments || []).forEach(adj => {
        const t = eventTime(adj);
        if (inRange(t)) events.push({ t, kind: 'adjustment', adj });
    });
    events.sort((a, b) => a.t - b.t);
    return events;
}

/**
 * Deep-copies a running state ({key: {quantity, rate, totalValue}}).
 * @param {Object} state
 * @returns {Object}
 */
export function cloneState(state) {
    const copy = {};
    Object.keys(state || {}).forEach(k => {
        const s = state[k];
        copy[k] = { quantity: s.quantity, rate: s.rate || 0, totalValue: s.totalValue };
    });
    return copy;
}

/**
 * Applies sorted events to a running state in place.
 *
 * `totalValue` is the cost basis of stock currently on hand; it is clamped to
 * 0 whenever the running quantity is <= 0, and a purchase that lifts a
 * negative position back above zero only carries the excess at the purchase
 * rate (the deficit is sunk cost). See the historical comments in
 * FirebaseService.calculateStock for the rationale of each rule.
 *
 * @param {Object} stock running state, mutated
 * @param {Array} events sorted events from collectEvents()
 * @param {Function} getItemKey resolver from createItemKeyResolver()
 * @param {Map<string, Array>} [resolutions] optional: records every distinct
 *   (itemId, normalized name) -> key resolution used
 * @returns {Object} the same state object
 */
export function replayEvents(stock, events, getItemKey, resolutions) {
    const keyOf = (input) => {
        const key = getItemKey(input);
        if (resolutions) {
            const id = input.itemId ? input.itemId : null;
            const name = normalize(input.name);
            const tag = `${typeof id}\u0000${id}\u0000${name}`;
            if (!resolutions.has(tag)) resolutions.set(tag, [id, name, key]);
        }
        return key;
    };
    for (const ev of events) {
        if (ev.kind === 'purchase') {
            const key = keyOf(ev.item);
            if (!stock[key]) stock[key] = { quantity: 0, rate: 0, totalValue: 0 };
            const qty = parseFloat(ev.item.qty || ev.item.quantity) || 0;
            const rate = parseFloat(ev.item.rate) || 0;
            const prevQty = stock[key].quantity;
            const newQty = prevQty + qty;
            stock[key].quantity = newQty;
            if (newQty <= 0) {
                stock[key].totalValue = 0;
            } else if (prevQty < 0) {
                stock[key].totalValue = newQty * rate;
            } else {
                stock[key].totalValue += qty * rate;
            }
        } else if (ev.kind === 'sale') {
            const key = keyOf(ev.item);
            if (!stock[key]) stock[key] = { quantity: 0, rate: 0, totalValue: 0 };
            const qty = parseFloat(ev.item.qty || ev.item.quantity) || 0;
            const prevQty = stock[key].quantity;
            const avgRate = prevQty > 0 ? stock[key].totalValue / prevQty : 0;
            const newQty = prevQty - qty;
            stock[key].quantity = newQty;
            if (newQty <= 0) {
                stock[key].totalValue = 0;
            } else {
                stock[key].totalValue -= qty * avgRate;
            }
        } else if (ev.kind === 'adjustment') {
            const adj = ev.adj;
            const key = keyOf({ itemId: adj.itemId, name: adj.itemName });
            if (!key) continue;
            if (!stock[key]) stock[key] = { quantity: 0, rate: 0, totalValue: 0 };

            const adjQty = parseFloat(adj.quantity) || 0;
            const adjRate = parseFloat(adj.rate) || 0;

            switch (adj.adjustType) {
                case 'add': {
                    const prevQty = stock[key].quantity;
                    const newQty = prevQty + adjQty;
                    stock[key].quantity = newQty;
                    if (newQty <= 0) {
                        stock[key].totalValue = 0;
                    } else if (prevQty < 0) {
                        stock[key].totalValue = adjRate > 0 ? newQty * adjRate : 0;
                    } else if (adjRate > 0) {
                        stock[key].totalValue += adjQty * adjRate;
                    }
                    break;
                }
                case 'remove': {
                    // A removal can never take stock below zero (#72): it
                    // removes at most what is on hand.
                    const prevQty = stock[key].quantity;
                    const removed = Math.min(adjQty, Math.max(0, prevQty));
                    const newQty = prevQty - removed;
                    stock[key].quantity = newQty;
                    if (newQty <= 0 || prevQty <= 0) {
                        stock[key].totalValue = 0;
                    } else {
                        const removalRatio = removed / prevQty;
                        stock[key].totalValue -= stock[key].totalValue * removalRatio;
                    }
                    break;
                }
                case 'set': {
                    const newQty = adjQty;
                    const prevQty = stock[key].quantity;
                    const prevTotal = stock[key].totalValue;
                    stock[key].quantity = newQty;
                    if (newQty <= 0) {
                        stock[key].totalValue = 0;
                    } else if (adjRate > 0) {
                        stock[key].totalValue = newQty * adjRate;
                    } else {
                        const currentAvgRate = prevQty > 0 && prevTotal > 0 ? prevTotal / prevQty : 0;
                        stock[key].totalValue = newQty * currentAvgRate;
                    }
                    break;
                }
            }
        }
    }
    return stock;
}

/**
 * Same as replayEvents() (it is used for every step), but reports how each
 * event changed the stock value: for a sale, -delta is the cost of the goods
 * sold at the weighted-average cost at that moment (#215).
 * @param {Object} stock running state, mutated
 * @param {Array} events sorted events from collectEvents()
 * @param {Function} getItemKey resolver from createItemKeyResolver()
 * @param {(ev: Object, key: string, delta: number, prevQty: number) => void} onEvent
 *   prevQty = quantity on hand just before the event
 * @returns {Object} the same state object
 */
export function replayWithValues(stock, events, getItemKey, onEvent) {
    for (const ev of events) {
        const key = ev.kind === 'adjustment'
            ? getItemKey({ itemId: ev.adj.itemId, name: ev.adj.itemName })
            : getItemKey(ev.item);
        const before = stock[key] ? stock[key].totalValue : 0;
        const prevQty = stock[key] ? stock[key].quantity : 0;
        replayEvents(stock, [ev], getItemKey);
        const after = stock[key] ? stock[key].totalValue : 0;
        onEvent(ev, key, after - before, prevQty);
    }
    return stock;
}

/**
 * Value of the stock on hand in a running state (items with quantity <= 0
 * carry no value).
 * @param {Object} state
 * @returns {number}
 */
export function stateValue(state) {
    let total = 0;
    Object.keys(state || {}).forEach(k => {
        const s = state[k];
        if (s.quantity > 0 && s.totalValue > 0) total += s.totalValue;
    });
    return total;
}

/**
 * Converts a running state into the public stock object ({quantity, rate}).
 * @param {Object} state running state (not mutated)
 * @returns {Object.<string, {quantity: number, rate: number}>}
 */
export function finalizeStock(state) {
    const stock = {};
    Object.keys(state).forEach(key => {
        const s = state[key];
        stock[key] = {
            quantity: s.quantity,
            rate: s.quantity > 0 && s.totalValue > 0 ? s.totalValue / s.quantity : 0
        };
    });
    return stock;
}

/**
 * Full replay over all history (the historical calculateStock behaviour).
 * @param {Object} sources see collectEvents()
 * @param {Array} items catalogue
 * @returns {Object.<string, {quantity: number, rate: number}>}
 */
export function computeStock(sources, items) {
    const state = replayEvents({}, collectEvents(sources), createItemKeyResolver(items));
    return finalizeStock(state);
}

/**
 * Replay starting from a checkpoint: `state` is the running state after every
 * event with t < asOf; only events with t >= asOf are replayed from `sources`
 * (older records in `sources` are ignored).
 * @param {Object} state checkpoint running state (not mutated)
 * @param {number} asOf
 * @param {Object} sources
 * @param {Array} items
 * @returns {Object.<string, {quantity: number, rate: number}>}
 */
export function computeStockFrom(state, asOf, sources, items) {
    const running = replayEvents(cloneState(state), collectEvents(sources, { from: asOf }), createItemKeyResolver(items));
    return finalizeStock(running);
}

/**
 * Running state after every event with t < asOf (what a checkpoint stores),
 * plus the key resolutions it relied on.
 * @param {Object} sources must contain every record with t < asOf
 * @param {number} asOf
 * @param {Array} items
 * @param {{state?: Object, from?: number}} [base] optional earlier checkpoint
 *   to roll forward from (then only events with base.from <= t < asOf replay)
 * @returns {{state: Object, resolutions: Array<Array>}}
 */
export function buildCheckpointState(sources, asOf, items, base = null) {
    const resolutions = new Map();
    const from = base ? base.from : -Infinity;
    const state = replayEvents(
        cloneState(base ? base.state : {}),
        collectEvents(sources, { from, to: asOf }),
        createItemKeyResolver(items),
        resolutions
    );
    return { state, resolutions: [...resolutions.values()] };
}

/**
 * True when the catalogue still resolves every recorded (itemId, name) pair to
 * the same key, i.e. a checkpoint built under another catalogue is still valid.
 * @param {Array<Array>} resolutions [[itemId|null, normalizedName, key], ...]
 * @param {Array} items current catalogue
 * @returns {boolean}
 */
export function resolutionsStillValid(resolutions, items) {
    if (!Array.isArray(resolutions)) return false;
    const getItemKey = createItemKeyResolver(items);
    return resolutions.every(r => Array.isArray(r) && getItemKey({ itemId: r[0], name: r[1] }) === r[2]);
}

/**
 * Serialises a running state for Firestore. Stored as an array because item
 * keys are arbitrary strings (e.g. '__unknown__' is a reserved field name).
 * @param {Object} state
 * @returns {Array<{k: string, q: number, v: number}>}
 */
export function serializeState(state) {
    return Object.keys(state).map(k => ({ k, q: state[k].quantity, v: state[k].totalValue }));
}

/**
 * Inverse of serializeState().
 * @param {Array} entries
 * @returns {Object|null} null when malformed
 */
export function deserializeState(entries) {
    if (!Array.isArray(entries)) return null;
    const state = {};
    for (const e of entries) {
        if (!e || typeof e.k !== 'string' || typeof e.q !== 'number' || typeof e.v !== 'number') return null;
        state[e.k] = { quantity: e.q, rate: 0, totalValue: e.v };
    }
    return state;
}

/**
 * Stock-relevant fingerprint of a bill/adjustment: its event time and the
 * fields the replay reads. Payment-only edits keep the same fingerprint.
 * @param {Object|null} record
 * @returns {string|null}
 */
export function stockFingerprint(record) {
    if (!record) return null;
    const pick = (o) => o && typeof o === 'object'
        ? [o.itemId ?? null, o.name ?? null, o.qty ?? null, o.quantity ?? null, o.rate ?? null]
        : null;
    return JSON.stringify([
        eventTime(record),
        Array.isArray(record.items) ? record.items.map(pick) : null,
        record.adjustType ?? null,
        record.adjustType !== undefined ? [record.itemId ?? null, record.itemName ?? null, record.quantity ?? null, record.rate ?? null] : null
    ]);
}

/**
 * Whether a change to a stock-affecting record invalidates a checkpoint taken
 * at `threshold`: true when either version's event time is before the
 * threshold and the stock-relevant fields changed. A missing old version of an
 * update/delete is unknown, so it invalidates conservatively.
 * @param {Object|null} oldRecord
 * @param {Object|null} newRecord
 * @param {number} threshold
 * @param {{oldUnknown?: boolean}} [opts] oldUnknown: the record existed but is not in memory
 * @returns {boolean}
 */
export function changeInvalidatesCheckpoint(oldRecord, newRecord, threshold, { oldUnknown = false } = {}) {
    if (oldUnknown && !oldRecord) return true;
    if (stockFingerprint(oldRecord) === stockFingerprint(newRecord)) return false;
    const before = (r) => !!r && eventTime(r) < threshold;
    return before(oldRecord) || before(newRecord);
}
