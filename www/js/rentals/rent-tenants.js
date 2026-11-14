/**
 * @fileoverview Rentals › Tenants: the list (search; Advanced: filters, sort, details), the tenant's own screen
 * (dues, lease, actions; less used ones under ⋯) and the tenant forms: add, edit, remove, move in / out,
 * change of unit, Change rent, meter reading. Loaded with import() by rentals.js only when used.
 * @module rentals/rent-tenants
 */

import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { formatINR, whatsAppReminderUrl } from '../utils/due-reminder.js';
import { moneyHtml, moneyInText } from '../ui/components.js';
import { icon } from '../ui/icons.js';
import { openExternal } from '../utils/open-external.js';
import { t, getLang } from '../i18n/index.js';
import { AuditService } from '../services/audit.js';
import * as store from './rent-store.js';
import { isShareToken } from './rent-public.js';
import { tenantRows, tenantDues } from './rent-views.js';
import {
    monthLabel, chargeDue, chargeStatus, buildRentReminderText, increaseDue, meterBill, tenantError, leaseError, isMonth, addMonths, ELEC_MODES, elecMode, mobile10
} from './rent-math.js';

const esc = (v) => Helpers.escapeHtml(v);
const js = (v) => Helpers.escapeJsAttr(v);
const money = (n) => { const h = moneyHtml(n); return h === '—' ? esc(formatINR(n)) : h; };
const et = (key, p) => esc(t(key, p));
const byId = (id) => document.getElementById(id);
const fail = (key, p) => UIManager.showToast(t(key, p), 'error');
const btn = (cls, fn, args, key, icon = '', attrs = '') => `<button type="button" class="btn${cls}"${attrs} data-onclick="rentals.${fn}(${args})">${icon}${et(key)}</button>`;
const lbl = (key, field) => `<label class="field rent-label">${et(key)}${field}</label>`;
const phones = (tn) => `${icon('phone', 'i-sm')}${esc(tn.phone)}${tn.phone2 ? `, ${esc(tn.phone2)}` : ''}`;
const val = (id) => (byId(id)?.value ?? '').trim();

/** rentals.js's context, set by every exported call. */
let c = null;

// ---------- The list ----------

const FILTERS = ['all', 'owes', 'late', 'nounit'];
const SORTS = ['name', 'due', 'since'];

function statusOf(due) {
    if (due.total <= 0) return '';
    return due.late ? c.badge('late', 'ui.rent.status_late') : due.partial ? c.badge('partial', 'ui.rent.status_partial') : c.badge('due', 'ui.rent.status_due');
}

function listRows(d, adv) {
    const ix = c.index(d);
    const rows = tenantRows(d, c.state.month);
    const v = c.state.tenantList;
    const lease = new Map(d.leases.map(l => [l.tenantId, l]));
    const q = v.q.trim().toLowerCase();
    const list = d.tenants.map(tn => ({ tn, lease: lease.get(tn.id) || null, due: tenantDues(rows, tn.id) }))
        .filter(x => !q || [x.tn.name, x.tn.phone, x.tn.phone2, x.lease ? c.placeOf(ix, x.lease.unitId) : ''].some(s => String(s || '').toLowerCase().includes(q)))
        .filter(x => !adv || v.filter === 'all' || (v.filter === 'owes' ? x.due.total > 0 : v.filter === 'late' ? x.due.late : !x.lease));
    const by = adv ? v.sort : 'name';
    list.sort((a, b) => (by === 'due' ? b.due.total - a.due.total : by === 'since' ? String(b.lease?.startDate || '').localeCompare(String(a.lease?.startDate || '')) : 0)
        || a.tn.name.localeCompare(b.tn.name));
    return list.map(({ tn, lease: l, due }) => {
        const where = l ? esc(c.placeOf(ix, l.unitId)) : et('ui.rent.no_unit');
        const more = adv ? [tn.phone ? phones(tn) : '',
            l ? `${moneyInText(t('ui.rent.rent_terms', { amount: formatINR(l.rent), day: l.dueDay }), l.rent)} ${c.elecTag(l)}` : '', l?.startDate ? esc(c.sinceText(l)) : '',
            isMonth(l?.agreementEnd) ? et('ui.rent.agr_till', { month: monthLabel(l.agreementEnd, getLang()) }) : '', tn.notes ? esc(tn.notes) : ''].filter(Boolean) : [];
        return `<button type="button" class="row rent-entry" data-tenant="${esc(tn.id)}" data-onclick="rentals.openTenant('${js(tn.id)}')">
            <span class="rent-entry-head"><span class="row-main"><span class="row-title">${esc(tn.name)}</span><span class="row-meta">${where}</span>
                ${more.map(x => `<span class="rent-sub">${x}</span>`).join('')}</span>
            <span class="row-trail">${due.total > 0 ? `<span class="row-amt">${money(due.total)}</span>` : ''}${statusOf(due)}</span></span>
        </button>`;
    }).join('') || `<p class="empty">${et(d.tenants.length ? 'ui.rent.no_match' : 'ui.rent.no_tenants_hint')}</p>`;
}

