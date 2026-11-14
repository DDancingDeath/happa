/**
 * @fileoverview Billing confirms with "Fix" as the default answer:
 * - extreme rate (BF-RATECHECK, owner decision OD-02): a line rate at least 5× today's
 *   rate of its item, or at most ⅕ of it, stops at Add to bill (and at Save for a line
 *   not confirmed yet) with the money it makes; a confirm is stored on the line (`rateCheck`);
 * - heavy bag (BF-BAGCHECK): one bag / packet weight above 100 kg stops when it is added;
 *   a confirm is stored on the line (`weightCheck`).
 * The owner sees every confirm in the anomalies / Day report.
 * @module ui/rate-check
 */

import {
    bagChecks, bagWeightGuess, BAG_WEIGHT_LIMIT_KG, extremeRate, heavyBag, linesNeedingRateCheck, rateCheckFigures,
    rateCheckRecord, savedRateCheck, todaysRates, weightCheckRecord
} from '../utils/calc/billing.js';
import { formatKg, formatRate, formatRupees, readLineItem } from '../utils/money.js';
import { AppState } from '../utils/state.js';
import { lineItemIdentity } from '../utils/item-catalog.js';
import { t } from '../i18n/index.js';
import { buildSheet, openSheet, closeSheet } from './ui-manager.js';

/**
 * A blocking question with two answers; "fix" is focused and is what Esc does.
 * @param {{kind: 'rate'|'bag', title: string, message: string, fix: string, confirm: string}} q
 * @returns {Promise<'fix'|'confirm'>}
 */
function askFixOrConfirm({ kind, title, message, fix, confirm }) {
    return new Promise((resolve) => {
        const { overlay, body, footer } = buildSheet({
            role: 'alertdialog', labelId: `${kind}CheckTitle`, title, describedBy: `${kind}CheckMessage`, className: `rate-check-dialog ${kind}-check-dialog`
        });
        const p = document.createElement('p');
        p.id = `${kind}CheckMessage`;
        p.textContent = message;
        body.appendChild(p);

        const button = (/** @type {string} */ cls, /** @type {string} */ text, /** @type {'fix'|'confirm'} */ choice) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = cls;
            b.dataset.choice = choice;
            // Esc, Back and a scrim tap press [data-dismiss]: "Fix"
            if (choice === 'fix') b.dataset.dismiss = '';
            b.textContent = text;
            b.addEventListener('click', () => {
                closeSheet(overlay);
                overlay.remove();
                resolve(choice);
            });
            footer.appendChild(b);
            return b;
        };
        button('btn btn-danger-outline rate-check-confirm', confirm, 'confirm');
        const fixBtn = button('btn btn-primary', fix, 'fix');

        document.body.appendChild(overlay);
        openSheet(overlay, { focus: fixBtn });
    });
}

/**
 * Asks whether an extreme rate is right.
 * @param {{label: string, qty: number, rate: number, todayRate: number, amount: number, todayAmount: number}} c
 * @returns {Promise<'fix'|'confirm'>}
 */
export function askRateCheck({ label, qty, rate, todayRate, amount, todayAmount }) {
    return askFixOrConfirm({
        kind: 'rate',
        title: t('ui.rate_check.title'),
        message: t('msg.rate_check.prompt', {
            item: label || '', kg: formatKg(qty), rate: formatRate(rate), amount: formatRupees(amount),
            today: formatRate(todayRate), todayAmount: formatRupees(todayAmount)
        }),
        fix: t('ui.rate_check.fix'),
        confirm: t('ui.rate_check.confirm', { rate: formatRate(rate) })
    });
}

/**
 * Asks whether a bag / packet weight above 100 kg is right.
 * @param {number} kg
 * @param {'bag'|'packet'} unit - purchase bags, retail packets
 * @returns {Promise<'fix'|'confirm'>}
 */
export function askBagCheck(kg, unit) {
    return askFixOrConfirm({
        kind: 'bag',
        title: t(`ui.bag_check.title_${unit}`),
        message: t(`msg.bag_check.prompt_${unit}`, { kg: formatKg(kg), limit: formatKg(BAG_WEIGHT_LIMIT_KG), guess: formatKg(bagWeightGuess(kg)) }),
        fix: t('ui.bag_check.fix'),
        confirm: t('ui.bag_check.confirm', { kg: formatKg(kg) })
    });
}

const who = () => ({ by: AppState.currentUser?.uid || 'unknown', byName: AppState.userName || '', at: Date.now() });

const focusInput = (/** @type {string} */ id) => {
    const input = /** @type {?HTMLInputElement} */ (document.getElementById(id));
    input?.focus();
    input?.select?.();
};

