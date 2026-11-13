// @ts-check
/**
 * @fileoverview Markup helpers for the shared components (docs/design-system.md §3), so pages write the
 * same escape-safe markup. Every helper returns a string for a template literal.
 * @module ui/components
 */

import { formatRupees } from '../utils/money.js';

/** @type {Record<string, string>} */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (/** @type {*} */ s) => String(s).replace(/[&<>"']/g, c => ESC[c]);

/**
 * A money figure with its ₹ muted: `<span class="money"><span class="cur">₹</span>2,50,000</span>`; the minus
 * stays outside `.cur`. Its textContent is exactly `formatRupees(amount, opts)`; a missing amount is "—".
 * @param {*} amount
 * @param {{decimals?: number, small?: boolean, exact?: boolean, trueMinus?: boolean}} [opts] as formatRupees
 * @returns {string}
 */
export function moneyHtml(amount, opts) {
    if (amount === null || amount === undefined || amount === '' || !Number.isFinite(Number(amount))) return '—';
    const text = formatRupees(Number(amount), opts);
    const i = text.indexOf('₹');
    return `<span class="money">${esc(text.slice(0, i))}<span class="cur">₹</span>${esc(text.slice(i + 1))}</span>`;
}

/**
 * Translated text that holds formatRupees(amount), escaped, with that figure drawn by moneyHtml(); the text is unchanged.
 * @param {*} text
 * @param {*} amount
 * @returns {string}
 */
export function moneyInText(text, amount) {
    const s = String(text ?? '');
    const figure = formatRupees(amount);
    const i = s.indexOf(figure);
    if (i < 0) return esc(s);
    return `${esc(s.slice(0, i))}${moneyHtml(amount)}${esc(s.slice(i + figure.length))}`;
}
