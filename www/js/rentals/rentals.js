/**
 * @fileoverview Rentals section (#170 phase 1): Rent (this month, dues, record
 * payment, WhatsApp reminder), Tenants, Properties and units, Access (owner).
 * Loaded only by ui/business-switcher.js with import() when Rentals opens.
 * @module rentals/rentals
 */

import { NavigationManager } from '../ui/navigation.js';
import { UIManager } from '../ui/ui-manager.js';
import { TemplateLoader } from '../utils/template-loader.js';
import { Helpers } from '../utils/helpers.js';
import { todayLocalISO } from '../utils/dates.js';
import { openExternal } from '../utils/open-external.js';
import { formatINR, whatsAppReminderUrl } from '../utils/due-reminder.js';
import { t, getLang, applyTranslations, LANG_CHANGE_EVENT } from '../i18n/index.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
import { rentalsRole } from '../ui/business-switcher.js';
import * as store from './rent-store.js';
import {
    PROPERTY_KINDS, PAYMENT_MODES, DEFAULT_DUE_DAY, DEFAULT_INCREASE_PCT, MAX_PROPERTIES, MAX_UNITS_PER_PROPERTY,
    monthKey, monthLabel, monthsToCharge, chargeStatus, chargeDue, monthSummary, leaseDues, buildRentReminderText,
    increaseDue, meterBill, propertyError, unitError, tenantError, leaseError, isMonth, addMonths
} from './rent-math.js';

const PAGES = ['rent', 'tenants', 'properties', 'access'];
const esc = (v) => Helpers.escapeHtml(v);
const js = (v) => Helpers.escapeJsAttr(v);
const money = (n) => esc(formatINR(n));

const state = {
    page: 'rent',
    month: null,
    loaded: new Set(),
    errors: new Set(),
    charging: false,
    charged: new Set(),
    users: null,
    renderTimer: null,
    entry: 0
};
let domReady = null;

// Owner decision: anyone with a rentals role records payments and updates records.
const canWrite = () => !!rentalsRole();
const isOwner = () => rentalsRole() === 'owner';
const isManager = () => ['owner', 'manager'].includes(rentalsRole());
const auditWarn = (e) => console.warn('Rentals audit entry not written:', e?.code || e);
/** Shop role in the chosen language (Helpers.roleLabel is English only). */
const roleText = (role) => t(`ui.role.${['owner', 'manager', 'staff'].includes(role) ? (role === 'staff' ? 'member' : role) : 'none'}`);
const val = (id) => (document.getElementById(id)?.value ?? '').trim();
const isVisible = () => document.getElementById('rentals')?.classList.contains('active');

function ensureDom() {
    if (document.getElementById('rentals')) return Promise.resolve();
    if (!domReady) {
        domReady = (async () => {
            if (!document.getElementById('rentalsCss')) {
                const link = document.createElement('link');
                link.id = 'rentalsCss';
                link.rel = 'stylesheet';
                link.href = 'css/rentals.css';
                document.head.appendChild(link);
            }
            const html = await TemplateLoader.loadTemplate('rentals');
            if (!html) throw new Error('rentals template not loaded');
            (document.getElementById('appContent') || document.body).insertAdjacentHTML('beforeend', html);
            applyTranslations(document.getElementById('rentals'));
            window.addEventListener(LANG_CHANGE_EVENT, () => { if (isVisible()) render(); });
        })().catch((e) => { domReady = null; throw e; });
    }
    return domReady;
}

function scheduleRender() {
    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(() => { if (isVisible()) render(); }, 30);
}

function onData(key, error) {
    state.loaded.add(key);
    if (error) state.errors.add(key); else state.errors.delete(key);
    if (['leases', 'tenants', 'units'].includes(key)) void maybeCharge();
    scheduleRender();
}

/** Creates this month's (and missed months') charges for active leases, once per visit. */
async function maybeCharge() {
    if (state.charging || !['leases', 'tenants', 'units'].every(k => state.loaded.has(k))) return;
    const d = store.snapshot();
    const todo = d.leases.filter(l => !l._pending && !state.charged.has(l.id) && monthsToCharge(l, state.month).length);
    if (!todo.length) return;
    state.charging = true;
    const tenants = new Map(d.tenants.map(x => [x.id, x]));
    const units = new Map(d.units.map(x => [x.id, x]));
    try {
        for (const l of todo) {
            state.charged.add(l.id);
            await store.chargeLease(l.id, state.month, {
                tenantName: tenants.get(l.tenantId)?.name || '',
                unitLabel: units.get(l.unitId)?.label || ''
            }).catch(e => console.warn('Rent charges not created for', l.id, e?.code || e));
        }
    } finally {
        state.charging = false;
    }
}

function index(d) {
    return {
        properties: new Map(d.properties.map(x => [x.id, x])),
        units: new Map(d.units.map(x => [x.id, x])),
        tenants: new Map(d.tenants.map(x => [x.id, x])),
        leases: new Map(d.leases.map(x => [x.id, x]))
    };
}

