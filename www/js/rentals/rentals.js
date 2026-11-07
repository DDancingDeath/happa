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
import { TelemetryService } from '../services/telemetry.js';
import { rentalsRole } from '../ui/business-switcher.js';
import * as store from './rent-store.js';
import { AppState } from '../utils/state.js';
import { noteRent } from '../utils/reminders.js';
import { APP_IDENTITY } from '../config/app-identity.js';
import { isShareToken, publicLink } from './rent-public.js';
import {
    UNIT_TYPES, VIEW_KEY, unitRows, summarize, propertySummaries, groupByType, filterRows, placeText, typedPlace
} from './rent-views.js';
import {
    PAYMENT_MODES, normalizeRentSettings, monthKey, monthLabel, monthsToCharge, chargeStatus, chargeDue, leaseDues,
    buildRentReminderText, increaseDue, elecMode, dateLabel, payOldestFirst, payAmount, expenseTotals, netOf
} from './rent-math.js';

const PAGES = ['rent', 'tenants', 'properties'];
const esc = (v) => Helpers.escapeHtml(v);
const js = (v) => Helpers.escapeJsAttr(v);
const money = (n) => esc(formatINR(n));
const et = (key, p) => esc(t(key, p));
const byId = (id) => document.getElementById(id);
const fail = (key, p) => UIManager.showToast(t(key, p), 'error');
/** Button calling window.app.rentals.<fn>(<args>), text = icon + t(key). */
const btn = (cls, fn, args, key, icon = '', attrs = '') => `<button type="button" class="rent-btn${cls}"${attrs} data-onclick="rentals.${fn}(${args})">${icon}${et(key)}</button>`;
const lbl = (key, field) => `<label class="rent-label">${et(key)}${field}</label>`;

