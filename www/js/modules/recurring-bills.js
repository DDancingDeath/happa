/**
 * @fileoverview Recurring bills (#437 phase 1): the owner's electricity, water, rent and other
 * repeating payments. Each bill item has a cadence; each period has a bill amount, payments and a
 * balance carried to the next period (docs/calculations.md RB-1 … RB-11). Imported on first open;
 * one read per bill item per open. Not linked to Money yet (owner decision pending).
 * @module modules/recurring-bills
 */

import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { AppState } from '../utils/state.js';
import { t, getLang } from '../i18n/index.js';
import { emptyState } from '../ui/components.js';
import { formatRupees, moneyText } from '../utils/money.js';
import { formatMonth, formatDay, todayLocalISO } from '../utils/dates.js';
import * as repo from '../firebase/repos/recurring-bills.js';
import {
    MAX_NAME, MAX_NOTE, MAX_DUE_DAY, CADENCES, balanceParts, billsSummary, billsDueDays, checkItem, checkEntry,
    entryPeriods, unusualBill, isMonthKey, periodOf, monthKeyOf, billsAfter
} from '../utils/recurring-bills.js';
import { saveBillsDue } from '../utils/pay-reminder.js';

const esc = (v) => Helpers.escapeHtml(v == null ? '' : String(v));
const js = (v) => Helpers.escapeJsAttr(v);
const et = (key, p) => esc(t(key, p));
const byId = (id) => document.getElementById(id);
const val = (id) => (byId(id)?.value ?? '').trim();
const monthName = (key) => formatMonth(`${key}-01`, { lang: getLang() });
const dayName = (day) => formatDay(day, { lang: getLang() });
const today = () => todayLocalISO();
const isOwner = () => AppState.userRole === 'owner';
const isShown = () => byId('recurring')?.classList.contains('active');
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const state = {
    items: [],
    loaded: false,
    error: false,
    open: '',
    form: '',
    seq: 0,
    unusual: null
};

const CADENCE_KEYS = { 1: 'ui.rbills.cadence_1', 2: 'ui.rbills.cadence_2', 3: 'ui.rbills.cadence_3', 6: 'ui.rbills.cadence_6', 12: 'ui.rbills.cadence_12' };
const MODE_KEYS = { cash: 'ui.rbills.mode_cash', online: 'ui.rbills.mode_online' };
const STATE_TAGS = { paid: 'pos', part: 'warn', due: 'warn', overdue: 'neg', nobill: 'info' };
const NAME_KEYS = ['ui.rbills.name_electricity', 'ui.rbills.name_water', 'ui.rbills.name_rent', 'ui.rbills.name_internet', 'ui.rbills.name_phone', 'ui.rbills.name_property_tax'];

function stateText(row) {
    if (row.state === 'part') return t('ui.rbills.state_part', { paid: formatRupees(row.covered), of: formatRupees(row.owed) });
    if (row.state === 'due') return t('ui.rbills.state_due', { amount: formatRupees(row.owed) });
    if (row.state === 'overdue') return t('ui.rbills.state_overdue', { amount: formatRupees(row.closing) });
    return t(row.state === 'paid' ? 'ui.rbills.state_paid' : 'ui.rbills.state_nobill');
}

const stateTag = (row) => (row ? `<span class="tag ${esc(STATE_TAGS[row.state])}" data-rb-state="${esc(row.state)}">${esc(stateText(row))}</span>` : '');

function balanceLine(balance) {
    const { left, advance } = balanceParts(balance);
    if (left > 0) return `<span class="tone-neg">${et('ui.rbills.balance_left', { amount: formatRupees(left) })}</span>`;
    if (advance > 0) return `<span class="tone-info">${et('ui.rbills.credit', { amount: formatRupees(advance) })}</span>`;
    return `<span class="tone-muted">${et('ui.rbills.nothing_left')}</span>`;
}

const metric = (id, key, amount) => `<div class="metric"><div class="metric-label">${et(key)}</div><div class="metric-value" data-rb="${esc(id)}">${moneyText(amount)}</div></div>`;

