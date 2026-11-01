/**
 * @fileoverview One bill row for the bill history lists (History and
 * Wholesale › History), the matching Table View, and the "dues carried from
 * the old app" toggle. Both pages use these so their rows line up the same way:
 * desktop = one grid row with fixed columns (bill no | party | amount |
 * date & by | items | payment chips), phone = a two-line card (see
 * history.css / desktop.css, `.bill-row`).
 * @module ui/bill-row
 */

import { Helpers } from '../utils/helpers.js';
import { t, tn } from '../i18n/index.js';
import { billTotal, formatAmount, formatRupees, isActiveBill, isOpeningRecord, openingAmount, outstandingDue, readPayment } from '../utils/money.js';
import { billDateOf } from '../utils/history-filters.js';
import { printStatusOf } from '../utils/print-status.js';
import { SyncStatus } from './sync-status.js';

const L = (key, params) => Helpers.escapeHtml(t(key, params));

/** Class names of the row slots, in desktop column order. */
export const BILL_ROW_SLOTS = Object.freeze(['no', 'party', 'amount', 'date', 'items', 'chips']);

/**
 * Bill number shown in lists ("S20261022-005"; short id when there is none).
 * @param {Object} bill
 * @returns {string}
 */
export function billNumberOf(bill) {
    return String(bill?.billNumber || (typeof bill?.id === 'string' ? bill.id.substring(0, 8) : (bill?.id ?? '')));
}

/**
 * Amount shown for the bill: the carried due for an old-app opening record,
 * else the bill total.
 * @param {Object} bill
 * @returns {number}
 */
export function billListAmount(bill) {
    if (isOpeningRecord(bill)) return openingAmount(bill);
    return billTotal(bill);
}

/**
 * Online / cash / due chips (empty string when nothing was paid or is due).
 * @param {Object} bill
 * @returns {string} HTML
 */
export function paymentChipsHtml(bill) {
    // BILL-PAY and BILL-DUE, as the reprint and Outstanding read them
    const pay = readPayment(bill);
    const p = { online: pay.online, cash: pay.cash, due: outstandingDue(bill) };
    const chips = [];
    if (p.online > 0) chips.push(`<span class="payment-badge payment-online">${L('ui.history.badge_online', { amount: formatAmount(p.online) })}</span>`);
    if (p.cash > 0) chips.push(`<span class="payment-badge payment-cash">${L('ui.history.badge_cash', { amount: formatAmount(p.cash) })}</span>`);
    if (p.due > 0) chips.push(`<span class="payment-badge payment-due">${L('ui.history.badge_due', { amount: formatAmount(p.due) })}</span>`);
    return chips.join('');
}

/**
 * "Wheat, Rice • 3 packets", or the opening-record summary.
 * @param {Object} bill
 * @returns {string} plain text (caller escapes)
 */
export function billItemsText(bill) {
    if (isOpeningRecord(bill)) return t('ui.history.opening_summary');
    const names = (Array.isArray(bill?.items) ? bill.items : []).map(item => item?.name).filter(Boolean).join(', ');
    const packets = bill?.totalPackets;
    const packetText = packets !== undefined && packets !== null && packets !== '' ? tn('ui.history.n_packets', packets) : '';
    return [names, packetText].filter(Boolean).join(' • ');
}

/**
 * One bill row element (`div.history-item.bill-row`).
 * @param {Object} bill
 * @param {Object} opts
 * @param {string} opts.onclick - safe inline handler for the bill number (built with Helpers.escapeJsAttr)
 * @param {string} [opts.kind] - 'purchase' | 'retail' | 'wholesale' (colour only)
 * @returns {HTMLElement}
 */
