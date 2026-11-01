/**
 * @fileoverview Manual reminders on Today (#86): the block in Today's
 * Reminders, its "Add reminder" form and the Done / Cancel taps. In-app only
 * (#58: no push). Reminders are shop-wide: every approved user sees them and
 * may mark one done (for everyone); owners and managers add and cancel them.
 * Grouping: utils/manual-reminders.js (REM-5); data: firebase/repos/reminders.js.
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
const FORM_IDS = ['reminderTitle', 'reminderDate', 'reminderParty'];
const CSS_ESCAPE = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));
/** A write the server hasn't confirmed in this time stays queued on the phone (Firestore sends it when online). */
const WRITE_WAIT_MS = 10000;
const TIMED_OUT = Symbol('timed-out');
function withTimeout(p) {
    let timer;
    return Promise.race([p, new Promise(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), WRITE_WAIT_MS); })])
        .finally(() => clearTimeout(timer));
}

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
        if (this.uid !== uid) this.reset();
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

    /** Sign-out / another person: nothing typed or open stays for the next one. */
    reset() {
        this.stop();
        this.formOpen = false;
        this.draft = null;
        const box = typeof document !== 'undefined' ? document.getElementById('todayReminders') : null;
        box?.querySelector('[data-reminder="manual"]')?.remove();
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

    /** What is typed in the open form; kept through Today's redraws until the reminder is saved. */
    draft: null,

    captureDraft() {
        const el = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);
        if (!this.formOpen || !el('reminderTitle')) return;
        const focused = typeof document !== 'undefined' ? document.activeElement : null;
        this.draft = {
            title: el('reminderTitle').value, dueDate: el('reminderDate')?.value || '', party: el('reminderParty')?.value || '',
            focus: FORM_IDS.includes(focused?.id) ? focused.id : null, caret: focused?.selectionStart ?? null
        };
    },

    /** After Today wrote the block: the field that had the cursor gets it back. */
    restoreFocus() {
        const f = this.draft?.focus;
        if (!f || typeof document === 'undefined') return;
        const el = document.getElementById(f);
        if (!el || document.activeElement === el) return;
        el.focus();
        if (Number.isInteger(this.draft.caret)) { try { el.setSelectionRange(this.draft.caret, this.draft.caret); } catch (_) { /* date input */ } }
    },

    formHtml() {
        const today = todayLocalISO();
        const d = this.draft || {};
        return '<div class="today-reminder-form">'
            + `<input type="text" id="reminderTitle" maxlength="${REMINDER_TITLE_MAX}" value="${esc(d.title || '')}" placeholder="${esc(t('ui.reminders.title_ph'))}" aria-label="${esc(t('ui.reminders.title_label'))}">`
            + `<input type="date" id="reminderDate" min="${today}" value="${esc(d.dueDate || today)}" aria-label="${esc(t('ui.reminders.date_label'))}">`
            + `<input type="text" id="reminderParty" maxlength="${REMINDER_PARTY_MAX}" value="${esc(d.party || '')}" placeholder="${esc(t('ui.reminders.party_ph'))}" aria-label="${esc(t('ui.reminders.party_label'))}">`
            + `<div class="today-reminder-form-buttons"><button type="button" class="btn btn-primary" data-reminder-save onclick="window.app.day.reminderSave()">${esc(t('ui.reminders.save'))}</button>`
            + `<button type="button" class="btn btn-secondary" onclick="window.app.day.reminderForm(false)">${esc(t('ui.reminders.close'))}</button></div></div>`;
    },

    /**
     * The block for Today's Reminders, or '' when there is nothing to show
     * (members with no reminders due or coming up).
     */
    html(todayIso = todayLocalISO()) {
        const manage = this.canManage();
        this.captureDraft();
        const g = groupReminders(this.list, todayIso);
        const rows = [...g.due, ...g.soon];
        if (!rows.length && !manage) return '';
        return '<div class="today-reminder" data-reminder="manual">'
            + `<div class="today-reminder-head"><strong>${esc(t('ui.reminders.title'))}</strong>`
            + (g.due.length ? ` ${esc(t('ui.reminders.due_count', { count: g.due.length }))}` : '') + '</div>'
            + (rows.length ? `<ul>${rows.map(r => this.rowHtml(r, manage)).join('')}</ul>` : `<div class="today-reminder-more">${esc(t('ui.reminders.none'))}</div>`)
            + (g.later ? `<div class="today-reminder-more">${esc(t('ui.reminders.later', { count: g.later }))}</div>` : '')
            + (this.list.length >= REMINDER_LISTEN_LIMIT ? `<div class="today-reminder-more">${esc(t('ui.reminders.limit', { count: REMINDER_LISTEN_LIMIT }))}</div>` : '')
            + (manage ? (this.formOpen ? this.formHtml()
                : `<button type="button" class="filter-btn" onclick="window.app.day.reminderForm(true)">${esc(t('ui.reminders.add'))}</button>`) : '')
            + '</div>';
    },

    by() {
        return { uid: AppState.currentUser?.uid, name: AppState.userName };
    },

    form(open) {
        this.formOpen = !!open && this.canManage();
        this.draft = null;
        this.changed();
        if (this.formOpen) setTimeout(() => document.getElementById('reminderTitle')?.focus(), 0);
    },

    offline() {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            UIManager.showToast(t('msg.reminders.needs_internet'));
            return true;
        }
        return false;
    },

    async save() {
        if (!this.canManage()) return false;
        const value = (id) => document.getElementById(id)?.value || '';
        const check = checkReminder({ title: value('reminderTitle'), dueDate: value('reminderDate'), party: value('reminderParty') }, todayLocalISO());
        if (!check.ok) { UIManager.showToast(t(check.error)); return false; }
        if (this.offline()) return false;
        return Helpers.runExclusive('reminder-save', '[data-reminder-save]', async () => {
            try {
                const write = FirebaseService.createReminder(check.value, this.by());
                const res = await withTimeout(write);
                if (res === TIMED_OUT) write.catch(() => UIManager.showToast(t('msg.reminders.not_saved')));
                this.formOpen = false;
                this.draft = null;
                UIManager.showToast(t(res === TIMED_OUT ? 'msg.reminders.saved_on_phone' : 'msg.reminders.saved'));
                this.changed();
                return true;
            } catch (e) {
                console.error('Reminder not saved:', e);
                UIManager.showToast(t('msg.reminders.not_saved'));
                return false;
            }
        });
    },

    /** Done / Cancel: one write per tap; refused because it is already closed (another phone) = nothing to say. */
    async closeReminder(id, write) {
        if (this.offline()) return false;
        return Helpers.runExclusive(`reminder-${id}`, `[data-reminder-id="${CSS_ESCAPE(id)}"] button`, async () => {
            const p = write();
            try {
                if (await withTimeout(p) === TIMED_OUT) p.catch(() => UIManager.showToast(t('msg.reminders.not_saved')));
                return true;
            } catch (e) {
                if (e?.code === 'permission-denied' && await FirebaseService.reminderClosed(id)) return true;
                console.error('Reminder not changed:', e);
                UIManager.showToast(t('msg.reminders.not_saved'));
                return false;
            }
        });
    },

    markReminderDone(id) {
        return this.closeReminder(id, () => FirebaseService.ackReminder(id, this.by()));
    },

    async cancelReminderNow(id) {
        if (!this.canManage() || Helpers.isBusy?.(`reminder-${id}`)) return false;
        if (!(await UIManager.showModal(t('msg.reminders.cancel_confirm'), t('ui.reminders.cancel'), true))) return false;
        return this.closeReminder(id, () => FirebaseService.cancelReminder(id, this.by()));
    }
};