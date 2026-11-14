/**
 * @fileoverview Admin Manager - owner-only panel: Users (approval, roles) and Data.
 * Labour, bill checks and the business name moved to Settings › Aadhat; the old
 * Configure tab opens that section.
 * @module modules/admin
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
import { Exporter } from '../services/exporter.js';
import { todayLocalISO, formatDateTimeIN, formatDay, formatDayTime, toLocalISODate } from '../utils/dates.js';
import { verifyBackup, verifyBackupText, recordDrill, readLimited } from '../utils/backup-verify.js';
import { userCounts, activityByUser, activityRange, ACTIVITY_RANGES } from '../utils/user-activity.js';
import { historyLoadedFrom } from '../utils/history-window.js';
import { getLang } from '../i18n/index.js';
import { buildBackup, isDeleteConfirmed, DELETE_CONFIRM_WORD, canClearCollection } from '../utils/data-export.js';
import { t } from '../i18n/index.js';
import { UserAdmin, isRemovedProfile, logUserAction } from '../services/user-admin.js';
import { icon } from '../ui/icons.js';
import { moneyHtml, emptyState } from '../ui/components.js';

const tx = (key, params) => Helpers.escapeHtml(t(key, params));
/** Most audit entries the activity report reads per tap. */
const ACTIVITY_LIMIT = 300;
/** Largest backup file checked on a phone (memory). */
const BACKUP_MAX_BYTES = 80 * 1024 * 1024;
/** Reasons readBackupFile gives; anything else thrown (a file moved away, a lapsed permission) is 'unreadable'. */
const BACKUP_READ_CODES = ['too_big', 'encrypted', 'gzip'];

/**
 * Admin Manager - owner-only panel
 * @namespace AdminManager
 */
