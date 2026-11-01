/**
 * @fileoverview Voice billing (#81): turns one spoken bill line, Hindi or English
 * ("10 kg rice 30 rupees", "chawal 10 kilo 30", or the same in Devanagari), into
 * item / weight / rate (spec VB-1: values as heard, nothing calculated). Pure, no
 * DOM or speech API; ported from the staging parser (V1 + Hindi numbers 1–99).
 * @module utils/voice-parse
 */

import { isArchivedItem, normalizeItemName } from './item-catalog.js';

// Hindi words are kept apart from Latin ones (one script per string), and the Hindi
// word for kilo is written with escapes: it is only understood here, never shown.
const HI_KILO = '\u0915\u093F\u0932\u094B';
/** Speech text is NFC-normalised (ड़ / ज़ become two code points), so every word list is too. */
const nfc = (w) => w.normalize('NFC');
const wordSet = (words) => new Set(words.map(nfc));

const HINDI_NUMBER_WORDS = [
    'शून्य', 'एक', 'दो', 'तीन', 'चार', 'पांच', 'छह', 'सात', 'आठ', 'नौ',
    'दस', 'ग्यारह', 'बारह', 'तेरह', 'चौदह', 'पंद्रह', 'सोलह', 'सत्रह', 'अठारह', 'उन्नीस',
    'बीस', 'इक्कीस', 'बाईस', 'तेईस', 'चौबीस', 'पच्चीस', 'छब्बीस', 'सत्ताईस', 'अट्ठाईस', 'उनतीस',
    'तीस', 'इकतीस', 'बत्तीस', 'तैंतीस', 'चौंतीस', 'पैंतीस', 'छत्तीस', 'सैंतीस', 'अड़तीस', 'उनतालीस',
    'चालीस', 'इकतालीस', 'बयालीस', 'तैंतालीस', 'चवालीस', 'पैंतालीस', 'छियालीस', 'सैंतालीस', 'अड़तालीस', 'उनचास',
    'पचास', 'इक्यावन', 'बावन', 'तिरपन', 'चौवन', 'पचपन', 'छप्पन', 'सत्तावन', 'अट्ठावन', 'उनसठ',
    'साठ', 'इकसठ', 'बासठ', 'तिरसठ', 'चौंसठ', 'पैंसठ', 'छियासठ', 'सड़सठ', 'अड़सठ', 'उनहत्तर',
    'सत्तर', 'इकहत्तर', 'बहत्तर', 'तिहत्तर', 'चौहत्तर', 'पचहत्तर', 'छिहत्तर', 'सतहत्तर', 'अठहत्तर', 'उनासी',
    'अस्सी', 'इक्यासी', 'बयासी', 'तिरासी', 'चौरासी', 'पचासी', 'छियासी', 'सत्तासी', 'अट्ठासी', 'नवासी',
    'नब्बे', 'इक्यानवे', 'बानवे', 'तिरानवे', 'चौरानवे', 'पचानवे', 'छियानवे', 'सत्तानवे', 'अट्ठानवे', 'निन्यानवे'
];
const HINDI_NUMBER_VARIANTS = {
    'पाँच': 5, 'छः': 6, 'छे': 6, 'पन्द्रह': 15, 'उन्निस': 19, 'पचीस': 25, 'सौ': 100, 'हज़ार': 1000, 'हजार': 1000
};
const ROMAN_HINDI_NUMBERS = {
    shunya: 0, ek: 1, do: 2, teen: 3, char: 4, chaar: 4, panch: 5, paanch: 5, chhe: 6, chhah: 6, chha: 6,
    saat: 7, aath: 8, nau: 9, das: 10, gyarah: 11, barah: 12, baarah: 12, terah: 13, chaudah: 14,
    pandrah: 15, solah: 16, satrah: 17, atharah: 18, unnees: 19, unnis: 19, bees: 20, pachees: 25,
    pachchis: 25, tees: 30, chalees: 40, chalis: 40, pachas: 50, pachaas: 50, saath: 60, sattar: 70,
    assi: 80, nabbe: 90, sau: 100, sou: 100, hazar: 1000, hazaar: 1000
};
const ENGLISH_NUMBERS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000
};
const NUMBER_WORDS = (() => {
    const map = new Map();
    HINDI_NUMBER_WORDS.forEach((w, n) => map.set(nfc(w), n));
    for (const src of [HINDI_NUMBER_VARIANTS, ROMAN_HINDI_NUMBERS, ENGLISH_NUMBERS]) {
        for (const [w, n] of Object.entries(src)) map.set(nfc(w), n);
    }
    return map;
})();
/** 1½ and 2½ said as one word. */
const FRACTION_WORDS = new Map([['डेढ़', 1.5], ['डेढ', 1.5], ['dedh', 1.5], ['dhai', 2.5], ['dhaai', 2.5], ['ढाई', 2.5]].map(([w, n]) => [nfc(w), n]));
/** Before a number: "saadhe das" = 10.5, "sava do" = 2.25, "paune do" = 1.75 ("saadhe teen sau" = 350). */
const NUMBER_MODIFIERS = new Map([
    ['साढ़े', 0.5], ['साढे', 0.5], ['saadhe', 0.5], ['sadhe', 0.5], ['sade', 0.5],
    ['सवा', 0.25], ['sava', 0.25], ['sawa', 0.25],
    ['पौने', -0.25], ['paune', -0.25], ['pone', -0.25]
].map(([w, n]) => [nfc(w), n]));
/** Grams: "500 gram" is 0.5 kg, "1 kilo 500 gram" 1.5 kg. */
const GRAM_UNITS = wordSet(['g', 'gm', 'gms', 'gram', 'grams', 'gramme', 'ग्राम']);

