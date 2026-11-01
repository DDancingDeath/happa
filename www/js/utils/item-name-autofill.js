/**
 * @fileoverview Offline English ↔ Hindi item-name suggestions (#134): a small
 * table of common grain and produce names, else a letter-by-letter
 * transliteration (Latin ↔ Devanagari). Pure, no network; the Items dialog
 * shows the result as a suggestion and never overwrites a field the user typed.
 * @module utils/item-name-autofill
 */

// Common item names. Several English / romanised spellings share one Hindi name.
const TO_HINDI = {
    wheat: 'गेहूं', gehu: 'गेहूं', gehun: 'गेहूं', gehoon: 'गेहूं',
    rice: 'चावल', chawal: 'चावल', chaval: 'चावल', paddy: 'धान', dhan: 'धान', dhaan: 'धान',
    maize: 'मक्का', corn: 'मक्का', makka: 'मक्का', makki: 'मक्की',
    mustard: 'सरसों', sarson: 'सरसों', sarso: 'सरसों', rai: 'राई',
    gram: 'चना', chana: 'चना', channa: 'चना', chickpea: 'चना', chickpeas: 'चना',
    moong: 'मूंग', mung: 'मूंग', urad: 'उड़द', masoor: 'मसूर', masur: 'मसूर', lentil: 'मसूर', lentils: 'मसूर',
    arhar: 'अरहर', tur: 'तूर', toor: 'तूर', soybean: 'सोयाबीन', soyabean: 'सोयाबीन', soya: 'सोया',
    barley: 'जौ', jau: 'जौ', bajra: 'बाजरा', millet: 'बाजरा', jowar: 'ज्वार', sorghum: 'ज्वार', ragi: 'रागी',
    groundnut: 'मूंगफली', peanut: 'मूंगफली', peanuts: 'मूंगफली', moongfali: 'मूंगफली', mungfali: 'मूंगफली',
    sesame: 'तिल', til: 'तिल', linseed: 'अलसी', alsi: 'अलसी', mahua: 'महुआ', castor: 'अरंडी',
    coriander: 'धनिया', dhaniya: 'धनिया', dhania: 'धनिया', cumin: 'जीरा', jeera: 'जीरा', jira: 'जीरा',
    fenugreek: 'मेथी', methi: 'मेथी', turmeric: 'हल्दी', haldi: 'हल्दी', chilli: 'मिर्च', chili: 'मिर्च',
    mirch: 'मिर्च', mirchi: 'मिर्ची', onion: 'प्याज', pyaz: 'प्याज', pyaj: 'प्याज', potato: 'आलू', aloo: 'आलू', alu: 'आलू',
    garlic: 'लहसुन', lahsun: 'लहसुन', ginger: 'अदरक', adrak: 'अदरक', sugar: 'चीनी', cheeni: 'चीनी', chini: 'चीनी',
    jaggery: 'गुड़', gud: 'गुड़', gur: 'गुड़', flour: 'आटा', atta: 'आटा', aata: 'आटा', besan: 'बेसन',
    peas: 'मटर', matar: 'मटर', rajma: 'राजमा', cotton: 'कपास', kapas: 'कपास', dal: 'दाल', daal: 'दाल',
    poha: 'पोहा', suji: 'सूजी', sooji: 'सूजी', semolina: 'सूजी', maida: 'मैदा', oil: 'तेल', tel: 'तेल',
    ghee: 'घी', salt: 'नमक', namak: 'नमक', tea: 'चाय', chai: 'चाय', bran: 'चोकर', chokar: 'चोकर',
    seed: 'बीज', seeds: 'बीज', beej: 'बीज', black: 'काला', kala: 'काला', white: 'सफेद', green: 'हरा', red: 'लाल',
    yellow: 'पीला', small: 'छोटा', big: 'बड़ा', new: 'नया', old: 'पुराना',
    kali: 'काली', kaali: 'काली', peeli: 'पीली', pili: 'पीली', lal: 'लाल', hari: 'हरी', dana: 'दाना', daana: 'दाना',
    tamatar: 'टमाटर', ajwain: 'अजवाइन', saunf: 'सौंफ', kalonji: 'कलौंजी', imli: 'इमली', kabuli: 'काबुली',
    basmati: 'बासमती', hing: 'हींग', elaichi: 'इलायची', laung: 'लौंग', amchur: 'अमचूर', kutki: 'कुटकी',
    ramtil: 'रामतिल', kodo: 'कोदो', sabudana: 'साबूदाना', makhana: 'मखाना', chironji: 'चिरौंजी', badam: 'बादाम',
    kaju: 'काजू', kishmish: 'किशमिश', nariyal: 'नारियल', gond: 'गोंद', lobia: 'लोबिया', kulthi: 'कुलथी',
    matki: 'मटकी', moth: 'मोठ', masala: 'मसाला', sabut: 'साबुत', mota: 'मोटा', patla: 'पतला'
};

