/**
 * @fileoverview The visual themes (redesign DIRECTION §4). Each theme's tokens live in the CSS
 * (www/css/variables.css for Modern Minimal, the default). `kind: 'dark'` themes stay dark under
 * Appearance Light or System; `kind: 'both'` themes follow the appearance.
 */

export const DEFAULT_THEME = 'modern';
export const DEFAULT_APPEARANCE = 'system';
export const APPEARANCES = ['light', 'dark', 'system'];

export const THEMES = [
    { id: 'modern', kind: 'both' },
];

/** @param {string|null|undefined} id */
export const themeById = (id) => THEMES.find((th) => th.id === id) || null;
