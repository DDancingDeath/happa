/**
 * @fileoverview Dead stock: items with stock on hand but no sale in N days
 * (#48). Pure functions; works only on the records already loaded in
 * AppState (the history window), so it never reads extra history. When an
 * item has no sale inside the loaded window the last sale is reported as
 * "older than the window" instead of being looked up.
 * @module utils/dead-stock
 */

import { createItemKeyResolver, eventTime } from './stock-replay.js';
import { startOfLocalDay } from './dates.js';
import { itemValue } from './calc/stock.js';
import { t } from '../i18n/index.js';

/** Day thresholds offered in the selector. */
export const DEAD_STOCK_DAY_OPTIONS = [30, 60, 90];
export const DEFAULT_DEAD_STOCK_DAYS = 30;

const MIN_QTY = 0.001;

/**
 * Whole local calendar days from `fromMs` to `toMs` (IST day boundaries;
 * a sale at 23:59 yesterday is 1 day ago at 00:01 today).
 * @param {number} fromMs
 * @param {number} toMs
 * @returns {number}
 */
export function localDaysBetween(fromMs, toMs) {
    const a = startOfLocalDay(fromMs);
    const b = startOfLocalDay(toMs);
    if (!a || !b) return NaN;
    return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * Latest sale, latest purchase, first purchase and kg purchased per catalogue
 * item id in the loaded bills. Wholesale and retail sales both count as
 * sales (they both move stock).
 * @param {{purchases?: Array, wholesaleSales?: Array, retailSales?: Array}} sources
 * @param {Array<Object>} items catalogue
 * @returns {{sale: Object.<string, number>, purchase: Object.<string, number>,
 *   firstPurchase: Object.<string, number>, purchasedQty: Object.<string, number>}}
 */
export function lastActivityByItem(sources, items) {
    const getKey = createItemKeyResolver(items);
    const sale = {};
    const purchase = {};
    const firstPurchase = {};
    const purchasedQty = {};
    const eachLine = (bills, fn) => (bills || []).forEach(bill => {
        if (!bill || !Array.isArray(bill.items)) return;
        const t = eventTime(bill);
        if (!Number.isFinite(t) || t === Number.MAX_SAFE_INTEGER) return;
        bill.items.forEach(line => {
            if (line) fn(getKey({ itemId: line.itemId, name: line.name || line.itemName }), t, line);
        });
    });
    const onSale = (key, t) => { if (!(sale[key] >= t)) sale[key] = t; };
    eachLine(sources?.wholesaleSales, onSale);
    eachLine(sources?.retailSales, onSale);
    eachLine(sources?.purchases, (key, t, line) => {
        if (!(purchase[key] >= t)) purchase[key] = t;
        if (!(firstPurchase[key] <= t)) firstPurchase[key] = t;
        purchasedQty[key] = (purchasedQty[key] || 0) + (parseFloat(line.qty || line.quantity) || 0);
    });
    return { sale, purchase, firstPurchase, purchasedQty };
}

/**
 * Items with stock on hand and no sale in the last `minDays` days, sorted
 * by stock value (highest first).
 *
 * `windowStart` is the start of the loaded history (ms; 0 = everything is
 * loaded). An item with no sale in the loaded data gets `saleBeyondWindow`
 * (shown as "> window") — or `neverSold` when the full history is loaded.
 * `uncertain` marks rows where the loaded window is shorter than `minDays`,
 * so an older sale inside the threshold can't be ruled out. Items that were
 * never sold but whose stock all arrived less than `minDays` ago are skipped
 * (too new to call dead).
 *
 * @param {Object} args
 * @param {Object.<string, {quantity: number, rate: number}>} args.stock keyed by item id
 * @param {Array<Object>} args.items catalogue
 * @param {Object} args.sources loaded purchases / wholesaleSales / retailSales
 * @param {number} args.now ms
 * @param {number} [args.minDays=30]
 * @param {number} [args.windowStart=0]
 * @returns {Array<Object>}
 */
export function findDeadStock({ stock, items, sources, now, minDays = DEFAULT_DEAD_STOCK_DAYS, windowStart = 0 }) {
    const full = !(windowStart > 0);
    const windowDays = full ? Infinity : localDaysBetween(windowStart, now);
    const { sale, purchase, firstPurchase, purchasedQty } = lastActivityByItem(sources, items);
    const rows = [];
    (items || []).forEach(item => {
        const entry = stock?.[item.id];
        const quantity = Number(entry?.quantity) || 0;
        if (quantity <= MIN_QTY) return;
        const rate = Number(entry?.rate) || 0;
        const lastSaleAt = sale[item.id] ?? null;
        const daysSinceSale = lastSaleAt === null ? null : localDaysBetween(lastSaleAt, now);
        if (daysSinceSale !== null && daysSinceSale < minDays) return;
        // No sale yet, but all the stock came in less than N days ago: too new to call dead.
        // (With a partial window, stock above what was bought in it is older stock.)
        if (lastSaleAt === null && firstPurchase[item.id] !== undefined
            && localDaysBetween(firstPurchase[item.id], now) < minDays
            && (full || quantity <= (purchasedQty[item.id] || 0) + MIN_QTY)) return;
        const lastPurchaseAt = purchase[item.id] ?? null;
        rows.push({
            itemId: item.id,
            name: item.name || '',
            hindiName: item.hindiName || '',
            quantity,
            rate,
            value: itemValue({ quantity, rate }),
            lastSaleAt,
            daysSinceSale,
            saleBeyondWindow: lastSaleAt === null && !full,
            neverSold: lastSaleAt === null && full,
            uncertain: lastSaleAt === null && windowDays < minDays,
            lastPurchaseAt,
            daysSincePurchase: lastPurchaseAt === null ? null : localDaysBetween(lastPurchaseAt, now),
            purchaseBeyondWindow: lastPurchaseAt === null && !full
        });
    });
    return rows.sort((a, b) => (b.value - a.value) || a.name.localeCompare(b.name));
}

/**
 * Label for "days since" cells.
 * @param {number|null} days
 * @param {boolean} beyondWindow
 * @param {number} windowDays whole days covered by the loaded data
 * @returns {string}
 */
export function daysSinceLabel(days, beyondWindow, windowDays) {
    if (days !== null && days !== undefined) return days === 0 ? t('ui.deadstock.today') : t('ui.deadstock.n_days', { n: days });
    if (beyondWindow) return Number.isFinite(windowDays) ? t('ui.deadstock.over_n_days', { n: windowDays }) : t('ui.deadstock.beyond_window');
    return t('ui.deadstock.never');
}