const AdminManager = {
    /**
     * Current active tab
     * @type {string}
     */
    activeTab: 'users',

    /**
     * Storage stats data
     * @type {Object|null}
     */
    storageStats: null,

    /**
     * Initialize admin panel
     */
    async init() {
        if (AppState.userRole !== 'owner') {
            UIManager.showToast(t('msg.common.access_denied'), 'error');
            return;
        }
        this.renderTabs();
        this.renderContent();
    },

    /**
     * Render the tab buttons
     */
    renderTabs() {
        const container = document.getElementById('adminTabsContainer');
        if (!container) return;

        const sel = (id) => String(this.activeTab === id);
        container.innerHTML = `
            <div class="admin-tabs">
                <div class="tabs" role="tablist">
                    <button type="button" role="tab" aria-selected="${sel('users')}" data-onclick="admin.showTab('users')">${tx('ui.admin.tab_users')}</button>
                    <button type="button" role="tab" aria-selected="${sel('data')}" data-onclick="admin.showTab('data')">${tx('ui.admin.tab_data')}</button>
                </div>
                <button class="btn btn-ghost btn-sm admin-open-settings" type="button"
                        data-onclick="nav.showTab('settings-shop', event)">
                    ${icon('sliders', 'i-sm')} ${tx('ui.admin.shop_settings_link')}
                </button>
            </div>
        `;
    },

    /**
     * Switch tab
     * @param {string} tab - Tab name
     */
    showTab(tab) {
        // Old Configure tab: its items live in Settings › Aadhat now.
        if (tab === 'configure') {
            window.app?.nav?.showTab?.('settings-shop');
            return;
        }
        this.activeTab = tab;
        this.renderTabs();
        this.renderContent();
    },

    /**
     * Render content based on active tab
     */
    renderContent() {
        switch (this.activeTab) {
            case 'users':
                this.renderUsers();
                break;
            case 'data':
                this.renderData();
                break;
        }
    },

    /**
     * Render Users tab
     */
    async renderUsers() {
        const container = document.getElementById('adminContainer');
        if (!container) return;

        container.innerHTML = `
            <p class="admin-hint" id="adminUserCounts"></p>
            <section class="admin-section">
                <h3>${tx('ui.users.pending_registrations')}</h3>
                <p class="admin-hint">${tx('ui.users.approve_new_users_and_assign')}</p>
                <div class="panel" id="adminPendingUsers">
                    <p class="empty">${tx('ui.navigation.loading')}</p>
                </div>
            </section>

            <section class="admin-section">
                <h3>${tx('ui.users.active_users')}</h3>
                <p class="admin-hint">${tx('ui.users.manage_existing_user_roles')}</p>
                <div class="panel" id="adminActiveUsers">
                    <p class="empty">${tx('ui.navigation.loading')}</p>
                </div>
            </section>

            <section class="admin-section" id="adminRemovedCard" hidden>
                <h3>${tx('ui.admin.removed_users')}</h3>
                <p class="admin-hint">${tx('ui.admin.removed_users_hint')}</p>
                <div class="panel" id="adminRemovedUsers"></div>
            </section>

            <section class="admin-section" id="adminActivityCard">
                <h3>${tx('ui.admin.activity_title')}</h3>
                <p class="admin-hint">${tx('ui.admin.activity_hint')}</p>
                <div class="seg admin-range" role="group" id="adminActivityRange">
                    ${ACTIVITY_RANGES.map(r => `<button type="button" aria-pressed="false" data-range="${Helpers.escapeHtml(r)}" data-onclick="admin.showActivity('${Helpers.escapeJsAttr(r)}')">${tx(`ui.admin.range_${r}`)}</button>`).join('')}
                </div>
                <div id="adminActivity"></div>
            </section>
        `;

        await this.loadUsers();
    },

    /**
     * Load users from Firestore
     */
    async loadUsers() {
        try {
            const users = await FirebaseService.loadUsers();
            
            const pendingUsers = [];
            const activeUsers = [];
            const removedUsers = [];
            
            users.forEach(user => {
                if (isRemovedProfile(user)) {
                    removedUsers.push(user);
                    return;
                }
                // Match logic from users.js: pending if status is pending OR no role assigned
                if (user.status === 'pending' || !user.role) {
                    pendingUsers.push(user);
                } else {
                    activeUsers.push(user);
                }
            });

            this.users = users;
            this.renderCounts(users);
            this.renderPendingUsers(pendingUsers);
            this.renderActiveUsers(activeUsers);
            this.renderRemovedUsers(removedUsers);
        } catch (error) {
            console.error('Error loading users:', error);
            UIManager.showToast(t('msg.common.failed_load_users'), 'error');
        }
    },

    /**
     * Removed and rejected people (#84), each with Restore (back to pending).
     * @param {Array} users
     */
    renderRemovedUsers(users) {
        const card = document.getElementById('adminRemovedCard');
        const container = document.getElementById('adminRemovedUsers');
        if (!card || !container) return;
        card.hidden = users.length === 0;
        container.innerHTML = users.map(user => this.userHtml(user, 'removed')).join('');
    },

    /**
     * One person in a Users list: name, email and a tag, with their buttons below.
     * @param {Object} user
     * @param {'pending'|'active'|'removed'} kind
     */
    userHtml(user, kind) {
        const isMe = kind === 'active' && user.id === AppState.currentUser?.uid;
        return `
            <div class="admin-user">
                <div class="row">
                    <div class="row-main">
                        <div class="row-title">${Helpers.escapeHtml(user.name || t('ui.reports.unknown'))}${isMe ? ` <span class="tag">${tx('ui.admin.you')}</span>` : ''}</div>
                        <div class="row-meta">${Helpers.escapeHtml(user.email || '')}</div>
                    </div>
                    <div class="row-trail">${this.userTagHtml(user, kind)}</div>
                </div>
                ${isMe ? '' : this.userActionsHtml(user, kind)}
            </div>`;
    },

    /** The person's status (pending, removed / rejected) or role. */
    userTagHtml(user, kind) {
        if (kind === 'removed') return `<span class="tag neg">${tx(user.status === 'rejected' ? 'ui.admin.status_rejected' : 'ui.admin.status_removed')}</span>`;
        if (kind === 'pending') return `<span class="tag warn">${tx('ui.admin.pending')}</span>`;
        return `<span class="tag${user.role === 'owner' ? ' info' : ''}">${Helpers.escapeHtml(Helpers.roleLabel(user.role))}</span>`;
    },

    /** Restore (removed), role + Approve / Reject (pending), Edit role / Reset password / Delete (active). */
    userActionsHtml(user, kind) {
        const id = Helpers.escapeJsAttr(user.id);
        const safeName = Helpers.escapeJsAttr(user.name || '');
        if (kind === 'removed') {
            return `<div class="admin-user-actions">
                    <button type="button" class="btn btn-sm btn-tonal" data-onclick="admin.restoreUser('${id}', '${safeName}')">
                        ${icon('refresh', 'i-sm')} ${tx('ui.admin.restore')}
                    </button>
                </div>`;
        }
        if (kind === 'pending') {
            return `<div class="admin-user-actions">
                    <select class="input admin-role-pick" id="role-${Helpers.escapeHtml(user.id)}">
                        <option value="staff">${Helpers.escapeHtml(Helpers.roleLabel('staff'))}</option>
                        <option value="manager">${Helpers.escapeHtml(Helpers.roleLabel('manager'))}</option>
                    </select>
                    <button type="button" class="btn btn-sm btn-tonal btn-approve" data-onclick="admin.approveUser('${id}')">
                        ${icon('check', 'i-sm')} ${tx('ui.admin.approve')}
                    </button>
                    <button type="button" class="btn btn-sm btn-reject" data-onclick="admin.rejectUser('${id}')">
                        ${icon('x', 'i-sm')} ${tx('ui.admin.reject')}
                    </button>
                </div>`;
        }
        return `<div class="admin-user-actions">
                    <button type="button" class="btn btn-sm btn-tonal" data-onclick="admin.showChangeRole('${id}', '${safeName}', '${Helpers.escapeJsAttr(user.role)}')">
                        ${icon('sliders', 'i-sm')} ${tx('ui.admin.edit_role')}
                    </button>
                    <button type="button" class="btn btn-sm" data-onclick="admin.resetUserPassword('${id}', '${Helpers.escapeJsAttr(user.email || '')}')">
                        ${icon('lock', 'i-sm')} ${tx('ui.admin.reset_password')}
                    </button>
                    <button type="button" class="btn btn-sm btn-danger" data-onclick="admin.deleteUser('${id}', '${safeName}')">
                        ${icon('trash', 'i-sm')} ${tx('ui.modals.delete')}
                    </button>
                </div>`;
    },

    /** People loaded for the Users tab (names for the activity report). */
    users: [],
    activitySeq: 0,

    /** ADM-1: counts by role, pending and removed, from the list already loaded. */
    renderCounts(users) {
        const el = document.getElementById('adminUserCounts');
        if (!el) return;
        const c = userCounts(users, isRemovedProfile);
        el.textContent = t('ui.admin.counts', {
            owner: c.owner, manager: c.manager, member: c.member, pending: c.pending, removed: c.removed
        });
    },

    /**
     * Per-person activity (#145): bills from the bills on this phone, payments,
     * edits, voids and sign-ins from the audit log of the range (one read of at
     * most ACTIVITY_LIMIT entries, only when tapped).
     * @param {'today'|'week'|'month'|'last_month'} range
     */
    async showActivity(range = 'week') {
        if (AppState.userRole !== 'owner') return;
        const host = document.getElementById('adminActivity');
        if (!host || !ACTIVITY_RANGES.includes(range)) return;
        document.querySelectorAll('#adminActivityRange [data-range]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
        host.innerHTML = `<p class="empty">${tx('ui.navigation.loading')}</p>`;
        const seq = ++this.activitySeq;
        const { from, to } = activityRange(range);
        let audit = [];
        let auditFailed = false;
        try {
            audit = await AuditService.getLogsBetween(from, to, ACTIVITY_LIMIT);
        } catch (error) {
            console.warn('Activity: audit log not read:', error?.code || error);
            auditFailed = true;
        }
        // A later tap (another range) wins.
        if (seq !== this.activitySeq) return;
        const bills = [...(AppState.purchaseHistory || []), ...(AppState.retailSalesHistory || []), ...(AppState.salesHistory || [])];
        const rows = activityByUser({ bills, audit, from, to });
        const names = new Map((this.users || []).map(u => [u.id, u.name || u.email || '']));
        const notes = [];
        if (auditFailed) notes.push(t('ui.admin.activity_audit_failed'));
        else if (audit.length >= ACTIVITY_LIMIT) notes.push(t('ui.admin.activity_limited', { count: ACTIVITY_LIMIT }));
        const loadedFrom = historyLoadedFrom();
        if (loadedFrom && loadedFrom > from) notes.push(t('ui.admin.activity_bills_from', { date: formatDay(loadedFrom, { lang: getLang() }) }));
        const noteHtml = notes.map(n => `<p class="notice admin-note">${Helpers.escapeHtml(n)}</p>`).join('');
        if (!rows.length) {
            host.innerHTML = `${noteHtml}${emptyState({ icon: 'list', title: t('ui.admin.activity_none') })}`;
            return;
        }
        const cell = (v) => `<td class="num">${Helpers.escapeHtml(String(v))}</td>`;
        host.innerHTML = `${noteHtml}
            <div class="panel admin-table-wrap"><table class="table admin-activity-table">
                <thead><tr><th>${tx('ui.admin.col_person')}</th><th class="num">${tx('ui.admin.col_bills')}</th>
                    <th class="num">${tx('ui.admin.col_bill_total')}</th><th class="num">${tx('ui.admin.col_payments')}</th>
                    <th class="num">${tx('ui.admin.col_edits')}</th><th class="num">${tx('ui.admin.col_voids')}</th>
                    <th class="num">${tx('ui.admin.col_last_active')}</th></tr></thead>
                <tbody>${rows.map(r => `<tr data-uid="${Helpers.escapeHtml(r.uid)}"><td>${Helpers.escapeHtml(names.get(r.uid) || t('ui.reports.unknown'))}</td>`
                    + cell(r.bills) + `<td class="num">${moneyHtml(r.billTotal)}</td>` + cell(r.payments) + cell(r.edits) + cell(r.voids)
                    + cell(r.lastActive ? formatDateTimeIN(new Date(r.lastActive)) : '—') + '</tr>').join('')}</tbody>
            </table></div>`;
    },

    /**
     * Render pending users list
     * @param {Array} users - Pending users
     */
    renderPendingUsers(users) {
        const container = document.getElementById('adminPendingUsers');
        if (!container) return;

        if (users.length === 0) {
            container.innerHTML = emptyState({ icon: 'check', tone: 'pos', title: t('ui.admin.no_pending') });
            return;
        }

        container.innerHTML = users.map(user => this.userHtml(user, 'pending')).join('');
    },

    /**
     * Render active users list
     * @param {Array} users - Active users
     */
    renderActiveUsers(users) {
        const container = document.getElementById('adminActiveUsers');
        if (!container) return;

        if (users.length === 0) {
            container.innerHTML = emptyState({ icon: 'user', title: t('ui.admin.no_active_users') });
            return;
        }

        container.innerHTML = users.map(user => this.userHtml(user, 'active')).join('');
    },

    /**
     * Approve a user
     * @param {string} userId - User ID
     */
    async approveUser(userId) {
        const roleSelect = document.getElementById(`role-${userId}`);
        const role = roleSelect?.value || 'staff';

        try {
            UIManager.showLoading();
            await FirebaseService.updateUser(userId, {
                status: 'active',
                role: role,
                approvedAt: FirebaseService.serverTimestamp(),
                approvedBy: AppState.currentUser?.uid
            });

            logUserAction(AuditService.ACTIONS.APPROVE_USER, { targetUserId: userId, role });
            UIManager.showToast(t('msg.common.user_approved_as', { roleLabel: Helpers.roleLabel(role) }));
            await this.loadUsers();
        } catch (error) {
            console.error('Error approving user:', error);
            UIManager.showToast(t('msg.common.failed_approve_user'), 'error');
        } finally {
            UIManager.hideLoading();
        }
    },

    /**
     * Reject a user
     * @param {string} userId - User ID
     */
    async rejectUser(userId) {
        const rejected = await UserAdmin.rejectUser(userId);
        if (rejected) await this.loadUsers();
        return rejected;
    },

    /**
     * Restore a removed or rejected person as a pending registration (#84)
     * @param {string} userId - User ID
     * @param {string} userName - User name
     */
    async restoreUser(userId, userName) {
        const restored = await UserAdmin.restoreUser(userId, userName);
        if (restored) await this.loadUsers();
        return restored;
    },

    /**
     * Show change role dialog
     * @param {string} userId - User ID
     * @param {string} userName - User name
     * @param {string} currentRole - Current role
     */
    async showChangeRole(userId, userName, currentRole) {
        const roles = ['staff', 'manager'];
        const newRole = currentRole === 'staff' ? 'manager' : 'staff';
        
        const confirmed = await UIManager.showModal(
            t('msg.admin.change_s_role_from', { userName, roleLabel: Helpers.roleLabel(currentRole), roleLabel2: Helpers.roleLabel(newRole) }),
            t('msg.admin.change_role'),
            true,
            { confirmLabel: t('msg.admin.change_role') }
        );
        if (!confirmed) return;

        try {
            UIManager.showLoading();
            await FirebaseService.updateUser(userId, {
                role: newRole
            });

            logUserAction(AuditService.ACTIONS.CHANGE_USER_ROLE, { targetUserId: userId, from: currentRole, to: newRole });
            UIManager.showToast(t('msg.admin.role_changed', { roleLabel: Helpers.roleLabel(newRole) }));
            await this.loadUsers();
        } catch (error) {
            console.error('Error changing role:', error);
            UIManager.showToast(t('msg.common.failed_change_role'), 'error');
        } finally {
            UIManager.hideLoading();
        }
    },

    /**
     * Send a password-reset email to a user (owner only)
     * @param {string} userId - User document ID
     * @param {string} email - User's email address
     */
    async resetUserPassword(userId, email) {
        return UserAdmin.resetPassword(userId, email);
    },

    /**
     * Remove a user's access (owner only); see services/user-admin.js
     * @param {string} userId - User document ID
     * @param {string} userName - User's display name
     */
    async deleteUser(userId, userName) {
        const removed = await UserAdmin.removeUser(userId, userName);
        if (removed) await this.loadUsers();
        return removed;
    },

    /**
     * Render Data tab
     */
    renderData() {
        const container = document.getElementById('adminContainer');
        if (!container) return;

        container.innerHTML = `
            <section class="panel panel-pad admin-section">
                <h3>${icon('grid')} ${tx('ui.admin.storage_title')}</h3>
                <p class="admin-hint">${tx('ui.admin.storage_hint')}</p>
                <button type="button" class="btn btn-tonal admin-action" data-onclick="admin.loadStorageStats()">
                    ${icon('refresh', 'i-sm')} ${tx('ui.admin.storage_calc')}
                </button>
                <div id="adminStorageStats"></div>
            </section>

            <section class="panel panel-pad admin-section" id="adminBackupCheck">
                <h3>${icon('shield')} ${tx('ui.backup.title')}</h3>
                <p class="admin-hint">${tx('ui.backup.hint')}</p>
                <label class="btn btn-tonal admin-action backup-pick">
                    ${icon('file', 'i-sm')} ${tx('ui.backup.pick')}
                    <input type="file" id="adminBackupFile" accept=".json,.gz,application/json,application/gzip" hidden data-onchange="admin.checkBackupInput(this)">
                </label>
                <div id="adminBackupResult" aria-live="polite"></div>
                <details class="backup-restore-guide">
                    <summary><strong>${tx('ui.backup.restore_title')}</strong></summary>
                    <ol>
                        <li>${tx('ui.backup.step_get')}</li>
                        <li>${tx('ui.backup.step_check')}</li>
                        <li>${tx('ui.backup.step_drill')}</li>
                        <li>${tx('ui.backup.step_restore')}</li>
                    </ol>
                    <p class="admin-hint">${tx('ui.backup.restore_note')}</p>
                </details>
            </section>

            <section class="panel panel-pad admin-section" id="adminDueFields">
                <h3>${icon('receipt')} ${tx('ui.duefix.title')}</h3>
                <p class="admin-hint">${tx('ui.duefix.hint')}</p>
                <button type="button" class="btn btn-tonal admin-action" data-onclick="admin.checkDueFields()">
                    ${icon('search', 'i-sm')} ${tx('ui.duefix.check')}
                </button>
                <div id="adminDueFieldsResult" aria-live="polite">${this.dueFieldsLastRunHtml()}</div>
            </section>
            <section class="panel panel-pad admin-section danger-zone">
                <h3 class="tone-neg">${icon('alert')} ${tx('ui.admin.danger_zone')}</h3>
                <p class="admin-hint">${tx('ui.admin.danger_hint')}</p>
                <button type="button" class="btn btn-danger" data-onclick="admin.clearAllData()">
                    ${icon('trash', 'i-sm')} ${tx('ui.admin.clear_all')}
                </button>
            </section>
        `;

        // If we have cached stats, show them
        if (this.storageStats) {
            this.displayStorageStats(this.storageStats);
        }
    },

    /** The last due backfill (DUE-BACKFILL, #126) as recorded, for the Data tab. */
    dueFieldsLastRunHtml() {
        const last = FirebaseService.dueBackfillState?.();
        if (!last) return '';
        return `<p class="admin-hint">${tx('ui.duefix.last_run', { date: formatDayTime(last.at, { lang: getLang() }) || '', written: last.written || 0 })}</p>`;
    },

    /**
     * DUE-BACKFILL check (#126), a dry run: reads every bill once and says how many store their due
     * other than once, as a number in payment.due. Writes nothing.
     */
    async checkDueFields() {
        if (AppState.userRole !== 'owner' || Helpers.isBusy('due-fields')) return;
        if (!(await UIManager.showModal(t('msg.duefix.check_confirm'), t('ui.duefix.title'), true))) return;
        const box = document.getElementById('adminDueFieldsResult');
        await Helpers.runExclusive('due-fields', '#adminDueFields button', async () => {
            try {
                if (box) box.textContent = t('ui.duefix.checking');
                const check = await FirebaseService.checkDueFields();
                this.dueFieldsCheck = check;
                if (!box) return;
                const count = check.todo.length;
                box.innerHTML = `<p>${tx('ui.duefix.checked', { checked: check.checked })}</p>`
                    + (count
                        ? `<p>${tx('ui.duefix.todo', { count, missing: check.byReason.missing, notNumber: check.byReason.notNumber, mirror: check.byReason.mirror })}</p>
                           <button type="button" class="btn btn-primary admin-action" data-onclick="admin.backfillDueFields()">${icon('check', 'i-sm')} ${tx('ui.duefix.run', { count })}</button>`
                        : `<p>${tx('ui.duefix.none')}</p>`)
                    + (check.changes.length ? `<p>${tx('ui.duefix.changes', { count: check.changes.length })}</p>` : '');
            } catch (error) {
                console.error('Due check failed:', error);
                if (box) box.textContent = t(error?.code === 'unavailable' ? 'msg.duefix.offline' : 'msg.duefix.failed');
            }
        });
    },

    /**
     * DUE-BACKFILL (#126): stores the due once in payment.due on the bills the check listed
     * (each re-read in a transaction, so a payment meanwhile is kept), with one audit entry.
     * No figure on any screen changes.
     */
    async backfillDueFields() {
        const check = this.dueFieldsCheck;
        if (AppState.userRole !== 'owner' || Helpers.isBusy('due-fields') || !check?.todo.length) return;
        const count = check.todo.length;
        if (!(await UIManager.showModal(t('msg.duefix.run_confirm', { count }), t('ui.duefix.title'), true))) return;
        const box = document.getElementById('adminDueFieldsResult');
        await Helpers.runExclusive('due-fields', '#adminDueFields button', async () => {
            try {
                if (box) box.textContent = t('ui.duefix.running');
                const result = await FirebaseService.backfillDueFields(check.todo, check.checked);
                this.dueFieldsCheck = null;
                AuditService.note(AuditService.ACTIONS.DUE_BACKFILL, {
                    checked: check.checked, listed: count, written: result.written, failed: result.failed, ...check.byReason
                });
                if (box) {
                    box.textContent = t(result.failed ? 'ui.duefix.done_failed' : 'ui.duefix.done', { written: result.written, failed: result.failed });
                }
            } catch (error) {
                console.error('Due backfill failed:', error);
                if (box) box.textContent = t('msg.duefix.failed');
            }
        });
    },
    /**
     * The text of a chosen backup file (#63): a .json, or a .json.gz unpacked on the
     * phone; an encrypted .enc file is refused (decrypt it first, tools/backup/README.md).
     * @param {File} file
     * @returns {Promise<string>} throws an Error whose `code` is a backup problem code
     */
    async readBackupFile(file) {
        const fail = (code) => Object.assign(new Error(code), { code });
        if (file.size > BACKUP_MAX_BYTES) throw fail('too_big');
        const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
        if (String.fromCharCode(...head) === 'Salted__' || /\.enc$/i.test(file.name || '')) throw fail('encrypted');
        if (head[0] === 0x1f && head[1] === 0x8b) {
            if (typeof DecompressionStream === 'undefined') throw fail('gzip');
            // Unpacked size counts too: a small .gz can unpack to more than a phone can hold.
            const text = await readLimited(file.stream().pipeThrough(new DecompressionStream('gzip')), BACKUP_MAX_BYTES);
            if (text === null) throw fail('too_big');
            return text;
        }
        return file.text();
    },

    /**
     * Checks a backup file on this phone, read-only (#63): nothing is uploaded or written
     * to the database. A good one is the owner's restore drill: recorded on this phone
     * (REM-3 on Today) and in the audit log.
     * @param {File} file
     * @returns {Promise<Object|null>} verifyBackup() result
     */
    async checkBackupFile(file) {
        if (!file || AppState.userRole !== 'owner') return null;
        const box = document.getElementById('adminBackupResult');
        if (box) box.innerHTML = `<p>${tx('ui.backup.checking')}</p>`;
        const now = Date.now();
        let result;
        try {
            result = verifyBackupText(await this.readBackupFile(file), now);
        } catch (e) {
            result = verifyBackup(null, now);
            result.problems[0] = { code: typeof e?.code === 'string' && BACKUP_READ_CODES.includes(e.code) ? e.code : 'unreadable' };
        }
        if (result.ok) {
            const uid = AppState.currentUser?.uid || '';
            recordDrill(localStorage, { uid, at: now, exportedAt: result.exportedAt, docs: result.totalDocs });
            AuditService.note(AuditService.ACTIONS.BACKUP_CHECK, {
                recordsChecked: result.totalDocs,
                date: result.exportedAt ? toLocalISODate(new Date(result.exportedAt)) : null
            });
        }
        if (box) box.innerHTML = this.backupResultHtml(result);
        return result;
    },

    backupResultHtml(r) {
        const e = (v) => Helpers.escapeHtml(String(v ?? ''));
        const lang = getLang();
        if (!r.ok) {
            const items = r.problems.map(p => `<li>${e(t(`ui.backup.p_${p.code}`, { coll: p.coll, at: p.at, id: p.id, file: p.file, manifest: p.manifest }))}</li>`).join('');
            const more = r.problemCount > r.problems.length ? `<p>${e(t('ui.backup.more_problems', { count: r.problemCount - r.problems.length }))}</p>` : '';
            return `<div class="notice neg backup-result backup-bad" data-backup-ok="false">${icon('x', 'i-sm')}<div class="grow"><p><b>${e(t('ui.backup.bad'))}</b></p><ul>${items}</ul>${more}</div></div>`;
        }
        const rows = [...r.collections, ...r.subcollections].map(c => `<tr><td lang="en" translate="no">${e(c.name)}</td><td class="num">${e(c.docs.toLocaleString('en-IN'))}</td></tr>`).join('');
        const lines = [
            t('ui.backup.good_docs', { docs: r.totalDocs.toLocaleString('en-IN'), collections: r.collections.length }),
            r.exportedAt ? t('ui.backup.good_saved', { when: formatDayTime(r.exportedAt, { lang }), days: r.ageDays }) : '',
            r.newestBillAt ? t('ui.backup.good_newest', { when: formatDay(r.newestBillAt, { lang }) }) : ''
        ].filter(Boolean);
        return `<div class="notice pos backup-result backup-good" data-backup-ok="true">${icon('check', 'i-sm')}<div class="grow"><p><b>${e(t('ui.backup.good'))}</b></p>`
            + lines.map(l => `<p>${e(l)}</p>`).join('')
            + (r.ageDays > 2 ? `<p class="backup-warn tone-warn">${icon('alert', 'i-sm')} ${e(t('ui.backup.old', { days: r.ageDays }))}</p>` : '')
            + `<details><summary>${e(t('ui.backup.counts'))}</summary><table class="table backup-counts">${rows}</table></details></div></div>`;
    },

    /**
     * Load storage statistics
     */
    async loadStorageStats() {
        try {
            UIManager.showLoading();
            
            const collections = [
                { name: 'items', labelKey: 'ui.admin.col_items' },
                { name: 'purchases', labelKey: 'ui.admin.col_purchases' },
                { name: 'retailSales', labelKey: 'ui.admin.col_retail_sales' },
                { name: 'wholesaleSales', labelKey: 'ui.admin.col_wholesale_sales' },
                { name: 'expenses', labelKey: 'ui.admin.col_expenses' },
                { name: 'stockAdjustments', labelKey: 'ui.admin.col_stock_adjustments' },
                { name: 'withdrawals', labelKey: 'ui.admin.col_withdrawals' },
                { name: 'cashManagement', labelKey: 'ui.admin.col_cash_management' },
                { name: 'users', labelKey: 'ui.admin.col_users' },
                { name: 'auditLogs', labelKey: 'ui.admin.col_audit_logs' },
                { name: 'telemetry', labelKey: 'ui.admin.col_telemetry' }
            ];

            let totalDocs = 0;
            const breakdown = [];

            for (const col of collections) {
                try {
                    const count = await FirebaseService.countDocuments(col.name);
                    totalDocs += count;
                    breakdown.push({
                        ...col,
                        count: count
                    });
                } catch (e) {
                    breakdown.push({
                        ...col,
                        count: 0
                    });
                }
            }

            // Rough estimate: ~1KB per document average
            const estimatedSizeKB = totalDocs * 1;
            const estimatedSize = estimatedSizeKB > 1024 
                ? (estimatedSizeKB / 1024).toFixed(1) + ' MB'
                : estimatedSizeKB + ' KB';

            this.storageStats = {
                totalDocs,
                estimatedSize,
                breakdown
            };

            this.displayStorageStats(this.storageStats);
        } catch (error) {
            console.error('Error loading storage stats:', error);
            UIManager.showToast(t('msg.admin.failed_load_storage_stats'), 'error');
        } finally {
            UIManager.hideLoading();
        }
    },

    /**
     * Display storage statistics
     * @param {Object} stats - Storage stats
     */
    displayStorageStats(stats) {
        const container = document.getElementById('adminStorageStats');
        if (!container) return;

        container.innerHTML = `
            <div class="panel metrics admin-storage">
                <div class="metric">
                    <div class="metric-label">${tx('ui.admin.total_docs')}</div>
                    <div class="metric-value">${Helpers.escapeHtml(stats.totalDocs)}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">${tx('ui.admin.est_size')}</div>
                    <div class="metric-value">${Helpers.escapeHtml(stats.estimatedSize)}</div>
                </div>
            </div>
            <div class="panel admin-storage">
                ${stats.breakdown.map(col => `
                    <div class="row collection-item">
                        <span class="row-main">${tx(col.labelKey)}</span>
                        <span class="row-trail row-amt">${Helpers.escapeHtml(col.count)}</span>
                    </div>
                `).join('')}
            </div>
        `;
    },

    /**
     * Saves a JSON backup on this device: the share sheet on phones (so it can
     * go to Drive/WhatsApp), a normal download elsewhere.
     * @param {Object} backup
     * @param {string} filename
     * @returns {Promise<boolean>} true when the share sheet or download was started (the browser
     *   can't confirm the file was kept); false when sharing was cancelled, or in the Android app
     *   when sharing isn't available (its WebView drops downloads)
     */
    async saveJsonBackup(backup, filename) {
        return Exporter.saveBlob(new Blob([JSON.stringify(backup)], { type: 'application/json' }), filename, { quiet: true });
    },

    /**
     * Clear Data (owner only). Nothing is pre-selected; the owner sees how many
     * records will go and types DELETE; the JSON backup download/share is started
     * and the owner must confirm they saved the file before anything is deleted.
     * On the live data only LIVE_CLEARABLE_COLLECTIONS can be selected (#63).
     */
    async clearAllData() {
        if (AppState.userRole !== 'owner') {
            UIManager.showToast(t('msg.admin.only_owner_can_clear_data'));
            return;
        }
        // An Android app without the share plugins can't save the backup file (no Web Share, downloads dropped)
        if (window.Capacitor?.isNativePlatform?.() && !navigator.canShare && !Exporter.canShareNative()) {
            UIManager.showToast(t('msg.admin.clear_data_needs_website'));
            return;
        }
        const env = (window.getCollection && window.getCollection('x') !== 'x') ? 'dev' : 'prod';
        // Show collection selection modal
        const collections = [
            { id: 'purchases', name: t('ui.admin.col_purchases') },
            { id: 'retailSales', name: t('ui.admin.col_retail_sales') },
            { id: 'wholesaleSales', name: t('ui.admin.col_wholesale_sales') },
            { id: 'expenses', name: t('ui.admin.col_expenses') },
            { id: 'stockAdjustments', name: t('ui.admin.col_stock_adjustments') },
            { id: 'withdrawals', name: t('ui.admin.col_withdrawals') },
            { id: 'cashManagement', name: t('ui.admin.col_cash_management') },
            { id: 'autoSaves', name: t('ui.admin.col_auto_saves') },
            { id: 'drafts', name: t('ui.admin.col_drafts') },
            { id: 'itemFrequency', name: t('ui.admin.col_item_frequency') },
            { id: 'items', name: t('ui.admin.col_items'), risky: true },
            { id: 'users', name: t('ui.admin.col_users'), risky: true }
        ];
        const nameOf = (id) => collections.find(c => c.id === id)?.name || id;
        const clearable = collections.filter(c => canClearCollection(c.id, env));
        
        const modalHTML = `
            <div class="admin-clear">
                <p>${Helpers.escapeHtml(t('ui.admin.choose_what_delete'))}</p>
                <label class="admin-clear-all">
                    <input type="checkbox" id="selectAllCollections">
                    <span>${tx('ui.admin.select_all')}</span>
                </label>
                <div class="admin-clear-grid">
                    ${clearable.map(col => `
                        <label class="admin-clear-opt${col.risky ? ' tone-neg' : ''}">
                            <input type="checkbox" class="collection-checkbox" data-collection="${col.id}">
                            <span>${Helpers.escapeHtml(col.name)}${col.risky ? ` ${icon('alert', 'i-sm')}` : ''}</span>
                        </label>
                    `).join('')}
                </div>
                ${clearable.length < collections.length ? `<p class="notice">${icon('lock', 'i-sm')}<span class="grow">${tx(env === 'dev' ? 'ui.admin.bills_locked' : 'ui.admin.live_data_locked')}</span></p>` : ''}
            </div>
            <p class="notice neg admin-clear-warn">${icon('alert', 'i-sm')}<span class="grow">${tx('ui.admin.cannot_undo')}</span></p>
        `;
        
        // Setup select all handler after modal is shown
        setTimeout(() => {
            const selectAll = document.getElementById('selectAllCollections');
            if (selectAll) {
                selectAll.addEventListener('change', (e) => {
                    const checkboxes = document.querySelectorAll('.collection-checkbox');
                    checkboxes.forEach(cb => cb.checked = e.target.checked);
                });
            }
        }, 100);
        
        // Show modal and get selected collections before it closes
        let selectedCollections = [];
        
        const confirmed = await new Promise((resolve) => {
            UIManager.showModalWithHtml(modalHTML, t('msg.admin.clear_data'), true).then((result) => {
                if (result) {
                    // Capture checkbox values while modal content still exists
                    const checkboxes = document.querySelectorAll('.collection-checkbox:checked');
                    selectedCollections = Array.from(checkboxes).map(cb => cb.dataset.collection);
                }
                resolve(result);
            });
        });
        
        if (!confirmed) return;
        // Only what the list offered (the live business record is never in it)
        selectedCollections = selectedCollections.filter(id => clearable.some(c => c.id === id));
        
        if (selectedCollections.length === 0) {
            UIManager.showToast(t('msg.admin.no_collections_selected'));
            return;
        }
        
        // Read what will be deleted (also the backup content)
        const data = {};
        UIManager.showLoading();
        try {
            for (const collectionId of selectedCollections) {
                data[collectionId] = await FirebaseService.readCollectionForBackup(collectionId);
            }
        } catch (error) {
            console.error('Error reading data for backup:', error);
            UIManager.hideLoading();
            UIManager.showToast(t('msg.admin.could_not_read_data_backup'));
            return;
        }
        UIManager.hideLoading();
        const total = selectedCollections.reduce((n, id) => n + data[id].length, 0);
        
        const summary = selectedCollections
            .map(id => `<li>${Helpers.escapeHtml(nameOf(id))}: <strong>${Helpers.escapeHtml(data[id].length)}</strong></li>`)
            .join('');
        let typed = '';
        const finalConfirm = await new Promise((resolve) => {
            UIManager.showModalWithHtml(`
                <div class="admin-clear">
                    <p>${Helpers.escapeHtml(t('ui.admin.records_deleted_everyone'))}</p>
                    <ul class="admin-clear-list">${summary}</ul>
                    <p>${tx('ui.admin.total_label')} <strong>${Helpers.escapeHtml(total)}</strong>. ${tx('ui.admin.backup_note')}</p>
                    <div class="field">
                        <label for="clearDataConfirmInput">${t('ui.admin.type_word_to_confirm', { word: `<strong>${Helpers.escapeHtml(DELETE_CONFIRM_WORD)}</strong>` })}</label>
                        <input id="clearDataConfirmInput" class="input" type="text" autocomplete="off" autocapitalize="characters">
                    </div>
                </div>`, t('msg.admin.final_confirmation'), true).then((result) => {
                typed = document.getElementById('clearDataConfirmInput')?.value || '';
                resolve(result);
            });
        });
        
        if (!finalConfirm) return;
        if (!isDeleteConfirmed(typed)) {
            UIManager.showToast(t('msg.admin.must_type_nothing_was_deleted', { DELETE_CONFIRM_WORD }));
            return;
        }
        
        const backup = buildBackup(data, { env, exportedBy: AppState.currentUser?.uid || null });
        const backupOffered = await this.saveJsonBackup(backup, `aadhat_backup_${env}_${todayLocalISO()}_${Date.now()}.json`);
        if (!backupOffered) {
            UIManager.showToast(t('msg.admin.backup_not_saved_nothing_deleted'));
            return;
        }
        // The browser can't tell whether the file was kept: the owner ticks a box to confirm it
        // (a box, so a double tap on the previous dialog's OK can't confirm by accident)
        let backupTicked = false;
        // Let the click that closed the DELETE dialog finish before this one opens
        await new Promise(resolve => setTimeout(resolve, 0));
        const confirmedDialog = await UIManager.showModalWithHtml(`
            <div class="admin-clear">
                <p>${tx('msg.admin.confirm_backup_saved_text')}</p>
                <label class="admin-clear-all">
                    <input type="checkbox" id="clearDataBackupSaved">
                    <span>${tx('msg.admin.confirm_backup_saved_title')}</span>
                </label>
            </div>`, t('msg.admin.final_confirmation'), true).then((result) => {
            backupTicked = document.getElementById('clearDataBackupSaved')?.checked === true;
            return result;
        });
        const ownerConfirmedBackup = confirmedDialog === true && backupTicked;
        if (!ownerConfirmedBackup) {
            UIManager.showToast(t('msg.admin.backup_not_saved_nothing_deleted'));
            return;
        }
        
        UIManager.showLoading();
        
        try {
            // Audit first so the wipe is on record even if deleting fails midway
            await AuditService.log(AuditService.ACTIONS.CLEAR_DATA, {
                collections: selectedCollections,
                recordsToDelete: total,
                backupOffered,
                ownerConfirmedBackup
            });
            
            let deletedCount = 0;
            for (const collectionId of selectedCollections) {
                deletedCount += await FirebaseService.deleteDocsInBatches(collectionId, data[collectionId].map(d => d.id));
            }
            
            UIManager.hideLoading();
            UIManager.showToast(t('msg.admin.cleared_records_from_collections', { deletedCount, count: selectedCollections.length }));
            
            // Reload the page
            setTimeout(() => location.reload(), 1000);
            
        } catch (error) {
            console.error('Error clearing data:', error);
            UIManager.hideLoading();
            UIManager.showToast(t('msg.admin.error_clearing_data', { message: error.message }));
        }
    }
};
export { AdminManager };
