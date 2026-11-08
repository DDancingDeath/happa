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
import { todayLocalISO, formatMonth } from '../utils/dates.js';
import { openExternal } from '../utils/open-external.js';
import { formatINR, whatsAppReminderUrl } from '../utils/due-reminder.js';
import { t, getLang, applyTranslations, LANG_CHANGE_EVENT } from '../i18n/index.js';
import { AuditService } from '../services/audit.js';
import { TelemetryService } from '../services/telemetry.js';
import { rentalsRole } from '../ui/business-switcher.js';
import * as store from './rent-store.js';
import { AppState } from '../utils/state.js';
import { noteRent, rentReminder, leaseReminder, leaseReminderText } from '../utils/reminders.js';
import { APP_IDENTITY } from '../config/app-identity.js';
import { isShareToken, publicLink } from './rent-public.js';
import {
    UNIT_TYPES, VIEW_KEY, unitRows, summarize, tenantRows, placeText, typedPlace, meterPending
} from './rent-views.js';
import {
    PAYMENT_MODES, normalizeRentSettings, monthKey, monthLabel, monthsToCharge, chargeDue, leaseDues,
    buildRentReminderText, elecMode, dateLabel, payOldestFirst, payAmount, applyPayment, expenseTotals, receivedIn, monthState
} from './rent-math.js';

const PAGES = ['rent', 'tenants', 'properties', 'reports'];
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
    lazyFailed: false,
    mode: 'simple',
    onlyLate: false,
    leaseNotes: '',
    charged: new Set(),
    renderTimer: null,
    entry: 0,
    view: savedView(),
    openProperty: '',
    detail: '',
    detailKey: 0,
    tenantList: { q: '', filter: 'all', sort: 'name' },
    filters: { propertyId: '', type: '', status: '', q: '', sort: 'desc' }
};

/** Simple or Advanced, per user on this phone (owner decision: everyone starts in Simple). */
const modeKey = () => `happa.rentMode.${AppState.currentUser?.uid || ''}`;
function savedMode() {
    try { return localStorage.getItem(modeKey()) === 'advanced' ? 'advanced' : 'simple'; } catch (_) { return 'simple'; }
}

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
    // RENT-20's listener failing only blanks that figure ("—"), not the page or Today's reminders.
    if (key === 'monthPaid') state.paidError = !!error;
    else if (error) state.errors.add(key); else state.errors.delete(key);
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
    const adv = state.mode === 'advanced';
    if (state.page === 'reports' && (!adv || !canWrite())) state.page = 'rent';
    const reports = byId('rentReportsTab');
    if (reports) reports.hidden = !adv || !canWrite();
    document.querySelectorAll('#rentals [data-rent-page]').forEach(b => b.classList.toggle('active', b.getAttribute('data-rent-page') === state.page));
    document.querySelectorAll('#rentals [data-rent-mode]').forEach((b) => {
        const on = b.getAttribute('data-rent-mode') === state.mode;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
    });
    const links = byId('rentSettingsLinks');
    if (links) links.hidden = !adv || !isManager();
    const roles = byId('rentRolesLink');
    if (roles) roles.hidden = !isOwner();
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
    const need = state.page === 'reports' ? '' : state.page !== 'rent' ? 'pages' : adv ? 'advanced' : '';
    if (need && !lazyMods[need]) {
        root.innerHTML = `<p class="rent-empty">${et(state.lazyFailed ? 'msg.rent.could_not_load' : 'ui.rent.loading')}</p>`;
        if (state.lazyFailed) return;
        return loadMod(need).then(() => { if (isVisible()) render(); }, () => { state.lazyFailed = true; fail('msg.rent.could_not_load'); render(); });
    }
    const detail = !state.detail ? null : state.page === 'tenants' ? lazyMods.pages.renderTenant(unitCtx(), d, state.detail)
        : state.page === 'properties' ? lazyMods.pages.renderProperty(unitCtx(), d, state.detail) : null;
    if (state.detail && !detail) {
        state.detail = '';
        if (history.state?.rentDetail === state.detailKey) history.back();
    }
    root.innerHTML = detail || (state.page === 'tenants' ? lazyMods.pages.renderTenants(unitCtx(), d)
        : state.page === 'properties' ? lazyMods.pages.renderProperties(unitCtx(), d)
        : state.page === 'reports' ? renderReports(d)
        : renderRent(d, adv));
}