export function buildBillRow(bill, { onclick, kind } = {}) {
    const div = document.createElement('div');
    const opening = isOpeningRecord(bill);
    const voided = !isActiveBill(bill);
    const type = kind || bill?.type || 'purchase';
    div.className = `history-item bill-row${opening ? ' is-opening' : ''}${voided ? ' is-voided' : ''}`;
    div.setAttribute('data-type', type);
    const number = billNumberOf(bill);
    const party = bill?.customerName ? String(bill.customerName) : '';
    const by = bill?.createdByName || bill?.userName;
    const date = Helpers.formatDateTime(billDateOf(bill) || bill?.date);
    const items = billItemsText(bill);
    div.innerHTML = `
        <span class="bill-row__no" title="#${Helpers.escapeHtml(number)}"><span class="bill-row__link" role="button" tabindex="0" onclick="${onclick || ''}">#${Helpers.escapeHtml(number)}</span></span>
        <span class="bill-row__party" title="${Helpers.escapeHtml(party)}">${party ? `<strong>${Helpers.escapeHtml(party)}</strong>` : '—'}</span>
        <span class="bill-row__amount">${Helpers.escapeHtml(formatRupees(billListAmount(bill)))}</span>
        <span class="bill-row__meta">
            <span class="bill-row__date">${Helpers.escapeHtml(date)}${by ? `<span class="bill-row__by"> • ${L('ui.outstanding.by')} <strong>${Helpers.escapeHtml(by)}</strong></span>` : ''}</span>
            <span class="bill-row__items history-summary" title="${Helpers.escapeHtml(items)}">${Helpers.escapeHtml(items)}</span>
            <span class="bill-row__chips history-payment">${opening ? `<span class="old-app-chip">${L('ui.history.old_app_chip')}</span>` : ''}${opening ? '' : SyncStatus.chipHtml(bill?.id)}${voidedChipHtml(bill)}${printStatusChipHtml(bill)}${paymentChipsHtml(bill)}</span>
        </span>
    `;
    return div;
}

const PRINT_CHIP_KEYS = Object.freeze({
    printed: 'ui.print_status.chip_printed',
    failed: 'ui.print_status.chip_failed',
    uncertain: 'ui.print_status.chip_uncertain',
    hand: 'ui.print_status.chip_hand'
});

/**
 * Print status chip from this phone (#132); '' when this phone never printed the bill.
 * @param {Object} bill
 * @returns {string} HTML
 */
export function printStatusChipHtml(bill) {
    if (isOpeningRecord(bill)) return '';
    const st = printStatusOf(bill);
    return st ? `<span class="print-chip print-chip--${st.s}">${L(PRINT_CHIP_KEYS[st.s])}</span>` : '';
}

/**
 * The bill details' print line (#132), plain text (caller escapes).
 * @param {Object} bill
 * @param {(e: {kind?: string, message?: string}) => string} [errorText] translates a stored failure
 * @returns {string}
 */
export function printStatusText(bill, errorText = (e) => e.message || '') {
    const st = printStatusOf(bill);
    if (!st) return t('ui.print_status.none');
    const time = Helpers.formatDateTime(st.at);
    const message = st.s === 'failed' && (st.k || st.err) ? errorText({ kind: st.k, message: st.err }) : '';
    if (st.s === 'failed') return message ? t('ui.print_status.failed', { time, message }) : t('ui.print_status.failed_plain', { time });
    return t(`ui.print_status.${st.s}`, { time });
}

/**
 * "Voided" chip with the reason (#75); '' for a bill that counts.
 * @param {Object} bill
 * @returns {string} HTML
 */
export function voidedChipHtml(bill) {
    if (isActiveBill(bill)) return '';
    const reason = String(bill.voidReason || '');
    return `<span class="voided-chip" title="${Helpers.escapeHtml(reason)}">${L('ui.void.chip')}</span>${reason ? `<span class="voided-reason">${Helpers.escapeHtml(reason)}</span>` : ''}`;
}

/**
 * Heading + container for a group of rows shown only when its toggle is on:
 * old-app dues ('opening') or voided bills ('voided').
 * @param {Array<Object>} bills
 * @param {(bill: Object) => HTMLElement} build
 * @param {'opening'|'voided'} [kind]
 * @returns {HTMLElement}
 */
export function buildOpeningGroup(bills, build, kind = 'opening') {
    const group = document.createElement('section');
    group.className = `bill-group bill-group--${kind}`;
    const heading = document.createElement('div');
    heading.className = 'bill-group__title';
    heading.textContent = t(kind === 'voided' ? 'ui.void.group' : 'ui.history.old_dues_group');
    group.appendChild(heading);
    bills.forEach(bill => group.appendChild(build(bill)));
    return group;
}

/**
 * The "Show voided bills (N)" chip (#75), placed first in `list`. None when count is 0.
 * @param {HTMLElement} list
 * @param {{id: string, count: number, on: boolean, onToggle: Function}} opts
 * @returns {?HTMLElement}
 */
export function addVoidedToggle(list, opts) {
    return addToggleChip(list, { ...opts, cls: 'voided-toggle-chip', showKey: 'ui.void.show', hideKey: 'ui.void.hide' });
}

/**
 * The "Show dues carried from old app (N)" chip, placed as the first child of
 * `list` (call after the list content is rendered). None when count is 0.
 * @param {HTMLElement} list
 * @param {Object} opts
 * @param {string} opts.id - element id for this screen
 * @param {number} opts.count
 * @param {boolean} opts.on
 * @param {Function} opts.onToggle
 * @returns {?HTMLElement}
 */