function placeOf(ix, unitId, fallback = '') {
    const unit = ix.units.get(unitId);
    if (!unit) return fallback;
    const prop = ix.properties.get(unit.propertyId);
    return prop ? `${prop.name} · ${unit.label}` : unit.label;
}

const kindLabel = (k) => t(`ui.rent.kind_${PROPERTY_KINDS.includes(k) ? k : 'other'}`);
const modeLabel = (m) => t(`ui.rent.mode_${PAYMENT_MODES.includes(m) ? m : 'cash'}`);

function render() {
    const root = document.getElementById('rentalsBody');
    if (!root) return;
    const owner = isOwner();
    document.querySelectorAll('#rentals [data-rent-page]').forEach(btn => {
        const page = btn.getAttribute('data-rent-page');
        btn.classList.toggle('active', page === state.page);
        if (page === 'access') btn.hidden = !owner;
    });
    document.querySelectorAll('.nav-menu a[data-rent-nav]').forEach(a => {
        a.classList.toggle('active', a.getAttribute('data-rent-nav') === state.page);
    });
    const notice = document.getElementById('rentalsNotice');
    if (notice) {
        const limited = store.truncatedKeys().length > 0;
        notice.hidden = state.errors.size === 0 && !limited;
        notice.textContent = state.errors.size ? t('msg.rent.could_not_load') : limited ? t('msg.rent.limit_reached') : '';
    }
    if (state.page === 'access') { root.innerHTML = renderAccess(); return; }
    if (!['properties', 'units', 'tenants', 'leases', 'openCharges', 'monthCharges'].every(k => state.loaded.has(k))) {
        root.innerHTML = `<p class="rent-empty">${esc(t('ui.rent.loading'))}</p>`;
        return;
    }
    const d = store.snapshot();
    root.innerHTML = state.page === 'tenants' ? renderTenants(d)
        : state.page === 'properties' ? renderProperties(d)
        : renderRent(d);
}

// ---------- Rent ----------

function accounts(d, ix) {
    const list = d.leases.map(l => ({
        leaseId: l.id,
        lease: l,
        name: ix.tenants.get(l.tenantId)?.name || '',
        phone: ix.tenants.get(l.tenantId)?.phone || '',
        place: placeOf(ix, l.unitId)
    }));
    const seen = new Set(list.map(a => a.leaseId));
    for (const c of d.charges) {
        if (seen.has(c.leaseId) || chargeDue(c) <= 0) continue;
        seen.add(c.leaseId);
        list.push({
            leaseId: c.leaseId, lease: null, ended: true,
            name: ix.tenants.get(c.tenantId)?.name || c.tenantName || '',
            phone: ix.tenants.get(c.tenantId)?.phone || '',
            place: placeOf(ix, c.unitId, c.unitLabel || '')
        });
    }
    for (const a of list) {
        a.dues = leaseDues(d.charges, a.leaseId);
        a.current = d.charges.find(c => c.leaseId === a.leaseId && c.month === state.month) || null;
    }
    return list.sort((a, b) => (b.dues.total - a.dues.total) || a.name.localeCompare(b.name));
}

const badge = (cls, key) => `<span class="rent-badge rent-badge-${cls}">${esc(t(key))}</span>`;

/** Paid, or Due / Part paid plus Late after the lease's due day. */
function statusBadges(charge) {
    if (!charge) return '';
    const s = chargeStatus(charge);
    if (s.status === 'paid') return badge('paid', 'ui.rent.status_paid');
    return badge(s.status, s.status === 'partial' ? 'ui.rent.status_partial' : 'ui.rent.status_due')
        + (s.late ? ` ${badge('late', 'ui.rent.status_late')}` : '');
}

function monthLine(c, lang) {
    const e = c.electricity;
    const power = e ? ` <span class="rent-sub">${esc(t('ui.rent.incl_electricity', { amount: formatINR(e.amount), units: e.units }))}</span>` : '';
    return `<li>${esc(monthLabel(c.month, lang))}: ${money(chargeDue(c))} ${statusBadges(c)}${power}</li>`;
}

