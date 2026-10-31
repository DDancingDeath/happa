/**
 * @fileoverview Owner decision: in Hindi the weight unit is always "kg" ("50 kg", "₹/kg",
 * "प्रति kg"), never किलो / किलोग्राम / किग्रा / कि.ग्रा. Guards the catalogue, every
 * shipped file under www/ and old stored records shown through pickLang().
 */
const fs = require('fs');
const path = require('path');
import hi from '../i18n/hi.js';
import { pickLang } from '../i18n/localize.js';

const WWW = path.join(__dirname, '..', '..');
const HINDI_KILO = /किलो|किग्रा|कि\.\s?ग्रा/;
const TEXT_FILE = /\.(js|html|json|css|webmanifest|txt|md)$/;

function shippedFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // Tests keep old stored sentences on purpose (they still show, with kg, via pickLang).
            if (entry.name !== '__tests__' && entry.name !== 'node_modules') shippedFiles(full, out);
        } else if (TEXT_FILE.test(entry.name)) out.push(full);
    }
    return out;
}

describe('Hindi weight unit is "kg"', () => {
    test('no hi.js value uses the Hindi word for kilo', () => {
        expect(Object.keys(hi).filter(k => HINDI_KILO.test(hi[k]))).toEqual([]);
    });

    test('no shipped www/ file (templates, receipts, shares, exports, rentals, /r/) does either', () => {
        const hits = [];
        for (const f of shippedFiles(WWW)) {
            fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
                if (HINDI_KILO.test(line)) hits.push(`${path.relative(WWW, f).replace(/\\/g, '/')}:${i + 1}`);
            });
        }
        expect(hits).toEqual([]);
    });

    test('records stored before the rule show "kg" in Hindi; English and names are untouched', () => {
        const old = 'Mahua Naya: selling 1.0 kg, only 0.5 kg in stock / Mahua Naya: 1.0 किलो बिक्री, स्टॉक में सिर्फ़ 0.5 किलो';
        expect(pickLang({ message: old }, 'hi')).toBe('Mahua Naya: 1.0 kg बिक्री, स्टॉक में सिर्फ़ 0.5 kg');
        expect(pickLang({ en: 'Stock changed by 5 kg with no reason', hi: 'बिना कारण स्टॉक 5 किलो बदला' }, 'hi'))
            .toBe('बिना कारण स्टॉक 5 kg बदला');
        expect(pickLang({ hi: 'बड़ा स्टॉक बदलाव: 120किलोग्राम (100 कि.ग्रा. से ज़्यादा), 3 किग्रा' }, 'hi'))
            .toBe('बड़ा स्टॉक बदलाव: 120 kg (100 kg से ज़्यादा), 3 kg');
        expect(pickLang({ hi: 'किलोनी ट्रेडर्स' }, 'hi')).toBe('किलोनी ट्रेडर्स');
        expect(pickLang({ en: 'Name 5 किलो' }, 'en')).toBe('Name 5 किलो');
    });
});
