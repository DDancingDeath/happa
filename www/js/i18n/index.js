/**
 * @fileoverview App language (#143): one `t(key, params)` catalogue for English and Hindi.
 * Templates mark text with data-i18n / data-i18n-placeholder / data-i18n-title /
 * data-i18n-aria-label; applyTranslations() fills them and setLang() re-applies
 * everything without a reload. English is the default; the choice is kept per device.
 * @module i18n
 */

import en from './en.js';
import hi from './hi.js';

export const LANGS = ['en', 'hi'];
export const DEFAULT_LANG = 'en';
export const LANG_STORAGE_KEY = 'aadhat.lang';
/** The old What's new-only language choice; migrated into LANG_STORAGE_KEY once. */
export const LEGACY_WHATS_NEW_LANG_KEY = 'aadhat.whatsNewLang';
export const LANG_CHANGE_EVENT = 'aadhat:langchange';

const CATALOGUES = { en, hi };
const ATTRS = [
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-title', 'title'],
    ['data-i18n-aria-label', 'aria-label']
];

let current = null;

function defaultStore() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; }
}

export function normalizeLang(value) {
    return LANGS.includes(value) ? value : DEFAULT_LANG;
}

/**
 * Reads the saved language, migrating the old What's new choice the first time.
 * @param {Storage|null} [store]
 * @returns {'en'|'hi'}
 */
export function loadLang(store = defaultStore()) {
    if (!store) return DEFAULT_LANG;
    try {
        let value = store.getItem(LANG_STORAGE_KEY);
        if (!LANGS.includes(value)) {
            const legacy = store.getItem(LEGACY_WHATS_NEW_LANG_KEY);
            if (LANGS.includes(legacy)) {
                value = legacy;
                store.setItem(LANG_STORAGE_KEY, legacy);
            }
        }
        store.removeItem(LEGACY_WHATS_NEW_LANG_KEY);
        return normalizeLang(value);
    } catch (_) {
        return DEFAULT_LANG;
    }
}

export function getLang() {
    if (!current) current = loadLang();
    return current;
}

/** True once a language has been saved on this device (explicitly or migrated). */
export function hasSavedLang(store = defaultStore()) {
    try { return LANGS.includes(store?.getItem(LANG_STORAGE_KEY)); } catch (_) { return false; }
}

/** Replaces {name} placeholders; unknown names are left as they are. */
export function formatMessage(template, params) {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
        (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match));
}

/**
 * Text for `key` in the current language (falls back to English, then to the key).
 * @param {string} key
 * @param {Object<string, *>} [params] values for {name} placeholders
 * @param {'en'|'hi'} [lang]
 * @returns {string}
 */
export function t(key, params, lang = getLang()) {
    const text = CATALOGUES[lang]?.[key] ?? en[key] ?? key;
    return formatMessage(text, params);
}

/** Fills every data-i18n element (and attribute) below `root`. */
export function applyTranslations(root = typeof document !== 'undefined' ? document : null) {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = t(el.getAttribute('data-i18n'));
    });
    for (const [dataAttr, attr] of ATTRS) {
        root.querySelectorAll(`[${dataAttr}]`).forEach(el => {
            el.setAttribute(attr, t(el.getAttribute(dataAttr)));
        });
    }
    const lang = getLang();
    root.querySelectorAll('[data-lang-option]').forEach(btn => {
        btn.setAttribute('aria-pressed', String(btn.getAttribute('data-lang-option') === lang));
    });
}

/**
 * Switches the app language without a reload: saves it, re-applies the templates and
 * tells the open screens (LANG_CHANGE_EVENT) to re-render.
 * @param {'en'|'hi'} lang
 * @param {{store?: Storage|null}} [options]
 * @returns {'en'|'hi'}
 */
export function setLang(lang, { store = defaultStore() } = {}) {
    const next = normalizeLang(lang);
    const changed = next !== getLang();
    current = next;
    try { store?.setItem(LANG_STORAGE_KEY, next); } catch (_) { /* storage blocked */ }
    if (typeof document !== 'undefined') {
        document.documentElement.lang = next;
        applyTranslations(document);
    }
    if (changed && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(LANG_CHANGE_EVENT, { detail: { lang: next } }));
    }
    return next;
}

/** For tests: forget the cached language so the next getLang() reads storage again. */
export function resetLangForTests() {
    current = null;
}
