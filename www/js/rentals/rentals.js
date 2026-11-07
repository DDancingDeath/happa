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
    UNIT_TYPES, VIEW_KEY, unitRows, summarize, tenantRows, placeText, typedPlace
} from './rent-views.js';
import {
    PAYMENT_MODES, normalizeRentSettings, monthKey, monthLabel, monthsToCharge, chargeDue, leaseDues,
    buildRentReminderText, elecMode, dateLabel, payOldestFirst, payAmount
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
    const need = state.page !== 'rent' ? 'pages' : adv ? 'advanced' : '';
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
        : renderRent(d, adv));
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

/** Needs attention: REM-2 and REM-4 as Today and the bell show them (utils/reminders.js), from this visit's data. */
function attentionHtml(d, ix) {
    const uid = AppState.currentUser?.uid;
    const rem = rentReminder(localStorage, uid, state.month);
    const notes = leaseReminder(localStorage, uid, state.month);
    const rows = [];
    if (rem?.late) {
        rows.push(`<button type="button" class="rent-attn-row" data-onclick="rentals.onlyLate(true)"><span>${et('ui.today.reminder_rent_units', { count: rem.dueUnits, late: rem.late })}</span><strong>${money(rem.due)}</strong></button>`);
    }
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
const unitCtx = () => ({
    esc, js, val, dialog, closeDialog: () => dialogResolve?.(false), index, placeOf, linkPlace, linkFor, findLease, knownType, typeWord,
    defaults, headerName, tenantSectionHtml: fromPages('tenantSectionHtml'), readTenantSection: fromPages('readTenantSection'), checkTenantSection: fromPages('checkTenantSection'),
    elecFieldsHtml: fromPages('elecFieldsHtml'), saveRent: fromPages('saveRent'), refreshLinkNames: fromPages('refreshLinkNames'), back,
    saveMoveIn: fromPages('saveMoveIn'), isManager: isManager(), isOwner: isOwner(), canWrite: canWrite(), month: state.month,
    state, typeLabel, elecTag, sinceText, receiptsBtn, payBtns, badge, render, unitUi, depUi, linkUi: (fn, ...a) => lazyUi('./rent-link.js', fn, ...a), unitMod, unitCtx, auditWarn
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

/**
 * Rentals form dialog (template #rentDialog); resolves true on Save. Inputs stay readable after it closes.
 * `info`: no Save button; `check`: on Save, false keeps it open (it shows the error at the field).
 */
function dialog(html, { info = false, check = null } = {}) {
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
            if (v === true && check && !check()) return;
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
        pay, fillDue, remind, payAny, setMode, onlyLate: (on) => { state.onlyLate = on === undefined ? !state.onlyLate : !!on; render(); },
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
        reportAction: (a, v) => lazyUi('./rent-report.js', 'action', a, v)
    }
};

export const _test = {
    state, index, render, maybeCharge, moveIn: pg('moveIn'), placeOf, linkPlace, pay, toUnit: (...a) => unitUi('toUnit', ...a), editTenant: pg('editTenant'), addTenant: pg('addTenant')
};
