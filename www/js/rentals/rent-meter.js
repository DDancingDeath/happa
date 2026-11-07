/**
 * @fileoverview Meter readings for every tenancy still without this month's reading (Needs attention › REM-7).
 * Each filled row is saved by the same `store.recordMeter` transaction as one reading, one after another.
 * Loaded with import() by rentals.js only when used, so it is not precached (docs/rentals-design.md §4).
 * @module rentals/rent-meter
 */

import { UIManager } from '../ui/ui-manager.js';
import { t, getLang } from '../i18n/index.js';
import { formatINR } from '../utils/due-reminder.js';
import { sumMoney } from '../utils/money.js';
import { AuditService } from '../services/audit.js';
import * as store from './rent-store.js';
import { meterBill, monthLabel } from './rent-math.js';
import { meterPending } from './rent-views.js';

const byId = (id) => document.getElementById(id);
const ERRORS = { below_paid: 'msg.rent.below_paid', already: 'msg.rent.meter_already' };

/** The open sheet's rows (what was pending when it opened). */
let rows = [];

function pendingRows(c, d, defs) {
    const ix = c.index(d);
    return meterPending(d, c.state.month).map(({ lease, charge }) => {
        const unit = d.units.find(u => u.id === lease.unitId);
        // Same locks as one reading: a known previous reading is fixed; a member keeps the unit's rate.
        return unit && {
            lease, charge, unit, name: ix.tenants.get(lease.tenantId)?.name || '', place: c.placeOf(ix, lease.unitId),
            prev: unit.lastReading ?? 0, prevLocked: unit.lastReading != null,
            rate: unit.meterRate ?? defs.meterRate ?? '', rateLocked: !c.isManager && unit.meterRate != null
        };
    }).filter(Boolean);
}

const num = (c, id, value, locked, label) => `<label class="rent-label">${c.esc(t(label))}<input id="${id}" type="number" inputmode="decimal" min="0" step="0.01" value="${c.esc(value)}"${locked ? ' readonly' : ''} data-oninput="rentals.meterPreview()"></label>`;

function rowHtml(c, r, i) {
    const rate = num(c, `rentMR${i}`, r.rate, r.rateLocked, 'ui.rent.meter_rate');
    return `<div class="rent-list-row" data-meter-row="${i}">
        <div class="rent-name">${c.esc([r.place, r.name].filter(Boolean).join(' · '))}</div>
        ${r.prevLocked ? `<div class="rent-sub">${c.esc(t('ui.rent.meter_prev_value', { value: r.prev }))}</div><input id="rentMP${i}" type="hidden" value="${c.esc(r.prev)}">`
        : num(c, `rentMP${i}`, r.prev, false, 'ui.rent.meter_prev')}
        ${num(c, `rentMC${i}`, '', false, 'ui.rent.meter_curr')}
        ${r.rate === '' ? rate : `<details class="rent-more"><summary>${c.esc(t('ui.rent.rate_per_unit', { rate: r.rate }))}</summary>${rate}</details>`}
        <p class="rent-sub" id="rentMB${i}" role="status"></p>
    </div>`;
}

const typed = (i) => ({ prev: byId(`rentMP${i}`)?.value ?? '', curr: (byId(`rentMC${i}`)?.value ?? '').trim(), rate: byId(`rentMR${i}`)?.value ?? '' });

/** The bill of row i: null when its reading is empty; throws on a bad reading or rate (RENT-7). */
function billOf(i) {
    const v = typed(i);
    return v.curr === '' ? null : meterBill(v);
}

/** Every row's preview: units × rate = amount, or what is wrong. */
export function preview() {
    rows.forEach((r, i) => {
        const out = byId(`rentMB${i}`);
        if (!out) return;
        try {
            const b = billOf(i);
            out.textContent = b ? t('ui.rent.meter_preview', { units: b.units, rate: b.rate, amount: formatINR(b.amount) }) : '';
            out.classList.remove('rent-field-error');
        } catch (_) {
            out.textContent = t('msg.rent.bad_reading');
            out.classList.add('rent-field-error');
        }
    });
}

/** Save: keeps the sheet open on a bad row (focused) or when nothing was entered. */
function check() {
    preview();
    let any = false;
    for (let i = 0; i < rows.length; i++) {
        try {
            if (billOf(i)) any = true;
        } catch (_) {
            byId(`rentMC${i}`)?.focus();
            return false;
        }
    }
    if (any) return true;
    const out = byId('rentMB0');
    if (out) {
        out.textContent = t('msg.rent.meter_none');
        out.classList.add('rent-field-error');
    }
    byId('rentMC0')?.focus();
    return false;
}

/** The sheet: every tenancy on our meter without this month's reading. */
export async function showMeters(c) {
    const defs = await c.defaults();
    rows = pendingRows(c, store.snapshot(), defs);
    if (!rows.length) return UIManager.showToast(t('msg.rent.meter_none_left'), 'info');
    const ok = await c.dialog(`<h3>⚡ ${c.esc(t('ui.rent.meter_readings'))} · ${c.esc(monthLabel(c.state.month, getLang()))}</h3>
        <p class="rent-help">${c.esc(t('ui.rent.meter_bulk_help'))}</p>
        <div class="rent-list">${rows.map((r, i) => rowHtml(c, r, i)).join('')}</div>`, { check });
    if (!ok) return;
    const filled = rows.map((r, i) => ({ r, bill: billOf(i) })).filter(x => x.bill);
    const results = [];
    for (const { r, bill } of filled) {
        try {
            // Entered on another phone meanwhile: keep it (this sheet only fills missing readings).
            if (store.snapshot().charges.find(x => x.id === r.charge.id)?.electricity) throw new Error('already');
            await store.recordMeter(r.charge.id, r.unit.id, bill, { onlyIfEmpty: true });
            AuditService.log('RENT_METER', { chargeId: r.charge.id, units: bill.units, rate: bill.rate, amount: bill.amount }).catch(c.auditWarn);
            results.push({ r, bill });
        } catch (err) {
            console.warn('Meter reading not saved:', err?.code || err?.message || err);
            results.push({ r, bill, error: ERRORS[err?.message] || (err?.code === 'permission-denied' ? 'msg.rent.not_allowed' : 'msg.rent.save_failed') });
        }
    }
    const saved = results.filter(x => !x.error);
    const total = sumMoney(saved, x => x.bill.amount);
    if (saved.length === results.length) {
        UIManager.showToast(t('msg.rent.meters_saved', { n: saved.length, amount: formatINR(total) }), 'success');
        return;
    }
    UIManager.showToast(t('msg.rent.meters_partly', { saved: saved.length, failed: results.length - saved.length }), 'error');
    await c.dialog(`<h3>⚡ ${c.esc(t('ui.rent.meter_readings'))}</h3>
        <ul class="rent-months">${results.map(x => `<li>${x.error ? '✗' : '✓'} ${c.esc(x.r.place)}: ${c.esc(x.error ? t(x.error) : formatINR(x.bill.amount))}</li>`).join('')}</ul>`, { info: true });
}
