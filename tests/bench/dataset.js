/**
 * The benchmark's shop (#59): tests/fixtures/generator.js's multi-year history
 * (seasonal items, credit and part payments, legacy money and date shapes),
 * ending today, as the dev_ documents the app reads on localhost. Every record
 * gets what the current app writes on save and the dues listener needs: a
 * numeric `timestamp` and, on bills, `openDue`; nothing else is changed.
 */
import { generateShop } from '../fixtures/generator.js';
import { outstandingDue } from '../../www/js/utils/money.js';

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');

/** Local ms of a stored date: ISO date-time, 'YYYY-MM-DD', or 'DD/MM/YYYY[, h:mm:ss am]'. */
export function dateMs(value) {
    const s = String(value || '');
    let m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?/i.exec(s);
    if (!m) return null;
    let h = +(m[4] || 0);
    if (m[7] && m[7].toLowerCase() === 'pm' && h !== 12) h += 12;
    if (m[7] && m[7].toLowerCase() === 'am' && h === 12) h = 0;
    return new Date(+m[3], +m[2] - 1, +m[1], h, +(m[5] || 0), +(m[6] || 0)).getTime();
}

/** A bill still owes something: the app's own rule (BILL-DUE, `outstandingDue`), as `openDue` is saved. */
export function openDue(bill) {
    return outstandingDue(bill) > 0;
}

/**
 * @param {{years?: number, activity?: number, seed?: number, today?: Date}} [opts]
 * @returns {{writes: Array<[string, string, Object]>, counts: Object<string, number>}}
 */
export function benchDataset({ years = 3, activity = 2, seed = 59, today = new Date() } = {}) {
    const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - Math.round(years * 365));
    const start = `${first.getFullYear()}-${pad(first.getMonth() + 1)}-${pad(first.getDate())}`;
    const shop = generateShop({ seed, years, start, activity });
    const now = today.getTime();
    const writes = [];
    const counts = {};
    const add = (coll, rec, { bill = false } = {}) => {
        const t = typeof rec.timestamp === 'number' ? rec.timestamp : dateMs(rec.date);
        if (t === null || t > now + DAY) return;
        const doc = { ...rec, timestamp: t };
        if (bill) doc.openDue = openDue(doc);
        writes.push([`dev_${coll}`, String(rec.id), doc]);
        counts[coll] = (counts[coll] || 0) + 1;
    };
    shop.items.forEach(i => writes.push(['dev_items', i.id, i]));
    shop.purchases.forEach(b => add('purchases', b, { bill: true }));
    shop.retailSales.forEach(b => add('retailSales', b, { bill: true }));
    shop.wholesaleSales.forEach(b => add('wholesaleSales', b, { bill: true }));
    shop.stockAdjustments.forEach(r => add('stockAdjustments', r));
    shop.expenses.forEach(r => add('expenses', r));
    shop.withdrawals.forEach(r => add('withdrawals', r));
    shop.sessions.forEach(s => {
        writes.push(['dev_cashManagement', String(s.id), { ...s, signedOut: s.date < toDay(today), counted: true }]);
        counts.cashManagement = (counts.cashManagement || 0) + 1;
    });
    return { writes, counts };
}

const toDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
