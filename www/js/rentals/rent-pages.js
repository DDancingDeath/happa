/**
 * @fileoverview Rentals Tenants and Properties pages, their forms, the tenant section of a
 * move-in, meter reading, rent change and move-out. Loaded with import() by rentals.js only
 * when one of them is used, so it is not precached (docs/rentals-design.md §4).
 * @module rentals/rent-pages
 */

import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { todayLocalISO, localISODaysAgo } from '../utils/dates.js';
import { formatINR } from '../utils/due-reminder.js';
import { t, getLang } from '../i18n/index.js';
import { AuditService } from '../services/audit.js';
import * as store from './rent-store.js';
import { isShareToken } from './rent-public.js';
import { UNIT_TYPES, unitType, unitExtraError } from './rent-views.js';
import {
    PROPERTY_KINDS, MAX_PROPERTIES, MAX_UNITS_PER_PROPERTY, normalizeRentSettings,
    monthLabel, increaseDue, meterBill, propertyError, unitError, tenantError, leaseError, moveInError, isMonth, addMonths,
    ELEC_MODES, elecMode, mobile10, firstMonthRent
} from './rent-math.js';

const esc = (v) => Helpers.escapeHtml(v);
const js = (v) => Helpers.escapeJsAttr(v);
const money = (n) => esc(formatINR(n));
const et = (key, p) => esc(t(key, p));
const byId = (id) => document.getElementById(id);
const fail = (key, p) => UIManager.showToast(t(key, p), 'error');
const btn = (cls, fn, args, key, icon = '', attrs = '') => `<button type="button" class="rent-btn${cls}"${attrs} data-onclick="rentals.${fn}(${args})">${icon}${et(key)}</button>`;
const lbl = (key, field) => `<label class="rent-label">${et(key)}${field}</label>`;
const val = (id) => (byId(id)?.value ?? '').trim();

const kindLabel = (k) => t(`ui.rent.kind_${PROPERTY_KINDS.includes(k) ? k : 'other'}`);

const confirmRemove = () => UIManager.showModal(t('msg.rent.confirm_remove'), t('ui.rent.remove'), true);

/** After a rename: linked tenants' pages show the new tenant / property / unit names. */
function refreshLinkNames(affects) {
    const d = store.snapshot();
    const ix = c.index(d);
    d.linked.filter(affects).forEach(l => {
        store.renameInLink(l, { tenantName: ix.tenants.get(l.tenantId)?.name, ...c.linkPlace(ix, l.unitId) })
            .catch(e => console.warn('Tenant link names not updated:', e?.code || e));
    });
}

/** Runs a save; resolves the save's result (true when it has none), or null when it failed. */
async function saveRent(fn) {
    try {
        const out = await fn();
        UIManager.showToast(t('msg.rent.saved'), 'success');
        return out ?? true;
    } catch (e) {
        console.error('Rentals save failed:', e);
        fail(e?.code === 'permission-denied' ? 'msg.rent.not_allowed' : 'msg.rent.save_failed');
        return null;
    }
}

