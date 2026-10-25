/**
 * @fileoverview Pure rules for a manual stock adjustment (Stock → Adjust).
 * @module utils/stock-adjust
 */

import { t } from '../i18n/index.js';
import { splitBilingual } from '../i18n/localize.js';

/** Reason picker options (catalogue keys); `other` needs a note, `opening` a cost per kg. */
export const ADJUST_REASONS = {
    opening: 'ui.stock.reason_opening',
    count: 'ui.stock.reason_count',
    damage: 'ui.stock.reason_damage',
    theft: 'ui.stock.reason_theft',
    other: 'ui.stock.reason_other'
};

/**
 * Reason of a saved adjustment in the app language: the label from its reasonCode plus
 * the typed note. Older records stored "English / Hindi: note"; their note is kept.
 * @param {{reason?: string, reasonCode?: string}} adj
 * @param {'en'|'hi'} [lang]
 * @returns {string}
 */
export function adjustReasonText(adj, lang) {
    const reason = String(adj?.reason || '').trim();
    const key = ADJUST_REASONS[adj?.reasonCode];
    if (!key) return splitBilingual(reason, lang);
    const en = t(key, null, 'en');
    const hi = t(key, null, 'hi');
    const prefix = [`${en} / ${hi}`, en, hi].find(p => reason === p || reason.startsWith(`${p}: `));
    const note = prefix ? reason.slice(prefix.length).replace(/^: /, '').trim() : '';
    const label = lang ? t(key, null, lang) : t(key);
    return note ? `${label}: ${note}` : label;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Validates an adjustment and works out the stock after it.
 *  - add/remove need a quantity > 0; set accepts 0 ("set stock to 0").
 *  - remove is capped at the stock on hand (`capped` tells the UI to warn);
 *    `quantity` is the effective amount, `rawQuantity` what was typed.
 *  - a reason is required; `other` also needs a note; `opening` (opening stock)
 *    needs the cost per kg, so the cost of goods sold can be worked out.
 * @param {{adjustType: string, quantity: number, currentStock: number, reasonCode?: string, reasonNote?: string, rate?: number}} input
 * @returns {{ok: true, quantity: number, rawQuantity: number, newStock: number, capped: boolean, reason: string}
 *          | {ok: false, error: string}}
 */
export function planStockAdjustment({ adjustType, quantity, currentStock, reasonCode, reasonNote, rate }) {
    const qty = Number(quantity);
    const stock = Number(currentStock) || 0;
    if (!['add', 'remove', 'set'].includes(adjustType)) {
        return { ok: false, error: t('msg.stock.choose_adjust_type') };
    }
    if (!Number.isFinite(qty) || qty < 0 || (qty === 0 && adjustType !== 'set')) {
        return { ok: false, error: t('msg.stock.enter_valid_quantity') };
    }
    const note = (reasonNote || '').trim();
    if (!ADJUST_REASONS[reasonCode]) {
        return { ok: false, error: t('msg.stock.choose_reason') };
    }
    if (reasonCode === 'other' && !note) {
        return { ok: false, error: t('msg.stock.write_reason') };
    }
    if (reasonCode === 'opening' && adjustType !== 'remove' && qty > 0 && !(Number(rate) > 0)) {
        return { ok: false, error: t('msg.stock.opening_needs_cost') };
    }
    const reason = note ? `${t(ADJUST_REASONS[reasonCode])}: ${note}` : t(ADJUST_REASONS[reasonCode]);

    let effective = qty;
    let newStock;
    let capped = false;
    if (adjustType === 'add') {
        newStock = stock + qty;
    } else if (adjustType === 'remove') {
        const onHand = Math.max(0, stock);
        if (qty > onHand) {
            if (onHand === 0) return { ok: false, error: t('msg.stock.no_stock_to_remove') };
            effective = onHand;
            capped = true;
        }
        newStock = stock - effective;
    } else {
        newStock = qty;
    }
    return { ok: true, quantity: round3(effective), rawQuantity: qty, newStock: round3(newStock), capped, reason };
}
