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
 * Suggested Hindi name for an English (or romanised) item name, word by word.
 * @param {string} english
 * @returns {string} '' when there is nothing to suggest
 */
export function suggestHindiName(english) {
    const text = String(english || '').trim();
    if (!text || DEVANAGARI.test(text)) return '';
    return text.split(/\s+/).map(w => {
        const key = w.toLowerCase().replace(/[^a-z]/g, '');
        if (!key) return w;
        return TO_HINDI[key] || latinToDevanagari(key);
    }).filter(Boolean).join(' ');
}

/**
 * Suggested English name for a Hindi item name, word by word.
 * @param {string} hindi
 * @returns {string} '' when there is nothing to suggest
 */
export function suggestEnglishName(hindi) {
    const text = String(hindi || '').trim();
    if (!text || !DEVANAGARI.test(text)) return '';
    const words = text.split(/\s+/).map(hindiKey);
    // All words known: the usual names; otherwise spell every word out (no half-translated names)
    if (words.every(w => TO_ENGLISH_BY_KEY.has(w))) return words.map(w => TO_ENGLISH_BY_KEY.get(w)).join(' ');
    return words.map(w => capitalize(devanagariToLatin(w))).filter(Boolean).join(' ');
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
