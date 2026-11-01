/**
 * @fileoverview Voice billing parser (#81, spec VB-1): one spoken line → item,
 * weight and rate exactly as heard, in English, Hindi and mixed speech.
 */
import { parseVoiceLine, pickVoiceLine, hasVoiceValues, isUnusualRate, voiceTokens } from '../utils/voice-parse.js';

const ITEMS = [
    { id: 'a', name: 'Aloo', hindiName: 'आलू' },
    { id: 'p', name: 'Pyaaz', hindiName: 'प्याज़' },
    { id: 'r', name: 'Rice 1121', hindiName: 'चावल' },
    { id: 'o', name: 'Old Dal', hindiName: 'पुरानी दाल', archived: true },
    { id: 'm', name: 'Moong Dal', hindiName: 'मूंग दाल' }
];
const KILO = '\u0915\u093F\u0932\u094B';
const line = (text) => {
    const { itemIndex, weight, rate } = parseVoiceLine(text, ITEMS);
    return { itemIndex, weight, rate };
};

describe('parseVoiceLine (VB-1)', () => {
    test.each([
        ['10 kilo aloo at 30 rupees', 0, 10, 30],
        ['aloo 10 kg 30', 0, 10, 30],
        ['5kg pyaaz ₹25', 1, 5, 25],
        ['30 rupees 5 kilo aloo', 0, 5, 30],
        ['aloo 10 kilo 30 rupees kilo', 0, 10, 30],
        ['rice 1121 48.5 kg 32', 2, 48.5, 32],
        ['moong dal 20 kg rate 95.50', 4, 20, 95.5],
        ['twenty five kg aloo thirty', 0, 25, 30],
        ['aloo das kilo tees ka', 0, 10, 30],
        ['aloo do sau kilo pachas', 0, 200, 50]
    ])('English / Hinglish: %s', (text, itemIndex, weight, rate) => {
        expect(line(text)).toEqual({ itemIndex, weight, rate });
    });

    test.each([
        [`दस ${KILO} आलू तीस रुपये`, 0, 10, 30],
        [`आलू १० ${KILO} ३० रुपये`, 0, 10, 30],
        ['चावल 50 kg 42 का', 2, 50, 42],
        [`साढ़े बारह ${KILO} प्याज़ पैंतालीस रुपये`, 1, 12.5, 45],
        [`डेढ़ ${KILO} आलू`, 0, 1.5, null],
        ['मूंग दाल निन्यानवे kg भाव अट्ठासी', 4, 99, 88]
    ])('Hindi: %s', (text, itemIndex, weight, rate) => {
        expect(line(text)).toEqual({ itemIndex, weight, rate });
    });

    test('Hindi numbers 1–99 all parse, and "das tees" stays two numbers', () => {
        const words = ['एक', 'तेईस', 'उनतालीस', 'इक्यावन', 'सड़सठ', 'उनासी', 'नवासी', 'तिरानवे'];
        expect(words.map(w => parseVoiceLine(`${w} kg`).weight)).toEqual([1, 23, 39, 51, 67, 79, 89, 93]);
        // ढ़ typed as one code point (U+095D) or as ढ + nukta reads the same
        expect(parseVoiceLine('\u0938\u093E\u095D\u0947 \u0926\u0938 kg').weight).toBe(10.5);
        expect(parseVoiceLine('\u0938\u093E\u0922\u093C\u0947 \u0926\u0938 kg').weight).toBe(10.5);
        expect(line('das tees')).toEqual({ itemIndex: null, weight: 10, rate: 30 });
        expect(line('aloo 100 50')).toEqual({ itemIndex: 0, weight: 100, rate: 50 });
    });

    test('saadhe / sava / paune change the number they come before, also before sau', () => {
        expect(line(`साढ़े तीन सौ ${KILO} चावल 30 रुपये`)).toEqual({ itemIndex: 2, weight: 350, rate: 30 });
        expect(line('saadhe chaar hazaar kilo 30').weight).toBe(4500);
        expect(line('sava do kilo rice 1121 40')).toEqual({ itemIndex: 2, weight: 2.25, rate: 40 });
        expect(line('paune do kilo aloo 40')).toEqual({ itemIndex: 0, weight: 1.75, rate: 40 });
    });

    test('sava / paune / saadhe before a bare sau or hazaar', () => {
        expect(line(`सवा सौ ${KILO} चावल`).weight).toBe(125);
        expect(line('paune sau kilo aloo').weight).toBe(75);
        expect(line('saadhe sau kilo aloo').weight).toBe(150);
        expect(line('sava hazaar kilo aloo').weight).toBe(1250);
        expect(line('dedh sau kilo aloo').weight).toBe(150);
        expect(line('ek sau bees kilo aloo').weight).toBe(120);
        expect(line('aloo one hundred and twenty kilo thirty')).toEqual({ itemIndex: 0, weight: 120, rate: 30 });
    });

    test('per kilo makes a rate', () => {
        expect(line('aloo 10 kg 30 per kilo')).toEqual({ itemIndex: 0, weight: 10, rate: 30 });
        expect(line('aloo 30 per kilo')).toEqual({ itemIndex: 0, weight: null, rate: 30 });
        expect(line(`चावल 30 प्रति ${KILO}`)).toEqual({ itemIndex: 2, weight: null, rate: 30 });
        expect(line(`चावल प्रति ${KILO} 30`)).toEqual({ itemIndex: 2, weight: null, rate: 30 });
        expect(line('aloo per kg 30 10 kilo')).toEqual({ itemIndex: 0, weight: 10, rate: 30 });
        expect(line(`आलू ${KILO} का 30`)).toEqual({ itemIndex: 0, weight: null, rate: 30 });
    });

    test('other units and totals are never guessed into weight or rate', () => {
        const flagged = (text) => {
            const p = parseVoiceLine(text, ITEMS);
            return { weight: p.weight, rate: p.rate, extraNumbers: p.extraNumbers };
        };
        expect(flagged('चावल 1 क्विंटल 2500')).toEqual({ weight: null, rate: null, extraNumbers: true });
        expect(flagged('rice 1121 1 quintal 2500 rupees')).toEqual({ weight: null, rate: null, extraNumbers: true });
        expect(flagged('rice 1121 2 bori 50 kilo 30 per kilo')).toEqual({ weight: 50, rate: 30, extraNumbers: true });
        expect(flagged('aloo 2 bori 30')).toEqual({ weight: null, rate: null, extraNumbers: true });
        expect(flagged('aloo 5 kilo 2 packet')).toEqual({ weight: 5, rate: null, extraNumbers: true });
        expect(flagged('aloo rate 2500 per quintal')).toEqual({ weight: null, rate: null, extraNumbers: true });
        expect(flagged('aloo 10 kilo for 300')).toEqual({ weight: 10, rate: null, extraNumbers: true });
        expect(flagged('aloo 10 kilo total 300')).toEqual({ weight: 10, rate: null, extraNumbers: true });
        expect(flagged(`चावल 10 ${KILO} के 300 रुपये`)).toEqual({ weight: 10, rate: null, extraNumbers: true });
        expect(flagged('aloo 10 kilo 300 total')).toEqual({ weight: 10, rate: null, extraNumbers: true });
        expect(flagged('aloo 10 kilo 300 rupees total')).toEqual({ weight: 10, rate: null, extraNumbers: true });
        expect(flagged('चावल 300 रुपये के 10 kg')).toEqual({ weight: 10, rate: null, extraNumbers: true });
        expect(flagged('चावल तीन सौ रुपये का दस kg')).toEqual({ weight: 10, rate: null, extraNumbers: true });
        expect(flagged('aloo 300 ka 10 kilo')).toEqual({ weight: 10, rate: null, extraNumbers: true });
        expect(flagged('aloo 10 kilo 300 mein')).toEqual({ weight: 10, rate: null, extraNumbers: true });
        expect(flagged('aloo 10 kilo in 300 rupees')).toEqual({ weight: 10, rate: null, extraNumbers: true });
        expect(flagged('aloo 30 rupees ka 1 kilo')).toEqual({ weight: 1, rate: 30, extraNumbers: false });
        expect(flagged('aloo 30 rupees per kilo 10 kilo')).toEqual({ weight: 10, rate: 30, extraNumbers: false });
        expect(flagged('aloo 500 gram ka 22')).toEqual({ weight: 0.5, rate: null, extraNumbers: true });
        expect(flagged('100 रुपये का चावल दे दो')).toEqual({ weight: null, rate: null, extraNumbers: true });
        expect(flagged('चावल 60 रुपये का')).toEqual({ weight: null, rate: null, extraNumbers: true });
        expect(flagged('aloo 30 rupees per kilo mein')).toEqual({ weight: null, rate: 30, extraNumbers: false });
        expect(flagged('चावल 10 kg 30 के भाव में')).toEqual({ weight: 10, rate: 30, extraNumbers: false });
        expect(flagged('aloo 30 me 10 kilo')).toEqual({ weight: 10, rate: 30, extraNumbers: false });
        expect(flagged('चावल 10 kg 300 रुपये टोटल')).toEqual({ weight: 10, rate: null, extraNumbers: true });
        expect(flagged('aloo 10 kilo at 30 total 300')).toEqual({ weight: 10, rate: 30, extraNumbers: true });
        expect(flagged('aloo ten kilos thirty rupees a kilo')).toEqual({ weight: 10, rate: 30, extraNumbers: false });
        expect(flagged('rice 1121 1 quintal, 25 rupees per kilo')).toEqual({ weight: null, rate: 25, extraNumbers: true });
        expect(flagged('aloo 25 kg bag 900')).toEqual({ weight: 25, rate: null, extraNumbers: true });
        expect(flagged('aloo 25 kilo wala bag 900')).toEqual({ weight: 25, rate: null, extraNumbers: true });
    });
    test('half, quarter and sava kilo', () => {
        expect(line('rice 1121 aadha kilo 40')).toEqual({ itemIndex: 2, weight: 0.5, rate: 40 });
        expect(line(`चावल आधा ${KILO} 40`)).toEqual({ itemIndex: 2, weight: 0.5, rate: 40 });
        expect(line('aloo half kg 40 rupees')).toEqual({ itemIndex: 0, weight: 0.5, rate: 40 });
        expect(line('aloo paav kilo 40')).toEqual({ itemIndex: 0, weight: 0.25, rate: 40 });
        expect(line('aloo sava kilo 40')).toEqual({ itemIndex: 0, weight: 1.25, rate: 40 });
        expect(line('aloo paune kilo 40')).toEqual({ itemIndex: 0, weight: 0.75, rate: 40 });
        expect(parseVoiceLine('aloo bada kilo 40', ITEMS)).toMatchObject({ weight: null, rate: null, extraNumbers: true });
    });

    test('"do" meaning "give" is not the number 2', () => {
        expect(line(`चावल 10 ${KILO} दो`)).toEqual({ itemIndex: 2, weight: 10, rate: null });
        expect(line('rice 1121 10 kilo de do')).toEqual({ itemIndex: 2, weight: 10, rate: null });
        expect(parseVoiceLine('aloo 10 kilo do 30', ITEMS)).toMatchObject({ weight: 10, rate: 30, extraNumbers: true });
        expect(line('do kilo aloo 30')).toEqual({ itemIndex: 0, weight: 2, rate: 30 });
    });
    test('grams are read as kg', () => {
        expect(line('500 gram aloo 40 rupees')).toEqual({ itemIndex: 0, weight: 0.5, rate: 40 });
        expect(line('चावल 250 ग्राम 40 रुपये')).toEqual({ itemIndex: 2, weight: 0.25, rate: 40 });
        expect(line('aloo 750g 40')).toEqual({ itemIndex: 0, weight: 0.75, rate: 40 });
        expect(line(`आलू 1 ${KILO} 500 ग्राम 40 रुपये`)).toEqual({ itemIndex: 0, weight: 1.5, rate: 40 });
        expect(parseVoiceLine('aloo 2 kg 30 rupees 500 gram', ITEMS)).toMatchObject({ weight: 2, rate: 30, extraNumbers: true });
    });
    test('only a weight, only a rate, or only the item leaves the rest empty', () => {
        expect(line('do kilo aloo')).toEqual({ itemIndex: 0, weight: 2, rate: null });
        expect(line('rate 30')).toEqual({ itemIndex: null, weight: null, rate: 30 });
        expect(line('pyaaz')).toEqual({ itemIndex: 1, weight: null, rate: null });
    });

    test('archived items are never matched; a close spelling is', () => {
        expect(line('old dal 10 kg 30').itemIndex).toBeNull();
        expect(line('aaloo 10 kg').itemIndex).toBeNull();
        expect(line('pyaazz 10 kg').itemIndex).toBe(1);
    });

    test('flags more numbers than a weight and a rate', () => {
        expect(parseVoiceLine('aloo 10 kg 30 rupees 40', ITEMS).extraNumbers).toBe(true);
        expect(parseVoiceLine('aloo 10 kg 5 kg', ITEMS)).toMatchObject({ weight: 10, extraNumbers: true });
        expect(parseVoiceLine('aloo 10 kg 30', ITEMS).extraNumbers).toBe(false);
    });

    test('nothing usable', () => {
        expect(hasVoiceValues(parseVoiceLine('hello there', ITEMS))).toBe(false);
        expect(hasVoiceValues(parseVoiceLine('', ITEMS))).toBe(false);
        expect(hasVoiceValues(parseVoiceLine('aloo', ITEMS))).toBe(true);
    });
});