/**
 * Add to bill: the rate check for the line about to be added.
 * @param {Object} line
 * @param {'purchase'|'retail'|'wholesale'} line.kind
 * @param {?Object} line.item - catalogue item
 * @param {string} line.label - the item's name as shown
 * @param {number} line.rate
 * @param {number} line.qty
 * @param {string} line.rateInputId - focused (text selected) on "Fix rate"
 * @param {Array<Object>} [line.keptLines] - lines already confirmed or saved (the bill being edited, the line taken back to edit):
 *   the same item at the same rate is not asked again and keeps that line's confirm
 * @returns {Promise<{ok: boolean, rateCheck: ?Object}>} ok false: do not add the line
 */
export async function checkLineRate({ kind, item, label, rate, qty, rateInputId, keptLines = [] }) {
    const kept = savedRateCheck({ itemId: item?.id, name: item?.name, rate }, keptLines);
    if (kept.saved) return { ok: true, rateCheck: kept.rateCheck };
    const hit = extremeRate(rate, todaysRates(item, kind));
    if (!hit) return { ok: true, rateCheck: null };
    const choice = await askRateCheck({ label, qty, rate, todayRate: hit.todayRate, ...rateCheckFigures({ rate, qty, todayRate: hit.todayRate }) });
    if (choice !== 'confirm') {
        focusInput(rateInputId);
        return { ok: false, rateCheck: null };
    }
    return { ok: true, rateCheck: rateCheckRecord({ rate, todayRate: hit.todayRate, ...who() }) };
}

/**
 * Adding one bag / packet weight: above 100 kg it is asked first.
 * @param {number} kg
 * @param {'bag'|'packet'} unit
 * @param {string} weightInputId - focused (text selected) on "Fix weight"
 * @returns {Promise<{ok: boolean, record: ?Object}>} ok false: do not add the weight
 */
export async function checkBagWeight(kg, unit, weightInputId) {
    if (!heavyBag(kg)) return { ok: true, record: null };
    if (await askBagCheck(kg, unit) !== 'confirm') {
        focusInput(weightInputId);
        return { ok: false, record: null };
    }
    return { ok: true, record: weightCheckRecord({ kg, ...who() }) };
}

/**
 * Add to bill: the confirms that cover the line's heavy bags. A heavy bag with no
 * confirm yet (e.g. weights of a restored bill) is asked now.
 * @param {number[]} weights - the line's bag / packet weights
 * @param {Array<Object>} records - confirms made while the weights were added
 * @param {'bag'|'packet'} unit
 * @param {string} weightInputId
 * @returns {Promise<{ok: boolean, weightCheck: Array<Object>, kept: Array<Object>}>} ok false: do not add the line;
 *   weightCheck: the confirms to store on the line; kept: every record that covers the weights (markers included)
 */
export async function confirmLineBags(weights, records, unit, weightInputId) {
    const { confirmed, unconfirmed } = bagChecks(weights, records);
    for (const kg of unconfirmed) {
        const { ok, record } = await checkBagWeight(kg, unit, weightInputId);
        if (!ok) return { ok: false, weightCheck: [], kept: confirmed };
        confirmed.push(record);
    }
    return { ok: true, weightCheck: confirmed.filter(r => !r.kept), kept: confirmed };
}

/**
 * Taking a line back to edit: its bag weights come back with their confirms, and a heavy
 * bag the line already had without one is marked kept (not asked again, not stored as a confirm).
 * @param {number[]} weights - the weights put back in the entry boxes
 * @param {*} records - the line's `weightCheck`
 * @returns {Array<Object>}
 */
export function keptBagChecks(weights, records) {
    const { confirmed, unconfirmed } = bagChecks(weights, Array.isArray(records) ? records : []);
    return [...confirmed, ...unconfirmed.map(kg => ({ kg, kept: true }))];
}

/**
 * Save: lines with an extreme rate not confirmed at Add to bill (e.g. a restored
 * bill) are asked one by one; a confirm is put on the line (`rateCheck`).
 * @param {{kind: 'purchase'|'retail'|'wholesale', items: Array<Object>, editingBill?: ?Object}} draft
 * @returns {Promise<{ok: boolean, index?: number, confirmed: number}>} ok false: "Fix rate" on line `index`; confirmed: lines confirmed now
 */
export async function confirmLineRates(draft) {
    const items = Array.isArray(draft?.items) ? draft.items : [];
    const saved = Array.isArray(draft?.editingBill?.items) ? draft.editingBill.items : [];
    let confirmed = 0;
    for (const { index, todayRate } of linesNeedingRateCheck(items, AppState.items, draft.kind, saved)) {
        const line = items[index];
        const { rate, qty } = readLineItem(line);
        const choice = await askRateCheck({ label: lineItemIdentity(line, AppState.items, AppState.settings?.showHindi).label, qty, rate, todayRate, ...rateCheckFigures({ rate, qty, todayRate }) });
        if (choice !== 'confirm') return { ok: false, index, confirmed };
        line.rateCheck = rateCheckRecord({ rate, todayRate, ...who() });
        confirmed += 1;
    }
    return { ok: true, confirmed };
}
