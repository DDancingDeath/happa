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
import { AuditService } from '../services/audit.js';
import { rentalsRole } from '../ui/business-switcher.js';
import * as store from './rent-store.js';
import { AppState } from '../utils/state.js';
import { APP_IDENTITY } from '../config/app-identity.js';
import { isShareToken, publicLink } from './rent-public.js';
import {
    UNIT_TYPES, VIEW_KEY, unitType, unitRows, summarize, propertySummaries, groupByType, filterRows,
    placeText, typedPlace, unitExtraError
} from './rent-views.js';
import {
    PROPERTY_KINDS, PAYMENT_MODES, MAX_PROPERTIES, MAX_UNITS_PER_PROPERTY, normalizeRentSettings,
    monthKey, monthLabel, monthsToCharge, chargeStatus, chargeDue, leaseDues, buildRentReminderText,
    increaseDue, meterBill, propertyError, unitError, tenantError, leaseError, isMonth, addMonths,
    ELEC_MODES, elecMode, mobile10, dateLabel, firstMonthRent
} from './rent-math.js';

const PAGES = ['rent', 'tenants', 'properties'];
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
    renderTimer: null,
    entry: 0,
    view: savedView(),
    openProperty: '',
    filters: { propertyId: '', type: '', status: '', q: '', sort: 'desc' }
};

function savedView() {
    try { return localStorage.getItem(VIEW_KEY) === 'units' ? 'units' : 'properties'; } catch (_) { return 'properties'; }
}
let domReady = null;

// Owner decision: anyone with a rentals role records payments and updates records.
const canWrite = () => !!rentalsRole();
const isOwner = () => rentalsRole() === 'owner';
const isManager = () => ['owner', 'manager'].includes(rentalsRole());
const auditWarn = (e) => console.warn('Rentals audit entry not written:', e?.code || e);
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

const typeLabel = (type) => t(`ui.rent.utype_${UNIT_TYPES.includes(type) ? type : 'flat'}`);
const typeWord = (type) => t(`ui.rent.uword_${UNIT_TYPES.includes(type) ? type : 'flat'}`);

/** "⚡ meter" / "⚡ included" / "⚡ own meter" tag for a lease. */
const elecTag = (lease) => `<span class="rent-tag">${esc(t(`ui.rent.elec_tag_${elecMode(lease)}`))}</span>`;
const sinceText = (lease) => (lease?.startDate ? t('ui.rent.since', { date: dateLabel(lease.startDate) }) : '');

/**
 * The unit's type when it is really known: its own type, else what the property
 * kind says (flat / shop / godown). Untyped units in a house or plot get no type
 * word in names tenants see (no guessed "Flat").
 */
const KIND_TYPES = { flat: 'flat', shop: 'commercial', godown: 'godown' };
function knownType(unit, prop) {
    if (UNIT_TYPES.includes(unit?.type)) return unit.type;
    return KIND_TYPES[prop?.kind] || null;
}

/** "Flat 2B, Gupta Bhawan" in the chosen language (reminders, lists). */
function placeOf(ix, unitId, fallback = '') {
    const unit = ix.units.get(unitId);
    if (!unit) return fallback;
    const prop = ix.properties.get(unit.propertyId);
    const type = knownType(unit, prop);
    return typedPlace(type ? typeWord(type) : '', unit.label, prop?.name);
}

/** For the tenant link: "2B, Gupta Bhawan" + the type id (the page adds the word in its own language). */
function linkPlace(ix, unitId) {
    const unit = ix.units.get(unitId);
    if (!unit) return { place: '' };
    const prop = ix.properties.get(unit.propertyId);
    return { place: placeText(unit.label, prop?.name), unitType: knownType(unit, prop) };
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
    if (!['properties', 'units', 'tenants', 'leases', 'openCharges', 'monthCharges'].every(k => state.loaded.has(k))) {
        root.innerHTML = `<p class="rent-empty">${esc(t('ui.rent.loading'))}</p>`;
        return;
    }
    const d = store.snapshot();
    root.innerHTML = state.page === 'tenants' ? renderTenants(d)
        : state.page === 'properties' ? renderProperties(d)
        : renderRent(d);
}

/** Settings › Rentals defaults; built-in defaults when they can't be read. */
const defaults = () => store.loadSettings().catch((e) => {
    console.warn('Rentals settings not loaded:', e?.code || e);
    return normalizeRentSettings(null);
});

/** Name on the tenant's page: Settings › Rentals header, else the business name. */
const headerName = (s) => s?.receiptHeader || AppState.settings?.shopName || '';

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

/** Paid / Part paid / Due / Late / Vacant for a unit row (RENT-10). */
function rowBadge(r) {
    return r.status === 'vacant' ? badge('vacant', 'ui.rent.vacant')
        : r.status === 'paid' ? badge('paid', 'ui.rent.status_paid')
        : r.status === 'late' ? badge('late', 'ui.rent.status_late')
        : r.status === 'partial' ? badge('partial', 'ui.rent.status_partial')
        : badge('due', 'ui.rent.status_due');
}

function totalsCards(sum) {
    return [
        ['ui.rent.expected', sum.expected],
        ['ui.rent.collected', sum.collected],
        ['ui.rent.pending_month', sum.pending],
        ['ui.rent.outstanding', sum.due]
    ].map(([k, v]) => `<div class="rent-card"><div class="rent-card-label">${esc(t(k))}</div><div class="rent-card-value">${money(v)}</div></div>`).join('');
}

/** "6 flats · 3 commercial" in the chosen language. */
function typeCounts(byType) {
    return UNIT_TYPES.filter(k => byType[k]).map(k => t(`ui.rent.count_${k}`, { n: byType[k] })).join(' · ');
}

