// @ts-check
/**
 * @fileoverview Existing due of the party on the bill being entered (#166):
 * what the customer already owes us (sales) or what we already owe the
 * supplier (purchases), from the open bills already loaded in AppState.
 * Uses the same party grouping and due math as Outstanding (utils/aging.js),
 * so the number always equals that party's Outstanding total.
 * No DOM or Firestore access.
 * @module utils/party-due
 */

import { buildAging, normalizePartyName } from './aging.js';
import { formatINR } from './due-reminder.js';
import { getLang, t } from '../i18n/index.js';

/**
 * Open bills that make up the Outstanding list for a billing form.
 * Wholesale dues live on the Wholesale page's Outstanding list (sales-tab bills only).
 * @param {?Rec} state AppState-like
 * @param {'purchase'|'retail'|'wholesale'} kind
 * @returns {Array<Bill>}
 */
export function billsForKind(state, kind) {
    if (kind === 'purchase') return state?.purchaseHistory || [];
    if (kind === 'retail') return state?.retailSalesHistory || [];
    if (kind === 'wholesale') return (state?.salesHistory || []).filter((/** @type {?Bill} */ s) => s && s.source === 'sales-tab');
    return [];
}

/**
 * Existing due of one party (exact normalized name match).
 * @param {Array<?Bill>} bills
 * @param {string} name Name typed on the bill
 * @param {{excludeId?: *, today?: Date}} [opts] excludeId: the bill being edited / retried
 * @returns {?{key: string, total: number, count: number, oldestDays: ?number, bucket: number}}
 *   null when the name is blank or nothing is owed
 */
export function partyDue(bills, name, { excludeId = null, today = new Date() } = {}) {
    const key = normalizePartyName(name);
    if (!key) return null;
    const skip = excludeId === null || excludeId === undefined ? null : String(excludeId);
    const mine = (bills || []).filter(b => b && normalizePartyName(b.customerName) === key
        && (skip === null || String(b.id) !== skip));
    const party = buildAging(/** @type {Bill[]} */ (mine), { today }).parties.find(p => p.key === key);
    if (!party || !(party.total > 0)) return null;
    return { key, total: party.total, count: party.bills.length, oldestDays: party.oldestDays, bucket: party.bucket };
}

/**
 * One-liner for the due under the name field, in the app language.
 * @param {{total: number, count: number, oldestDays: ?number}} due
 * @param {'purchase'|'retail'|'wholesale'} kind purchase = we owe the supplier
 * @param {'en'|'hi'} [lang]
 * @returns {string}
 */
export function partyDueText(due, kind, lang = getLang()) {
    const amount = formatINR(due.total);
    const n = due.count;
    const bills = t(n === 1 ? 'ui.outstanding.bills_one' : 'ui.outstanding.bills_many', { count: n }, lang);
    const d = due.oldestDays;
    const oldest = d === null || d === undefined ? t('ui.outstanding.date_unknown', null, lang)
        : d === 0 ? t('ui.billing.oldest_today', null, lang)
        : t('ui.outstanding.oldest', { age: t(d === 1 ? 'ui.outstanding.day_one' : 'ui.outstanding.days_many', { count: d }, lang) }, lang);
    return t(kind === 'purchase' ? 'ui.billing.party_we_owe' : 'ui.billing.party_owes', { amount, bills, oldest }, lang);
}
