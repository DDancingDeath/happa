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
/** Fractions said as one word: ½, ¼, ¾, 1½, 2½. */
const FRACTION_WORDS = new Map([
    ['आधा', 0.5], ['आधी', 0.5], ['aadha', 0.5], ['adha', 0.5], ['aadhi', 0.5], ['half', 0.5],
    ['पाव', 0.25], ['paav', 0.25], ['pav', 0.25], ['quarter', 0.25], ['पौना', 0.75], ['pauna', 0.75],
    ['डेढ़', 1.5], ['डेढ', 1.5], ['dedh', 1.5], ['dhai', 2.5], ['dhaai', 2.5], ['ढाई', 2.5]
].map(([w, n]) => [nfc(w), n]));
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
const RATE_WORDS = wordSet(['at', '@', 'rate', 'bhav', 'bhaav', 'रेट', 'भाव', 'दर', 'daam', 'दाम', 'hisaab', 'hisab', 'हिसाब']);
/** "₹60" is "60 rupaye": a price, maybe a total. */
const CURRENCY_BEFORE = wordSet(['₹', 'rs']);
const PRICE_BEFORE = new Set([...RATE_WORDS, ...CURRENCY_BEFORE]);
/** "30 per kilo", "प्रति kg 30": a rate. */
const PER_WORDS = wordSet(['per', 'prati', 'प्रति', 'pratee', 'fi']);
const POSSESSIVE = wordSet(['ka', 'ke', 'ki', 'का', 'के', 'की']);
/**
 * Units the form doesn't take (it is kg and ₹ per kg): a number with one of these is
 * not used, and the line's other unmarked numbers aren't guessed either.
 */
