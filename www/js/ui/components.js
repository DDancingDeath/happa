// @ts-check
/**
 * @fileoverview Markup helpers for the shared components (docs/design-system.md §3), so pages write the
 * same escape-safe markup. Every helper returns a string for a template literal.
 * @module ui/components
 */

import { formatRupees, isMissingAmount, moneyText } from '../utils/money.js';

/** @type {Record<string, string>} */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (/** @type {*} */ s) => String(s).replace(/[&<>"']/g, c => ESC[c]);

/**
 * A money figure with its ₹ muted: `<span class="money"><span class="cur">₹</span>2,50,000</span>`; the true
 * minus stays outside `.cur` ("−₹500"). Its textContent is exactly `moneyText(amount, opts)`; a missing amount is "—".
 * @param {*} amount
 * @param {import('../utils/money.js').MoneyPreset|import('../utils/money.js').MoneyOpts} [opts] as moneyText
 * @returns {string}
 */
export function moneyHtml(amount, opts) {
    if (isMissingAmount(amount)) return '—';
    const text = moneyText(amount, opts);
    const i = text.indexOf('₹');
    return `<span class="money">${esc(text.slice(0, i))}<span class="cur">₹</span>${esc(text.slice(i + 1))}</span>`;
}

/**
 * Translated text that holds formatRupees(amount, opts) (or moneyText) for each amount, escaped, with those figures drawn
 * by moneyHtml(), so a negative one gets the true minus; the rest of the text is unchanged. Several amounts are found in
 * order, each after the previous one; a figure that isn't there, or a missing amount, stays plain text.
 * @param {*} text
 * @param {*} amounts one amount, or an array of them
 * @param {import('../utils/money.js').MoneyPreset|import('../utils/money.js').MoneyOpts} [opts] as formatRupees
 * @returns {string}
 */
export function moneyInText(text, amounts, opts) {
    let rest = String(text ?? '');
    let out = '';
    for (const amount of Array.isArray(amounts) ? amounts : [amounts]) {
        let figure = formatRupees(amount, opts);
        let i = rest.indexOf(figure);
        if (i < 0) {
            figure = moneyText(amount, opts);
            i = rest.indexOf(figure);
        }
        const html = moneyHtml(amount, opts);
        if (i < 0 || html === '—') continue;
        out += `${esc(rest.slice(0, i))}${html}`;
        rest = rest.slice(i + figure.length);
    }
    return out + esc(rest);
}
