/**
 * @fileoverview User Management Module
 * Handles user registration, approval, role management, and access control
 * Owner-only functionality for managing staff and managers
 * @module modules/users
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { t } from '../i18n/index.js';

const tx = (key, params) => Helpers.escapeHtml(t(key, params));

/**
 * Users Manager - Manages user operations
 * @class UsersManager
 */
export class UsersManager {
    /**
     * Load all users from Firebase
     * Separates into pending and active users
     * @async
     * @returns {Promise<void>}
     */
    static async loadUsers() {
        const userRole = AppState.userRole;
        if (userRole !== 'owner') return;
        
        try {
            const users = await FirebaseService.loadUsers();
            
            const pendingUsers = [];
            const activeUsers = [];
            
            users.forEach(userData => {
                if (userData.status === 'pending' || !userData.role) {
                    pendingUsers.push(userData);
                } else {
                    activeUsers.push(userData);
                }
            });
            
            this.renderPendingUsers(pendingUsers);
            this.renderActiveUsers(activeUsers);
        } catch (error) {
            console.error('Error loading users:', error);
            UIManager.showToast(t('msg.common.failed_load_users'));
        }
    }

    /**
     * Render list of pending user registrations
     * @param {Array<Object>} users - Array of pending user objects
     */
    static renderPendingUsers(users) {
        const container = document.getElementById('pendingUsersList');
        if (!container) return;
        
        if (users.length === 0) {
            container.innerHTML = `<p style="color: #666; padding: 16px; text-align: center;">${tx('ui.admin.no_pending')}</p>`;
            return;
        }
        
        container.innerHTML = users.map(user => `
            <div style="background: #fff; border: 1px solid #e0e0e0; border-radius: 12px; padding: 16px; margin-bottom: 12px;">
                <div style="margin-bottom: 12px;">
                    <strong style="font-size: 16px;">${Helpers.escapeHtml(user.name)}</strong>
                    <p style="color: #666; margin: 4px 0;">${Helpers.escapeHtml(user.email)}</p>
                    <p style="color: #999; font-size: 12px;">${tx('ui.users.registered', { date: user.createdAt ? new Date(user.createdAt.toDate()).toLocaleDateString('en-IN') : t('ui.users.recently') })}</p>
                </div>
                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                    <button onclick="window.app.users.approveUser('${Helpers.escapeJsAttr(user.id)}', 'owner')" style="flex: 1; min-width: 100px; padding: 8px 16px; background: #667eea; color: white; border: none; border-radius: 8px; cursor: pointer;">
                        👑 ${Helpers.escapeHtml(Helpers.roleLabel('owner'))}
                    </button>
                    <button onclick="window.app.users.approveUser('${Helpers.escapeJsAttr(user.id)}', 'manager')" style="flex: 1; min-width: 100px; padding: 8px 16px; background: #764ba2; color: white; border: none; border-radius: 8px; cursor: pointer;">
                        👔 ${Helpers.escapeHtml(Helpers.roleLabel('manager'))}
                    </button>
                    <button onclick="window.app.users.approveUser('${Helpers.escapeJsAttr(user.id)}', 'staff')" style="flex: 1; min-width: 100px; padding: 8px 16px; background: #48bb78; color: white; border: none; border-radius: 8px; cursor: pointer;">
                        👤 ${Helpers.escapeHtml(Helpers.roleLabel('staff'))}
                    </button>
                    <button onclick="window.app.users.rejectUser('${Helpers.escapeJsAttr(user.id)}')" style="flex: 1; min-width: 100px; padding: 8px 16px; background: #f56565; color: white; border: none; border-radius: 8px; cursor: pointer;">
                        ❌ ${tx('ui.admin.reject')}
                    </button>
                </div>
            </div>
        `).join('');
    }