const WEIGHT_UNITS = wordSet([
    'kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms', 'keelo', 'kilogramme',
    HI_KILO, HI_KILO + '\u0917\u094D\u0930\u093E\u092E', 'केजी'
]);
/** Words after a number that make it the rate ("30 rupees", "30 का"). */
const PRICE_AFTER = wordSet([
    'rupees', 'rupee', 'rs', 'rupaye', 'rupaiye', 'rupiya', 'rupiye', 'rupya',
    'रुपये', 'रुपए', 'रुपया', 'रूपये', 'रूपए', 'ka', 'ke', 'का', 'के'
]);
/** Words just before a number that make it the rate ("at 30", "₹30", "rate 30"). */
const PRICE_BEFORE = wordSet(['₹', 'rs', 'at', '@', 'rate', 'bhav', 'bhaav', 'रेट', 'भाव', 'दर']);
/** Words never taken as the start of an item name. */
const NOT_ITEM_WORDS = wordSet([...WEIGHT_UNITS, ...PRICE_AFTER, ...PRICE_BEFORE, ...NUMBER_MODIFIERS.keys(), ...GRAM_UNITS,
    'and', 'aur', 'also', 'then', 'phir', 'with', 'per', 'prati', 'wala', 'wale', 'वाला', 'वाले', 'और', 'प्रति', 'फिर']);

const toAsciiDigits = (s) => s.replace(/[\u0966-\u096F]/g, (d) => String(d.charCodeAt(0) - 0x0966));

/**
 * Lower-cased words, with digits split from letters ("10kg", "₹30") and
 * Devanagari digits made ASCII. Decimal points stay inside numbers.
 * @param {string} text
 * @returns {string[]}
 */
