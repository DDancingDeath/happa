/**
 * @fileoverview Security deposit ledger screens (#157): a tenant's ledger
 * (received / adjusted against a month's rent / refunded, and the deposit held,
 * RENT-14), adding an entry, the owner's edit / remove, and Tenants › Deposits held
 * (RENT-15). Loaded with import() from rentals.js only when used (not precached).
 * Deposits are not cash in the Aadhat drawer.
 * @module rentals/rent-deposit
 */

import { UIManager } from '../ui/ui-manager.js';
import { t, getLang } from '../i18n/index.js';
import { Helpers } from '../utils/helpers.js';
import { AuditService } from '../services/audit.js';
import { todayLocalISO } from '../utils/dates.js';
import { formatINR } from '../utils/due-reminder.js';
import { entryAmount } from '../utils/calc/billing.js';
import * as store from './rent-store.js';
import * as ds from './rent-deposit-store.js';
import { PAYMENT_MODES, DEPOSIT_KINDS, monthLabel, dateLabel, chargeDue, chargeId, depositHeld, depositFill, depositsTotal, isDate } from './rent-math.js';

const auditWarn = (e) => console.warn('Rentals audit entry not written:', e?.code || e);
const ERRORS = { amount: 'msg.rent.bad_amount', over: 'msg.rent.dep_over', too_many: 'msg.rent.dep_full', missing: 'msg.rent.save_failed', changed: 'msg.rent.dep_changed' };
const fail = (e) => UIManager.showToast(t(ERRORS[e?.message] || (e?.code === 'permission-denied' ? 'msg.rent.not_allowed' : 'msg.rent.save_failed')), 'error');

/** The tenant, the lease whose link shows the balance (current, else a moved-out one with a link) and the open months. */
function tenantOf(tenantId) {
    const d = store.snapshot();
    const tenant = d.tenants.find(x => x.id === tenantId) || null;
    const lease = d.leases.find(l => l.tenantId === tenantId) || d.linked.find(l => l.tenantId === tenantId) || null;
    const dues = d.charges.filter(ch => ch.tenantId === tenantId && chargeDue(ch) > 0).sort((a, b) => a.month.localeCompare(b.month));
    return { tenant, lease, dues };
}

const act = (c, action, tenantId, key, cls = '', i = '') => `<button type="button" class="rent-btn${cls}" data-rent-dep onclick="window.app.rentals.depositAction('${action}', '${c.js(tenantId)}'${i !== '' ? `, ${i}` : ''})">${c.esc(t(key))}</button>`;

function entryLine(c, e, i, tenantId, owner) {
    const what = [dateLabel(e.date), t(`ui.rent.dep_${e.kind}`), e.month ? monthLabel(e.month, getLang()) : '', e.mode ? t(e.mode === 'advance' ? 'ui.rent.dep_from_advance' : `ui.rent.mode_${e.mode}`) : '']
        .filter(Boolean).join(' · ');
    const edit = owner && e.kind !== 'adjust' && e.mode !== 'advance'
        ? ` ${act(c, 'edit', tenantId, 'ui.rent.edit', ' rent-btn-small', i)}${act(c, 'remove', tenantId, 'ui.rent.remove', ' rent-btn-small', i)}` : '';
    return `<li>${c.esc(what)}: <strong>${c.esc(formatINR(e.amount))}</strong>${e.note ? ` · ${c.esc(e.note)}` : ''}
        <span class="rent-sub">${c.esc(e.byName || '')}</span>${edit}</li>`;
}

/** A tenant's deposit ledger (one read). `dep`: already loaded. */
export async function showDeposit(c, tenantId, dep) {
    const { tenant, lease, dues } = tenantOf(tenantId);
    try {
        if (dep === undefined) dep = await ds.loadDeposit(tenantId);
    } catch (e) {
        console.error('Deposit not loaded:', e);
        UIManager.showToast(t('msg.rent.could_not_load'), 'error');
        return;
    }
    const name = tenant?.name || dep?.tenantName;
    if (!name) return;
    const entries = dep?.entries || [];
    const held = depositHeld(entries);
    const rows = entries.map((e, i) => entryLine(c, e, i, tenantId, c.isOwner)).reverse().join('');
    const add = [act(c, 'received', tenantId, 'ui.rent.dep_add_received', ' rent-btn-primary'),
        held > 0 && dues.length ? act(c, 'adjust', tenantId, 'ui.rent.dep_add_adjust') : '',
        held > 0 ? act(c, 'refund', tenantId, 'ui.rent.dep_add_refund') : ''].join('');
    await c.dialog(`<h3>💰 ${c.esc(t('ui.rent.dep_title'))}: ${c.esc(name)}</h3>
        <div class="rent-cards">
            ${lease ? `<div class="rent-card"><div class="rent-card-label">${c.esc(t('ui.rent.dep_agreed'))}</div><div class="rent-card-value">${c.esc(formatINR(lease.deposit || 0))}</div></div>` : ''}
            <div class="rent-card"><div class="rent-card-label">${c.esc(t('ui.rent.dep_held'))}</div><div class="rent-card-value">${c.esc(formatINR(held))}</div></div>
        </div>
        <p class="rent-help">${c.esc(t('ui.rent.dep_help'))}</p>
        ${rows ? `<ul class="rent-months">${rows}</ul>` : `<p class="rent-empty">${c.esc(t('ui.rent.dep_none'))}</p>`}
        <div class="rent-actions">${add}</div>`, { info: true });
}

