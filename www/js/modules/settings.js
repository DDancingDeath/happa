/**
 * @fileoverview Settings: Common (language, account, notifications, printer,
 * install, about, Roles & access), Aadhat (internal id 'shop': business name,
 * UPI, labour, bill checks, bill numbers, opening stock) and Rentals (loaded on
 * demand from js/rentals). Which sections show: utils/settings-sections.js.
 * @module modules/settings
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { AuditService } from '../services/audit.js';
import { PrinterService } from '../services/printer.js';
import { Helpers } from '../utils/helpers.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { normalizeLabourSettings } from '../utils/money.js';
import { DEFAULT_THRESHOLDS, normalizeThresholds } from '../utils/bill-checks.js';
import { t } from '../i18n/index.js';
import { auditActionLabel } from '../i18n/localize.js';
import { settingsView } from '../utils/settings-sections.js';
import { BusinessSwitcher } from '../ui/business-switcher.js';
import { APP_IDENTITY } from '../config/app-identity.js';
import { AuthManager } from '../auth/authentication.js';

const LABOUR_OWNER_ONLY_KEY = 'msg.settings.labour_owner_only';
/** '1' = item names follow the app language, '0' = the user chose "Show item names in Hindi" (#143). */
export const ITEM_NAMES_FOLLOW_LANG_KEY = 'aadhat.itemNamesFollowLang';

/** Bill-check limits in Settings › Aadhat (keys of DEFAULT_THRESHOLDS); moved from Admin › Configure. */
export const CHECK_THRESHOLD_FIELDS = [
    ['oversellBlockKg', 'ui.checks.oversell_block'],
    ['rateMultiple', 'ui.checks.rate_multiple'],
    ['duplicateWindowSec', 'ui.checks.duplicate_window'],
    ['maxFutureMin', 'ui.checks.max_future'],
    ['backdateDays', 'ui.checks.backdate_days'],
    ['cashOkRs', 'ui.checks.cash_ok'],
    ['cashHighRs', 'ui.checks.cash_high'],
    ['stockAdjustFlagKg', 'ui.checks.stock_adjust_flag']
];
const MAX_BUSINESS_NAME = 80;
const MAX_BUSINESS_DETAILS = 120;
const MAX_UPI = 60;

/** Set an input's value / checked state when it is on the page. */
function setField(id, prop, value) {
    const el = document.getElementById(id);
    if (el) el[prop] = value;
    return el;
}

/**
 * Settings Manager - Manages application settings
 * @class SettingsManager
 */
export class SettingsManager {
    /**
     * Load settings from AppState and populate form fields
     * Configures visibility based on user role
     */
    static loadSettings() {
        const { settings } = AppState;
        const labour = normalizeLabourSettings(settings);
        const canEdit = this.canEditShop();
        
        // Labour settings are shared by every device; the owner (or a manager allowed in Roles & access) changes them (#20)
        setField('settingHeavyWeight', 'value', labour.heavyWeightThreshold);
        setField('settingLaborRate', 'value', labour.laborRate);
        ['settingHeavyWeight', 'settingLaborRate'].forEach(id => setField(id, 'disabled', !canEdit));
        const note = document.getElementById('labourSettingsNote');
        if (note) note.textContent = t(canEdit ? 'msg.settings.labour_saved_for_everyone' : LABOUR_OWNER_ONLY_KEY);
        setField('settingAutoLabor', 'checked', settings.autoLaborEnabled !== false);
        setField('settingShowHindi', 'checked', settings.showHindi || false);
        
        // Update email display
        const userEmail = document.getElementById('userEmail');
        if (userEmail && AppState.currentUser?.email) {
            userEmail.textContent = AppState.currentUser.email;
        }
        const nameInput = document.getElementById('settingUserName');
        if (nameInput && document.activeElement !== nameInput) nameInput.value = AppState.userName || '';
        
        const darkModeCheckbox = document.getElementById('settingDarkMode');
        if (darkModeCheckbox) {
            const darkModeEnabled = localStorage.getItem('darkMode') === 'true';
            darkModeCheckbox.checked = darkModeEnabled;
            if (darkModeEnabled) {
                document.body.classList.add('dark-mode');
            }
        }
        
        const bluetoothCheckbox = document.getElementById('settingBluetoothEnabled');
        if (bluetoothCheckbox) {
            const { printerSettings } = AppState;
            bluetoothCheckbox.checked = printerSettings.enabled || false;
            const section = document.getElementById('bluetoothPrinterSection');
            if (section) {
                section.style.display = printerSettings.enabled ? 'block' : 'none';
            }
        }
        
        this.updatePrinterStatus();
    }