export function voiceTokens(text) {
    const s = toAsciiDigits(String(text || '').normalize('NFC').toLowerCase())
        .replace(/₹/g, ' ₹ ')
        .replace(/@/g, ' @ ')
        .replace(/(\d)(?=[^\d.,\s])/g, '$1 ')
        .replace(/([^\d.,\s])(?=\d)/g, '$1 ')
        .replace(/(\d),(?=\d{3}\b)/g, '$1')
        .replace(/[,;:!?।"“”'‘’()]/g, ' ');
    return s.split(/\s+/).map(w => w.replace(/^\.+|\.+$/g, '')).filter(Boolean);
}

const isDigits = (w) => /^\d+(?:\.\d+)?$/.test(w);
const numberOf = (w) => (isDigits(w) ? parseFloat(w) : (NUMBER_WORDS.has(w) ? NUMBER_WORDS.get(w) : FRACTION_WORDS.get(w)));
const isEnglishTens = (w, n) => Object.prototype.hasOwnProperty.call(ENGLISH_NUMBERS, w) && n >= 20 && n <= 90;

/**
 * Number groups in spoken order: "do sau pachas" → 250, "twenty five" → 25,
 * "saadhe das" → 10.5, "saadhe teen sau" → 350, but "das tees" stays 10 and 30.
 * @param {string[]} tokens
 * @returns {Array<{value: number, start: number, end: number}>} end is exclusive
 */
function numberGroups(tokens) {
    const groups = [];
    for (let i = 0; i < tokens.length; i++) {
        let modifier = 0;
        const start = i;
        if (NUMBER_MODIFIERS.has(tokens[i]) && numberOf(tokens[i + 1]) !== undefined) {
            modifier = NUMBER_MODIFIERS.get(tokens[i]);
            i += 1;
        }
        const first = numberOf(tokens[i]);
        if (first === undefined || !Number.isFinite(first)) continue;
        let total = 0;
        let cur = first + modifier;
        let lastWord = tokens[i];
        let j = i + 1;
        for (; j < tokens.length; j++) {
            const n = numberOf(tokens[j]);
            if (n === undefined) break;
            const word = !isDigits(tokens[j]);
            if (word && n === 1000) { total += (cur || 1) * 1000; cur = 0; } else if (word && n === 100) cur = (cur || 1) * 100;
            else if (!isDigits(lastWord) && (cur >= 100 || (cur === 0 && total > 0)) && cur % 100 === 0 && n < 100) cur += n;
            else if (isEnglishTens(lastWord, cur % 100) && Object.prototype.hasOwnProperty.call(ENGLISH_NUMBERS, tokens[j]) && n < 10) cur += n;
            else break;
            lastWord = tokens[j];
        }
        groups.push({ value: total + cur, start, end: j });
        i = j - 1;
    }
    return groups;
}

/**
 * Which catalogue item the words name: the longest English or Hindi name found
 * whole in the text, else a word that starts like a name (3+ letters). Archived
 * items are not offered for new bills, so they are never matched.
 * @param {string[]} tokens
 * @param {Array<{name?: string, hindiName?: string}>} items AppState.items
 * @returns {?{index: number, start: number, end: number}}
 */
function matchItem(tokens, items) {
    let best = null;
    (items || []).forEach((item, index) => {
        if (!item || isArchivedItem(item)) return;
        for (const name of [item.name, item.hindiName]) {
            const words = voiceTokens(normalizeItemName(name));
            if (words.length === 0) continue;
            const len = words.join(' ').length;
            for (let i = 0; i + words.length <= tokens.length; i++) {
                if (words.every((w, k) => tokens[i + k] === w) && (!best || len > best.len)) {
                    best = { index, start: i, end: i + words.length, len };
                }
            }
        }
    });
    if (best) return best;
    for (let i = 0; i < tokens.length; i++) {
        const w = tokens[i];
        if (w.length < 4 || numberOf(w) !== undefined || NOT_ITEM_WORDS.has(w)) continue;
        const index = (items || []).findIndex(item => item && !isArchivedItem(item) && [item.name, item.hindiName].some(name => {
            const n = normalizeItemName(name);
            return n.length >= 4 && !n.includes(' ') && (w.startsWith(n) || n.startsWith(w));
        }));
        if (index !== -1) return { index, start: i, end: i + 1 };
    }
    return null;
}

/**
 * Parses one spoken bill line.
 *
 * A number followed by a weight word is the weight (grams become kg), one followed by a rupee word
 * (or after "at" / "₹" / "rate") is the rate; numbers with no such word fill the
 * weight first, then the rate, in spoken order ("10 kilo aloo 30" → 10 kg at ₹30).
 * @param {string} text what the speech recogniser heard
 * @param {Array<Object>} items AppState.items
 * @returns {{itemIndex: ?number, weight: ?number, rate: ?number, extraNumbers: boolean, heard: string}}
 */
export function parseVoiceLine(text, items = []) {
    const heard = String(text || '').trim();
    const tokens = voiceTokens(heard);
    const item = matchItem(tokens, items);
    const rest = item ? tokens.map((w, i) => (i >= item.start && i < item.end ? '' : w)) : tokens;
    const groups = numberGroups(rest).filter(g => g.value > 0);

    let weight = null;
    let rate = null;
    const unmarked = [];
    let kgJustSet = false;
    groups.forEach((g, gi) => {
        const before = rest[g.start - 1];
        const stop = gi + 1 < groups.length ? groups[gi + 1].start : rest.length;
        let kind = PRICE_BEFORE.has(before) ? 'rate' : null;
        for (let k = g.end; !kind && k < stop; k++) {
            if (WEIGHT_UNITS.has(rest[k])) kind = 'weight';
            else if (GRAM_UNITS.has(rest[k])) kind = 'gram';
            else if (PRICE_AFTER.has(rest[k])) kind = 'rate';
        }
        const wasKg = kgJustSet;
        kgJustSet = false;
        if (kind === 'weight' && weight === null) {
            weight = g.value;
            kgJustSet = true;
        } else if (kind === 'gram' && weight === null) weight = g.value / 1000;
        else if (kind === 'gram' && wasKg && g.value < 1000) weight = Math.round((weight + g.value / 1000) * 1000) / 1000;
        else if (kind === 'rate' && rate === null) rate = g.value;
        else if (!kind) unmarked.push(g.value);
        else unmarked.push(NaN);
    });
    let extraNumbers = unmarked.some(n => Number.isNaN(n));
    for (const n of unmarked.filter(v => !Number.isNaN(v))) {
        if (weight === null) weight = n;
        else if (rate === null) rate = n;
        else extraNumbers = true;
    }
    return { itemIndex: item ? item.index : null, weight, rate, extraNumbers, heard };
}

/**
 * The best of the recogniser's alternatives: the first that names an item and a
 * weight, else the first that gives anything, else the first.
 * @param {string[]} alternatives
 * @param {Array<Object>} items
 */
export function pickVoiceLine(alternatives, items = []) {
    const parsed = (alternatives || []).filter(a => String(a || '').trim()).map(a => parseVoiceLine(a, items));
    return parsed.find(p => p.itemIndex !== null && p.weight !== null)
        || parsed.find(p => p.itemIndex !== null || p.weight !== null || p.rate !== null)
        || parsed[0]
        || parseVoiceLine('', items);
}

/** True when the line gives something to fill. */
export const hasVoiceValues = (p) => !!p && (p.itemIndex !== null || p.weight !== null || p.rate !== null);
