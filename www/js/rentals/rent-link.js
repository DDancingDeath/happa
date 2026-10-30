/**
 * @fileoverview Tenant rent-history link management (owner/manager): make, share,
 * replace or turn off a lease's read-only link. Every action needs the network, so
 * this loads with import() from rentals.js only when used (not precached).
 * @module rentals/rent-link
 */

import { UIManager } from '../ui/ui-manager.js';
import { t } from '../i18n/index.js';
import { AuditService } from '../services/audit.js';
import { openExternal } from '../utils/open-external.js';
import { whatsAppReminderUrl } from '../utils/due-reminder.js';
import * as store from './rent-store.js';
import { placeText } from './rent-views.js';

const auditWarn = (e) => console.warn('Rentals audit entry not written:', e?.code || e);

/** Owner/manager: make, share, replace or turn off the tenant's read-only link. */
export async function shareLink(c, leaseId) {
    if (!c.isManager) return;
    const lease = c.findLease(leaseId);
    if (!lease) return;
    const url = c.linkFor(lease);
    const id = c.js(leaseId);
    const btn = (action, key, cls = '') => `<button type="button" class="rent-btn${cls}" onclick="window.app.rentals.linkAction('${action}', '${id}')">${c.esc(t(key))}</button>`;
    const body = url
        ? `<p class="rent-help">${c.esc(t('ui.rent.link_help'))}</p>
           <input id="rentLinkUrl" type="text" readonly value="${c.esc(url)}">
           <div class="rent-actions">${btn('send', 'ui.rent.link_send', ' rent-btn-wa')}${btn('copy', 'ui.rent.link_copy')}${btn('new', 'ui.rent.link_new')}${btn('off', 'ui.rent.link_off')}</div>`
        : `<p class="rent-help">${c.esc(t('ui.rent.link_help'))}</p>
           <div class="rent-actions">${btn('make', 'ui.rent.link_make', ' rent-btn-primary')}</div>`;
    await c.dialog(`<h3>🔗 ${c.esc(t('ui.rent.link_title'))}</h3>${body}`);
}

export async function linkAction(c, action, leaseId) {
    c.closeDialog();
    const lease = c.findLease(leaseId);
    if (!lease || !c.isManager) return;
    const ix = c.index(store.snapshot());
    if (action === 'copy' || action === 'send') {
        const url = c.linkFor(lease);
        if (!url) return;
        if (action === 'copy') {
            try { await navigator.clipboard.writeText(url); UIManager.showToast(t('msg.rent.link_copied'), 'success'); } catch (_) { UIManager.showToast(url, 'info'); }
            return;
        }
        openExternal(whatsAppReminderUrl(t('msg.rent.link_message', { url }), ix.tenants.get(lease.tenantId)?.phone));
        return;
    }
    try {
        if (action === 'off') {
            if (!await UIManager.showModal(t('msg.rent.link_off_confirm'), t('ui.rent.link_off'), true)) return;
            await store.removeShareLink(lease);
            UIManager.showToast(t('msg.rent.link_turned_off'), 'success');
        } else {
            if (action === 'new' && !await UIManager.showModal(t('msg.rent.link_new_confirm'), t('ui.rent.link_new'), true)) return;
            await store.makeShareLink(lease, {
                tenantName: ix.tenants.get(lease.tenantId)?.name || '',
                ...c.linkPlace(ix, lease.unitId),
                shopName: c.headerName(await c.defaults())
            });
            UIManager.showToast(t('msg.rent.link_ready'), 'success');
        }
        AuditService.log(action === 'off' ? 'RENT_LINK_OFF' : 'RENT_LINK_ON', { leaseId }).catch(auditWarn);
        setTimeout(() => shareLink(c, leaseId), 300);
    } catch (e) {
        console.error('Tenant link not saved:', e);
        UIManager.showToast(t('msg.rent.save_failed'), 'error');
    }
}

/** Settings › Rentals "Make a tenant link for new leases": the link for a lease just moved in (never blocks the move-in). */
export async function linkNewLease(c, { unit, res, occ, defs }) {
    const d = store.snapshot();
    const prop = d.properties.find(x => x.id === unit.propertyId);
    const created = {
        id: res.leaseId, unitId: res.unitId, propertyId: unit.propertyId, tenantId: res.tenantId,
        ...occ.lease, status: 'active', endMonth: null, shareToken: null
    };
    try {
        await store.makeShareLink(created, {
            tenantName: occ.tenant?.name || d.tenants.find(x => x.id === res.tenantId)?.name || '',
            place: placeText(unit.label, prop?.name),
            unitType: c.knownType(unit, prop),
            shopName: c.headerName(defs)
        });
        AuditService.log('RENT_LINK_ON', { leaseId: res.leaseId }).catch(auditWarn);
    } catch (e) {
        console.warn('Tenant link not made for the new lease:', e?.code || e);
    }
}