// Hindi → the English name the app usually stores.
const TO_ENGLISH = {
    'गेहूं': 'Wheat', 'चावल': 'Rice', 'धान': 'Paddy', 'मक्का': 'Maize', 'मक्की': 'Makki', 'सरसों': 'Mustard', 'राई': 'Rai',
    'चना': 'Chana', 'मूंग': 'Moong', 'उड़द': 'Urad', 'मसूर': 'Masoor', 'अरहर': 'Arhar', 'तूर': 'Toor',
    'सोयाबीन': 'Soybean', 'सोया': 'Soya', 'जौ': 'Barley', 'बाजरा': 'Bajra', 'ज्वार': 'Jowar', 'रागी': 'Ragi',
    'मूंगफली': 'Groundnut', 'तिल': 'Til', 'अलसी': 'Alsi', 'महुआ': 'Mahua', 'अरंडी': 'Castor',
    'धनिया': 'Dhaniya', 'जीरा': 'Jeera', 'मेथी': 'Methi', 'हल्दी': 'Haldi', 'मिर्च': 'Mirch', 'मिर्ची': 'Mirchi',
    'प्याज': 'Onion', 'आलू': 'Potato', 'लहसुन': 'Garlic', 'अदरक': 'Ginger', 'चीनी': 'Sugar', 'गुड़': 'Gud',
    'आटा': 'Atta', 'बेसन': 'Besan', 'मटर': 'Matar', 'राजमा': 'Rajma', 'कपास': 'Cotton', 'दाल': 'Dal',
    'पोहा': 'Poha', 'सूजी': 'Suji', 'मैदा': 'Maida', 'तेल': 'Oil', 'घी': 'Ghee', 'नमक': 'Salt', 'चाय': 'Tea',
    'चोकर': 'Chokar', 'बीज': 'Seed', 'काला': 'Kala', 'सफेद': 'Safed', 'हरा': 'Hara', 'लाल': 'Lal', 'पीला': 'Peela',
    'छोटा': 'Chhota', 'बड़ा': 'Bada', 'नया': 'Naya', 'पुराना': 'Purana',
    'काली': 'Kali', 'पीली': 'Peeli', 'हरी': 'Hari', 'दाना': 'Dana', 'टमाटर': 'Tomato', 'अजवाइन': 'Ajwain', 'सौंफ': 'Saunf',
    'कलौंजी': 'Kalonji', 'इमली': 'Imli', 'काबुली': 'Kabuli', 'बासमती': 'Basmati', 'हींग': 'Hing', 'इलायची': 'Elaichi',
    'लौंग': 'Laung', 'अमचूर': 'Amchur', 'कुटकी': 'Kutki', 'रामतिल': 'Ramtil', 'कोदो': 'Kodo', 'साबूदाना': 'Sabudana',
    'मखाना': 'Makhana', 'चिरौंजी': 'Chironji', 'बादाम': 'Badam', 'काजू': 'Kaju', 'किशमिश': 'Kishmish', 'नारियल': 'Nariyal',
    'गोंद': 'Gond', 'लोबिया': 'Lobia', 'कुलथी': 'Kulthi', 'मटकी': 'Matki', 'मोठ': 'Moth', 'मसाला': 'Masala',
    'साबुत': 'Sabut', 'मोटा': 'Mota', 'पतला': 'Patla'
};