function renderTenants(d) {
    const adv = c.state.mode === 'advanced';
    const v = c.state.tenantList;
    const search = d.tenants.length > 8 || v.q ? `<input class="input" type="search" id="rentTenantSearch" value="${esc(v.q)}" placeholder="${et('ui.rent.search_tenants')}" aria-label="${et('ui.rent.search_tenants')}" data-oninput="rentals.tenantList('q', this.value)">` : '';
    const add = c.canWrite ? btn(' btn-primary', 'addTenant', '', 'ui.rent.add_tenant', icon('plus', 'i-sm')) : '';
    const chip = (k, cur, field, key) => `<button type="button" class="chip" aria-pressed="${k === cur ? 'true' : 'false'}" data-onclick="rentals.tenantList('${field}', '${k}')">${et(key)}</button>`;
    const tools = adv ? `<div class="rent-chips" role="group">${FILTERS.map(k => chip(k, v.filter, 'filter', `ui.rent.tfilter_${k}`)).join('')}</div>
        <div class="rent-chips" role="group">${SORTS.map(k => chip(k, v.sort, 'sort', `ui.rent.tsort_${k}`)).join('')}</div>` : '';
    // Moved-out tenants whose link is still on (it stays readable until turned off).
    const ix = c.index(d);
    const endedLinks = adv && c.isManager ? d.linked.filter(l => l.status === 'ended').map(l => `<div class="row rent-entry">
            <div class="row-title">${esc(ix.tenants.get(l.tenantId)?.name || t('ui.rent.no_name'))}</div>
            <div class="row-meta">${et('ui.rent.moved_out')} · ${esc(monthLabel(l.endMonth, getLang()))}</div>
            <div class="rent-actions">${btn(' btn-sm', 'shareLink', `'${js(l.id)}'`, 'ui.rent.link_on', icon('link', 'i-sm'))}</div>
        </div>`).join('') : '';
    return `<div class="rent-toolbar">${search}${add}</div>${tools}
        <div class="panel rent-tenant-list" id="rentTenantList">${listRows(d, adv)}</div>
        ${endedLinks ? `<h3 class="rent-section-title">${et('ui.rent.links_moved_out')}</h3><div class="panel">${endedLinks}</div>` : ''}`;
}

/** Search redraws only the list, so the box keeps its focus. */
function tenantList(field, value) {
    const v = c.state.tenantList;
    if (field === 'q') v.q = String(value ?? '');
    else if (field === 'filter' && FILTERS.includes(value)) v.filter = value;
    else if (field === 'sort' && SORTS.includes(value)) v.sort = value;
    else return;
    const list = byId('rentTenantList');
    if (field === 'q' && list) list.innerHTML = listRows(store.snapshot(), c.state.mode === 'advanced');
    else c.render();
}

// ---------- The tenant's screen ----------

function monthLine(ch, lang, place) {
    const s = chargeStatus(ch);
    const e = ch.electricity;
    return `<li>${esc(monthLabel(ch.month, lang))}${place ? ` · ${esc(place)}` : ''}: ${money(chargeDue(ch))}
        ${c.badge(s.status === 'partial' ? 'partial' : 'due', s.status === 'partial' ? 'ui.rent.status_partial' : 'ui.rent.status_due')}${s.late ? ` ${c.badge('late', 'ui.rent.status_late')}` : ''}
        ${e ? `<span class="rent-sub">${moneyInText(t('ui.rent.incl_electricity', { amount: formatINR(e.amount), units: e.units }), e.amount)}</span>` : ''}</li>`;
}

