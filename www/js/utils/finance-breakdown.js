// @ts-check
/**
 * @fileoverview "What makes up this number" for every Finance dashboard card
 * (#215). Pure functions only: the sheet UI (ui/finance-breakdown-sheet.js)
 * renders what these return.
 *
 * A card is either a leaf (its rows are records: bill lines, expenses,
 * payments, stock items) or a formula of other cards (e.g. profit = sales −
 * cost of goods sold − business expenses). A formula card's rows are its
 * terms' rows with the term's sign applied, so the rows of every card add up
 * to the card value.
 * @module utils/finance-breakdown
 */

import { round2 } from './money.js';
import { toLocalISODate } from './dates.js';

/** Rows shown per "page" in the sheet. */
export const PAGE_SIZE = 50;

/**
 * @typedef {{label: string, rows?: (d: Rec) => ?Array<Rec>, terms?: Array<[string, number, string?]>,
 *   value: (s: Rec) => ?number, notes?: string[]}} Card
 */

const stockRows = (/** @type {string} */ name) => (/** @type {Rec} */ d) => (d.stock ? d.stock[name] : null);
const stockValue = (/** @type {string} */ name) => (/** @type {Rec} */ s) => (s.stock ? s.stock[name] : null);

/**
 * Card id → definition. `label` is an i18n key; `rows(detail)` for leaves,
 * `terms` ([cardId, sign]) for formulas; `value(summary)` is the number shown
 * on the dashboard (null = can't be computed yet).
 * @type {Object<string, Card>}
 */
export const CARDS = {
    sales: { label: 'ui.finance.sales', rows: d => d.sales, value: s => s.sales.total },
    cogs: { label: 'ui.finance.cogs', rows: stockRows('cogs'), value: s => s.cogs, notes: ['uncosted', 'labour'] },
    gross: { label: 'ui.finance.gross_profit', terms: [['sales', 1], ['cogs', -1]], value: s => s.grossProfit },
    business: { label: 'ui.finance.business_expenses', rows: d => d.business, value: s => s.expenses.business },
    badDebts: { label: 'ui.finance.bad_debts', rows: d => d.badDebts, value: s => s.badDebts },
    profit: {
        label: 'ui.finance.profit_on_goods_sold',
        // 'optional' terms are left out of the formula while they are 0.
        terms: [['sales', 1], ['cogs', -1], ['business', -1], ['badDebts', -1, 'optional']],
        value: s => s.profit,
        notes: ['uncosted', 'labour']
    },
    // Shown next to profit, never part of it: units sold before their purchase was
    // recorded (costed at ₹0, so profit may be overstated by about this much) and
    // labour on purchases (not in cost; owner question on #215).
    uncosted: { label: 'ui.finance.uncosted', rows: stockRows('uncosted'), value: s => (s.stock ? s.stock.uncosted.estimate : null) },
    labour: { label: 'ui.finance.labour', rows: d => d.labour, value: s => s.purchases.labour },
    personal: { label: 'ui.finance.personal_expenses', rows: d => d.personal, value: s => s.expenses.personal },
    afterPersonal: { label: 'ui.finance.profit_after_personal', terms: [['profit', 1], ['personal', -1]], value: s => s.afterPersonal },
    withdrawn: { label: 'ui.finance.withdrawn', rows: d => d.withdrawn, value: s => s.withdrawn },
    afterWithdrawals: { label: 'ui.finance.left_after_withdrawals', terms: [['afterPersonal', 1], ['withdrawn', -1]], value: s => s.afterWithdrawals },
    stockOpening: { label: 'ui.finance.opening_stock', rows: stockRows('opening'), value: stockValue('opening') },
    stockPurchases: { label: 'ui.finance.purchases', rows: stockRows('purchases'), value: stockValue('purchases') },
    stockAdjustments: { label: 'ui.finance.stock_corrections', rows: stockRows('adjustments'), value: stockValue('adjustments') },
    stockClosing: { label: 'ui.finance.closing_stock', rows: stockRows('closing'), value: stockValue('closing') },
    stockNow: { label: 'ui.finance.stock_value_now', rows: stockRows('now'), value: stockValue('now') },
    // Formula shows the check line; the rows are the per-item differences.
    stockCheck: {
        label: 'ui.finance.stock_check',
        notes: ['uncosted'],
        terms: [['stockOpening', 1], ['stockPurchases', 1], ['cogs', -1], ['stockAdjustments', 1], ['stockClosing', -1]],
        rows: stockRows('gap'),
        value: stockValue('gap')
    },
    receivedAtSale: { label: 'ui.finance.received_at_sale', rows: d => d.receivedAtSale, value: s => s.cash.receivedAtSale },
    dueReceived: { label: 'ui.finance.due_received', rows: d => d.dueReceived, value: s => s.cash.dueReceived },
    moneyIn: { label: 'ui.finance.money_in', terms: [['receivedAtSale', 1], ['dueReceived', 1]], value: s => s.cash.moneyIn },
    paidAtPurchase: { label: 'ui.finance.paid_at_purchase', rows: d => d.paidAtPurchase, value: s => s.cash.paidAtPurchase },
    duePaid: { label: 'ui.finance.due_paid', rows: d => d.duePaid, value: s => s.cash.duePaid },
    expensesAll: { label: 'ui.finance.all_expenses', terms: [['business', 1], ['personal', 1]], value: s => round2(s.expenses.business + s.expenses.personal) },
    moneyOut: { label: 'ui.finance.money_out', terms: [['paidAtPurchase', 1], ['duePaid', 1], ['expensesAll', 1]], value: s => s.cash.moneyOut },
    netCash: { label: 'ui.finance.net_cash_flow', terms: [['moneyIn', 1], ['moneyOut', -1]], value: s => s.cash.net }
};

