/**
 * Owner guide (#148): docs/owner-guide.md (English) and docs/owner-guide.hi.md
 * (Hindi) explain each page in plain words with the spec IDs of
 * docs/calculations.md. Every ID they cite must exist there, both guides cite the
 * same IDs (so one is not updated without the other), and the Hindi guide is in
 * one language (Latin only for codes, units and product names).
 */
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const read = (name) => fs.readFileSync(path.join(DOCS, name), 'utf8');
const en = read('owner-guide.md');
const hi = read('owner-guide.hi.md');
const calc = read('calculations.md');

const ID = /\b(?:BILL-[A-Z]+(?:-[A-Z]+)*|RENT-\d+|T-LAB-\d|BF-[A-Z]+|WS-[A-Z]+|DUE-[A-Z]+|EXP-[A-Z]+|AVG-COST|MONEY-ROUND|COGS|VOID|OPENING|DAY|CMP|PARTY|(?:T|C|S|O|M|I|ST)\d{1,2}|RT|PT)\b/g;

/** Spec IDs in a guide; "T10–T12" and "RENT-1 to RENT-3" count every ID between. */
function citedIds(text) {
    const ids = new Set(text.match(ID) || []);
    for (const m of text.matchAll(/\b([A-Z]+-?)(\d+)\s*(?:–|to|से)\s*\1(\d+)\b/g)) {
        for (let n = Number(m[2]); n <= Number(m[3]); n++) ids.add(`${m[1]}${n}`);
    }
    return ids;
}

/** IDs defined in calculations.md: the first cell of a table row, or a family prefix (RT1 → RT). */
function definedIds() {
    const ids = new Set();
    for (const m of calc.matchAll(/^\|\s*([A-Z][A-Z0-9-]*(?:,\s*[A-Z][A-Z0-9-]*)*)\s*\|/gm)) {
        m[1].split(/,\s*/).forEach(id => {
            ids.add(id);
            const family = /^(RT|PT)/.exec(id);
            if (family) ids.add(family[1]);
        });
    }
    return ids;
}

describe('owner guide (#148)', () => {
    test('every spec ID it cites is defined in calculations.md', () => {
        const defined = definedIds();
        const missing = [...citedIds(en), ...citedIds(hi)].filter(id => !defined.has(id));
        expect([...new Set(missing)]).toEqual([]);
    });

    test('the English and Hindi guides cite the same spec IDs', () => {
        expect([...citedIds(hi)].sort()).toEqual([...citedIds(en)].sort());
    });

    test('the Hindi guide is in Hindi: Latin only for codes, units and product names', () => {
        const ALLOWED = new Set(['happa', 'kg', 'WhatsApp', 'CSV', 'PDF', 'Excel', 'R']);
        const prose = hi
            .replace(/\[[^\]]*\]\([^)]*\)/g, '')
            .replace(/`[^`]*`/g, '')
            .replace(ID, '');
        const latin = [...new Set(prose.match(/[A-Za-z]+/g) || [])].filter(w => !ALLOWED.has(w));
        expect(latin).toEqual([]);
    });

    test('the runbook covers the situations the owner asked for', () => {
        for (const [guide, words] of [
            [en, ['Every day', 'Every week', 'printer is not printing', 'not syncing', 'cash does not match', 'entered twice', 'phone was lost', 'Battery', 'Backups']],
            [hi, ['हर दिन', 'हर हफ़्ते', 'प्रिंटर नहीं छाप रहा', 'सिंक नहीं हो रहे', 'नकद मेल नहीं खा रहा', 'दो बार लिखा गया', 'फ़ोन खो गया', 'बैटरी', 'बैकअप']]
        ]) {
            words.forEach(w => expect(guide).toContain(w));
        }
    });
});
