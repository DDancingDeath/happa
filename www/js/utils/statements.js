/**
 * @fileoverview Statements (docs/insights-redesign.md §5.4): day book, party
 * ledger, item ledger and the CSV export, as plain rows. Pure: no DOM, no
 * Firestore. Totals come from the same rules as the pages (BILL-TOTAL,
 * BILL-AT-SAVE, DUE-PAY, AVG-COST), so a statement closes on the page's figure.
 * @module utils/statements
 */

import { billsInRange } from './finance-calc.js';
import { activityBills, billLabour, billTotal, isOpeningRecord, isOnlineExpense, isPersonalExpense, openingAmount, outstandingDue, readLineItem, round2 } from './money.js';
import { saleTimePayment, entryParts, entryTime, dueEvents } from './due-payments.js';
import { collectEvents, createItemKeyResolver, replayWithValues, eventTime } from './stock-replay.js';
import { normalizePartyName } from './aging.js';
import { parseAnyBillDate } from './dates.js';

const num = (v) => {
    const x = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(x) ? x : 0;
};
const timeOf = (bill) => {
    const t = eventTime(bill);
    return Number.isFinite(t) && t !== Number.MAX_SAFE_INTEGER ? t : null;
};
const recTime = (rec) => parseAnyBillDate(rec?.date)?.getTime() ?? null;
const billNo = (b) => String(b?.billNumber || b?.billNo || '');
const partyOf = (b) => String(b?.customerName ?? b?.supplierName ?? '').trim();

/**
 * Day book (ST1): every bill, expense, withdrawal and due payment of [from, to), in time order.
 * Due payments come from the bills and the range's cash-session legs (de-duplicated by id, as M12).
 * @param {Object} src {purchases, wholesaleSales, retailSales, expenses, withdrawals}
 * @param {{from: number, to: number}} range
 * @param {{personal?: boolean, sessions?: Array}} [opts] personal: false leaves personal expenses out (no personalExpenses permission)
 * @returns {{rows: Array<{t: ?number, kind: string, billNo: string, party: string, amount: number, cash: number, online: number, due: number, note: string}>,
 *   totals: {sales: number, purchases: number, expenses: number, withdrawals: number, dueReceived: number, duePaid: number, salesCount: number, purchaseCount: number}}}
 */
export function dayBook(src, { from, to }, { personal = true, sessions = [] } = {}) {
    const rows = [];
    const totals = { sales: 0, purchases: 0, expenses: 0, withdrawals: 0, dueReceived: 0, duePaid: 0, salesCount: 0, purchaseCount: 0 };
    const addBills = (list, kind) => billsInRange(list || [], from, to).forEach(b => {
        const p = saleTimePayment(b);
        const total = billTotal(b);
        rows.push({ t: timeOf(b), kind, billNo: billNo(b), party: partyOf(b), amount: total, cash: p.cash, online: p.online, due: round2(Math.max(0, total - p.cash - p.online)), note: '' });
        if (kind === 'purchase') { totals.purchases += total; totals.purchaseCount++; } else { totals.sales += total; totals.salesCount++; }
    });
    addBills(src.purchases, 'purchase');
    addBills(src.retailSales, 'retail');
    addBills(src.wholesaleSales, 'wholesale');
    (src.expenses || []).forEach(e => {
        const t = recTime(e);
        if (t === null || t < from || t >= to) return;
        if (!personal && isPersonalExpense(e)) return;
        const amount = num(e.amount);
        const online = isOnlineExpense(e);
        rows.push({ t, kind: isPersonalExpense(e) ? 'personal' : 'expense', billNo: '', party: String(e.personName || '').trim(), amount, cash: online ? 0 : amount, online: online ? amount : 0, due: 0, note: [e.type, e.remarks].filter(Boolean).join(' · ') });
        totals.expenses += amount;
    });
    (src.withdrawals || []).forEach(w => {
        const t = recTime(w);
        if (t === null || t < from || t >= to) return;
        rows.push({ t, kind: 'withdrawal', billNo: '', party: String(w.person || '').trim(), amount: num(w.amount), cash: num(w.amount), online: 0, due: 0, note: String(w.purpose || '') });
        totals.withdrawals += num(w.amount);
    });
    const bills = { purchase: src.purchases || [], retail: src.retailSales || [], wholesale: src.wholesaleSales || [] };
    dueEvents({ bills, sessions, from, to }).forEach(e => {
        const amount = round2(e.cash + e.online);
        if (amount === 0) return;
        const kind = e.direction === 'paid' ? 'duePaid' : 'dueReceived';
        rows.push({ t: Number.isFinite(e.at) ? e.at : null, kind, billNo: e.billNo || '', party: String(e.party || '').trim(), amount, cash: e.cash, online: e.online, due: 0, note: '' });
        totals[kind] += amount;
    });
    rows.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    Object.keys(totals).forEach(k => { if (!/Count$/.test(k)) totals[k] = round2(totals[k]); });
    return { rows, totals };
}

