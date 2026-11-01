/**
 * @fileoverview Home-screen shortcuts of the installed web app (#151): the
 * manifest's `shortcuts` open `/?shortcut=<key>`; after sign-in the app shows the
 * page (and bill mode) of that key. Unknown keys are ignored.
 * @module utils/launch-shortcut
 */

/** Shortcut key → the page and, for Billing, the bill mode it opens. */
export const SHORTCUTS = Object.freeze({
    sale: Object.freeze({ tab: 'billing', mode: 'sale' }),
    purchase: Object.freeze({ tab: 'billing', mode: 'purchase' }),
    history: Object.freeze({ tab: 'history' })
});

/**
 * The shortcut a launch URL asks for.
 * @param {string} search - `location.search`
 * @returns {?{tab: string, mode?: string}}
 */
export function shortcutFromSearch(search) {
    const key = new URLSearchParams(search || '').get('shortcut');
    return key && Object.prototype.hasOwnProperty.call(SHORTCUTS, key) ? { ...SHORTCUTS[key] } : null;
}

/**
 * The launch URL without its `shortcut` parameter, so a reload doesn't open it again.
 * @param {string} pathname
 * @param {string} search
 * @param {string} [hash]
 * @returns {string}
 */
export function withoutShortcut(pathname, search, hash = '') {
    const params = new URLSearchParams(search || '');
    params.delete('shortcut');
    const rest = params.toString();
    return `${pathname}${rest ? `?${rest}` : ''}${hash}`;
}