/**
 * Rows of a card (records, with formula signs applied and `term` = the leaf
 * card each row comes from). Null when the card can't be computed.
 * @param {Rec} summary computeFinanceSummary(..., detail: true)
 * @param {string} cardId
 * @param {number} [sign=1]
 * @param {string} [path='']
 * @returns {?Array<Rec>}
 */
export function cardRows(summary, cardId, sign = 1, path = '') {
    const card = CARDS[cardId];
    if (!card || !summary?.detail) return null;
    if (card.rows) {
        const rows = card.rows(summary.detail);
        if (!rows) return null;
        return rows.map(r => ({ ...r, key: `${path}${cardId}:${r.key}`, term: cardId, amount: r.amount * sign }));
    }
    /** @type {Array<Rec>} */
    const out = [];
    for (const [term, s] of /** @type {Array<[string, number, string?]>} */ (card.terms)) {
        const rows = cardRows(summary, term, sign * s, `${path}${cardId}/`);
        if (!rows) return null;
        out.push(...rows);
    }
    return out;
}

/**
 * Sum of row amounts, rounded to paise.
 * @param {?Array<Rec>|undefined} rows
 * @returns {number}
 */
export function sumRows(rows) {
    return round2((rows || []).reduce((/** @type {number} */ a, r) => a + (Number(r.amount) || 0), 0));
}

/**
 * Everything the sheet shows for one card.
 * @param {Rec} summary computeFinanceSummary(..., detail: true)
 * @param {string} cardId
 * @returns {?{cardId: string, label: string, value: ?number, available: boolean,
 *   formula: ?Array<{cardId: string, label: string, sign: number, value: ?number}>, rows: Array<Rec>, total: number,
 *   notes: Array<{cardId: string, label: string, value: ?number}>}} notes: related numbers that
 *   are NOT part of this card (shown, tappable, only when non-zero)
 */
export function buildBreakdown(summary, cardId) {
    const card = CARDS[cardId];
    if (!card) return null;
    const value = summary ? card.value(summary) : null;
    const rows = value === null || value === undefined ? null : cardRows(summary, cardId);
    const formula = card.terms
        ? card.terms
            .map(([id, sign, opt]) => ({ cardId: id, label: CARDS[id].label, sign, value: CARDS[id].value(summary), opt }))
            .filter(term => !(term.opt && !term.value))
            .map(({ opt, ...term }) => term)
        : null;
    const notes = (card.notes || [])
        .map(id => ({ cardId: id, label: CARDS[id].label, value: summary ? CARDS[id].value(summary) : null }))
        .filter(n => n.value);
    return {
        cardId,
        label: card.label,
        notes,
        value: value ?? null,
        available: !!rows,
        formula,
        rows: rows || [],
        total: sumRows(rows || [])
    };
}

