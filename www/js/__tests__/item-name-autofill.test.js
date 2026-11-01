/**
 * Offline English ↔ Hindi item-name suggestions (#134).
 */
import { suggestHindiName, suggestEnglishName, latinToDevanagari, devanagariToLatin, autofillValue } from '../utils/item-name-autofill.js';

describe('common grain and produce names', () => {
    test.each([
        ['Wheat', 'गेहूं'], ['gehu', 'गेहूं'], ['Rice', 'चावल'], ['Paddy', 'धान'], ['Maize', 'मक्का'],
        ['Mustard', 'सरसों'], ['Chana', 'चना'], ['Moong', 'मूंग'], ['Urad', 'उड़द'], ['Masoor', 'मसूर'],
        ['Soybean', 'सोयाबीन'], ['Bajra', 'बाजरा'], ['Jowar', 'ज्वार'], ['Groundnut', 'मूंगफली'], ['Mahua', 'महुआ'],
        ['Dhaniya', 'धनिया'], ['Jeera', 'जीरा'], ['Haldi', 'हल्दी'], ['Chana Dal', 'चना दाल'], ['Kali Mirch', 'काली मिर्च'],
        ['  basmati   RICE ', 'बासमती चावल']
    ])('%s → %s', (en, hi) => {
        expect(suggestHindiName(en)).toBe(hi);
    });

    test.each([
        ['गेहूं', 'Wheat'], ['गेहूँ', 'Wheat'], ['सरसों', 'Mustard'], ['चना', 'Chana'], ['मूंग', 'Moong'],
        ['उड़द', 'Urad'], ['मक्का', 'Maize'], ['चना दाल', 'Chana Dal'], ['महुआ', 'Mahua'], ['अलसी', 'Alsi']
    ])('%s → %s', (hi, en) => {
        expect(suggestEnglishName(hi)).toBe(en);
    });
});

describe('names not in the table are spelled out', () => {
    test('romanised Hindi → Devanagari: clusters, nasal n, word-end vowels', () => {
        expect(latinToDevanagari('makka')).toBe('मक्का');
        expect(latinToDevanagari('mirchi')).toBe('मिर्ची');
        expect(latinToDevanagari('sarson')).toBe('सर्सों');
        expect(latinToDevanagari('baingan')).toBe('बैंगन');
        expect(latinToDevanagari('aloo')).toBe('अलू');
        expect(suggestHindiName('Binaula')).toBe('बिनौला');
    });

    test('Devanagari → Latin drops the silent a, keeps nasal n', () => {
        expect(devanagariToLatin('सरसों')).toBe('sarson');
        expect(devanagariToLatin('धनिया')).toBe('dhaniya');
        expect(devanagariToLatin('मक्का')).toBe('makka');
        expect(devanagariToLatin('बिनौला')).toBe('binaula');
        expect(suggestEnglishName('बिनौला खली')).toBe('Binaula Khali');
    });

    test('a half-known Hindi name is spelled out whole, never half translated', () => {
        expect(suggestEnglishName('चना बिनौला')).toBe('Chana Binaula');
    });

    test('nothing to suggest for empty text or the wrong script', () => {
        expect(suggestHindiName('')).toBe('');
        expect(suggestHindiName('गेहूं')).toBe('');
        expect(suggestEnglishName('Wheat')).toBe('');
        expect(suggestEnglishName('   ')).toBe('');
    });
});

describe('autofillValue never overwrites a typed field', () => {
    test('empty or suggested field is filled; typed or saved field is left alone', () => {
        expect(autofillValue({ typed: false, suggested: false, value: '' }, 'चना')).toBe('चना');
        expect(autofillValue({ typed: false, suggested: true, value: 'चन' }, 'चना')).toBe('चना');
        expect(autofillValue({ typed: true, suggested: false, value: 'चना' }, 'गेहूं')).toBeNull();
        expect(autofillValue({ typed: false, suggested: false, value: 'चना' }, 'गेहूं')).toBeNull();
        expect(autofillValue({ typed: false, suggested: true, value: 'चना' }, '')).toBe('');
    });
});