function renderTenant(d, id) {
    const tn = d.tenants.find(x => x.id === id);
    if (!tn) return null;
    const ix = c.index(d);
    const lang = getLang();
    const lease = d.leases.find(l => l.tenantId === id) || null;
    const due = tenantDues(tenantRows(d, c.state.month), id);
    const owing = due.rows.filter(r => r.dues.total > 0);
    const w = c.canWrite;
    const tid = js(id);
    const lid = lease ? js(lease.id) : '';
    const linked = lease || d.linked.find(l => l.tenantId === id) || null;
    const menu = [
        w ? btn(' btn-ghost', 'editTenant', `'${tid}'`, 'ui.rent.edit') : '',
        lease && c.isManager ? btn(' btn-ghost', 'agreement', `'${lid}'`, 'ui.rent.agr_btn') : '',
        linked && c.isManager ? btn(' btn-ghost', 'shareLink', `'${js(linked.id)}'`, isShareToken(linked.shareToken) ? 'ui.rent.link_on' : 'ui.rent.link_make') : '',
        lease && w ? btn(' btn-ghost', 'changeUnit', `'${tid}'`, 'ui.rent.change_unit') : '',
        !lease && w ? btn(' btn-ghost tone-neg', 'archiveTenant', `'${tid}'`, 'ui.rent.remove') : ''
    ].filter(Boolean);
    const several = new Set(due.charges.map(x => x.leaseId)).size > 1;
    const months = due.charges.map(x => monthLine(x, lang, several ? c.placeOf(ix, x.unitId, x.unitLabel || '') : '')).join('');
    const first = owing[0];
    const payActs = first ? `${w ? btn(' btn-primary', 'pay', `'${js(first.leaseId)}'`, 'ui.rent.record_payment', '', ' data-rent-pay') : ''}
        ${w ? owing.slice(1).map(r => `<button type="button" class="btn" data-rent-pay data-onclick="rentals.pay('${js(r.leaseId)}')">${et('ui.rent.collect_at', { place: c.placeOf(ix, r.unitId, r.unitLabel || '') })}</button>`).join('') : ''}
        ${btn(' btn-success', 'remindTenant', `'${tid}'`, 'ui.rent.whatsapp', icon('wa', 'i-sm'))}` : '';
    const current = lease ? d.charges.find(x => x.leaseId === lease.id && x.month === c.state.month) : null;
    const inc = lease ? increaseDue(lease, c.state.month) : { due: false };
    const meterBtn = lease && w && current && elecMode(lease) === 'meter' && (!current.electricity || c.isManager)
        ? btn('', 'meter', `'${lid}'`, 'ui.rent.meter_reading', icon('bolt', 'i-sm')) : '';
    const leaseCard = lease ? `<section class="panel panel-pad rent-box">
            <h4 class="rent-section-title">${et('ui.rent.lease')}</h4>
            <div>${moneyInText(t('ui.rent.rent_terms', { amount: formatINR(lease.rent), day: lease.dueDay }), lease.rent)} ${c.elecTag(lease)}</div>
            ${lease.startDate ? `<div class="rent-sub">${esc(c.sinceText(lease))}</div>` : ''}
            ${isMonth(lease.agreementEnd) ? `<div class="rent-sub">${et('ui.rent.agr_till', { month: monthLabel(lease.agreementEnd, lang) })}</div>` : ''}
            ${inc.due ? `<div class="notice info rent-increase">${icon('trend', 'i-sm')}<span class="grow">${moneyInText(t('ui.rent.increase_due', { pct: inc.pct, amount: formatINR(inc.newRent) }), inc.newRent)}</span></div>` : ''}
            <div class="rent-actions">${w ? btn('', 'editLease', `'${lid}'`, 'ui.rent.update_rent') : ''}${meterBtn}
                ${w ? btn(' btn-ghost tone-neg', 'moveOut', `'${lid}'`, 'ui.rent.move_out') : ''}</div>
        </section>`
        : `<section class="panel panel-pad rent-box"><p class="empty">${et('ui.rent.no_unit')}.</p>${w ? btn('', 'moveIn', `'${tid}'`, 'ui.rent.let_unit') : ''}</section>`;
    return `<div class="rent-detail" data-tenant-detail="${esc(id)}">
        <div class="rent-detail-bar">${btn(' btn-ghost btn-sm', 'back', '', 'ui.nav.tenants', icon('chevL', 'i-sm'))}
            ${menu.length ? `<details class="rent-menu"><summary class="btn btn-ghost btn-icon" aria-label="${et('ui.rent.more_actions')}">${icon('dots')}</summary><div class="panel rent-menu-list">${menu.join('')}</div></details>` : ''}</div>
        <h3 class="rent-detail-title" id="rentDetailTitle" tabindex="-1">${esc(tn.name)}</h3>
        <div class="rent-sub">${tn.phone ? `${phones(tn)} · ` : ''}${lease ? esc(c.placeOf(ix, lease.unitId)) : et('ui.rent.no_unit')}</div>
        ${tn.notes ? `<div class="rent-sub">${esc(tn.notes)}</div>` : ''}
        <section class="panel panel-pad rent-box">
            ${due.total > 0 ? `<div class="rent-entry-head"><span class="rent-owes">${moneyInText(t('ui.rent.owes', { amount: formatINR(due.total) }), due.total)}</span><span>${statusOf(due)}</span></div>
                <ul class="rent-months">${months}</ul>` : `<p class="empty">${et('ui.rent.no_rent_due')}</p>`}
            ${current?.adv > 0 ? `<div class="rent-sub">${moneyInText(t('ui.rent.adv_next', { amount: formatINR(current.adv) }), current.adv)}</div>` : ''}
            <div class="rent-actions">${payActs}${c.receiptsBtn(id)}${btn('', 'deposit', `'${tid}'`, 'ui.rent.dep_btn', icon('coins', 'i-sm'))}</div>
        </section>
        ${leaseCard}
    </div>`;
}

