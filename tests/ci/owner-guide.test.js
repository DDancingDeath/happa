/**
 * Owner guide (#148): docs/owner-guide.md (English) and docs/owner-guide.hi.md
 * (Hindi) hold the words and the runbook; each page has its own short doc,
 * docs/pages/<page>.md and <page>.hi.md, explaining it in plain words with the
 * spec IDs of docs/calculations.md, cited in brackets. Every ID they cite must
 * exist there, each English / Hindi pair cites the same IDs (so one is not updated
 * without the other), and the Hindi docs are in one language (Latin only for
 * codes, units and product names).
 */
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const read = (name) => fs.readFileSync(path.join(DOCS, name), 'utf8');
const guideEn = read('owner-guide.md');
const guideHi = read('owner-guide.hi.md');
const PAGE_FILES = fs.readdirSync(path.join(DOCS, 'pages')).filter(f => f.endsWith('.md'));
const PAGES = PAGE_FILES.filter(f => !f.endsWith('.hi.md')).map(f => f.slice(0, -3)).sort();
const HI_PAGES = PAGE_FILES.filter(f => f.endsWith('.hi.md')).map(f => f.slice(0, -6)).sort();
const readIf = (name) => (fs.existsSync(path.join(DOCS, name)) ? read(name) : '');
const pageEn = Object.fromEntries(HI_PAGES.concat(PAGES).map(p => [p, readIf(`pages/${p}.md`)]));
const pageHi = Object.fromEntries(HI_PAGES.concat(PAGES).map(p => [p, readIf(`pages/${p}.hi.md`)]));
const en = [guideEn, ...Object.values(pageEn)].join('\n');
const hi = [guideHi, ...Object.values(pageHi)].join('\n');
const calc = read('calculations.md');

/** Codes in brackets that are not spec IDs. */
const NOT_IDS = new Set(['IST', 'UPI', 'CSV', 'PDF', 'ID']);
/** A spec-ID-shaped token: capitals and digits, optionally hyphenated (T1, BILL-DUE, RENT-12, T-LAB-3). */
const TOKEN = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*\b/g;

/** Spec IDs cited in a guide: every ID-shaped token inside brackets; "T10–T12", "RENT-1 to RENT-3" include those between. */
function citedIds(text) {
    const ids = new Set();
    const prose = text.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/`[^`]*`/g, '');
    for (const [, inside] of prose.matchAll(/\(([^()]*)\)/g)) {
        (inside.match(TOKEN) || []).filter(t => !NOT_IDS.has(t)).forEach(t => ids.add(t));
        for (const m of inside.matchAll(/\b([A-Z]+-?)(\d+)\s*(?:–|to|से)\s*\1(\d+)\b/g)) {
            for (let n = Number(m[2]); n <= Number(m[3]); n++) ids.add(`${m[1]}${n}`);
        }
    }
    return ids;
}

/** IDs defined in calculations.md: the first cell of a table row; RT* / PT* also as their family (RT, PT). */
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
    test('finds the cited IDs, ranges included, and would notice a wrong one', () => {
        expect([...citedIds('Net (T10–T12), rent (RENT-1 to RENT-3), labour (T-LAB-3), check (AC15), time (IST)')].sort())
            .toEqual(['AC15', 'RENT-1', 'RENT-2', 'RENT-3', 'T-LAB-3', 'T10', 'T11', 'T12']);
        expect(definedIds().has('AC15')).toBe(false);
    });

    test('every spec ID it cites is defined in calculations.md', () => {
        const defined = definedIds();
        const missing = [...citedIds(en), ...citedIds(hi)].filter(id => !defined.has(id));
        expect([...new Set(missing)]).toEqual([]);
    });

    test('the English and Hindi guides cite the same spec IDs', () => {
        expect([...citedIds(hi)].sort()).toEqual([...citedIds(en)].sort());
        expect([...citedIds(guideHi)].sort()).toEqual([...citedIds(guideEn)].sort());
    });

    test('one doc per page, in English and Hindi, each pair citing the same spec IDs, all listed in the guides', () => {
        expect(PAGES.length).toBeGreaterThanOrEqual(13);
        expect(HI_PAGES).toEqual(PAGES);
        for (const p of PAGES) {
            expect([p, [...citedIds(pageHi[p])].sort()]).toEqual([p, [...citedIds(pageEn[p])].sort()]);
            expect(guideEn).toContain(`](pages/${p}.md)`);
            expect(guideHi).toContain(`](pages/${p}.hi.md)`);
        }
    });

    test('the Hindi guide is in Hindi: Latin only for codes, units and product names', () => {
        const ALLOWED = new Set(['happa', 'kg', 'WhatsApp', 'CSV', 'PDF', 'Excel', 'R']);
        const prose = hi
            .replace(/\[[^\]]*\]\([^)]*\)/g, '')
            .replace(/`[^`]*`/g, '')
            .replace(TOKEN, '');
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