function renderSummary(sum) {
    return `<div class="panel metrics rb-metrics">
            ${metric('RB-8', 'ui.rbills.due_now', sum.dueNow)}
            ${metric('RB-9', 'ui.rbills.paid_month', sum.paidMonth)}
            ${metric('RB-5', 'ui.rbills.credit_total', sum.credit)}
        </div>
        <p class="tone-muted rb-counts">${et('ui.rbills.counts', sum.counts)}</p>`;
}

function rowMeta(v) {
    const parts = [t(CADENCE_KEYS[v.item.cadence] || CADENCE_KEYS[1])];
    if (v.item.active === false) parts.push(t('ui.rbills.stopped'));
    if (v.nextDue) parts.push(t(v.current ? 'ui.rbills.next_due' : 'ui.rbills.first_due', { date: dayName(v.nextDue) }));
    return parts.join(' · ');
}

function renderRow(v) {
    const open = state.open === v.item.id;
    return `<button type="button" class="row${open ? ' selected' : ''}" data-rbill="${esc(v.item.id)}" aria-expanded="${open}" data-onclick="recurring.open('${js(v.item.id)}')">
            <span class="row-main"><span class="row-title">${esc(v.item.name)}</span><span class="row-meta">${esc(rowMeta(v))}</span></span>
            <span class="row-trail">${stateTag(v.current)}<span class="row-meta">${balanceLine(v.balance)}</span></span>
        </button>`;
}

const label = (id, key) => `<label for="${esc(id)}">${et(key)}</label>`;
const options = (pairs, chosen) => pairs.map(([v, text]) => `<option value="${esc(v)}"${String(v) === String(chosen) ? ' selected' : ''}>${esc(text)}</option>`).join('');

function formActions(save) {
    return `<div class="rb-actions">
            <button type="button" class="btn btn-primary" id="rbSave" data-onclick="recurring.${esc(save)}()">${et('ui.rbills.save')}</button>
            <button type="button" class="btn btn-ghost" data-onclick="recurring.cancel()">${et('ui.modals.cancel')}</button>
        </div>`;
}

function renderItemForm(item) {
    const editing = Boolean(item);
    const fixed = editing && (item.entries || []).length > 0;
    const lock = fixed ? ' disabled' : '';
    const names = NAME_KEYS.map(k => `<option value="${et(k)}"></option>`).join('');
    return `<div class="panel panel-pad rb-form" id="${editing ? 'rbEditForm' : 'rbAddForm'}">
            <h3>${et(editing ? 'ui.rbills.edit' : 'ui.rbills.add')}</h3>
            <div class="field">${label('rbName', 'ui.rbills.name')}<input class="input" id="rbName" list="rbNames" maxlength="${esc(MAX_NAME)}" autocomplete="off" value="${esc(item?.name || '')}"><datalist id="rbNames">${names}</datalist></div>
            <div class="field">${label('rbCadence', 'ui.rbills.cadence')}<select class="input" id="rbCadence"${lock}>${options(CADENCES.map(c => [c, t(CADENCE_KEYS[c])]), item?.cadence || 1)}</select></div>
            <div class="field">${label('rbDueDay', 'ui.rbills.due_day')}<input class="input" id="rbDueDay" inputmode="numeric" type="number" min="1" max="${esc(MAX_DUE_DAY)}" step="1" value="${esc(item?.dueDay || 10)}"></div>
            <div class="field">${label('rbStart', 'ui.rbills.start_month')}<input class="input" id="rbStart" type="month" value="${esc(item?.startMonth || monthKeyOf(new Date()))}"${lock}></div>
            <div class="field">${label('rbExpected', 'ui.rbills.expected')}<input class="input" id="rbExpected" inputmode="numeric" type="number" min="0" step="1" value="${esc(item?.expected || '')}"></div>
            <div class="field">${label('rbNote', 'ui.rbills.note')}<input class="input" id="rbNote" maxlength="${esc(MAX_NOTE)}" autocomplete="off" value="${esc(item?.note || '')}"></div>
            <p class="tone-muted">${et(fixed ? 'ui.rbills.fixed_help' : 'ui.rbills.cadence_help')}</p>
            ${formActions(editing ? 'saveEdit' : 'saveItem')}
        </div>`;
}

function periodOptions(v, chosen) {
    return options(entryPeriods(v.item, today()).slice(-24).reverse().map(p => [p, t('ui.rbills.period_option', { month: monthName(p), date: dayName(`${p}-${String(v.item.dueDay).padStart(2, '0')}`) })]), chosen);
}