/** WhatsApp reminder for everything the tenant owes, over all their tenancies (what the screen shows). */
function remindTenant(id) {
    const d = store.snapshot();
    const tn = d.tenants.find(x => x.id === id);
    const due = tenantDues(tenantRows(d, c.state.month), id);
    if (!tn || due.total <= 0) return;
    const lease = d.leases.find(l => l.tenantId === id) || null;
    const last = due.rows[due.rows.length - 1];
    const text = buildRentReminderText({
        tenantName: tn.name, place: c.placeOf(c.index(d), lease ? lease.unitId : last.unitId, last.unitLabel || ''), charges: due.charges,
        lastMonth: lease ? c.state.month : last.lease?.endMonth || c.state.month, lang: getLang(), since: lease?.startDate || '',
        link: c.linkFor(lease || d.linked.find(l => l.tenantId === id))
    });
    if (!tn.phone) UIManager.showToast(t('msg.rent.no_phone'), 'info');
    openExternal(whatsAppReminderUrl(text, tn.phone));
}

// ---------- Forms ----------

/** Add tenant: name and phones; a unit picked here starts their tenancy (Move in) straight after. */
async function addTenant() {
    const open = c.dialog(`<h3>${et('ui.rent.add_tenant')}</h3>
        ${lbl('ui.rent.tenant_name', '<input class="input" id="rentTenantName" type="text" maxlength="80">')}
        ${lbl('ui.rent.phone_required', '<input class="input" id="rentTenantPhone" type="tel" maxlength="20" inputmode="tel">')}
        ${lbl('ui.rent.phone2', '<input class="input" id="rentTenantPhone2" type="tel" maxlength="20" inputmode="tel">')}
        ${lbl('ui.rent.notes', '<input class="input" id="rentTenantNotes" type="text" maxlength="500">')}
        <div id="rentTenantUnitBox"></div>`);
    void c.unitUi('fillPicker', 'rentTenantUnitBox', 'rentTenantUnit');
    if (!await open) return;
    const raw = { name: val('rentTenantName'), phone: val('rentTenantPhone'), phone2: val('rentTenantPhone2'), notes: val('rentTenantNotes') };
    const err = tenantError(raw);
    if (err) return fail(err);
    const tn = { name: raw.name, phone: mobile10(raw.phone), notes: raw.notes, ...(raw.phone2 ? { phone2: mobile10(raw.phone2) } : {}) };
    const unitId = val('rentTenantUnit');
    if (unitId) return c.unitUi('toUnit', tn, unitId);
    await c.saveRent(() => store.addTenant(tn));
}

/** Name, phones and notes only: moving is Change unit / Move out (owner decision, #157 UX redesign). */
async function editTenant(id) {
    const tn = store.snapshot().tenants.find(x => x.id === id);
    if (!tn) return;
    const ok = await c.dialog(`<h3>${et('ui.rent.edit')}</h3>
        ${lbl('ui.rent.tenant_name', `<input class="input" id="rentEditName" type="text" maxlength="80" value="${esc(tn.name)}">`)}
        ${lbl('ui.rent.phone_required', `<input class="input" id="rentEditPhone" type="tel" maxlength="20" value="${esc(tn.phone || '')}">`)}
        ${lbl('ui.rent.phone2', `<input class="input" id="rentEditPhone2" type="tel" maxlength="20" value="${esc(tn.phone2 || '')}">`)}
        ${lbl('ui.rent.notes', `<input class="input" id="rentEditNotes" type="text" maxlength="500" value="${esc(tn.notes || '')}">`)}`);
    if (!ok) return;
    const raw = { name: val('rentEditName'), phone: val('rentEditPhone'), phone2: val('rentEditPhone2'), notes: val('rentEditNotes') };
    const err = tenantError(raw);
    if (err) return fail(err);
    const next = { name: raw.name, phone: mobile10(raw.phone), notes: raw.notes, phone2: raw.phone2 ? mobile10(raw.phone2) : null };
    if (await c.saveRent(() => store.updateTenant(id, next)) === null) return;
    c.refreshLinkNames(l => l.tenantId === id);
}

