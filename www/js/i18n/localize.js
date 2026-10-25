/**
 * @fileoverview One-language text from records that carry both languages (#143):
 * `{ en, hi }` label objects, stored anomaly / flag records, and old stored
 * sentences saved as "English / हिंदी" (read-only fallback for old docs).
 * @module i18n/localize
 */

import { getLang } from './index.js';

const DEVANAGARI = /[\u0900-\u097F]/;
const SEP = ' / ';

/**
 * The part of an old combined "English / Hindi" sentence for `lang`.
 * Text without the separator, or without both scripts, is returned unchanged.
 * @param {string} text
 * @param {'en'|'hi'} [lang]
 * @returns {string}
 */
export function splitBilingual(text, lang = getLang()) {
    const s = String(text ?? '');
    if (!s.includes(SEP) || !DEVANAGARI.test(s) || !/[A-Za-z]/.test(s)) return s;
    const parts = s.split(SEP);
    let cut = -1;
    if (parts.length % 2 === 0 && DEVANAGARI.test(parts.slice(parts.length / 2).join(SEP))) cut = parts.length / 2;
    if (cut === -1) cut = parts.findIndex((p, i) => i > 0 && DEVANAGARI.test(p) && !DEVANAGARI.test(parts[i - 1]));
    if (cut <= 0) return s;
    return (lang === 'hi' ? parts.slice(cut) : parts.slice(0, cut)).join(SEP).trim();
}

/**
 * Text in the current language from `{ en, hi }` (falls back to the other language,
 * then to an old combined `message`). Strings are split as old combined text.
 * @param {Object|string|null|undefined} value
 * @param {'en'|'hi'} [lang]
 * @returns {string}
 */
export function pickLang(value, lang = getLang()) {
    if (value == null) return '';
    if (typeof value !== 'object') return splitBilingual(value, lang);
    const own = value[lang];
    if (own != null && String(own) !== '') return String(own);
    const other = value[lang === 'hi' ? 'en' : 'hi'];
    if (other != null && String(other) !== '') return String(other);
    if (value.message != null) return splitBilingual(value.message, lang);
    return '';
}