/** Advanced › Reports: the yearly report (owner, managers), deposits held and this month's expenses per property (as before). */
function renderReports(d) {
    const tile = (fn, args, title, sub) => `<button type="button" class="rent-row rent-prop-card" data-onclick="rentals.${fn}(${args})"><span class="rent-name">${esc(title)}</span><span class="rent-sub">${esc(sub)}</span></button>`;
    const ex = expenseTotals(d.expenses, state.month).byProperty;
    const props = [...d.properties].sort((a, b) => a.name.localeCompare(b.name));
    return `${isManager() ? tile('yearReport', '', `📊 ${t('ui.rent.yr_btn')}`, t('ui.rent.rep_yearly_sub')) : ''}
        ${tile('deposits', '', `💰 ${t('ui.rent.dep_held_list')}`, t('ui.rent.rep_deposits_sub'))}
        <h3 class="rent-section-title">${et('ui.rent.exp_month')} · ${esc(monthLabel(state.month, getLang()))}</h3>
        ${props.map(p => tile('expenses', `'${js(p.id)}'`, p.name, formatINR(ex[p.id] || 0))).join('') || `<p class="rent-empty">${et('ui.rent.no_properties')}</p>`}`;
}

/** Settings › Rentals defaults; built-in defaults when they can't be read. */
const defaults = () => store.loadSettings().catch((e) => {
    console.warn('Rentals settings not loaded:', e?.code || e);
    return normalizeRentSettings(null);
});

/** Name on the tenant's page: Settings › Rentals header, else the business name. */
const headerName = (s) => s?.receiptHeader || AppState.settings?.shopName || '';

// ---------- This month ----------

const badge = (cls, key) => `<span class="rent-badge rent-badge-${cls}">${et(key)}</span>`;

/** REM-2 and REM-4 for Today, the bell and Needs attention, saved from complete data only. */
function notePage(d, ix, rows) {
    noteRent(state, rows, store.truncatedKeys());
    state.leaseNotes = JSON.stringify(leaseReminder(localStorage, AppState.currentUser?.uid, state.month)?.items || null);
    if (state.errors.size || store.truncatedKeys().length) return;
    void import('./rent-report.js').then((m) => {
        m.noteLeases(d, state.month, u => placeOf(ix, u));
        const now = JSON.stringify(leaseReminder(localStorage, AppState.currentUser?.uid, state.month)?.items || null);
        if (state.mode === 'simple' && now !== state.leaseNotes) scheduleRender();
    }).catch(() => {});
}

function renderRent(d, adv) {
    const ix = index(d);
    const rows = unitRows(d, state.month);
    notePage(d, ix, rows);
    return adv ? lazyMods.advanced.renderAdvanced(unitCtx(), d, rows) : renderMonth(d, ix, rows);
}