    /**
     * Item names show in Hindi with the Hindi app language until the user sets
     * "Show item names in Hindi" themselves. An existing "on" choice is kept.
     * @param {'en'|'hi'} lang
     */
    static syncItemNamesWithLanguage(lang) {
        let follow = localStorage.getItem(ITEM_NAMES_FOLLOW_LANG_KEY);
        if (follow === null) {
            follow = AppState.settings.showHindi === true ? '0' : '1';
            localStorage.setItem(ITEM_NAMES_FOLLOW_LANG_KEY, follow);
        }
        if (follow === '1') AppState.settings.showHindi = lang === 'hi';
        setField('settingShowHindi', 'checked', !!AppState.settings.showHindi);
    }

    /**
     * Toggle dark mode on/off
     * Persists preference to localStorage
     */
    static toggleDarkMode() {
        const enabled = document.getElementById('settingDarkMode').checked;
        localStorage.setItem('darkMode', enabled);
        
        if (enabled) {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }
        
        UIManager.hapticFeedback('light');
        UIManager.showToast(enabled ? t('msg.settings.dark_mode_enabled') : t('msg.settings.dark_mode_disabled'));
    }

    /**
     * Save current settings to AppState and localStorage
     * Updates related UI components after save
     */
    static saveSettings() {
        const autoLabor = document.getElementById('settingAutoLabor');
        if (autoLabor) AppState.settings.autoLaborEnabled = autoLabor.checked;
        const showHindi = document.getElementById('settingShowHindi');
        if (showHindi && showHindi.checked !== !!AppState.settings.showHindi) {
            AppState.settings.showHindi = showHindi.checked;
            localStorage.setItem(ITEM_NAMES_FOLLOW_LANG_KEY, '0');
        }
        
        localStorage.setItem('settings', JSON.stringify(AppState.settings));
        
        const rateInput = document.getElementById('settingLaborRate');
        const weightInput = document.getElementById('settingHeavyWeight');
        const current = normalizeLabourSettings(AppState.settings);
        const typed = normalizeLabourSettings({
            laborRate: rateInput ? rateInput.value : current.laborRate,
            heavyWeightThreshold: weightInput ? weightInput.value : current.heavyWeightThreshold
        });
        const labourChanged = (rateInput || weightInput)
            && (typed.laborRate !== current.laborRate || typed.heavyWeightThreshold !== current.heavyWeightThreshold);
        const labourWrite = labourChanged ? this.saveLabourSettings(typed) : Promise.resolve(false);
        
        UIManager.hapticFeedback('light');
        UIManager.showToast(t('msg.settings.settings_saved_successfully'));
        
        window.app?.items?.render?.();
        window.app?.billing?.loadItemsDropdown?.();
        return labourWrite;
    }

    /**
     * Labour rate + heavy-packet weight: one shared value for every device (#20).
     * Blank or invalid values fall back to ₹6 / 30 kg. The owner, or a manager
     * allowed in Roles & access, may change them (firestore.rules check the same
     * on settings/app); for anyone else the form is reset to the shared values.
     * @param {{laborRate?: *, heavyWeightThreshold?: *}} values
     * @returns {Promise<boolean>} true when the shared value was saved
     */
    static async saveLabourSettings(values) {
        const current = normalizeLabourSettings(AppState.settings);
        if (!this.canEditShop()) {
            setField('settingLaborRate', 'value', current.laborRate);
            setField('settingHeavyWeight', 'value', current.heavyWeightThreshold);
            UIManager.showToast(t(LABOUR_OWNER_ONLY_KEY));
            return false;
        }
        const next = normalizeLabourSettings({
            laborRate: values?.laborRate ?? current.laborRate,
            heavyWeightThreshold: values?.heavyWeightThreshold ?? current.heavyWeightThreshold
        });
        this.applyLabourLocally(next);
        try {
            await FirebaseService.saveSharedLabourSettings(next);
            return true;
        } catch (error) {
            console.error('Saving shared labour settings failed:', error);
            UIManager.showToast(t('msg.settings.labour_rate_not_saved_everyone'));
            return false;
        }
    }