async function archiveTenant(id) {
    const name = store.snapshot().tenants.find(x => x.id === id)?.name || '';
    if (!await UIManager.showModal(t('msg.rent.confirm_remove_tenant', { name }), t('ui.rent.remove'), true)) return;
    if (await c.saveRent(() => store.updateTenant(id, { archived: true })) !== null) c.back();
}

/** A tenant without a unit moves into a vacant one. */
async function moveIn(tenantId) {
    const tenant = store.snapshot().tenants.find(x => x.id === tenantId);
    if (tenant) await c.unitUi('toUnit', tenant);
}

/** The same change of unit as before, picked here; it confirms with the tenant, both units and the dues. */
async function changeUnit(tenantId) {
    const tenant = store.snapshot().tenants.find(x => x.id === tenantId);
    if (tenant) await c.unitUi('toUnit', { id: tenant.id, name: tenant.name });
}

/** Electricity from the unit's sub-meter, added to this month's charge. */
async function meter(leaseId) {
    const d = store.snapshot();
    const lease = d.leases.find(l => l.id === leaseId);
    const charge = d.charges.find(x => x.leaseId === leaseId && x.month === c.state.month);
    if (!lease || !charge) return;
    if (elecMode(lease) !== 'meter') return UIManager.showToast(t('msg.rent.no_meter_billing'), 'info');
    const unit = d.units.find(u => u.id === lease.unitId);
    const e = charge.electricity;
    if (e && !c.isManager) return UIManager.showToast(t('msg.rent.meter_manager_only'), 'info');
    const prev = e?.prev ?? unit?.lastReading ?? 0;
    // Previous reading is fixed once known; the rate too for members (rules check both).
    const prevLocked = e != null || unit?.lastReading != null;
    const defaultRate = e?.rate ?? unit?.meterRate ?? (await c.defaults()).meterRate ?? '';
    const rateLocked = !c.isManager && unit?.meterRate != null;
    const ok = await c.dialog(`<h3>${et('ui.rent.meter_reading')}: ${esc(monthLabel(c.state.month, getLang()))}</h3>
        ${lbl('ui.rent.meter_prev', `<input class="input" id="rentMeterPrev" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(prev)}"${prevLocked ? ' readonly' : ''}>`)}
        ${lbl('ui.rent.meter_curr', `<input class="input" id="rentMeterCurr" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(e?.curr ?? '')}">`)}
        ${lbl('ui.rent.meter_rate', `<input class="input" id="rentMeterRate" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(defaultRate)}"${rateLocked ? ' readonly' : ''}>`)}
        <p class="rent-help">${et('ui.rent.meter_help')}</p>`);
    if (!ok) return;
    let bill;
    try {
        bill = meterBill({ prev: val('rentMeterPrev'), curr: val('rentMeterCurr'), rate: val('rentMeterRate') });
    } catch (_) {
        return fail('msg.rent.bad_reading');
    }
    if (!unit) return fail('msg.rent.save_failed');
    try {
        await store.recordMeter(charge.id, unit.id, bill);
        UIManager.showToast(t('msg.rent.meter_saved', { amount: formatINR(bill.amount), units: bill.units }), 'success');
        AuditService.log('RENT_METER', { chargeId: charge.id, units: bill.units, rate: bill.rate, amount: bill.amount }).catch(c.auditWarn);
    } catch (err) {
        fail(err?.message === 'below_paid' ? 'msg.rent.below_paid' : 'msg.rent.save_failed');
    }
}

/**
 * Rent, due day and yearly increase % of a lease. The yearly increase is only a
 * reminder: the new rent is saved here after it was agreed with the tenant.
 */
async function editLease(leaseId) {
    const lease = store.snapshot().leases.find(l => l.id === leaseId);
    if (!lease) return;
    const inc = increaseDue(lease, c.state.month);
    const ok = await c.dialog(`<h3>${et('ui.rent.update_rent')}</h3>
        ${inc.due ? `<p class="notice info rent-increase">${icon('trend', 'i-sm')}<span class="grow">${moneyInText(t('ui.rent.increase_due', { pct: inc.pct, amount: formatINR(inc.newRent) }), inc.newRent)}</span></p>` : ''}
        ${lbl('ui.rent.monthly_rent', `<input class="input" id="rentEditRent" type="number" inputmode="decimal" min="0" step="1" value="${esc(inc.due ? inc.newRent : lease.rent)}">`)}
        ${lbl('ui.rent.due_day', `<input class="input" id="rentEditDay" type="number" min="1" max="28" step="1" value="${esc(lease.dueDay)}">`)}
        ${lbl('ui.rent.increase_pct', `<input class="input" id="rentEditPct" type="number" min="0" max="100" step="0.5" value="${esc(inc.pct)}">`)}
        ${c.elecFieldsHtml(elecMode(lease), lease.meterNo || '')}
        <p class="rent-help">${et('ui.rent.rent_change_note')}</p>`);
    if (!ok) return;
    const next = {
        rent: Number(val('rentEditRent')), dueDay: Number(val('rentEditDay')),
        increasePct: Number(val('rentEditPct')), startMonth: lease.startMonth
    };
    const err = leaseError(next);
    if (err) return fail(err);
    // The new rent applies from the first month not yet charged, so the next
    // yearly reminder counts from there.
    const appliesFrom = isMonth(lease.chargedThrough) && lease.chargedThrough >= c.state.month ? addMonths(c.state.month, 1) : c.state.month;
    const reviewed = next.rent !== lease.rent || inc.due;
    const mode = ELEC_MODES.includes(val('rentTElec')) ? val('rentTElec') : elecMode(lease);
    const fields = { rent: next.rent, dueDay: next.dueDay, increasePct: next.increasePct, elecMode: mode };
    const meterNo = val('rentTMeterNo');
    if (mode === 'own' && meterNo) fields.meterNo = meterNo.slice(0, 40);
    if (reviewed) fields.rentSince = appliesFrom;
    await c.saveRent(() => store.updateLease(leaseId, fields));
    if (next.rent !== lease.rent) AuditService.log('RENT_CHANGE', { leaseId, from: lease.rent, to: next.rent }).catch(c.auditWarn);
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
    const earliest = !c.isManager && isMonth(lease.chargedThrough) && lease.chargedThrough > lease.startMonth
        ? lease.chargedThrough : lease.startMonth;
    const ix = c.index(d);
    const ok = await c.dialog(`<h3>${et('ui.rent.move_out_who', { name: ix.tenants.get(lease.tenantId)?.name || '', place: c.placeOf(ix, lease.unitId) })}</h3>
        <p>${et('msg.rent.move_out_note')}</p>
        ${lbl('ui.rent.last_month', `<input class="input" id="rentEndMonth" type="month" min="${esc(earliest)}" max="${esc(c.state.month)}" value="${esc(c.state.month)}">`)}`);
    if (!ok) return;
    const end = val('rentEndMonth');
    if (!isMonth(end) || end < lease.startMonth || end > c.state.month) return fail('msg.rent.bad_end_month');
    if (end < earliest) return fail('msg.rent.backdate_manager_only');
    const names = {
        tenantName: d.tenants.find(x => x.id === lease.tenantId)?.name || '',
        unitLabel: d.units.find(x => x.id === lease.unitId)?.label || ''
    };
    try {
        await store.endLease(leaseId, end, c.state.month, names);
        UIManager.showToast(t('msg.rent.saved'), 'success');
        AuditService.log('RENT_MOVE_OUT', { leaseId, endMonth: end }).catch(c.auditWarn);
        void c.depUi('afterMoveOut', lease.tenantId, leaseId);
    } catch (e) {
        console.warn('Move-out failed:', e?.code || e?.message || e);
        const key = e?.message === 'later_paid' ? 'msg.rent.later_paid'
            : e?.message === 'bad_month' ? 'msg.rent.bad_end_month' : 'msg.rent.save_failed';
        fail(key);
    }
}

export const tenants = Object.fromEntries(Object.entries({
    renderTenants, renderTenant, tenantList, remindTenant, addTenant, editTenant, archiveTenant, moveIn, changeUnit, moveOut, meter, editLease
}).map(([k, f]) => [k, (ctx, ...a) => { c = ctx; return f(...a); }]));
