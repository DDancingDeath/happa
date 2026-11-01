/**
 * @fileoverview Oracle for the voice billing check dialog (docs/calculations.md
 * VB-1): whatever weight and rate are spoken, in any order or language, the
 * dialog shows exactly those numbers and the item named.
 */
import fc from 'fast-check';
import { parseVoiceLine } from '../../www/js/utils/voice-parse.js';

const ITEMS = [{ name: 'Rice', hindiName: 'चावल' }, { name: 'Moong Dal', hindiName: 'मूंग दाल' }];
const KILO = '\u0915\u093F\u0932\u094B';
const HINDI_WORDS = ['दस', 'बीस', 'पच्चीस', 'तीस', 'पैंतीस', 'चालीस', 'पचास', 'साठ', 'पचहत्तर', 'नब्बे'];
const HINDI_VALUES = [10, 20, 25, 30, 35, 40, 50, 60, 75, 90];

const SHAPES = [
    (i, w, r) => `${w} kg ${i} ${r} rupees`,
    (i, w, r) => `${i} ${w} kilo at ${r}`,
    (i, w, r) => `${r} rupees ${w} kg ${i}`,
    (i, w, r) => `${i} ${w} ${r}`,
    (i, w, r) => `₹${r} ${i} ${w}kg`,
    (i, w, r) => `${i} ${w} ${KILO} ${r} रुपये`
];

describe('VB-1: values as heard', () => {
    test('digits: the spoken weight, rate and item in every phrase shape', () => {
        const amount = fc.integer({ min: 1, max: 99999 }).map(n => n / (n % 3 === 0 ? 10 : 1));
        fc.assert(fc.property(fc.integer({ min: 0, max: 1 }), fc.constantFrom('name', 'hindiName'), amount, amount,
            fc.integer({ min: 0, max: SHAPES.length - 1 }),
            (index, field, weight, rate, shape) => {
                const said = SHAPES[shape](ITEMS[index][field], String(weight), String(rate));
                expect(parseVoiceLine(said, ITEMS)).toMatchObject({ itemIndex: index, weight, rate, extraNumbers: false });
            }
        ), { numRuns: 300, seed: 81 });
    });

    test('Hindi number words', () => {
        fc.assert(fc.property(fc.integer({ min: 0, max: 9 }), fc.integer({ min: 0, max: 9 }), (w, r) => {
            const said = `${HINDI_WORDS[w]} ${KILO} चावल ${HINDI_WORDS[r]} रुपये`;
            expect(parseVoiceLine(said, ITEMS)).toMatchObject({ itemIndex: 0, weight: HINDI_VALUES[w], rate: HINDI_VALUES[r] });
        }), { numRuns: 100, seed: 81 });
    });
});