const norm = (/** @type {*} */ s) => String(s ?? '').normalize('NFC').toLowerCase();

/**
 * Rows matching a free-text search (bill no, party, item in either language,
 * note, category, date).
 * @param {Array<Rec>} rows
 * @param {*} query
 * @returns {Array<Rec>}
 */
export function searchRows(rows, query) {
    const q = norm(query).trim();
    if (!q) return rows;
    return rows.filter(r => [r.billNo, r.party, r.item, r.itemHi, r.note, r.category, r.t ? toLocalISODate(new Date(r.t)) : '']
        .some(v => norm(v).includes(q)));
}

/**
 * Sorted copy: 'amount' (biggest first, by size), 'date' (newest first) or
 * 'date-asc'. Undated rows go last.
 * @param {Array<Rec>} rows
 * @param {string} [by]
 * @returns {Array<Rec>}
 */
export function sortRows(rows, by = 'amount') {
    const copy = [...rows];
    if (by === 'amount') return copy.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    const dir = by === 'date-asc' ? 1 : -1;
    return copy.sort((a, b) => {
        if (a.t == null && b.t == null) return 0;
        if (a.t == null) return 1;
        if (b.t == null) return -1;
        return dir * (a.t - b.t);
    });
}

/** Every grouping the sheet can offer (label key: `ui.finance.group_<id>`). */
export const GROUPS = ['none', 'item', 'party', 'day', 'term'];

/**
 * FB-COUNT: when every row is a line of a bill (an item line, its COGS, or a
 * bill's rest), the number of distinct bills they come from ("168 lines in 136
 * bills"); else null (the rows are counted as entries).
 * @param {Array<Rec>} rows
 * @returns {?number}
 */
export function billsOfLines(rows) {
    if (!rows.length || !rows.every(r => r.billId && r.billType && (r.itemKey !== undefined || r.rest))) return null;
    return new Set(rows.map(r => `${r.billType}:${r.billId}`)).size;
}

/**
 * Grouping choices that make sense for these rows.
 * @param {Array<Rec>} rows
 * @returns {string[]}
 */
export function groupOptions(rows) {
    const opts = ['none'];
    if (rows.some(r => r.itemKey)) opts.push('item');
    if (rows.some(r => r.party)) opts.push('party');
    if (rows.some(r => r.t != null)) opts.push('day');
    if (new Set(rows.map(r => r.term)).size > 1) opts.push('term');
    return opts;
}

/**
 * Groups with subtotals. Keys: item → itemKey ('' = no item), party →
 * normalised name, day → local YYYY-MM-DD ('' = no date), term → card id.
 * Day groups are newest first; the others biggest first.
 * @param {Array<Rec>} rows
 * @param {'item'|'party'|'day'|'term'} by
 * @param {{lang?: 'en'|'hi'}} [opts]
 * @returns {Array<{key: string, label: string, rows: Array<Rec>, subtotal: number, count: number}>}
 */
export function groupRows(rows, by, { lang = 'en' } = {}) {
    /** @type {Map<string, {key: string, label: string, rows: Array<Rec>, subtotal: number, count: number}>} */
    const groups = new Map();
    rows.forEach(r => {
        let key;
        let label;
        if (by === 'item') {
            key = r.itemKey || '';
            label = lang === 'hi' ? (r.itemHi || r.item || '') : (r.item || '');
        } else if (by === 'party') {
            label = String(r.party || '').trim();
            key = norm(label).replace(/\s+/g, ' ');
        } else if (by === 'day') {
            key = r.t != null ? toLocalISODate(new Date(r.t)) : '';
            label = key;
        } else {
            key = r.term || '';
            label = r.term ? CARDS[r.term]?.label || r.term : '';
        }
        if (!groups.has(key)) groups.set(key, { key, label, rows: [], subtotal: 0, count: 0 });
        const g = /** @type {{key: string, label: string, rows: Array<Rec>, subtotal: number, count: number}} */ (groups.get(key));
        g.rows.push(r);
        g.subtotal += Number(r.amount) || 0;
        g.count++;
    });
    const list = [...groups.values()].map(g => ({ ...g, subtotal: round2(g.subtotal) }));
    if (by === 'day') return list.sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : b.key.localeCompare(a.key)));
    return list.sort((a, b) => Math.abs(b.subtotal) - Math.abs(a.subtotal));
}
