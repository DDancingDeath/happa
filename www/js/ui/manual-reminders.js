/**
 * @fileoverview Manual reminders on Today (#86): the block in Today's
 * Reminders, its "Add reminder" form and the Done / Cancel taps. In-app only
 * (#58: no push). Reminders are shop-wide: every approved user sees them and
 * may mark one done (for everyone); owners and managers add and cancel them.
 * Grouping: utils/manual-reminders.js (REM-3); data: firebase/repos/reminders.js.
 * @module ui/manual-reminders
 */

import { AppState } from '../utils/state.js';
import { Helpers } from '../utils/helpers.js';
import { UIManager } from './ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { t, tn, getLang } from '../i18n/index.js';
import { formatDay, todayLocalISO } from '../utils/dates.js';
import { checkReminder, groupReminders, REMINDER_LISTEN_LIMIT, REMINDER_TITLE_MAX, REMINDER_PARTY_MAX } from '../utils/manual-reminders.js';

const esc = (s) => Helpers.escapeHtml(String(s ?? ''));

export const ManualReminders = {
    list: [],
    uid: null,
    unsubscribe: null,
    formOpen: false,
    onChange: null,

    /** Owners and managers add and cancel reminders. */
    canManage(role = AppState.userRole) {
        return role === 'owner' || role === 'manager';
    },

    /** Listens to the open reminders once per sign-in; `onChange` redraws Today. */
    start(onChange) {
        this.onChange = onChange;
        const uid = AppState.currentUser?.uid || null;
        if (this.unsubscribe && this.uid === uid) return;
        this.stop();
        if (!uid || typeof FirebaseService.listenOpenReminders !== 'function') return;
        this.uid = uid;
        try {
            this.unsubscribe = FirebaseService.listenOpenReminders(list => {
                this.list = list;
                this.changed();
            }, error => {
                console.warn('Reminders: listener stopped:', error?.message || error);
                this.stop();
                this.changed();
            }, REMINDER_LISTEN_LIMIT);
        } catch (e) {
            console.warn('Reminders: could not listen:', e?.message || e);
        }
    },

    stop() {
        try { this.unsubscribe?.(); } catch (_) { /* already stopped */ }
        this.unsubscribe = null;
        this.uid = null;
        this.list = [];
    },

    changed() {
        try { this.onChange?.(); } catch (e) { console.error('Reminders: redraw failed:', e); }
    },

    whenText(r) {
        if (r.days === 0) return t('ui.reminders.today');
        if (r.days < 0) return tn('ui.reminders.late', -r.days);
        return t('ui.reminders.on_day', { day: formatDay(r.dueDate, { lang: getLang(), year: false }) });
    },

    rowHtml(r, manage) {
        return `<li class="today-reminder-item" data-reminder-id="${esc(r.id)}">`
            + `<span class="today-reminder-title">${esc(r.title)}</span>`
            + (r.party ? ` <span class="today-reminder-party-name">· ${esc(r.party)}</span>` : '')
            + ` <span class="today-reminder-days${r.days < 0 ? ' late' : ''}">${esc(this.whenText(r))}</span>`
            + `<span class="today-reminder-actions"><button type="button" class="filter-btn" data-reminder-done onclick="window.app.day.reminderDone('${Helpers.escapeJsAttr(r.id)}')">${esc(t('ui.reminders.done'))}</button>`
            + (manage ? `<button type="button" class="filter-btn" onclick="window.app.day.reminderCancel('${Helpers.escapeJsAttr(r.id)}')">${esc(t('ui.reminders.cancel'))}</button>` : '')
            + '</span></li>';
    },

    formHtml() {
        const today = todayLocalISO();
        return '<div class="today-reminder-form">'
            + `<input type="text" id="reminderTitle" maxlength="${REMINDER_TITLE_MAX}" placeholder="${esc(t('ui.reminders.title_ph'))}" aria-label="${esc(t('ui.reminders.title_label'))}">`
            + `<input type="date" id="reminderDate" min="${today}" value="${today}" aria-label="${esc(t('ui.reminders.date_label'))}">`
            + `<input type="text" id="reminderParty" maxlength="${REMINDER_PARTY_MAX}" placeholder="${esc(t('ui.reminders.party_ph'))}" aria-label="${esc(t('ui.reminders.party_label'))}">`
            + `<div class="today-reminder-form-buttons"><button type="button" class="btn btn-primary" data-reminder-save onclick="window.app.day.reminderSave()">${esc(t('ui.reminders.save'))}</button>`
            + `<button type="button" class="btn btn-secondary" onclick="window.app.day.reminderForm(false)">${esc(t('ui.reminders.close'))}</button></div></div>`;
    },

    /**
     * The block for Today's Reminders, or '' when there is nothing to show
     * (members with no reminders due or coming up).
     */
    html(todayIso = todayLocalISO()) {
        const manage = this.canManage();
        const g = groupReminders(this.list, todayIso);
        const rows = [...g.due, ...g.soon];
        if (!rows.length && !manage) return '';
        return '<div class="today-reminder" data-reminder="manual">'
            + `<div class="today-reminder-head"><strong>${esc(t('ui.reminders.title'))}</strong>`
            + (g.due.length ? ` ${esc(t('ui.reminders.due_count', { count: g.due.length }))}` : '') + '</div>'
            + (rows.length ? `<ul>${rows.map(r => this.rowHtml(r, manage)).join('')}</ul>` : `<div class="today-reminder-more">${esc(t('ui.reminders.none'))}</div>`)
            + (g.later ? `<div class="today-reminder-more">${esc(t('ui.reminders.later', { count: g.later }))}</div>` : '')
            + (manage ? (this.formOpen ? this.formHtml()
                : `<button type="button" class="filter-btn" onclick="window.app.day.reminderForm(true)">${esc(t('ui.reminders.add'))}</button>`) : '')
            + '</div>';
    },

    by() {
        return { uid: AppState.currentUser?.uid, name: AppState.userName };
    },

    form(open) {
        this.formOpen = !!open && this.canManage();
        this.changed();
        if (this.formOpen) setTimeout(() => document.getElementById('reminderTitle')?.focus(), 0);
    },

    async save() {
        if (!this.canManage()) return false;
        const value = (id) => document.getElementById(id)?.value || '';
        const check = checkReminder({ title: value('reminderTitle'), dueDate: value('reminderDate'), party: value('reminderParty') }, todayLocalISO());
        if (!check.ok) { UIManager.showToast(t(check.error)); return false; }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) { UIManager.showToast(t('msg.reminders.needs_internet')); return false; }
        return Helpers.runExclusive('reminder-save', '[data-reminder-save]', async () => {
            try {
                await FirebaseService.createReminder(check.value, this.by());
                this.formOpen = false;
                UIManager.showToast(t('msg.reminders.saved'));
                this.changed();
                return true;
            } catch (e) {
                console.error('Reminder not saved:', e);
                UIManager.showToast(t('msg.reminders.not_saved'));
                return false;
            }
        });
    },

    async done(id) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) { UIManager.showToast(t('msg.reminders.needs_internet')); return false; }
        try {
            await FirebaseService.ackReminder(id, this.by());
            return true;
        } catch (e) {
            console.error('Reminder not marked done:', e);
            UIManager.showToast(t('msg.reminders.not_saved'));
            return false;
        }
    },

    async cancel(id) {
        if (!this.canManage()) return false;
        if (!(await UIManager.showModal(t('msg.reminders.cancel_confirm'), t('ui.reminders.cancel'), true))) return false;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) { UIManager.showToast(t('msg.reminders.needs_internet')); return false; }
        try {
            await FirebaseService.cancelReminder(id, this.by());
            return true;
        } catch (e) {
            console.error('Reminder not cancelled:', e);
            UIManager.showToast(t('msg.reminders.not_saved'));
            return false;
        }
    }
};