/** The period a new entry is for: the current one; a bill already entered for it moves a new bill to the next. */
function defaultPeriod(v, kind) {
    const periods = entryPeriods(v.item, today());
    const current = v.current?.period || periods[0];
    if (kind === 'bill' && v.current?.source === 'entered') return periods[periods.indexOf(current) + 1] || current;
    return current;
}

function renderBillForm(v) {
    const warn = state.unusual
        ? `<div class="notice warn" id="rbUnusual" role="alert">${et('ui.rbills.unusual', { last: formatRupees(state.unusual.last) })}
                <button type="button" class="btn btn-tonal btn-sm" data-onclick="recurring.saveBill(true)">${et('ui.rbills.its_right')}</button></div>`
        : '';
    return `<div class="panel panel-pad rb-form" id="rbBillForm">
            <h3>${et('ui.rbills.enter_bill', { name: v.item.name })}</h3>
            <div class="field">${label('rbPeriod', 'ui.rbills.period')}<select class="input" id="rbPeriod">${periodOptions(v, state.unusual?.period || defaultPeriod(v, 'bill'))}</select></div>
            <div class="field">${label('rbAmount', 'ui.rbills.bill_amount')}<input class="input" id="rbAmount" inputmode="numeric" type="number" min="0" step="1" value="${esc(state.unusual?.amount ?? '')}"></div>
            <p class="tone-muted">${et('ui.rbills.bill_help')}</p>
            ${warn}
            ${formActions('saveBill')}
        </div>`;
}

function renderPayForm(v) {
    const period = defaultPeriod(v, 'pay');
    const left = Math.max(0, v.balance);
    return `<div class="panel panel-pad rb-form" id="rbPayForm">
            <h3>${et('ui.rbills.record', { name: v.item.name })}</h3>
            <div class="field">${label('rbAmount', 'ui.rbills.amount')}<input class="input" id="rbAmount" inputmode="numeric" type="number" min="1" step="1" value="${esc(left || '')}"></div>
            <div class="field">${label('rbPeriod', 'ui.rbills.period')}<select class="input" id="rbPeriod">${periodOptions(v, period)}</select></div>
            <div class="field">${label('rbDate', 'ui.rbills.date')}<input class="input" id="rbDate" type="date" value="${esc(today())}" max="${esc(today())}"></div>
            <div class="field">${label('rbMode', 'ui.rbills.mode')}<select class="input" id="rbMode">${options(Object.entries(MODE_KEYS).map(([k, key]) => [k, t(key)]), 'cash')}</select></div>
            <div class="field">${label('rbPayNote', 'ui.rbills.pay_note')}<input class="input" id="rbPayNote" maxlength="${esc(MAX_NOTE)}" autocomplete="off"></div>
            ${formActions('savePay')}
        </div>`;
}

function renderStopForm(v) {
    return `<div class="panel panel-pad rb-form" id="rbStopForm">
            <h3>${et('ui.rbills.stop')}</h3>
            <div class="field">${label('rbLastMonth', 'ui.rbills.last_month')}<input class="input" id="rbLastMonth" type="month" min="${esc(v.item.startMonth)}" value="${esc(v.current?.period || v.item.startMonth)}"></div>
            <p class="tone-muted">${et('ui.rbills.stop_help')}</p>
            ${formActions('saveStop')}
        </div>`;
}

function renderPeriods(v) {
    const shown = v.periods.slice(-24).reverse();
    if (!shown.length) return emptyState({ icon: 'calendar', title: t('ui.rbills.no_periods') });
    const rows = shown.map(r => `<tr data-period="${esc(r.period)}">
            <td>${esc(monthName(r.period))}</td>
            <td>${esc(dayName(r.due))}</td>
            <td class="num">${r.bill === null ? '—' : moneyText(r.bill)}${r.source === 'expected' ? ` <span class="tone-muted">${et('ui.rbills.expected_mark')}</span>` : ''}</td>
            <td class="num">${moneyText(r.paid)}</td>
            <td class="num">${r.opening ? moneyText(r.opening) : ''}</td>
            <td>${stateTag(r)}</td>
            <td>${balanceLine(r.closing)}</td>
        </tr>`).join('');
    return `<div class="scroll-cue"><div class="scroll-cue-inner"><table class="table">
            <thead><tr><th>${et('ui.rbills.period')}</th><th>${et('ui.rbills.col_due')}</th><th>${et('ui.rbills.col_bill')}</th><th>${et('ui.rbills.col_paid')}</th><th>${et('ui.rbills.col_carried_in')}</th><th>${et('ui.rbills.col_state')}</th><th>${et('ui.rbills.col_balance')}</th></tr></thead>
            <tbody>${rows}</tbody></table></div></div>`;
}