function renderRent(d) {
    const ix = index(d);
    const sum = monthSummary(d.charges, state.month);
    const lang = getLang();
    const cards = [
        ['ui.rent.expected', sum.expected],
        ['ui.rent.collected', sum.collected],
        ['ui.rent.pending_month', sum.pending],
        ['ui.rent.outstanding', sum.outstanding]
    ].map(([k, v]) => `<div class="rent-card"><div class="rent-card-label">${esc(t(k))}</div><div class="rent-card-value">${money(v)}</div></div>`).join('');
    const list = accounts(d, ix);
    const rows = list.map(a => {
        const months = a.dues.charges.map(c => monthLine(c, lang)).join('');
        const inc = a.lease ? increaseDue(a.lease, state.month) : { due: false };
        const increase = inc.due
            ? `<div class="rent-increase">📈 ${esc(t('ui.rent.increase_due', { pct: inc.pct, amount: formatINR(inc.newRent) }))}
                <button type="button" class="rent-btn rent-btn-small" onclick="window.app.rentals.editLease('${js(a.leaseId)}')">${esc(t('ui.rent.update_rent'))}</button></div>`
            : '';
        const power = a.current?.electricity && !a.dues.charges.some(c => c.id === a.current.id) ? monthLine(a.current, lang) : '';
        const terms = a.lease
            ? esc(t('ui.rent.rent_terms', { amount: formatINR(a.lease.rent), day: a.lease.dueDay }))
            : esc(t('ui.rent.moved_out'));
        const actions = (a.dues.total > 0
            ? `<button type="button" class="rent-btn rent-btn-primary" onclick="window.app.rentals.pay('${js(a.leaseId)}')">${esc(t('ui.rent.record_payment'))}</button>
               <button type="button" class="rent-btn rent-btn-wa" onclick="window.app.rentals.remind('${js(a.leaseId)}')">${esc(t('ui.rent.whatsapp_reminder'))}</button>`
            : '') + (a.lease && a.current && (!a.current.electricity || isManager())
            ? `<button type="button" class="rent-btn" onclick="window.app.rentals.meter('${js(a.leaseId)}')">⚡ ${esc(t('ui.rent.meter_reading'))}</button>`
            : '');
        return `<div class="rent-row">
            <div class="rent-row-head">
                <div><div class="rent-name">${esc(a.name || t('ui.rent.no_name'))}</div>
                <div class="rent-sub">${esc(a.place)} · ${terms}</div></div>
                <div class="rent-row-right">${statusBadges(a.current)}<div class="rent-due">${money(a.dues.total)}</div></div>
            </div>
            ${months || power ? `<ul class="rent-months">${months}${power}</ul>` : ''}
            ${increase}
            ${actions ? `<div class="rent-actions">${actions}</div>` : ''}
        </div>`;
    }).join('');
    return `<h3 class="rent-month-title">${esc(monthLabel(state.month, lang))}</h3>
        <div class="rent-cards">${cards}</div>
        ${rows || `<p class="rent-empty">${esc(t('ui.rent.no_leases'))}</p>`}`;
}

async function pay(leaseId) {
    const dues = leaseDues(store.snapshot().charges, leaseId);
    if (!dues.charges.length) return;
    const lang = getLang();
    const first = dues.charges[0];
    const options = dues.charges.map(c => `<option value="${esc(c.id)}" data-due="${esc(chargeDue(c))}">${esc(monthLabel(c.month, lang))} · ${money(chargeDue(c))}</option>`).join('');
    const modes = PAYMENT_MODES.map(m => `<option value="${m}">${esc(modeLabel(m))}</option>`).join('');
    const html = `<h3>${esc(t('ui.rent.record_payment'))}</h3>
        <label class="rent-label">${esc(t('ui.rent.month'))}
            <select id="rentPayCharge" onchange="window.app.rentals.fillDue(this)">${options}</select></label>
        <label class="rent-label">${esc(t('ui.rent.amount'))}
            <input id="rentPayAmount" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(chargeDue(first))}"></label>
        <label class="rent-label">${esc(t('ui.rent.mode'))}<select id="rentPayMode">${modes}</select></label>
        <label class="rent-label">${esc(t('ui.rent.reference'))}<input id="rentPayRef" type="text" maxlength="60"></label>
        <label class="rent-label">${esc(t('ui.rent.date'))}<input id="rentPayDate" type="date" value="${esc(todayLocalISO())}"></label>`;
    const ok = await dialog(html);
    if (!ok) return;
    const id = val('rentPayCharge');
    const charge = dues.charges.find(c => c.id === id);
    const amount = Number(val('rentPayAmount'));
    const mode = PAYMENT_MODES.includes(val('rentPayMode')) ? val('rentPayMode') : 'cash';
    const ref = val('rentPayRef');
    const date = val('rentPayDate') || todayLocalISO();
    try {
        const res = await store.recordPayment(id, { amount, mode, ref, date });
        UIManager.showToast(t('msg.rent.payment_saved', { amount: formatINR(res.amount) }), 'success');
        AuditService.log('RENT_PAYMENT', {
            chargeId: id, month: charge?.month || '', amount: res.amount, mode, tenant: charge?.tenantName || ''
        }).catch(auditWarn);
    } catch (e) {
        const key = e?.message === 'amount' ? 'msg.rent.bad_amount'
            : e?.message === 'over' ? 'msg.rent.more_than_due'
            : e?.message === 'too_many' ? 'msg.rent.too_many_payments'
            : 'msg.rent.payment_failed';
        UIManager.showToast(t(key), 'error');
    }
}

function fillDue(select) {
    const due = select?.selectedOptions?.[0]?.getAttribute('data-due');
    const input = document.getElementById('rentPayAmount');
    if (input && due != null) input.value = due;
}

function remind(leaseId) {
    const d = store.snapshot();
    const ix = index(d);
    const a = accounts(d, ix).find(x => x.leaseId === leaseId);
    if (!a || a.dues.total <= 0) return;
    const text = buildRentReminderText({
        tenantName: a.name, place: a.place, charges: a.dues.charges,
        lastMonth: a.lease?.endMonth || state.month, lang: getLang()
    });
    if (!a.phone) UIManager.showToast(t('msg.rent.no_phone'), 'info');
    openExternal(whatsAppReminderUrl(text, a.phone));
}