/** Advance left on an ended lease's last month goes into the deposit (RENT-16); says so. */
async function moveAdvance(chId) {
    try {
        const adv = await ds.advanceToDeposit(chId);
        if (!(adv > 0)) return;
        UIManager.showToast(t('msg.rent.adv_to_deposit', { amount: formatINR(adv) }), 'success');
        AuditService.log('RENT_ADVANCE_TO_DEPOSIT', { chargeId: chId, amount: adv }).catch(auditWarn);
    } catch (e) {
        console.warn('Advance not moved to the deposit:', e?.code || e);
    }
}

/**
 * After a move-out (or a change of unit, `open` false): an advance left on the lease's last month
 * moves into the deposit, then the ledger opens when a deposit is held (to adjust or refund it).
 */
export async function afterMoveOut(c, tenantId, leaseId, month, open = true) {
    if (leaseId && month) await moveAdvance(chargeId(leaseId, month));
    if (!open) return;
    const dep = await ds.loadDeposit(tenantId).catch(e => console.warn('Deposit not loaded after move-out:', e?.code || e));
    if (depositHeld(dep?.entries) > 0) await showDeposit(c, tenantId, dep);
}

/** Deposits held › an advance left after a move-out: into the deposit, then the list again. */
export async function advanceAction(c, chId) {
    c.closeDialog();
    await moveAdvance(chId);
    setTimeout(() => showHeld(c), 300);
}

const lbl = (c, key, field) => `<label class="rent-label">${c.esc(t(key))}${field}</label>`;

/** Received / adjust / refund form, or the owner's edit / remove of entry `i`. */
export async function action(c, kind, tenantId, i) {
    c.closeDialog();
    if (Helpers.isBusy('rent-dep')) return;
    const { tenant, lease, dues } = tenantOf(tenantId);
    let dep;
    try { dep = await ds.loadDeposit(tenantId); } catch (e) { fail(e); return; }
    const name = tenant?.name || dep?.tenantName;
    if (!name) return;
    const entries = dep?.entries || [];
    if (kind === 'edit' || kind === 'remove') return ownerChange(c, kind, tenantId, lease, entries, i);
    if (!DEPOSIT_KINDS.includes(kind)) return;
    const held = depositHeld(entries);
    const lang = getLang();
    const months = kind === 'adjust' ? dues.map(ch => `<option value="${c.esc(ch.id)}" data-due="${c.esc(depositFill('adjust', held, chargeDue(ch)))}">${c.esc(monthLabel(ch.month, lang))} · ${c.esc(formatINR(chargeDue(ch)))}</option>`).join('') : '';
    const fill = depositFill(kind, held, dues[0] ? chargeDue(dues[0]) : 0, lease?.deposit || 0);
    const ok = await c.dialog(`<h3>💰 ${c.esc(t(`ui.rent.dep_add_${kind}`))}</h3>
        <p class="rent-help">${c.esc(t('ui.rent.dep_held'))}: ${c.esc(formatINR(held))}</p>
        ${months ? lbl(c, 'ui.rent.month', `<select id="rentDepCharge" onchange="window.app.rentals.fillDue(this)">${months}</select>`) : ''}
        ${lbl(c, 'ui.rent.amount', `<input id="rentPayAmount" type="number" inputmode="decimal" min="0" step="1" value="${c.esc(fill)}">`)}
        ${kind === 'adjust' ? '' : lbl(c, 'ui.rent.mode', `<select id="rentDepMode">${PAYMENT_MODES.map(m => `<option value="${m}">${c.esc(t(`ui.rent.mode_${m}`))}</option>`).join('')}</select>`)}
        ${lbl(c, 'ui.rent.date', `<input id="rentDepDate" type="date" value="${c.esc(todayLocalISO())}">`)}
        ${lbl(c, 'ui.rent.notes', `<input id="rentDepNote" type="text" maxlength="200">`)}`);
    if (!ok) return;
    const mode = c.val('rentDepMode');
    const p = {
        tenantId, tenantName: name, leaseId: lease?.id || '', kind, amount: Number(c.val('rentPayAmount')),
        date: isDate(c.val('rentDepDate')) ? c.val('rentDepDate') : todayLocalISO(),
        mode: PAYMENT_MODES.includes(mode) ? mode : 'cash', note: c.val('rentDepNote'), chargeId: c.val('rentDepCharge')
    };
    await Helpers.runExclusive('rent-dep', '[data-rent-dep]', async () => {
        try {
            const res = await ds.addDepositEntry(p);
            UIManager.showToast(t('msg.rent.dep_saved', { amount: formatINR(res.amount), held: formatINR(res.held) }), 'success');
            AuditService.log('RENT_DEPOSIT', { tenantId, kind, amount: res.amount, held: res.held, chargeId: p.chargeId || '' }).catch(auditWarn);
            setTimeout(() => showDeposit(c, tenantId), 300);
        } catch (e) {
            console.error('Deposit entry not saved:', e);
            fail(e);
        }
    });
}

