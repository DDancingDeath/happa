/**
 * @fileoverview Admin Manager - Unified admin panel for Configure, Users, and Data management
 * Owner-only access to system configuration
 * @module modules/admin
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
import { todayLocalISO } from '../utils/dates.js';
import { buildBackup, isDeleteConfirmed, DELETE_CONFIRM_WORD } from '../utils/data-export.js';
import { normalizeLabourSettings } from '../utils/money.js';
import { DEFAULT_THRESHOLDS, normalizeThresholds } from '../utils/bill-checks.js';
import { SettingsManager } from './settings.js';
import { t } from '../i18n/index.js';

/**
 * Admin Manager - Unified admin panel
 * @namespace AdminManager
 */
/** Bill-check limits editable in Admin → Configure (keys of DEFAULT_THRESHOLDS). */
const CHECK_THRESHOLD_FIELDS = [
    ['oversellBlockKg', 'ui.checks.oversell_block'],
    ['rateMultiple', 'ui.checks.rate_multiple'],
    ['duplicateWindowSec', 'ui.checks.duplicate_window'],
    ['maxFutureMin', 'ui.checks.max_future'],
    ['backdateDays', 'ui.checks.backdate_days'],
    ['cashOkRs', 'ui.checks.cash_ok'],
    ['cashHighRs', 'ui.checks.cash_high'],
    ['stockAdjustFlagKg', 'ui.checks.stock_adjust_flag']
];