const OTHER_UNITS = wordSet([
    'quintal', 'quintals', 'qtl', 'kuntal', 'क्विंटल', 'कुंतल', 'कुन्तल', 'ton', 'tonne', 'टन',
    'bori', 'boriya', 'boriyan', 'बोरी', 'बोरियां', 'बोरियाँ', 'bag', 'bags', 'बैग', 'katta', 'katte', 'कट्टा', 'कट्टे',
    'packet', 'packets', 'पैकेट', 'peti', 'पेटी', 'dozen', 'दर्जन', 'piece', 'pieces', 'नग', 'litre', 'liter', 'लीटर'
]);
/** Before a number: the line's total, not the rate ("for 300", "कुल 300"). */
const TOTAL_BEFORE = wordSet(['for', 'total', 'kul', 'कुल', 'टोटल']);
/** After a number: the line's total ("300 total"). */
const TOTAL_AFTER = wordSet(['total', 'kul', 'कुल', 'टोटल']);
/** Around a later number: "10 kilo 300 mein", "10 kilo in 300": a total. */
const TOTAL_AFTER_A_WEIGHT = wordSet(['mein', 'me', 'mai', 'में', 'in']);
/** "de do" / "दो" at the end means "give", not 2. */
const GIVE_WORDS = wordSet(['do', 'दो']);
const GIVE_BEFORE = wordSet(['de', 'दे', 'dena', 'देना']);
/** Words never taken as the start of an item name. */
const NOT_ITEM_WORDS = wordSet([...WEIGHT_UNITS, ...PRICE_AFTER, ...PRICE_BEFORE, ...NUMBER_MODIFIERS.keys(), ...GRAM_UNITS,
    ...PER_WORDS, ...OTHER_UNITS, ...TOTAL_BEFORE, ...TOTAL_AFTER_A_WEIGHT,
    'and', 'aur', 'also', 'then', 'phir', 'with', 'wala', 'wale', 'वाला', 'वाले', 'और', 'फिर']);

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
        // "sava kilo" = 1.25 kg
        if (NUMBER_MODIFIERS.has(tokens[i]) && WEIGHT_UNITS.has(tokens[i + 1])) {
            groups.push({ value: 1 + NUMBER_MODIFIERS.get(tokens[i]), start, end: i + 1 });
            continue;
        }
        if (NUMBER_MODIFIERS.has(tokens[i]) && numberOf(tokens[i + 1]) !== undefined) {
            modifier = NUMBER_MODIFIERS.get(tokens[i]);
            i += 1;
        }
        const first = numberOf(tokens[i]);
        if (first === undefined || !Number.isFinite(first)) continue;
        let total = 0;
        // "sava sau" = 125: a quarter / half before a bare hundred or thousand scales it
        let cur = modifier && (first === 100 || first === 1000) && !isDigits(tokens[i]) ? (1 + modifier) * first : first + modifier;
        let lastWord = tokens[i];
        let j = i + 1;
        for (; j < tokens.length; j++) {
            if (tokens[j] === 'and' && !isDigits(lastWord) && cur >= 100 && cur % 100 === 0
                && numberOf(tokens[j + 1]) < 100 && !isDigits(tokens[j + 1])) continue;
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
 * What a number group is, from the words around it: 'weight' (kg), 'gram', 'rate'
 * (₹, unit not said), 'rate-kg' (₹ per kg said), 'rate-of' ("₹N ka": a rate only if a weight is said too), 'other' (another unit or a total: not used) or null (no word).
 * @param {string[]} rest tokens, the item's words blanked
 * @param {Array<{start: number, end: number}>} groups
 * @param {number} gi
 * @returns {?string}
 */
function numberKind(rest, groups, gi) {
    const g = groups[gi];
    const stop = gi + 1 < groups.length ? groups[gi + 1].start : rest.length;
    let after = null;
    let lastWord = null;
    let prevWord = null;
    let mein = false;
    let meinAfterRateWord = false;
    let possessive = false;
    let rupees = false;
    for (let k = g.end; k < stop; k++) {
        const w = rest[k];
        if (w) [prevWord, lastWord] = [lastWord, w];
        if (TOTAL_AFTER_A_WEIGHT.has(w) && prevWord !== 'give') {
            mein = true;
            meinAfterRateWord = RATE_WORDS.has(prevWord);
        }
        if (POSSESSIVE.has(w)) possessive = true;
        else if (PRICE_AFTER.has(w)) rupees = true;
        // a total word just before the next number belongs to that number ("30 rupees total 300")
        const total = TOTAL_AFTER.has(w) && !(k + 1 === stop && gi + 1 < groups.length);
        if (!after) {
            if (PER_WORDS.has(w)) after = WEIGHT_UNITS.has(rest[k + 1]) ? 'rate-kg' : 'other';
            else if (WEIGHT_UNITS.has(w)) after = 'weight';
            else if (GRAM_UNITS.has(w)) after = 'gram';
            else if (OTHER_UNITS.has(w) || total) after = 'other';
            else if (PRICE_AFTER.has(w)) after = 'rate';
        } else if (after === 'rate' && (OTHER_UNITS.has(w) || total)) after = 'other';
        else if (after === 'rate' && (WEIGHT_UNITS.has(w) || (PER_WORDS.has(w) && WEIGHT_UNITS.has(rest[k + 1])))) after = 'rate-kg';
    }
    const [b1, b2] = [rest[g.start - 1], rest[g.start - 2]];
    if (CURRENCY_BEFORE.has(b1)) {
        rupees = true;
        if (after === null) after = 'rate';
        else if (after === 'weight') after = 'rate-kg';
    }
    if (after === 'other') return 'other';
    // "300 rupaye ke 10 kilo" / "300 ka 10 kilo": the price of that weight, a total (but "30 ka 1 kilo" is a rate)
    // and so is "60 rupaye mein 2 kilo"
    const next = groups[gi + 1];
    const nextIsWeight = next && next.value !== 1 && (WEIGHT_UNITS.has(rest[next.end]) || GRAM_UNITS.has(rest[next.end]));
    if (after !== 'weight' && after !== 'gram' && POSSESSIVE.has(lastWord) && nextIsWeight) return 'other';
    if ((after === null || after === 'rate') && mein && !meinAfterRateWord && nextIsWeight && !RATE_WORDS.has(b1)) return 'other';
    if (WEIGHT_UNITS.has(b1) && PER_WORDS.has(b2) && after !== 'weight') return 'rate-kg';
    if (RATE_WORDS.has(b1)) {
        // "30 (rupaye) ka bhav 10 kilo": the rate word belongs to the 30, and 10 is the weight
        const between = gi > 0 ? rest.slice(groups[gi - 1].end, g.start - 1) : null;
        const earlier = between !== null && between.every(w => !w || PRICE_AFTER.has(w) || POSSESSIVE.has(w));
        if (!(earlier && (after === 'weight' || after === 'gram'))) return after === 'rate-kg' || after === 'weight' ? 'rate-kg' : 'rate';
    }
    // "2 kilo 60 (rupaye) mein" is a total; "30 ke bhav mein" a rate
    if (gi > 0 && (((after === null || after === 'rate') && mein && !meinAfterRateWord)
        || (after !== 'weight' && after !== 'gram' && TOTAL_AFTER_A_WEIGHT.has(b1)))) return 'other';
    if (TOTAL_BEFORE.has(b1) || (CURRENCY_BEFORE.has(b1) && TOTAL_BEFORE.has(b2))) return 'other';
    // "10 kilo ke 300" is a total, "kilo ka 30" a rate per kg
    if (POSSESSIVE.has(b1) && GRAM_UNITS.has(b2)) return 'other';
    if (POSSESSIVE.has(b1) && WEIGHT_UNITS.has(b2)) return gi > 0 && groups[gi - 1].end === g.start - 2 ? 'other' : 'rate-kg';
    // "60 rupaye ka" with no kilo word: maybe a rate, maybe what to buy for ₹60
    if (after === 'rate' && possessive && rupees) return 'rate-of';
    return after;
}

/**
 * A rate more than 3 times above or below every rate kept for the item (purchase,
 * sale, wholesale) is likely a total or a slip: the check dialog warns.
 * @param {number} rate
 * @param {?Object} item
 */
export function isUnusualRate(rate, item) {
    const known = [...(item?.rates || []), ...(item?.saleRates || []), ...(item?.wholesaleRates || [])]
        .map(Number).filter(r => Number.isFinite(r) && r > 0);
    if (known.length === 0) return false;
    return rate > 3 * Math.max(...known) || rate * 3 < Math.min(...known);
}

/**
 * Parses one spoken bill line.
 *
 * A number followed by a weight word is the weight (grams become kg), one followed by a rupee word
 * (or after "at" / "₹" / "rate") is the rate; numbers with no such word fill the
 * weight first, then the rate, in spoken order ("10 kilo aloo 30" → 10 kg at ₹30).
 * @param {string} text what the speech recogniser heard
 * @param {Array<Object>} items AppState.items
 * @returns {{itemIndex: ?number, weight: ?number, rate: ?number, extraNumbers: boolean, rateUnusual: boolean, heard: string}}
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
    // Bags, quintals or a weight word with no number before it: don't guess the unmarked numbers
    let otherUnit = rest.some(w => OTHER_UNITS.has(w)) || rest.some((w, k) => (WEIGHT_UNITS.has(w) || GRAM_UNITS.has(w))
        && !groups.some(g => g.end === k) && !PER_WORDS.has(rest[k - 1]) && !PRICE_AFTER.has(rest[k - 1]) && !(rest[k - 1] === 'a' && PRICE_AFTER.has(rest[k - 2]))
        && !POSSESSIVE.has(rest[k + 1]));
    let ratePerKg = false;
    let rateOf = false;
    groups.forEach((g, gi) => {
        const kind = numberKind(rest, groups, gi);
        const lone = g.end === g.start + 1 && GIVE_WORDS.has(rest[g.start]);
        if (!kind && lone && (g.end === rest.length || GIVE_BEFORE.has(rest[g.start - 1]))) return;
        if (!kind && lone) {
            unmarked.push(NaN);
            return;
        }
        const wasKg = kgJustSet;
        kgJustSet = false;
        if (kind === 'weight' && weight === null) {
            weight = g.value;
            kgJustSet = true;
        } else if (kind === 'gram' && weight === null) weight = g.value / 1000;
        else if (kind === 'gram' && wasKg && g.value < 1000) weight = Math.round((weight + g.value / 1000) * 1000) / 1000;
        else if ((kind === 'rate' || kind === 'rate-kg' || kind === 'rate-of') && rate === null) {
            rate = g.value;
            ratePerKg = kind === 'rate-kg';
            rateOf = kind === 'rate-of';
        }
        else if (!kind) unmarked.push(g.value);
        else unmarked.push(NaN);
    });
    let extraNumbers = unmarked.some(n => Number.isNaN(n));
    for (const n of unmarked.filter(v => !Number.isNaN(v))) {
        if (otherUnit) extraNumbers = true;
        else if (weight === null) weight = n;
        else if (rate === null) rate = n;
        else extraNumbers = true;
    }
    // With quintals or bags in the line, a rate said only in rupees may be per quintal / bag;
    // "100 rupaye ka chawal" with no weight is an amount to buy, not a rate
    if (rate !== null && ((otherUnit && !ratePerKg) || (rateOf && weight === null))) {
        rate = null;
        extraNumbers = true;
    }
    const rateUnusual = rate !== null && item !== null && isUnusualRate(rate, items[item.index]);
    return { itemIndex: item ? item.index : null, weight, rate, extraNumbers, rateUnusual, heard };
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