/** Electricity from the unit's sub-meter, added to this month's charge. */
async function meter(leaseId) {
    const d = store.snapshot();
    const lease = d.leases.find(l => l.id === leaseId);
    const charge = d.charges.find(c => c.leaseId === leaseId && c.month === state.month);
    if (!lease || !charge) return;
    const unit = d.units.find(u => u.id === lease.unitId);
    const e = charge.electricity;
    if (e && !isManager()) return UIManager.showToast(t('msg.rent.meter_manager_only'), 'info');
    const prev = e?.prev ?? unit?.lastReading ?? 0;
    // Previous reading is fixed once known; the rate too for members (rules check both).
    const prevLocked = e != null || unit?.lastReading != null;
    const rateLocked = !isManager() && unit?.meterRate != null;
    const ok = await dialog(`<h3>⚡ ${esc(t('ui.rent.meter_reading'))}: ${esc(monthLabel(state.month, getLang()))}</h3>
        <label class="rent-label">${esc(t('ui.rent.meter_prev'))}<input id="rentMeterPrev" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(prev)}"${prevLocked ? ' readonly' : ''}></label>
        <label class="rent-label">${esc(t('ui.rent.meter_curr'))}<input id="rentMeterCurr" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(e?.curr ?? '')}"></label>
        <label class="rent-label">${esc(t('ui.rent.meter_rate'))}<input id="rentMeterRate" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(e?.rate ?? unit?.meterRate ?? '')}"${rateLocked ? ' readonly' : ''}></label>
        <p class="rent-help">${esc(t('ui.rent.meter_help'))}</p>`);
    if (!ok) return;
    let bill;
    try {
        bill = meterBill({ prev: val('rentMeterPrev'), curr: val('rentMeterCurr'), rate: val('rentMeterRate') });
    } catch (_) {
        return UIManager.showToast(t('msg.rent.bad_reading'), 'error');
    }
    if (!unit) return UIManager.showToast(t('msg.rent.save_failed'), 'error');
    try {
        await store.recordMeter(charge.id, unit.id, bill);
        UIManager.showToast(t('msg.rent.meter_saved', { amount: formatINR(bill.amount), units: bill.units }), 'success');
        AuditService.log('RENT_METER', { chargeId: charge.id, units: bill.units, rate: bill.rate, amount: bill.amount }).catch(auditWarn);
    } catch (err) {
        UIManager.showToast(t(err?.message === 'below_paid' ? 'msg.rent.below_paid' : 'msg.rent.save_failed'), 'error');
    }
}

/**
 * Rent, due day and yearly increase % of a lease. The yearly increase is only a
 * reminder: the new rent is saved here after it was agreed with the tenant.
 */
async function editLease(leaseId) {
    const lease = store.snapshot().leases.find(l => l.id === leaseId);
    if (!lease) return;
    const inc = increaseDue(lease, state.month);
    const ok = await dialog(`<h3>${esc(t('ui.rent.update_rent'))}</h3>
        ${inc.due ? `<p class="rent-increase">📈 ${esc(t('ui.rent.increase_due', { pct: inc.pct, amount: formatINR(inc.newRent) }))}</p>` : ''}
        <label class="rent-label">${esc(t('ui.rent.monthly_rent'))}<input id="rentEditRent" type="number" inputmode="decimal" min="0" step="1" value="${esc(inc.due ? inc.newRent : lease.rent)}"></label>
        <label class="rent-label">${esc(t('ui.rent.due_day'))}<input id="rentEditDay" type="number" min="1" max="28" step="1" value="${esc(lease.dueDay)}"></label>
        <label class="rent-label">${esc(t('ui.rent.increase_pct'))}<input id="rentEditPct" type="number" min="0" max="100" step="0.5" value="${esc(inc.pct)}"></label>
        <p class="rent-help">${esc(t('ui.rent.rent_change_note'))}</p>`);
    if (!ok) return;
    const next = {
        rent: Number(val('rentEditRent')), dueDay: Number(val('rentEditDay')),
        increasePct: Number(val('rentEditPct')), startMonth: lease.startMonth
    };
    const err = leaseError(next);
    if (err) return UIManager.showToast(t(err), 'error');
    // The new rent applies from the first month not yet charged, so the next
    // yearly reminder counts from there.
    const appliesFrom = isMonth(lease.chargedThrough) && lease.chargedThrough >= state.month ? addMonths(state.month, 1) : state.month;
    const reviewed = next.rent !== lease.rent || inc.due;
    const fields = { rent: next.rent, dueDay: next.dueDay, increasePct: next.increasePct };
    if (reviewed) fields.rentSince = appliesFrom;
    await saveRent(() => store.updateLease(leaseId, fields));
    if (next.rent !== lease.rent) AuditService.log('RENT_CHANGE', { leaseId, from: lease.rent, to: next.rent }).catch(auditWarn);
}

// ---------- Tenants ----------