    /**
     * Use the shared labour settings from settings/app (read once at startup).
     * When none exist yet, the owner's device seeds them from its own values.
     * @param {Object|null} appSettings - settings/app data
     * @returns {Promise<void>}
     */
    static async applySharedSettings(appSettings) {
        // Bill-check limits (#37): shop-wide, defaults when the owner has not set any
        AppState.settings.checkThresholds = normalizeThresholds(appSettings?.checkThresholds);
        // Business name/details (Settings › Aadhat): shared; a name set only on this device is kept until one is saved
        if (typeof appSettings?.businessName === 'string') AppState.settings.shopName = appSettings.businessName;
        if (typeof appSettings?.businessDetails === 'string') AppState.settings.businessDetails = appSettings.businessDetails;
        localStorage.setItem('settings', JSON.stringify(AppState.settings));
        const hasShared = !!appSettings && (appSettings.laborRate !== undefined || appSettings.heavyWeightThreshold !== undefined);
        if (hasShared) {
            this.applyLabourLocally(normalizeLabourSettings(appSettings));
            return;
        }
        if (AppState.userRole === 'owner') {
            const seed = normalizeLabourSettings(AppState.settings);
            this.applyLabourLocally(seed);
            await FirebaseService.saveSharedLabourSettings(seed);
        }
    }

    /**
     * Put labour settings into AppState (+ the offline cache in localStorage) and
     * refresh the open purchase bill and the settings form.
     * @param {{laborRate: number, heavyWeightThreshold: number}} labour
     */
    static applyLabourLocally(labour) {
        AppState.settings.laborRate = labour.laborRate;
        AppState.settings.heavyWeightThreshold = labour.heavyWeightThreshold;
        localStorage.setItem('settings', JSON.stringify(AppState.settings));
        setField('settingLaborRate', 'value', labour.laborRate);
        setField('settingHeavyWeight', 'value', labour.heavyWeightThreshold);
        // Clean up the keys the old Admin → Configure screen wrote (never read by billing, #21)
        ['laborChargeRate', 'heavyWeightThreshold', 'autoLaborCharges'].forEach(key => localStorage.removeItem(key));
        if (document.getElementById('billTable')) window.app?.billing?.renderBill?.();
    }

    /** Owner, or a manager allowed in Roles & access (rules: settings/app). */
    static canEditShop() {
        return settingsView({ userRole: AppState.userRole, rentRole: AppState.rentRole, roleAccess: AppState.settings?.roleAccess }).shop.editable;
    }

    /** Section the user toggled to (null = the business open in the switcher). */
    static sectionChoice = null;

    /**
     * Opens Settings: Common always; the Aadhat or Rentals section by the
     * business switcher, or `section` from a settings-* route.
     * @param {('common'|'shop'|'rentals'|'roles'|null)} [section]
     */
    static open(section = null) {
        if (section === 'shop' || section === 'rentals') this.sectionChoice = section;
        this.loadSettings();
        window.app?.roles?.render?.();
        const view = this.renderSections();
        const target = section === 'roles' ? 'roleAccessCard'
            : section === 'common' ? 'settingsCommon'
            : (section === 'shop' || section === 'rentals') && view.active === section ? 'settingsBizBar' : null;
        const el = target && document.getElementById(target);
        if (el?.scrollIntoView) el.scrollIntoView({ block: 'start' });
        return view;
    }

    /** View the other business's section (only offered when the user has a role there). */
    static showOther() {
        const view = this.currentView();
        if (!view.other) return view;
        this.sectionChoice = view.other;
        return this.renderSections();
    }