/**
 * Party ledger (ST3): the running balance of one party. Customers: retail +
 * wholesale bills, balance = what they owe the shop; suppliers: purchases,
 * balance = what the shop owes. Old-app balances (OPENING) start as their
 * carried amount. Bills marked cleared without a payment close their rest.
 * @param {Object} src {purchases, wholesaleSales, retailSales}
 * @param {string} partyKey normalizePartyName() key
 * @param {'customer'|'supplier'} kind
 * @param {{from?: number, to?: number}} [range]
 * @returns {{name: string, opening: number, rows: Array, closing: number, due: number, count: number}}
 *   due = Σ BILL-DUE of the party's bills (Outstanding's figure) to check `closing` against
 */
export function partyLedger(src, partyKey, kind, { from = -Infinity, to = Infinity } = {}) {
    const bills = (kind === 'supplier' ? (src.purchases || []) : [...(src.retailSales || []), ...(src.wholesaleSales || [])])
        .filter(b => normalizePartyName(partyOf(b)) === partyKey);
    const entries = [];
    let name = '';
    bills.forEach(b => {
        if (!name && partyOf(b)) name = partyOf(b);
        const t = timeOf(b) ?? 0;
        let balance;
        if (isOpeningRecord(b)) {
            balance = openingAmount(b);
            entries.push({ t, kind: 'opening', billNo: billNo(b), debit: balance, credit: 0 });
        } else {
            const total = billTotal(b);
            const p = saleTimePayment(b);
            entries.push({ t, kind: 'bill', billNo: billNo(b), debit: total, credit: 0 });
            if (p.cash + p.online > 0) entries.push({ t, kind: 'paidAtBill', billNo: billNo(b), debit: 0, credit: round2(p.cash + p.online) });
            balance = total - p.cash - p.online;
        }
        let last = t;
        (Array.isArray(b.payments) ? b.payments : []).forEach(e => {
            const et = entryTime(e);
            const at = Number.isFinite(et) ? et : t;
            const parts = entryParts(e);
            const amount = round2(parts.cash + parts.online + parts.writeOff);
            if (!amount) return;
            entries.push({ t: at, kind: parts.writeOff ? 'writeOff' : 'payment', billNo: billNo(b), debit: 0, credit: amount });
            balance -= amount;
            last = Math.max(last, at);
        });
        if (b.cleared && balance > 0.5) {
            entries.push({ t: last, kind: 'cleared', billNo: billNo(b), debit: 0, credit: round2(balance) });
        }
    });
    entries.sort((a, b) => a.t - b.t || (a.kind === 'bill' || a.kind === 'opening' ? -1 : 1));
    let running = 0;
    let opening = 0;
    const rows = [];
    entries.forEach(e => {
        running = round2(running + e.debit - e.credit);
        if (e.t < from) { opening = running; return; }
        if (e.t >= to) return;
        rows.push({ ...e, balance: running });
    });
    const closing = rows.length ? rows[rows.length - 1].balance : opening;
    const due = round2(bills.reduce((a, b) => a + outstandingDue(b), 0));
    return { name, opening, rows, closing, due, count: bills.length };
}