function renderTenants(d) {
    const ix = index(d);
    const leaseByTenant = new Map(d.leases.map(l => [l.tenantId, l]));
    const manage = canWrite();
    const form = manage ? `<div class="rent-form">
            <h3>${esc(t('ui.rent.add_tenant'))}</h3>
            <input id="rentTenantName" type="text" maxlength="80" placeholder="${esc(t('ui.rent.tenant_name'))}">
            <input id="rentTenantPhone" type="tel" maxlength="20" placeholder="${esc(t('ui.rent.phone'))}">
            <input id="rentTenantNotes" type="text" maxlength="500" placeholder="${esc(t('ui.rent.notes'))}">
            <button type="button" class="rent-btn rent-btn-primary" onclick="window.app.rentals.addTenant()">${esc(t('ui.rent.add'))}</button>
        </div>` : '';
    const rows = [...d.tenants].sort((a, b) => a.name.localeCompare(b.name)).map(tn => {
        const lease = leaseByTenant.get(tn.id);
        const where = lease ? `${esc(placeOf(ix, lease.unitId))} · ${esc(t('ui.rent.rent_terms', { amount: formatINR(lease.rent), day: lease.dueDay }))}`
            : esc(t('ui.rent.no_unit'));
        const id = js(tn.id);
        const actions = !manage ? '' : `<div class="rent-actions">
            ${lease ? `<button type="button" class="rent-btn" onclick="window.app.rentals.editLease('${js(lease.id)}')">${esc(t('ui.rent.update_rent'))}</button>
                <button type="button" class="rent-btn" onclick="window.app.rentals.moveOut('${js(lease.id)}')">${esc(t('ui.rent.move_out'))}</button>`
                : `<button type="button" class="rent-btn rent-btn-primary" onclick="window.app.rentals.moveIn('${id}')">${esc(t('ui.rent.move_in'))}</button>`}
            <button type="button" class="rent-btn" onclick="window.app.rentals.editTenant('${id}')">${esc(t('ui.rent.edit'))}</button>
            ${lease ? '' : `<button type="button" class="rent-btn" onclick="window.app.rentals.archiveTenant('${id}')">${esc(t('ui.rent.remove'))}</button>`}
        </div>`;
        return `<div class="rent-row"><div class="rent-name">${esc(tn.name)}</div>
            <div class="rent-sub">${tn.phone ? `📞 ${esc(tn.phone)} · ` : ''}${where}</div>
            ${tn.notes ? `<div class="rent-sub">${esc(tn.notes)}</div>` : ''}${actions}</div>`;
    }).join('');
    return form + (rows || `<p class="rent-empty">${esc(t('ui.rent.no_tenants'))}</p>`);
}

async function addTenant() {
    const tn = { name: val('rentTenantName'), phone: val('rentTenantPhone'), notes: val('rentTenantNotes') };
    const err = tenantError(tn);
    if (err) return UIManager.showToast(t(err), 'error');
    await saveRent(() => store.addTenant(tn));
}

async function editTenant(id) {
    const tn = store.snapshot().tenants.find(x => x.id === id);
    if (!tn) return;
    const ok = await dialog(`<h3>${esc(t('ui.rent.edit'))}</h3>
        <label class="rent-label">${esc(t('ui.rent.tenant_name'))}<input id="rentEditName" type="text" maxlength="80" value="${esc(tn.name)}"></label>
        <label class="rent-label">${esc(t('ui.rent.phone'))}<input id="rentEditPhone" type="tel" maxlength="20" value="${esc(tn.phone || '')}"></label>
        <label class="rent-label">${esc(t('ui.rent.notes'))}<input id="rentEditNotes" type="text" maxlength="500" value="${esc(tn.notes || '')}"></label>`);
    if (!ok) return;
    const next = { name: val('rentEditName'), phone: val('rentEditPhone'), notes: val('rentEditNotes') };
    const err = tenantError(next);
    if (err) return UIManager.showToast(t(err), 'error');
    await saveRent(() => store.updateTenant(id, next));
}

async function archiveTenant(id) {
    if (!await UIManager.showModal(t('msg.rent.confirm_remove'), t('ui.rent.remove'), true)) return;
    await saveRent(() => store.updateTenant(id, { archived: true }));
}