    static currentView() {
        return settingsView({
            userRole: AppState.userRole, rentRole: AppState.rentRole,
            business: BusinessSwitcher.current(), choice: this.sectionChoice, roleAccess: AppState.settings?.roleAccess
        });
    }

    /** Shows the active business section only; Rentals code and data load only when that section is shown. */
    static renderSections() {
        const view = this.currentView();
        const shop = document.getElementById('settingsShop');
        const rentals = document.getElementById('settingsRentals');
        if (shop) shop.hidden = view.active !== 'shop';
        if (rentals) rentals.hidden = view.active !== 'rentals';
        const bar = document.getElementById('settingsBizBar');
        if (bar) bar.hidden = !view.active && !view.other;
        const title = document.getElementById('settingsBizTitle');
        if (title) {
            title.hidden = !view.active;
            title.textContent = view.active ? t(view.active === 'rentals' ? 'ui.settings.section_rentals' : 'ui.settings.section_shop') : '';
        }
        const toggle = document.getElementById('settingsBizToggle');
        if (toggle) {
            toggle.hidden = !view.other;
            toggle.textContent = view.other ? t(view.other === 'rentals' ? 'ui.settings.view_rentals' : 'ui.settings.view_shop') : '';
        }
        if (view.active === 'shop') this.renderShop(view.shop.editable);
        if (view.active === 'rentals') this.renderRentals(view.rentals.editable).catch(e => console.warn('Rentals settings not shown:', e));
        else {
            const body = document.getElementById('settingsRentalsBody');
            if (body) body.innerHTML = '';
        }
        return view;
    }

    /** Settings › Aadhat: values from settings/app (already read at start-up) and this device. */
    static renderShop(editable) {
        const s = AppState.settings || {};
        setField('settingBusinessName', 'value', s.shopName || '');
        setField('settingBusinessDetails', 'value', s.businessDetails || '');
        setField('settingUpiId', 'value', s.upiId || '');
        document.querySelectorAll('#settingsShop [data-shop-edit]').forEach(el => { el.disabled = !editable; });
        const viewOnly = document.getElementById('settingsShopViewOnly');
        if (viewOnly) viewOnly.hidden = editable;
        const code = document.getElementById('settingBillDeviceCode');
        if (code) code.textContent = Helpers.getBillDeviceCode();
        this.renderCheckThresholds(editable);
    }

    /** Bill-check limits (#37): shop-wide, blank = default. */
    static renderCheckThresholds(editable = this.canEditShop()) {
        const box = document.getElementById('settingsChecks');
        if (!box) return;
        const e = Helpers.escapeHtml;
        const vals = normalizeThresholds(AppState.settings?.checkThresholds);
        box.innerHTML = CHECK_THRESHOLD_FIELDS.map(([key, label]) => `
                <label for="settingCheck_${key}">${e(t(label))}</label>
                <input type="number" inputmode="decimal" min="0" step="any" id="settingCheck_${key}"
                       placeholder="${e(DEFAULT_THRESHOLDS[key])}" value="${e(vals[key])}"${editable ? '' : ' disabled'}
                       onchange="window.app.settings.saveCheckThresholds()" />`).join('');
    }

    /**
     * Save the bill-check limits for everyone (owner, or a manager allowed in Roles & access).
     * @returns {Promise<boolean>}
     */
    static async saveCheckThresholds() {
        if (!this.canEditShop()) return false;
        const typed = {};
        CHECK_THRESHOLD_FIELDS.forEach(([key]) => { typed[key] = document.getElementById(`settingCheck_${key}`)?.value; });
        const next = normalizeThresholds(typed);
        AppState.settings.checkThresholds = next;
        localStorage.setItem('settings', JSON.stringify(AppState.settings));
        CHECK_THRESHOLD_FIELDS.forEach(([key]) => setField(`settingCheck_${key}`, 'value', next[key]));
        try {
            await FirebaseService.saveSharedCheckThresholds(next);
            UIManager.showToast(t('msg.admin.settings_saved_everyone'));
            return true;
        } catch (error) {
            console.error('Saving bill-check limits failed:', error);
            UIManager.showToast(t('msg.admin.not_saved_everyone_check_internet'));
            return false;
        }
    }

