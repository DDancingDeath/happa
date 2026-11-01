/**
 * @fileoverview Unit on the tenant form (owner, 2026-10-30): the vacant-unit picker,
 * move in and change of unit. A change ends the old lease and starts the new one in
 * one transaction, pro-rates the move month on both units by default (RENT-13) and
 * carries the tenant link over. The amounts and checks are in rent-math (moveMonthSplit,
 * changeUnitPlan, oldMonth); this file shows and saves them. Loaded with import() by rentals.js only when used.
 * @module rentals/rent-unit
 */

import { UIManager } from '../ui/ui-manager.js';
import { t, getLang } from '../i18n/index.js';
import { formatINR } from '../utils/due-reminder.js';
import * as store from './rent-store.js';
import { isShareToken, withLease, withMonth, PUBLIC_MONTHS } from './rent-public.js';
import { vacantByProperty, typedPlace, moveTarget } from './rent-views.js';
import { monthLabel, dateLabel, leaseDues, chargeId, isDate } from './rent-math.js';
import { moveMonthRent, oldMonth, moveMonthSplit, changeUnitPlan, keptTerms, advanceLeft } from './rent-math-ledger.js';

const el = (id) => document.getElementById(id);
const toast = (key) => UIManager.showToast(t(key), 'error');

/** Vacant units by property (`current`: the tenant's own unit, shown selected). */
export function unitPickHtml(c, id, d, { current = '', none = true, attrs = '' } = {}) {
    const groups = vacantByProperty(d.properties, d.units, current).map(g => `<optgroup label="${c.esc(g.property.name)}">${g.units.map(u => {
        const type = c.knownType(u, g.property);
        const now = u.id === current;
        return `<option value="${c.esc(u.id)}" data-rent="${c.esc(u.rent || 0)}"${now ? ' selected' : ''}>${c.esc(typedPlace(type ? c.typeWord(type) : '', u.label, ''))}${now ? ` ${c.esc(t('ui.rent.unit_now'))}` : ''}</option>`;
    }).join('')}</optgroup>`).join('');
    return `<label class="rent-label">${c.esc(t('ui.rent.unit'))}<select id="${id}"${attrs}>${none ? `<option value="">${c.esc(t('ui.rent.unit_none'))}</option>` : ''}${groups}</select></label>`;
}

/** Tenants page, Add tenant: the picker in its box. */
export function fillPicker(c, boxId, id) {
    const box = el(boxId);
    if (box && !el(id)) box.innerHTML = unitPickHtml(c, id, store.snapshot());
}

const splitHtml = (c, mgr) => {
    const input = (id) => `<input id="${id}" type="number" inputmode="decimal" min="0" step="1"${mgr ? '' : ' readonly'}>`;
    return `<div class="rent-tenant-section">
        <label class="rent-check"><input id="rentSplitOn" type="checkbox" checked> ${c.esc(t('ui.rent.prorate_move'))}</label>
        <div id="rentSplitBox">
            <label class="rent-label" id="rentSplitOldL"><span></span>${input('rentSplitOld')}</label>
            <label class="rent-label" id="rentSplitNewL"><span></span>${input('rentSplitNew')}</label>
            <p class="rent-help" id="rentSplitHelp"></p>
        </div></div>`;
};

/** Pre-fills the split for the dialog's date and rent (again when either changes). */
function fillSplit(from, d) {
    const date = el('rentTDate')?.value || '';
    if (!el('rentSplitBox') || !isDate(date)) return;
    const s = moveMonthSplit(from, d.charges, date, Number(el('rentTRent').value) || 0);
    const month = monthLabel(s.month, getLang());
    el('rentSplitBox').hidden = !el('rentSplitOn').checked;
    el('rentSplitOldL').hidden = s.old === null;
    el('rentSplitOldL').firstChild.textContent = s.old === null ? '' : t('ui.rent.split_old', { month, date: dateLabel(s.oldEnd) });
    el('rentSplitNewL').firstChild.textContent = t('ui.rent.split_new', { month, date: dateLabel(date) });
    el('rentSplitOld').value = s.old ?? '';
    el('rentSplitNew').value = s.next;
    el('rentSplitHelp').textContent = s.old === null ? t('ui.rent.split_first', { month }) : t('ui.rent.split_help');
}

