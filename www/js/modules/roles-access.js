/**
 * @fileoverview Settings → Roles & access (#84): the owner chooses, per role,
 * which pages and numbers managers and members see, how far back History goes
 * and for how many days bills can be edited or deleted.
 * @module modules/roles-access
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
import { AuthManager } from '../auth/authentication.js';
import { Helpers } from '../utils/helpers.js';
import { t } from '../i18n/index.js';
import {
    CONFIGURABLE_ROLES, PAGE_PERMISSIONS, SECTION_PERMISSIONS, SETTINGS_PERMISSIONS, MAX_EDIT_DAYS, MAX_HISTORY_DAYS,
    normalizeRoleAccess
} from '../utils/role-access.js';

const ROLE_LABEL_KEYS = { manager: 'ui.roles.manager', staff: 'ui.roles.member' };
const PERMISSION_LABEL_KEYS = {
    finance: 'ui.roles.perm_finance',
    reports: 'ui.roles.perm_reports',
    analytics: 'ui.roles.perm_analytics',
    wholesale: 'ui.roles.perm_wholesale',
    personalExpenses: 'ui.roles.perm_personal_expenses',
    profit: 'ui.roles.perm_profit',
    stockValue: 'ui.roles.perm_stock_value',
    oldCashSessions: 'ui.roles.perm_old_cash_sessions',
    purchaseRates: 'ui.roles.perm_purchase_rates',
    shopSettings: 'ui.roles.perm_shop_settings',
    historyDays: 'ui.roles.perm_history_days',
    editDays: 'ui.roles.perm_edit_days'
};
const DAY_LIMITS = { historyDays: MAX_HISTORY_DAYS, editDays: MAX_EDIT_DAYS };
// Applied by the app only; the database rules don't enforce these yet (docs/role-permissions.md).
const CLIENT_ONLY = new Set(['personalExpenses', 'historyDays']);

const fieldId = (role, permission) => `ra-${role}-${permission}`;

export class RolesAccessManager {
    /** Roles & access in use on this device (defaults when the owner has not set any). */
    static current() {
        return normalizeRoleAccess(AppState.settings?.roleAccess);
    }

    /**
     * Use roleAccess from settings/app (the startup read) and re-apply the page/section gating.
     * @param {Object|null} appSettings
     */
    static applyShared(appSettings) {
        AppState.settings.roleAccess = normalizeRoleAccess(appSettings?.roleAccess);
        try { localStorage.setItem('settings', JSON.stringify(AppState.settings)); } catch (_) { /* storage full/blocked */ }
        AuthManager.applyRoleBasedRestrictions();
    }

    /** Draws the owner-only grid in Settings. */
    static render() {
        const card = document.getElementById('roleAccessCard');
        if (!card) return;
        const isOwner = AppState.userRole === 'owner';
        card.style.display = isOwner ? '' : 'none';
        const grid = document.getElementById('roleAccessGrid');
        if (!isOwner || !grid) {
            if (grid) grid.innerHTML = '';
            return;
        }
        const e = Helpers.escapeHtml;
        const access = this.current();
        const head = `<tr><th>${e(t('ui.roles.permission'))}</th>${CONFIGURABLE_ROLES.map(r => `<th>${e(t(ROLE_LABEL_KEYS[r]))}</th>`).join('')}</tr>`;
        const group = (key) => `<tr class="role-access-group"><td colspan="${CONFIGURABLE_ROLES.length + 1}">${e(t(key))}</td></tr>`;
        const label = (p) => `<td>${e(t(PERMISSION_LABEL_KEYS[p]))}${CLIENT_ONLY.has(p) ? `<small class="role-access-note">${e(t('ui.roles.client_only_note'))}</small>` : ''}</td>`;
        const switchRow = (p) => `<tr>${label(p)}${CONFIGURABLE_ROLES.map(r => `
            <td><input type="checkbox" id="${fieldId(r, p)}" aria-label="${e(`${t(PERMISSION_LABEL_KEYS[p])} – ${t(ROLE_LABEL_KEYS[r])}`)}"${access[r][p] ? ' checked' : ''}></td>`).join('')}</tr>`;
        // Settings switches are for managers only (members never see the Aadhat settings).
        const managerRow = (p) => `<tr><td>${e(t(PERMISSION_LABEL_KEYS[p]))}</td>${CONFIGURABLE_ROLES.map(r => r !== 'manager' ? '<td>–</td>' : `
            <td><input type="checkbox" id="${fieldId(r, p)}" aria-label="${e(`${t(PERMISSION_LABEL_KEYS[p])} – ${t(ROLE_LABEL_KEYS[r])}`)}"${access[r][p] ? ' checked' : ''}></td>`).join('')}</tr>`;
        const daysRow = (p) => `<tr>${label(p)}${CONFIGURABLE_ROLES.map(r => `
            <td><input type="number" inputmode="numeric" min="0" max="${DAY_LIMITS[p]}" step="1" id="${fieldId(r, p)}" aria-label="${e(`${t(PERMISSION_LABEL_KEYS[p])} – ${t(ROLE_LABEL_KEYS[r])}`)}" value="${e(access[r][p])}"></td>`).join('')}</tr>`;
        grid.innerHTML = `
            <table class="role-access-table">
                <thead>${head}</thead>
                <tbody>
                    ${group('ui.roles.group_pages')}
                    ${PAGE_PERMISSIONS.map(switchRow).join('')}
                    ${group('ui.roles.group_numbers')}
                    ${SECTION_PERMISSIONS.map(switchRow).join('')}
                    ${group('ui.roles.group_settings')}
                    ${SETTINGS_PERMISSIONS.map(managerRow).join('')}
                    ${group('ui.roles.group_days')}
                    ${daysRow('historyDays')}
                    ${daysRow('editDays')}
                </tbody>
            </table>
            <p class="setting-description">${e(t('ui.roles.history_days_hint'))}</p>
            <p class="setting-description">${e(t('ui.roles.edit_days_hint', { max: MAX_EDIT_DAYS }))}</p>`;
        const status = document.getElementById('roleAccessStatus');
        if (status) status.textContent = '';
    }

    /** Values on the screen, normalized (missing/invalid → defaults, days clamped). */
    static readForm() {
        const raw = {};
        for (const role of CONFIGURABLE_ROLES) {
            raw[role] = {};
            for (const p of [...PAGE_PERMISSIONS, ...SECTION_PERMISSIONS, ...SETTINGS_PERMISSIONS]) {
                const el = document.getElementById(fieldId(role, p));
                if (el) raw[role][p] = !!el.checked;
            }
            for (const p of ['historyDays', 'editDays']) {
                const el = document.getElementById(fieldId(role, p));
                if (el) raw[role][p] = el.value;
            }
        }
        return normalizeRoleAccess(raw);
    }

    /**
     * Owner saves Roles & access for every device (settings/app, owner-only in rules).
     * @returns {Promise<boolean>} true when saved
     */
    static async saveForm() {
        if (AppState.userRole !== 'owner') {
            UIManager.showToast(t('msg.roles.owner_only'));
            return false;
        }
        const before = this.current();
        const next = this.readForm();
        const changes = [];
        for (const role of CONFIGURABLE_ROLES) {
            for (const [p, value] of Object.entries(next[role])) {
                if (before[role][p] !== value) changes.push(`${role}.${p}=${value}`);
            }
        }
        AppState.settings.roleAccess = next;
        try { localStorage.setItem('settings', JSON.stringify(AppState.settings)); } catch (_) { /* storage full/blocked */ }
        AuthManager.applyRoleBasedRestrictions();
        this.render();
        try {
            await FirebaseService.saveRoleAccess(next);
        } catch (error) {
            console.error('Saving roles & access failed:', error);
            UIManager.showToast(t('msg.roles.not_saved'));
            return false;
        }
        if (changes.length) {
            AuditService.log(AuditService.ACTIONS.CHANGE_ROLE_ACCESS, { changes: changes.join(', ').slice(0, 900) })
                .catch(e => console.warn('Audit log failed:', e));
        }
        const status = document.getElementById('roleAccessStatus');
        if (status) status.textContent = t('msg.roles.saved');
        UIManager.showToast(t('msg.roles.saved'));
        return true;
    }

    /** Approved users, loaded only when the owner asks (one users read). */
    static people = null;

    static async loadPeople() {
        if (AppState.userRole !== 'owner') return false;
        const box = document.getElementById('rolePeopleList');
        if (box) box.innerHTML = `<p class="setting-description">${Helpers.escapeHtml(t('ui.navigation.loading'))}</p>`;
        try {
            this.people = await FirebaseService.loadUsers();
        } catch (error) {
            console.warn('Roles & access: users not loaded', error?.code || error);
            this.people = null;
            if (box) box.innerHTML = '';
            UIManager.showToast(t('msg.common.failed_load_users'));
            return false;
        }
        this.renderPeople();
        return true;
    }

    /** Each user's Aadhat role (changed in Admin › Users) and Rentals role (changed here). */
    static renderPeople() {
        const box = document.getElementById('rolePeopleList');
        if (!box) return;
        if (AppState.userRole !== 'owner' || !this.people) { box.innerHTML = ''; return; }
        const e = Helpers.escapeHtml;
        const shopRole = (r) => t(`ui.role.${r === 'owner' || r === 'manager' ? r : r === 'staff' ? 'member' : 'none'}`);
        const rentOptions = [['', 'ui.rent.access_none'], ['manager', 'ui.rent.access_manager'], ['member', 'ui.rent.access_member']];
        const rows = this.people
            .filter(u => !['pending', 'rejected', 'disabled'].includes(u.status) && (u.role || u.rentRole))
            .map(u => {
                const owner = u.role === 'owner';
                const rent = owner ? e(t('ui.role.owner'))
                    : `<select aria-label="${e(t('ui.roles.rentals_role'))}" onchange="window.app.roles.setRentRole('${Helpers.escapeJsAttr(u.id)}', this.value)">${rentOptions.map(([v, k]) => `<option value="${v}"${(u.rentRole || '') === v ? ' selected' : ''}>${e(t(k))}</option>`).join('')}</select>`;
                return `<tr><td>${e(u.name || u.email || '')}</td><td>${e(shopRole(u.role))}</td><td>${rent}</td></tr>`;
            }).join('');
        box.innerHTML = `<table class="role-access-table role-people-table">
                <thead><tr><th>${e(t('ui.roles.person'))}</th><th>${e(t('ui.roles.shop_role'))}</th><th>${e(t('ui.roles.rentals_role'))}</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <p class="setting-description">${e(t('ui.roles.people_hint'))}</p>`;
    }

    /** Owner: a user's Rentals role ('manager' | 'member' | none). */
    static async setRentRole(userId, role) {
        if (AppState.userRole !== 'owner') return false;
        const value = ['manager', 'member'].includes(role) ? role : null;
        try {
            await FirebaseService.updateUser(userId, { rentRole: value });
        } catch (error) {
            console.error('Rentals role not saved:', error);
            UIManager.showToast(t('msg.rent.save_failed'));
            this.renderPeople();
            return false;
        }
        const u = this.people?.find(x => x.id === userId);
        if (u) u.rentRole = value;
        UIManager.showToast(t('msg.rent.access_saved'));
        return true;
    }
}
