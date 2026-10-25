/**
 * @fileoverview In-app notifications (#12): bell + unread badge, inbox panel,
 * toasts for new notifications and (optional, desktop web only) system
 * notifications while the app is open in the background. No server push:
 * on the free Spark plan nothing can reach a closed app.
 * @module modules/notifications
 */

import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { TelemetryService } from '../services/telemetry.js';
import { Helpers } from '../utils/helpers.js';
import { t } from '../i18n/index.js';
import { APP_IDENTITY } from '../config/app-identity.js';
import {
    UNREAD_LIMIT, PAGE_SIZE, describeNotification, notificationText, formatWhen,
    badgeText, idsToMarkRead, prepareList, newArrivals, notificationTime, retentionCutoff
} from '../utils/notification-format.js';

const SYSTEM_PREF_KEY = 'aadhat.notifications.system';
const CLEANUP_KEY = 'aadhat.notifications.cleanupAt';
const CLEANUP_EVERY_MS = 24 * 60 * 60 * 1000;
const TOAST_MS = 5000;

/** Message for a listener / query failure. */
export function notificationErrorMessage(error) {
    const code = error?.code || '';
    if (code === 'failed-precondition') return t('msg.notifications.needs_index');
    if (code === 'permission-denied') return t('msg.notifications.no_permission');
    return t('msg.notifications.could_not_load');
}

