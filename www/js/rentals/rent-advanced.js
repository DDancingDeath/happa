/**
 * @fileoverview Rentals › This month in Advanced: the property wise and unit wise views with their totals
 * (RENT-9/10, RENT-17/18), filters and unit rows. Loaded with import() by rentals.js only in Advanced.
 * @module rentals/rent-advanced
 */

import { Helpers } from '../utils/helpers.js';
import { formatINR } from '../utils/due-reminder.js';
import { t, getLang } from '../i18n/index.js';
import * as store from './rent-store.js';
import { UNIT_TYPES, unitRows, summarize, propertySummaries, groupByType, filterRows, typedPlace, tenantRows } from './rent-views.js';
import { monthLabel, chargeStatus, chargeDue, leaseDues, increaseDue, elecMode, expenseTotals, netOf } from './rent-math.js';

const esc = (v) => Helpers.escapeHtml(v);
const js = (v) => Helpers.escapeJsAttr(v);
const money = (n) => esc(formatINR(n));
const et = (key, p) => esc(t(key, p));
const btn = (cls, fn, args, key, icon = '', attrs = '') => `<button type="button" class="rent-btn${cls}"${attrs} data-onclick="rentals.${fn}(${args})">${icon}${et(key)}</button>`;

/** rentals.js's context, set by every exported call. */
let c = null;

/** Paid, or Due / Part paid plus Late after the lease's due day. */
function statusBadges(charge) {
    if (!charge) return '';
    const s = chargeStatus(charge);
    if (s.status === 'paid') return c.badge('paid', 'ui.rent.status_paid');
    return c.badge(s.status, s.status === 'partial' ? 'ui.rent.status_partial' : 'ui.rent.status_due')
        + (s.late ? ` ${c.badge('late', 'ui.rent.status_late')}` : '');
}

function monthLine(ch, lang) {
    const e = ch.electricity;
    const power = e ? ` <span class="rent-sub">${et('ui.rent.incl_electricity', { amount: formatINR(e.amount), units: e.units })}</span>` : '';
    return `<li>${esc(monthLabel(ch.month, lang))}: ${money(chargeDue(ch))} ${statusBadges(ch)}${power}</li>`;
}

/** Paid / Part paid / Due / Late / Vacant for a unit row (RENT-10). */
function rowBadge(r) {
    return r.status === 'vacant' ? c.badge('vacant', 'ui.rent.vacant')
        : r.status === 'paid' ? c.badge('paid', 'ui.rent.status_paid')
        : r.status === 'late' ? c.badge('late', 'ui.rent.status_late')
        : r.status === 'partial' ? c.badge('partial', 'ui.rent.status_partial')
        : c.badge('due', 'ui.rent.status_due');
}

/** RENT-9 cards; with this month's expenses (RENT-17) also the net (RENT-18); with `rec` RENT-20 (null: not loaded, "—"). */
function totalsCards(sum, exp, rec) {
    return [
        ['ui.rent.expected', sum.expected],
        ['ui.rent.collected', sum.collected],
        ...(rec === undefined ? [] : [['ui.rent.received_month', rec]]),
        ['ui.rent.pending_month', sum.pending],
        ['ui.rent.outstanding', sum.due],
        ...(exp === undefined ? [] : [['ui.rent.exp_month', exp], ['ui.rent.net_month', netOf(sum.collected, exp)]])
    ].map(([k, v]) => `<div class="rent-card"><div class="rent-card-label">${et(k)}</div><div class="rent-card-value">${v === null ? '—' : money(v)}</div></div>`).join('');
}

/** "6 flats · 3 commercial" in the chosen language. */
function typeCounts(byType) {
    return UNIT_TYPES.filter(k => byType[k]).map(k => t(`ui.rent.count_${k}`, { n: byType[k] })).join(' · ');
}