async function moveIn(tenantId) {
    const d = store.snapshot();
    const ix = index(d);
    const vacant = d.units.filter(u => !u.leaseId);
    if (!vacant.length) return UIManager.showToast(t('msg.rent.no_vacant_unit'), 'info');
    const options = vacant.map(u => `<option value="${esc(u.id)}" data-rent="${esc(u.rent || 0)}">${esc(placeOf(ix, u.id))}</option>`).join('');
    const ok = await dialog(`<h3>${esc(t('ui.rent.move_in'))}: ${esc(ix.tenants.get(tenantId)?.name || '')}</h3>
        <label class="rent-label">${esc(t('ui.rent.unit'))}<select id="rentLeaseUnit" onchange="window.app.rentals.fillRent(this)">${options}</select></label>
        <label class="rent-label">${esc(t('ui.rent.monthly_rent'))}<input id="rentLeaseRent" type="number" inputmode="decimal" min="0" step="1" value="${esc(vacant[0].rent || 0)}"></label>
        <label class="rent-label">${esc(t('ui.rent.due_day'))}<input id="rentLeaseDay" type="number" min="1" max="28" step="1" value="${DEFAULT_DUE_DAY}"></label>
        <label class="rent-label">${esc(t('ui.rent.start_month'))}<input id="rentLeaseStart" type="month" value="${esc(monthKey())}"></label>
        <label class="rent-label">${esc(t('ui.rent.increase_pct'))}<input id="rentLeasePct" type="number" min="0" max="100" step="0.5" value="${DEFAULT_INCREASE_PCT}"></label>
        <label class="rent-label">${esc(t('ui.rent.deposit'))}<input id="rentLeaseDeposit" type="number" inputmode="decimal" min="0" step="1" value="0"></label>`);
    if (!ok) return;
    const unit = ix.units.get(val('rentLeaseUnit'));
    const lease = {
        rent: Number(val('rentLeaseRent')), dueDay: Number(val('rentLeaseDay')),
        startMonth: val('rentLeaseStart'), deposit: Number(val('rentLeaseDeposit') || 0),
        increasePct: Number(val('rentLeasePct') || 0)
    };
    const err = !unit || unit.leaseId ? 'msg.rent.no_vacant_unit' : leaseError(lease, state.month);
    if (err) return UIManager.showToast(t(err), 'error');
    await saveRent(() => store.startLease({ unit, tenantId, ...lease }));
    AuditService.log('RENT_MOVE_IN', { tenantId, unitId: unit.id, rent: lease.rent }).catch(auditWarn);
}

function fillRent(select) {
    const rent = select?.selectedOptions?.[0]?.getAttribute('data-rent');
    const input = document.getElementById('rentLeaseRent');
    if (input && rent != null) input.value = rent;
}

/**
 * Move out: the last month can't be in the future. Charges are settled in one
 * transaction (rent-store endLease): missing months up to it are created and
 * unpaid later months removed; a paid later month stops the move-out.
 */
async function moveOut(leaseId) {
    const d = store.snapshot();
    const lease = d.leases.find(l => l.id === leaseId);
    if (!lease) return;
    // Ending before the last charged month removes charged months: owner/manager only (rules).
    const earliest = !isManager() && isMonth(lease.chargedThrough) && lease.chargedThrough > lease.startMonth
        ? lease.chargedThrough : lease.startMonth;
    const ok = await dialog(`<h3>${esc(t('ui.rent.move_out'))}</h3>
        <p>${esc(t('msg.rent.move_out_note'))}</p>
        <label class="rent-label">${esc(t('ui.rent.last_month'))}<input id="rentEndMonth" type="month" min="${esc(earliest)}" max="${esc(state.month)}" value="${esc(state.month)}"></label>`);
    if (!ok) return;
    const end = val('rentEndMonth');
    if (!isMonth(end) || end < lease.startMonth || end > state.month) return UIManager.showToast(t('msg.rent.bad_end_month'), 'error');
    if (end < earliest) return UIManager.showToast(t('msg.rent.backdate_manager_only'), 'error');
    const names = {
        tenantName: d.tenants.find(x => x.id === lease.tenantId)?.name || '',
        unitLabel: d.units.find(x => x.id === lease.unitId)?.label || ''
    };
    try {
        await store.endLease(leaseId, end, state.month, names);
        UIManager.showToast(t('msg.rent.saved'), 'success');
        AuditService.log('RENT_MOVE_OUT', { leaseId, endMonth: end }).catch(auditWarn);
    } catch (e) {
        console.warn('Move-out failed:', e?.code || e?.message || e);
        const key = e?.message === 'later_paid' ? 'msg.rent.later_paid'
            : e?.message === 'bad_month' ? 'msg.rent.bad_end_month' : 'msg.rent.save_failed';
        UIManager.showToast(t(key), 'error');
    }
}

// ---------- Properties ----------