const AdminManager = {
    /**
     * Current active tab
     * @type {string}
     */
    activeTab: 'configure',

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
                <button class="filter-btn ${this.activeTab === 'configure' ? 'active' : ''}" 
                        onclick="window.app.admin.showTab('configure')">
                    🔧 Configure
                </button>
                <button class="filter-btn ${this.activeTab === 'users' ? 'active' : ''}" 
                        onclick="window.app.admin.showTab('users')">
                    👥 Users
                </button>
                <button class="filter-btn ${this.activeTab === 'data' ? 'active' : ''}" 
                        onclick="window.app.admin.showTab('data')">
                    📊 Data
                </button>
            </div>
        `;
    },

    /**
     * Switch tab
     * @param {string} tab - Tab name
     */
    showTab(tab) {
        this.activeTab = tab;
        this.renderTabs();
        this.renderContent();
    },

    /**
     * Render content based on active tab
     */
    renderContent() {
        switch (this.activeTab) {
            case 'configure':
                this.renderConfigure();
                break;
            case 'users':
                this.renderUsers();
                break;
            case 'data':
                this.renderData();
                break;
        }
    },

    /**
     * Render Configure tab
     */
    renderConfigure() {
        const container = document.getElementById('adminContainer');
        if (!container) return;

        // Same shared values billing uses (#21): settings/app via AppState.settings
        const { heavyWeightThreshold: heavyWeight, laborRate } = normalizeLabourSettings(AppState.settings);
        const autoLabor = AppState.settings?.autoLaborEnabled !== false;

        container.innerHTML = `
            <div class="settings-card">
                <h3>Labor Charges</h3>
                
                <label>Heavy Packet Weight Threshold (kg):</label>
                <input type="number" inputmode="decimal" id="adminHeavyWeight" 
                       placeholder="30" value="${Helpers.escapeHtml(heavyWeight)}" 
                       onchange="window.app.admin.saveConfigure()" />
                <p class="setting-description">Packets above this weight will incur labor charges</p>

                <label>Labor Charge per Heavy Packet (₹):</label>
                <input type="number" inputmode="decimal" id="adminLaborRate" 
                       placeholder="6" value="${Helpers.escapeHtml(laborRate)}" 
                       onchange="window.app.admin.saveConfigure()" />
                <p class="setting-description">Amount charged for each heavy packet</p>

                <label class="checkbox-label">
                    <input type="checkbox" id="adminAutoLabor" 
                           ${autoLabor ? 'checked' : ''} 
                           onchange="window.app.admin.saveConfigure()">
                    <span>Enable automatic labor charges by default</span>
                </label>
            </div>
            ${this.renderCheckThresholds()}
        `;
    },

    /**
     * Bill-check limits card (#37): shop-wide, blank = default.
     * @returns {string}
     */
    renderCheckThresholds() {
        const vals = normalizeThresholds(AppState.settings?.checkThresholds);
        const rows = CHECK_THRESHOLD_FIELDS.map(([key, label]) => `
                <label for="adminCheck_${key}">${Helpers.escapeHtml(t(label))}</label>
                <input type="number" inputmode="decimal" min="0" step="any" id="adminCheck_${key}"
                       placeholder="${Helpers.escapeHtml(DEFAULT_THRESHOLDS[key])}" value="${Helpers.escapeHtml(vals[key])}"
                       onchange="window.app.admin.saveCheckThresholds()" />`).join('');
        return `
            <div class="settings-card">
                <h3>${Helpers.escapeHtml(t('ui.checks.title'))}</h3>
                <p class="setting-description">${Helpers.escapeHtml(t('ui.checks.description'))}</p>
                ${rows}
            </div>`;
    },

    /**
     * Save the bill-check limits for everyone (owner only).
     * @returns {Promise<boolean>}
     */
    async saveCheckThresholds() {
        if (AppState.userRole !== 'owner') return false;
        const typed = {};
        CHECK_THRESHOLD_FIELDS.forEach(([key]) => { typed[key] = document.getElementById(`adminCheck_${key}`)?.value; });
        const next = normalizeThresholds(typed);
        AppState.settings.checkThresholds = next;
        localStorage.setItem('settings', JSON.stringify(AppState.settings));
        CHECK_THRESHOLD_FIELDS.forEach(([key]) => {
            const input = document.getElementById(`adminCheck_${key}`);
            if (input) input.value = next[key];
        });
        try {
            await FirebaseService.saveSharedCheckThresholds(next);
            UIManager.showToast(t('msg.admin.settings_saved_everyone'));
            return true;
        } catch (error) {
            console.error('Saving bill-check limits failed:', error);
            UIManager.showToast(t('msg.admin.not_saved_everyone_check_internet'));
            return false;
        }
    },

    /**
     * Save configure settings
     */
    async saveConfigure() {
        const autoLabor = document.getElementById('adminAutoLabor');
        if (autoLabor) {
            AppState.settings.autoLaborEnabled = autoLabor.checked;
            localStorage.setItem('settings', JSON.stringify(AppState.settings));
            const settingAutoLabor = document.getElementById('settingAutoLabor');
            if (settingAutoLabor) settingAutoLabor.checked = autoLabor.checked;
        }

        // Same save path as Settings: one shared value for billing on every device (#21)
        const saved = await SettingsManager.saveLabourSettings({
            laborRate: document.getElementById('adminLaborRate')?.value,
            heavyWeightThreshold: document.getElementById('adminHeavyWeight')?.value
        });
        const { heavyWeightThreshold, laborRate } = normalizeLabourSettings(AppState.settings);
        const heavyInput = document.getElementById('adminHeavyWeight');
        const rateInput = document.getElementById('adminLaborRate');
        if (heavyInput) heavyInput.value = heavyWeightThreshold;
        if (rateInput) rateInput.value = laborRate;

        if (saved) UIManager.showToast(t('msg.admin.settings_saved_everyone'));
        return saved;
    },

    /**
     * Render Users tab
     */
    async renderUsers() {
        const container = document.getElementById('adminContainer');
        if (!container) return;

        container.innerHTML = `
            <div class="settings-card">
                <h3>Pending Registrations</h3>
                <p class="setting-description">Approve new users and assign their roles</p>
                <div id="adminPendingUsers">
                    <p style="text-align: center; color: #888;">Loading...</p>
                </div>
            </div>
            
            <div class="settings-card">
                <h3>Active Users</h3>
                <p class="setting-description">Manage existing user roles</p>
                <div id="adminActiveUsers">
                    <p style="text-align: center; color: #888;">Loading...</p>
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
                    <p>No pending registrations</p>
                </div>
            `;
            return;
        }

        container.innerHTML = users.map(user => `
            <div class="pending-user-card">
                <div class="user-card-header">
                    <div>
                        <div class="user-name">${Helpers.escapeHtml(user.name || 'Unknown')}</div>
                        <div class="user-email">${Helpers.escapeHtml(user.email)}</div>
                    </div>
                    <span class="user-role-badge pending">Pending</span>
                </div>
                <div class="user-actions">
                    <select id="role-${Helpers.escapeHtml(user.id)}">
                        <option value="staff">Member</option>
                        <option value="manager">Manager</option>
                    </select>
                    <button class="btn-approve" onclick="window.app.admin.approveUser('${Helpers.escapeJsAttr(user.id)}')">
                        ✓ Approve
                    </button>
                    <button class="btn-reject" onclick="window.app.admin.rejectUser('${Helpers.escapeJsAttr(user.id)}')">
                        ✕ Reject
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
                    <p>No active users</p>
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
                        <div class="user-name">${Helpers.escapeHtml(user.name || 'Unknown')} ${isCurrentUser ? '<span style="color: #999; font-size: 12px;">(You)</span>' : ''}</div>
                        <div class="user-email">${Helpers.escapeHtml(user.email)}</div>
                    </div>
                    <span class="user-role-badge ${Helpers.escapeHtml(user.role)}">${Helpers.escapeHtml(Helpers.roleLabel(user.role))}</span>
                </div>
                ${!isCurrentUser ? `
                <div class="user-actions" style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px;">
                    <button onclick="window.app.admin.showChangeRole('${Helpers.escapeJsAttr(user.id)}', '${safeName}', '${Helpers.escapeJsAttr(user.role)}')" style="flex: 1; min-width: 80px; padding: 8px 12px; background: #f7fafc; border: 1px solid #e0e0e0; border-radius: 8px; cursor: pointer; font-size: 13px;">
                        ✏️ Edit Role
                    </button>
                    <button onclick="window.app.admin.resetUserPassword('${Helpers.escapeJsAttr(user.id)}', '${safeEmail}')" style="flex: 1; min-width: 80px; padding: 8px 12px; background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; cursor: pointer; font-size: 13px; color: #92400e;">
                        🔑 Reset Password
                    </button>
                    <button onclick="window.app.admin.deleteUser('${Helpers.escapeJsAttr(user.id)}', '${safeName}')" style="flex: 1; min-width: 80px; padding: 8px 12px; background: #fee2e2; border: 1px solid #ef4444; border-radius: 8px; cursor: pointer; font-size: 13px; color: #991b1b;">
                        🗑️ Delete
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
     * Send password reset email to a user
     * @param {string} userId - User document ID
     * @param {string} email - User's email address
     */
    async resetUserPassword(userId, email) {
        const confirmed = await UIManager.showModal(
            t('msg.common.send_password_reset_email', { email }),
            t('msg.common.reset_password'),
            true
        );
        
        if (!confirmed) return;
        
        try {
            UIManager.showLoading();
            await firebase.auth().sendPasswordResetEmail(email);
            UIManager.showToast(t('msg.common.password_reset_email_sent', { email }));
        } catch (error) {
            console.error('Error sending reset email:', error);
            UIManager.showToast(t('msg.common.failed_send_reset_email', { message: error.message }), 'error');
        } finally {
            UIManager.hideLoading();
        }
    },

    /**
     * Delete a user from the system
     * @param {string} userId - User document ID
     * @param {string} userName - User's display name
     */
    async deleteUser(userId, userName) {
        const confirmed = await UIManager.showModal(
            t('msg.common.are_sure_want_delete_user', { userName }),
            t('msg.common.delete_user'),
            true
        );
        
        if (!confirmed) return;
        
        try {
            UIManager.showLoading();
            // Delete user document from Firestore
            await FirebaseService.deleteUserProfile(userId);
            
            UIManager.showToast(t('msg.common.user_has_been_deleted', { userName }));
            await this.loadUsers();
        } catch (error) {
            console.error('Error deleting user:', error);
            UIManager.showToast(t('msg.common.failed_delete_user', { message: error.message }), 'error');
        } finally {
            UIManager.hideLoading();
        }
    },

    /**
     * Render Data tab
     */
    renderData() {
        const container = document.getElementById('adminContainer');
        if (!container) return;

        container.innerHTML = `
            <div class="settings-card">
                <h3>📊 Storage Usage</h3>
                <p class="setting-description">View database storage statistics</p>
                <button class="add-item-btn" onclick="window.app.admin.loadStorageStats()" style="padding: 8px 16px; margin-bottom: 12px;">
                    🔄 Calculate Storage
                </button>
                <div id="adminStorageStats"></div>
            </div>

            <div class="settings-card danger-zone">
                <h4>⚠️ Danger Zone</h4>
                <p>Permanently delete all business data. This cannot be undone!</p>
                <button class="danger-btn" onclick="window.app.admin.clearAllData()">
                    🗑️ Clear All Data
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
                { name: 'items', label: 'Items', icon: '📦' },
                { name: 'purchases', label: 'Purchases', icon: '📥' },
                { name: 'retailSales', label: 'Retail Sales', icon: '🛒' },
                { name: 'wholesaleSales', label: 'Wholesale Sales', icon: '📤' },
                { name: 'expenses', label: 'Expenses', icon: '💳' },
                { name: 'stockAdjustments', label: 'Stock Adjustments', icon: '📊' },
                { name: 'withdrawals', label: 'Withdrawals', icon: '💸' },
                { name: 'cashManagement', label: 'Cash Management', icon: '💰' },
                { name: 'users', label: 'Users', icon: '👥' },
                { name: 'auditLogs', label: 'Audit Logs', icon: '📋' },
                { name: 'telemetry', label: 'Telemetry', icon: '🔬' }
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
                    <div class="storage-stat-label">Total Documents</div>
                </div>
                <div class="storage-stat-card">
                    <div class="storage-stat-value">${Helpers.escapeHtml(stats.estimatedSize)}</div>
                    <div class="storage-stat-label">Estimated Size</div>
                </div>
            </div>
            <div style="background: var(--light-bg, #f5f5f5); border-radius: 8px; padding: 12px;">
                ${stats.breakdown.map(col => `
                    <div class="collection-item">
                        <span class="collection-name">
                            <span>${Helpers.escapeHtml(col.icon)}</span>
                            <span>${Helpers.escapeHtml(col.label)}</span>
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
            { id: 'purchases', name: 'Purchases' },
            { id: 'retailSales', name: 'Retail Sales' },
            { id: 'wholesaleSales', name: 'Wholesale Sales' },
            { id: 'expenses', name: 'Expenses' },
            { id: 'stockAdjustments', name: 'Stock Adj.' },
            { id: 'withdrawals', name: 'Withdrawals' },
            { id: 'cashManagement', name: 'Cash Mgmt' },
            { id: 'autoSaves', name: 'Auto Saves' },
            { id: 'drafts', name: 'Drafts' },
            { id: 'itemFrequency', name: 'Item Freq.' },
            { id: 'items', name: 'Items ⚠️' },
            { id: 'users', name: 'Users ⚠️' }
        ];
        const nameOf = (id) => collections.find(c => c.id === id)?.name || id;
        
        const modalHTML = `
            <div style="text-align: left;">
                <p style="margin: 0 0 8px; font-size: 13px;">${Helpers.escapeHtml(t('ui.admin.choose_what_delete'))}:</p>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-weight: bold; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 2px solid #ddd;">
                    <input type="checkbox" id="selectAllCollections" style="width: 16px; height: 16px;">
                    <span style="font-size: 14px;">Select All</span>
                </label>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px;">
                    ${collections.map((col, i) => `
                        <label style="display: flex; align-items: center; gap: 6px; padding: 3px 0; cursor: pointer;">
                            <input type="checkbox" class="collection-checkbox" data-collection="${col.id}" style="width: 14px; height: 14px;">
                            <span style="font-size: 13px; ${i >= 10 ? 'color: #e74c3c;' : ''}">${col.name}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
            <p style="color: #e74c3c; margin-top: 10px; font-size: 12px; text-align: center;">⚠️ Cannot be undone! A backup file is saved first.</p>
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
                    <p style="margin: 0 0 6px; font-size: 13px;">Total: <strong>${Helpers.escapeHtml(total)}</strong>. A backup file (JSON) is saved on this device first.</p>
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