/**
 * Parties seen in the loaded bills, for the ledger picker (most bills first).
 * @param {Object} src
 * @param {'customer'|'supplier'} kind
 * @returns {Array<{key: string, name: string, count: number}>}
 */
export function partyChoices(src, kind) {
    const bills = kind === 'supplier' ? (src.purchases || []) : [...(src.retailSales || []), ...(src.wholesaleSales || [])];
    const map = new Map();
    bills.forEach(b => {
        const raw = partyOf(b);
        const key = normalizePartyName(raw);
        if (!key) return;
        const r = map.get(key) || { key, name: raw, count: 0 };
        r.count++;
        map.set(key, r);
    });
    return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Item ledger (ST4): every purchase, sale and adjustment of one item with the
 * running kg and average cost (AVG-COST); flags a sale below cost and a sale
 * before the stock was bought.
 * @param {Object} src {purchases, wholesaleSales, retailSales, stockAdjustments}
 * @param {Array} items catalogue
 * @param {string} itemKey
 * @param {{from?: number, to?: number}} [range]
 * @returns {{opening: {qty: number, value: number}, rows: Array, closing: {qty: number, value: number, rate: number}}}
 */
export function itemLedger(src, items, itemKey, { from = -Infinity, to = Infinity } = {}) {
    const getKey = createItemKeyResolver(items || []);
    const events = collectEvents({
        purchases: activityBills(src.purchases || []), wholesaleSales: activityBills(src.wholesaleSales || []),
        retailSales: activityBills(src.retailSales || []), stockAdjustments: src.stockAdjustments || []
    });
    const state = {};
    const rows = [];
    let opening = { qty: 0, value: 0 };
    let openingTaken = false;
    replayWithValues(state, events, getKey, (ev, key, delta, prevQty) => {
        if (key !== itemKey) return;
        const s = state[key] || { quantity: 0, totalValue: 0 };
        if (ev.t >= to) return;
        if (ev.t < from) return;
        if (!openingTaken) {
            openingTaken = true;
            const beforeQty = num(prevQty);
            opening = { qty: round2(beforeQty), value: round2(s.totalValue - delta) };
        }
        const line = ev.item ? readLineItem(ev.item) : null;
        const qty = ev.kind === 'adjustment' ? num(ev.adj?.quantity) : line.qty;
        const avg = s.quantity > 0 ? s.totalValue / s.quantity : 0;
        const row = {
            t: Number.isFinite(ev.t) && ev.t !== Number.MAX_SAFE_INTEGER ? ev.t : null,
            kind: ev.kind === 'purchase' ? 'purchase' : ev.kind === 'sale' ? ev.source : 'adjustment',
            billNo: ev.bill ? billNo(ev.bill) : '', party: ev.bill ? partyOf(ev.bill) : String(ev.adj?.adjustType || ''),
            qty: round2(s.quantity - num(prevQty)),
            rate: line ? line.rate : num(ev.adj?.rate),
            balanceQty: round2(s.quantity), avgCost: round2(avg), value: round2(Math.max(0, s.totalValue))
        };
        if (ev.kind === 'sale') {
            const cost = qty > 0 ? -delta / qty : 0;
            row.cost = round2(cost);
            row.belowCost = line.rate > 0 && cost > 0 && line.rate < cost - 0.005;
            row.beforeBought = qty - Math.max(0, num(prevQty)) > 1e-9;
        }
        rows.push(row);
    });
    const s = state[itemKey] || { quantity: 0, totalValue: 0 };
    if (!openingTaken) opening = { qty: round2(s.quantity), value: round2(Math.max(0, s.totalValue)) };
    const last = rows[rows.length - 1];
    const closing = last
        ? { qty: last.balanceQty, value: last.value, rate: last.avgCost }
        : { qty: opening.qty, value: opening.value, rate: opening.qty > 0 ? round2(opening.value / opening.qty) : 0 };
    return { opening, rows, closing };
}

/** Device setting: CSV in English even when the app is in Hindi (for the accountant). */
export const CSV_ENGLISH_KEY = 'aadhat.csvEnglish';

/** @returns {boolean} */
export function readCsvEnglish() {
    try { return localStorage.getItem(CSV_ENGLISH_KEY) === '1'; } catch (_) { return false; }
}

/** @param {boolean} on */
export function writeCsvEnglish(on) {
    try { localStorage.setItem(CSV_ENGLISH_KEY, on ? '1' : '0'); } catch (_) { /* storage blocked */ }
}

/**
 * Language of a CSV: the app language, or English when English headers are chosen.
 * @param {'en'|'hi'} lang
 * @param {boolean} english
 * @returns {'en'|'hi'}
 */
export function csvLanguage(lang, english) {
    return lang === 'hi' && !english ? 'hi' : 'en';
}

/** A label without its statement sign ("− Cost of goods sold" → "Cost of goods sold"). */
export const plainLabel = (s) => String(s ?? '').replace(/^[\s−=+±-]+/, '').trim();

/** 'YYYY-MM-DD HH:mm' (local) of a time in ms; '' when unknown. */
export function isoMinute(t) {
    if (t === null || t === undefined || !Number.isFinite(t)) return '';
    const pad = (x) => String(x).padStart(2, '0');
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * One CSV cell. Text starting with = + - @ (or tab / CR) gets a leading ' so a
 * spreadsheet shows it instead of running it as a formula (CSV injection);
 * numbers are written as they are.
 */
export const csvCell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * CSV text from a header and rows (RFC 4180 quoting, UTF-8 BOM for Excel).
 * @param {string[]} header
 * @param {Array<Array>} rows
 * @returns {string}
 */
export function toCsv(header, rows) {
    return `\uFEFF${[header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/**
 * Line-level export (ST5): one row per bill line in [from, to); labour shared by
 * line value, so Σ amount after labour = the bill totals (M1 / M16).
 * @param {Object} src {purchases, wholesaleSales, retailSales}
 * @param {Array} items
 * @param {{from: number, to: number}} range
 * @returns {Array<Object>}
 */
export function exportLines(src, items, { from, to }) {
    const byId = new Map((items || []).map(i => [i.id, i]));
    const getKey = createItemKeyResolver(items || []);
    const out = [];
    const iso = isoMinute;
    [['purchase', src.purchases], ['retail', src.retailSales], ['wholesale', src.wholesaleSales]].forEach(([type, list]) => {
        billsInRange(list || [], from, to).forEach(b => {
            const lines = (Array.isArray(b.items) ? b.items : []).map(l => ({ l, v: readLineItem(l) }));
            const value = lines.reduce((a, x) => a + x.v.total, 0);
            const labour = type === 'purchase' ? billLabour(b) : 0;
            const p = saleTimePayment(b);
            const total = billTotal(b);
            let used = 0;
            lines.forEach(({ l, v }, i) => {
                const share = value > 0 ? labour * (v.total / value) : 0;
                const it = byId.get(getKey(l));
                used += v.total - share;
                out.push({
                    date: iso(timeOf(b)), type, billNo: billNo(b), party: partyOf(b),
                    item: it?.name || String(l.name || ''), qty: v.qty, rate: v.rate, lineAmount: round2(v.total),
                    labour: round2(share), amount: round2(v.total - share),
                    billTotal: i === 0 ? total : '', cash: i === 0 ? p.cash : '', online: i === 0 ? p.online : '',
                    due: i === 0 ? round2(Math.max(0, total - p.cash - p.online)) : ''
                });
            });
            const rest = round2(total - used);
            if (Math.abs(rest) >= 0.005) {
                out.push({ date: iso(timeOf(b)), type, billNo: billNo(b), party: partyOf(b), item: '', qty: '', rate: '', lineAmount: '', labour: '', amount: rest, billTotal: lines.length ? '' : total, cash: lines.length ? '' : p.cash, online: lines.length ? '' : p.online, due: '' });
            }
        });
    });
    return out.sort((a, b) => a.date.localeCompare(b.date));
}