function renderEntries(item) {
    const list = [...(item.entries || [])].reverse();
    if (!list.length) return emptyState({ icon: 'list', title: t('ui.rbills.no_entries') });
    return list.map((e) => {
        const month = monthName(periodOf(item, e.period));
        if (e.kind === 'bill') {
            return `<div class="row" data-entry="${esc(e.id)}"><span class="row-main"><span class="row-title">${et('ui.rbills.entry_bill', { amount: formatRupees(e.amount) })}</span>
                <span class="row-meta">${et('ui.rbills.entry_bill_meta', { month, date: dayName(e.date) })}</span></span></div>`;
        }
        return `<div class="row" data-entry="${esc(e.id)}">
            <span class="row-main"><span class="row-title">${et('ui.rbills.entry_pay', { amount: formatRupees(e.amount) })}</span>
            <span class="row-meta">${et('ui.rbills.entry_pay_meta', { month, date: dayName(e.date), mode: t(MODE_KEYS[e.mode] || MODE_KEYS.cash) })}${e.note ? ` · ${esc(e.note)}` : ''}</span></span>
            <button type="button" class="btn btn-ghost btn-sm" data-onclick="recurring.removeEntry('${js(item.id)}', '${js(e.id)}')">${et('ui.rbills.remove')}</button>
        </div>`;
    }).join('');
}

function renderDetail(v) {
    const it = v.item;
    const form = state.form === 'bill' ? renderBillForm(v) : state.form === 'pay' ? renderPayForm(v)
        : state.form === 'edit' ? renderItemForm(it) : state.form === 'stop' ? renderStopForm(v) : '';
    const stop = it.active === false ? '' : `<button type="button" class="btn btn-tonal btn-sm" data-onclick="recurring.showForm('stop')">${et('ui.rbills.stop')}</button>`;
    return `<section class="panel panel-pad rb-detail" id="rbDetail">
            <h3>${esc(it.name)}</h3>
            ${it.note ? `<p class="tone-muted">${esc(it.note)}</p>` : ''}
            <p>${balanceLine(v.balance)}${v.nextDue ? ` · ${et('ui.rbills.next_due', { date: dayName(v.nextDue) })}` : ''}</p>
            <div class="rb-actions">
                <button type="button" class="btn btn-tonal btn-sm" data-onclick="recurring.showForm('bill')">${et('ui.rbills.enter_bill_btn')}</button>
                <button type="button" class="btn btn-tonal btn-sm" data-onclick="recurring.showForm('pay')">${et('ui.rbills.record_btn')}</button>
                <button type="button" class="btn btn-tonal btn-sm" data-onclick="recurring.showForm('edit')">${et('ui.rbills.edit')}</button>
                ${stop}
            </div>
            ${form}
            <h4>${et('ui.rbills.by_period')}</h4>
            ${renderPeriods(v)}
            <h4>${et('ui.rbills.entries')}</h4>
            <div class="panel">${renderEntries(it)}</div>
        </section>`;
}

export function render() {
    const root = byId('recurringBody');
    if (!root) return;
    if (!isOwner()) {
        root.innerHTML = `<p class="empty">${et('ui.rbills.owner_only')}</p>`;
        return;
    }
    if (!state.loaded) {
        root.innerHTML = state.error
            ? `<p class="notice neg">${et('msg.rbills.not_loaded')}</p>`
            : `<p class="empty">${et('ui.rbills.loading')}</p>`;
        return;
    }
    const sum = billsSummary(state.items, today());
    const rows = [...sum.rows].sort((a, b) => (a.item.active === false) - (b.item.active === false)
        || String(a.nextDue || '9999').localeCompare(String(b.nextDue || '9999')) || a.item.name.localeCompare(b.item.name));
    const open = rows.find(v => v.item.id === state.open);
    const list = rows.length
        ? `<div class="panel rb-list">${rows.map(renderRow).join('')}</div>`
        : emptyState({ icon: 'receipt', title: t('ui.rbills.none') });
    root.innerHTML = `${renderSummary(sum)}
        <div class="rb-actions"><button type="button" class="btn btn-tonal" data-onclick="recurring.showForm('add')">${et('ui.rbills.add')}</button></div>
        ${state.form === 'add' ? renderItemForm(null) : ''}
        ${list}
        ${open ? renderDetail(open) : ''}`;
}

