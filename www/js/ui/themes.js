/**
 * @fileoverview The visual themes (redesign DIRECTION §4). Each theme's tokens live in the CSS:
 * www/css/variables.css for Modern Minimal (the default), www/css/themes/<id>.css for the others.
 * `kind: 'dark'` themes stay dark under Appearance Light or System; `kind: 'both'` themes follow it.
 */

export const DEFAULT_THEME = 'modern';
export const DEFAULT_APPEARANCE = 'system';
export const APPEARANCES = ['light', 'dark', 'system'];

/** Order = the gallery order. Name and description: i18n ui.settings.theme_<id> / theme_<id>_desc. */
export const THEMES = [
    { id: 'modern', kind: 'both' },
    { id: 'nordic', kind: 'both' },
    { id: 'nature', kind: 'both' },
    { id: 'dark', kind: 'dark' },
    { id: 'midnight', kind: 'dark' },
];

/** @param {string|null|undefined} id */
export const themeById = (id) => THEMES.find((th) => th.id === id) || null;