function renderRent(d) {
    const ix = index(d);
    const lang = getLang();
    const rows = unitRows(d, state.month);
    const view = state.view === 'units' ? 'units' : 'properties';
    const sw = `<div class="rent-viewswitch" role="group">
        <button type="button" class="filter-btn${view === 'properties' ? ' active' : ''}" aria-pressed="${view === 'properties'}" onclick="window.app.rentals.setView('properties')">${esc(t('ui.rent.view_properties'))}</button>
        <button type="button" class="filter-btn${view === 'units' ? ' active' : ''}" aria-pressed="${view === 'units'}" onclick="window.app.rentals.setView('units')">${esc(t('ui.rent.view_units'))}</button>
    </div>`;
    const body = view === 'units' ? renderUnitView(d, rows) : renderPropertyView(d, ix, rows);
    return `<h3 class="rent-month-title">${esc(monthLabel(state.month, lang))}</h3>
        ${sw}
        ${body}
        ${renderMovedOut(d, ix)}`;
}

function renderPropertyView(d, ix, rows) {
    if (state.openProperty && d.properties.some(p => p.id === state.openProperty)) return renderPropertyDetail(d, ix, rows);
    state.openProperty = '';
    const cards = propertySummaries(d.properties, rows).map(({ property: p, summary: s }) => `
        <button type="button" class="rent-row rent-prop-card" onclick="window.app.rentals.openProperty('${js(p.id)}')">
            <div class="rent-row-head">
                <div><div class="rent-name">${esc(p.name)}</div>
                    <div class="rent-sub">${esc(typeCounts(s.byType) || t('ui.rent.no_units'))}</div>
                    <div class="rent-sub">${esc(t('ui.rent.occupancy', { occupied: s.occupied, vacant: s.vacant }))}${s.late ? ` · ${esc(t('ui.rent.late_count', { n: s.late }))}` : ''}</div></div>
                <div class="rent-row-right"><div class="rent-due">${money(s.pending)}</div><div class="rent-sub">${esc(t('ui.rent.pending_month'))}</div></div>
            </div>
            <div class="rent-sub">${esc(t('ui.rent.prop_month_line', { expected: formatINR(s.expected), collected: formatINR(s.collected) }))}</div>
        </button>`).join('');
    return `<div class="rent-cards">${totalsCards(summarize(rows))}</div>
        ${cards || `<p class="rent-empty">${esc(t('ui.rent.no_properties'))}</p>`}`;
}

function renderPropertyDetail(d, ix, rows) {
    const p = ix.properties.get(state.openProperty);
    const mine = rows.filter(r => r.propertyId === p.id);
    const s = summarize(mine);
    const groups = groupByType(mine).map(g => `
        <h4 class="rent-group-title">${esc(typeLabel(g.type))} (${g.rows.length})</h4>
        ${g.rows.map(r => unitRowHtml(r, d, { showProperty: false })).join('')}`).join('');
    return `<div class="rent-detail-head">
            <button type="button" class="rent-btn rent-btn-small" onclick="window.app.rentals.openProperty('')">← ${esc(t('ui.rent.all_properties'))}</button>
            <h3 class="rent-name">${esc(p.name)}</h3>
            <div class="rent-sub">${esc(typeCounts(s.byType))} · ${esc(t('ui.rent.occupancy', { occupied: s.occupied, vacant: s.vacant }))}</div>
        </div>
        <div class="rent-cards">${totalsCards(s)}</div>
        ${groups || `<p class="rent-empty">${esc(t('ui.rent.no_units'))}</p>`}`;
}

/** One unit: tenant, rent, status, amount due, open months, quick actions. */
function unitRowHtml(r, d, { showProperty = true } = {}) {
    const lang = getLang();
    const lease = r.leaseId ? d.leases.find(l => l.id === r.leaseId) : null;
    const dues = lease ? leaseDues(d.charges, lease.id) : { charges: [], total: 0 };
    const current = lease ? d.charges.find(c => c.leaseId === lease.id && c.month === state.month) : null;
    const head = esc(typedPlace(typeWord(r.type), r.label, showProperty ? r.propertyName : ''));
    const extra = [r.floor ? t('ui.rent.floor_value', { floor: r.floor }) : '', r.area ? t('ui.rent.area_value', { area: r.area }) : '']
        .filter(Boolean).map(esc).join(' · ');
    const who = lease
        ? `${esc(r.tenantName || t('ui.rent.no_name'))} · ${esc(t('ui.rent.rent_terms', { amount: formatINR(lease.rent), day: lease.dueDay }))} ${elecTag(lease)}${lease.startDate ? ` · ${esc(sinceText(lease))}` : ''}`
        : `${esc(t('ui.rent.vacant'))} · ${money(r.rent)}`;
    const months = dues.charges.map(c => monthLine(c, lang)).join('');
    const inc = lease ? increaseDue(lease, state.month) : { due: false };
    const increase = inc.due
        ? `<div class="rent-increase">📈 ${esc(t('ui.rent.increase_due', { pct: inc.pct, amount: formatINR(inc.newRent) }))}
            <button type="button" class="rent-btn rent-btn-small" onclick="window.app.rentals.editLease('${js(lease.id)}')">${esc(t('ui.rent.update_rent'))}</button></div>`
        : '';
    const actions = lease ? ((dues.total > 0
        ? `<button type="button" class="rent-btn rent-btn-primary" onclick="window.app.rentals.pay('${js(lease.id)}')">${esc(t('ui.rent.record_payment'))}</button>
           <button type="button" class="rent-btn rent-btn-wa" onclick="window.app.rentals.remind('${js(lease.id)}')">${esc(t('ui.rent.whatsapp_reminder'))}</button>`
        : '') + (current && elecMode(lease) === 'meter' && (!current.electricity || isManager())
        ? `<button type="button" class="rent-btn" onclick="window.app.rentals.meter('${js(lease.id)}')">⚡ ${esc(t('ui.rent.meter_reading'))}</button>`
        : '') + receiptsBtn(lease.tenantId)) : (canWrite()
        ? `<button type="button" class="rent-btn rent-btn-primary" onclick="window.app.rentals.addTenantToUnit('${js(r.unitId)}')">${esc(t('ui.rent.add_tenant'))}</button>`
        : '');
    return `<div class="rent-row" data-unit="${esc(r.unitId)}">
        <div class="rent-row-head">
            <div><div class="rent-name">${head}</div>
                <div class="rent-sub">${who}</div>${extra ? `<div class="rent-sub">${extra}</div>` : ''}</div>
            <div class="rent-row-right">${rowBadge(r)}<div class="rent-due">${money(r.due)}</div></div>
        </div>
        ${months ? `<ul class="rent-months">${months}</ul>` : ''}
        ${increase}
        ${actions ? `<div class="rent-actions">${actions}</div>` : ''}
    </div>`;
}

