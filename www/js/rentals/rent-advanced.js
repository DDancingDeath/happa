/**
 * @fileoverview Rentals › This month in Advanced: the property wise and unit wise views with their totals
 * (RENT-9/10, RENT-17/18), filters and unit rows. Loaded with import() by rentals.js only in Advanced.
 * @module rentals/rent-advanced
 */

import { Helpers } from '../utils/helpers.js';
import { formatINR } from '../utils/due-reminder.js';
import { moneyHtml, moneyInText } from '../ui/components.js';
import { icon } from '../ui/icons.js';
import { t, getLang } from '../i18n/index.js';
import * as store from './rent-store.js';
import { UNIT_TYPES, unitRows, summarize, propertySummaries, groupByType, filterRows, typedPlace, tenantRows } from './rent-views.js';
import { monthLabel, chargeStatus, chargeDue, leaseDues, increaseDue, elecMode, expenseTotals, netOf } from './rent-math.js';

const esc = (v) => Helpers.escapeHtml(v);
const js = (v) => Helpers.escapeJsAttr(v);
const money = (n) => { const h = moneyHtml(n); return h === '—' ? esc(formatINR(n)) : h; };
const et = (key, p) => esc(t(key, p));
const btn = (cls, fn, args, key, icon = '', attrs = '') => `<button type="button" class="btn${cls}"${attrs} data-onclick="rentals.${fn}(${args})">${icon}${et(key)}</button>`;

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
    const power = e ? ` <span class="rent-sub">${moneyInText(t('ui.rent.incl_electricity', { amount: formatINR(e.amount), units: e.units }), e.amount)}</span>` : '';
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
    ].map(([k, v]) => `<div class="metric"><div class="metric-label">${et(k)}</div><div class="metric-value">${v === null ? '—' : money(v)}</div></div>`).join('');
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
    const sw = `<div class="seg rent-viewswitch" role="group">
        <button type="button" aria-pressed="${view === 'properties'}" data-onclick="rentals.setView('properties')">${et('ui.rent.view_properties')}</button>
        <button type="button" aria-pressed="${view === 'units'}" data-onclick="rentals.setView('units')">${et('ui.rent.view_units')}</button>
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
        <button type="button" class="row rent-entry" data-property="${esc(p.id)}" data-onclick="rentals.openProperty('${js(p.id)}')">
            <div class="rent-entry-head">
                <div class="row-main"><div class="row-title">${esc(p.name)}</div>
                    <div class="row-meta">${esc(typeCounts(s.byType) || t('ui.rent.no_units'))}</div>
                    <div class="row-meta">${et('ui.rent.occupancy', { occupied: s.occupied, vacant: s.vacant })}${s.late ? ` · ${et('ui.rent.late_count', { n: s.late })}` : ''}</div></div>
                <div class="row-trail"><div class="row-amt">${money(s.pending)}</div><div class="row-meta">${et('ui.rent.pending_month')}</div></div>
            </div>
            <div class="row-meta">${moneyInText(t('ui.rent.prop_month_line', { expected: formatINR(s.expected), collected: formatINR(s.collected) }), [s.expected, s.collected])}${ex.byProperty[p.id] ? ` · ${moneyInText(t('ui.rent.exp_line', { amount: formatINR(ex.byProperty[p.id]) }), ex.byProperty[p.id])}` : ''}</div>
        </button>`).join('');
    const empty = `<p class="empty">${et('ui.rent.no_properties')}</p>`
        + (c.canWrite ? btn(' btn-primary', 'page', `'properties'`, 'ui.rent.add_property', icon('plus', 'i-sm')) : '');
    return `<div class="panel metrics rent-metrics">${totalsCards(summarize(rows), ex.total, c.received(d))}</div>
        ${cards ? `<div class="panel">${cards}</div>` : empty}`;
}

