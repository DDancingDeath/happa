/**
 * @fileoverview Property expenses screens (#157): a property's expenses (this
 * month's total, RENT-17, and the newest entries), adding one (any rentals role),
 * and the owner's edit / delete. Loaded with import() from rentals.js only when
 * used (not precached). Not the Aadhat cash drawer or Aadhat expenses.
 * @module rentals/rent-expense
 */

import { UIManager } from '../ui/ui-manager.js';
import { t, getLang } from '../i18n/index.js';
import { Helpers } from '../utils/helpers.js';
import { AuditService } from '../services/audit.js';
import { todayLocalISO } from '../utils/dates.js';
import { formatINR } from '../utils/due-reminder.js';
import { entryAmount } from '../utils/calc/billing.js';
import * as store from './rent-store.js';
import * as es from './rent-expense-store.js';
import { EXPENSE_CATEGORIES, PAYMENT_MODES, expenseError, expenseTotals, dateLabel, monthLabel } from './rent-math.js';

const auditWarn = (e) => console.warn('Rentals audit entry not written:', e?.code || e);
const fail = (key) => UIManager.showToast(t(key), 'error');
const lbl = (c, key, field) => `<label class="rent-label">${c.esc(t(key))}${field}</label>`;
const opts = (c, list, cur, label) => list.map(v => `<option value="${c.esc(v)}"${v === cur ? ' selected' : ''}>${c.esc(label(v))}</option>`).join('');
const act = (c, action, pid, key, cls = '', id = '') => `<button type="button" class="rent-btn${cls}" data-rent-exp onclick="window.app.rentals.expenseAction('${action}', '${c.js(pid)}', '${c.js(id)}')">${c.esc(t(key))}</button>`;

function propertyOf(pid) {
    const d = store.snapshot();
    return { property: d.properties.find(p => p.id === pid) || null, units: d.units.filter(u => u.propertyId === pid).sort((a, b) => a.label.localeCompare(b.label)) };
}

/** A property's expenses: this month's total (RENT-17) and the newest 60; any rentals role adds, the owner edits / deletes. */
export async function showExpenses(c, pid) {
    const { property, units } = propertyOf(pid);
    if (!property) return;
    let list;
    try { list = await es.listExpenses(pid); } catch (e) {
        console.error('Expenses not loaded:', e);
        fail('msg.rent.could_not_load');
        return;
    }
    const unitName = new Map(units.map(u => [u.id, u.label]));
    const lang = getLang();
    const rows = list.map(e => `<li>${c.esc([dateLabel(e.date), t(`ui.rent.exp_cat_${e.category}`), e.unitId ? unitName.get(e.unitId) || '' : t('ui.rent.exp_unit_all'), t(`ui.rent.mode_${e.mode}`)].filter(Boolean).join(' · '))}:
        <strong>${c.esc(formatINR(e.amount))}</strong>${e.note ? ` · ${c.esc(e.note)}` : ''} <span class="rent-sub">${c.esc(e.byName || '')}</span>
        ${c.isOwner ? `${act(c, 'edit', pid, 'ui.rent.edit', ' rent-btn-small', e.id)}${act(c, 'delete', pid, 'ui.rent.remove', ' rent-btn-small', e.id)}` : ''}</li>`).join('');
    await c.dialog(`<h3>💸 ${c.esc(t('ui.rent.exp_title', { name: property.name }))}</h3>
        <div class="rent-cards"><div class="rent-card"><div class="rent-card-label">${c.esc(t('ui.rent.exp_month'))} · ${c.esc(monthLabel(c.month, lang))}</div>
            <div class="rent-card-value">${c.esc(formatINR(expenseTotals(store.snapshot().expenses, c.month).byProperty[pid] || 0))}</div></div></div>
        <p class="rent-help">${c.esc(t('ui.rent.exp_help'))}</p>
        <div class="rent-actions">${act(c, 'add', pid, 'ui.rent.exp_add', ' rent-btn-primary')}</div>
        ${rows ? `<ul class="rent-months">${rows}</ul>` : `<p class="rent-empty">${c.esc(t('ui.rent.exp_none'))}</p>`}`, { info: true });
}

