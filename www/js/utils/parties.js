// @ts-check
/**
 * @fileoverview PARTY (docs/calculations.md): the one rule for when two bills
 * belong to the same customer or supplier, and which spelling of the name to
 * show. Bills match when their names are equal with case, extra spaces and
 * Unicode form (NFC) ignored. Nothing else is folded: "Ramesh Ji", "R. Kumar",
 * "रमेश" and a nukta letter (क़ vs क) stay separate parties.
 * Dues, statements, Insights and the cash page group, filter and compare parties
 * through here (#139); the exceptions are listed in docs/architecture.md (PARTY row).
 * Pure: no DOM, Firestore or AppState.
 * @module utils/parties
 */

/**
 * The PARTY key of a name: Unicode NFC, trimmed, inner spaces collapsed to one, lower case.
 * @param {*} name
 * @returns {string} '' when there is no name
 */
export function partyNameKey(name) {
    return String(name ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * True when two names are the same party ('' never matches).
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function sameParty(a, b) {
    const x = partyNameKey(a);
    return x !== '' && x === partyNameKey(b);
}

/**
 * A name as one spelling of a party: trimmed, inner spaces collapsed, case and form kept.
 * @param {*} name
 * @returns {string}
 */
export function partyNameSpelling(name) {
    return String(name ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * The duplicate-bill check's name key: trimmed and lower case only, no NFC and no
 * space collapsing. Kept apart from partyNameKey so that warning fires exactly as
 * before #139 ("Ram  Lal" and "Ram Lal" are not the same bill to it).
 * @param {*} name
 * @returns {string}
 */
export function duplicateCheckNameKey(name) {
    return name == null ? '' : String(name).trim().toLowerCase();
}

const capitals = (/** @type {string} */ s) => (String(s).match(/(^|\s)\p{Lu}/gu) || []).length;

/**
 * The spelling to show for a party seen under several spellings ("test party",
 * "Test Party"): the most used one; on a tie the one with more capitalised
 * words, then the latest seen.
 * @param {Map<string, {count: number, last: number}>} spellings raw name → use count and last time
 * @returns {string}
 */
export function pickPartyName(spellings) {
    let best = '';
    /** @type {?{count: number, last: number}} */
    let bestInfo = null;
    (spellings || new Map()).forEach((info, name) => {
        if (!name) return;
        const better = !bestInfo || info.count > bestInfo.count
            || (info.count === bestInfo.count && (capitals(name) > capitals(best)
                || (capitals(name) === capitals(best) && info.last > bestInfo.last)));
        if (better) { best = name; bestInfo = info; }
    });
    return best;
}

/**
 * Groups raw party names by partyNameKey and picks one display spelling
 * per party (pickPartyName).
 * @param {Iterable<string>} names raw names, one per bill (repeats count)
 * @returns {Map<string, string>} key → display name
 */
export function partyDisplayNames(names) {
    const byKey = new Map();
    let i = 0;
    for (const raw of names || []) {
        const name = partyNameSpelling(raw);
        const key = partyNameKey(name);
        if (!key) continue;
        if (!byKey.has(key)) byKey.set(key, new Map());
        const spellings = byKey.get(key);
        const info = spellings.get(name) || { count: 0, last: 0 };
        info.count++;
        info.last = ++i;
        spellings.set(name, info);
    }
    const out = new Map();
    byKey.forEach((spellings, key) => out.set(key, pickPartyName(spellings)));
    return out;
}
