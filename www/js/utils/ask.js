/**
 * @fileoverview Ask (#88): answers short typed questions ("aaj ki bikri",
 * "Ramesh ka baaki", "chawal ka stock") from the data already on the phone,
 * offline, with no AI: a word matcher (English, Hinglish, Hindi) picks the
 * question, and the answer comes from the same functions the home pages use
 * (Today: todaySummary; Outstanding: dueRows + buildAging; Stock: stockRows).
 * Pure: no DOM, no AppState, no Firestore. Specs: docs/calculations.md ASK-1..ASK-5.
 * @module utils/ask
 */

import { todaySummary } from './calc/today.js';
import { stockRows } from './calc/stock.js';
import { buildAging, dueRows, normalizePartyName } from './aging.js';
import { devanagariToLatin, latinToDevanagari, suggestEnglishName, suggestHindiName } from './item-name-autofill.js';

/** Answer → its spec ID in docs/calculations.md. */
export const ASK_SPEC = Object.freeze({
    sales_today: 'ASK-1',
    purchases_today: 'ASK-1',
    expenses_today: 'ASK-1',
    party_due: 'ASK-2',
    total_due: 'ASK-3',
    item_stock: 'ASK-4'
});

/** Members see "Available" above this many kg, as on the Stock page. */
export const MEMBER_STOCK_LIMIT_KG = 100;
/** Most names offered when a question matches several parties or items. */
export const ASK_MATCH_LIMIT = 5;

const words = (list) => new Set(list);
const TODAY = words(['aaj', 'aj', 'today', 'todays', 'आज']);
const SALES = words(['bikri', 'bikree', 'bechi', 'becha', 'beche', 'bechaa', 'sale', 'sales', 'sold', 'बिक्री', 'बिकी', 'बिका', 'बेचा', 'बेची', 'बेचे']);
const PURCHASES = words(['kharid', 'khareed', 'kharida', 'kharidi', 'khareeda', 'khareedi', 'purchase', 'purchases', 'bought', 'खरीद', 'खरीदा', 'खरीदी']);
const EXPENSES = words(['kharcha', 'kharch', 'kharche', 'expense', 'expenses', 'spent', 'खर्च', 'खर्चा', 'खर्चे']);
const DUES = words(['baaki', 'baki', 'bakaya', 'baqaya', 'udhaar', 'udhar', 'udhari', 'due', 'dues', 'owe', 'owes', 'balance', 'बाकी', 'बाक़ी', 'बकाया', 'उधार', 'उधारी']);
const STOCK = words(['stock', 'stok', 'maal', 'स्टॉक', 'स्टाक', 'माल', 'bacha', 'bachaa', 'बचा']);
const TOTAL = words(['kul', 'total', 'sab', 'sabka', 'sabhi', 'saara', 'sara', 'all', 'कुल', 'सब', 'सबका', 'सभी', 'सारा']);
const HELP = words(['help', 'madad', 'मदद', 'सहायता']);
const LINK = words(['ka', 'ki', 'ke', 'ko', 'se', 'of', 'for', 'from', 'by', 'का', 'की', 'के', 'को', 'से']);
const FILLER = words([
    'kitna', 'kitni', 'kitne', 'hai', 'he', 'h', 'hain', 'kya', 'batao', 'bata', 'bataiye', 'bataye', 'dikhao', 'please', 'plz',
    'what', 'whats', 'is', 'are', 'was', 'the', 'how', 'much', 'many', 'show', 'me', 'tell', 'my', 'do', 'does', 'did', 'us',
    'we', 'i', 'in', 'hamara', 'mera', 'abhi', 'now', 'left', 'tak', 'paas', 'pass', 'hua', 'hui', 'hue', 'gaya', 'gayi', 'ab',
    'कितना', 'कितनी', 'कितने', 'है', 'हैं', 'क्या', 'बताओ', 'बताइए', 'दिखाओ', 'मेरा', 'हमारा', 'अभी', 'तक', 'पास', 'हुआ', 'हुई', 'गया', 'गई'
]);