function renderPropertyDetail(d, ix, rows) {
    const p = ix.properties.get(c.state.openProperty);
    const mine = rows.filter(r => r.propertyId === p.id);
    const s = summarize(mine);
    const groups = groupByType(mine).map(g => `
        <h4 class="rent-group-title">${esc(c.typeLabel(g.type))} (${g.rows.length})</h4>
        <div class="panel">${g.rows.map(r => unitRowHtml(r, d, { showProperty: false })).join('')}</div>`).join('');
    return `<div class="rent-detail-head">
            ${btn(' btn-ghost btn-sm', 'openProperty', `''`, 'ui.rent.all_properties', icon('chevL', 'i-sm'))}
            <h3 class="rent-detail-title">${esc(p.name)}</h3>
            <div class="rent-sub">${esc(typeCounts(s.byType))} · ${et('ui.rent.occupancy', { occupied: s.occupied, vacant: s.vacant })}</div>
        </div>
        <div class="panel metrics rent-metrics">${totalsCards(s, expenseTotals(d.expenses, c.state.month).byProperty[p.id] || 0)}</div>
        ${groups || `<p class="empty">${et('ui.rent.no_units')}</p>`}`;
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
        ? `${esc(r.tenantName || t('ui.rent.no_name'))} · ${moneyInText(t('ui.rent.rent_terms', { amount: formatINR(lease.rent), day: lease.dueDay }), lease.rent)} ${c.elecTag(lease)}${lease.startDate ? ` · ${esc(c.sinceText(lease))}` : ''}`
        : `${et('ui.rent.vacant')} · ${money(r.rent)}`;
    const months = dues.charges.map(x => monthLine(x, lang)).join('');
    const inc = lease ? increaseDue(lease, c.state.month) : { due: false };
    const increase = inc.due
        ? `<div class="notice info rent-increase">${icon('trend', 'i-sm')}<span class="grow">${moneyInText(t('ui.rent.increase_due', { pct: inc.pct, amount: formatINR(inc.newRent) }), inc.newRent)}</span>
            ${btn(' btn-sm', 'editLease', `'${js(lease.id)}'`, 'ui.rent.update_rent')}</div>`
        : '';
    const actions = lease ? ((dues.total > 0
        ? `${c.payBtns(lease.id)}`
        : '') + (current && elecMode(lease) === 'meter' && (!current.electricity || c.isManager)
        ? btn('', 'meter', `'${js(lease.id)}'`, 'ui.rent.meter_reading', icon('bolt', 'i-sm'))
        : '') + c.receiptsBtn(lease.tenantId)) : (c.canWrite
        ? btn(' btn-primary', 'addTenantToUnit', `'${js(r.unitId)}'`, 'ui.rent.add_tenant')
        : '');
    return `<div class="row rent-entry" data-unit="${esc(r.unitId)}">
        <div class="rent-entry-head">
            <div class="row-main"><div class="row-title">${head}</div>
                <div class="row-meta">${who}</div>${extra ? `<div class="row-meta">${extra}</div>` : ''}</div>
            <div class="row-trail">${rowBadge(r)}<div class="row-amt">${money(r.due)}</div></div>
        </div>
        ${months ? `<ul class="rent-months">${months}</ul>` : ''}
        ${current?.adv > 0 ? `<div class="row-meta">${moneyInText(t('ui.rent.adv_next', { amount: formatINR(current.adv) }), current.adv)}</div>` : ''}
        ${increase}
        ${actions ? `<div class="rent-actions">${actions}</div>` : ''}
    </div>`;
}

function renderUnitView(d, rows) {
    const f = c.state.filters;
    const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
    const props = [...d.properties].sort((a, b) => a.name.localeCompare(b.name));
    const controls = `<div class="panel panel-pad rent-filters">
        <select class="input" aria-label="${et('ui.rent.filter_property')}" data-onchange="rentals.filterUnits('propertyId', this.value)">
            ${opt('', t('ui.rent.all_properties'), f.propertyId)}${props.map(p => opt(p.id, p.name, f.propertyId)).join('')}</select>
        <select class="input" aria-label="${et('ui.rent.filter_type')}" data-onchange="rentals.filterUnits('type', this.value)">
            ${opt('', t('ui.rent.all_types'), f.type)}${UNIT_TYPES.map(k => opt(k, c.typeLabel(k), f.type)).join('')}</select>
        <select class="input" aria-label="${et('ui.rent.filter_status')}" data-onchange="rentals.filterUnits('status', this.value)">
            ${opt('', t('ui.rent.all_statuses'), f.status)}${['occupied', 'vacant', 'late', 'due'].map(k => opt(k, t(`ui.rent.filter_${k}`), f.status)).join('')}</select>
        <input class="input" type="search" value="${esc(f.q)}" placeholder="${et('ui.rent.search_units')}" aria-label="${et('ui.rent.search_units')}" data-oninput="rentals.filterUnits('q', this.value)">
        ${btn(' btn-sm', 'filterUnits', `'sort', '${f.sort === 'desc' ? 'asc' : 'desc'}'`, f.sort === 'desc' ? 'ui.rent.sort_due_desc' : 'ui.rent.sort_due_asc')}
    </div>`;
    return `${controls}<div id="rentUnitList">${unitListHtml(d, rows)}</div>`;
}

/** The filtered unit list and its totals (same RENT-9 sum as the property view). */
function unitListHtml(d, rows) {
    const shown = filterRows(rows, c.state.filters);
    return `<div class="panel metrics rent-metrics">${totalsCards(summarize(shown))}</div>
        ${shown.length ? `<div class="panel">${shown.map(r => unitRowHtml(r, d)).join('')}</div>` : `<p class="empty">${et('ui.rent.no_matching_units')}</p>`}`;
}

/** Tenants who moved out and still owe rent (not on any unit any more). */
function renderMovedOut(d, ix) {
    const gone = tenantRows(d, c.state.month).filter(a => a.ended);
    if (!gone.length) return '';
    return `<h3 class="rent-month-title">${et('ui.rent.moved_out_due')}</h3><div class="panel">${gone.map(a => `<div class="row rent-entry" data-lease="${esc(a.leaseId)}">
        <div class="rent-entry-head"><div class="row-main"><div class="row-title">${esc(a.name || t('ui.rent.no_name'))}</div>
            <div class="row-meta">${esc(c.placeOf(ix, a.unitId, a.unitLabel))} · ${et('ui.rent.moved_out')}</div></div>
            <div class="row-trail"><div class="row-amt">${money(a.dues.total)}</div></div></div>
        <ul class="rent-months">${a.dues.charges.map(x => monthLine(x, getLang())).join('')}</ul>
        <div class="rent-actions">
            ${c.payBtns(a.leaseId)}
        </div></div>`).join('')}</div>`;
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
