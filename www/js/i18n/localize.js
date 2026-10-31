/**
 * @fileoverview One-language text from records that carry both languages (#143):
 * `{ en, hi }` label objects, stored anomaly / flag records, and old stored
 * sentences saved as "English / हिंदी" (read-only fallback for old docs).
 * @module i18n/localize
 */

import { getLang, t } from './index.js';

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

export const AUDIT_ACTIONS = ['CREATE_BILL', 'DELETE_BILL', 'EDIT_BILL', 'VOID_BILL', 'CREATE_SALE', 'DELETE_SALE', 'EDIT_SALE', 'CREATE_ITEM',
    'DELETE_ITEM', 'EDIT_ITEM', 'UPDATE_PAYMENT', 'RECORD_PAYMENT', 'CLEAR_DUE', 'ADJUST_STOCK', 'OVERRIDE_CHECK', 'RECORD_WITHDRAWAL',
    'RECORD_EXPENSE', 'EDIT_EXPENSE', 'DELETE_EXPENSE', 'CLEAR_DATA', 'CHANGE_ROLE_ACCESS', 'LOGIN', 'LOGOUT',
    'RENT_PAYMENT', 'RENT_METER', 'RENT_MOVE_IN', 'RENT_MOVE_OUT', 'RENT_UNIT_CHANGE', 'RENT_CHANGE', 'RENT_LINK_ON', 'RENT_LINK_OFF',
    'RENT_RECEIPT_ISSUE', 'RENT_RECEIPT_VOID', 'RENT_SETTINGS',
    'CASH_OPEN', 'CASH_CLOSE', 'SETTINGS_CHANGE', 'HIDE_ERRORS'];

/**
 * Audit action code (CREATE_BILL) in the app language; unknown codes as plain words.
 * @param {string} action
 * @returns {string}
 */
export function auditActionLabel(action = '') {
    return AUDIT_ACTIONS.includes(action) ? t(`ui.diag.a_${action.toLowerCase()}`) : String(action).replace(/_/g, ' ');
}