const LATIN_CONSONANTS = [
    ['chh', 'छ'], ['ksh', 'क्ष'], ['kh', 'ख'], ['gh', 'घ'], ['ch', 'च'], ['jh', 'झ'], ['th', 'थ'], ['dh', 'ध'],
    ['ph', 'फ'], ['bh', 'भ'], ['sh', 'श'], ['k', 'क'], ['g', 'ग'], ['c', 'क'], ['j', 'ज'], ['t', 'त'], ['d', 'द'],
    ['n', 'न'], ['p', 'प'], ['b', 'ब'], ['m', 'म'], ['y', 'य'], ['r', 'र'], ['l', 'ल'], ['v', 'व'], ['w', 'व'],
    ['s', 'स'], ['h', 'ह'], ['f', 'फ'], ['z', 'ज'], ['q', 'क'], ['x', 'क्स']
];
// [latin, independent letter, sign after a consonant]
const LATIN_VOWELS = [
    ['aa', 'आ', 'ा'], ['ai', 'ऐ', 'ै'], ['au', 'औ', 'ौ'], ['ee', 'ई', 'ी'], ['ii', 'ई', 'ी'], ['oo', 'ऊ', 'ू'],
    ['uu', 'ऊ', 'ू'], ['a', 'अ', ''], ['i', 'इ', 'ि'], ['u', 'उ', 'ु'], ['e', 'ए', 'े'], ['o', 'ओ', 'ो']
];
const WORD_END_SIGN = { a: 'ा', i: 'ी', u: 'ू' };
const LONG_VOWELS = new Set(['aa', 'ai', 'au', 'ee', 'ii', 'oo', 'uu', 'e', 'o']);

const DEV_CONSONANTS = {
    'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
    'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
    'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh',
    'ष': 'sh', 'स': 's', 'ह': 'h'
};
const DEV_NUKTA = { 'ड': 'r', 'ढ': 'rh', 'क': 'q', 'ख': 'kh', 'ग': 'g', 'ज': 'z', 'फ': 'f' };
const DEV_VOWELS = {
    'अ': 'a', 'आ': 'a', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऋ': 'ri'
};
const DEV_SIGNS = {
    'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ृ': 'ri'
};
const HALANT = '्';
const NUKTA = '़';
const ANUSVARA = 'ं';

const DEVANAGARI = /[\u0900-\u097F]/;

const TO_ENGLISH_BY_KEY = new Map(Object.entries(TO_ENGLISH).map(([k, v]) => [hindiKey(k), v]));
const TO_HINDI_BY_KEY = new Map(Object.entries(TO_HINDI));

// Two-word trade names whose words alone would name another commodity ("black gram" is urad, not chana)
const PHRASES_TO_HINDI = new Map([
    ['black gram', 'उड़द'], ['green gram', 'मूंग'], ['red gram', 'अरहर'], ['horse gram', 'कुलथी'], ['bengal gram', 'चना'],
    ['pigeon pea', 'अरहर'], ['lady finger', 'भिंडी'], ['bottle gourd', 'लौकी'], ['bitter gourd', 'करेला']
]);

const DEVANAGARI_DIGITS = /[\u0966-\u096F]/g;

// Units and codes kept as typed (the Hindi screens also write "kg")
const KEEP_AS_TYPED = new Set(['kg', 'kgs', 'g', 'gm', 'gms', 'ml', 'l', 'ltr', 'qtl', 'pc', 'pcs', 'no']);
// Kilo anywhere is the weight unit, written "kg" in Hindi too (never the Hindi word)
const KILO_WORDS = new Set(['kilo', 'kilos', 'kilogram', 'kilograms', 'kgm']);
// Unit words after a number ("50 gram"): kept as typed, never read as an item ("gram" is also chana)
const UNIT_WORDS = new Set(['gram', 'grams', 'kilo', 'kilos', 'kilogram', 'kilograms', 'litre', 'litres', 'liter', 'liters', 'quintal', 'quintals']);
// Hindi unit words a user may type → the unit the English name writes. The kilo words are
// escaped: they are only recognised here, the app never shows them (hindi-kg-unit.test.js).
const HINDI_UNITS = new Map([['\u0915\u093F\u0932\u094B', 'kg'], ['\u0915\u093F\u0917\u094D\u0930\u093E', 'kg'], ['\u0915\u093F\u0932\u094B\u0917\u094D\u0930\u093E\u092E', 'kg'], ['ग्राम', 'g'], ['लीटर', 'L'], ['क्विंटल', 'qtl']]);

