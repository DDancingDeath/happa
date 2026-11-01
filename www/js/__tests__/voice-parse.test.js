/**
 * @fileoverview Voice billing parser (#81, spec VB-1): one spoken line → item,
 * weight and rate exactly as heard, in English, Hindi and mixed speech.
 */
import { parseVoiceLine, pickVoiceLine, hasVoiceValues, voiceTokens } from '../utils/voice-parse.js';

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