function ensureCss() {
    if (byId('recurringCss')) return;
    const link = document.createElement('link');
    link.id = 'recurringCss';
    link.rel = 'stylesheet';
    link.href = 'css/recurring-bills.css';
    document.head.appendChild(link);
}

/** Keeps RB-11 for Today from the loaded items (no reads). */
function noteDue(list = state.items, uid = AppState.currentUser?.uid) {
    if (!uid) return;
    try { saveBillsDue(localStorage, { uid, days: billsDueDays(list, today()) }); } catch (_) { /* never break the page */ }
}

/**
 * Today's bills line (RB-11), once a day on the owner's phone (main.js, after the first screen): one
 * read per bill item. Nothing on the page changes.
 */
export async function refreshBillsDue() {
    const uid = AppState.currentUser?.uid;
    if (!isOwner() || !uid) return false;
    const seq = state.seq;
    const list = await repo.loadBillItems();
    if (AppState.currentUser?.uid !== uid || !isOwner()) return false;
    // The page opened or saved meanwhile: its figure is newer than this read
    if (seq !== state.seq || state.loaded) return false;
    noteDue(list, uid);
    return true;
}

/** Opens the page: reads every bill item once (one read each). */
export async function init() {
    ensureCss();
    state.loaded = false;
    state.error = false;
    render();
    if (!isOwner()) return;
    const seq = ++state.seq;
    try {
        const list = await repo.loadBillItems();
        if (seq !== state.seq) return;
        state.items = list;
        state.loaded = true;
        noteDue();
    } catch (e) {
        console.warn('Recurring bills not loaded:', e?.code || e);
        if (seq === state.seq) state.error = true;
    }
    if (isShown()) render();
}

const focusFirst = { add: 'rbName', edit: 'rbName', bill: 'rbAmount', pay: 'rbAmount', stop: 'rbLastMonth' };

export function open(id) {
    state.open = state.open === id ? '' : id;
    if (state.form !== 'add') state.form = '';
    state.unusual = null;
    render();
    if (state.open) byId('rbDetail')?.scrollIntoView?.({ block: 'nearest' });
}

export function showForm(kind) {
    state.form = kind;
    state.unusual = null;
    render();
    byId(focusFirst[kind])?.focus?.();
}

export function cancel() {
    state.form = '';
    state.unusual = null;
    render();
}

const openItem = () => state.items.find(x => x.id === state.open);
const warn = (key) => UIManager.showToast(t(key), 'warning');

/** Runs one save (one tap = one write), refusing offline; true when saved. */
async function save(key, fn, doneKey, params) {
    if (Helpers.isBusy(key)) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        warn('msg.rbills.needs_internet');
        return false;
    }
    try {
        await Helpers.runExclusive(key, '#recurring .btn', fn);
        noteDue();
        state.form = '';
        state.unusual = null;
        render();
        UIManager.showToast(t(doneKey, params), 'success');
        return true;
    } catch (e) {
        console.warn('Recurring bill not saved:', e?.code || e);
        UIManager.showToast(t('msg.rbills.not_saved'), 'error');
        return false;
    }
}

const itemForm = () => ({ name: val('rbName'), cadence: val('rbCadence'), dueDay: val('rbDueDay'), startMonth: val('rbStart'), expected: val('rbExpected'), note: val('rbNote') });

export async function saveItem() {
    const { item, error } = checkItem(itemForm(), monthKeyOf(new Date()));
    if (error) return warn(error);
    await save('rbills.add', async () => {
        const id = await repo.addBillItem(item);
        state.items.push({ id, ...item, active: true, endMonth: '', entries: [] });
        state.open = id;
    }, 'msg.rbills.added', { name: item.name });
}