/** Hindi spelling variants that mean the same word (chandrabindu, nukta, NFC). */
function hindiKey(s) {
    return String(s || '').normalize('NFC').replace(/\u0901/g, ANUSVARA).trim();
}

function tokenizeLatin(word) {
    const tokens = [];
    let i = 0;
    while (i < word.length) {
        const rest = word.slice(i);
        const v = LATIN_VOWELS.find(([l]) => rest.startsWith(l));
        if (v) {
            tokens.push({ type: 'V', latin: v[0], letter: v[1], sign: v[2] });
            i += v[0].length;
            continue;
        }
        const c = LATIN_CONSONANTS.find(([l]) => rest.startsWith(l));
        if (c) {
            tokens.push({ type: 'C', latin: c[0], letter: c[1] });
            i += c[0].length;
            continue;
        }
        i += 1;
    }
    return tokens;
}

/**
 * Romanised Hindi word → Devanagari ("chana" → "चना", "moong" → "मूंग").
 * @param {string} word Latin letters
 * @returns {string}
 */
export function latinToDevanagari(word) {
    const tokens = tokenizeLatin(String(word || '').toLowerCase());
    let out = '';
    tokens.forEach((tok, i) => {
        const prev = tokens[i - 1];
        const next = tokens[i + 1];
        const last = i === tokens.length - 1;
        if (tok.type === 'V') {
            if (prev?.type === 'C') out += last && tok.latin in WORD_END_SIGN ? WORD_END_SIGN[tok.latin] : tok.sign;
            // a word ending in -ia / -ea / -ua: दलिया, बथुआ
            else if (last && prev && tok.latin === 'a') out += ['i', 'e', 'ee', 'ii'].includes(prev.latin) ? 'या' : 'आ';
            else out += tok.letter;
            return;
        }
        // n after a vowel and before a consonant (or ending a word after a long vowel) is nasal: मूंग, सरसों
        if (tok.latin === 'n' && prev?.type === 'V' && ((next?.type === 'C' && next.latin !== 'y') || (last && LONG_VOWELS.has(prev.latin)))) {
            out += ANUSVARA;
            return;
        }
        out += tok.letter;
        if (next?.type === 'C') out += HALANT;
    });
    return out;
}

/**
 * Devanagari word → romanised Latin, with the usual silent "a" dropped
 * ("सरसों" → "sarson", "धनिया" → "dhaniya").
 * @param {string} word
 * @returns {string}
 */
export function devanagariToLatin(word) {
    const chars = [...String(word || '').normalize('NFC')];
    const units = [];
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch in DEV_CONSONANTS) {
            let c = DEV_CONSONANTS[ch];
            if (chars[i + 1] === NUKTA) {
                c = DEV_NUKTA[ch] || c;
                i++;
            }
            const unit = { c, v: 'a', inherent: true };
            const nextCh = chars[i + 1];
            if (nextCh === HALANT) {
                unit.v = '';
                unit.inherent = false;
                i++;
            } else if (nextCh in DEV_SIGNS) {
                unit.v = DEV_SIGNS[nextCh];
                unit.inherent = false;
                i++;
            }
            units.push(unit);
        } else if (ch in DEV_VOWELS) {
            units.push({ c: '', v: DEV_VOWELS[ch], inherent: false });
        } else if (ch === ANUSVARA || ch === '\u0901') {
            if (units.length) units[units.length - 1].nasal = true;
        } else if (ch === 'ः') {
            if (units.length) units[units.length - 1].v += 'h';
        }
    }
    const last = units.length - 1;
    if (last > 0 && units[last].inherent && !units[last].nasal) units[last].v = '';
    for (let i = 1; i < last; i++) {
        const u = units[i];
        if (u.inherent && !u.nasal && units[i - 1].v && units[i + 1].c && units[i + 1].v) u.v = '';
    }
    return units.map(u => u.c + u.v + (u.nasal ? 'n' : '')).join('');
}

const capitalize = (w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w);

/**
 * Suggested Hindi name for an English (or romanised) item name, word by word:
 * letter runs are translated or spelled in Devanagari; numbers, units glued to
 * them, punctuation and spaces stay as typed ("Sugar 50kg" → "चीनी 50kg").
 * @param {string} english
 * @returns {string} '' when there is nothing to suggest
 */
