// @ts-check
/**
 * @fileoverview Local usage counters (#136): which features are used on this
 * phone, per day. Event names come from the fixed list below, never from user
 * text, so a counter can't hold a name, phone number or amount. Pure: the
 * store (services/usage.js) keeps the rows in IndexedDB on the phone only.
 * Spec: docs/calculations.md USE-1.
 * @module utils/usage-stats
 */

/**
 * Event names (documented; anything else is dropped):
 * - `page.<page id>`: a page was opened (`aadhat:tabshown`, e.g. `page.billing`)
 * - `bill.save.purchases|retailSales|wholesaleSales`: a new bill was saved
 * - `payment.record`: a due payment was recorded on Outstanding
 * - `cash.close`: the cash day was closed
 * - `print.bill`: a bill was sent to the printer
 * - `share.whatsapp`: a bill was shared on WhatsApp
 * - `perf.diagnostic_run`: Diagnostics › Status speed check (#83)
 * - `voice.miss`: a voice line was heard but nothing in it was understood (#131, C13)
 * - `voice.miss.<8 hex>`: the same, per phrase: a salted hash of the words (voicePhraseHash), never the words (Q75)
 * - `voice.undo`: the last voice change was undone; `voice.edit`: a heard line was corrected before use
 */
export const USAGE_EVENTS = Object.freeze([
    'bill.save.purchases', 'bill.save.retailSales', 'bill.save.wholesaleSales',
    'payment.record', 'cash.close', 'print.bill', 'share.whatsapp', 'perf.diagnostic_run',
    'voice.miss', 'voice.undo', 'voice.edit'
]);

const PAGE_EVENT = /^page\.[a-z][a-z0-9-]{0,39}$/;
export const VOICE_MISS_PHRASE = /^voice\.miss\.[0-9a-f]{8}$/;

/**
 * A phrase lower-cased with its spacing and punctuation evened out, so the same words count together.
 * @param {string} text
 * @returns {string}
 */
export function voicePhraseText(text) {
    return String(text || '').normalize('NFC').toLowerCase().replace(/[\s,.;:!?।"“”'‘’()]+/g, ' ').trim();
}

/**
 * HMAC-SHA-256 of the phrase keyed with this phone's random salt, first 8 hex digits: the same
 * words on this phone give the same code, and the code can't be turned back into the words
 * without the salt, which never leaves the phone (#131 C13, Q75).
 * @param {string} text
 * @param {?string} salt this phone's salt (services/usage.js phraseSalt)
 * @param {?SubtleCrypto} [subtle]
 * @returns {Promise<?string>} 8 hex digits, or null without a salt or Web Crypto
 */
export async function voicePhraseHash(text, salt, subtle = globalThis.crypto?.subtle) {
    if (!salt || !subtle) return null;
    const enc = new TextEncoder();
    const key = await subtle.importKey('raw', enc.encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await subtle.sign('HMAC', key, enc.encode(voicePhraseText(text))));
    return [...sig.slice(0, 4)].map(n => n.toString(16).padStart(2, '0')).join('');
}

/**
 * The per-phrase miss counter's name, or null when it can't be hashed.
 * @param {string} text
 * @param {?string} salt
 * @param {?SubtleCrypto} [subtle]
 * @returns {Promise<?string>}
 */
export async function voiceMissEvent(text, salt, subtle = globalThis.crypto?.subtle) {
    const h = await voicePhraseHash(text, salt, subtle);
    return h ? `voice.miss.${h}` : null;
}

/** Days kept on the phone. */
export const USAGE_KEEP_DAYS = 90;

/**
 * @param {*} name
 * @returns {boolean} true for a documented event name
 */
export function isUsageEvent(name) {
    return typeof name === 'string' && (USAGE_EVENTS.includes(name) || PAGE_EVENT.test(name) || VOICE_MISS_PHRASE.test(name));
}

/** Store key of one counter. */
export const usageKey = (/** @type {string} */ day, /** @type {string} */ event) => `${day}|${event}`;

/**
 * Adds pending counts into stored rows.
 * @param {Array<{day: string, event: string, count: number}>} rows
 * @param {Map<string, number>} pending usageKey → count
 * @returns {Array<{day: string, event: string, count: number}>} new rows (input untouched)
 */
export function mergeUsage(rows, pending) {
    const byKey = new Map((rows || []).map(r => [usageKey(r.day, r.event), { ...r }]));
    pending.forEach((n, key) => {
        const [day, event] = key.split('|');
        const row = byKey.get(key) || { day, event, count: 0 };
        row.count += n;
        byKey.set(key, row);
    });
    return [...byKey.values()];
}

/**
 * USE-1: uses per event from `fromDay` to `toDay` (YYYY-MM-DD, inclusive), most used first
 * (ties by name), at most `limit`.
 * @param {Array<{day: string, event: string, count: number}>} rows
 * @param {{fromDay: string, toDay: string, limit?: number}} range
 * @returns {Array<{event: string, count: number}>}
 */
export function topUsage(rows, { fromDay, toDay, limit = 10 }) {
    const totals = new Map();
    (rows || []).forEach(r => {
        if (!r || r.day < fromDay || r.day > toDay || !isUsageEvent(r.event)) return;
        totals.set(r.event, (totals.get(r.event) || 0) + (Number(r.count) || 0));
    });
    return [...totals.entries()]
        .map(([event, count]) => ({ event, count }))
        .filter(r => r.count > 0)
        .sort((a, b) => b.count - a.count || (a.event < b.event ? -1 : 1))
        .slice(0, limit);
}

/**
 * Rows older than `oldestDay` (to drop).
 * @param {Array<{day: string}>} rows
 * @param {string} oldestDay
 * @returns {Array<{day: string}>}
 */
export function expiredUsage(rows, oldestDay) {
    return (rows || []).filter(r => r.day < oldestDay);
}