export function addOpeningToggle(list, opts) {
    return addToggleChip(list, { ...opts, cls: 'opening-toggle-chip', showKey: 'ui.history.show_old_dues', hideKey: 'ui.history.hide_old_dues' });
}

function addToggleChip(list, { id, count, on, onToggle, cls, showKey, hideKey }) {
    if (!list || !id) return null;
    document.getElementById(id)?.remove();
    if (!count) return null;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.id = id;
    chip.className = `${cls}${on ? ' active' : ''}`;
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    chip.textContent = t(on ? hideKey : showKey, { count });
    chip.addEventListener('click', () => onToggle?.());
    list.prepend(chip);
    return chip;
}

/**
 * Items cell of the Table View: one line per item with weight and rate
 * ("Wheat · 60.0 kg × ₹25"), or the opening-record summary.
 * @param {Object} bill
 * @returns {string} HTML
 */
function tableItemsHtml(bill) {
    const items = Array.isArray(bill?.items) ? bill.items : [];
    if (isOpeningRecord(bill) || items.length === 0) return Helpers.escapeHtml(billItemsText(bill));
    return items.map(item => {
        const qty = Number(item?.qty || item?.quantity || 0).toFixed(1);
        return `<div class="bill-table__item">${Helpers.escapeHtml(item?.name || '')} · ${Helpers.escapeHtml(qty)} kg × ₹${Helpers.escapeHtml(item?.rate ?? '')}</div>`;
    }).join('');
}

/**
 * Table View rows, same column order as the row (bill no, party, amount, date,
 * items, payment), one row per bill.
 * @param {Array<Object>} bills
 * @param {Object} opts
 * @param {(bill: Object) => string} opts.onclickFor - safe inline handler per bill
 * @param {Array<Object>} [opts.openings] - opening records shown as a separate group on top
 * @returns {string} HTML
 */
export function billTableHtml(bills, { onclickFor, openings = [], voided = [] } = {}) {
    const row = (bill) => {
        const opening = isOpeningRecord(bill);
        const isVoided = !isActiveBill(bill);
        const number = billNumberOf(bill);
        const by = bill?.createdByName || bill?.userName;
        const date = Helpers.formatDateTime(billDateOf(bill) || bill?.date);
        return `
            <tr class="bill-table__row${opening ? ' is-opening' : ''}${isVoided ? ' is-voided' : ''}" data-type="${Helpers.escapeHtml(bill?.type || '')}" onclick="${onclickFor(bill)}">
                <td class="bill-table__no" title="#${Helpers.escapeHtml(number)}">#${Helpers.escapeHtml(number)}</td>
                <td class="bill-table__party">${Helpers.escapeHtml(bill?.customerName || '—')}</td>
                <td class="bill-table__amount">${Helpers.escapeHtml(formatRupees(billListAmount(bill)))}</td>
                <td class="bill-table__date">${Helpers.escapeHtml(date)}${by ? `<div class="bill-table__by">${L('ui.outstanding.by')} ${Helpers.escapeHtml(by)}</div>` : ''}</td>
                <td class="bill-table__items">${tableItemsHtml(bill)}</td>
                <td class="bill-table__chips">${opening ? `<span class="old-app-chip">${L('ui.history.old_app_chip')}</span>` : ''}${opening ? '' : SyncStatus.chipHtml(bill?.id)}${voidedChipHtml(bill)}${printStatusChipHtml(bill)}${paymentChipsHtml(bill)}</td>
            </tr>`;
    };
    const group = (list, key) => (list.length ? `
            <tr class="bill-table__group"><th colspan="6" scope="rowgroup">${L(key)}</th></tr>
            ${list.map(row).join('')}` : '');
    const openingRows = group(openings, 'ui.history.old_dues_group');
    const voidedRows = group(voided, 'ui.void.group');
    return `
        <div class="bill-table-wrap">
            <table class="bill-table">
                <thead>
                    <tr>
                        <th class="bill-table__no">${L('ui.history.col_bill_no')}</th>
                        <th class="bill-table__party">${L('ui.history.customer')}</th>
                        <th class="bill-table__amount">${L('ui.history.total_rs')}</th>
                        <th class="bill-table__date">${L('ui.history.date')}</th>
                        <th class="bill-table__items">${L('ui.history.items')}</th>
                        <th class="bill-table__chips">${L('ui.history.col_payment')}</th>
                    </tr>
                </thead>
                <tbody>${openingRows}${voidedRows}${bills.map(row).join('')}</tbody>
            </table>
        </div>`;
}