export function suggestHindiName(english) {
    const text = String(english || '').trim();
    if (!text || DEVANAGARI.test(text) || !/[A-Za-z]/.test(text)) return '';
    const parts = text.split(/([A-Za-z]+)/).filter(p => p !== '');
    const isWord = (p) => /^[A-Za-z]+$/.test(p);
    let out = '';
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!isWord(part)) {
            out += part;
            continue;
        }
        if (KILO_WORDS.has(part.toLowerCase())) {
            out += 'kg';
            // "kilo gram" / "kilo-gram" is one unit
            if (/^[\s-]?$/.test(parts[i + 1] || 'x') && /^grams?$/i.test(parts[i + 2] || '')) i += 2;
            else if (/^grams?$/i.test(parts[i + 1] || '')) i += 1;
            continue;
        }
        // A letter run glued to digits ("50kg", "No1") is a code or a unit: kept as typed
        const afterNumber = /\d\s*$/.test(parts[i - 1] || '');
        if (KEEP_AS_TYPED.has(part.toLowerCase()) || (afterNumber && UNIT_WORDS.has(part.toLowerCase()))
            || /\d$/.test(parts[i - 1] || '') || /^\d/.test(parts[i + 1] || '')) {
            out += part;
            continue;
        }
        const key = part.toLowerCase();
        const phrase = /^\s+$/.test(parts[i + 1] || '') && isWord(parts[i + 2] || '') ? `${key} ${parts[i + 2].toLowerCase()}` : null;
        if (phrase && PHRASES_TO_HINDI.has(phrase)) {
            out += PHRASES_TO_HINDI.get(phrase);
            i += 2;
            continue;
        }
        out += TO_HINDI_BY_KEY.get(key) || latinToDevanagari(key);
    }
    return out.replace(/\s+/g, ' ').trim();
}

/**
 * Suggested English name for a Hindi item name: Devanagari words translated when
 * every one is known, else all spelled out (never half translated); numbers (also
 * Devanagari digits), punctuation and Latin words stay as typed.
 * @param {string} hindi
 * @returns {string} '' when there is nothing to suggest
 */
export function suggestEnglishName(hindi) {
    const text = String(hindi || '').trim().replace(DEVANAGARI_DIGITS, d => String(d.charCodeAt(0) - 0x0966))
        // the abbreviated kilo (dots, danda or the abbreviation sign) and "kilo gram" are one unit: kg
        .replace(/\u0915\u093F[.\u0964\u0970]\s?\u0917\u094D\u0930\u093E(?:\u092E|[.\u0964\u0970])?(?![\u0900-\u0963\u0971-\u097F])/g, 'kg')
        .replace(/\u0915\u093F\u0932\u094B[\s-]*\u0917\u094D\u0930\u093E\u092E(?![\u0900-\u0963\u0971-\u097F])/g, 'kg');
    if (!text || !DEVANAGARI.test(text)) return '';
    // danda, double danda and the abbreviation sign are punctuation, not letters
    const parts = text.split(/([\u0900-\u0963\u0971-\u097F]+)/).filter(p => p !== '');
    const isWord = (p) => /[\u0900-\u0963\u0971-\u097F]/.test(p);
    const words = parts.filter(isWord).map(hindiKey).filter(w => !HINDI_UNITS.has(w));
    const known = words.every(w => TO_ENGLISH_BY_KEY.has(w));
    return parts.map(p => {
        if (!isWord(p)) return p;
        const key = hindiKey(p);
        if (HINDI_UNITS.has(key)) return HINDI_UNITS.get(key);
        return known ? TO_ENGLISH_BY_KEY.get(key) : capitalize(devanagariToLatin(key));
    }).join('').replace(/\s+/g, ' ').trim();
}

/**
 * What to put in the other name field after the user typed in one of them.
 * The other field is filled only while it is empty or still holds an earlier
 * suggestion; a value the user typed (or that was saved) is never replaced.
 * @param {{typed: boolean, suggested: boolean, value: string}} other the other field
 * @param {string} suggestion
 * @returns {?string} the new value, or null to leave the field alone
 */
export function autofillValue(other, suggestion) {
    if (other.typed) return null;
    if (other.value && !other.suggested) return null;
    return suggestion || '';
}
