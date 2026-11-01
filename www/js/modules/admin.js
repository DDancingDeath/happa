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

        container.innerHTML = `
            <div class="filter-buttons" style="margin-bottom: 16px;">
                <button class="filter-btn ${this.activeTab === 'users' ? 'active' : ''}" 
                        onclick="window.app.admin.showTab('users')">
                    👥 ${tx('ui.admin.tab_users')}
                </button>
                <button class="filter-btn ${this.activeTab === 'data' ? 'active' : ''}" 
                        onclick="window.app.admin.showTab('data')">
                    📊 ${tx('ui.admin.tab_data')}
                </button>
                <button class="filter-btn admin-open-settings" type="button"
                        onclick="window.app.nav.showTab('settings-shop', event)">
                    ⚙️ ${tx('ui.admin.shop_settings_link')}
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
            <p class="admin-user-counts" id="adminUserCounts"></p>
            <div class="settings-card">
                <h3>${tx('ui.users.pending_registrations')}</h3>
                <p class="setting-description">${tx('ui.users.approve_new_users_and_assign')}</p>
                <div id="adminPendingUsers">
                    <p style="text-align: center; color: #888;">${tx('ui.navigation.loading')}</p>
                </div>
            </div>
            
            <div class="settings-card">
                <h3>${tx('ui.users.active_users')}</h3>
                <p class="setting-description">${tx('ui.users.manage_existing_user_roles')}</p>
                <div id="adminActiveUsers">
                    <p style="text-align: center; color: #888;">${tx('ui.navigation.loading')}</p>
                </div>
            </div>

            <div class="settings-card" id="adminRemovedCard" hidden>
                <h3>${tx('ui.admin.removed_users')}</h3>
                <p class="setting-description">${tx('ui.admin.removed_users_hint')}</p>
                <div id="adminRemovedUsers"></div>
            </div>

            <div class="settings-card" id="adminActivityCard">
                <h3>${tx('ui.admin.activity_title')}</h3>
                <p class="setting-description">${tx('ui.admin.activity_hint')}</p>
                <div class="filter-buttons" id="adminActivityRange">
                    ${ACTIVITY_RANGES.map(r => `<button type="button" class="filter-btn" data-range="${r}" onclick="window.app.admin.showActivity('${r}')">${tx(`ui.admin.range_${r}`)}</button>`).join('')}
                </div>
                <div id="adminActivity"></div>
            </div>
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
        container.innerHTML = users.map(user => `
            <div class="active-user-card">
                <div class="user-card-header">
                    <div>
                        <div class="user-name">${Helpers.escapeHtml(user.name || t('ui.reports.unknown'))}</div>
                        <div class="user-email">${Helpers.escapeHtml(user.email || '')}</div>
                    </div>
                    <span class="user-role-badge pending">${tx(user.status === 'rejected' ? 'ui.admin.status_rejected' : 'ui.admin.status_removed')}</span>
                </div>
                <div class="user-actions">
                    <button type="button" onclick="window.app.admin.restoreUser('${Helpers.escapeJsAttr(user.id)}', '${Helpers.escapeJsAttr(user.name || '')}')">
                        ↩️ ${tx('ui.admin.restore')}
                    </button>
                </div>
            </div>
        `).join('');
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
        document.querySelectorAll('#adminActivityRange [data-range]').forEach(b => b.classList.toggle('active', b.dataset.range === range));
        host.innerHTML = `<p style="text-align: center; color: #888;">${tx('ui.navigation.loading')}</p>`;
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
        const noteHtml = notes.map(n => `<p class="setting-description">${Helpers.escapeHtml(n)}</p>`).join('');
        if (!rows.length) {
            host.innerHTML = `${noteHtml}<p class="setting-description">${tx('ui.admin.activity_none')}</p>`;
            return;
        }
        const cell = (v) => `<td style="text-align:right">${Helpers.escapeHtml(String(v))}</td>`;
        host.innerHTML = `${noteHtml}
            <div class="table-scroll"><table class="admin-activity-table" style="width:100%;font-size:13px;border-collapse:collapse;">
                <thead><tr><th style="text-align:left">${tx('ui.admin.col_person')}</th><th style="text-align:right">${tx('ui.admin.col_bills')}</th>
                    <th style="text-align:right">${tx('ui.admin.col_bill_total')}</th><th style="text-align:right">${tx('ui.admin.col_payments')}</th>
                    <th style="text-align:right">${tx('ui.admin.col_edits')}</th><th style="text-align:right">${tx('ui.admin.col_voids')}</th>
                    <th style="text-align:right">${tx('ui.admin.col_last_active')}</th></tr></thead>
                <tbody>${rows.map(r => `<tr data-uid="${Helpers.escapeHtml(r.uid)}"><td>${Helpers.escapeHtml(names.get(r.uid) || t('ui.reports.unknown'))}</td>`
                    + cell(r.bills) + cell(Helpers.formatCurrency(r.billTotal)) + cell(r.payments) + cell(r.edits) + cell(r.voids)
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
            container.innerHTML = `
                <div class="admin-empty">
                    <span class="admin-empty-icon">✅</span>
                    <p>${tx('ui.admin.no_pending')}</p>
                </div>
            `;
            return;
        }

        container.innerHTML = users.map(user => `
            <div class="pending-user-card">
                <div class="user-card-header">
                    <div>
                        <div class="user-name">${Helpers.escapeHtml(user.name || t('ui.reports.unknown'))}</div>
                        <div class="user-email">${Helpers.escapeHtml(user.email)}</div>
                    </div>
                    <span class="user-role-badge pending">${tx('ui.admin.pending')}</span>
                </div>
                <div class="user-actions">
                    <select id="role-${Helpers.escapeHtml(user.id)}">
                        <option value="staff">${Helpers.escapeHtml(Helpers.roleLabel('staff'))}</option>
                        <option value="manager">${Helpers.escapeHtml(Helpers.roleLabel('manager'))}</option>
                    </select>
                    <button class="btn-approve" onclick="window.app.admin.approveUser('${Helpers.escapeJsAttr(user.id)}')">
                        ✓ ${tx('ui.admin.approve')}
                    </button>
                    <button class="btn-reject" onclick="window.app.admin.rejectUser('${Helpers.escapeJsAttr(user.id)}')">
                        ✕ ${tx('ui.admin.reject')}
                    </button>
                </div>
            </div>
        `).join('');
    },

    /**
     * Render active users list
     * @param {Array} users - Active users
     */
    renderActiveUsers(users) {
        const container = document.getElementById('adminActiveUsers');
        if (!container) return;

        if (users.length === 0) {
            container.innerHTML = `
                <div class="admin-empty">
                    <span class="admin-empty-icon">👤</span>
                    <p>${tx('ui.admin.no_active_users')}</p>
                </div>
            `;
            return;
        }

        const currentUserId = AppState.currentUser?.uid;

        container.innerHTML = users.map(user => {
            const isCurrentUser = user.id === currentUserId;
            const safeName = Helpers.escapeJsAttr(user.name || '');
            const safeEmail = Helpers.escapeJsAttr(user.email || '');
            
            return `
            <div class="active-user-card">
                <div class="user-card-header">
                    <div>
                        <div class="user-name">${Helpers.escapeHtml(user.name || t('ui.reports.unknown'))} ${isCurrentUser ? `<span style="color: #999; font-size: 12px;">${tx('ui.admin.you')}</span>` : ''}</div>
                        <div class="user-email">${Helpers.escapeHtml(user.email)}</div>
                    </div>
                    <span class="user-role-badge ${Helpers.escapeHtml(user.role)}">${Helpers.escapeHtml(Helpers.roleLabel(user.role))}</span>
                </div>
                ${!isCurrentUser ? `
                <div class="user-actions" style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px;">
                    <button onclick="window.app.admin.showChangeRole('${Helpers.escapeJsAttr(user.id)}', '${safeName}', '${Helpers.escapeJsAttr(user.role)}')" style="flex: 1; min-width: 80px; padding: 8px 12px; background: #f7fafc; border: 1px solid #e0e0e0; border-radius: 8px; cursor: pointer; font-size: 13px;">
                        ✏️ ${tx('ui.admin.edit_role')}
                    </button>
                    <button onclick="window.app.admin.resetUserPassword('${Helpers.escapeJsAttr(user.id)}', '${safeEmail}')" style="flex: 1; min-width: 80px; padding: 8px 12px; background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; cursor: pointer; font-size: 13px; color: #92400e;">
                        🔑 ${tx('ui.admin.reset_password')}
                    </button>
                    <button onclick="window.app.admin.deleteUser('${Helpers.escapeJsAttr(user.id)}', '${safeName}')" style="flex: 1; min-width: 80px; padding: 8px 12px; background: #fee2e2; border: 1px solid #ef4444; border-radius: 8px; cursor: pointer; font-size: 13px; color: #991b1b;">
                        🗑️ ${tx('ui.modals.delete')}
                    </button>
                </div>
                ` : ''}
            </div>
        `}).join('');
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
            true
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
            <div class="settings-card">
                <h3>📊 ${tx('ui.admin.storage_title')}</h3>
                <p class="setting-description">${tx('ui.admin.storage_hint')}</p>
                <button class="add-item-btn" onclick="window.app.admin.loadStorageStats()" style="padding: 8px 16px; margin-bottom: 12px;">
                    🔄 ${tx('ui.admin.storage_calc')}
                </button>
                <div id="adminStorageStats"></div>
            </div>

            <div class="settings-card" id="adminBackupCheck">
                <h3>🗄️ ${tx('ui.backup.title')}</h3>
                <p class="setting-description">${tx('ui.backup.hint')}</p>
                <label class="add-item-btn backup-pick" style="display: inline-block; padding: 8px 16px; margin-bottom: 12px; cursor: pointer;">
                    📂 ${tx('ui.backup.pick')}
                    <input type="file" id="adminBackupFile" accept=".json,.gz,application/json,application/gzip" hidden onchange="window.app.admin.checkBackupFile(this.files && this.files[0]); this.value = ''">
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
                    <p class="setting-description">${tx('ui.backup.restore_note')}</p>
                </details>
            </div>

            <div class="settings-card danger-zone">
                <h4>⚠️ ${tx('ui.admin.danger_zone')}</h4>
                <p>${tx('ui.admin.danger_hint')}</p>
                <button class="danger-btn" onclick="window.app.admin.clearAllData()">
                    🗑️ ${tx('ui.admin.clear_all')}
                </button>
            </div>
        `;

        // If we have cached stats, show them
        if (this.storageStats) {
            this.displayStorageStats(this.storageStats);
        }
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
            return `<div class="backup-result backup-bad" data-backup-ok="false"><p><strong>✗ ${e(t('ui.backup.bad'))}</strong></p><ul>${items}</ul>${more}</div>`;
        }
        const rows = [...r.collections, ...r.subcollections].map(c => `<tr><td lang="en" translate="no">${e(c.name)}</td><td style="text-align:right">${e(c.docs.toLocaleString('en-IN'))}</td></tr>`).join('');
        const lines = [
            t('ui.backup.good_docs', { docs: r.totalDocs.toLocaleString('en-IN'), collections: r.collections.length }),
            r.exportedAt ? t('ui.backup.good_saved', { when: formatDayTime(r.exportedAt, { lang }), days: r.ageDays }) : '',
            r.newestBillAt ? t('ui.backup.good_newest', { when: formatDay(r.newestBillAt, { lang }) }) : ''
        ].filter(Boolean);
        return `<div class="backup-result backup-good" data-backup-ok="true"><p><strong>✓ ${e(t('ui.backup.good'))}</strong></p>`
            + lines.map(l => `<p>${e(l)}</p>`).join('')
            + (r.ageDays > 2 ? `<p class="backup-warn">⚠️ ${e(t('ui.backup.old', { days: r.ageDays }))}</p>` : '')
            + `<details><summary>${e(t('ui.backup.counts'))}</summary><table class="backup-counts" style="width:100%;font-size:13px">${rows}</table></details></div>`;
    },

    /**
     * Load storage statistics
     */
    async loadStorageStats() {
        try {
            UIManager.showLoading();
            
            const collections = [
                { name: 'items', labelKey: 'ui.admin.col_items', icon: '📦' },
                { name: 'purchases', labelKey: 'ui.admin.col_purchases', icon: '📥' },
                { name: 'retailSales', labelKey: 'ui.admin.col_retail_sales', icon: '🛒' },
                { name: 'wholesaleSales', labelKey: 'ui.admin.col_wholesale_sales', icon: '📤' },
                { name: 'expenses', labelKey: 'ui.admin.col_expenses', icon: '💳' },
                { name: 'stockAdjustments', labelKey: 'ui.admin.col_stock_adjustments', icon: '📊' },
                { name: 'withdrawals', labelKey: 'ui.admin.col_withdrawals', icon: '💸' },
                { name: 'cashManagement', labelKey: 'ui.admin.col_cash_management', icon: '💰' },
                { name: 'users', labelKey: 'ui.admin.col_users', icon: '👥' },
                { name: 'auditLogs', labelKey: 'ui.admin.col_audit_logs', icon: '📋' },
                { name: 'telemetry', labelKey: 'ui.admin.col_telemetry', icon: '🔬' }
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
            <div class="storage-grid">
                <div class="storage-stat-card">
                    <div class="storage-stat-value">${Helpers.escapeHtml(stats.totalDocs)}</div>
                    <div class="storage-stat-label">${tx('ui.admin.total_docs')}</div>
                </div>
                <div class="storage-stat-card">
                    <div class="storage-stat-value">${Helpers.escapeHtml(stats.estimatedSize)}</div>
                    <div class="storage-stat-label">${tx('ui.admin.est_size')}</div>
                </div>
            </div>
            <div style="background: var(--light-bg, #f5f5f5); border-radius: 8px; padding: 12px;">
                ${stats.breakdown.map(col => `
                    <div class="collection-item">
                        <span class="collection-name">
                            <span>${Helpers.escapeHtml(col.icon)}</span>
                            <span>${tx(col.labelKey)}</span>
                        </span>
                        <span class="collection-count">${Helpers.escapeHtml(col.count)}</span>
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
            { id: 'items', name: t('ui.admin.col_items') + ' ⚠️' },
            { id: 'users', name: t('ui.admin.col_users') + ' ⚠️' }
        ];
        const nameOf = (id) => collections.find(c => c.id === id)?.name || id;
        const clearable = collections.filter(c => canClearCollection(c.id, env));
        
        const modalHTML = `
            <div style="text-align: left;">
                <p style="margin: 0 0 8px; font-size: 13px;">${Helpers.escapeHtml(t('ui.admin.choose_what_delete'))}:</p>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-weight: bold; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 2px solid #ddd;">
                    <input type="checkbox" id="selectAllCollections" style="width: 16px; height: 16px;">
                    <span style="font-size: 14px;">${tx('ui.admin.select_all')}</span>
                </label>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px;">
                    ${clearable.map(col => `
                        <label style="display: flex; align-items: center; gap: 6px; padding: 3px 0; cursor: pointer;">
                            <input type="checkbox" class="collection-checkbox" data-collection="${col.id}" style="width: 14px; height: 14px;">
                            <span style="font-size: 13px; ${col.id === 'items' || col.id === 'users' ? 'color: #e74c3c;' : ''}">${Helpers.escapeHtml(col.name)}</span>
                        </label>
                    `).join('')}
                </div>
                ${clearable.length < collections.length ? `<p style="margin: 10px 0 0; font-size: 12px; color: #555;">🔒 ${tx('ui.admin.live_data_locked')}</p>` : ''}
            </div>
            <p style="color: #e74c3c; margin-top: 10px; font-size: 12px; text-align: center;">⚠️ ${tx('ui.admin.cannot_undo')}</p>
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
                <div style="text-align: left;">
                    <p style="margin: 0 0 6px;">${Helpers.escapeHtml(t('ui.admin.records_deleted_everyone'))}:</p>
                    <ul style="margin: 0 0 8px 16px; font-size: 13px;">${summary}</ul>
                    <p style="margin: 0 0 6px; font-size: 13px;">${tx('ui.admin.total_label')} <strong>${Helpers.escapeHtml(total)}</strong>. ${tx('ui.admin.backup_note')}</p>
                    <label for="clearDataConfirmInput" style="font-size: 13px;">${t('ui.admin.type_word_to_confirm', { word: `<strong>${Helpers.escapeHtml(DELETE_CONFIRM_WORD)}</strong>` })}:</label>
                    <input id="clearDataConfirmInput" type="text" autocomplete="off" autocapitalize="characters" style="width: 100%; padding: 8px; margin-top: 4px; border: 2px solid #e74c3c; border-radius: 6px;">
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
            <div style="text-align: left;">
                <p style="margin: 0 0 10px; font-size: 13px;">${tx('msg.admin.confirm_backup_saved_text')}</p>
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: bold;">
                    <input type="checkbox" id="clearDataBackupSaved" style="width: 18px; height: 18px;">
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