const state = {
    page: 'rent',
    month: null,
    loaded: new Set(),
    errors: new Set(),
    charging: false,
    moving: 0,
    pagesFailed: false,
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
const val = (id) => (byId(id)?.value ?? '').trim();
const isVisible = () => byId('rentals')?.classList.contains('active');

function ensureDom() {
    if (byId('rentals')) return Promise.resolve();
    if (!domReady) {
        domReady = (async () => {
            if (!byId('rentalsCss')) {
                const link = document.createElement('link');
                link.id = 'rentalsCss';
                link.rel = 'stylesheet';
                link.href = 'css/rentals.css';
                document.head.appendChild(link);
            }
            const html = await TemplateLoader.loadTemplate('rentals');
            if (!html) throw new Error('rentals template not loaded');
            (byId('appContent') || document.body).insertAdjacentHTML('beforeend', html);
            applyTranslations(byId('rentals'));
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
    if (state.charging || state.moving || !['leases', 'tenants', 'units'].every(k => state.loaded.has(k))) return;
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
const elecTag = (lease) => `<span class="rent-tag">${et(`ui.rent.elec_tag_${elecMode(lease)}`)}</span>`;
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

const modeLabel = (m) => t(`ui.rent.mode_${PAYMENT_MODES.includes(m) ? m : 'cash'}`);

function render() {
    const root = byId('rentalsBody');
    if (!root) return;
    const owner = isOwner();
    document.querySelectorAll('#rentals [data-rent-page]').forEach(btn => {
        const page = btn.getAttribute('data-rent-page');
        btn.classList.toggle('active', page === state.page);
        if (page === 'access') btn.hidden = !owner;
    });
    document.querySelectorAll('.nav-menu a').forEach(a => {
        a.classList.toggle('active', a.getAttribute('data-rent-nav') === state.page);
    });
    const notice = byId('rentalsNotice');
    if (notice) {
        const limited = store.truncatedKeys().length > 0;
        notice.hidden = state.errors.size === 0 && !limited;
        notice.textContent = state.errors.size ? t('msg.rent.could_not_load') : limited ? t('msg.rent.limit_reached') : '';
    }
    if (!['properties', 'units', 'tenants', 'leases', 'openCharges', 'monthCharges', 'monthExpenses'].every(k => state.loaded.has(k))) {
        root.innerHTML = `<p class="rent-empty">${et('ui.rent.loading')}</p>`;
        return;
    }
    const d = store.snapshot();
    if (state.page !== 'rent' && !pagesMod) {
        root.innerHTML = `<p class="rent-empty">${et(state.pagesFailed ? 'msg.rent.could_not_load' : 'ui.rent.loading')}</p>`;
        if (state.pagesFailed) return;
        return loadPages().then(() => { if (isVisible()) render(); }, () => { state.pagesFailed = true; fail('msg.rent.could_not_load'); render(); });
    }
    root.innerHTML = state.page === 'tenants' ? pagesMod.renderTenants(unitCtx(), d)
        : state.page === 'properties' ? pagesMod.renderProperties(unitCtx(), d)
        : renderRent(d);
    if (state.page === 'tenants' && canWrite()) void unitUi('fillPicker', 'rentTenantUnitBox', 'rentTenantUnit');
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

const badge = (cls, key) => `<span class="rent-badge rent-badge-${cls}">${et(key)}</span>`;

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
    const power = e ? ` <span class="rent-sub">${et('ui.rent.incl_electricity', { amount: formatINR(e.amount), units: e.units })}</span>` : '';
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

/** RENT-9 cards; with this month's expenses (RENT-17) also the net (RENT-18). */
function totalsCards(sum, exp) {
    return [
        ['ui.rent.expected', sum.expected],
        ['ui.rent.collected', sum.collected],
        ['ui.rent.pending_month', sum.pending],
        ['ui.rent.outstanding', sum.due],
        ...(exp === undefined ? [] : [['ui.rent.exp_month', exp], ['ui.rent.net_month', netOf(sum.collected, exp)]])
    ].map(([k, v]) => `<div class="rent-card"><div class="rent-card-label">${et(k)}</div><div class="rent-card-value">${money(v)}</div></div>`).join('');
}

/** "6 flats · 3 commercial" in the chosen language. */
function typeCounts(byType) {
    return UNIT_TYPES.filter(k => byType[k]).map(k => t(`ui.rent.count_${k}`, { n: byType[k] })).join(' · ');
}

function renderRent(d) {
    const ix = index(d);
    const lang = getLang();
    const rows = unitRows(d, state.month);
    noteRent(state, rows, store.truncatedKeys());
    if (!state.errors.size && !store.truncatedKeys().length) void import('./rent-report.js').then(m => m.noteLeases(d, state.month, u => placeOf(ix, u))).catch(() => {});
    const view = state.view === 'units' ? 'units' : 'properties';
    const sw = `<div class="rent-viewswitch" role="group">
        <button type="button" class="filter-btn${view === 'properties' ? ' active' : ''}" aria-pressed="${view === 'properties'}" data-onclick="rentals.setView('properties')">${et('ui.rent.view_properties')}</button>
        <button type="button" class="filter-btn${view === 'units' ? ' active' : ''}" aria-pressed="${view === 'units'}" data-onclick="rentals.setView('units')">${et('ui.rent.view_units')}</button>
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
    const ex = expenseTotals(d.expenses, state.month);
    const cards = propertySummaries(d.properties, rows).map(({ property: p, summary: s }) => `
        <button type="button" class="rent-row rent-prop-card" data-onclick="rentals.openProperty('${js(p.id)}')">
            <div class="rent-row-head">
                <div><div class="rent-name">${esc(p.name)}</div>
                    <div class="rent-sub">${esc(typeCounts(s.byType) || t('ui.rent.no_units'))}</div>
                    <div class="rent-sub">${et('ui.rent.occupancy', { occupied: s.occupied, vacant: s.vacant })}${s.late ? ` · ${et('ui.rent.late_count', { n: s.late })}` : ''}</div></div>
                <div class="rent-row-right"><div class="rent-due">${money(s.pending)}</div><div class="rent-sub">${et('ui.rent.pending_month')}</div></div>
            </div>
            <div class="rent-sub">${et('ui.rent.prop_month_line', { expected: formatINR(s.expected), collected: formatINR(s.collected) })}${ex.byProperty[p.id] ? ` · ${et('ui.rent.exp_line', { amount: formatINR(ex.byProperty[p.id]) })}` : ''}</div>
        </button>`).join('');
    const empty = `<p class="rent-empty">${et('ui.rent.no_properties')}</p>`
        + (canWrite() ? btn(' rent-btn-primary', 'page', `'properties'`, 'ui.rent.add_property') : '');
    return `<div class="rent-cards">${totalsCards(summarize(rows), ex.total)}</div>
        ${cards || empty}`;
}

function renderPropertyDetail(d, ix, rows) {
    const p = ix.properties.get(state.openProperty);
    const mine = rows.filter(r => r.propertyId === p.id);
    const s = summarize(mine);
    const groups = groupByType(mine).map(g => `
        <h4 class="rent-group-title">${esc(typeLabel(g.type))} (${g.rows.length})</h4>
        ${g.rows.map(r => unitRowHtml(r, d, { showProperty: false })).join('')}`).join('');
    return `<div class="rent-detail-head">
            ${btn(' rent-btn-small', 'openProperty', `''`, 'ui.rent.all_properties', '← ')}
            <h3 class="rent-name">${esc(p.name)}</h3>
            <div class="rent-sub">${esc(typeCounts(s.byType))} · ${et('ui.rent.occupancy', { occupied: s.occupied, vacant: s.vacant })}</div>
        </div>
        <div class="rent-cards">${totalsCards(s, expenseTotals(d.expenses, state.month).byProperty[p.id] || 0)}</div>
        ${groups || `<p class="rent-empty">${et('ui.rent.no_units')}</p>`}`;
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
        ? `${esc(r.tenantName || t('ui.rent.no_name'))} · ${et('ui.rent.rent_terms', { amount: formatINR(lease.rent), day: lease.dueDay })} ${elecTag(lease)}${lease.startDate ? ` · ${esc(sinceText(lease))}` : ''}`
        : `${et('ui.rent.vacant')} · ${money(r.rent)}`;
    const months = dues.charges.map(c => monthLine(c, lang)).join('');
    const inc = lease ? increaseDue(lease, state.month) : { due: false };
    const increase = inc.due
        ? `<div class="rent-increase">📈 ${et('ui.rent.increase_due', { pct: inc.pct, amount: formatINR(inc.newRent) })}
            ${btn(' rent-btn-small', 'editLease', `'${js(lease.id)}'`, 'ui.rent.update_rent')}</div>`
        : '';
    const actions = lease ? ((dues.total > 0
        ? `${payBtns(lease.id)}`
        : '') + (current && elecMode(lease) === 'meter' && (!current.electricity || isManager())
        ? btn('', 'meter', `'${js(lease.id)}'`, 'ui.rent.meter_reading', '⚡ ')
        : '') + receiptsBtn(lease.tenantId)) : (canWrite()
        ? btn(' rent-btn-primary', 'addTenantToUnit', `'${js(r.unitId)}'`, 'ui.rent.add_tenant')
        : '');
    return `<div class="rent-row" data-unit="${esc(r.unitId)}">
        <div class="rent-row-head">
            <div><div class="rent-name">${head}</div>
                <div class="rent-sub">${who}</div>${extra ? `<div class="rent-sub">${extra}</div>` : ''}</div>
            <div class="rent-row-right">${rowBadge(r)}<div class="rent-due">${money(r.due)}</div></div>
        </div>
        ${months ? `<ul class="rent-months">${months}</ul>` : ''}
        ${current?.adv > 0 ? `<div class="rent-sub">${et('ui.rent.adv_next', { amount: formatINR(current.adv) })}</div>` : ''}
        ${increase}
        ${actions ? `<div class="rent-actions">${actions}</div>` : ''}
    </div>`;
}

function renderUnitView(d, rows) {
    const f = state.filters;
    const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
    const props = [...d.properties].sort((a, b) => a.name.localeCompare(b.name));
    const controls = `<div class="rent-filters">
        <select aria-label="${et('ui.rent.filter_property')}" data-onchange="rentals.filterUnits('propertyId', this.value)">
            ${opt('', t('ui.rent.all_properties'), f.propertyId)}${props.map(p => opt(p.id, p.name, f.propertyId)).join('')}</select>
        <select aria-label="${et('ui.rent.filter_type')}" data-onchange="rentals.filterUnits('type', this.value)">
            ${opt('', t('ui.rent.all_types'), f.type)}${UNIT_TYPES.map(k => opt(k, typeLabel(k), f.type)).join('')}</select>
        <select aria-label="${et('ui.rent.filter_status')}" data-onchange="rentals.filterUnits('status', this.value)">
            ${opt('', t('ui.rent.all_statuses'), f.status)}${['occupied', 'vacant', 'late', 'due'].map(k => opt(k, t(`ui.rent.filter_${k}`), f.status)).join('')}</select>
        <input type="search" value="${esc(f.q)}" placeholder="${et('ui.rent.search_units')}" aria-label="${et('ui.rent.search_units')}" data-oninput="rentals.filterUnits('q', this.value)">
        ${btn(' rent-btn-small', 'filterUnits', `'sort', '${f.sort === 'desc' ? 'asc' : 'desc'}'`, f.sort === 'desc' ? 'ui.rent.sort_due_desc' : 'ui.rent.sort_due_asc')}
    </div>`;
    return `${controls}<div id="rentUnitList">${unitListHtml(d, rows)}</div>`;
}

/** The filtered unit list and its totals (same RENT-9 sum as the property view). */
function unitListHtml(d, rows) {
    const shown = filterRows(rows, state.filters);
    return `<div class="rent-cards">${totalsCards(summarize(shown))}</div>
        ${shown.map(r => unitRowHtml(r, d)).join('') || `<p class="rent-empty">${et('ui.rent.no_matching_units')}</p>`}`;
}

/** Tenants who moved out and still owe rent (not on any unit any more). */
function renderMovedOut(d, ix) {
    const gone = accounts(d, ix).filter(a => !a.lease && a.dues.total > 0);
    if (!gone.length) return '';
    return `<h3 class="rent-month-title">${et('ui.rent.moved_out_due')}</h3>${gone.map(a => `<div class="rent-row">
        <div class="rent-row-head"><div><div class="rent-name">${esc(a.name || t('ui.rent.no_name'))}</div>
            <div class="rent-sub">${esc(a.place)} · ${et('ui.rent.moved_out')}</div></div>
            <div class="rent-row-right"><div class="rent-due">${money(a.dues.total)}</div></div></div>
        <ul class="rent-months">${a.dues.charges.map(c => monthLine(c, getLang())).join('')}</ul>
        <div class="rent-actions">
            ${payBtns(a.leaseId)}
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
    byId('rentals')?.scrollIntoView?.({ block: 'start' });
}

/** Unit view filters: only the list redraws, so the search box keeps its focus. */
function filterUnits(field, value) {
    if (!['propertyId', 'type', 'status', 'q', 'sort'].includes(field)) return;
    state.filters = { ...state.filters, [field]: String(value ?? '') };
    if (field === 'sort') { render(); return; }
    const list = byId('rentUnitList');
    if (!list) { render(); return; }
    const d = store.snapshot();
    list.innerHTML = unitListHtml(d, unitRows(d, state.month));
}

async function pay(leaseId) {
    if (Helpers.isBusy('rent-pay')) return;
    const dues = leaseDues(store.snapshot().charges, leaseId);
    if (!dues.charges.length) return;
    const lang = getLang();
    const first = dues.charges[0];
    const options = dues.charges.map(c => `<option value="${esc(c.id)}" data-due="${esc(chargeDue(c))}">${esc(monthLabel(c.month, lang))} · ${money(chargeDue(c))}</option>`).join('');
    const modes = PAYMENT_MODES.map(m => `<option value="${m}">${esc(modeLabel(m))}</option>`).join('');
    const html = `<h3>${et('ui.rent.record_payment')}</h3>
        ${lbl('ui.rent.month', `
            <select id="rentPayCharge" data-onchange="rentals.fillDue(this)">${options}</select>`)}
        ${lbl('ui.rent.amount', `
            <input id="rentPayAmount" type="number" inputmode="decimal" min="0" step="1" value="${esc(chargeDue(first))}">`)}
        ${lbl('ui.rent.mode', `<select id="rentPayMode">${modes}</select>`)}
        ${lbl('ui.rent.reference', `<input id="rentPayRef" type="text" maxlength="60">`)}
        ${lbl('ui.rent.date', `<input id="rentPayDate" type="date" value="${esc(todayLocalISO())}">`)}
        <p class="rent-help">${et('ui.rent.advance_help')}</p>`;
    const ok = await dialog(html);
    if (!ok) return;
    const id = val('rentPayCharge');
    const charge = dues.charges.find(c => c.id === id);
    const amount = Number(val('rentPayAmount'));
    const mode = PAYMENT_MODES.includes(val('rentPayMode')) ? val('rentPayMode') : 'cash';
    const ref = val('rentPayRef');
    const date = val('rentPayDate') || todayLocalISO();
    // RENT-5, RENT-16: more than the month's due pays the unpaid months oldest first; only the rest is an advance.
    let parts = [{ id, amount }];
    if (charge && amount > chargeDue(charge)) {
        try {
            parts = payOldestFirst(dues.charges, amount, store.snapshot().leases.find(l => l.id === leaseId)?.chargedThrough);
        } catch (e) {
            return fail(e.message === 'over' ? 'msg.rent.more_than_due' : 'msg.rent.bad_amount');
        }
        const adv = parts[parts.length - 1].adv;
        const lines = parts.map(p => `${monthLabel(p.month, lang)}: ${formatINR(p.amount)}`).concat(adv ? [t('ui.rent.adv_next', { amount: formatINR(adv) })] : []).join(' · ');
        if (!await UIManager.showModal(t('msg.rent.pay_split', { lines }), t('ui.rent.record_payment'), true)) return;
    }
    await Helpers.runExclusive('rent-pay', '[data-rent-pay]', () => savePayment(parts, dues.charges, { mode, ref, date }));
}

/** One payment (and receipt) per part: a month, or several oldest first; one opens its receipt, several the tenant's list. */
async function savePayment(parts, charges, { mode, ref, date }) {
    const ch = (id) => charges.find(c => c.id === id);
    let res = null;
    let n = 0;
    let adv = 0;
    let no = false;
    try {
        for (const p of parts) {
            res = await store.recordPayment(p.id, { amount: payAmount(p), mode, ref, date, exact: !!p.month }, rcOf(ch(p.id)));
            n++;
            adv = res.adv || adv;
            no = no || res.noReceipt;
            if (res.noReceipt) TelemetryService.logWarning('Rent receipt not issued', { code: res.receiptError || '', chargeId: p.id });
            AuditService.log('RENT_PAYMENT', {
                chargeId: p.id, month: ch(p.id)?.month || '', amount: res.amount, adv: res.adv || 0, mode, tenant: ch(p.id)?.tenantName || '', receipt: res.receipt?.no || ''
            }).catch(auditWarn);
        }
        UIManager.showToast(t(`msg.rent.${n > 1 ? 'payments' : 'payment'}_saved${no ? '_no_receipt' : ''}`, { amount: formatINR(res.amount), n })
            + (adv ? ` ${t('msg.rent.adv_carried', { amount: formatINR(adv) })}` : ''), no ? 'warning' : 'success');
    } catch (e) {
        fail(n ? 'msg.rent.payments_part_saved' : `msg.rent.${{ amount: 'bad_amount', over: 'more_than_due', too_many: 'too_many_payments' }[e?.message] || 'payment_failed'}`, { n });
    }
    if (n > 1 || no) void receiptUi('showHistory', ch(parts[0].id)?.tenantId);
    else if (res?.receipt) void receiptUi('showReceipt', res.receipt);
}

function fillDue(select) {
    const due = select?.selectedOptions?.[0]?.getAttribute('data-due');
    const input = byId('rentPayAmount');
    if (input && due != null) input.value = due;
}

// ---------- Receipts (rent-receipt.js, loaded on first use) ----------

/** Unit words on a receipt of charge `c`. */
function rcOf(c) {
    const lp = linkPlace(index(store.snapshot()), c?.unitId);
    return { place: lp.place || c?.unitLabel || '', ut: lp.unitType || null };
}

/** Runs a rent-receipt.js function with what it needs from here (dialog, header, tenant link, owner/manager). */
function receiptUi(fn, ...args) {
    return Promise.all([import('./rent-receipt.js'), defaults()])
        .then(([m, s]) => m[fn]({
            dialog, rcOf, linkOf: (id) => linkFor(findLease(id)), canVoid: isManager(),
            head: { biz: headerName(s), bizAddr: s.receiptAddress || '' }
        }, ...args))
        .catch((e) => {
            console.error('Receipt not shown:', e);
            fail('msg.rent.could_not_load');
        });
}

/** Record payment and WhatsApp reminder of a lease. */
const payBtns = (id) => `${btn(' rent-btn-primary', 'pay', `'${js(id)}'`, 'ui.rent.record_payment', '', ' data-rent-pay')} ${btn(' rent-btn-wa', 'remind', `'${js(id)}'`, 'ui.rent.whatsapp_reminder')}`;
const receiptsBtn = (tenantId) => btn('', 'receipts', `'${js(tenantId)}'`, 'ui.rcpt.receipts', '🧾 ');

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


// ---------- Unit picker / change of unit (rent-unit.js) and link actions (rent-link.js), loaded on first use ----------

const unitMod = () => import('./rent-unit.js');
/** Tenants / Properties pages and their forms (rent-pages.js), loaded on first use. */
let pagesMod = null;
const loadPages = () => import('./rent-pages.js').then(m => (pagesMod = m.pages));
const pg = (fn) => (...args) => loadPages().then(p => p[fn](unitCtx(), ...args), (e) => {
    console.error('Rentals file not loaded:', e);
    fail('msg.rent.could_not_load');
});
const fromPages = (fn) => (...args) => pagesMod[fn](unitCtx(), ...args);

/** A move-in or change of unit charges its new lease itself: the visit's charge pass waits, so one path writes each month. */
async function whileMoving(fn) {
    state.moving++;
    try {
        return await fn();
    } finally {
        state.moving--;
        void maybeCharge();
    }
}
const unitCtx = () => ({
    esc, js, val, dialog, closeDialog: () => dialogResolve?.(false), index, placeOf, linkPlace, linkFor, findLease, knownType, typeWord,
    defaults, headerName, tenantSectionHtml: fromPages('tenantSectionHtml'), readTenantSection: fromPages('readTenantSection'),
    saveMoveIn: (...a) => whileMoving(() => fromPages('saveMoveIn')(...a)), isManager: isManager(), isOwner: isOwner(), canWrite: canWrite(), month: state.month,
    state, typeLabel, elecTag, sinceText, receiptsBtn, unitUi, depUi, linkUi: (fn, ...a) => lazyUi('./rent-link.js', fn, ...a), unitMod, unitCtx, auditWarn
});

/** Runs function `fn` of a lazy file (rent-unit.js / rent-link.js) with what it needs from here. */
function lazyUi(file, fn, ...args) {
    return (file === './rent-unit.js' ? loadPages().then(unitMod) : file === './rent-deposit.js' ? import('./rent-deposit.js') : file === './rent-expense.js' ? import('./rent-expense.js') : file === './rent-report.js' ? import('./rent-report.js') : import('./rent-link.js')).then(
        (m) => Promise.resolve().then(() => m[fn](unitCtx(), ...args)).catch((e) => {
            console.error(`Rentals ${fn} failed:`, e);
            fail('msg.rent.save_failed');
        }),
        (e) => {
            console.error('Rentals file not loaded:', e);
            fail('msg.rent.could_not_load');
        });
}
const unitUi = (fn, ...args) => lazyUi('./rent-unit.js', fn, ...args);
const depUi = (fn, ...args) => lazyUi('./rent-deposit.js', fn, ...args);
const expUi = (fn, ...args) => lazyUi('./rent-expense.js', fn, ...args);

// ---------- shared ----------

let dialogResolve = null;

/** Rentals form dialog (template #rentDialog); resolves true on Save. Inputs stay readable after it closes. `info`: no Save button. */
function dialog(html, { info = false } = {}) {
    dialogResolve?.(false);
    const box = byId('rentDialog');
    const body = byId('rentDialogBody');
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
        state.pagesFailed = false;
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
        pay, fillDue, remind,
        ...Object.fromEntries(['meter', 'editLease', 'addTenant', 'editTenant', 'archiveTenant', 'moveIn', 'moveOut', 'fillRent', 'addProperty', 'editProperty',
            'archiveProperty', 'addUnit', 'editUnit', 'archiveUnit', 'tenantToggle', 'tenantPick', 'tenantElec'].map(n => [n, pg(n)])),
        shareLink: (id) => lazyUi('./rent-link.js', 'shareLink', id), linkAction: (a, id) => lazyUi('./rent-link.js', 'linkAction', a, id), setView, openProperty, filterUnits,
        addTenantToUnit: (unitId) => unitUi('toUnit', null, unitId),
        receipts: (tenantId) => receiptUi('showHistory', tenantId),
        receiptAction: (name, id) => receiptUi('action', name, id),
        deposit: (id) => depUi('showDeposit', id), deposits: () => depUi('showHeld'), depositAction: (a, id, i) => depUi('action', a, id, i), advanceToDeposit: (id) => depUi('advanceAction', id),
        expenses: (pid) => expUi('showExpenses', pid), expenseAction: (a, pid, id) => expUi('action', a, pid, id),
        agreement: (id) => lazyUi('./rent-report.js', 'editAgreement', id), yearReport: () => lazyUi('./rent-report.js', 'showYearReport'),
        reportAction: (a, v) => lazyUi('./rent-report.js', 'action', a, v)
    }
};

export const _test = {
    state, accounts, index, render, maybeCharge, moveIn: pg('moveIn'), placeOf, linkPlace, pay, toUnit: (...a) => unitUi('toUnit', ...a), editTenant: pg('editTenant'), addTenant: pg('addTenant')
};