/** Simple: how much came in, what needs doing, and who still owes (active and moved-out tenants). */
function renderMonth(d, ix, rows) {
    const lang = getLang();
    const sum = summarize(rows);
    const all = tenantRows(d, state.month);
    const owe = all.filter(a => a.dues.total > 0);
    const shown = state.onlyLate && owe.some(a => a.late) ? owe.filter(a => a.late) : owe;
    const paid = all.filter(a => !a.ended && a.dues.total <= 0);
    const title = `<h3 class="rent-month-title">${esc(monthLabel(state.month, lang))}</h3>`;
    if (!d.properties.length) {
        return `${title}<p class="rent-empty">${et('ui.rent.start_hint')}</p>`
            + (canWrite() ? btn(' rent-btn-primary', 'page', `'properties'`, 'ui.rent.add_property') : '');
    }
    const summary = `<div class="rent-summary">
        <div class="rent-name">${et('ui.rent.collected_of', { collected: formatINR(sum.collected), expected: formatINR(sum.expected) })}</div>
        ${sum.expected > 0 ? `<progress class="rent-progress" max="${esc(sum.expected)}" value="${esc(sum.collected)}" aria-label="${et('ui.rent.collected')}"></progress>` : ''}
        <div class="rent-sub" data-rent-received>${et('ui.rent.received_month')}: ${receivedText(d)}</div>
        <div class="rent-sub">${et('ui.rent.outstanding')}: ${money(sum.due)}</div>
    </div>`;
    const list = shown.map(a => collectRow(a, ix, lang)).join('')
        || `<p class="rent-empty">${et(owe.length ? 'ui.rent.none_late' : 'ui.rent.all_paid', { month: monthLabel(state.month, lang) })}</p>`;
    const paidList = paid.length ? `<details class="rent-more"><summary>${et('ui.rent.paid_month', { n: paid.length })}</summary>
        <div class="rent-list">${paid.map(a => collectRow(a, ix, lang)).join('')}</div></details>` : '';
    const vacant = sum.vacant ? `<button type="button" class="rent-link" data-onclick="rentals.page('properties')">${et('ui.rent.vacant_units', { n: sum.vacant })} ›</button>` : '';
    const payAny = canWrite() && owe.length ? `<div class="rent-sticky">${btn(' rent-btn-primary rent-btn-block', 'payAny', '', 'ui.rent.record_payment', '', ' data-rent-pay')}</div>` : '';
    return `${title}${summary}${attentionHtml(d, ix)}
        <h3 class="rent-section-title">${et('ui.rent.to_collect', { n: owe.length })}${owe.some(a => a.late)
            ? ` <button type="button" class="filter-btn${state.onlyLate ? ' active" aria-pressed="true"' : '" aria-pressed="false"'} data-onclick="rentals.onlyLate()">${et('ui.rent.status_late')}</button>` : ''}</h3>
        <div class="rent-list">${list}</div>${paidList}${vacant}${payAny}`;
}

/** RENT-20 once its listener has answered complete; null ("—") until then, or when it failed or was cut at its limit. */
function received(d) {
    return state.loaded.has('monthPaid') && !state.paidError && !store.paidTruncated?.() ? receivedIn(d.paidCharges, state.month) : null;
}

const receivedText = (d) => { const r = received(d); return r === null ? '—' : money(r); };

/** RENT-21: this month's rent of one tenant: paid, part paid (₹X of ₹Y) or due. */
function monthStateLine(a) {
    const m = a.ended ? null : monthState(a.current);
    if (!m) return '';
    const text = m.status === 'paid' ? t('ui.rent.month_paid')
        : m.status === 'partial' ? t('ui.rent.month_part', { paid: formatINR(m.paid), amount: formatINR(m.amount) })
            : t('ui.rent.month_due', { amount: formatINR(m.due) });
    return `<div class="rent-sub" data-rent-month-state="${esc(m.status)}">${esc(text)}</div>`;
}

/** Needs attention: REM-2 and REM-4 as Today and the bell show them (utils/reminders.js), from this visit's data. */
function attentionHtml(d, ix) {
    const uid = AppState.currentUser?.uid;
    const rem = rentReminder(localStorage, uid, state.month);
    const notes = leaseReminder(localStorage, uid, state.month);
    const rows = [];
    if (rem?.late) {
        rows.push(`<button type="button" class="rent-attn-row" data-onclick="rentals.onlyLate(true)"><span>${et('ui.today.reminder_rent_units', { count: rem.dueUnits, late: rem.late })}</span><strong>${money(rem.due)}</strong></button>`);
    }
    const meters = meterPending(d, state.month).length;
    if (meters) rows.push(`<button type="button" class="rent-attn-row" data-onclick="rentals.meters()"><span>⚡ ${et('ui.rent.meter_pending', { n: meters })}</span></button>`);
    for (const x of notes?.items || []) {
        const lease = d.leases.find(l => placeOf(ix, l.unitId) === x.place && ix.tenants.get(l.tenantId)?.name === x.tenant);
        const fn = !lease ? '' : x.kind === 'increase' ? 'editLease' : isManager() ? 'agreement' : '';
        const text = `<span>${esc([x.place, x.tenant].filter(Boolean).join(' · '))}</span><span class="rent-sub">${esc(leaseReminderText(x))}</span>`;
        rows.push(fn ? `<button type="button" class="rent-attn-row" data-onclick="rentals.${fn}('${js(lease.id)}')">${text}</button>` : `<div class="rent-attn-row">${text}</div>`);
    }
    if (!rows.length) return '';
    const more = rows.length - 4 + (notes?.more || 0);
    return `<div class="rent-attn"><h3 class="rent-section-title">${et('ui.rent.needs_attention')}</h3>${rows.slice(0, 4).join('')}
        ${more > 0 ? `<div class="rent-sub">${et('ui.today.reminder_more', { count: more })}</div>` : ''}</div>`;
}

/** A tenant on This month: amount due, months owed, status; Collect and WhatsApp (and the meter reading still to enter). */
function collectRow(a, ix, lang) {
    const id = js(a.leaseId);
    const year = state.month.slice(0, 4);
    const months = a.dues.charges.map(c => formatMonth(`${c.month}-01`, { lang, year: c.month.slice(0, 4) !== year })).join(', ');
    const status = a.dues.total <= 0 ? badge('paid', 'ui.rent.status_paid')
        : [a.ended ? badge('vacant', 'ui.rent.moved_out') : '', a.partial ? badge('partial', 'ui.rent.status_partial') : a.late ? '' : badge('due', 'ui.rent.status_due'),
            a.late ? badge('late', 'ui.rent.status_late') : ''].filter(Boolean).join(' ');
    const meter = a.lease && a.current && elecMode(a.lease) === 'meter' && !a.current.electricity
        ? btn(' rent-btn-small', 'meter', `'${id}'`, 'ui.rent.meter_reading', '⚡ ') : '';
    const acts = a.dues.total > 0 ? `${btn(' rent-btn-small', 'pay', `'${id}'`, 'ui.rent.collect', '', ' data-rent-pay')}
        <button type="button" class="rent-btn rent-btn-small rent-btn-wa" aria-label="${et('ui.rent.whatsapp_reminder')}" data-onclick="rentals.remind('${id}')">${et('ui.rent.whatsapp')}</button>` : '';
    return `<div class="rent-list-row" data-lease="${esc(a.leaseId)}">
        <div class="rent-row-head"><div><div class="rent-name">${esc(a.name || t('ui.rent.no_name'))}</div>
            <div class="rent-sub">${esc(placeOf(ix, a.unitId, a.unitLabel || ''))}</div></div>
            <div class="rent-row-right">${a.dues.total > 0 ? `<div class="rent-due">${money(a.dues.total)}</div>` : ''}</div></div>
        <div class="rent-sub">${months ? `${esc(months)} · ` : ''}${status}</div>
        ${monthStateLine(a)}
        ${a.current?.adv > 0 ? `<div class="rent-sub">${et('ui.rent.adv_next', { amount: formatINR(a.current.adv) })}</div>` : ''}
        ${acts || meter ? `<div class="rent-actions">${acts}${meter}</div>` : ''}
    </div>`;
}

/** The sticky Record payment: one tenant owes → their payment; several → pick (late first). */
async function payAny() {
    const ix = index(store.snapshot());
    const owe = tenantRows(store.snapshot(), state.month).filter(a => a.dues.total > 0);
    if (owe.length < 2) return owe[0] ? pay(owe[0].leaseId) : undefined;
    const ok = await dialog(`<h3>${et('ui.rent.record_payment')}</h3>${lbl('ui.rent.tenant_pick', `<select id="rentPayWho">${owe.map(a => `<option value="${esc(a.leaseId)}">${esc(a.name)} · ${esc(placeOf(ix, a.unitId, a.unitLabel || ''))} · ${money(a.dues.total)}</option>`).join('')}</select>`)}`);
    if (ok && val('rentPayWho')) await pay(val('rentPayWho'));
}

function setMode(mode) {
    state.mode = mode === 'advanced' ? 'advanced' : 'simple';
    try { localStorage.setItem(modeKey(), state.mode); } catch (_) { /* private mode */ }
    render();
}

/** Property wise / Unit wise live in Advanced, so choosing one opens Advanced. */
function setView(view) {
    state.view = view === 'units' ? 'units' : 'properties';
    try { localStorage.setItem(VIEW_KEY, state.view); } catch (_) { /* private mode */ }
    if (state.mode !== 'advanced') return setMode('advanced');
    render();
}

/** A tenant's or property's screen; Back (page or phone) returns to the screen before it. */
let popBound = false;
let detailSeq = 0;
let dialogClosedAt = 0;
// Entries up to this key belong to screens left through the menu; Back does not reopen them.
let staleKeys = 0;
function openDetail(page, id) {
    if (!popBound) {
        popBound = true;
        window.addEventListener('popstate', (e) => {
            if (!state.detail) return;
            // Back that only closed a form keeps the screen; NavigationManager has re-pushed the entry below, so tag it.
            if (Date.now() - dialogClosedAt < 300) {
                try { history.replaceState({ ...(history.state || {}), rentDetail: state.detailKey, rentPage: state.page, rentId: state.detail }, ''); } catch (_) { /* no history */ }
                return;
            }
            const s = e.state || {};
            if (s.rentDetail === state.detailKey) return;
            if (s.rentDetail > staleKeys && s.rentDetail < state.detailKey && s.rentId) {
                Object.assign(state, { page: s.rentPage, detail: s.rentId, detailKey: s.rentDetail });
            } else state.detail = '';
            if (isVisible()) render();
        });
    }
    state.page = page;
    state.detail = String(id || '');
    state.detailKey = ++detailSeq;
    try { history.pushState({ ...(history.state || {}), rentDetail: state.detailKey, rentPage: page, rentId: state.detail }, ''); } catch (_) { /* no history */ }
    render();
    byId('rentDetailTitle')?.focus?.();
}
const openTenant = (id) => openDetail('tenants', id);
const showProperty = (id) => openDetail('properties', id);

/** Advanced's This month, opened at property `pid`. */
function propertyMonth(pid) {
    state.view = 'properties';
    state.openProperty = pid || '';
    return RentalsModule.enter('rent');
}

function back() {
    if (!state.detail) return;
    if (history.state?.rentDetail === state.detailKey) { history.back(); return; }
    state.detail = '';
    render();
}

function openProperty(id) {
    state.openProperty = id || '';
    render();
    byId('rentals')?.scrollIntoView?.({ block: 'start' });
}

/**
 * Record payment: amount (the oldest month's due, or a chip for all that is due), how it was paid; month, reference
 * and date under More. A refused amount reopens the form with the message under the amount.
 */
async function pay(leaseId, typed = null) {
    if (Helpers.isBusy('rent-pay')) return;
    const snap = store.snapshot();
    const dues = leaseDues(snap.charges, leaseId);
    if (!dues.charges.length) return;
    const lang = getLang();
    const first = dues.charges[0];
    const today = todayLocalISO();
    const v = typed || { id: first.id, amount: chargeDue(first), mode: 'cash', ref: '', date: today, error: '' };
    const due = (id) => chargeDue(dues.charges.find(c => c.id === id) || first);
    const options = dues.charges.map(c => `<option value="${esc(c.id)}" data-due="${esc(chargeDue(c))}"${c.id === v.id ? ' selected' : ''}>${esc(monthLabel(c.month, lang))} · ${money(chargeDue(c))}</option>`).join('');
    const chip = (key, n) => `<button type="button" class="rent-chip" data-amount="${esc(n)}" data-charge="${esc(first.id)}" data-onclick="rentals.fillAmount(this)">${et(key, { amount: formatINR(n) })}</button>`;
    const modes = PAYMENT_MODES.map(m => `<button type="button" class="rent-seg-btn${m === v.mode ? ' active' : ''}" aria-pressed="${m === v.mode ? 'true' : 'false'}" data-pay-mode="${m}" data-onclick="rentals.payMode(this)">${esc(modeLabel(m))}</button>`).join('');
    const name = snap.tenants.find(x => x.id === first.tenantId)?.name || first.tenantName || '';
    const html = `<h3>${et('ui.rent.record_payment')}${name ? ` · ${esc(name)}` : ''}</h3>
        ${lbl('ui.rent.amount', `
            <input id="rentPayAmount" type="number" inputmode="decimal" min="0" step="1" value="${esc(v.amount)}" aria-describedby="rentPayErr" data-oninput="rentals.payHint()">`)}
        <p id="rentPayErr" class="rent-field-error" role="alert"${v.error ? '' : ' hidden'}>${v.error ? et(v.error) : ''}</p>
        <div class="rent-chips">${chip('ui.rent.chip_oldest', chargeDue(first))}${dues.charges.length > 1 ? chip('ui.rent.chip_all', dues.total) : ''}</div>
        <div class="rent-label" id="rentPayModeL">${et('ui.rent.mode')}</div>
        <div class="rent-seg rent-seg-wide" role="group" aria-labelledby="rentPayModeL">${modes}</div>
        <input id="rentPayMode" type="hidden" value="${esc(v.mode)}">
        <details class="rent-more"${v.id !== first.id || v.ref || v.date !== today ? ' open' : ''}><summary>${et('ui.rent.more_pay')}</summary>
            ${lbl('ui.rent.month', `
                <select id="rentPayCharge" data-onchange="rentals.fillDue(this)">${options}</select>`)}
            ${lbl('ui.rent.reference', `<input id="rentPayRef" type="text" maxlength="60" value="${esc(v.ref)}">`)}
            ${lbl('ui.rent.date', `<input id="rentPayDate" type="date" value="${esc(v.date)}">`)}
        </details>
        <p id="rentPayAdv" class="rent-help"${Number(v.amount) > due(v.id) ? '' : ' hidden'}>${et('ui.rent.advance_help')}</p>`;
    const ok = await dialog(html);
    if (!ok) return;
    const id = val('rentPayCharge');
    const charge = dues.charges.find(c => c.id === id);
    const amount = Number(val('rentPayAmount'));
    const mode = PAYMENT_MODES.includes(val('rentPayMode')) ? val('rentPayMode') : 'cash';
    const ref = val('rentPayRef');
    const date = val('rentPayDate') || today;
    const again = (key) => {
        fail(key);
        return pay(leaseId, { id, amount: val('rentPayAmount'), mode, ref, date, error: key });
    };
    // RENT-5, RENT-16: more than the month's due pays the unpaid months oldest first; only the rest is an advance.
    let parts = [{ id, amount }];
    if (charge && amount > chargeDue(charge)) {
        try {
            parts = payOldestFirst(dues.charges, amount, store.snapshot().leases.find(l => l.id === leaseId)?.chargedThrough);
        } catch (e) {
            return again(e.message === 'over' ? 'msg.rent.more_than_due' : 'msg.rent.bad_amount');
        }
        const adv = parts[parts.length - 1].adv;
        const lines = parts.map(p => `${monthLabel(p.month, lang)}: ${formatINR(p.amount)}`).concat(adv ? [t('ui.rent.adv_next', { amount: formatINR(adv) })] : []).join(' · ');
        if (!await UIManager.showModal(t('msg.rent.pay_split', { lines }), t('ui.rent.record_payment'), true)) return;
    } else if (charge) {
        // The same check the save runs (applyPayment), before the form closes.
        try { applyPayment(charge, amount); } catch (e) { return again(e.message === 'too_many' ? 'msg.rent.too_many_payments' : 'msg.rent.bad_amount'); }
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
    payHint();
}

/** A chip's amount into the payment form; both chips start from the oldest unpaid month. */
function fillAmount(chip) {
    const input = byId('rentPayAmount');
    const month = byId('rentPayCharge');
    if (month && chip?.getAttribute('data-charge')) month.value = chip.getAttribute('data-charge');
    if (input && chip?.getAttribute('data-amount') != null) input.value = chip.getAttribute('data-amount');
    payHint();
}

function payMode(b) {
    const mode = b?.getAttribute('data-pay-mode');
    const input = byId('rentPayMode');
    if (!input || !PAYMENT_MODES.includes(mode)) return;
    input.value = mode;
    b.parentElement.querySelectorAll('[data-pay-mode]').forEach((x) => {
        x.classList.toggle('active', x === b);
        x.setAttribute('aria-pressed', String(x === b));
    });
}

/** The advance note only when the amount is more than the chosen month's due; a typed amount clears the message. */
function payHint() {
    const due = byId('rentPayCharge')?.selectedOptions?.[0]?.getAttribute('data-due');
    const adv = byId('rentPayAdv');
    if (adv && due != null) adv.hidden = !(Number(val('rentPayAmount')) > Number(due));
    const err = byId('rentPayErr');
    if (err) err.hidden = true;
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
    const a = tenantRows(d, state.month).find(x => x.leaseId === leaseId);
    if (!a || a.dues.total <= 0) return;
    const text = buildRentReminderText({
        tenantName: a.name, place: placeOf(ix, a.unitId, a.unitLabel || ''), charges: a.dues.charges,
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
/** Tenants / Properties pages and their forms (rent-pages.js), and Advanced's This month (rent-advanced.js), loaded on first use. */
const lazyMods = {};
const loadMod = (name) => (name === 'pages'
    ? Promise.all([import('./rent-pages.js'), import('./rent-tenants.js')]).then(([a, b]) => ({ ...a.pages, ...b.tenants }))
    : import('./rent-advanced.js').then(m => m.advanced)).then(m => (lazyMods[name] = m));
const loadPages = () => loadMod('pages');
const lazyCall = (name, fn) => (...args) => (lazyMods[name] ? lazyMods[name][fn](unitCtx(), ...args) : loadMod(name).then(p => p[fn](unitCtx(), ...args), (e) => {
    console.error('Rentals file not loaded:', e);
    fail('msg.rent.could_not_load');
}));
const pg = (fn) => lazyCall('pages', fn);
const fromPages = (fn) => (...args) => lazyMods.pages[fn](unitCtx(), ...args);

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
    defaults, headerName, tenantSectionHtml: fromPages('tenantSectionHtml'), readTenantSection: fromPages('readTenantSection'), checkTenantSection: fromPages('checkTenantSection'),
    elecFieldsHtml: fromPages('elecFieldsHtml'), saveRent: fromPages('saveRent'), refreshLinkNames: fromPages('refreshLinkNames'), back,
    saveMoveIn: (...a) => whileMoving(() => fromPages('saveMoveIn')(...a)), isManager: isManager(), isOwner: isOwner(), canWrite: canWrite(), month: state.month,
    state, received, typeLabel, elecTag, sinceText, receiptsBtn, payBtns, badge, render, unitUi, depUi, linkUi: (fn, ...a) => lazyUi('./rent-link.js', fn, ...a), unitMod, unitCtx, auditWarn
});

/** Runs function `fn` of a lazy file (rent-unit.js / rent-link.js) with what it needs from here. */
function lazyUi(file, fn, ...args) {
    return (file === './rent-unit.js' ? loadPages().then(unitMod) : file === './rent-deposit.js' ? import('./rent-deposit.js') : file === './rent-expense.js' ? import('./rent-expense.js') : file === './rent-report.js' ? import('./rent-report.js') : file === './rent-meter.js' ? import('./rent-meter.js') : import('./rent-link.js')).then(
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

/**
 * Rentals form dialog (template #rentDialog); resolves true on Save. Inputs stay readable after it closes.
 * `info`: no Save button; `check`: on Save, false keeps it open (it shows the error at the field).
 */
function dialog(html, { info = false, check: canSave = null } = {}) {
    dialogResolve?.(false);
    const box = byId('rentDialog');
    const body = byId('rentDialogBody');
    if (!box || !body) return Promise.resolve(false);
    body.innerHTML = html;
    const save = box.querySelector('.rent-dialog-actions .rent-btn-primary');
    if (save) save.hidden = info;
    const close = box.querySelector('.rent-dialog-actions .rent-btn:not(.rent-btn-primary)');
    if (close) close.textContent = t(info ? 'ui.common.close' : 'ui.modals.cancel');
    box.hidden = false;
    body.querySelector('input, select')?.focus();
    return new Promise((resolve) => {
        dialogResolve = (v) => {
            if (v === true && canSave && !canSave()) return;
            dialogClosedAt = Date.now();
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
        state.detail = '';
        staleKeys = detailSeq;
        NavigationManager.showTab('rentals');
        if (!store.isAttached()) {
            state.month = monthKey();
            state.loaded.clear();
            state.errors.clear();
            state.paidError = false;
            state.charged.clear();
            store.attach(state.month, onData);
        }
        state.lazyFailed = false;
        state.onlyLate = false;
        state.mode = savedMode();
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
        pay: (id) => pay(id), fillDue, fillAmount, payMode, payHint, remind, payAny, setMode, onlyLate: (on) => { state.onlyLate = on === undefined ? !state.onlyLate : !!on; render(); },
        settings: (which) => NavigationManager.showTabFromNav(which === 'roles' ? 'settings-roles' : 'settings-rentals'),
        filterUnits: lazyCall('advanced', 'filterUnits'),
        ...Object.fromEntries(['meter', 'editLease', 'addTenant', 'editTenant', 'archiveTenant', 'moveIn', 'moveOut', 'fillRent', 'addProperty', 'editProperty',
            'archiveProperty', 'addUnit', 'editUnit', 'archiveUnit', 'tenantToggle', 'tenantPick', 'tenantElec', 'changeUnit', 'tenantList', 'remindTenant'].map(n => [n, pg(n)])),
        openTenant, showProperty, propertyMonth, back,
        shareLink: (id) => lazyUi('./rent-link.js', 'shareLink', id), linkAction: (a, id) => lazyUi('./rent-link.js', 'linkAction', a, id), setView, openProperty,
        addTenantToUnit: (unitId) => unitUi('toUnit', null, unitId),
        receipts: (tenantId) => receiptUi('showHistory', tenantId),
        receiptAction: (name, id) => receiptUi('action', name, id),
        deposit: (id) => depUi('showDeposit', id), deposits: () => depUi('showHeld'), depositAction: (a, id, i) => depUi('action', a, id, i), advanceToDeposit: (id) => depUi('advanceAction', id),
        expenses: (pid) => expUi('showExpenses', pid), expenseAction: (a, pid, id) => expUi('action', a, pid, id),
        agreement: (id) => lazyUi('./rent-report.js', 'editAgreement', id), yearReport: () => lazyUi('./rent-report.js', 'showYearReport'),
        reportAction: (a, v) => lazyUi('./rent-report.js', 'action', a, v),
        meters: () => lazyUi('./rent-meter.js', 'showMeters'), meterPreview: () => lazyUi('./rent-meter.js', 'preview')
    }
};

export const _test = {
    state, index, render, maybeCharge, moveIn: pg('moveIn'), placeOf, linkPlace, pay, toUnit: (...a) => unitUi('toUnit', ...a), editTenant: pg('editTenant'), addTenant: pg('addTenant')
};