async function ownerChange(c, kind, tenantId, lease, entries, i) {
    const e = entries[i];
    if (!c.isOwner || !e || e.kind === 'adjust') return;
    let fields = null;
    if (kind === 'remove') {
        if (!await UIManager.showModal(t('msg.rent.confirm_remove'), t('ui.rent.remove'), true)) return;
    } else {
        const ok = await c.dialog(`<h3>💰 ${c.esc(t('ui.rent.edit'))}: ${c.esc(t(`ui.rent.dep_${e.kind}`))}</h3>
            ${lbl(c, 'ui.rent.amount', `<input id="rentPayAmount" type="number" inputmode="decimal" min="0" step="1" value="${c.esc(e.amount)}">`)}
            ${lbl(c, 'ui.rent.date', `<input id="rentDepDate" type="date" value="${c.esc(e.date)}">`)}
            ${lbl(c, 'ui.rent.notes', `<input id="rentDepNote" type="text" maxlength="200" value="${c.esc(e.note || '')}">`)}`);
        if (!ok) return;
        const amount = entryAmount(c.val('rentPayAmount'));
        if (!(amount > 0)) { fail({ message: 'amount' }); return; }
        const date = isDate(c.val('rentDepDate')) ? c.val('rentDepDate') : e.date;
        fields = { amount, date, note: c.val('rentDepNote').slice(0, 200) };
    }
    await Helpers.runExclusive('rent-dep', '[data-rent-dep]', async () => {
        try {
            const held = await ds.changeDepositEntry({ tenantId, leaseId: lease?.id || '', entry: e, fields });
            UIManager.showToast(t('msg.rent.saved'), 'success');
            AuditService.log('RENT_DEPOSIT_EDIT', { tenantId, kind, index: i, from: e.amount, held }).catch(auditWarn);
            setTimeout(() => showDeposit(c, tenantId), 300);
        } catch (err) {
            console.error('Deposit not changed:', err);
            fail(err);
        }
    });
}

/** Tenants › Deposits held: every tenant whose deposit is still held, and the total (RENT-15). */
export async function showHeld(c) {
    let list;
    let left;
    try { [list, left] = await Promise.all([ds.depositsHeld(), ds.advancesLeft()]); } catch (e) {
        console.error('Deposits not loaded:', e);
        UIManager.showToast(t('msg.rent.could_not_load'), 'error');
        return;
    }
    const rows = list.sort((a, b) => String(a.tenantName).localeCompare(String(b.tenantName))).map(l => `<li>${c.esc(l.tenantName || t('ui.rent.no_name'))}: <strong>${c.esc(formatINR(l.held))}</strong>
        <button type="button" class="rent-btn rent-btn-small" onclick="window.app.rentals.deposit('${c.js(l.tenantId)}')">${c.esc(t('ui.rent.dep_btn'))}</button></li>`).join('');
    await c.dialog(`<h3>💰 ${c.esc(t('ui.rent.dep_held_list'))}</h3>
        <div class="rent-cards"><div class="rent-card"><div class="rent-card-label">${c.esc(t('ui.rent.dep_total'))}</div><div class="rent-card-value">${c.esc(formatINR(depositsTotal(list)))}</div></div></div>
        <p class="rent-help">${c.esc(t('ui.rent.dep_help'))}</p>
        ${rows ? `<ul class="rent-months">${rows}</ul>` : `<p class="rent-empty">${c.esc(t('ui.rent.dep_none_held'))}</p>`}
        ${advLeftHtml(c, left)}`, { info: true });
}

/** RENT-16: advances left on months of leases that ended (no active lease), to move into the deposit. */
function advLeftHtml(c, left) {
    const active = new Set(store.snapshot().leases.map(l => l.id));
    const rows = left.filter(ch => !active.has(ch.leaseId)).map(ch => `<li>${c.esc(ch.tenantName || t('ui.rent.no_name'))} · ${c.esc(monthLabel(ch.month, getLang()))}: <strong>${c.esc(formatINR(ch.adv))}</strong>
        <button type="button" class="rent-btn rent-btn-small" onclick="window.app.rentals.advanceToDeposit('${c.js(ch.id)}')">${c.esc(t('ui.rent.adv_to_deposit'))}</button></li>`).join('');
    return rows ? `<p class="rent-label">${c.esc(t('ui.rent.adv_left'))}</p><ul class="rent-months">${rows}</ul>` : '';
}