/** Today's Rent page: property wise or unit wise; tenants who moved out owing are listed once, not under a property. */
function renderAdvanced(d, rows) {
    const ix = c.index(d);
    const lang = getLang();
    const view = c.state.view === 'units' ? 'units' : 'properties';
    const sw = `<div class="rent-viewswitch" role="group">
        <button type="button" class="filter-btn${view === 'properties' ? ' active' : ''}" aria-pressed="${view === 'properties'}" data-onclick="rentals.setView('properties')">${et('ui.rent.view_properties')}</button>
        <button type="button" class="filter-btn${view === 'units' ? ' active' : ''}" aria-pressed="${view === 'units'}" data-onclick="rentals.setView('units')">${et('ui.rent.view_units')}</button>
    </div>`;
    const body = view === 'units' ? renderUnitView(d, rows) : renderPropertyView(d, ix, rows);
    return `<h3 class="rent-month-title">${esc(monthLabel(c.state.month, lang))}</h3>
        ${sw}
        ${body}
        ${view === 'units' || !c.state.openProperty ? renderMovedOut(d, ix) : ''}`;
}

function renderPropertyView(d, ix, rows) {
    if (c.state.openProperty && d.properties.some(p => p.id === c.state.openProperty)) return renderPropertyDetail(d, ix, rows);
    c.state.openProperty = '';
    const ex = expenseTotals(d.expenses, c.state.month);
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
        + (c.canWrite ? btn(' rent-btn-primary', 'page', `'properties'`, 'ui.rent.add_property') : '');
    return `<div class="rent-cards">${totalsCards(summarize(rows), ex.total, c.received(d))}</div>
        ${cards || empty}`;
}

function renderPropertyDetail(d, ix, rows) {
    const p = ix.properties.get(c.state.openProperty);
    const mine = rows.filter(r => r.propertyId === p.id);
    const s = summarize(mine);
    const groups = groupByType(mine).map(g => `
        <h4 class="rent-group-title">${esc(c.typeLabel(g.type))} (${g.rows.length})</h4>
        ${g.rows.map(r => unitRowHtml(r, d, { showProperty: false })).join('')}`).join('');
    return `<div class="rent-detail-head">
            ${btn(' rent-btn-small', 'openProperty', `''`, 'ui.rent.all_properties', '← ')}
            <h3 class="rent-name">${esc(p.name)}</h3>
            <div class="rent-sub">${esc(typeCounts(s.byType))} · ${et('ui.rent.occupancy', { occupied: s.occupied, vacant: s.vacant })}</div>
        </div>
        <div class="rent-cards">${totalsCards(s, expenseTotals(d.expenses, c.state.month).byProperty[p.id] || 0)}</div>
        ${groups || `<p class="rent-empty">${et('ui.rent.no_units')}</p>`}`;
}

