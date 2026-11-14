/**
 * @fileoverview Save / Print with a line still typed in the entry boxes (BF-PENDING):
 * the line is never dropped without a word. A complete line asks "Add this line and
 * save" / "Discard line and save" (or go back); an incomplete one is pointed out
 * and the save waits.
 * @module ui/pending-line
 */

import { pendingLine } from '../utils/calc/billing.js';
import { formatKg, formatRate, formatRupees } from '../utils/money.js';
import { t } from '../i18n/index.js';
import { UIManager, buildSheet, openSheet, closeSheet } from './ui-manager.js';

const MISSING_KEY = {
    item: 'msg.billing.pending_line_item',
    rate: 'msg.billing.pending_line_rate',
    qty: 'msg.billing.pending_line_qty'
};

/**
 * Asks what to do with a complete line that is not on the bill.
 * @param {{label: string, line: {rate: number, qty: number, total: number}}} pending
 * @returns {Promise<'add'|'discard'|'cancel'>}
 */
export function askPendingLine({ label, line }) {
    return new Promise((resolve) => {
        const { overlay, body, footer } = buildSheet({ labelId: 'pendingLineTitle', title: t('ui.billing.pending_line_title'), className: 'pending-line-sheet' });
        const message = document.createElement('p');
        message.id = 'pendingLineMessage';
        message.textContent = t('msg.billing.pending_line_prompt', {
            item: label || '', kg: formatKg(line.qty), rate: formatRate(line.rate), amount: formatRupees(line.total)
        });
        body.appendChild(message);

        const done = (/** @type {'add'|'discard'|'cancel'} */ choice) => {
            closeSheet(overlay);
            overlay.remove();
            resolve(choice);
        };
        const button = (/** @type {string} */ cls, /** @type {string} */ key, /** @type {'add'|'discard'|'cancel'} */ choice) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = cls;
            b.dataset.choice = choice;
            if (choice === 'cancel') b.dataset.dismiss = '';
            b.textContent = t(key);
            b.addEventListener('click', () => done(choice));
            footer.appendChild(b);
            return b;
        };
        button('btn btn-ghost', 'ui.modals.cancel', 'cancel');
        button('btn btn-danger-outline pending-line-discard', 'ui.billing.pending_line_discard', 'discard');
        const add = button('btn btn-primary', 'ui.billing.pending_line_add', 'add');

        document.body.appendChild(overlay);
        openSheet(overlay, { focus: add });
    });
}

/**
 * Settles the line in the entry boxes before a save. Resolves true when the save
 * may go on (nothing typed, the line was added, or the user discarded it).
 * @param {Object} form
 * @param {Parameters<typeof pendingLine>[0]} form.entry - what is typed (pendingLine input)
 * @param {string} form.label - the item's name as shown
 * @param {{item: string, rate: string, qty: string}} form.inputs - ids of the entry boxes
 * @param {() => Promise<boolean>} form.add - puts the line on the bill; true when it is there
 * @param {() => void} form.discard - empties the entry boxes
 * @returns {Promise<boolean>}
 */
export async function settlePendingLine({ entry, label, inputs, add, discard }) {
    const line = pendingLine(entry);
    if (line.state === 'empty') return true;
    if (line.state === 'incomplete') {
        UIManager.showToast(t(MISSING_KEY[/** @type {'item'|'rate'|'qty'} */ (line.missing)], { item: label || '' }), 'warning');
        document.getElementById(inputs[/** @type {'item'|'rate'|'qty'} */ (line.missing)])?.focus();
        return false;
    }
    const choice = await askPendingLine({ label, line });
    if (choice === 'add') return add();
    if (choice === 'discard') {
        discard();
        return true;
    }
    document.getElementById(inputs.qty)?.focus();
    return false;
}
