// @ts-check
/**
 * @fileoverview Line icons from the sprite in templates/navigation.html, for markup a script writes
 * (docs/design-system.md §4). Pass a constant name only, never one built from data:
 * icon-sprite.test.js checks every name passed here.
 * @module ui/icons
 */

/**
 * @param {string} name - sprite symbol without the `i-` prefix, e.g. 'flag'
 * @param {string} [size] - '' (20 px), 'i-sm' (16) or 'i-lg' (24)
 * @returns {string} a decorative `<svg>`
 */
export function icon(name, size = '') {
    return `<svg class="i${size ? ` ${size}` : ''}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
}