    /**
     * Render list of active approved users
     * @param {Array<Object>} users - Array of active user objects
     */
    static renderActiveUsers(users) {
        const container = document.getElementById('activeUsersList');
        if (!container) return;
        
        container.innerHTML = users.map(user => {
            const roleColors = {
                owner: '#667eea',
                manager: '#764ba2',
                staff: '#48bb78'
            };
            const roleIcons = {
                owner: '👑',
                manager: '👔',
                staff: '👤'
            };
            
            const isCurrentUser = user.id === (AppState.currentUser ? AppState.currentUser.uid : null);
            
            // Escape for use in onclick attributes
            const safeId = Helpers.escapeJsAttr(user.id);
            const safeName = Helpers.escapeJsAttr(user.name || '');
            const safeEmail = Helpers.escapeJsAttr(user.email || '');
            
            return `
                <div style="background: #fff; border: 1px solid #e0e0e0; border-radius: 12px; padding: 16px; margin-bottom: 12px;">
                    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px;">
                        <div style="flex: 1;">
                            <strong style="font-size: 16px;">${Helpers.escapeHtml(user.name)}</strong>
                            <p style="color: #666; margin: 4px 0;">${Helpers.escapeHtml(user.email)}</p>
                            <span style="display: inline-block; padding: 4px 12px; background: ${Helpers.escapeHtml(roleColors[user.role])}; color: white; border-radius: 12px; font-size: 12px; margin-top: 4px;">
                                ${Helpers.escapeHtml(roleIcons[user.role])} ${Helpers.escapeHtml(Helpers.roleLabel(user.role).toUpperCase())}
                            </span>
                        </div>
                        ${isCurrentUser ? `<span style="color: #999; font-size: 12px; padding: 8px;">${tx('ui.admin.you')}</span>` : ''}
                    </div>
                    ${!isCurrentUser ? `
                    <div style="display: flex; gap: 8px; flex-wrap: wrap; border-top: 1px solid #eee; padding-top: 12px;">
                        <button onclick="window.app.users.showChangeRoleDialog('${safeId}', '${safeName}', '${Helpers.escapeJsAttr(user.role)}')" style="flex: 1; min-width: 80px; padding: 8px 12px; background: #f7fafc; border: 1px solid #e0e0e0; border-radius: 8px; cursor: pointer; font-size: 13px;">
                            ✏️ ${tx('ui.admin.edit_role')}
                        </button>
                        <button onclick="window.app.users.resetUserPassword('${safeId}', '${safeEmail}')" style="flex: 1; min-width: 80px; padding: 8px 12px; background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; cursor: pointer; font-size: 13px; color: #92400e;">
                            🔑 ${tx('ui.admin.reset_password')}
                        </button>
                        <button onclick="window.app.users.deleteUser('${safeId}', '${safeName}')" style="flex: 1; min-width: 80px; padding: 8px 12px; background: #fee2e2; border: 1px solid #ef4444; border-radius: 8px; cursor: pointer; font-size: 13px; color: #991b1b;">
                            🗑️ ${tx('ui.modals.delete')}
                        </button>
                    </div>
                    ` : ''}
                </div>
            `;
        }).join('');
    }

    static async approveUser(userId, role) {
        try {
            await FirebaseService.updateUser(userId, {
                role: role,
                status: 'active',
                approvedAt: FirebaseService.serverTimestamp()
            });
            
            UIManager.hapticFeedback('medium');
            UIManager.showToast(t('msg.common.user_approved_as', { roleLabel: Helpers.roleLabel(role) }));
            this.loadUsers();
        } catch (error) {
            console.error('Error approving user:', error);
            UIManager.showModal(t('msg.common.failed_approve_user'));
        }
    }

    static async rejectUser(userId) {
        const confirmed = await UIManager.showModal(t('msg.users.are_sure_want_reject_registration'), t('msg.users.confirm'), true);
        if (!confirmed) return;
        
        try {
            await FirebaseService.deleteUserProfile(userId);
            
            UIManager.hapticFeedback('light');
            UIManager.showToast(t('msg.users.registration_rejected'));
            this.loadUsers();
        } catch (error) {
            console.error('Error rejecting user:', error);
            UIManager.showModal(t('msg.common.failed_reject_user'));
        }
    }

