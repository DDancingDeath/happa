// @ts-check
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
import { buildAging, dueRows } from './aging.js';
import { partyNameKey } from './parties.js';
import { devanagariToLatin, latinToDevanagari, suggestEnglishName, suggestHindiName } from './item-name-autofill.js';
import { itemReport, kgOnlyReport, matchKinds, reportBillTypes, reportKinds, reportParties, reportPeriod, validateSpec } from './ask-report.js';

/** Answer → its spec ID in docs/calculations.md. */
export const ASK_SPEC = Object.freeze({
    sales_today: 'ASK-1',
    purchases_today: 'ASK-1',
    expenses_today: 'ASK-1',
    party_due: 'ASK-2',
    total_due: 'ASK-3',
    item_stock: 'ASK-4',
    item_report: 'ASK-5'
});

/** Members see "Available" above this many kg, as on the Stock page. */
export const MEMBER_STOCK_LIMIT_KG = 100;
/** Most names offered when a question matches several parties or items. */
export const ASK_MATCH_LIMIT = 5;
/** @typedef {{key: string, name: string, hindiName: string}} Kind */

/** Most kinds an item report offers to pick from by hand. */
export const REPORT_POOL_LIMIT = 12;

const words = (/** @type {string[]} */ list) => new Set(list);
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

// Item reports (ASK-5): words of the request itself, never an item's name.
const REPORT = words(['report', 'excel', 'xlsx', 'sheet', 'sheets', 'csv', 'list', 'download', 'file', 'average', 'avg', 'rate', 'rates',
    'bhav', 'bhaav', 'kinds', 'kind', 'types', 'type', 'kism', 'kisam', 'kisme', 'kismen', 'prakar', 'tarah', 'varieties', 'variety',
    'weight', 'vajan', 'wajan', 'bill', 'bills', 'number', 'no', 'date', 'totals', 'plus', 'one', 'page', 'per', 'each', 'har',
    'with', 'as', 'an', 'a', 'were', 'and', 'aur', 'at', 'all', 'mein', 'me', 'ek', 'wise', 'vise', 'give', 'make', 'banao', 'bana', 'do', 'de',
    'maine', 'mene', 'humne', 'hamne', 'tha', 'thi', 'the', 'liya', 'lia', 'li', 'kilo', 'kg', 'quintal', 'kuntal', 'in', 'by', 'we', 'have', 'has',
    'मैंने', 'हमने', 'था', 'थी', 'थे', 'लिया', 'ली', 'क्विंटल',
    'रिपोर्ट', 'एक्सेल', 'शीट', 'लिस्ट', 'भाव', 'रेट', 'औसत', 'किस्म', 'किस्में', 'किस्मों', 'प्रकार', 'तरह', 'वज़न', 'वजन', 'बिल', 'नंबर',
    'तारीख', 'हर', 'और', 'में', 'एक', 'पेज', 'दो', 'बनाओ']);
const MONTH = words(['mahina', 'mahine', 'month', 'महीना', 'महीने']);
const YEAR = words(['saal', 'year', 'साल', 'varsh', 'वर्ष']);
const LAST = words(['pichle', 'pichhle', 'pichla', 'last', 'previous', 'पिछले', 'पिछला']);
const FY = words(['fy', 'financial']);
// "pichle saal se ab tak": from the start of that period until today
const SINCE = words(['se', 'from', 'since', 'से']);
const DAYS_WEEKS = words(['kal', 'parso', 'parson', 'yesterday', 'tomorrow', 'week', 'hafta', 'hafte', 'कल', 'परसों', 'हफ़्ता', 'हफ्ता', 'हफ़्ते', 'हफ्ते']);
const ALL_TIME = words(['all', 'sab', 'sabhi', 'saara', 'kul', 'total', 'shuru', 'सब', 'सभी', 'सारा', 'कुल', 'शुरू']);
const SO_FAR = /(^|\s)((ab|abhi|aaj|aj|अब|अभी|आज)\s+(tak|तक)|(till|until|upto|up to)\s+(today|now|date)|so far|all time)(?=[\s?!.,]|$)/;
// More purchase spellings for reports ("kitni lah kharidi").
const BOUGHT = words(['kharide', 'khareede', 'kharidin', 'kharidi', 'खरीदीं', 'खरीदे']);
// Sales reports ("chawal kitna becha is mahine", "lah kisko becha"); one kind of sale.
const SOLD = words(['bika', 'biki', 'bikin', 'bechin', 'बिके', 'बिकीं', 'बेचीं']);
const RETAIL = words(['retail', 'khudra', 'khudara', 'futkar', 'phutkar', 'खुदरा', 'फुटकर', 'रिटेल']);
const WHOLESALE = words(['wholesale', 'thok', 'थोक', 'होलसेल']);
// Group by party ("lah kisko becha", "party wise"), by item ("kya kya becha", "item wise").
const BY_PARTY = words(['kisko', 'kise', 'kisse', 'kinko', 'kinse', 'kiske', 'kisne', 'party', 'parties', 'partywise', 'customer', 'customers',
    'supplier', 'suppliers', 'grahak', 'grahakon', 'vyapari', 'पार्टी', 'पार्टियों', 'किसको', 'किसे', 'किससे', 'किसने', 'ग्राहक', 'ग्राहकों', 'व्यापारी']);