function renderProperties(d) {
    const ix = index(d);
    const manage = canWrite();
    const kinds = PROPERTY_KINDS.map(k => `<option value="${k}">${esc(kindLabel(k))}</option>`).join('');
    const form = manage ? `<div class="rent-form">
            <h3>${esc(t('ui.rent.add_property'))}</h3>
            <input id="rentPropName" type="text" maxlength="80" placeholder="${esc(t('ui.rent.property_name'))}">
            <input id="rentPropAddress" type="text" maxlength="200" placeholder="${esc(t('ui.rent.address'))}">
            <select id="rentPropKind">${kinds}</select>
            <button type="button" class="rent-btn rent-btn-primary" onclick="window.app.rentals.addProperty()">${esc(t('ui.rent.add'))}</button>
        </div>` : '';
    const leaseById = ix.leases;
    const cards = [...d.properties].sort((a, b) => a.name.localeCompare(b.name)).map(p => {
        const units = d.units.filter(u => u.propertyId === p.id).sort((a, b) => a.label.localeCompare(b.label));
        const pid = js(p.id);
        const unitRows = units.map(u => {
            const lease = u.leaseId ? leaseById.get(u.leaseId) : null;
            const who = lease ? esc(ix.tenants.get(lease.tenantId)?.name || t('ui.rent.occupied')) : esc(t('ui.rent.vacant'));
            const uid = js(u.id);
            return `<li class="rent-unit"><span><strong>${esc(u.label)}</strong> · ${money(u.rent || 0)} · ${who}</span>
                ${manage ? `<span><button type="button" class="rent-btn rent-btn-small" onclick="window.app.rentals.editUnit('${uid}')">${esc(t('ui.rent.edit'))}</button>
                ${u.leaseId ? '' : `<button type="button" class="rent-btn rent-btn-small" onclick="window.app.rentals.archiveUnit('${uid}')">${esc(t('ui.rent.remove'))}</button>`}</span>` : ''}</li>`;
        }).join('');
        const occupied = units.some(u => u.leaseId);
        return `<div class="rent-row">
            <div class="rent-name">${esc(p.name)} <span class="rent-kind">${esc(kindLabel(p.kind))}</span></div>
            ${p.address ? `<div class="rent-sub">${esc(p.address)}</div>` : ''}
            <ul class="rent-units">${unitRows || `<li class="rent-empty">${esc(t('ui.rent.no_units'))}</li>`}</ul>
            ${manage ? `<div class="rent-actions">
                <button type="button" class="rent-btn rent-btn-primary" onclick="window.app.rentals.addUnit('${pid}')">${esc(t('ui.rent.add_unit'))}</button>
                <button type="button" class="rent-btn" onclick="window.app.rentals.editProperty('${pid}')">${esc(t('ui.rent.edit'))}</button>
                ${occupied ? '' : `<button type="button" class="rent-btn" onclick="window.app.rentals.archiveProperty('${pid}')">${esc(t('ui.rent.remove'))}</button>`}
            </div>` : ''}
        </div>`;
    }).join('');
    return form + (cards || `<p class="rent-empty">${esc(t('ui.rent.no_properties'))}</p>`);
}

async function addProperty() {
    const kind = val('rentPropKind');
    const p = { name: val('rentPropName'), address: val('rentPropAddress'), kind: PROPERTY_KINDS.includes(kind) ? kind : 'other', notes: '' };
    const err = propertyError(p);
    if (err) return UIManager.showToast(t(err), 'error');
    if (store.snapshot().properties.length >= MAX_PROPERTIES) {
        return UIManager.showToast(t('msg.rent.max_properties', { max: MAX_PROPERTIES }), 'error');
    }
    await saveRent(() => store.addProperty(p));
}

async function editProperty(id) {
    const p = store.snapshot().properties.find(x => x.id === id);
    if (!p) return;
    const kinds = PROPERTY_KINDS.map(k => `<option value="${k}"${k === p.kind ? ' selected' : ''}>${esc(kindLabel(k))}</option>`).join('');
    const ok = await dialog(`<h3>${esc(t('ui.rent.edit'))}</h3>
        <label class="rent-label">${esc(t('ui.rent.property_name'))}<input id="rentEditPropName" type="text" maxlength="80" value="${esc(p.name)}"></label>
        <label class="rent-label">${esc(t('ui.rent.address'))}<input id="rentEditPropAddress" type="text" maxlength="200" value="${esc(p.address || '')}"></label>
        <label class="rent-label">${esc(t('ui.rent.kind'))}<select id="rentEditPropKind">${kinds}</select></label>`);
    if (!ok) return;
    const kind = val('rentEditPropKind');
    const next = { name: val('rentEditPropName'), address: val('rentEditPropAddress'), kind: PROPERTY_KINDS.includes(kind) ? kind : 'other' };
    const err = propertyError(next);
    if (err) return UIManager.showToast(t(err), 'error');
    await saveRent(() => store.updateProperty(id, next));
}

async function archiveProperty(id) {
    if (!await UIManager.showModal(t('msg.rent.confirm_remove'), t('ui.rent.remove'), true)) return;
    const units = store.snapshot().units.filter(u => u.propertyId === id);
    if (units.some(u => u.leaseId)) return UIManager.showToast(t('msg.rent.has_tenant'), 'error');
    await saveRent(async () => {
        for (const u of units) await store.updateUnit(u.id, { archived: true });
        await store.updateProperty(id, { archived: true });
    });
}

async function unitDialog(title, unit) {
    const ok = await dialog(`<h3>${esc(title)}</h3>
        <label class="rent-label">${esc(t('ui.rent.unit_label'))}<input id="rentUnitLabel" type="text" maxlength="60" value="${esc(unit?.label || '')}"></label>
        <label class="rent-label">${esc(t('ui.rent.monthly_rent'))}<input id="rentUnitRent" type="number" inputmode="decimal" min="0" step="1" value="${esc(unit?.rent ?? 0)}"></label>`);
    if (!ok) return null;
    const u = { label: val('rentUnitLabel'), rent: Number(val('rentUnitRent') || 0) };
    const err = unitError(u);
    if (err) { UIManager.showToast(t(err), 'error'); return null; }
    return u;
}

