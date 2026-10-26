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
import { todayLocalISO } from '../utils/dates.js';
import { buildBackup, isDeleteConfirmed, DELETE_CONFIRM_WORD } from '../utils/data-export.js';
import { t } from '../i18n/index.js';
import { UserAdmin, isDisabledProfile } from '../services/user-admin.js';

const tx = (key, params) => Helpers.escapeHtml(t(key, params));

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
            
            users.forEach(user => {
                if (isDisabledProfile(user)) return;
                // Match logic from users.js: pending if status is pending OR no role assigned
                if (user.status === 'pending' || !user.role) {
                    pendingUsers.push(user);
                } else {
                    activeUsers.push(user);
                }
            });

            this.renderPendingUsers(pendingUsers);
            this.renderActiveUsers(activeUsers);
        } catch (error) {
            console.error('Error loading users:', error);
            UIManager.showToast(t('msg.common.failed_load_users'), 'error');
        }
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
        const confirmed = await UIManager.showModal(
            t('msg.admin.are_sure_want_reject_user'),
            t('msg.admin.reject_user'),
            true
        );
        if (!confirmed) return;

        try {
            UIManager.showLoading();
            await FirebaseService.deleteUserProfile(userId);

            UIManager.showToast(t('msg.admin.user_rejected'));
            await this.loadUsers();
        } catch (error) {
            console.error('Error rejecting user:', error);
            UIManager.showToast(t('msg.common.failed_reject_user'), 'error');
        } finally {
            UIManager.hideLoading();
        }
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
     * @returns {Promise<boolean>} false when the user cancelled sharing
     */
    async saveJsonBackup(backup, filename) {
        const json = JSON.stringify(backup);
        const blob = new Blob([json], { type: 'application/json' });
        if (typeof File !== 'undefined' && navigator.canShare) {
            const file = new File([blob], filename, { type: 'application/json' });
            if (navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({ files: [file], title: filename });
                    return true;
                } catch (e) {
                    if (e?.name === 'AbortError') return false;
                    console.warn('Share failed, falling back to download:', e);
                }
            }
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return true;
    },

    /**
     * Clear Data (owner only). Nothing is pre-selected; the owner sees how many
     * records will go, a JSON backup of the selected collections is saved
     * first, and deletion needs the word DELETE typed in.
     */
    async clearAllData() {
        if (AppState.userRole !== 'owner') {
            UIManager.showToast(t('msg.admin.only_owner_can_clear_data'));
            return;
        }
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
        
        const modalHTML = `
            <div style="text-align: left;">
                <p style="margin: 0 0 8px; font-size: 13px;">${Helpers.escapeHtml(t('ui.admin.choose_what_delete'))}:</p>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-weight: bold; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 2px solid #ddd;">
                    <input type="checkbox" id="selectAllCollections" style="width: 16px; height: 16px;">
                    <span style="font-size: 14px;">${tx('ui.admin.select_all')}</span>
                </label>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px;">
                    ${collections.map((col, i) => `
                        <label style="display: flex; align-items: center; gap: 6px; padding: 3px 0; cursor: pointer;">
                            <input type="checkbox" class="collection-checkbox" data-collection="${col.id}" style="width: 14px; height: 14px;">
                            <span style="font-size: 13px; ${i >= 10 ? 'color: #e74c3c;' : ''}">${Helpers.escapeHtml(col.name)}</span>
                        </label>
                    `).join('')}
                </div>
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
        
        const env = (window.getCollection && window.getCollection('x') !== 'x') ? 'dev' : 'prod';
        const backup = buildBackup(data, { env, exportedBy: AppState.currentUser?.uid || null });
        const saved = await this.saveJsonBackup(backup, `aadhat_backup_${env}_${todayLocalISO()}_${Date.now()}.json`);
        if (!saved) {
            const goAhead = await UIManager.showModal(
                t('msg.admin.backup_was_not_saved_delete'),
                t('msg.admin.no_backup'),
                true
            );
            if (!goAhead) return;
        }
        
        UIManager.showLoading();
        
        try {
            // Audit first so the wipe is on record even if deleting fails midway
            await AuditService.log(AuditService.ACTIONS.CLEAR_DATA, {
                collections: selectedCollections,
                recordsToDelete: total,
                backupSaved: saved
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