/** Add (any rentals role), or the owner's edit / delete of expense `id`. */
export async function action(c, kind, pid, id) {
    c.closeDialog();
    if (Helpers.isBusy('rent-exp')) return;
    const { property, units } = propertyOf(pid);
    if (!property) return;
    let old = null;
    if (kind !== 'add') {
        if (!c.isOwner) return;
        old = (await es.listExpenses(pid).catch(() => [])).find(e => e.id === id);
        if (!old) return fail('msg.rent.save_failed');
    }
    if (kind === 'delete') {
        if (!await UIManager.showModal(t('msg.rent.confirm_remove'), t('ui.rent.remove'), true)) return;
        return save(c, pid, () => es.deleteExpense(id), 'RENT_EXPENSE_DELETE', { id, amount: old.amount });
    }
    const v = old || { category: 'repairs', unitId: null, amount: '', date: todayLocalISO(), mode: 'cash', note: '' };
    const ok = await c.dialog(`<h3>💸 ${c.esc(t(old ? 'ui.rent.edit' : 'ui.rent.exp_add'))}: ${c.esc(property.name)}</h3>
        ${lbl(c, 'ui.rent.exp_category', `<select id="rentExpCat">${opts(c, EXPENSE_CATEGORIES, v.category, k => t(`ui.rent.exp_cat_${k}`))}</select>`)}
        ${lbl(c, 'ui.rent.exp_unit', `<select id="rentExpUnit"><option value="">${c.esc(t('ui.rent.exp_unit_all'))}</option>${units.map(u => `<option value="${c.esc(u.id)}"${u.id === v.unitId ? ' selected' : ''}>${c.esc(u.label)}</option>`).join('')}</select>`)}
        ${lbl(c, 'ui.rent.amount', `<input id="rentExpAmount" type="number" inputmode="decimal" min="0" step="1" value="${c.esc(v.amount)}">`)}
        ${lbl(c, 'ui.rent.date', `<input id="rentExpDate" type="date" value="${c.esc(v.date)}">`)}
        ${lbl(c, 'ui.rent.mode', `<select id="rentExpMode">${opts(c, PAYMENT_MODES, v.mode, m => t(`ui.rent.mode_${m}`))}</select>`)}
        ${lbl(c, 'ui.rent.notes', `<input id="rentExpNote" type="text" maxlength="200" value="${c.esc(v.note || '')}">`)}
        <p class="rent-help">${c.esc(t('ui.rent.exp_help'))}</p>`);
    if (!ok) return;
    const e = {
        propertyId: pid, unitId: units.some(u => u.id === c.val('rentExpUnit')) ? c.val('rentExpUnit') : null,
        category: c.val('rentExpCat'), amount: entryAmount(c.val('rentExpAmount')), date: c.val('rentExpDate'), mode: c.val('rentExpMode'), note: c.val('rentExpNote')
    };
    const err = expenseError(e);
    if (err) return fail(err);
    return old
        ? save(c, pid, () => es.updateExpense(id, e), 'RENT_EXPENSE_EDIT', { id, from: old.amount, to: e.amount })
        : save(c, pid, () => es.addExpense(e), 'RENT_EXPENSE', { propertyId: pid, category: e.category, amount: e.amount, date: e.date }, e.amount);
}

async function save(c, pid, fn, audit, details, amount = null) {
    await Helpers.runExclusive('rent-exp', '[data-rent-exp]', async () => {
        try {
            await fn();
            UIManager.showToast(amount === null ? t('msg.rent.saved') : t('msg.rent.exp_saved', { amount: formatINR(amount) }), 'success');
            AuditService.log(audit, details).catch(auditWarn);
            setTimeout(() => showExpenses(c, pid), 300);
        } catch (e) {
            console.error('Expense not saved:', e);
            fail(e?.code === 'permission-denied' ? 'msg.rent.not_allowed' : 'msg.rent.save_failed');
        }
    });
}