/** Move in or change unit (asks first); tenant: new, {id, name} or null (picked here); no unitId: picked here. */
export async function toUnit(c, tenant, unitId = '') {
    const d = store.snapshot();
    const ix = c.index(d);
    const { unit: shown, pick, error } = moveTarget(d.properties, d.units, unitId);
    if (error) return toast(error);
    const from = d.leases.find(l => tenant?.id && l.tenantId === tenant.id);
    const mgr = c.isManager;
    const defs = await c.defaults();
    const open = c.dialog(`<h3>${c.esc(t(from ? 'ui.rent.change_unit' : tenant ? 'ui.rent.move_in' : 'ui.rent.add_tenant'))}${pick ? '' : `: ${c.esc(c.placeOf(ix, unitId))}`}</h3>
        ${pick ? unitPickHtml(c, 'rentLeaseUnit', d, { none: false, attrs: ' onchange="window.app.rentals.fillRent(this)"' }) : ''}
        ${c.tenantSectionHtml({ rent: shown.rent, meterRate: shown.meterRate, fixedTenant: tenant && { id: '', ...tenant }, ...(from ? keptTerms(from, defs) : { defs }) })}
        ${from ? splitHtml(c, mgr) : ''}`);
    if (from) {
        el('rentTProRate')?.closest('label')?.setAttribute('hidden', '');
        const refill = () => fillSplit(from, d);
        ['rentTDate', 'rentTRent', 'rentSplitOn'].forEach(id => el(id)?.addEventListener('change', refill));
        el('rentTRent')?.addEventListener('input', refill);
        refill();
    }
    if (!await open) return;
    const unit = pick ? ix.units.get(c.val('rentLeaseUnit')) || pick : shown;
    const occ = c.readTenantSection({ given: tenant?.id ? null : tenant });
    if (occ?.error) return toast(occ.error);
    if (!from) return c.saveMoveIn({ unit, newUnit: false, occ, defs });
    return changeDialog(c, { d, ix, from, unit, occ, defs, mgr, on: !!el('rentSplitOn')?.checked, typed: { old: c.val('rentSplitOld'), next: c.val('rentSplitNew') } });
}

async function changeDialog(c, { d, ix, from, unit, occ, defs, mgr, on, typed }) {
    const { lease } = occ;
    const plan = changeUnitPlan(from, d.charges, lease, { mgr, on, typed });
    if (plan.error) return toast(plan.error);
    // oldRent 'auto': worked out from the stored charge in the same transaction (members always).
    const { s, oldRent, paidOld } = plan;
    lease.proRate = on;
    if (on) lease.firstRent = plan.firstRent;
    else delete lease.firstRent;
    const lang = getLang();
    const place = c.placeOf(ix, from.unitId);
    const to = c.placeOf(ix, unit.id);
    const month = monthLabel(s.month, lang);
    const ask = t('msg.rent.change_unit_confirm', {
        name: ix.tenants.get(from.tenantId)?.name || '', from: place, to, date: dateLabel(lease.startDate),
        month: monthLabel(s.endMonth, lang), dues: formatINR(leaseDues(d.charges, from.id).total)
    }) + (s.endMonth !== s.month ? ''
        : ` ${!on ? t('msg.rent.change_unit_both', { month })
            : paidOld?.kept ? t('msg.rent.change_unit_old_paid', { month, from: place, to, new: formatINR(lease.firstRent) })
                : paidOld?.capped ? t('msg.rent.change_unit_old_capped', { month, from: place, old: formatINR(paidOld.amount), to, new: formatINR(lease.firstRent) })
                    : t('msg.rent.change_unit_split', { month, from: place, old: formatINR(oldRent === 'auto' ? s.old : oldRent), to, new: formatINR(lease.firstRent) })}`)
        // RENT-16: an advance carried on the old lease pays the new unit's first month.
        + (advanceLeft(d.charges, from.id, s.endMonth) > 0 ? ` ${t('msg.rent.change_unit_adv', { amount: formatINR(advanceLeft(d.charges, from.id, s.endMonth)) })}` : '');
    if (!await UIManager.showModal(ask, t('ui.rent.change_unit'), true)) return;
    return c.saveMoveIn({
        unit, newUnit: false, occ, defs, from,
        save: (tenantName) => changeUnit({
            unitId: unit.id, tenantId: from.tenantId, tenantName, fromLeaseId: from.id, endMonth: s.endMonth, lease, oldRent, currentMonth: c.month,
            names: { oldLabel: ix.units.get(from.unitId)?.label || '', old: c.linkPlace(ix, from.unitId), now: c.linkPlace(ix, unit.id) }
        })
    });
}

