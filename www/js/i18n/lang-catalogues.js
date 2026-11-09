/**
 * @fileoverview Where the language catalogues come from (#59): each one is imported only
 * when its language is needed, so start-up parses one catalogue, not both. Jest maps this
 * file to tests/support/lang-catalogues.js, which has both loaded up front.
 * @module i18n/lang-catalogues
 */

/** @type {Object<string, Object<string, string>>} catalogues available without an import */
export const PRELOADED = {};

/**
 * @param {'en'|'hi'} lang
 * @returns {Promise<{default: Object<string, string>}>}
 */
export function importCatalogue(lang) {
    return lang === 'hi' ? import('./hi.js') : import('./en.js');
}