/** What rentals.js lends (unitCtx() plus page helpers); set by every exported call. */
let c = null;
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
    const ok = await c.dialog(`<h3>⚡ ${et('ui.rent.meter_reading')}: ${esc(monthLabel(c.state.month, getLang()))}</h3>
        ${lbl('ui.rent.meter_prev', `<input id="rentMeterPrev" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(prev)}"${prevLocked ? ' readonly' : ''}>`)}
        ${lbl('ui.rent.meter_curr', `<input id="rentMeterCurr" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(e?.curr ?? '')}">`)}
        ${lbl('ui.rent.meter_rate', `<input id="rentMeterRate" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(defaultRate)}"${rateLocked ? ' readonly' : ''}>`)}
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
        ${inc.due ? `<p class="rent-increase">📈 ${et('ui.rent.increase_due', { pct: inc.pct, amount: formatINR(inc.newRent) })}</p>` : ''}
        ${lbl('ui.rent.monthly_rent', `<input id="rentEditRent" type="number" inputmode="decimal" min="0" step="1" value="${esc(inc.due ? inc.newRent : lease.rent)}">`)}
        ${lbl('ui.rent.due_day', `<input id="rentEditDay" type="number" min="1" max="28" step="1" value="${esc(lease.dueDay)}">`)}
        ${lbl('ui.rent.increase_pct', `<input id="rentEditPct" type="number" min="0" max="100" step="0.5" value="${esc(inc.pct)}">`)}
        ${elecFieldsHtml(elecMode(lease), lease.meterNo || '')}
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
    await saveRent(() => store.updateLease(leaseId, fields));
    if (next.rent !== lease.rent) AuditService.log('RENT_CHANGE', { leaseId, from: lease.rent, to: next.rent }).catch(c.auditWarn);
}

// ---------- Tenants ----------

function renderTenants(d) {
    const ix = c.index(d);
    const leaseByTenant = new Map(d.leases.map(l => [l.tenantId, l]));
    const manage = c.canWrite;
    const form = manage ? `<div class="rent-form">
            <h3>${et('ui.rent.add_tenant')}</h3>
            <input id="rentTenantName" type="text" maxlength="80" placeholder="${et('ui.rent.tenant_name')}">
            <input id="rentTenantPhone" type="tel" maxlength="20" placeholder="${et('ui.rent.phone_required')}">
            <input id="rentTenantPhone2" type="tel" maxlength="20" placeholder="${et('ui.rent.phone2')}">
            <input id="rentTenantNotes" type="text" maxlength="500" placeholder="${et('ui.rent.notes')}">
            <div id="rentTenantUnitBox"></div>
            ${btn(' rent-btn-primary', 'addTenant', '', 'ui.rent.add')}
        </div>` : '';
    const rows = [...d.tenants].sort((a, b) => a.name.localeCompare(b.name)).map(tn => {
        const lease = leaseByTenant.get(tn.id);
        const where = lease ? `${esc(c.placeOf(ix, lease.unitId))} · ${et('ui.rent.rent_terms', { amount: formatINR(lease.rent), day: lease.dueDay })} ${c.elecTag(lease)}${lease.startDate ? ` · ${esc(c.sinceText(lease))}` : ''}${isMonth(lease.agreementEnd) ? ` · ${et('ui.rent.agr_till', { month: monthLabel(lease.agreementEnd, getLang()) })}` : ''}`
            : et('ui.rent.no_unit');
        const id = js(tn.id);
        const actions = !manage ? '' : `<div class="rent-actions">
            ${lease && c.isManager ? btn('', 'shareLink', `'${js(lease.id)}'`, isShareToken(lease.shareToken) ? 'ui.rent.link_on' : 'ui.rent.link_make', '🔗 ') : ''}
            ${lease && c.isManager ? btn('', 'agreement', `'${js(lease.id)}'`, 'ui.rent.agr_btn', '📄 ') : ''}
            ${lease ? `${btn('', 'editLease', `'${js(lease.id)}'`, 'ui.rent.update_rent')}
                ${btn('', 'moveOut', `'${js(lease.id)}'`, 'ui.rent.move_out')}`
                : btn(' rent-btn-primary', 'moveIn', `'${id}'`, 'ui.rent.move_in')}
            ${btn('', 'editTenant', `'${id}'`, 'ui.rent.edit')}
            ${c.receiptsBtn(tn.id)}${btn('', 'deposit', `'${id}'`, 'ui.rent.dep_btn', '💰 ')}
            ${lease ? '' : btn('', 'archiveTenant', `'${id}'`, 'ui.rent.remove')}
        </div>`;
        return `<div class="rent-row"><div class="rent-name">${esc(tn.name)}</div>
            <div class="rent-sub">${tn.phone ? `📞 ${esc(tn.phone)}${tn.phone2 ? `, ${esc(tn.phone2)}` : ''} · ` : ''}${where}</div>
            ${tn.notes ? `<div class="rent-sub">${esc(tn.notes)}</div>` : ''}${actions}</div>`;
    }).join('');
    // Moved-out tenants whose link is still on (it stays readable until turned off).
    const endedLinks = c.isManager ? d.linked.filter(l => l.status === 'ended').map(l => `<div class="rent-row">
            <div class="rent-name">${esc(ix.tenants.get(l.tenantId)?.name || t('ui.rent.no_name'))}</div>
            <div class="rent-sub">${et('ui.rent.moved_out')} · ${esc(monthLabel(l.endMonth, getLang()))}</div>
            <div class="rent-actions">${btn('', 'shareLink', `'${js(l.id)}'`, 'ui.rent.link_on', '🔗 ')}</div>
        </div>`).join('') : '';
    return form + (manage ? `<div class="rent-actions">${btn('', 'deposits', '', 'ui.rent.dep_held_list', '💰 ')}</div>` : '') + (rows || `<p class="rent-empty">${et('ui.rent.no_tenants')}</p>`)
        + (endedLinks ? `<h3 class="rent-month-title">${et('ui.rent.links_moved_out')}</h3>${endedLinks}` : '');
}