describe('isUnusualRate', () => {
    const rice = { name: 'Rice', rates: [28, 30], saleRates: [34] };
    test('more than 3× above or below every kept rate', () => {
        expect([30, 90, 102, 103, 11, 9].map(r => isUnusualRate(r, rice))).toEqual([false, false, false, true, false, true]);
        expect(isUnusualRate(500, { name: 'New' })).toBe(false);
    });
    test('flags a spoken total', () => {
        expect(parseVoiceLine('rice 10 kilo 300', [rice])).toMatchObject({ weight: 10, rate: 300, rateUnusual: true });
        expect(parseVoiceLine('rice 10 kilo 30', [rice]).rateUnusual).toBe(false);
    });
});
describe('pickVoiceLine', () => {
    test('prefers the alternative with an item and a weight', () => {
        const p = pickVoiceLine(['10 kilo allu 30', '10 kilo aloo 30'], ITEMS);
        expect(p).toMatchObject({ itemIndex: 0, weight: 10, rate: 30, heard: '10 kilo aloo 30' });
    });

    test('falls back to the first alternative', () => {
        expect(pickVoiceLine(['hmm', 'okay'], ITEMS).heard).toBe('hmm');
        expect(pickVoiceLine([], ITEMS).heard).toBe('');
    });
});

test('voiceTokens splits digits from words and keeps decimals', () => {
    expect(voiceTokens('₹30, 10kg; 48.5Kg.')).toEqual(['₹', '30', '10', 'kg', '48.5', 'kg']);
});