async function addUnit(propertyId) {
    if (store.snapshot().units.filter(x => x.propertyId === propertyId).length >= MAX_UNITS_PER_PROPERTY) {
        return UIManager.showToast(t('msg.rent.max_units', { max: MAX_UNITS_PER_PROPERTY }), 'error');
    }
    const u = await unitDialog(t('ui.rent.add_unit'));
    if (u) await saveRent(() => store.addUnit({ propertyId, ...u }));
}

async function editUnit(id) {
    const unit = store.snapshot().units.find(x => x.id === id);
    if (!unit) return;
    const u = await unitDialog(t('ui.rent.edit'), unit);
    if (u) await saveRent(() => store.updateUnit(id, u));
}

async function archiveUnit(id) {
    if (!await UIManager.showModal(t('msg.rent.confirm_remove'), t('ui.rent.remove'), true)) return;
    await saveRent(() => store.updateUnit(id, { archived: true }));
}

// ---------- Access (owner) ----------

function renderAccess() {
    if (!isOwner()) return '';
    if (!state.users) {
        void loadUsers();
        return `<p class="rent-empty">${esc(t('ui.rent.loading'))}</p>`;
    }
    const roles = [['', 'ui.rent.access_none'], ['manager', 'ui.rent.access_manager'], ['member', 'ui.rent.access_member']];
    const rows = state.users
        .filter(u => u.role !== 'owner' && !['pending', 'rejected'].includes(u.status))
        .map(u => {
            const opts = roles.map(([v, k]) => `<option value="${v}"${(u.rentRole || '') === v ? ' selected' : ''}>${esc(t(k))}</option>`).join('');
            return `<div class="rent-row rent-access-row"><div><div class="rent-name">${esc(u.name || u.email || '')}</div>
                <div class="rent-sub">${esc(t('ui.rent.shop_role', { role: roleText(u.role) }))}</div></div>
                <select onchange="window.app.rentals.setRole('${js(u.id)}', this.value)">${opts}</select></div>`;
        }).join('');
    return `<p class="rent-help">${esc(t('ui.rent.access_help'))}</p>${rows || `<p class="rent-empty">${esc(t('ui.rent.no_users'))}</p>`}`;
}

async function loadUsers() {
    try {
        state.users = await FirebaseService.loadUsers();
    } catch (e) {
        console.warn('Rentals access: users not loaded', e?.code || e);
        state.users = [];
        UIManager.showToast(t('msg.rent.could_not_load'), 'error');
    }
    if (state.page === 'access') render();
}

async function setRole(userId, role) {
    if (!isOwner()) return;
    const value = ['manager', 'member'].includes(role) ? role : null;
    try {
        await store.setRentRole(userId, value);
        const u = state.users?.find(x => x.id === userId);
        if (u) u.rentRole = value;
        UIManager.showToast(t('msg.rent.access_saved'), 'success');
    } catch (e) {
        console.error('Rentals access not saved:', e);
        UIManager.showToast(t('msg.rent.save_failed'), 'error');
        render();
    }
}

// ---------- shared ----------

let dialogResolve = null;

/** Rentals form dialog (template #rentDialog); resolves true on Save. Inputs stay readable after it closes. */
function dialog(html) {
    dialogResolve?.(false);
    const box = document.getElementById('rentDialog');
    const body = document.getElementById('rentDialogBody');
    if (!box || !body) return Promise.resolve(false);
    body.innerHTML = html;
    box.hidden = false;
    body.querySelector('input, select')?.focus();
    return new Promise((resolve) => {
        dialogResolve = (v) => {
            box.hidden = true;
            dialogResolve = null;
            resolve(v === true);
        };
    });
}

async function saveRent(fn) {
    try {
        await fn();
        UIManager.showToast(t('msg.rent.saved'), 'success');
    } catch (e) {
        console.error('Rentals save failed:', e);
        UIManager.showToast(t('msg.rent.save_failed'), 'error');
    }
}

export const RentalsModule = {
    /** Shows a Rentals page and starts the listeners if they aren't running. */
    async enter(page = 'rent') {
        if (!rentalsRole()) return;
        // leave() (or another enter) while the page is loading wins: don't show or listen then.
        const token = ++state.entry;
        await ensureDom();
        if (token !== state.entry) return;
        state.page = PAGES.includes(page) && (page !== 'access' || isOwner()) ? page : 'rent';
        if (state.page === 'access') state.users = null;
        NavigationManager.showTab('rentals');
        if (!store.isAttached()) {
            state.month = monthKey();
            state.loaded.clear();
            state.errors.clear();
            state.charged.clear();
            store.attach(state.month, onData);
        }
        render();
    },

    /** Stops the listeners (another page or business opened, or sign-out). */
    leave() {
        state.entry++;
        clearTimeout(state.renderTimer);
        dialogResolve?.(false);
        store.detach();
    },

    api: {
        page: (p) => RentalsModule.enter(p),
        dialogClose: (v) => dialogResolve?.(v),
        pay, fillDue, remind, meter, editLease,
        addTenant, editTenant, archiveTenant, moveIn, moveOut, fillRent,
        addProperty, editProperty, archiveProperty, addUnit, editUnit, archiveUnit,
        setRole
    }
};

export const _test = { state, accounts, index, render, maybeCharge };