const hasAny = (tokens, set) => tokens.some(w => set.has(w));
const DEVANAGARI = /[\u0900-\u097F]/;

/**
 * Lower-case words of a question, punctuation and filler words dropped.
 * @param {string} text
 * @returns {string[]}
 */
export function questionWords(text) {
    return String(text || '').normalize('NFC').toLowerCase()
        .replace(/['’]s\b/g, 's')
        .replace(/[?!.,;:।"“”‘’()[\]{}]+/g, ' ')
        .split(/\s+/)
        .filter(w => w && !FILLER.has(w));
}

/**
 * What the question asks.
 * @param {string} text
 * @returns {{intent: 'help'|'sales_today'|'purchases_today'|'expenses_today'|'party_due'|'total_due'|'item_stock'|'unknown', subject?: string}}
 */
export function parseQuestion(text) {
    const tokens = questionWords(text);
    if (!tokens.length || hasAny(tokens, HELP)) return { intent: 'help' };
    const rest = (...sets) => tokens.filter(w => !LINK.has(w) && !TODAY.has(w) && !TOTAL.has(w) && !sets.some(s => s.has(w))).join(' ');

    if (hasAny(tokens, DUES)) {
        const subject = rest(DUES);
        return subject ? { intent: 'party_due', subject } : { intent: 'total_due' };
    }
    if (hasAny(tokens, STOCK)) return { intent: 'item_stock', subject: rest(STOCK) };
    if (hasAny(tokens, SALES)) return { intent: 'sales_today' };
    if (hasAny(tokens, PURCHASES)) return { intent: 'purchases_today' };
    if (hasAny(tokens, EXPENSES)) return { intent: 'expenses_today' };
    return { intent: 'unknown' };
}

/** The spellings a name may be typed in: as written, and Latin ↔ Devanagari word by word. */
function spellings(text) {
    const key = normalizePartyName(text);
    if (!key) return [];
    const parts = key.split(' ');
    const other = DEVANAGARI.test(key) ? parts.map(devanagariToLatin).join(' ') : parts.map(latinToDevanagari).join(' ');
    return [...new Set([key, normalizePartyName(other)].filter(Boolean))];
}

/**
 * Entries whose names match the typed subject: exact spellings first, else
 * names with a word starting with it (at least 2 letters).
 * @template T
 * @param {T[]} list
 * @param {(entry: T) => string[]} namesOf normalised names of an entry
 * @param {string[]} typed normalised spellings of the subject
 * @returns {T[]}
 */
function matchNames(list, namesOf, typed) {
    if (!typed.length) return [];
    const exact = list.filter(e => namesOf(e).some(n => typed.includes(n)));
    if (exact.length) return exact;
    return list.filter(e => namesOf(e).some(n => typed.some(q => q.length >= 2 && (n.startsWith(q) || n.split(' ').some(w => w.startsWith(q))))));
}

/**
 * The questions Ask understands, with the data each needs. `role` decides
 * what the role may see, as on the pages: wholesale dues only with Wholesale
 * (`wholesale`), members see "Available" above 100 kg on Stock.
 * @param {{intent: string, subject?: string}} q parseQuestion()
 * @param {Object} src
 * @param {{purchases?: Object[], retailSales?: Object[], wholesaleSales?: Object[]}} src.bills
 * @param {Object[]} [src.expenses]
 * @param {Object<string, {quantity: number, rate: number}>} [src.stock]
 * @param {Object[]} [src.items] catalogue
 * @param {Object} [src.settings]
 * @param {{role?: string, wholesale?: boolean, stockReady?: boolean, today?: Date}} [opts]
 * @returns {Object} answer; `intent` and `spec` always set, `page` = where the figure lives
 */
export function answerQuestion(q, src = {}, { role = 'staff', wholesale = false, stockReady = true, today = new Date() } = {}) {
    const intent = q?.intent || 'unknown';
    const spec = ASK_SPEC[intent] || null;
    const bills = src.bills || {};

    if (intent === 'sales_today' || intent === 'purchases_today' || intent === 'expenses_today') {
        const s = todaySummary({
            bills: { purchase: bills.purchases || [], wholesale: bills.wholesaleSales || [], retail: bills.retailSales || [] },
            expenses: src.expenses || [],
            settings: src.settings || {},
            today
        });
        const pick = intent === 'sales_today' ? [s.sales, s.saleCount]
            : intent === 'purchases_today' ? [s.purchases, s.purchaseCount]
                : [s.businessExpenses, s.businessExpenseCount];
        return { intent, spec, page: 'day', amount: pick[0], count: pick[1] };
    }

    if (intent === 'party_due' || intent === 'total_due') {
        const lists = {
            receive: buildAging(dueRows(bills, 'sale', { wholesale }), { today }),
            pay: buildAging(dueRows(bills, 'purchase'), { today })
        };
        if (intent === 'total_due') {
            return { intent, spec, page: 'due', receive: lists.receive.total, receiveCount: lists.receive.parties.length, pay: lists.pay.total, payCount: lists.pay.parties.length };
        }
        const typed = spellings(q.subject);
        const keys = new Map();
        ['receive', 'pay'].forEach(side => lists[side].parties.forEach(p => {
            if (!keys.has(p.key)) keys.set(p.key, { key: p.key, name: p.name, names: spellings(p.name) });
        }));
        const hits = matchNames([...keys.values()], e => [e.key, ...e.names], typed);
        if (hits.length !== 1) {
            return { intent, spec, page: 'due', subject: q.subject, matches: hits.slice(0, ASK_MATCH_LIMIT).map(h => h.name), more: Math.max(0, hits.length - ASK_MATCH_LIMIT) };
        }
        const side = (s) => {
            const p = lists[s].parties.find(x => x.key === hits[0].key);
            return p ? { total: p.total, count: p.bills.length, oldestDays: p.oldestDays } : null;
        };
        return { intent, spec, page: 'due', subject: q.subject, name: hits[0].name, key: hits[0].key, receive: side('receive'), pay: side('pay') };
    }

    if (intent === 'item_stock') {
        if (!q.subject) return { intent, spec, page: 'stock', needsItem: true };
        if (stockReady === false) return { intent, spec, page: 'stock', subject: q.subject, updating: true };
        const { rows } = stockRows(src.stock || {}, src.items || []);
        const byId = new Map(rows.map(r => [r.itemId, r]));
        const entries = [
            ...(src.items || []).filter(i => i && !i.archived).map(i => ({ itemId: i.id, name: i.name, hindiName: i.hindiName || '' })),
            ...rows.filter(r => r.isOrphan).map(r => ({ itemId: r.itemId, name: r.name, hindiName: '' }))
        ];
        const namesOf = (e) => [e.name, e.hindiName, suggestHindiName(e.name), suggestEnglishName(e.hindiName)]
            .map(normalizePartyName).filter(Boolean);
        const subject = normalizePartyName(q.subject);
        const typed = [...new Set([subject, normalizePartyName(suggestHindiName(subject)), normalizePartyName(suggestEnglishName(subject))].filter(Boolean))];
        const hits = matchNames(entries, namesOf, typed);
        if (hits.length !== 1) {
            return { intent, spec, page: 'stock', subject: q.subject, matches: hits.slice(0, ASK_MATCH_LIMIT).map(h => ({ name: h.name, hindiName: h.hindiName })), more: Math.max(0, hits.length - ASK_MATCH_LIMIT) };
        }
        const row = byId.get(hits[0].itemId);
        const quantity = row ? row.quantity : 0;
        return {
            intent, spec, page: 'stock', subject: q.subject, name: hits[0].name, hindiName: hits[0].hindiName,
            quantity, limited: role === 'staff' && quantity > MEMBER_STOCK_LIMIT_KG
        };
    }

    return { intent, spec, page: null };
}