const NotificationsManager = {
    uid: null,
    unsubscribe: null,
    unread: [],
    seen: new Set(),
    initial: true,
    errorShown: false,
    panelOpen: false,
    panelItems: [],
    cursor: null,
    hasMore: false,
    loading: false,
    cleanupTimer: null,
    startedAt: 0,

    /**
     * Attaches the unread listener for the signed-in user. Safe to call again
     * (re-login, profile reload): the previous listener is detached first.
     * @param {string} uid
     */
    start(uid) {
        this.stop();
        if (!uid) return;
        this.uid = uid;
        this.initial = true;
        this.startedAt = Date.now();
        this.errorShown = false;
        this.setBellVisible(true);
        try {
            this.unsubscribe = FirebaseService.listenUnreadNotifications(
                uid, UNREAD_LIMIT,
                (list, changes, meta) => this.onUnread(uid, list, changes, meta),
                (error) => this.onListenerError(uid, error)
            );
        } catch (error) {
            this.onListenerError(uid, error);
        }
        this.cleanupTimer = setTimeout(() => this.cleanupOld(uid), 30000);
    },

    /** Detaches the listener and clears per-user state (logout). */
    stop() {
        if (this.unsubscribe) {
            try { this.unsubscribe(); } catch (e) { console.warn('Notifications unsubscribe failed:', e); }
        }
        clearTimeout(this.cleanupTimer);
        this.unsubscribe = null;
        this.uid = null;
        this.unread = [];
        this.seen = new Set();
        this.panelItems = [];
        this.cursor = null;
        this.hasMore = false;
        this.close();
        this.renderBadge();
        this.setBellVisible(false);
    },

    /** @private */
    onUnread(uid, list, changes, meta = {}) {
        if (uid !== this.uid) return;
        this.unread = prepareList(list);
        const initial = this.initial;
        this.initial = false;
        const arrivals = newArrivals(changes, this.seen, initial);
        this.renderBadge();

        if (initial) {
            const count = this.unread.length;
            if (count > 0 && !meta.fromCache) {
                UIManager.showToast(t('msg.notifications.new_notification_s_tap_bell', { badgeText: badgeText(count) }), TOAST_MS);
            }
            return;
        }
        // Older unread docs slide into the window when others are marked read: no toast for those.
        const fresh = arrivals.map(id => this.unread.find(n => n.id === id))
            .filter(n => n && (!notificationTime(n) || notificationTime(n) >= this.startedAt - 60000));
        if (!fresh.length) return;
        const latest = fresh[0];
        const text = fresh.length > 1
            ? `${notificationText(latest)} (+${fresh.length - 1})`
            : notificationText(latest);
        UIManager.showToast(text, TOAST_MS);
        this.showSystemNotification(fresh);
        if (this.panelOpen) {
            this.panelItems = prepareList([...fresh, ...this.panelItems]);
            this.renderPanel();
        }
    },

    /** @private */
    onListenerError(uid, error) {
        if (uid !== this.uid) return;
        console.error('Notifications listener error:', error);
        const bell = document.getElementById('notifBell');
        if (bell) bell.classList.add('notif-error');
        try {
            TelemetryService.logWarning('Notifications listener failed', { code: error?.code || '', message: error?.message || String(error) });
        } catch (e) {
            console.warn('Telemetry unavailable:', e);
        }
        if (!this.errorShown) {
            this.errorShown = true;
            UIManager.showToast(notificationErrorMessage(error), TOAST_MS);
        }
    },

    /** @private */
    setBellVisible(visible) {
        const bell = document.getElementById('notifBell');
        if (!bell) return;
        bell.style.display = visible ? '' : 'none';
        if (!visible) bell.classList.remove('notif-error');
    },

    /** Updates the bell badge from the unread listener. */
    renderBadge() {
        const badge = document.getElementById('notifBadge');
        const bell = document.getElementById('notifBell');
        const text = badgeText(this.unread.length);
        if (badge) {
            badge.textContent = text;
            badge.hidden = !text;
        }
        if (bell) {
            bell.setAttribute('aria-label', text ? t('ui.nav.notifications_unread', { count: text }) : t('ui.common.notifications'));
        }
    },

    toggle() {
        if (this.panelOpen) this.close();
        else this.openInbox().catch(e => console.warn('Opening notifications failed:', e));
    },

    /** Opens the inbox, loads the newest page and marks what is shown as read. */
    async openInbox() {
        const panel = document.getElementById('notifPanel');
        if (!panel || !this.uid) return;
        this.panelOpen = true;
        panel.hidden = false;
        const backdrop = document.getElementById('notifBackdrop');
        if (backdrop) backdrop.hidden = false;
        this.panelItems = prepareList(this.unread.slice());
        this.cursor = null;
        this.hasMore = false;
        this.renderPanel();
        await this.loadPage(true);
        if (!this.panelOpen) return;
        this.markRead(idsToMarkRead('open', this.panelItems.filter(n => !n.readNow)));
    },

    close() {
        this.panelOpen = false;
        const panel = document.getElementById('notifPanel');
        if (panel) panel.hidden = true;
        const backdrop = document.getElementById('notifBackdrop');
        if (backdrop) backdrop.hidden = true;
    },

    async loadMore() {
        await this.loadPage(false);
        if (this.panelOpen) this.markRead(idsToMarkRead('open', this.panelItems.filter(n => !n.readNow)));
    },

    /** @private */
    async loadPage(first) {
        if (this.loading || !this.uid) return;
        const uid = this.uid;
        this.loading = true;
        this.renderPanel();
        try {
            const page = await FirebaseService.loadNotificationsPage(uid, { limit: PAGE_SIZE, after: first ? null : this.cursor });
            if (uid !== this.uid) return;
            this.cursor = page.cursor;
            this.hasMore = page.hasMore;
            this.panelItems = prepareList([...this.panelItems, ...page.items]);
        } catch (error) {
            console.error('Loading notifications failed:', error);
            try {
                TelemetryService.logWarning('Notifications inbox load failed', { code: error?.code || '', message: error?.message || String(error) });
            } catch (e) {
                console.warn('Telemetry unavailable:', e);
            }
            UIManager.showToast(notificationErrorMessage(error), TOAST_MS);
        } finally {
            this.loading = false;
            this.renderPanel();
        }
    },

    /** @private Marks ids read locally (keeps the "new" highlight) and in Firestore. */
    markRead(ids) {
        if (!ids.length) return;
        this.applyLocalRead(ids);
        FirebaseService.markNotificationsRead(ids)
            .catch(e => console.warn('Marking notifications read failed:', e));
    },

    /** @private */
    applyLocalRead(ids) {
        const set = new Set(ids);
        this.panelItems.forEach(n => { if (set.has(n.id)) n.readNow = true; });
        this.unread = this.unread.filter(n => !set.has(n.id));
        this.renderBadge();
    },

    /**
     * Marks every unread notification of this user read on the server, not
     * only the ones in memory: otherwise the 20-doc unread listener refills
     * with older unread and the badge comes back.
     */
    markAllRead() {
        if (!this.uid) return;
        const ids = idsToMarkRead('all', [...this.unread, ...this.panelItems.filter(n => !n.readNow)]);
        this.applyLocalRead(ids);
        this.panelItems.forEach(n => { n.read = true; });
        this.renderPanel();
        FirebaseService.markAllNotificationsRead(this.uid)
            .catch(e => {
                console.warn('Mark all read failed:', e);
                FirebaseService.markNotificationsRead(ids)
                    .catch(err => console.warn('Marking notifications read failed:', err));
            });
    },

    /** Row tap: mark it read and go to the related item / bill list. */
    openNotification(id) {
        const n = this.panelItems.find(x => x.id === id) || this.unread.find(x => x.id === id);
        if (!n) return;
        this.markRead(idsToMarkRead('tap', [n], id));
        const target = describeNotification(n).target;
        this.close();
        if (!target?.tab || !window.app?.nav) return;
        window.app.nav.showTab(target.tab);
        if (target.tab === 'items' && target.query) {
            setTimeout(() => {
                const input = document.getElementById('itemsSearchInput');
                if (input) input.value = target.query;
                window.app.items?.search?.(target.query);
            }, 200);
        }
    },

    /** @private */
    renderPanel() {
        const list = document.getElementById('notifList');
        if (!list) return;
        const now = Date.now();
        if (!this.panelItems.length) {
            list.innerHTML = this.loading
                ? '<div class="notif-empty">Loading… · लोड हो रहा है…</div>'
                : '<div class="notif-empty">No notifications yet · अभी कोई सूचना नहीं</div>';
        } else {
            list.innerHTML = this.panelItems.map(n => {
                const d = describeNotification(n);
                const when = formatWhen(notificationTime(n), now);
                const unread = n.read !== true;
                const who = d.who ? `${Helpers.escapeHtml(d.who)} · ` : '';
                return `
                <button type="button" class="notif-row${unread ? ' unread' : ''}" onclick="window.app.notifications.openNotification('${Helpers.escapeJsAttr(n.id)}')">
                    <span class="notif-icon">${d.icon}</span>
                    <span class="notif-body">
                        <span class="notif-en">${Helpers.escapeHtml(d.en)}</span>
                        <span class="notif-hi">${Helpers.escapeHtml(d.hi)}</span>
                        <span class="notif-meta">${who}<span title="${Helpers.escapeHtml(when.abs)} IST">${Helpers.escapeHtml(when.en)} · ${Helpers.escapeHtml(when.hi)}</span></span>
                    </span>
                </button>`;
            }).join('');
        }
        const more = document.getElementById('notifMore');
        if (more) {
            more.hidden = !this.hasMore;
            more.disabled = this.loading;
        }
    },

    /** Deletes this user's notifications older than 30 days, at most once a day per device. */
    async cleanupOld(uid) {
        if (uid !== this.uid) return;
        const key = `${CLEANUP_KEY}.${uid}`;
        try {
            const last = Number(localStorage.getItem(key)) || 0;
            if (Date.now() - last < CLEANUP_EVERY_MS) return;
            localStorage.setItem(key, String(Date.now()));
        } catch (e) {
            console.warn('localStorage unavailable:', e);
        }
        FirebaseService.deleteOldNotifications(uid, retentionCutoff())
            .then(n => { if (n) console.info(`Removed ${n} notifications older than 30 days`); })
            .catch(e => console.warn('Old notifications cleanup failed:', e?.code || e));
    },

    // ---------- Optional desktop system notifications (no push) ----------

    /** System notifications are possible here: web (not the Android app) with the Notification API. */
    systemSupported() {
        if (typeof window === 'undefined' || !('Notification' in window)) return false;
        return !window.Capacitor?.isNativePlatform?.();
    },

    systemEnabled() {
        try {
            return this.systemSupported() && localStorage.getItem(SYSTEM_PREF_KEY) === '1' && window.Notification.permission === 'granted';
        } catch (e) {
            return false;
        }
    },

    /** Settings checkbox handler. */
    async toggleSystem(checked) {
        if (!this.systemSupported()) return;
        if (checked) {
            let permission = window.Notification.permission;
            if (permission === 'default') permission = await window.Notification.requestPermission();
            if (permission !== 'granted') {
                UIManager.showToast(t('msg.notifications.browser_blocked_notifications_allow_them'), TOAST_MS);
                this.refreshSettings();
                return;
            }
            localStorage.setItem(SYSTEM_PREF_KEY, '1');
            UIManager.showToast(t('msg.notifications.desktop_notifications_on_while_app'));
        } else {
            localStorage.removeItem(SYSTEM_PREF_KEY);
        }
        this.refreshSettings();
    },

    /** Shows/hides the Settings card and syncs the checkbox. */
    refreshSettings() {
        const card = document.getElementById('notifSettingsCard');
        if (!card) return;
        card.style.display = this.systemSupported() ? '' : 'none';
        const box = document.getElementById('settingSystemNotifications');
        if (box) box.checked = this.systemEnabled();
    },

    /** @private Only when the tab is in the background and the user opted in. */
    showSystemNotification(fresh) {
        if (!this.systemEnabled() || typeof document === 'undefined' || !document.hidden) return;
        try {
            const d = describeNotification(fresh[0]);
            const body = `${d.en}\n${d.hi}${d.who ? `\n— ${d.who}` : ''}`;
            const note = new window.Notification(fresh.length > 1 ? `${APP_IDENTITY.appName}: ${fresh.length} new` : APP_IDENTITY.appName, { body, tag: 'aadhat-notifications' });
            note.onclick = () => { window.focus(); this.openInbox().catch(e => console.warn('Opening notifications failed:', e)); note.close(); };
        } catch (e) {
            console.warn('System notification failed:', e);
        }
    }
};

export { NotificationsManager };