async function addTenant() {
    const raw = { name: val('rentTenantName'), phone: val('rentTenantPhone'), phone2: val('rentTenantPhone2'), notes: val('rentTenantNotes') };
    const err = tenantError(raw);
    if (err) return fail(err);
    const tn = { name: raw.name, phone: mobile10(raw.phone), notes: raw.notes, ...(raw.phone2 ? { phone2: mobile10(raw.phone2) } : {}) };
    const unitId = val('rentTenantUnit');
    if (unitId) return c.unitUi('toUnit', tn, unitId);
    await saveRent(() => store.addTenant(tn));
}

async function editTenant(id) {
    const d = store.snapshot();
    const tn = d.tenants.find(x => x.id === id);
    if (!tn) return;
    const lease = d.leases.find(l => l.tenantId === id);
    const u = await c.unitMod().catch(() => null);
    const ok = await c.dialog(`<h3>${et('ui.rent.edit')}</h3>
        ${lbl('ui.rent.tenant_name', `<input id="rentEditName" type="text" maxlength="80" value="${esc(tn.name)}">`)}
        ${lbl('ui.rent.phone_required', `<input id="rentEditPhone" type="tel" maxlength="20" value="${esc(tn.phone || '')}">`)}
        ${lbl('ui.rent.phone2', `<input id="rentEditPhone2" type="tel" maxlength="20" value="${esc(tn.phone2 || '')}">`)}
        ${lbl('ui.rent.notes', `<input id="rentEditNotes" type="text" maxlength="500" value="${esc(tn.notes || '')}">`)}
        ${u ? u.unitPickHtml(c.unitCtx(), 'rentEditUnit', d, { current: lease?.unitId }) : ''}`);
    if (!ok) return;
    const raw = { name: val('rentEditName'), phone: val('rentEditPhone'), phone2: val('rentEditPhone2'), notes: val('rentEditNotes') };
    const err = tenantError(raw);
    if (err) return fail(err);
    const next = { name: raw.name, phone: mobile10(raw.phone), notes: raw.notes, phone2: raw.phone2 ? mobile10(raw.phone2) : null };
    const pick = u ? val('rentEditUnit') : lease?.unitId || '';
    if (await saveRent(() => store.updateTenant(id, next)) === null) return;
    refreshLinkNames(l => l.tenantId === id);
    if (pick === (lease?.unitId || '')) return;
    if (pick) await c.unitUi('toUnit', { id, name: next.name }, pick);
    else await moveOut(lease.id);
}

