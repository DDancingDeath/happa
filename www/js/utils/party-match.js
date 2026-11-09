// @ts-check
/**
 * @fileoverview Customer / supplier name suggestions while billing (#139 phase 1, plan P3.B2):
 * the names already used on the bills loaded on this phone, matched in any spelling
 * (Latin or Devanagari, through the transliteration of utils/item-name-autofill.js),
 * and "Did you mean …?" for a new name close to a known one. Grouping and the shown
 * spelling stay PARTY (utils/parties.js); the loose spellings and honorifics are used
 * only for these suggestions, never to group bills. Pure: no DOM, Firestore or AppState.
 * @module utils/party-match
 */

import { partyDisplayNames, partyNameKey, partyNameSpelling } from './parties.js';
import { devanagariToLatin } from './item-name-autofill.js';
import { buildAging } from './aging.js';
import { billDateOf } from './history-filters.js';
import { isActiveBill } from './money.js';

const DEVANAGARI = /[\u0900-\u097F]/;
// Words of respect left out when comparing names for "Did you mean" ("Ramesh Ji" ~ "Ramesh")
const HONORIFICS = new Set(['ji', 'bhai', 'bhaiya', 'seth', 'sethji', 'sahab', 'saheb', 'shri', 'sri']);

/**
 * One word in a loose Latin spelling: "रमेश", "Ramesh" and "RAMESH" are "ramesh";
 * "Seeta" and "सीता" are "sita".
 * @param {*} word
 * @returns {string}
 */
export function looseWord(word) {
    const w = partyNameKey(word);
    const latin = DEVANAGARI.test(w) ? devanagariToLatin(w) : w;
    return latin.replace(/ph/g, 'f').replace(/w/g, 'v').replace(/z/g, 'j').replace(/q/g, 'k').replace(/ck/g, 'k')
        .replace(/[^a-z0-9]/g, '')
        .replace(/ee|ii/g, 'i').replace(/oo|uu/g, 'u')
        .replace(/([a-z])\1+/g, '$1');
}

/**
 * The loose words of a name.
 * @param {*} name
 * @returns {string[]}
 */
export function looseWords(name) {
    return partyNameKey(name).split(' ').map(looseWord).filter(Boolean);
}

/** The name in one loose run, honorifics left out (all kept when the name is only honorifics). */
function coreOf(/** @type {string[]} */ words) {
    const core = words.filter(w => !HONORIFICS.has(w));
    return (core.length ? core : words).join('');
}

/**
 * @typedef {{key: string, name: string, words: string[], core: string, last: number, count: number, due: number, dueBills: number}} PartyEntry
 * key: PARTY key; name: the spelling shown (the one used most); last: newest bill time (ms);
 * due: what is open on the party's loaded bills (the "Already owes" figure, PARTY)
 */

/**
 * The parties named on these bills, newest first (voided bills left out).
 * @param {?Array<?Rec>|undefined} bills
 * @param {{today?: Date, excludeId?: *}} [opts] excludeId: the bill being edited
 * @returns {PartyEntry[]}
 */
export function partyEntries(bills, { today = new Date(), excludeId = null } = {}) {
    const skip = excludeId === null || excludeId === undefined ? null : String(excludeId);
    const active = (bills || []).filter(b => isActiveBill(b) && (skip === null || String(b?.id) !== skip));
    /** @type {string[]} */
    const names = [];
    /** @type {Map<string, {last: number, count: number}>} */
    const seen = new Map();
    active.forEach(b => {
        const name = partyNameSpelling(b?.customerName ?? b?.supplierName);
        const key = partyNameKey(name);
        if (!key) return;
        names.push(name);
        const time = billDateOf(/** @type {Rec} */ (b))?.getTime() ?? 0;
        const info = seen.get(key) || { last: 0, count: 0 };
        seen.set(key, { last: Math.max(info.last, Number.isFinite(time) ? time : 0), count: info.count + 1 });
    });
    const dues = new Map(buildAging(/** @type {Bill[]} */ (active), { today }).parties.map(p => [p.key, p]));
    /** @type {PartyEntry[]} */
    const out = [];
    partyDisplayNames(names).forEach((name, key) => {
        const words = looseWords(name);
        const info = seen.get(key) || { last: 0, count: 0 };
        const due = dues.get(key);
        const open = due && due.total > 0 ? due : null;
        out.push({ key, name, words, core: coreOf(words), last: info.last, count: info.count, due: open ? open.total : 0, dueBills: open ? open.bills.length : 0 });
    });
    return out.sort((a, b) => b.last - a.last || b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Suggestions for a typed name: every typed word starts a word of the party's name, in any
 * spelling ("sit" → Sita Devi, "सीता" → Sita Devi, "devi s" → Sita Devi). Newest first; the
 * party already typed exactly is not suggested.
 * @param {PartyEntry[]} entries partyEntries()
 * @param {*} typed
 * @param {{limit?: number}} [opts]
 * @returns {PartyEntry[]}
 */
export function matchParties(entries, typed, { limit = 5 } = {}) {
    const key = partyNameKey(typed);
    const words = looseWords(typed);
    if (!key || !words.length) return [];
    return (entries || [])
        .filter(e => e.key !== key && words.every(w => e.words.some(x => x.startsWith(w))))
        .slice(0, limit);
}

/**
 * Edit distance of two strings, or `max + 1` once it is over `max`.
 * @param {string} a
 * @param {string} b
 * @param {number} max
 * @returns {number}
 */
export function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            best = Math.min(best, row[j]);
        }
        if (best > max) return max + 1;
        prev = row;
    }
    return prev[b.length];
}

/**
 * "Did you mean …?": a known party whose name is close to a typed name that no bill uses
 * yet. Close = the same loose spelling (honorifics left out: "Ramesh Ji" ~ "Ramesh",
 * "Seeta" ~ "सीता"), one starting the other with at least 4 letters ("Ramesh" ~ "Ramesh
 * Kumar"), or at most 1 letter different (2 from 6 letters on). The closest wins, then the
 * newest. A warning only: the typed name is always kept when the user says so.
 * @param {PartyEntry[]} entries partyEntries()
 * @param {*} typed
 * @returns {?PartyEntry}
 */
export function closeParty(entries, typed) {
    const key = partyNameKey(typed);
    if (!key || (entries || []).some(e => e.key === key)) return null;
    const core = coreOf(looseWords(typed));
    if (core.length < 3) return null;
    /** @type {?PartyEntry} */
    let best = null;
    let bestScore = Infinity;
    (entries || []).forEach(e => {
        const c = e.core;
        if (!c) return;
        const shorter = Math.min(c.length, core.length);
        let score;
        if (c === core) score = 0;
        else if (shorter >= 4 && (c.startsWith(core) || core.startsWith(c))) score = 1;
        else {
            const max = shorter >= 6 ? 2 : shorter >= 4 ? 1 : 0;
            if (!max) return;
            const d = editDistance(c, core, max);
            if (d > max) return;
            score = d;
        }
        if (score < bestScore) {
            best = e;
            bestScore = score;
        }
    });
    return best;
}