    /** Business name and one line of details, printed on bills; shared in settings/app. */
    static async saveBusinessDetails() {
        if (!this.canEditShop()) {
            UIManager.showToast(t(LABOUR_OWNER_ONLY_KEY));
            return false;
        }
        const clean = (id, max) => String(document.getElementById(id)?.value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
        const details = { businessName: clean('settingBusinessName', MAX_BUSINESS_NAME), businessDetails: clean('settingBusinessDetails', MAX_BUSINESS_DETAILS) };
        AppState.settings.shopName = details.businessName;
        AppState.settings.businessDetails = details.businessDetails;
        localStorage.setItem('settings', JSON.stringify(AppState.settings));
        try {
            await FirebaseService.saveBusinessDetails(details);
            UIManager.showToast(t('msg.admin.settings_saved_everyone'));
            return true;
        } catch (error) {
            console.error('Saving business details failed:', error);
            UIManager.showToast(t('msg.admin.not_saved_everyone_check_internet'));
            return false;
        }
    }

    /** UPI ID for payment reminders: this device only (as before). */
    static saveUpi() {
        const upi = String(document.getElementById('settingUpiId')?.value ?? '').replace(/\s+/g, '').slice(0, MAX_UPI);
        AppState.settings.upiId = upi;
        localStorage.setItem('settings', JSON.stringify(AppState.settings));
        setField('settingUpiId', 'value', upi);
        UIManager.showToast(t('msg.settings.settings_saved_successfully'));
        return upi;
    }

    /** Settings › Rentals: its code is imported (and rent_settings read) only now. */
    static async renderRentals(editable) {
        const body = document.getElementById('settingsRentalsBody');
        if (!body) return;
        try {
            const mod = await BusinessSwitcher.loadSettings();
            if (this.currentView().active !== 'rentals') return;
            await mod.mount(body, { editable });
        } catch (error) {
            console.error('Rentals settings failed to open:', error);
            body.innerHTML = `<p class="setting-description">${Helpers.escapeHtml(t('msg.rent.could_not_open'))}</p>`;
        }
    }

    static async saveRentals() {
        if (!this.currentView().rentals.editable) return null;
        const mod = await BusinessSwitcher.loadSettings();
        return mod.save();
    }

    /** Stocks › Set opening stock. */
    static openOpeningStock() {
        window.app?.nav?.showTab?.('stock');
        setTimeout(() => window.app?.stock?.startOpeningStock?.(), 150);
    }

    /** Account: your name (your own profile; rules let you change it). */
    static async saveName() {
        const uid = AppState.currentUser?.uid;
        const name = String(document.getElementById('settingUserName')?.value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!uid || !name) {
            UIManager.showToast(t('msg.settings.name_needed'));
            return false;
        }
        try {
            await FirebaseService.updateUser(uid, { name });
        } catch (error) {
            console.error('Saving name failed:', error);
            UIManager.showToast(t('msg.settings.name_not_saved'));
            return false;
        }
        AppState.userName = name;
        AuthManager.applyRoleBasedRestrictions();
        UIManager.showToast(t('msg.settings.name_saved'));
        return true;
    }

    /** Account: emails a link to set a new password. */
    static async changePassword() {
        const email = AppState.currentUser?.email;
        if (!email) return false;
        const ok = await UIManager.showModal(t('msg.common.send_password_reset_email', { email }), t('msg.common.reset_password'), true);
        if (!ok) return false;
        try {
            await firebase.auth().sendPasswordResetEmail(email, { url: APP_IDENTITY.siteUrl, handleCodeInApp: false });
            UIManager.showToast(t('msg.common.password_reset_email_sent', { email }));
            return true;
        } catch (error) {
            console.error('Password reset email failed:', error?.code || error);
            UIManager.showToast(t('msg.common.failed_send_reset_email', { message: error.message }), 'error');
            return false;
        }
    }

    static toggleBluetoothPrinter() {
        const enabled = document.getElementById('settingBluetoothEnabled').checked;
        AppState.printerSettings.enabled = enabled;
        localStorage.setItem('printerSettings', JSON.stringify(AppState.printerSettings));
        
        const section = document.getElementById('bluetoothPrinterSection');
        if (section) {
            section.style.display = enabled ? 'block' : 'none';
        }
        
        this.updatePrinterStatus();
    }

    static async scanBluetoothDevices() {
        try {
            UIManager.hapticFeedback('light');
            
            if (!window.bluetoothSerial) {
                const msg = t('msg.settings.bluetooth_app_only');
                await UIManager.showModal(msg);
                return;
            }
            
            const devices = await PrinterService.scanDevices();
            this.displayBluetoothDevices(devices);
        } catch (error) {
            const errorMsg = t('msg.printer.failed_scan_devices', { message: error.message || error });
            console.error('[SETTINGS] Scan error:', error);
            await UIManager.showModal(errorMsg);
        }
    }

    static displayBluetoothDevices(devices) {
        const container = document.getElementById('bluetoothDevicesList');
        if (!container) return;
        
        if (!devices || devices.length === 0) {
            container.innerHTML = `<p style="color: #666; padding: 12px;">${Helpers.escapeHtml(t('ui.settings.no_devices_found'))}</p>`;
            return;
        }
        
        container.innerHTML = `<div style="margin-top: 12px;"><strong>${Helpers.escapeHtml(t('ui.settings.available_devices'))}</strong></div>`;
        
        devices.forEach((device, index) => {
            const deviceCard = document.createElement('div');
            deviceCard.style.cssText = 'background: #f5f5f5; padding: 12px; margin: 8px 0; border-radius: 8px; display: flex; justify-content: space-between; align-items: center;';
            const address = device.address || device.deviceId || device.id;
            const name = device.name || 'Unknown Device';
            
            // Store device info in a data attribute to avoid quote issues
            deviceCard.setAttribute('data-device-id', address);
            deviceCard.setAttribute('data-device-name', name);
            
            deviceCard.innerHTML = `
                <div>
                    <strong>${Helpers.escapeHtml(name)}</strong><br>
                    <small style="color: #666;">${Helpers.escapeHtml(address)}</small>
                </div>
                <button class="add-item-btn" data-device-index="${index}">${Helpers.escapeHtml(t('ui.settings.connect'))}</button>
            `;
            
            // Add click handler to the button
            const button = deviceCard.querySelector('button');
            button.addEventListener('click', () => {
                this.connectToPrinter(address, name);
            });
            
            container.appendChild(deviceCard);
        });
    }

    static async connectToPrinter(deviceId, deviceName) {
        try {
            UIManager.hapticFeedback('medium');
            
            await PrinterService.connect(deviceId, deviceName);
            
            AppState.printerSettings.deviceId = deviceId;
            AppState.printerSettings.deviceName = deviceName;
            localStorage.setItem('printerSettings', JSON.stringify(AppState.printerSettings));
            
            this.updatePrinterStatus();
            UIManager.showToast(t('msg.settings.connected', { deviceName }));
            
            const container = document.getElementById('bluetoothDevicesList');
            if (container) container.innerHTML = '';
            
        } catch (error) {
            const errorMsg = t('msg.printer.failed_connect', { message: error.message || error });
            console.error('[SETTINGS] Connect error:', error);
            await UIManager.showModal(errorMsg);
        }
    }

    static async disconnectPrinter() {
        try {
            UIManager.hapticFeedback('light');
            await PrinterService.disconnect();
            
            AppState.printerSettings.deviceId = null;
            AppState.printerSettings.deviceName = null;
            localStorage.setItem('printerSettings', JSON.stringify(AppState.printerSettings));
            
            this.updatePrinterStatus();
            UIManager.showToast(t('msg.common.printer_disconnected'));
        } catch (error) {
            await UIManager.showModal(t('msg.common.failed_disconnect', { message: error.message }));
        }
    }

    static updatePrinterStatus() {
        return PrinterService.refreshStatus();
    }

    static async testPrint() {
        UIManager.hapticFeedback('medium');
        const printed = await PrinterService.testPrint();
        PrinterService.updateStatus();
        if (printed) UIManager.hapticFeedback('heavy');
        return printed;
    }

    // Audit Logs Methods
    static auditLogs = [];
    
    static async loadAuditLogs() {
        if (AppState.userRole !== 'owner') {
            UIManager.showToast(t('msg.common.only_owners_can_view_audit'));
            return;
        }
        
        UIManager.showLoading();
        try {
            this.auditLogs = await AuditService.getRecentLogs(100);
            this.renderAuditLogs();
            UIManager.hideLoading();
        } catch (error) {
            console.error('Error loading audit logs:', error);
            UIManager.hideLoading();
            UIManager.showToast(t('msg.common.failed_load_audit_logs'));
        }
    }
    
    static filterAuditLogs() {
        this.renderAuditLogs();
    }
    
    static renderAuditLogs() {
        const container = document.getElementById('auditLogsList');
        if (!container) return;
        
        const filterAction = document.getElementById('auditFilterAction')?.value || '';
        
        let filteredLogs = this.auditLogs;
        if (filterAction) {
            filteredLogs = this.auditLogs.filter(log => log.action === filterAction);
        }
        
        if (filteredLogs.length === 0) {
            container.innerHTML = `<p style="padding: 16px; text-align: center; color: #888;">${Helpers.escapeHtml(t('ui.settings.no_audit_logs'))}</p>`;
            return;
        }
        
        container.innerHTML = filteredLogs.map(log => {
            const date = new Date(log.timestamp);
            const formattedDate = Helpers.formatDateTime(date);
            
            const actionIcon = this.getActionIcon(log.action);
            const actionColor = this.getActionColor(log.action);
            const details = this.formatDetails(log.details);
            
            return `
                <div style="padding: 12px; border-bottom: 1px solid #eee; display: flex; gap: 12px; align-items: flex-start;">
                    <span style="font-size: 20px;">${actionIcon}</span>
                    <div style="flex: 1;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                            <span style="font-weight: 600; color: ${actionColor};">${Helpers.escapeHtml(auditActionLabel(log.action))}</span>
                            <span style="font-size: 11px; color: #888;">${formattedDate}</span>
                        </div>
                        <div style="font-size: 12px; color: #666;">
                            <strong>${Helpers.escapeHtml(log.userName)}</strong> (${Helpers.escapeHtml(Helpers.roleLabel(log.userRole))})
                        </div>
                        ${details ? `<div style="font-size: 11px; color: #888; margin-top: 4px;">${Helpers.escapeHtml(details)}</div>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }
    
    static getActionIcon(action) {
        const icons = {
            'CREATE_BILL': '📥',
            'DELETE_BILL': '🗑️',
            'CREATE_SALE': '📤',
            'DELETE_SALE': '🗑️',
            'DELETE_ITEM': '🗑️',
            'UPDATE_PAYMENT': '💰',
            'RECORD_PAYMENT': '💰',
            'CLEAR_DATA': '⚠️',
            'LOGIN': '🔑',
            'LOGOUT': '🚪'
        };
        return icons[action] || '📋';
    }
    
    static getActionColor(action) {
        if (action.includes('DELETE') || action === 'CLEAR_DATA') return '#e74c3c';
        if (action.includes('CREATE')) return '#27ae60';
        if (action.includes('PAYMENT')) return '#3498db';
        return '#333';
    }
    
    static formatDetails(details) {
        if (!details || typeof details !== 'object') return '';
        
        const parts = [];
        if (details.billNumber) parts.push(t('ui.settings.audit_bill', { value: details.billNumber }));
        if (details.amount) parts.push(t('ui.settings.audit_amount', { value: details.amount }));
        if (details.customer) parts.push(t('ui.settings.audit_customer', { value: details.customer }));
        if (details.itemName) parts.push(t('ui.settings.audit_item', { value: details.itemName }));
        if (details.paymentAmount) parts.push(t('ui.settings.audit_payment', { value: details.paymentAmount }));
        if (details.collections) parts.push(t('ui.settings.audit_collections', { value: details.collections.join(', ') }));
        if (details.recordsDeleted) parts.push(t('ui.settings.audit_records', { value: details.recordsDeleted }));
        
        return parts.join(' • ');
    }
}