async function archiveTenant(id) {
    if (!await confirmRemove()) return;
    await saveRent(() => store.updateTenant(id, { archived: true }));
}

// ---------- Tenant section (Add unit with its tenant, Add tenant to a vacant unit, Move in) ----------

/** Electricity choice of a lease (and the tenant's own meter number when that is chosen). */
function elecFieldsHtml(mode, meterNo = '') {
    return `${lbl('ui.rent.elec_mode', `
            <select id="rentTElec" data-onchange="rentals.tenantElec(this)">${ELEC_MODES.map(m => `<option value="${m}"${m === mode ? ' selected' : ''}>${et(`ui.rent.elec_${m}`)}</option>`).join('')}</select>`)}
        <div id="rentTOwnBox"${mode === 'own' ? '' : ' hidden'}>${lbl('ui.rent.own_meter_no', `<input id="rentTMeterNo" type="text" maxlength="40" value="${esc(meterNo)}">`)}</div>`;
}

/**
 * The tenant fields. toggle: Add unit shows them only after "Occupied — add tenant
 * now"; fixedTenant: Move in from the Tenants page; newUnit: opening meter reading.
 */
function tenantSectionHtml({ toggle = false, rent = 0, fixedTenant = null, newUnit = false, meterRate = '', defs = normalizeRentSettings(null), deposit = 0, elec = '' } = {}) {
    const d = store.snapshot();
    const busy = new Set(d.leases.map(l => l.tenantId));
    const free = d.tenants.filter(x => !busy.has(x.id)).sort((a, b) => a.name.localeCompare(b.name));
    // Settings › Rentals defaults fill a NEW lease; existing leases keep their own values.
    const rate = meterRate !== '' && meterRate != null ? meterRate : (defs.meterRate ?? '');
    const mode = elec || (rate !== '' && rate != null ? 'meter' : 'included');
    const who = fixedTenant
        ? `<input type="hidden" id="rentTPick" value="${esc(fixedTenant.id)}"><p class="rent-name">${esc(fixedTenant.name)}</p>`
        : `${lbl('ui.rent.tenant_pick', `<select id="rentTPick" data-onchange="rentals.tenantPick(this)">
                <option value="">${et('ui.rent.tenant_new')}</option>${free.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>`)}
            <div id="rentTNewBox">
                ${lbl('ui.rent.tenant_name', `<input id="rentTName" type="text" maxlength="80">`)}
                ${lbl('ui.rent.phone_required', `<input id="rentTPhone" type="tel" maxlength="20" inputmode="tel">`)}
                ${lbl('ui.rent.phone2', `<input id="rentTPhone2" type="tel" maxlength="20" inputmode="tel">`)}
            </div>`;
    const box = `<div id="rentTBox" class="rent-tenant-section"${toggle ? ' hidden' : ''}>
        <h4 class="rent-group-title">${et('ui.rent.tenant_if_occupied')}</h4>
        ${who}
        ${lbl('ui.rent.monthly_rent', `<input id="rentTRent" type="number" inputmode="decimal" min="0" step="1" value="${esc(rent || 0)}">`)}
        ${lbl('ui.rent.start_date', `<input id="rentTDate" type="date" value="${esc(todayLocalISO())}">`)}
        <label class="rent-check"><input id="rentTProRate" type="checkbox"> ${et('ui.rent.pro_rate_first')}</label>
        ${lbl('ui.rent.due_day', `<input id="rentTDay" type="number" min="1" max="28" step="1" value="${esc(defs.dueDay)}">`)}
        ${lbl('ui.rent.increase_pct', `<input id="rentTPct" type="number" min="0" max="100" step="0.5" value="${esc(defs.increasePct)}">`)}
        ${lbl('ui.rent.deposit', `<input id="rentTDeposit" type="number" inputmode="decimal" min="0" step="1" value="${esc(deposit)}">`)}
        <p class="rent-help">${et('ui.rent.deposit_note')}</p>
        ${elecFieldsHtml(mode)}
        ${newUnit ? `<div id="rentTMeterBox"${mode === 'meter' ? '' : ' hidden'}>
            ${lbl('ui.rent.opening_reading', `<input id="rentTOpen" type="number" inputmode="decimal" min="0" step="0.01">`)}
            ${lbl('ui.rent.meter_rate', `<input id="rentTRate" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(rate)}">`)}
        </div>` : ''}
    </div>`;
    return (toggle ? `<label class="rent-check rent-occupied-toggle"><input id="rentTOn" type="checkbox" data-onchange="rentals.tenantToggle(this)"> ${et('ui.rent.occupied_add_tenant')}</label>` : '') + box;
}

function tenantToggle(cb) {
    const box = byId('rentTBox');
    if (box) box.hidden = !cb?.checked;
}

function tenantPick(sel) {
    const box = byId('rentTNewBox');
    if (box) box.hidden = !!sel?.value;
}

function tenantElec(sel) {
    const own = byId('rentTOwnBox');
    const meterBox = byId('rentTMeterBox');
    if (own) own.hidden = sel?.value !== 'own';
    if (meterBox) meterBox.hidden = sel?.value !== 'meter';
}

const checked = (id) => !!byId(id)?.checked;
const numOrNull = (id) => (val(id) === '' ? null : Number(val(id)));

/**
 * Reads the tenant section: null when Add unit is saved as Vacant, else
 * {error} or {tenant | tenantId, lease, meter}. Nothing is saved on an error.
 */
function readTenantSection({ newUnit = false, given = null } = {}) {
    if (byId('rentTOn') && !checked('rentTOn')) return null;
    const tenantId = given ? null : val('rentTPick') || null;
    let tenant = given;
    if (!tenantId && !tenant) {
        const raw = { name: val('rentTName'), phone: val('rentTPhone'), phone2: val('rentTPhone2') };
        const err = tenantError(raw);
        if (err) return { error: err };
        tenant = { name: raw.name, phone: mobile10(raw.phone), ...(raw.phone2 ? { phone2: mobile10(raw.phone2) } : {}) };
    }
    const startDate = val('rentTDate');
    const elec = ELEC_MODES.includes(val('rentTElec')) ? val('rentTElec') : 'included';
    const lease = {
        rent: Number(val('rentTRent')), dueDay: Number(val('rentTDay')),
        startDate, startMonth: startDate.slice(0, 7), proRate: checked('rentTProRate'),
        deposit: Number(val('rentTDeposit') || 0), increasePct: Number(val('rentTPct') || 0),
        elecMode: elec, meterNo: elec === 'own' ? val('rentTMeterNo').slice(0, 40) : ''
    };
    const meter = newUnit && elec === 'meter' ? { reading: numOrNull('rentTOpen'), rate: numOrNull('rentTRate') } : null;
    const err = moveInError(lease, meter, c.state.month, c.isOwner ? '' : localISODaysAgo(EDIT_DAYS));
    return err ? { error: err } : { tenant, tenantId, lease, meter };
}

/** Saves a move-in from the tenant section (or a change of unit: `save`); true when saved. */
async function saveMoveIn({ unit, newUnit, occ, defs, from = null, save = null }) {
    try {
        const tenantName = occ.tenant?.name || store.snapshot().tenants.find(x => x.id === occ.tenantId)?.name || '';
        const res = await (save ? save(tenantName) : store.moveIn({
            unit, newUnit, tenant: occ.tenant, tenantId: occ.tenantId, tenantName, lease: occ.lease, meter: occ.meter, currentMonth: c.state.month
        }));
        const first = occ.lease.firstRent ?? firstMonthRent(occ.lease.rent, occ.lease.startDate, occ.lease.proRate);
        const moved = isShareToken(from?.shareToken);
        UIManager.showToast(t(`msg.rent.${from ? 'unit_changed' : 'moved_in'}${res.charged ? '_charged' : ''}`, { amount: formatINR(first) })
            + (moved ? ` ${t('msg.rent.link_moved')}` : '') + (res.oldKept ? ` ${t('msg.rent.old_month_kept')}` : res.oldCapped != null ? ` ${t('msg.rent.old_month_capped', { amount: formatINR(res.oldCapped) })}` : ''), 'success');
        AuditService.log(from ? 'RENT_UNIT_CHANGE' : 'RENT_MOVE_IN', {
            tenantId: res.tenantId, unitId: res.unitId, rent: occ.lease.rent, startDate: occ.lease.startDate, fromLeaseId: from?.id || null
        }).catch(c.auditWarn);
        if (defs?.tenantLink && c.isManager && !moved) await c.linkUi('linkNewLease', { unit, res, occ, defs });
        return true;
    } catch (e) {
        console.error('Move-in not saved:', e);
        fail(MOVE_ERRORS.includes(e?.message) ? `msg.rent.${e.message}`
            : e?.code === 'unavailable' || navigator.onLine === false ? 'msg.rent.offline'
                : e?.code === 'permission-denied' ? 'msg.rent.not_allowed' : 'msg.rent.save_failed');
        return false;
    }
}
const MOVE_ERRORS = ['unit_taken', 'tenant_changed', 'later_paid', 'bad_move_date'];
const EDIT_DAYS = 2;

/** Tenants page: move an existing tenant into a vacant unit. */
async function moveIn(tenantId) {
    const tenant = store.snapshot().tenants.find(x => x.id === tenantId);
    if (tenant) await c.unitUi('toUnit', tenant);
}

function fillRent(select) {
    const rent = select?.selectedOptions?.[0]?.getAttribute('data-rent');
    const input = byId('rentTRent');
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
    const earliest = !c.isManager && isMonth(lease.chargedThrough) && lease.chargedThrough > lease.startMonth
        ? lease.chargedThrough : lease.startMonth;
    const ok = await c.dialog(`<h3>${et('ui.rent.move_out')}</h3>
        <p>${et('msg.rent.move_out_note')}</p>
        ${lbl('ui.rent.last_month', `<input id="rentEndMonth" type="month" min="${esc(earliest)}" max="${esc(c.state.month)}" value="${esc(c.state.month)}">`)}`);
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

// ---------- Properties ----------

function renderProperties(d) {
    const ix = c.index(d);
    const manage = c.canWrite;
    const kinds = PROPERTY_KINDS.map(k => `<option value="${k}">${esc(kindLabel(k))}</option>`).join('');
    const form = manage ? `<div class="rent-form">
            <h3>${et('ui.rent.add_property')}</h3>
            <input id="rentPropName" type="text" maxlength="80" placeholder="${et('ui.rent.property_name')}">
            <input id="rentPropAddress" type="text" maxlength="200" placeholder="${et('ui.rent.address')}">
            <select id="rentPropKind">${kinds}</select>
            ${btn(' rent-btn-primary', 'addProperty', '', 'ui.rent.add')}
        </div>` : '';
    const report = c.isManager ? `<div class="rent-actions">${btn('', 'yearReport', '', 'ui.rent.yr_btn', '📊 ')}</div>` : '';
    const leaseById = ix.leases;
    const cards = [...d.properties].sort((a, b) => a.name.localeCompare(b.name)).map(p => {
        const units = d.units.filter(u => u.propertyId === p.id).sort((a, b) => a.label.localeCompare(b.label));
        const pid = js(p.id);
        const unitRows = units.map(u => {
            const lease = u.leaseId ? leaseById.get(u.leaseId) : null;
            const who = lease ? esc(ix.tenants.get(lease.tenantId)?.name || t('ui.rent.occupied')) : et('ui.rent.vacant');
            const uid = js(u.id);
            const size = [u.floor ? t('ui.rent.floor_value', { floor: u.floor }) : '', Number.isFinite(u.area) ? t('ui.rent.area_value', { area: u.area }) : ''].filter(Boolean).join(' · ');
            return `<li class="rent-unit"><span><span class="rent-kind">${esc(c.typeLabel(unitType(u)))}</span> <strong>${esc(u.label)}</strong> · ${money(u.rent || 0)} · ${who}${size ? ` · ${esc(size)}` : ''}</span>
                ${manage ? `<span>${btn(' rent-btn-small', 'editUnit', `'${uid}'`, 'ui.rent.edit')}
                ${u.leaseId ? '' : btn(' rent-btn-small', 'archiveUnit', `'${uid}'`, 'ui.rent.remove')}</span>` : ''}</li>`;
        }).join('');
        const occupied = units.some(u => u.leaseId);
        return `<div class="rent-row">
            <div class="rent-name">${esc(p.name)} <span class="rent-kind">${esc(kindLabel(p.kind))}</span></div>
            ${p.address ? `<div class="rent-sub">${esc(p.address)}</div>` : ''}
            <ul class="rent-units">${unitRows || `<li class="rent-empty">${et('ui.rent.no_units')}</li>`}</ul>
            ${manage ? `<div class="rent-actions">
                ${btn(' rent-btn-primary', 'addUnit', `'${pid}'`, 'ui.rent.add_unit')}
                ${btn('', 'editProperty', `'${pid}'`, 'ui.rent.edit')}
                ${btn('', 'expenses', `'${pid}'`, 'ui.rent.exp_btn', '💸 ')}
                ${occupied ? '' : btn('', 'archiveProperty', `'${pid}'`, 'ui.rent.remove')}
            </div>` : ''}
        </div>`;
    }).join('');
    return form + report + (cards || `<p class="rent-empty">${et('ui.rent.no_properties')}</p>`);
}

async function addProperty() {
    const kind = val('rentPropKind');
    const p = { name: val('rentPropName'), address: val('rentPropAddress'), kind: PROPERTY_KINDS.includes(kind) ? kind : 'other', notes: '' };
    const err = propertyError(p);
    if (err) return fail(err);
    if (store.snapshot().properties.length >= MAX_PROPERTIES) {
        return fail('msg.rent.max_properties', { max: MAX_PROPERTIES });
    }
    await saveRent(() => store.addProperty(p));
}

async function editProperty(id) {
    const p = store.snapshot().properties.find(x => x.id === id);
    if (!p) return;
    const kinds = PROPERTY_KINDS.map(k => `<option value="${k}"${k === p.kind ? ' selected' : ''}>${esc(kindLabel(k))}</option>`).join('');
    const ok = await c.dialog(`<h3>${et('ui.rent.edit')}</h3>
        ${lbl('ui.rent.property_name', `<input id="rentEditPropName" type="text" maxlength="80" value="${esc(p.name)}">`)}
        ${lbl('ui.rent.address', `<input id="rentEditPropAddress" type="text" maxlength="200" value="${esc(p.address || '')}">`)}
        ${lbl('ui.rent.kind', `<select id="rentEditPropKind">${kinds}</select>`)}`);
    if (!ok) return;
    const kind = val('rentEditPropKind');
    const next = { name: val('rentEditPropName'), address: val('rentEditPropAddress'), kind: PROPERTY_KINDS.includes(kind) ? kind : 'other' };
    const err = propertyError(next);
    if (err) return fail(err);
    await saveRent(() => store.updateProperty(id, next));
    refreshLinkNames(l => l.propertyId === id);
}

async function archiveProperty(id) {
    if (!await confirmRemove()) return;
    const units = store.snapshot().units.filter(u => u.propertyId === id);
    if (units.some(u => u.leaseId)) return fail('msg.rent.has_tenant');
    await saveRent(async () => {
        for (const u of units) await store.updateUnit(u.id, { archived: true });
        await store.updateProperty(id, { archived: true });
    });
}

async function unitDialog(title, unit, { withTenant = false, defs = null } = {}) {
    const ok = await c.dialog(`<h3>${esc(title)}</h3>
        ${lbl('ui.rent.unit_label', `<input id="rentUnitLabel" type="text" maxlength="60" value="${esc(unit?.label || '')}">`)}
        ${lbl('ui.rent.unit_type', `<select id="rentUnitType">${UNIT_TYPES.map(k => `<option value="${k}"${k === unitType(unit) ? ' selected' : ''}>${esc(c.typeLabel(k))}</option>`).join('')}</select>`)}
        ${lbl('ui.rent.monthly_rent', `<input id="rentUnitRent" type="number" inputmode="decimal" min="0" step="1" value="${esc(unit?.rent ?? 0)}">`)}
        ${lbl('ui.rent.unit_area', `<input id="rentUnitArea" type="number" inputmode="decimal" min="0" step="1" value="${esc(unit?.area ?? '')}">`)}
        ${lbl('ui.rent.unit_floor', `<input id="rentUnitFloor" type="text" maxlength="20" value="${esc(unit?.floor || '')}">`)}
        ${withTenant ? tenantSectionHtml({ toggle: true, rent: unit?.rent ?? 0, newUnit: true, defs: defs || undefined }) : ''}`);
    if (!ok) return null;
    const area = val('rentUnitArea');
    const u = {
        label: val('rentUnitLabel'), rent: Number(val('rentUnitRent') || 0),
        type: UNIT_TYPES.includes(val('rentUnitType')) ? val('rentUnitType') : 'flat',
        area: area === '' ? null : Number(area), floor: val('rentUnitFloor') || null
    };
    const err = unitError(u) || unitExtraError(u);
    if (err) { fail(err); return null; }
    if (!withTenant) return u;
    // The tenant's rent defaults to the unit rent typed above.
    const rentInput = byId('rentTRent');
    if (rentInput && Number(rentInput.value) === 0 && u.rent > 0) rentInput.value = String(u.rent);
    const occ = readTenantSection({ newUnit: true });
    if (occ?.error) { fail(occ.error); return null; }
    return { ...u, occ };
}

async function addUnit(propertyId) {
    if (store.snapshot().units.filter(x => x.propertyId === propertyId).length >= MAX_UNITS_PER_PROPERTY) {
        return fail('msg.rent.max_units', { max: MAX_UNITS_PER_PROPERTY });
    }
    const defs = await c.defaults();
    const res = await unitDialog(t('ui.rent.add_unit'), null, { withTenant: true, defs });
    if (!res) return;
    const { occ, ...u } = res;
    if (!occ) { await saveRent(() => store.addUnit({ propertyId, ...u })); return; }
    await saveMoveIn({ unit: { propertyId, ...u }, newUnit: true, occ, defs });
}

async function editUnit(id) {
    const unit = store.snapshot().units.find(x => x.id === id);
    if (!unit) return;
    const u = await unitDialog(t('ui.rent.edit'), unit);
    if (!u) return;
    await saveRent(() => store.updateUnit(id, u));
    refreshLinkNames(l => l.unitId === id);
}

async function archiveUnit(id) {
    if (!await confirmRemove()) return;
    await saveRent(() => store.updateUnit(id, { archived: true }));
}

const NAMES = {
    meter, editLease, renderTenants, addTenant, editTenant, archiveTenant, tenantSectionHtml, tenantToggle, tenantPick, tenantElec,
    readTenantSection, saveMoveIn, moveIn, fillRent, moveOut, renderProperties, addProperty, editProperty, archiveProperty, addUnit, editUnit, archiveUnit
};
/** Each function takes rentals.js's context first, like the other lazy Rentals files. */
export const pages = Object.fromEntries(Object.entries(NAMES).map(([k, f]) => [k, (ctx, ...a) => { c = ctx; return f(...a); }]));