function renderUnitView(d, rows) {
    const f = state.filters;
    const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
    const props = [...d.properties].sort((a, b) => a.name.localeCompare(b.name));
    const controls = `<div class="rent-filters">
        <select aria-label="${esc(t('ui.rent.filter_property'))}" onchange="window.app.rentals.filterUnits('propertyId', this.value)">
            ${opt('', t('ui.rent.all_properties'), f.propertyId)}${props.map(p => opt(p.id, p.name, f.propertyId)).join('')}</select>
        <select aria-label="${esc(t('ui.rent.filter_type'))}" onchange="window.app.rentals.filterUnits('type', this.value)">
            ${opt('', t('ui.rent.all_types'), f.type)}${UNIT_TYPES.map(k => opt(k, typeLabel(k), f.type)).join('')}</select>
        <select aria-label="${esc(t('ui.rent.filter_status'))}" onchange="window.app.rentals.filterUnits('status', this.value)">
            ${opt('', t('ui.rent.all_statuses'), f.status)}${['occupied', 'vacant', 'late', 'due'].map(k => opt(k, t(`ui.rent.filter_${k}`), f.status)).join('')}</select>
        <input type="search" value="${esc(f.q)}" placeholder="${esc(t('ui.rent.search_units'))}" aria-label="${esc(t('ui.rent.search_units'))}" oninput="window.app.rentals.filterUnits('q', this.value)">
        <button type="button" class="rent-btn rent-btn-small" onclick="window.app.rentals.filterUnits('sort', '${f.sort === 'desc' ? 'asc' : 'desc'}')">${esc(t(f.sort === 'desc' ? 'ui.rent.sort_due_desc' : 'ui.rent.sort_due_asc'))}</button>
    </div>`;
    return `${controls}<div id="rentUnitList">${unitListHtml(d, rows)}</div>`;
}

/** The filtered unit list and its totals (same RENT-9 sum as the property view). */
function unitListHtml(d, rows) {
    const shown = filterRows(rows, state.filters);
    return `<div class="rent-cards">${totalsCards(summarize(shown))}</div>
        ${shown.map(r => unitRowHtml(r, d)).join('') || `<p class="rent-empty">${esc(t('ui.rent.no_matching_units'))}</p>`}`;
}

/** Tenants who moved out and still owe rent (not on any unit any more). */
function renderMovedOut(d, ix) {
    const gone = accounts(d, ix).filter(a => !a.lease && a.dues.total > 0);
    if (!gone.length) return '';
    return `<h3 class="rent-month-title">${esc(t('ui.rent.moved_out_due'))}</h3>${gone.map(a => `<div class="rent-row">
        <div class="rent-row-head"><div><div class="rent-name">${esc(a.name || t('ui.rent.no_name'))}</div>
            <div class="rent-sub">${esc(a.place)} · ${esc(t('ui.rent.moved_out'))}</div></div>
            <div class="rent-row-right"><div class="rent-due">${money(a.dues.total)}</div></div></div>
        <ul class="rent-months">${a.dues.charges.map(c => monthLine(c, getLang())).join('')}</ul>
        <div class="rent-actions">
            <button type="button" class="rent-btn rent-btn-primary" onclick="window.app.rentals.pay('${js(a.leaseId)}')">${esc(t('ui.rent.record_payment'))}</button>
            <button type="button" class="rent-btn rent-btn-wa" onclick="window.app.rentals.remind('${js(a.leaseId)}')">${esc(t('ui.rent.whatsapp_reminder'))}</button>
        </div></div>`).join('')}`;
}

function setView(view) {
    state.view = view === 'units' ? 'units' : 'properties';
    try { localStorage.setItem(VIEW_KEY, state.view); } catch (_) { /* private mode */ }
    render();
}

function openProperty(id) {
    state.openProperty = id || '';
    render();
    document.getElementById('rentals')?.scrollIntoView?.({ block: 'start' });
}