/**
 * The link snapshot after a change: the new lease (lid, place, rent, not moved out),
 * the tenant's start date kept, the old unit's months kept and tagged with its place.
 */
export function movedSnapshot(s, { leaseId, lease, endMonth, names, split = null, now = Date.now() }) {
    const tag = { pl: String(names.old?.place || '').slice(0, 150), ...(names.old?.unitType ? { pt: names.old.unitType } : {}) };
    const months = (s.months || []).filter(x => x.pl || x.m <= endMonth).map(x => (x.pl ? x : { ...x, ...tag })).slice(-PUBLIC_MONTHS);
    const next = withLease({ ...s, lid: leaseId, months }, { ...lease, status: 'active', endMonth: null }, now);
    delete next.ut;
    Object.assign(next, {
        place: String(names.now?.place || s.place || '').slice(0, 150),
        ...(names.now?.unitType ? { ut: names.now.unitType } : {}), ...(s.since ? { since: s.since } : {})
    });
    return split ? withMonth(next, split, now, tag) : next;
}

/**
 * Change of unit (rent-store moveIn with `change`): the old lease ends with endMonth as on
 * move-out and points at the new one (movedTo); its move month is pro-rated (RENT-13; oldRent
 * 'auto' = worked out here from the stored charge, null = left full); its tenant link
 * moves to the new lease (same token) with the history. The new lease's first month is
 * charged right after.
 * More than the old unit's share already paid: its month closes at what is paid (oldCapped,
 * the amount), or stays as it is when fully paid (oldKept) (oldMonth).
 * @throws {Error} 'bad_move_date' | 'tenant_changed' | 'later_paid' | 'unit_taken' | 'missing'
 */
export async function changeUnit({ unitId, tenantId, tenantName, fromLeaseId, endMonth, lease, oldRent = 'auto', names = {}, currentMonth }) {
    if (endMonth > currentMonth) throw new Error('bad_move_date');
    await store.chargeLease(fromLeaseId, endMonth, { tenantName, unitLabel: names.oldLabel || '' });
    const month = lease.startDate.slice(0, 7);
    let kept = false;
    let capped = null;
    const read = async (tx, leaseId) => {
        kept = false;
        capped = null;
        const old = { id: fromLeaseId, ...(await store.leaseInTx(tx, fromLeaseId)) };
        if (old.status !== 'active' || old.tenantId !== tenantId) throw new Error('tenant_changed');
        if (endMonth < old.startMonth) throw new Error('bad_move_date');
        const end = await store.endInTx(tx, old, endMonth);
        // A pro-rated move month can't also take back an advance from the month after (RENT-16) in one write.
        if (end.back && endMonth === month && oldRent !== null) throw new Error('later_paid');
        const chId = chargeId(fromLeaseId, endMonth);
        const ch = oldRent !== null && endMonth === month ? await store.chargeInTx(tx, chId) : null;
        let split = null;
        if (Number.isFinite(ch?.rent)) {
            const o = oldMonth(ch, oldRent === 'auto' ? moveMonthRent(ch.rent, old, month, lease.startDate) : oldRent);
            kept = o.kept;
            if (o.capped) capped = o.amount;
            if (!o.kept && o.rent < ch.rent) split = { ...ch, rent: o.rent, amount: o.amount, open: o.open };
        }
        const token = isShareToken(old.shareToken) ? old.shareToken : null;
        return {
            lease: { fromLeaseId, ...(token ? { shareToken: token } : {}) },
            write: () => {
                end({ movedTo: leaseId, ...(token ? { shareToken: null } : {}) }, (s) => movedSnapshot(s, { leaseId, lease, endMonth, names, split }));
                if (split) store.updateChargeInTx(tx, chId, { rent: split.rent, amount: split.amount, open: split.open, updatedAt: Date.now(), updatedBy: store.uid() });
            }
        };
    };
    const res = await store.moveIn({ unit: { id: unitId }, tenantId, tenantName, lease, currentMonth, change: { from: fromLeaseId, read } });
    return { ...res, oldKept: kept, oldCapped: capped };
}