const WHO_ALL = /(^|\s)(kis\s+kis|किस\s+किस)(?=[\s?!.,]|$)/;
// "kis bhav pe", "kaun sa": question words, never a name
const ITEM_WORDS = words(['item', 'items', 'itemwise', 'saman', 'samaan', 'cheez', 'cheeze', 'cheezen', 'kaun', 'kon', 'konsa', 'kaunsa', 'kaunse', 'konse',
    'kis', 'pe', 'par', 'सामान', 'चीज़', 'चीज़ें', 'चीजें', 'कौन', 'कौनसा', 'कौनसे', 'किस', 'पर', 'पे']);
const BY_MONTH = /(^|\s)((month|mahine|mahina|महीने|महीना)\s*-?\s*(wise|vise|war|vaar|वार)|monthly|mahinewar|mahinevar|महीनेवार|(har|each|every|per|हर)\s+(mahine|mahina|month|महीने|महीना)|month\s+by\s+month)(?=[\s?!.,]|$)/g;
const WHAT_ALL = /(^|\s)(kya\s+kya|क्या\s+क्या)(?=[\s?!.,]|$)/;
// Words asking for a report even without an item or a period ("is mahine ki bikri item wise").
const REPORT_ASK = words(['report', 'excel', 'xlsx', 'sheet', 'sheets', 'csv', 'list', 'download', 'wise', 'vise', 'kinds', 'types', 'kism', 'kisam',
    'kisme', 'kismen', 'prakar', 'varieties', 'item', 'items', 'itemwise', 'रिपोर्ट', 'एक्सेल', 'शीट', 'लिस्ट', 'किस्में', 'किस्मों', 'प्रकार']);
const POINTERS = words(['this', 'that', 'ne', 'इस', 'उस', 'ने']);
/** A report by month with no period named covers last month and this one: still on the phone. */
const MONTHLY_DEFAULT = 'since-last-month';

const hasAny = (/** @type {string[]} */ tokens, /** @type {Set<string>} */ set) => tokens.some(w => set.has(w));

/**
 * The period an item report asks about ("is mahine", "pichle saal", "ab tak", "aaj");
 * 'this-month' when none is named, null for one a report can't cover ("kal", a date).
 * @param {string} text
 * @param {string[]} tokens questionWords()
 * @returns {?string} a REPORT_PRESETS value
 */
export function reportRange(text, tokens) {
    const last = hasAny(tokens, LAST);
    const soFar = SO_FAR.test(String(text || '').normalize('NFC').toLowerCase());
    const from = (/** @type {string} */ unit) => (!last ? `this-${unit}` : soFar && hasAny(tokens, SINCE) ? `since-last-${unit}` : `last-${unit}`);
    // "kal", "is hafte", "pichle 3 mahine": a period a report doesn't offer
    if (hasAny(tokens, DAYS_WEEKS) || tokens.some(w => /[\d\u0966-\u096F]/.test(w))) return null;
    if (hasAny(tokens, FY)) return from('fy');
    if (hasAny(tokens, MONTH)) return from('month');
    if (hasAny(tokens, YEAR)) return from('year');
    if (soFar) return 'all';
    if (hasAny(tokens, TODAY)) return 'today';
    if (hasAny(tokens, ALL_TIME)) return 'all';
    return 'this-month';
}
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
 * @returns {{intent: 'help'|'sales_today'|'purchases_today'|'expenses_today'|'today_only'|'party_due'|'total_due'|'item_stock'|'item_report'|'unknown',
 *   subject?: string, range?: string, billType?: string, groupBy?: string}}
 */
