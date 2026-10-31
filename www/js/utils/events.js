/**
 * @fileoverview A tiny in-page event bus (docs/architecture.md, phase 4): the data
 * layer says what changed (`emit`), pages decide what to redraw (`on`). It replaces
 * firestore-service.js calling page methods through `window.app`.
 *
 * Events the data layer emits (firebase/firestore-service.js):
 *  - `REFRESH[view]` (`refresh:<view>`): data shown by that view changed. Emitted
 *    after the 150 ms debounce, once the view's tab is open (views in a hidden tab
 *    wait until it is shown), exactly when the view used to be re-rendered.
 *  - `ITEM_FREQUENCY_CHANGED`: the shared item order (`itemFrequency/global`)
 *    changed; payload: the document's data.
 * @module utils/events
 */

/** View names (firestore-service.js VIEWS) → their refresh event. */
export const REFRESH = Object.freeze(Object.fromEntries([
    'itemsList', 'itemsTable', 'billingDropdown', 'salesDropdown', 'wholesaleHistory', 'wholesaleOutstanding',
    'history', 'due', 'stockAdjustmentHistory', 'stockView', 'expensesHistory', 'money', 'insights', 'statements'
].map(view => [view, `refresh:${view}`])));

export const ITEM_FREQUENCY_CHANGED = 'itemFrequency:changed';

/**
 * Firestore refused a call with permission-denied (firebase/firestore-meter.js);
 * payload: its source label ("purchases (doc) update", "batch commit"…) and the
 * error (callers mark one the app expects with `aadhatExpected`). #124.
 */
export const FIRESTORE_DENIED = 'firestore:denied';

const handlers = new Map();

/**
 * Subscribes to an event.
 * @param {string} name
 * @param {Function} fn
 * @returns {Function} unsubscribe
 */
export function on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, []);
    handlers.get(name).push(fn);
    return () => off(name, fn);
}

/**
 * @param {string} name
 * @param {Function} fn
 */
export function off(name, fn) {
    const list = handlers.get(name);
    if (!list) return;
    const at = list.indexOf(fn);
    if (at !== -1) list.splice(at, 1);
}

/**
 * Calls the event's handlers in the order they subscribed. A handler that throws
 * is logged and the others still run.
 * @param {string} name
 * @param {...*} args
 * @returns {number} how many handlers ran
 */
export function emit(name, ...args) {
    const list = [...(handlers.get(name) || [])];
    list.forEach(fn => {
        try {
            fn(...args);
        } catch (e) {
            console.error(`Event handler error (${name}):`, e);
        }
    });
    return list.length;
}
