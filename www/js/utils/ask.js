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
// "maal" alone may also mean goods bought or sold ("aaj kitna maal becha"): sales / purchase words win over it.
const STOCK = words(['stock', 'stok', 'स्टॉक', 'स्टाक', 'bacha', 'bachaa', 'बचा']);
const GOODS = words(['maal', 'mal', 'माल']);
const TOTAL = words(['kul', 'total', 'sab', 'sabka', 'sabhi', 'saara', 'sara', 'all', 'कुल', 'सब', 'सबका', 'सभी', 'सारा']);
const HELP = words(['help', 'madad', 'मदद', 'सहायता']);
const LINK = words(['ka', 'ki', 'ke', 'ko', 'se', 'of', 'for', 'from', 'by', 'का', 'की', 'के', 'को', 'से']);
// Words around a name or an amount that are never part of it ("Ramesh ji ka kitna paisa baaki").
const NOISE = words(['paisa', 'paise', 'rupaye', 'rupay', 'rupees', 'rupee', 'rs', 'ji', 'jee', 'hisab', 'hisaab', 'lena', 'dena',
    'पैसा', 'पैसे', 'रुपये', 'रुपया', 'जी', 'हिसाब', 'लेना', 'देना']);
const FILLER = words([
    'kitna', 'kitni', 'kitne', 'hai', 'he', 'h', 'hain', 'kya', 'batao', 'bata', 'bataiye', 'bataye', 'dikhao', 'please', 'plz',
    'what', 'whats', 'is', 'are', 'was', 'the', 'how', 'much', 'many', 'show', 'me', 'tell', 'my', 'do', 'does', 'did', 'us',
    'we', 'i', 'in', 'hamara', 'mera', 'now', 'left', 'tak', 'paas', 'pass', 'hua', 'hui', 'hue', 'gaya', 'gayi',
    'rahi', 'raha', 'rahe', 'kaisi', 'kaisa', 'kaise', 'na', 'so', 'far', 'amount', 'figure', 'till', 'until', 'to', 'तो',
    'कितना', 'कितनी', 'कितने', 'है', 'हैं', 'क्या', 'बताओ', 'बताइए', 'दिखाओ', 'मेरा', 'हमारा', 'तक', 'पास', 'हुआ', 'हुई', 'गया', 'गई',
    'रही', 'रहा', 'रहे', 'कैसी', 'कैसा', 'ना'
]);
// "now" / "all", but also names: a name only right before ka / ki / ji ("Abhi ka baaki", "Sara ji ka baaki").
const AMBIGUOUS = words(['abhi', 'ab', 'sara', 'अभी', 'अब']);
const NAME_NEXT = words([...LINK, 'ji', 'jee', 'जी']);
// Cash in hand or the bank: not a party's due (Cash, Money › Worth).
const MONEY_PLACES = words(['cash', 'bank', 'galla', 'gulla', 'drawer', 'नकद', 'बैंक', 'गल्ला']);
// Another day or period: Ask knows only today's totals.
const OTHER_DAY = words(['kal', 'parso', 'parson', 'yesterday', 'tomorrow', 'week', 'hafta', 'hafte', 'mahina', 'mahine', 'month',
    'saal', 'year', 'pichle', 'pichhle', 'last', 'कल', 'परसों', 'हफ़्ता', 'हफ्ता', 'हफ़्ते', 'हफ्ते', 'महीना', 'महीने', 'साल', 'पिछले']);

const hasAny = (tokens, set) => tokens.some(w => set.has(w));
const DEVANAGARI = /[\u0900-\u097F]/;

/**
 * Lower-case words of a question, punctuation and filler words dropped.
 * @param {string} text
 * @returns {string[]}
 */
