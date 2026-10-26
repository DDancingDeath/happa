/**
 * @fileoverview Settings › Rentals: defaults for NEW leases (due day, yearly
 * increase %, electricity rate, tenant link) and the header on tenant pages.
 * Stored in rent_settings/default (rent-store.js). Loaded with import() only
 * when this section is shown (ui/business-switcher.js loadSettings()).
 * @module rentals/rent-settings
 */

import { t } from '../i18n/index.js';
import { Helpers } from '../utils/helpers.js';
import { UIManager } from '../ui/ui-manager.js';
import { AuditService } from '../services/audit.js';
import * as store from './rent-store.js';
import { MAX_RECEIPT_HEADER } from './rent-math.js';

const esc = (v) => Helpers.escapeHtml(v);
const val = (id) => document.getElementById(id)?.value ?? '';

/**
 * Draws the Rentals defaults form into `el` (reads rent_settings/default once).
 * @param {HTMLElement} el
 * @param {{editable: boolean}} opts
 */
export async function mount(el, { editable }) {
    if (!el) return;
    el.innerHTML = `<p class="setting-description">${esc(t('ui.navigation.loading'))}</p>`;
    let s;
    try {
        s = await store.loadSettings();
    } catch (e) {
        console.warn('Rentals settings not loaded:', e?.code || e);
        el.innerHTML = `<p class="setting-description">${esc(t('msg.rent.could_not_load'))}</p>`;
        return;
    }
    const off = editable ? '' : ' disabled';
    el.innerHTML = `
        <div class="settings-card" id="rentDefaultsCard">
            <h3>${esc(t('ui.rentset.defaults_title'))}</h3>
            <p class="setting-description">${esc(t('ui.rentset.defaults_hint'))}</p>
            <label for="rentSetDueDay">${esc(t('ui.rentset.due_day'))}</label>
            <input type="number" id="rentSetDueDay" min="1" max="28" step="1" value="${esc(s.dueDay)}"${off}>
            <label for="rentSetIncrease">${esc(t('ui.rentset.increase_pct'))}</label>
            <input type="number" id="rentSetIncrease" min="0" max="100" step="0.5" value="${esc(s.increasePct)}"${off}>
            <label for="rentSetMeterRate">${esc(t('ui.rentset.meter_rate'))}</label>
            <input type="number" inputmode="decimal" id="rentSetMeterRate" min="0" step="0.01" value="${esc(s.meterRate ?? '')}" placeholder="${esc(t('ui.rentset.meter_rate_none'))}"${off}>
            <label class="checkbox-label">
                <input type="checkbox" id="rentSetTenantLink"${s.tenantLink ? ' checked' : ''}${off}>
                <span>${esc(t('ui.rentset.tenant_link'))}</span>
            </label>
            <p class="setting-description">${esc(t('ui.rentset.tenant_link_hint'))}</p>
        </div>
        <div class="settings-card" id="rentReceiptCard">
            <h3>${esc(t('ui.rentset.receipt_title'))}</h3>
            <label for="rentSetHeader">${esc(t('ui.rentset.receipt_header'))}</label>
            <input type="text" id="rentSetHeader" maxlength="${MAX_RECEIPT_HEADER}" value="${esc(s.receiptHeader)}" placeholder="${esc(t('ui.rentset.receipt_header_placeholder'))}"${off}>
            <p class="setting-description">${esc(t('ui.rentset.receipt_hint'))}</p>
        </div>
        ${editable ? `<button type="button" class="add-item-btn" id="rentSetSave" onclick="window.app.settings.saveRentals()">${esc(t('ui.roles.save'))}</button>`
            : `<p class="setting-description">${esc(t('ui.rentset.view_only'))}</p>`}`;
}

/** Owner/manager: saves the form (rules: rent_settings is owner/manager write). */
export async function save() {
    const values = {
        dueDay: Number(val('rentSetDueDay')),
        increasePct: Number(val('rentSetIncrease')),
        meterRate: val('rentSetMeterRate') === '' ? null : Number(val('rentSetMeterRate')),
        tenantLink: !!document.getElementById('rentSetTenantLink')?.checked,
        receiptHeader: val('rentSetHeader')
    };
    try {
        const next = await store.saveSettings(values);
        UIManager.showToast(t('msg.rent.saved'), 'success');
        AuditService.log('RENT_SETTINGS', { ...next }).catch(e => console.warn('Rentals audit entry not written:', e?.code || e));
        return next;
    } catch (e) {
        console.error('Rentals settings not saved:', e);
        UIManager.showToast(t('msg.rent.save_failed'), 'error');
        return null;
    }
}