export function parseQuestion(text) {
    const tokens = questionWords(text);
    if (!tokens.length || hasAny(tokens, HELP)) return { intent: 'help' };
    const KEYWORDS = [LINK, TODAY, TOTAL, NOISE, DUES, STOCK, GOODS, SALES, SOLD, PURCHASES, EXPENSES];
    const named = (/** @type {number} */ i) => AMBIGUOUS.has(tokens[i]) && NAME_NEXT.has(tokens[i + 1]);
    const leftover = () => tokens.filter((w, i) => named(i) || (!AMBIGUOUS.has(w) && !KEYWORDS.some(s => s.has(w)))).join(' ');

    // Dues and stock are known as they are now, sales only for today: another day gets no figure.
    const otherDay = hasAny(tokens, OTHER_DAY) || tokens.some(w => /[\d\u0966-\u096F]/.test(w));
    const sale = hasAny(tokens, SALES) || hasAny(tokens, SOLD) || hasAny(tokens, PURCHASES) || hasAny(tokens, EXPENSES);
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
    const money = hasAny(tokens, SALES) || hasAny(tokens, SOLD) ? 'sales_today' : hasAny(tokens, PURCHASES) ? 'purchases_today'
        : hasAny(tokens, EXPENSES) ? 'expenses_today' : null;
    if (stockAsked) return otherDay ? { intent: 'today_only' } : { intent: 'item_stock', subject: leftover() };
    // "lah kitna kharida ab tak", "chawal kitna becha is mahine", "Ramesh ko kya kya becha": an item report (ASK-5, ASK-6)
    const bought = hasAny(tokens, PURCHASES) || hasAny(tokens, BOUGHT);
    const sold = hasAny(tokens, SALES) || hasAny(tokens, SOLD);
    if (bought !== sold && !hasAny(tokens, EXPENSES)) {
        const report = itemReportQuestion(text, sold);
        if (report) return report;
    }
    // Only today's totals are known here: "kal ki bikri" or "chawal kitna becha kal"
    // must not get today's total, so any word left over gets no figure.
    if (money) return leftover() || otherDay ? { intent: 'today_only' } : { intent: money };
    return { intent: 'unknown' };
}

/**
 * An item report question: what was bought or sold (purchases, sales, retail or wholesale),
 * the words naming items or a party (resolved against the bills when answered), the period,
 * and what to group by. Null when it asks for today's total only ("aaj ki bikri").
 * @param {string} text
 * @param {boolean} sale
 * @returns {?{intent: 'item_report'|'today_only', billType?: string, subject?: string, range?: string, groupBy?: string}}
 */
function itemReportQuestion(text, sale) {
    const lower = String(text || '').normalize('NFC').toLowerCase();
    const plain = lower.replace(BY_MONTH, '$1 ');
    const monthly = plain !== lower;
    const tokens = questionWords(plain);
    const byParty = hasAny(tokens, BY_PARTY) || WHO_ALL.test(plain);
    const groupBy = monthly ? 'month' : byParty ? 'party' : 'item';
    const KEYWORDS = [LINK, TODAY, TOTAL, NOISE, DUES, STOCK, GOODS, SALES, PURCHASES, EXPENSES, BOUGHT, SOLD, REPORT, MONTH, YEAR, LAST, FY,
        SINCE, ALL_TIME, OTHER_DAY, AMBIGUOUS, RETAIL, WHOLESALE, BY_PARTY, ITEM_WORDS, REPORT_ASK, POINTERS];
    const subject = tokens.filter(w => !KEYWORDS.some(s => s.has(w)) && !/^[\d\u0966-\u096F]/.test(w)).join(' ');
    // "abhi tak ki bikri" alone is today's sales so far: only a month, year or FY makes it a report
    const periodNamed = [MONTH, YEAR, FY, LAST].some(s => hasAny(tokens, s));
    const asked = subject || groupBy !== 'item' || WHAT_ALL.test(plain) || hasAny(tokens, REPORT_ASK);
    if (!asked && !periodNamed) return null;
    const range = monthly && !periodNamed && !hasAny(tokens, TODAY) && !hasAny(tokens, ALL_TIME) ? MONTHLY_DEFAULT : reportRange(plain, tokens);
    if (!range) return { intent: 'today_only' };
    const billType = !sale ? 'purchase' : hasAny(tokens, WHOLESALE) ? 'wholesale' : hasAny(tokens, RETAIL) ? 'retail' : 'sale';
    return { intent: 'item_report', billType, subject, range, groupBy };
}

