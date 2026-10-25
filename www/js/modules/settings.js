/**
 * @fileoverview Settings Module
 * Handles application settings including display, labor rates, dark mode,
 * printer configuration, data management, and audit logs
 * @module modules/settings
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { AuditService } from '../services/audit.js';
import { Helpers } from '../utils/helpers.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { normalizeLabourSettings } from '../utils/money.js';
import { normalizeThresholds } from '../utils/bill-checks.js';
import { t } from '../i18n/index.js';
import { auditActionLabel } from '../i18n/localize.js';

const LABOUR_OWNER_ONLY_KEY = 'msg.settings.labour_owner_only';
/** '1' = item names follow the app language, '0' = the user chose "Show item names in Hindi" (#143). */
export const ITEM_NAMES_FOLLOW_LANG_KEY = 'aadhat.itemNamesFollowLang';

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
        const isOwner = AppState.userRole === 'owner';
        
        // Labour settings are shared by every device; only the owner may change them (#20)
        setField('settingHeavyWeight', 'value', labour.heavyWeightThreshold);
        setField('settingLaborRate', 'value', labour.laborRate);
        ['settingHeavyWeight', 'settingLaborRate'].forEach(id => setField(id, 'disabled', !isOwner));
        const note = document.getElementById('labourSettingsNote');
        if (note) note.textContent = t(isOwner ? 'msg.settings.labour_saved_for_everyone' : LABOUR_OWNER_ONLY_KEY);
        setField('settingAutoLabor', 'checked', settings.autoLaborEnabled !== false);
        setField('settingShowHindi', 'checked', settings.showHindi || false);
        
        // Update email display
        const userEmail = document.getElementById('userEmail');
        if (userEmail && AppState.currentUser?.email) {
            userEmail.textContent = AppState.currentUser.email;
        }
        
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
     * Blank or invalid values fall back to ₹6 / 30 kg. Only the owner may change
     * them (settings/app is owner-only in firestore.rules); for anyone else the
     * form is reset to the shared values. Admin → Configure uses this too (#21).
     * @param {{laborRate?: *, heavyWeightThreshold?: *}} values
     * @returns {Promise<boolean>} true when the shared value was saved
     */
    static async saveLabourSettings(values) {
        const current = normalizeLabourSettings(AppState.settings);
        if (AppState.userRole !== 'owner') {
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
            
            const devices = await window.app.printer.scan();
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
            
            await window.app.printer.connect(deviceId, deviceName);
            
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
            await window.app.printer.disconnect();
            
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
        const { printerSettings } = AppState;
        const statusText = document.getElementById('printerStatusText');
        const disconnectBtn = document.getElementById('disconnectBtn');
        const testPrintBtn = document.getElementById('testPrintBtn');
        
        const isConnected = window.app.printer && window.app.printer.device && printerSettings.deviceName;
        
        if (isConnected) {
            if (statusText) {
                statusText.innerHTML = `<span style="color: #4CAF50;">● ${Helpers.escapeHtml(t('ui.settings.printer_connected_to', { deviceName: printerSettings.deviceName }))}</span>`;
            }
            if (disconnectBtn) disconnectBtn.style.display = 'block';
            if (testPrintBtn) testPrintBtn.style.display = 'block';
        } else {
            if (statusText) {
                statusText.innerHTML = `<span style="color: #999;">○ ${Helpers.escapeHtml(t('ui.settings.printer_not_connected'))}</span>`;
            }
            if (disconnectBtn) disconnectBtn.style.display = 'none';
            if (testPrintBtn) testPrintBtn.style.display = 'none';
        }
    }

    static async testPrint() {
        if (!window.app.printer || !window.app.printer.device) {
            await UIManager.showModal(t('msg.settings.printer_not_connected'));
            return;
        }
        
        try {
            UIManager.hapticFeedback('medium');
            UIManager.showLoading();
            
            const testBillData = {
                isPurchase: true,
                billTotal: 1000,
                laborCharges: 12,
                amountPayable: 988,
                totalPackets: 3,
                onlinePayment: 500,
                cashPayment: 488,
                laborCalc: '(6 × 2)',
                items: [
                    {
                        name: 'Test Item 1',
                        rate: 50,
                        qty: 10,
                        total: 500,
                        weights: [5, 5]
                    },
                    {
                        name: 'Test Item 2',
                        rate: 50,
                        qty: 10,
                        total: 500,
                        weights: [10]
                    }
                ]
            };
            
            await window.app.printer.write(testBillData);
            UIManager.hideLoading();
            UIManager.showToast(t('msg.settings.test_print_sent'));
            UIManager.hapticFeedback('heavy');
        } catch (error) {
            UIManager.hideLoading();
            await UIManager.showModal(t('msg.common.test_print_failed', { message: error.message }));
        }
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