export function questionWords(text) {
    return String(text || '').normalize('NFC').toLowerCase()
        .replace(/['’]s\b/g, '')
        // "abhi tak" / "ab tak" / "aaj tak" = so far: never a name, never "today"
        .replace(/(^|\s)(abhi|ab|aaj|aj|अभी|अब|आज)\s+(tak|तक)(?=\s|$)/g, ' ')
        .replace(/[?!.,;:।"“”‘’()[\]{}]+/g, ' ')
        .split(/\s+/)
        .filter(w => w && !FILLER.has(w));
}

/**
 * What the question asks.
 * @param {string} text
 * @returns {{intent: 'help'|'sales_today'|'purchases_today'|'expenses_today'|'today_only'|'party_due'|'total_due'|'item_stock'|'unknown', subject?: string}}
 */
export function parseQuestion(text) {
    const tokens = questionWords(text);
    if (!tokens.length || hasAny(tokens, HELP)) return { intent: 'help' };
    const KEYWORDS = [LINK, TODAY, TOTAL, NOISE, DUES, STOCK, GOODS, SALES, PURCHASES, EXPENSES];
    const named = (i) => AMBIGUOUS.has(tokens[i]) && NAME_NEXT.has(tokens[i + 1]);
    const leftover = () => tokens.filter((w, i) => named(i) || (!AMBIGUOUS.has(w) && !KEYWORDS.some(s => s.has(w)))).join(' ');

    // Dues and stock are known as they are now, sales only for today: another day gets no figure.
    const otherDay = hasAny(tokens, OTHER_DAY) || tokens.some(w => /[\d\u0966-\u096F]/.test(w));
    const sale = hasAny(tokens, SALES) || hasAny(tokens, PURCHASES) || hasAny(tokens, EXPENSES);
    // "baaki" also means "left": "kitna stock baaki hai" is a stock question
    // "Ramesh ka maal baaki" (a name left over) is still Ramesh's due
    const stockAsked = hasAny(tokens, STOCK) || (!sale && hasAny(tokens, GOODS) && (!hasAny(tokens, DUES) || !leftover()));
    if (hasAny(tokens, DUES) && !stockAsked) {
        // "aaj kitna udhaar hua", "udhaar bikri": credit given today or sold on credit, not what is owed in all
        if (otherDay || sale || hasAny(tokens, TODAY)) return { intent: 'today_only' };
        if (hasAny(tokens, MONEY_PLACES)) return { intent: 'unknown' };
        const subject = leftover();
        return subject ? { intent: 'party_due', subject } : { intent: 'total_due' };
    }
    const money = hasAny(tokens, SALES) ? 'sales_today' : hasAny(tokens, PURCHASES) ? 'purchases_today'
        : hasAny(tokens, EXPENSES) ? 'expenses_today' : null;
    if (stockAsked) return otherDay ? { intent: 'today_only' } : { intent: 'item_stock', subject: leftover() };
    // Only today's totals are known here: "kal ki bikri", "chawal kitna becha" or "Ramesh ko kitna becha"
    // must not get today's total, so any word left over gets no figure.
    if (money) return leftover() || otherDay ? { intent: 'today_only' } : { intent: money };
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
 * Catalogue items (not archived) and "Unmatched" stock rows whose English or Hindi name matches
 * the typed one, also through the item-name table (#134: "chawal" = चावल = Rice).
 */
function matchItems(items, rows, text) {
    const entries = [
        ...(items || []).filter(i => i && !i.archived).map(i => ({ itemId: i.id, name: i.name, hindiName: i.hindiName || '' })),
        ...(rows || []).filter(r => r.isOrphan).map(r => ({ itemId: r.itemId, name: r.name, hindiName: '' }))
    ];
    const namesOf = (e) => [e.name, e.hindiName, suggestHindiName(e.name), suggestEnglishName(e.hindiName)]
        .map(normalizePartyName).filter(Boolean);
    const subject = normalizePartyName(text);
    const typed = [...new Set([subject, normalizePartyName(suggestHindiName(subject)), normalizePartyName(suggestEnglishName(subject))].filter(Boolean))];
    return matchNames(entries, namesOf, typed);
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
        const hits = matchItems(src.items, rows, q.subject);
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