    static async showChangeRoleDialog(userId, userName, currentRole) {
        const roles = ['owner', 'manager', 'staff'];
        const roleOptions = roles.map(r => 
            `<option value="${r}" ${r === currentRole ? 'selected' : ''}>${Helpers.roleLabel(r).toUpperCase()}</option>`
        ).join('');
        
        const html = `
            <div style="text-align: left;">
                <p style="margin-bottom: 16px;">${tx('ui.users.change_role_for')} <strong>${Helpers.escapeHtml(userName)}</strong></p>
                <select id="newRoleSelect" style="width: 100%; padding: 12px; border: 1px solid #e0e0e0; border-radius: 8px; font-size: 16px;">
                    ${roleOptions}
                </select>
            </div>
        `;
        
        const result = await this.showCustomModal(html, [
            { text: t('ui.modals.cancel'), value: null },
            { text: t('msg.admin.change_role'), value: 'change', primary: true }
        ]);
        
        if (result && result.selectedRole) {
            const newRole = result.selectedRole;
            if (newRole !== currentRole) {
                await this.changeUserRole(userId, newRole);
            }
        }
    }

    static async changeUserRole(userId, newRole) {
        try {
            await FirebaseService.updateUser(userId, {
                role: newRole,
                updatedAt: FirebaseService.serverTimestamp()
            });
            
            UIManager.hapticFeedback('medium');
            UIManager.showToast(t('msg.users.role_updated', { roleLabel: Helpers.roleLabel(newRole) }));
            this.loadUsers();
        } catch (error) {
            console.error('Error changing role:', error);
            UIManager.showModal(t('msg.common.failed_change_role'));
        }
    }

    /**
     * Send password reset email to a user
     * @param {string} userId - User document ID
     * @param {string} email - User's email address
     */
    static async resetUserPassword(userId, email) {
        const confirmed = await UIManager.showModal(
            t('msg.common.send_password_reset_email', { email }),
            t('msg.common.reset_password'),
            true
        );
        
        if (!confirmed) return;
        
        try {
            await firebase.auth().sendPasswordResetEmail(email);
            UIManager.hapticFeedback('success');
            UIManager.showToast(t('msg.common.password_reset_email_sent', { email }));
        } catch (error) {
            console.error('Error sending reset email:', error);
            UIManager.showModal(t('msg.common.failed_send_reset_email', { message: error.message }));
        }
    }

    /**
     * Delete a user from the system
     * @param {string} userId - User document ID
     * @param {string} userName - User's display name
     */
    static async deleteUser(userId, userName) {
        const confirmed = await UIManager.showModal(
            t('msg.common.are_sure_want_delete_user', { userName }),
            t('msg.common.delete_user'),
            true
        );
        
        if (!confirmed) return;
        
        // Double confirm for safety
        const doubleConfirm = await UIManager.showModal(
            t('msg.users.type_delete_confirm_deletion', { userName }),
            t('msg.users.confirm_deletion'),
            true
        );
        
        if (!doubleConfirm) return;
        
        try {
            // Delete user document from Firestore
            await FirebaseService.deleteUserProfile(userId);
            
            UIManager.hapticFeedback('medium');
            UIManager.showToast(t('msg.common.user_has_been_deleted', { userName }));
            this.loadUsers();
        } catch (error) {
            console.error('Error deleting user:', error);
            UIManager.showModal(t('msg.common.failed_delete_user', { message: error.message }));
        }
    }

    static showCustomModal(html, buttons) {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 10000;';
            
            const content = document.createElement('div');
            content.style.cssText = 'background: white; padding: 24px; border-radius: 16px; max-width: 400px; width: 90%; box-shadow: 0 8px 32px rgba(0,0,0,0.2);';
            content.innerHTML = html;
            
            const buttonContainer = document.createElement('div');
            buttonContainer.style.cssText = 'display: flex; gap: 12px; margin-top: 20px;';
            
            buttons.forEach(btn => {
                const button = document.createElement('button');
                button.textContent = btn.text;
                button.style.cssText = `flex: 1; padding: 12px; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; ${
                    btn.primary ? 'background: #667eea; color: white;' : 'background: #f7fafc; color: #333;'
                }`;
                button.onclick = () => {
                    const selectElement = document.getElementById('newRoleSelect');
                    const selectedRole = selectElement ? selectElement.value : null;
                    
                    document.body.removeChild(modal);
                    
                    if (btn.value === 'change' && selectedRole) {
                        resolve({ ...btn, selectedRole });
                    } else {
                        resolve(btn.value);
                    }
                };
                buttonContainer.appendChild(button);
            });
            
            content.appendChild(buttonContainer);
            modal.appendChild(content);
            document.body.appendChild(modal);
        });
    }

}