/** One unit: tenant, rent, status, amount due, open months, quick actions. */
function unitRowHtml(r, d, { showProperty = true } = {}) {
    const lang = getLang();
    const lease = r.leaseId ? d.leases.find(l => l.id === r.leaseId) : null;
    const dues = lease ? leaseDues(d.charges, lease.id) : { charges: [], total: 0 };
    const current = lease ? d.charges.find(x => x.leaseId === lease.id && x.month === c.state.month) : null;
    const head = esc(typedPlace(c.typeWord(r.type), r.label, showProperty ? r.propertyName : ''));
    const extra = [r.floor ? t('ui.rent.floor_value', { floor: r.floor }) : '', r.area ? t('ui.rent.area_value', { area: r.area }) : '']
        .filter(Boolean).map(esc).join(' · ');
    const who = lease
        ? `${esc(r.tenantName || t('ui.rent.no_name'))} · ${et('ui.rent.rent_terms', { amount: formatINR(lease.rent), day: lease.dueDay })} ${c.elecTag(lease)}${lease.startDate ? ` · ${esc(c.sinceText(lease))}` : ''}`
        : `${et('ui.rent.vacant')} · ${money(r.rent)}`;
    const months = dues.charges.map(x => monthLine(x, lang)).join('');
    const inc = lease ? increaseDue(lease, c.state.month) : { due: false };
    const increase = inc.due
        ? `<div class="rent-increase">📈 ${et('ui.rent.increase_due', { pct: inc.pct, amount: formatINR(inc.newRent) })}
            ${btn(' rent-btn-small', 'editLease', `'${js(lease.id)}'`, 'ui.rent.update_rent')}</div>`
        : '';
    const actions = lease ? ((dues.total > 0
        ? `${c.payBtns(lease.id)}`
        : '') + (current && elecMode(lease) === 'meter' && (!current.electricity || c.isManager)
        ? btn('', 'meter', `'${js(lease.id)}'`, 'ui.rent.meter_reading', '⚡ ')
        : '') + c.receiptsBtn(lease.tenantId)) : (c.canWrite
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
    const f = c.state.filters;
    const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
    const props = [...d.properties].sort((a, b) => a.name.localeCompare(b.name));
    const controls = `<div class="rent-filters">
        <select aria-label="${et('ui.rent.filter_property')}" data-onchange="rentals.filterUnits('propertyId', this.value)">
            ${opt('', t('ui.rent.all_properties'), f.propertyId)}${props.map(p => opt(p.id, p.name, f.propertyId)).join('')}</select>
        <select aria-label="${et('ui.rent.filter_type')}" data-onchange="rentals.filterUnits('type', this.value)">
            ${opt('', t('ui.rent.all_types'), f.type)}${UNIT_TYPES.map(k => opt(k, c.typeLabel(k), f.type)).join('')}</select>
        <select aria-label="${et('ui.rent.filter_status')}" data-onchange="rentals.filterUnits('status', this.value)">
            ${opt('', t('ui.rent.all_statuses'), f.status)}${['occupied', 'vacant', 'late', 'due'].map(k => opt(k, t(`ui.rent.filter_${k}`), f.status)).join('')}</select>
        <input type="search" value="${esc(f.q)}" placeholder="${et('ui.rent.search_units')}" aria-label="${et('ui.rent.search_units')}" data-oninput="rentals.filterUnits('q', this.value)">
        ${btn(' rent-btn-small', 'filterUnits', `'sort', '${f.sort === 'desc' ? 'asc' : 'desc'}'`, f.sort === 'desc' ? 'ui.rent.sort_due_desc' : 'ui.rent.sort_due_asc')}
    </div>`;
    return `${controls}<div id="rentUnitList">${unitListHtml(d, rows)}</div>`;
}

/** The filtered unit list and its totals (same RENT-9 sum as the property view). */
function unitListHtml(d, rows) {
    const shown = filterRows(rows, c.state.filters);
    return `<div class="rent-cards">${totalsCards(summarize(shown))}</div>
        ${shown.map(r => unitRowHtml(r, d)).join('') || `<p class="rent-empty">${et('ui.rent.no_matching_units')}</p>`}`;
}

/** Tenants who moved out and still owe rent (not on any unit any more). */
function renderMovedOut(d, ix) {
    const gone = tenantRows(d, c.state.month).filter(a => a.ended);
    if (!gone.length) return '';
    return `<h3 class="rent-month-title">${et('ui.rent.moved_out_due')}</h3>${gone.map(a => `<div class="rent-row">
        <div class="rent-row-head"><div><div class="rent-name">${esc(a.name || t('ui.rent.no_name'))}</div>
            <div class="rent-sub">${esc(c.placeOf(ix, a.unitId, a.unitLabel))} · ${et('ui.rent.moved_out')}</div></div>
            <div class="rent-row-right"><div class="rent-due">${money(a.dues.total)}</div></div></div>
        <ul class="rent-months">${a.dues.charges.map(x => monthLine(x, getLang())).join('')}</ul>
        <div class="rent-actions">
            ${c.payBtns(a.leaseId)}
        </div></div>`).join('')}`;
}

/** Unit view filters: only the list redraws, so the search box keeps its focus. */
function filterUnits(field, value) {
    if (!['propertyId', 'type', 'status', 'q', 'sort'].includes(field)) return;
    c.state.filters = { ...c.state.filters, [field]: String(value ?? '') };
    if (field === 'sort') { c.render(); return; }
    const list = document.getElementById('rentUnitList');
    if (!list) { c.render(); return; }
    const d = store.snapshot();
    list.innerHTML = unitListHtml(d, unitRows(d, c.state.month));
}

export const advanced = Object.fromEntries(Object.entries({ renderAdvanced, filterUnits })
    .map(([k, f]) => [k, (ctx, ...a) => { c = ctx; return f(...a); }]));