export async function saveEdit() {
    const it = openItem();
    if (!it) return;
    const fixed = (it.entries || []).length > 0;
    const f = itemForm();
    const { item, error } = checkItem(fixed ? { ...f, cadence: it.cadence, startMonth: it.startMonth } : f, monthKeyOf(new Date()));
    if (error) return warn(error);
    if (it.endMonth && item.startMonth > it.endMonth) return warn('msg.rbills.bad_month');
    const patch = fixed ? { name: item.name, dueDay: item.dueDay, expected: item.expected, note: item.note } : item;
    await save('rbills.edit', async () => {
        await repo.updateBillItem(it.id, patch);
        Object.assign(it, patch);
    }, 'msg.rbills.saved');
}

/** Enters (or corrects) a period's bill amount; a bill over 3× the last one asks once ("Yes, it's right"). */
export async function saveBill(confirmed = false) {
    const it = openItem();
    if (!it) return;
    const { entry, error } = checkEntry({ kind: 'bill', amount: val('rbAmount'), period: val('rbPeriod'), date: today() }, it, today());
    if (error) return warn(error);
    const last = unusualBill(it, entry.period, entry.amount);
    if (last !== null && !confirmed) {
        state.unusual = { last, period: entry.period, amount: entry.amount };
        render();
        byId('rbUnusual')?.querySelector('button')?.focus?.();
        return;
    }
    const full = { id: newId(), ...entry };
    await save('rbills.bill', async () => {
        await repo.addEntry(it.id, full);
        it.entries = [...(it.entries || []), full];
    }, 'msg.rbills.bill_saved', { amount: formatRupees(full.amount), name: it.name, month: monthName(full.period) });
}

export async function savePay() {
    const it = openItem();
    if (!it) return;
    const { entry, error } = checkEntry({ kind: 'pay', amount: val('rbAmount'), period: val('rbPeriod'), date: val('rbDate'), mode: val('rbMode'), note: val('rbPayNote') }, it, today());
    if (error) return warn(error);
    const full = { id: newId(), ...entry };
    await save('rbills.pay', async () => {
        await repo.addEntry(it.id, full);
        it.entries = [...(it.entries || []), full];
    }, 'msg.rbills.recorded', { amount: formatRupees(full.amount), name: it.name });
}

export async function saveStop() {
    const it = openItem();
    const last = val('rbLastMonth');
    if (!it) return;
    if (!isMonthKey(last) || last < it.startMonth) return warn('msg.rbills.bad_month');
    const later = billsAfter(it, last);
    if (later.length && !Helpers.isBusy('rbills.stop')) {
        const ok = await UIManager.showModal(t('msg.rbills.stop_drops_bills', { month: monthName(later[0]), last: monthName(last) }), t('ui.rbills.stop'), true, { confirmLabel: t('ui.rbills.stop') });
        if (!ok) return;
    }
    const patch = { active: false, endMonth: last };
    await save('rbills.stop', async () => {
        await repo.updateBillItem(it.id, patch);
        Object.assign(it, patch);
    }, 'msg.rbills.stopped', { name: it.name });
}

export async function removeEntry(itemId, entryId) {
    const it = state.items.find(x => x.id === itemId);
    const entry = it?.entries?.find(e => e.id === entryId && e.kind === 'pay');
    if (!entry || Helpers.isBusy('rbills.remove')) return;
    const ok = await UIManager.showModal(t('msg.rbills.remove_confirm', { amount: formatRupees(entry.amount), name: it.name }), t('ui.rbills.remove'), true, { confirmLabel: t('ui.rbills.remove'), danger: true });
    if (!ok) return;
    await save('rbills.remove', async () => {
        await repo.removeEntry(it.id, entry);
        it.entries = it.entries.filter(e => e.id !== entryId);
    }, 'msg.rbills.removed');
}

/** Signed out: nothing of the last owner's stays in memory. */
export function reset() {
    Object.assign(state, { items: [], loaded: false, error: false, open: '', form: '', seq: state.seq + 1, unusual: null });
}

export const RecurringBillsManager = { init, render, reset, open, showForm, cancel, saveItem, saveEdit, saveBill, savePay, saveStop, removeEntry, refreshBillsDue };