/**
 * The spellings a name may be typed in: as written, and Latin ↔ Devanagari word by word.
 * @param {*} text
 * @returns {string[]}
 */
function spellings(text) {
    const key = partyNameKey(text);
    if (!key) return [];
    const parts = key.split(' ');
    const other = DEVANAGARI.test(key) ? parts.map(devanagariToLatin).join(' ') : parts.map(latinToDevanagari).join(' ');
    return [...new Set([key, partyNameKey(other)].filter(Boolean))];
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
 * @param {?Array<Rec>|undefined} items
 * @param {?Array<Rec>|undefined} rows stockRows()
 * @param {string} text
 * @returns {Array<{itemId: *, name: string, hindiName: string}>}
 */
function matchItems(items, rows, text) {
    const entries = [
        ...(items || []).filter(i => i && !i.archived).map(i => ({ itemId: i.id, name: i.name, hindiName: i.hindiName || '' })),
        ...(rows || []).filter(r => r.isOrphan).map(r => ({ itemId: r.itemId, name: r.name, hindiName: '' }))
    ];
    const namesOf = (/** @type {{name: string, hindiName: string}} */ e) => [e.name, e.hindiName, suggestHindiName(e.name), suggestEnglishName(e.hindiName)]
        .map(partyNameKey).filter(Boolean);
    const subject = partyNameKey(text);
    const typed = [...new Set([subject, partyNameKey(suggestHindiName(subject)), partyNameKey(suggestEnglishName(subject))].filter(Boolean))];
    return matchNames(entries, namesOf, typed);
}

/**
 * The questions Ask understands, with the data each needs. `role` decides
 * what the role may see, as on the pages: wholesale dues only with Wholesale
 * (`wholesale`), members see "Available" above 100 kg on Stock.
 * @param {{intent: string, subject?: string, range?: string, billType?: string, groupBy?: string, keys?: string[]}} q parseQuestion(); keys: kinds picked by hand
 * @param {Object} src
 * @param {{purchases?: Rec[], retailSales?: Rec[], wholesaleSales?: Rec[]}} [src.bills]
 * @param {Rec[]} [src.expenses]
 * @param {Object<string, {quantity: number, rate: number}>} [src.stock]
 * @param {Array<{id: string, name: string, hindiName?: string}>} [src.items] catalogue
 * @param {Rec} [src.settings]
 * @param {{role?: string, wholesale?: boolean, reports?: boolean, stockReady?: boolean, today?: Date, covered?: boolean, limitFrom?: number, cfg?: Rec}} [opts]
 *   reports: the role may open Statements (a manager's item reports, in kg only); covered: false when the bills an
 *   item report needs are not all on the phone; limitFrom: the oldest bill time a manager's report may need; cfg: insightsSettings()
 * @returns {Rec} answer; `intent` and `spec` always set, `page` = where the figure lives
 */
export function answerQuestion(q, src = {}, { role = 'staff', wholesale = false, reports = false, stockReady = true, today = new Date(), covered = true, limitFrom = 0, cfg = undefined } = {}) {
    const intent = q?.intent || 'unknown';
    const spec = /** @type {Rec} */ (ASK_SPEC)[intent] || null;
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
        /** @type {Array<'receive'|'pay'>} */ (['receive', 'pay']).forEach(side => lists[side].parties.forEach(p => {
            if (!keys.has(p.key)) keys.set(p.key, { key: p.key, name: p.name, names: spellings(p.name) });
        }));
        const hits = matchNames([...keys.values()], e => [e.key, ...e.names], typed);
        if (hits.length !== 1) {
            return { intent, spec, page: 'due', subject: q.subject, matches: hits.slice(0, ASK_MATCH_LIMIT).map(h => h.name), more: Math.max(0, hits.length - ASK_MATCH_LIMIT) };
        }
        const side = (/** @type {'receive'|'pay'} */ s) => {
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

    if (intent === 'item_report') {
        const owner = role === 'owner';
        const types = reportBillTypes(q.billType || '', owner || wholesale);
        if ((!owner && !(role === 'manager' && reports)) || !types.length) return { intent, spec, page: null, notAllowed: true };
        const rs = validateSpec({ v: 1, billType: q.billType, item: { text: q.subject || '' }, keys: q.keys, range: { preset: q.range }, groupBy: q.groupBy });
        if (!rs) return { intent: 'unknown', spec: null, page: null };
        const listOf = { purchase: bills.purchases, retail: bills.retailSales, wholesale: bills.wholesaleSales };
        const sources = types.map(type => ({ type, bills: listOf[type] || [] }));
        const all = sources.flatMap(s => s.bills);
        const period = reportPeriod(rs.range.preset, today, cfg);
        const base = {
            intent, spec: rs.billType === 'purchase' ? 'ASK-5' : 'ASK-6', page: null, billType: rs.billType, groupBy: rs.groupBy,
            retailOnly: rs.billType === 'sale' && types.length === 1, kgOnly: !owner, subject: rs.item?.text || '', period,
            kinds: /** @type {?Array<Kind>} */ (null), near: /** @type {Array<Kind>} */ ([]), nearMore: 0, pool: /** @type {Array<Kind>} */ ([]), party: /** @type {?string} */ (null)
        };
        // Bills this role can't load: a manager sees the ones on the phone only
        const older = owner ? { needsOlder: true } : { limited: limitFrom };
        /** @type {?string} */
        let partyKey = null;
        if (rs.item) {
            const m = matchKinds(reportKinds(src.items, all), rs.item.text);
            const pool = [...m.kinds, ...m.near].slice(0, REPORT_POOL_LIMIT);
            const picked = rs.keys ? new Set(rs.keys) : null;
            const kinds = picked ? pool.filter(k => picked.has(k.key)) : m.kinds;
            const near = picked ? pool.filter(k => !picked.has(k.key)) : m.near;
            Object.assign(base, { kinds, pool, picked: !!picked, near: near.slice(0, ASK_MATCH_LIMIT), nearMore: Math.max(0, near.length - ASK_MATCH_LIMIT) });
            if (m.unknown.length) {
                // "Ramesh se lah kitna kharida", "Ramesh ko kya kya becha": the words that name no item name a party
                const hits = matchNames(reportParties(all), p => [p.key, ...spellings(p.name)], spellings(m.unknown.join(' ')));
                if (hits.length > 1) return { ...base, partyMatches: hits.slice(0, ASK_MATCH_LIMIT).map(h => h.name), partyMore: Math.max(0, hits.length - ASK_MATCH_LIMIT) };
                if (!hits.length) {
                    // A name only on bills older than this phone has may still be found once they are read
                    if (!covered) return { ...base, ...older };
                    return m.kinds.length ? { ...base, notItems: m.unknown } : base;
                }
                partyKey = hits[0].key;
                base.party = hits[0].name;
            }
            // only a party named: every item it bought or sold
            if (!m.kinds.length && !picked) Object.assign(base, { kinds: null, pool: [], near: [], nearMore: 0 });
            if (picked && !kinds.length) return { ...base, noKinds: true };
        }
        if (!owner && limitFrom > 0 && (period.loadFrom === null || period.loadFrom < limitFrom)) return { ...base, limited: limitFrom };
        if (!covered) return { ...base, ...older };
        const report = itemReport(sources, src.items, { kinds: base.kinds, partyKey, groupBy: rs.groupBy, billType: rs.billType }, period);
        return { ...base, report: owner ? report : kgOnlyReport(report) };
    }

    return { intent, spec, page: null };
}

