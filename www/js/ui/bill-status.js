/**
 * @fileoverview Bill details extras shared by History and Wholesale › History:
 * the "Voided" banner (#75), "Edited N× · View changes" and its list (#121),
 * the reason dialog for a void or an edit, and which action buttons
 * (Edit, Void, Delete permanently, Reprint, Share) the open bill shows.
 * @module ui/bill-status
 */

import { Helpers } from '../utils/helpers.js';
import { t } from '../i18n/index.js';
import { isActiveBill } from '../utils/money.js';
import { cleanReason, describeEdit, editCountOf, editHeading, REASON_MAX } from '../utils/bill-edits.js';
import { formatDayTime } from '../utils/dates.js';
import { accessFor, canDeleteBillWith, canEditBillWith, canVoidBillWith } from '../utils/role-access.js';
import { UIManager } from './ui-manager.js';

const L = (key, params) => Helpers.escapeHtml(t(key, params));

/**
 * Banner at the top of a voided bill's details: chip, reason, who and when.
 * @param {Object} bill
 * @returns {string} HTML ('' for a bill that counts)
 */
export function voidedBannerHtml(bill) {
    if (isActiveBill(bill)) return '';
    const when = formatDayTime(bill.voidedAt);
    const by = bill.voidedByName || '';
    const line = by ? L('ui.void.by_line', { name: by, when: when || '—' }) : (when ? L('ui.void.when_line', { when }) : '');
    return `<div class="bill-voided-banner" role="status">
        <span class="voided-chip">${L('ui.void.chip')}</span>
        <div class="bill-voided-banner__reason">${L('ui.void.reason_line', { reason: bill.voidReason || '—' })}</div>
        ${line ? `<div class="bill-voided-banner__by">${line}</div>` : ''}
    </div>`;
}

/**
 * "Edited 2× · View changes" (nothing for a bill never edited). The changes
 * are read only when tapped.
 * @param {Object} bill
 * @param {string} onclick safe inline handler
 * @returns {string} HTML
 */
export function editsRowHtml(bill, onclick) {
    const n = editCountOf(bill);
    if (!n) return '';
    return `<div class="bill-edits" id="billEditsBox">
        <span class="bill-edits__count">${L('ui.edits.edited_times', { count: n })}</span>
        <span aria-hidden="true">·</span>
        <button type="button" class="bill-edits__view" id="billEditsToggle" onclick="${onclick}">${L('ui.edits.view_changes')}</button>
        <div class="bill-edits__list" id="billEditsList" hidden></div>
    </div>`;
}

/**
 * Fills the edits list: one block per edit (who, when, reason, what changed).
 * @param {HTMLElement} list
 * @param {Array<Object>} edits stored edit records, oldest first
 */
export function renderEditsList(list, edits) {
    if (!list) return;
    if (!edits.length) {
        list.innerHTML = `<p class="bill-edits__empty">${L('ui.edits.none_found')}</p>`;
        return;
    }
    list.innerHTML = edits.map(e => `
        <div class="bill-edit">
            <div class="bill-edit__head">${Helpers.escapeHtml(editHeading(e))}</div>
            <div class="bill-edit__reason">${L('ui.edits.reason', { reason: e.reason || '—' })}</div>
            <ul class="bill-edit__changes">${describeEdit(e).map(s => `<li>${Helpers.escapeHtml(s)}</li>`).join('')}</ul>
        </div>`).join('');
}

/**
 * Asks for a required reason (void or edit). Too short or cancelled: null.
 * @param {{titleKey: string, explainKey?: string, labelKey: string}} keys
 * @returns {Promise<?string>}
 */
export async function askReason({ titleKey, explainKey, labelKey }) {
    const html = `<div class="reason-dialog">
        ${explainKey ? `<p class="reason-dialog__explain">${L(explainKey)}</p>` : ''}
        <label class="reason-dialog__label" for="reasonInput">${L(labelKey)}</label>
        <textarea id="reasonInput" class="reason-dialog__input" rows="2" maxlength="${REASON_MAX}"></textarea>
    </div>`;
    const ok = await UIManager.showModalWithHtml(html, t(titleKey), true);
    if (!ok) return null;
    const reason = cleanReason(document.getElementById('reasonInput')?.value);
    if (!reason) {
        UIManager.showToast(t('msg.edits.reason_required'));
        return null;
    }
    return reason;
}

/**
 * Shows the action buttons this user may use on the open bill: Edit (not for
 * wholesale or voided bills), Void, Delete permanently (owner, voided bills),
 * Reprint and Share (not for voided bills).
 * @param {Object} bill
 * @param {{uid: string, role: string, raw: Object}} who
 * @param {{editable?: boolean}} [opts] editable: this kind of bill can be edited here
 */
export function setBillActions(bill, who, { editable = true } = {}) {
    const show = (id, on) => {
        const el = document.getElementById(id);
        if (el) el.style.display = on ? '' : 'none';
    };
    const active = isActiveBill(bill);
    // #124: Edit / Void stay visible past the edit window for those who could act inside it;
    // a tap then explains the window (and is recorded for the owner's review)
    const role = who?.role;
    const mine = !!bill?.userId && bill.userId === who?.uid;
    // Only when the role has a window at all (editDays 0 = never: the buttons stay hidden)
    const hasWindow = accessFor(role, who?.raw).editDays > 0;
    show('billEditBtn', editable && (canEditBillWith(bill, who) || (active && hasWindow && (role === 'manager' || mine))));
    show('billVoidBtn', canVoidBillWith(bill, who) || (active && hasWindow && mine));
    show('billDeleteBtn', canDeleteBillWith(bill, who));
    show('billReprintBtn', active);
    show('billShareBtn', active);
}