/** Unit view filters: only the list redraws, so the search box keeps its focus. */
function filterUnits(field, value) {
    if (!['propertyId', 'type', 'status', 'q', 'sort'].includes(field)) return;
    state.filters = { ...state.filters, [field]: String(value ?? '') };
    if (field === 'sort') { render(); return; }
    const list = document.getElementById('rentUnitList');
    if (!list) { render(); return; }
    const d = store.snapshot();
    list.innerHTML = unitListHtml(d, unitRows(d, state.month));
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
    const d = store.snapshot();
    const ix = index(d);
    const s = await defaults();
    const lp = linkPlace(ix, charge?.unitId);
    const rc = {
        tenantName: ix.tenants.get(charge?.tenantId)?.name || charge?.tenantName || '',
        place: lp.place || charge?.unitLabel || '', ut: lp.unitType || null, biz: headerName(s), bizAddr: s.receiptAddress || ''
    };
    try {
        const res = await store.recordPayment(id, { amount, mode, ref, date }, rc);
        UIManager.showToast(t('msg.rent.payment_saved', { amount: formatINR(res.amount) }), 'success');
        AuditService.log('RENT_PAYMENT', {
            chargeId: id, month: charge?.month || '', amount: res.amount, mode, tenant: charge?.tenantName || '', receipt: res.receipt?.no || ''
        }).catch(auditWarn);
        if (res.receipt) void receiptUi('showReceipt', res.receipt);
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

// ---------- Receipts (rent-receipt.js, loaded on first use) ----------

/** Runs a rent-receipt.js function with what it needs from here (dialog, tenant link, who may cancel). */
function receiptUi(fn, ...args) {
    return import('./rent-receipt.js')
        .then(m => m[fn]({ dialog, linkOf: (id) => linkFor(findLease(id)), canVoid: isManager() }, ...args))
        .catch((e) => {
            console.error('Receipt not shown:', e);
            UIManager.showToast(t('msg.rent.could_not_load'), 'error');
        });
}

const receiptsBtn = (tenantId) => `<button type="button" class="rent-btn" onclick="window.app.rentals.receipts('${js(tenantId)}')">🧾 ${esc(t('ui.rcpt.receipts'))}</button>`;

function remind(leaseId) {
    const d = store.snapshot();
    const ix = index(d);
    const a = accounts(d, ix).find(x => x.leaseId === leaseId);
    if (!a || a.dues.total <= 0) return;
    const text = buildRentReminderText({
        tenantName: a.name, place: a.place, charges: a.dues.charges,
        lastMonth: a.lease?.endMonth || state.month, lang: getLang(), since: a.lease?.startDate || '',
        link: linkFor(a.lease || store.snapshot().linked.find(l => l.id === leaseId))
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
    if (elecMode(lease) !== 'meter') return UIManager.showToast(t('msg.rent.no_meter_billing'), 'info');
    const unit = d.units.find(u => u.id === lease.unitId);
    const e = charge.electricity;
    if (e && !isManager()) return UIManager.showToast(t('msg.rent.meter_manager_only'), 'info');
    const prev = e?.prev ?? unit?.lastReading ?? 0;
    // Previous reading is fixed once known; the rate too for members (rules check both).
    const prevLocked = e != null || unit?.lastReading != null;
    const defaultRate = e?.rate ?? unit?.meterRate ?? (await defaults()).meterRate ?? '';
    const rateLocked = !isManager() && unit?.meterRate != null;
    const ok = await dialog(`<h3>⚡ ${esc(t('ui.rent.meter_reading'))}: ${esc(monthLabel(state.month, getLang()))}</h3>
        <label class="rent-label">${esc(t('ui.rent.meter_prev'))}<input id="rentMeterPrev" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(prev)}"${prevLocked ? ' readonly' : ''}></label>
        <label class="rent-label">${esc(t('ui.rent.meter_curr'))}<input id="rentMeterCurr" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(e?.curr ?? '')}"></label>
        <label class="rent-label">${esc(t('ui.rent.meter_rate'))}<input id="rentMeterRate" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(defaultRate)}"${rateLocked ? ' readonly' : ''}></label>
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
        ${elecFieldsHtml(elecMode(lease), lease.meterNo || '')}
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
    const mode = ELEC_MODES.includes(val('rentTElec')) ? val('rentTElec') : elecMode(lease);
    const fields = { rent: next.rent, dueDay: next.dueDay, increasePct: next.increasePct, elecMode: mode };
    const meterNo = val('rentTMeterNo');
    if (mode === 'own' && meterNo) fields.meterNo = meterNo.slice(0, 40);
    if (reviewed) fields.rentSince = appliesFrom;
    await saveRent(() => store.updateLease(leaseId, fields));
    if (next.rent !== lease.rent) AuditService.log('RENT_CHANGE', { leaseId, from: lease.rent, to: next.rent }).catch(auditWarn);
}

// ---------- Tenant rent-history link (read-only, own unit only) ----------

/** Development data (collection names get a prefix) -> the link is marked so the page reads the same data. */
const isDevData = () => typeof window.getCollection === 'function' && window.getCollection('rent_public') !== 'rent_public';

/** Public site for the link (the APK's own origin isn't reachable by tenants). */
function linkOrigin() {
    const dev = typeof window !== 'undefined' && isDevData();
    const web = /^https?:$/.test(window.location?.protocol || '');
    return dev && web ? window.location.origin : APP_IDENTITY.siteUrl;
}

function linkFor(lease) {
    if (!isShareToken(lease?.shareToken)) return '';
    const params = new URLSearchParams(window.location?.search || '');
    return publicLink(linkOrigin(), lease.shareToken, {
        dev: isDevData(), emulator: params.get('emulator') === '1'
    });
}

function findLease(leaseId) {
    const d = store.snapshot();
    return d.leases.find(l => l.id === leaseId) || d.linked.find(l => l.id === leaseId) || null;
}

/** Owner/manager: make, share, replace or turn off the tenant's read-only link. */
async function shareLink(leaseId) {
    if (!isManager()) return;
    const lease = findLease(leaseId);
    if (!lease) return;
    const url = linkFor(lease);
    const id = js(leaseId);
    const body = url
        ? `<p class="rent-help">${esc(t('ui.rent.link_help'))}</p>
           <input id="rentLinkUrl" type="text" readonly value="${esc(url)}">
           <div class="rent-actions">
             <button type="button" class="rent-btn rent-btn-wa" onclick="window.app.rentals.linkAction('send', '${id}')">${esc(t('ui.rent.link_send'))}</button>
             <button type="button" class="rent-btn" onclick="window.app.rentals.linkAction('copy', '${id}')">${esc(t('ui.rent.link_copy'))}</button>
             <button type="button" class="rent-btn" onclick="window.app.rentals.linkAction('new', '${id}')">${esc(t('ui.rent.link_new'))}</button>
             <button type="button" class="rent-btn" onclick="window.app.rentals.linkAction('off', '${id}')">${esc(t('ui.rent.link_off'))}</button>
           </div>`
        : `<p class="rent-help">${esc(t('ui.rent.link_help'))}</p>
           <div class="rent-actions"><button type="button" class="rent-btn rent-btn-primary" onclick="window.app.rentals.linkAction('make', '${id}')">${esc(t('ui.rent.link_make'))}</button></div>`;
    await dialog(`<h3>🔗 ${esc(t('ui.rent.link_title'))}</h3>${body}`);
}

/** After a rename: linked tenants' pages show the new tenant / property / unit names. */
function refreshLinkNames(affects) {
    const d = store.snapshot();
    const ix = index(d);
    d.linked.filter(affects).forEach(l => {
        store.renameInLink(l, { tenantName: ix.tenants.get(l.tenantId)?.name, ...linkPlace(ix, l.unitId) })
            .catch(e => console.warn('Tenant link names not updated:', e?.code || e));
    });
}

async function linkAction(action, leaseId) {
    dialogResolve?.(false);
    const lease = findLease(leaseId);
    if (!lease || !isManager()) return;
    const d = store.snapshot();
    const ix = index(d);
    if (action === 'copy' || action === 'send') {
        const url = linkFor(lease);
        if (!url) return;
        if (action === 'copy') {
            try { await navigator.clipboard.writeText(url); UIManager.showToast(t('msg.rent.link_copied'), 'success'); } catch (_) { UIManager.showToast(url, 'info'); }
            return;
        }
        const tenant = ix.tenants.get(lease.tenantId);
        openExternal(whatsAppReminderUrl(t('msg.rent.link_message', { url }), tenant?.phone));
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
                ...linkPlace(ix, lease.unitId),
                shopName: headerName(await defaults())
            });
            UIManager.showToast(t('msg.rent.link_ready'), 'success');
        }
        AuditService.log(action === 'off' ? 'RENT_LINK_OFF' : 'RENT_LINK_ON', { leaseId }).catch(auditWarn);
        setTimeout(() => shareLink(leaseId), 300);
    } catch (e) {
        console.error('Tenant link not saved:', e);
        UIManager.showToast(t('msg.rent.save_failed'), 'error');
    }
}

// ---------- Tenants ----------

function renderTenants(d) {
    const ix = index(d);
    const leaseByTenant = new Map(d.leases.map(l => [l.tenantId, l]));
    const manage = canWrite();
    const form = manage ? `<div class="rent-form">
            <h3>${esc(t('ui.rent.add_tenant'))}</h3>
            <input id="rentTenantName" type="text" maxlength="80" placeholder="${esc(t('ui.rent.tenant_name'))}">
            <input id="rentTenantPhone" type="tel" maxlength="20" placeholder="${esc(t('ui.rent.phone_required'))}">
            <input id="rentTenantPhone2" type="tel" maxlength="20" placeholder="${esc(t('ui.rent.phone2'))}">
            <input id="rentTenantNotes" type="text" maxlength="500" placeholder="${esc(t('ui.rent.notes'))}">
            <button type="button" class="rent-btn rent-btn-primary" onclick="window.app.rentals.addTenant()">${esc(t('ui.rent.add'))}</button>
        </div>` : '';
    const rows = [...d.tenants].sort((a, b) => a.name.localeCompare(b.name)).map(tn => {
        const lease = leaseByTenant.get(tn.id);
        const where = lease ? `${esc(placeOf(ix, lease.unitId))} · ${esc(t('ui.rent.rent_terms', { amount: formatINR(lease.rent), day: lease.dueDay }))} ${elecTag(lease)}${lease.startDate ? ` · ${esc(sinceText(lease))}` : ''}`
            : esc(t('ui.rent.no_unit'));
        const id = js(tn.id);
        const actions = !manage ? '' : `<div class="rent-actions">
            ${lease && isManager() ? `<button type="button" class="rent-btn" onclick="window.app.rentals.shareLink('${js(lease.id)}')">🔗 ${esc(t(isShareToken(lease.shareToken) ? 'ui.rent.link_on' : 'ui.rent.link_make'))}</button>` : ''}
            ${lease ? `<button type="button" class="rent-btn" onclick="window.app.rentals.editLease('${js(lease.id)}')">${esc(t('ui.rent.update_rent'))}</button>
                <button type="button" class="rent-btn" onclick="window.app.rentals.moveOut('${js(lease.id)}')">${esc(t('ui.rent.move_out'))}</button>`
                : `<button type="button" class="rent-btn rent-btn-primary" onclick="window.app.rentals.moveIn('${id}')">${esc(t('ui.rent.move_in'))}</button>`}
            <button type="button" class="rent-btn" onclick="window.app.rentals.editTenant('${id}')">${esc(t('ui.rent.edit'))}</button>
            ${receiptsBtn(tn.id)}
            ${lease ? '' : `<button type="button" class="rent-btn" onclick="window.app.rentals.archiveTenant('${id}')">${esc(t('ui.rent.remove'))}</button>`}
        </div>`;
        return `<div class="rent-row"><div class="rent-name">${esc(tn.name)}</div>
            <div class="rent-sub">${tn.phone ? `📞 ${esc(tn.phone)}${tn.phone2 ? `, ${esc(tn.phone2)}` : ''} · ` : ''}${where}</div>
            ${tn.notes ? `<div class="rent-sub">${esc(tn.notes)}</div>` : ''}${actions}</div>`;
    }).join('');
    // Moved-out tenants whose link is still on (it stays readable until turned off).
    const endedLinks = isManager() ? d.linked.filter(l => l.status === 'ended').map(l => `<div class="rent-row">
            <div class="rent-name">${esc(ix.tenants.get(l.tenantId)?.name || t('ui.rent.no_name'))}</div>
            <div class="rent-sub">${esc(t('ui.rent.moved_out'))} · ${esc(monthLabel(l.endMonth, getLang()))}</div>
            <div class="rent-actions"><button type="button" class="rent-btn" onclick="window.app.rentals.shareLink('${js(l.id)}')">🔗 ${esc(t('ui.rent.link_on'))}</button></div>
        </div>`).join('') : '';
    return form + (rows || `<p class="rent-empty">${esc(t('ui.rent.no_tenants'))}</p>`)
        + (endedLinks ? `<h3 class="rent-month-title">${esc(t('ui.rent.links_moved_out'))}</h3>${endedLinks}` : '');
}

async function addTenant() {
    const raw = { name: val('rentTenantName'), phone: val('rentTenantPhone'), phone2: val('rentTenantPhone2'), notes: val('rentTenantNotes') };
    const err = tenantError(raw);
    if (err) return UIManager.showToast(t(err), 'error');
    const tn = { name: raw.name, phone: mobile10(raw.phone), notes: raw.notes, ...(raw.phone2 ? { phone2: mobile10(raw.phone2) } : {}) };
    await saveRent(() => store.addTenant(tn));
}

async function editTenant(id) {
    const tn = store.snapshot().tenants.find(x => x.id === id);
    if (!tn) return;
    const ok = await dialog(`<h3>${esc(t('ui.rent.edit'))}</h3>
        <label class="rent-label">${esc(t('ui.rent.tenant_name'))}<input id="rentEditName" type="text" maxlength="80" value="${esc(tn.name)}"></label>
        <label class="rent-label">${esc(t('ui.rent.phone_required'))}<input id="rentEditPhone" type="tel" maxlength="20" value="${esc(tn.phone || '')}"></label>
        <label class="rent-label">${esc(t('ui.rent.phone2'))}<input id="rentEditPhone2" type="tel" maxlength="20" value="${esc(tn.phone2 || '')}"></label>
        <label class="rent-label">${esc(t('ui.rent.notes'))}<input id="rentEditNotes" type="text" maxlength="500" value="${esc(tn.notes || '')}"></label>`);
    if (!ok) return;
    const raw = { name: val('rentEditName'), phone: val('rentEditPhone'), phone2: val('rentEditPhone2'), notes: val('rentEditNotes') };
    const err = tenantError(raw);
    if (err) return UIManager.showToast(t(err), 'error');
    const next = { name: raw.name, phone: mobile10(raw.phone), notes: raw.notes, phone2: raw.phone2 ? mobile10(raw.phone2) : null };
    await saveRent(() => store.updateTenant(id, next));
    refreshLinkNames(l => l.tenantId === id);
}

async function archiveTenant(id) {
    if (!await UIManager.showModal(t('msg.rent.confirm_remove'), t('ui.rent.remove'), true)) return;
    await saveRent(() => store.updateTenant(id, { archived: true }));
}

// ---------- Tenant section (Add unit with its tenant, Add tenant to a vacant unit, Move in) ----------

/** Electricity choice of a lease (and the tenant's own meter number when that is chosen). */
function elecFieldsHtml(mode, meterNo = '') {
    return `<label class="rent-label">${esc(t('ui.rent.elec_mode'))}
            <select id="rentTElec" onchange="window.app.rentals.tenantElec(this)">${ELEC_MODES.map(m => `<option value="${m}"${m === mode ? ' selected' : ''}>${esc(t(`ui.rent.elec_${m}`))}</option>`).join('')}</select></label>
        <div id="rentTOwnBox"${mode === 'own' ? '' : ' hidden'}><label class="rent-label">${esc(t('ui.rent.own_meter_no'))}<input id="rentTMeterNo" type="text" maxlength="40" value="${esc(meterNo)}"></label></div>`;
}

/**
 * The tenant fields. toggle: Add unit shows them only after "Occupied — add tenant
 * now"; fixedTenant: Move in from the Tenants page; newUnit: opening meter reading.
 */
function tenantSectionHtml({ toggle = false, rent = 0, fixedTenant = null, newUnit = false, meterRate = '', defs = normalizeRentSettings(null) } = {}) {
    const d = store.snapshot();
    const busy = new Set(d.leases.map(l => l.tenantId));
    const free = d.tenants.filter(x => !busy.has(x.id)).sort((a, b) => a.name.localeCompare(b.name));
    // Settings › Rentals defaults fill a NEW lease; existing leases keep their own values.
    const rate = meterRate !== '' && meterRate != null ? meterRate : (defs.meterRate ?? '');
    const mode = rate !== '' && rate != null ? 'meter' : 'included';
    const who = fixedTenant
        ? `<input type="hidden" id="rentTPick" value="${esc(fixedTenant.id)}"><p class="rent-name">${esc(fixedTenant.name)}</p>`
        : `<label class="rent-label">${esc(t('ui.rent.tenant_pick'))}<select id="rentTPick" onchange="window.app.rentals.tenantPick(this)">
                <option value="">${esc(t('ui.rent.tenant_new'))}</option>${free.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></label>
            <div id="rentTNewBox">
                <label class="rent-label">${esc(t('ui.rent.tenant_name'))}<input id="rentTName" type="text" maxlength="80"></label>
                <label class="rent-label">${esc(t('ui.rent.phone_required'))}<input id="rentTPhone" type="tel" maxlength="20" inputmode="tel"></label>
                <label class="rent-label">${esc(t('ui.rent.phone2'))}<input id="rentTPhone2" type="tel" maxlength="20" inputmode="tel"></label>
            </div>`;
    const box = `<div id="rentTBox" class="rent-tenant-section"${toggle ? ' hidden' : ''}>
        <h4 class="rent-group-title">${esc(t('ui.rent.tenant_if_occupied'))}</h4>
        ${who}
        <label class="rent-label">${esc(t('ui.rent.monthly_rent'))}<input id="rentTRent" type="number" inputmode="decimal" min="0" step="1" value="${esc(rent || 0)}"></label>
        <label class="rent-label">${esc(t('ui.rent.start_date'))}<input id="rentTDate" type="date" value="${esc(todayLocalISO())}"></label>
        <label class="rent-check"><input id="rentTProRate" type="checkbox"> ${esc(t('ui.rent.pro_rate_first'))}</label>
        <label class="rent-label">${esc(t('ui.rent.due_day'))}<input id="rentTDay" type="number" min="1" max="28" step="1" value="${esc(defs.dueDay)}"></label>
        <label class="rent-label">${esc(t('ui.rent.increase_pct'))}<input id="rentTPct" type="number" min="0" max="100" step="0.5" value="${esc(defs.increasePct)}"></label>
        <label class="rent-label">${esc(t('ui.rent.deposit'))}<input id="rentTDeposit" type="number" inputmode="decimal" min="0" step="1" value="0"></label>
        <p class="rent-help">${esc(t('ui.rent.deposit_note'))}</p>
        ${elecFieldsHtml(mode)}
        ${newUnit ? `<div id="rentTMeterBox"${mode === 'meter' ? '' : ' hidden'}>
            <label class="rent-label">${esc(t('ui.rent.opening_reading'))}<input id="rentTOpen" type="number" inputmode="decimal" min="0" step="0.01"></label>
            <label class="rent-label">${esc(t('ui.rent.meter_rate'))}<input id="rentTRate" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(rate)}"></label>
        </div>` : ''}
    </div>`;
    return (toggle ? `<label class="rent-check rent-occupied-toggle"><input id="rentTOn" type="checkbox" onchange="window.app.rentals.tenantToggle(this)"> ${esc(t('ui.rent.occupied_add_tenant'))}</label>` : '') + box;
}

function tenantToggle(cb) {
    const box = document.getElementById('rentTBox');
    if (box) box.hidden = !cb?.checked;
}

function tenantPick(sel) {
    const box = document.getElementById('rentTNewBox');
    if (box) box.hidden = !!sel?.value;
}

function tenantElec(sel) {
    const own = document.getElementById('rentTOwnBox');
    const meterBox = document.getElementById('rentTMeterBox');
    if (own) own.hidden = sel?.value !== 'own';
    if (meterBox) meterBox.hidden = sel?.value !== 'meter';
}

const checked = (id) => !!document.getElementById(id)?.checked;
const numOrNull = (id) => (val(id) === '' ? null : Number(val(id)));

/**
 * Reads the tenant section: null when Add unit is saved as Vacant, else
 * {error} or {tenant | tenantId, lease, meter}. Nothing is saved on an error.
 */
function readTenantSection({ newUnit = false } = {}) {
    if (document.getElementById('rentTOn') && !checked('rentTOn')) return null;
    const tenantId = val('rentTPick') || null;
    let tenant = null;
    if (!tenantId) {
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
    const err = leaseError(lease, state.month);
    if (err) return { error: err };
    let meter = null;
    if (newUnit && elec === 'meter') {
        meter = { reading: numOrNull('rentTOpen'), rate: numOrNull('rentTRate') };
        if ([meter.reading, meter.rate].some(v => v !== null && (!Number.isFinite(v) || v < 0))) return { error: 'msg.rent.bad_reading' };
    }
    return { tenant, tenantId, lease, meter };
}

/** Saves a move-in from the tenant section (one batch); true when saved. */
async function saveMoveIn({ unit, newUnit, occ, defs }) {
    try {
        const tenantName = occ.tenant?.name || store.snapshot().tenants.find(x => x.id === occ.tenantId)?.name || '';
        const res = await store.moveIn({ unit, newUnit, tenant: occ.tenant, tenantId: occ.tenantId, tenantName, lease: occ.lease, meter: occ.meter, currentMonth: state.month });
        const first = firstMonthRent(occ.lease.rent, occ.lease.startDate, occ.lease.proRate);
        UIManager.showToast(t(res.charged ? 'msg.rent.moved_in_charged' : 'msg.rent.moved_in', { amount: formatINR(first) }), 'success');
        AuditService.log('RENT_MOVE_IN', { tenantId: res.tenantId, unitId: res.unitId, rent: occ.lease.rent, startDate: occ.lease.startDate }).catch(auditWarn);
        if (defs?.tenantLink && isManager()) await linkNewLease({ unit, res, occ, defs });
        return true;
    } catch (e) {
        console.error('Move-in not saved:', e);
        UIManager.showToast(t(e?.code === 'permission-denied' ? 'msg.rent.not_allowed' : 'msg.rent.save_failed'), 'error');
        return false;
    }
}

/** Settings › Rentals "Make a tenant link for new leases": the link for a lease just moved in (never blocks the move-in). */
async function linkNewLease({ unit, res, occ, defs }) {
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
            unitType: knownType(unit, prop),
            shopName: headerName(defs)
        });
        AuditService.log('RENT_LINK_ON', { leaseId: res.leaseId }).catch(auditWarn);
    } catch (e) {
        console.warn('Tenant link not made for the new lease:', e?.code || e);
    }
}

/** Property view: "Add tenant" on a vacant unit. */
async function addTenantToUnit(unitId) {
    const unit = store.snapshot().units.find(u => u.id === unitId);
    if (!unit || unit.leaseId) return UIManager.showToast(t('msg.rent.no_vacant_unit'), 'info');
    const ix = index(store.snapshot());
    const defs = await defaults();
    const ok = await dialog(`<h3>${esc(t('ui.rent.add_tenant'))}: ${esc(placeOf(ix, unit.id))}</h3>${tenantSectionHtml({ rent: unit.rent, meterRate: unit.meterRate, defs })}`);
    if (!ok) return;
    const occ = readTenantSection();
    if (occ?.error) return UIManager.showToast(t(occ.error), 'error');
    await saveMoveIn({ unit, newUnit: false, occ, defs });
}

/** Tenants page: move an existing tenant into a vacant unit. */
async function moveIn(tenantId) {
    const d = store.snapshot();
    const ix = index(d);
    const tenant = ix.tenants.get(tenantId);
    const vacant = d.units.filter(u => !u.leaseId);
    if (!tenant) return;
    if (!vacant.length) return UIManager.showToast(t('msg.rent.no_vacant_unit'), 'info');
    // Settings › Rentals defaults fill a NEW lease; existing leases keep their own values.
    const defs = await defaults();
    const options = vacant.map(u => `<option value="${esc(u.id)}" data-rent="${esc(u.rent || 0)}">${esc(placeOf(ix, u.id))}</option>`).join('');
    const ok = await dialog(`<h3>${esc(t('ui.rent.move_in'))}</h3>
        <label class="rent-label">${esc(t('ui.rent.unit'))}<select id="rentLeaseUnit" onchange="window.app.rentals.fillRent(this)">${options}</select></label>
        ${tenantSectionHtml({ rent: vacant[0].rent, fixedTenant: tenant, defs })}`);
    if (!ok) return;
    const unit = ix.units.get(val('rentLeaseUnit'));
    if (!unit || unit.leaseId) return UIManager.showToast(t('msg.rent.no_vacant_unit'), 'error');
    const occ = readTenantSection();
    if (occ?.error) return UIManager.showToast(t(occ.error), 'error');
    await saveMoveIn({ unit, newUnit: false, occ, defs });
}

function fillRent(select) {
    const rent = select?.selectedOptions?.[0]?.getAttribute('data-rent');
    const input = document.getElementById('rentTRent');
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
            const size = [u.floor ? t('ui.rent.floor_value', { floor: u.floor }) : '', Number.isFinite(u.area) ? t('ui.rent.area_value', { area: u.area }) : ''].filter(Boolean).join(' · ');
            return `<li class="rent-unit"><span><span class="rent-kind">${esc(typeLabel(unitType(u)))}</span> <strong>${esc(u.label)}</strong> · ${money(u.rent || 0)} · ${who}${size ? ` · ${esc(size)}` : ''}</span>
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
    refreshLinkNames(l => l.propertyId === id);
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

async function unitDialog(title, unit, { withTenant = false, defs = null } = {}) {
    const ok = await dialog(`<h3>${esc(title)}</h3>
        <label class="rent-label">${esc(t('ui.rent.unit_label'))}<input id="rentUnitLabel" type="text" maxlength="60" value="${esc(unit?.label || '')}"></label>
        <label class="rent-label">${esc(t('ui.rent.unit_type'))}<select id="rentUnitType">${UNIT_TYPES.map(k => `<option value="${k}"${k === unitType(unit) ? ' selected' : ''}>${esc(typeLabel(k))}</option>`).join('')}</select></label>
        <label class="rent-label">${esc(t('ui.rent.monthly_rent'))}<input id="rentUnitRent" type="number" inputmode="decimal" min="0" step="1" value="${esc(unit?.rent ?? 0)}"></label>
        <label class="rent-label">${esc(t('ui.rent.unit_area'))}<input id="rentUnitArea" type="number" inputmode="decimal" min="0" step="1" value="${esc(unit?.area ?? '')}"></label>
        <label class="rent-label">${esc(t('ui.rent.unit_floor'))}<input id="rentUnitFloor" type="text" maxlength="20" value="${esc(unit?.floor || '')}"></label>
        ${withTenant ? tenantSectionHtml({ toggle: true, rent: unit?.rent ?? 0, newUnit: true, defs: defs || undefined }) : ''}`);
    if (!ok) return null;
    const area = val('rentUnitArea');
    const u = {
        label: val('rentUnitLabel'), rent: Number(val('rentUnitRent') || 0),
        type: UNIT_TYPES.includes(val('rentUnitType')) ? val('rentUnitType') : 'flat',
        area: area === '' ? null : Number(area), floor: val('rentUnitFloor') || null
    };
    const err = unitError(u) || unitExtraError(u);
    if (err) { UIManager.showToast(t(err), 'error'); return null; }
    if (!withTenant) return u;
    // The tenant's rent defaults to the unit rent typed above.
    const rentInput = document.getElementById('rentTRent');
    if (rentInput && Number(rentInput.value) === 0 && u.rent > 0) rentInput.value = String(u.rent);
    const occ = readTenantSection({ newUnit: true });
    if (occ?.error) { UIManager.showToast(t(occ.error), 'error'); return null; }
    return { ...u, occ };
}

async function addUnit(propertyId) {
    if (store.snapshot().units.filter(x => x.propertyId === propertyId).length >= MAX_UNITS_PER_PROPERTY) {
        return UIManager.showToast(t('msg.rent.max_units', { max: MAX_UNITS_PER_PROPERTY }), 'error');
    }
    const defs = await defaults();
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
    if (!await UIManager.showModal(t('msg.rent.confirm_remove'), t('ui.rent.remove'), true)) return;
    await saveRent(() => store.updateUnit(id, { archived: true }));
}

// ---------- shared ----------

let dialogResolve = null;

/** Rentals form dialog (template #rentDialog); resolves true on Save. Inputs stay readable after it closes. `info`: no Save button. */
function dialog(html, { info = false } = {}) {
    dialogResolve?.(false);
    const box = document.getElementById('rentDialog');
    const body = document.getElementById('rentDialogBody');
    if (!box || !body) return Promise.resolve(false);
    body.innerHTML = html;
    const save = box.querySelector('.rent-dialog-actions .rent-btn-primary');
    if (save) save.hidden = info;
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

/** Runs a save; resolves the save's result (true when it has none), or null when it failed. */
async function saveRent(fn) {
    try {
        const out = await fn();
        UIManager.showToast(t('msg.rent.saved'), 'success');
        return out ?? true;
    } catch (e) {
        console.error('Rentals save failed:', e);
        UIManager.showToast(t(e?.code === 'permission-denied' ? 'msg.rent.not_allowed' : 'msg.rent.save_failed'), 'error');
        return null;
    }
}

export const RentalsModule = {
    /** Shows a Rentals page and starts the listeners if they aren't running. */
    async enter(page = 'rent') {
        if (!rentalsRole()) return;
        // Access moved to Settings › Roles & access (one screen for both businesses).
        if (page === 'access') {
            if (isOwner()) NavigationManager.showTabFromNav('settings-roles');
            return;
        }
        // leave() (or another enter) while the page is loading wins: don't show or listen then.
        const token = ++state.entry;
        await ensureDom();
        if (token !== state.entry) return;
        state.page = PAGES.includes(page) ? page : 'rent';
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
        shareLink, linkAction, setView, openProperty, filterUnits,
        addTenantToUnit, tenantToggle, tenantPick, tenantElec,
        receipts: (tenantId) => receiptUi('showHistory', tenantId),
        receiptAction: (name, id) => receiptUi('action', name, id)
    }
};

export const _test = { state, accounts, index, render, maybeCharge, moveIn, placeOf, linkPlace, pay };
