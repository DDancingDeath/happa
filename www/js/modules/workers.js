/**
 * @fileoverview Workers / Salaries (#373 phase 1): the owner's monthly pay tracker. Each worker's
 * month is paid, part-paid or due, with payments and advances and the balance carried to the next
 * month (docs/calculations.md WP-1 … WP-10). Imported on first open; one read per worker per open.
 * Not linked to Money yet (owner decision pending).
 * @module modules/workers
 */

import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { AppState } from '../utils/state.js';
import { t, getLang } from '../i18n/index.js';
import { formatRupees } from '../utils/money.js';
import { formatMonth, formatDay, todayLocalISO } from '../utils/dates.js';
import * as repo from '../firebase/repos/workers.js';
import {
    MAX_NAME, MAX_NOTE, monthKeyOf, addMonthKey, payFor, withPay, withStart,
    paySummary, balanceParts, checkEntry, checkWorker, isMonthKey
} from '../utils/worker-pay.js';

const esc = (v) => Helpers.escapeHtml(v == null ? '' : String(v));
const js = (v) => Helpers.escapeJsAttr(v);
const et = (key, p) => esc(t(key, p));
const money = (n) => esc(formatRupees(n));
const byId = (id) => document.getElementById(id);
const val = (id) => (byId(id)?.value ?? '').trim();
const monthText = (key) => esc(formatMonth(`${key}-01`, { lang: getLang() }));
const thisMonth = () => monthKeyOf(new Date());
const isOwner = () => AppState.userRole === 'owner';
const isShown = () => byId('workers')?.classList.contains('active');
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const state = {
    workers: [],
    loaded: false,
    error: false,
    month: null,
    open: '',
    form: '',
    seq: 0
};

const STATE_TAGS = { paid: 'pos', part: 'warn', due: 'neg' };

function stateTag(row) {
    if (!row?.state) return '';
    const text = row.state === 'part'
        ? t('ui.workers.state_part', { paid: formatRupees(row.covered), of: formatRupees(row.owed) })
        : row.state === 'due' ? t('ui.workers.state_due', { amount: formatRupees(row.owed) }) : t('ui.workers.state_paid');
    return `<span class="tag ${esc(STATE_TAGS[row.state])}" data-wp-state="${esc(row.state)}">${esc(text)}</span>`;
}

function balanceLine(balance) {
    const { left, advance } = balanceParts(balance);
    if (left > 0) return `<span class="tone-neg">${et('ui.workers.balance_left', { amount: formatRupees(left) })}</span>`;
    if (advance > 0) return `<span class="tone-info">${et('ui.workers.advance_carried', { amount: formatRupees(advance) })}</span>`;
    return `<span class="tone-muted">${et('ui.workers.nothing_left')}</span>`;
}

function metric(id, key, amount) {
    return `<div class="metric"><div class="metric-label">${et(key)}</div><div class="metric-value" data-wp="${esc(id)}">${money(amount)}</div></div>`;
}

function renderSummary(sum) {
    const latest = state.month >= thisMonth();
    return `<div class="wp-month">
            <button type="button" class="btn btn-ghost btn-sm" data-onclick="workers.step(-1)" aria-label="${et('ui.workers.prev_month')}">‹</button>
            <b id="workersMonth">${monthText(state.month)}</b>
            <button type="button" class="btn btn-ghost btn-sm" data-onclick="workers.step(1)" aria-label="${et('ui.workers.next_month')}"${latest ? ' disabled' : ''}>›</button>
        </div>
        <div class="panel metrics wp-metrics">
            ${metric('WP-7', 'ui.workers.pay_month', sum.pay)}
            ${metric('WP-8', 'ui.workers.paid_out_month', sum.paidOut)}
            ${metric('WP-9', 'ui.workers.to_pay', sum.toPay)}
            ${metric('WP-10', 'ui.workers.advances', sum.advances)}
        </div>
        <p class="tone-muted wp-counts">${et('ui.workers.counts', sum.counts)}</p>`;
}

function renderRow({ worker, row, balance }) {
    const pay = payFor(worker, state.month);
    const meta = worker.active === false ? t('ui.workers.left') : t('ui.workers.pay_a_month', { amount: formatRupees(pay) });
    const open = state.open === worker.id;
    return `<button type="button" class="row${open ? ' selected' : ''}" data-worker="${esc(worker.id)}" aria-expanded="${open}" data-onclick="workers.open('${js(worker.id)}')">
            <span class="row-main"><span class="row-title">${esc(worker.name)}</span><span class="row-meta">${esc(meta)}</span></span>
            <span class="row-trail">${stateTag(row)}<span class="row-meta">${balanceLine(balance)}</span></span>
        </button>`;
}

const label = (id, key) => `<label for="${esc(id)}">${et(key)}</label>`;

const KIND_KEYS = { pay: 'ui.workers.kind_pay', advance: 'ui.workers.kind_advance' };
const MODE_KEYS = { cash: 'ui.workers.mode_cash', online: 'ui.workers.mode_online' };
const options = (keys, chosen) => Object.entries(keys).map(([v, key]) => `<option value="${esc(v)}"${v === chosen ? ' selected' : ''}>${et(key)}</option>`).join('');

function formActions(save) {
    return `<div class="wp-actions">
            <button type="button" class="btn btn-primary" id="wpSave" data-onclick="workers.${esc(save)}()">${et('ui.workers.save')}</button>
            <button type="button" class="btn btn-ghost" data-onclick="workers.cancel()">${et('ui.workers.cancel')}</button>
        </div>`;
}

function renderAddForm() {
    return `<div class="panel panel-pad wp-form" id="wpAddForm">
            <h3>${et('ui.workers.add')}</h3>
            <div class="field">${label('wpName', 'ui.workers.name')}<input class="input" id="wpName" maxlength="${esc(MAX_NAME)}" autocomplete="off"></div>
            <div class="field">${label('wpPay', 'ui.workers.monthly_pay')}<input class="input" id="wpPay" inputmode="numeric" type="number" min="1" step="1"></div>
            <div class="field">${label('wpStart', 'ui.workers.start_month')}<input class="input" id="wpStart" type="month" value="${esc(thisMonth())}"></div>
            ${formActions('saveWorker')}
        </div>`;
}

function renderPayForm(worker) {
    const month = state.month;
    return `<div class="panel panel-pad wp-form" id="wpPayForm">
            <h3>${et('ui.workers.record', { name: worker.name })}</h3>
            <div class="field">${label('wpAmount', 'ui.workers.amount')}<input class="input" id="wpAmount" inputmode="numeric" type="number" min="1" step="1"></div>
            <div class="field">${label('wpKind', 'ui.workers.kind')}<select class="input" id="wpKind">${options(KIND_KEYS, 'pay')}</select></div>
            <div class="field">${label('wpForMonth', 'ui.workers.for_month')}<input class="input" id="wpForMonth" type="month" value="${esc(month)}" max="${esc(thisMonth())}"></div>
            <div class="field">${label('wpDate', 'ui.workers.date')}<input class="input" id="wpDate" type="date" value="${esc(todayLocalISO())}"></div>
            <div class="field">${label('wpMode', 'ui.workers.mode')}<select class="input" id="wpMode">${options(MODE_KEYS, 'cash')}</select></div>
            <div class="field">${label('wpNote', 'ui.workers.note')}<input class="input" id="wpNote" maxlength="${esc(MAX_NOTE)}" autocomplete="off"></div>
            ${formActions('savePay')}
        </div>`;
}

function renderEditForm(worker) {
    const pay = payFor(worker, thisMonth());
    const payFields = worker.active === false ? '' : `<div class="field">${label('wpPay', 'ui.workers.monthly_pay')}<input class="input" id="wpPay" inputmode="numeric" type="number" min="1" step="1" value="${esc(pay || '')}"></div>
            <div class="field">${label('wpPayFrom', 'ui.workers.pay_from')}<input class="input" id="wpPayFrom" type="month" value="${esc(thisMonth())}"></div>
            <p class="tone-muted">${et('ui.workers.pay_from_help')}</p>`;
    return `<div class="panel panel-pad wp-form" id="wpEditForm">
            <h3>${et('ui.workers.edit')}</h3>
            <div class="field">${label('wpName', 'ui.workers.name')}<input class="input" id="wpName" maxlength="${esc(MAX_NAME)}" value="${esc(worker.name)}" autocomplete="off"></div>
            <div class="field">${label('wpStart', 'ui.workers.start_month')}<input class="input" id="wpStart" type="month" value="${esc(worker.startMonth)}"></div>
            ${payFields}
            ${formActions('saveEdit')}
        </div>`;
}

function renderLeftForm() {
    return `<div class="panel panel-pad wp-form" id="wpLeftForm">
            <h3>${et('ui.workers.mark_left')}</h3>
            <div class="field">${label('wpLastMonth', 'ui.workers.last_month')}<input class="input" id="wpLastMonth" type="month" value="${esc(thisMonth())}"></div>
            <p class="tone-muted">${et('ui.workers.left_help')}</p>
            ${formActions('saveLeft')}
        </div>`;
}

function renderMonths(months) {
    const shown = months.filter(r => r.state || r.paid > 0).slice(-24).reverse();
    if (!shown.length) return '';
    const rows = shown.map(r => `<tr data-month="${esc(r.month)}">
            <td>${monthText(r.month)}</td>
            <td class="num">${money(r.pay)}</td>
            <td class="num">${money(r.paid)}</td>
            <td class="num">${r.recovered > 0 ? et('ui.workers.from_advance', { amount: formatRupees(r.recovered) }) : ''}</td>
            <td>${stateTag(r)}</td>
            <td>${balanceLine(r.closing)}</td>
        </tr>`).join('');
    return `<div class="scroll-cue"><div class="scroll-cue-inner"><table class="wp-table">
            <thead><tr><th>${et('ui.workers.month')}</th><th>${et('ui.workers.col_pay')}</th><th>${et('ui.workers.col_paid')}</th><th>${et('ui.workers.col_advance')}</th><th>${et('ui.workers.col_state')}</th><th>${et('ui.workers.col_balance')}</th></tr></thead>
            <tbody>${rows}</tbody></table></div></div>`;
}

function renderEntries(worker) {
    const list = [...(worker.entries || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.month).localeCompare(String(a.month)));
    if (!list.length) return `<p class="empty">${et('ui.workers.no_entries')}</p>`;
    return list.map(e => `<div class="row" data-entry="${esc(e.id)}">
            <span class="row-main"><span class="row-title">${money(e.amount)} · ${et(KIND_KEYS[e.kind] || KIND_KEYS.pay)}</span>
            <span class="row-meta">${et('ui.workers.entry_meta', { month: formatMonth(`${e.month}-01`, { lang: getLang() }), date: formatDay(e.date, { lang: getLang() }), mode: t(MODE_KEYS[e.mode] || MODE_KEYS.cash) })}${e.note ? ` · ${esc(e.note)}` : ''}</span></span>
            <button type="button" class="btn btn-ghost btn-sm" data-onclick="workers.removeEntry('${js(worker.id)}', '${js(e.id)}')">${et('ui.workers.remove')}</button>
        </div>`).join('');
}

function renderDetail(item) {
    const w = item.worker;
    const form = state.form === 'pay' ? renderPayForm(w) : state.form === 'edit' ? renderEditForm(w) : state.form === 'left' ? renderLeftForm() : '';
    const leave = w.active === false
        ? `<button type="button" class="btn btn-tonal btn-sm" data-onclick="workers.rejoin()">${et('ui.workers.rejoin')}</button>`
        : `<button type="button" class="btn btn-tonal btn-sm" data-onclick="workers.showForm('left')">${et('ui.workers.mark_left')}</button>`;
    return `<section class="panel panel-pad wp-detail" id="wpDetail">
            <h3>${esc(w.name)}</h3>
            <p>${balanceLine(item.balance)}</p>
            <div class="wp-actions">
                <button type="button" class="btn btn-primary btn-sm" data-onclick="workers.showForm('pay')">${et('ui.workers.record_btn')}</button>
                <button type="button" class="btn btn-tonal btn-sm" data-onclick="workers.showForm('edit')">${et('ui.workers.edit')}</button>
                ${leave}
            </div>
            ${form}
            <h4>${et('ui.workers.by_month')}</h4>
            ${renderMonths(item.months)}
            <h4>${et('ui.workers.entries')}</h4>
            <div class="panel">${renderEntries(w)}</div>
        </section>`;
}

export function render() {
    const root = byId('workersBody');
    if (!root) return;
    if (!isOwner()) {
        root.innerHTML = `<p class="empty">${et('ui.workers.owner_only')}</p>`;
        return;
    }
    if (!state.loaded) {
        root.innerHTML = state.error
            ? `<p class="notice neg">${et('msg.workers.not_loaded')}</p>`
            : `<p class="empty">${et('ui.workers.loading')}</p>`;
        return;
    }
    const sum = paySummary(state.workers, state.month);
    const items = [...sum.rows].sort((a, b) => (a.worker.active === false) - (b.worker.active === false) || a.worker.name.localeCompare(b.worker.name));
    const open = items.find(i => i.worker.id === state.open);
    const list = items.length
        ? `<div class="panel wp-list">${items.map(renderRow).join('')}</div>`
        : `<p class="empty">${et('ui.workers.none')}</p>`;
    root.innerHTML = `${renderSummary(sum)}
        <div class="wp-actions"><button type="button" class="btn btn-tonal" data-onclick="workers.showForm('add')">${et('ui.workers.add')}</button></div>
        ${state.form === 'add' ? renderAddForm() : ''}
        ${list}
        ${open ? renderDetail(open) : ''}`;
}

function ensureCss() {
    if (byId('workersCss')) return;
    const link = document.createElement('link');
    link.id = 'workersCss';
    link.rel = 'stylesheet';
    link.href = 'css/workers.css';
    document.head.appendChild(link);
}

/** Opens the page: reads every worker once (one read each). */
export async function init() {
    ensureCss();
    if (!state.month) state.month = thisMonth();
    state.loaded = false;
    state.error = false;
    render();
    if (!isOwner()) return;
    const seq = ++state.seq;
    try {
        const list = await repo.loadWorkers();
        if (seq !== state.seq) return;
        state.workers = list;
        state.loaded = true;
    } catch (e) {
        console.warn('Workers not loaded:', e?.code || e);
        if (seq === state.seq) state.error = true;
    }
    if (isShown()) render();
}

export function step(n) {
    const next = addMonthKey(state.month || thisMonth(), n);
    if (next > thisMonth()) return;
    state.month = next;
    render();
}

export function open(id) {
    state.open = state.open === id ? '' : id;
    if (state.form !== 'add') state.form = '';
    render();
    if (state.open) byId('wpDetail')?.scrollIntoView?.({ block: 'nearest' });
}

export function showForm(kind) {
    state.form = kind;
    render();
    byId(kind === 'pay' ? 'wpAmount' : kind === 'left' ? 'wpLastMonth' : 'wpName')?.focus?.();
}

export function cancel() {
    state.form = '';
    render();
}

const openWorker = () => state.workers.find(w => w.id === state.open);

/** Runs one save (one tap = one write), refusing offline; true when saved. */
async function save(key, fn, doneKey, params) {
    if (Helpers.isBusy(key)) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        UIManager.showToast(t('msg.workers.needs_internet'), 'warning');
        return false;
    }
    try {
        await Helpers.runExclusive(key, '#workers .btn', fn);
        state.form = '';
        render();
        UIManager.showToast(t(doneKey, params), 'success');
        return true;
    } catch (e) {
        console.warn('Worker pay not saved:', e?.code || e);
        UIManager.showToast(t('msg.workers.not_saved'), 'error');
        return false;
    }
}

const warn = (key) => UIManager.showToast(t(key), 'warning');

export async function saveWorker() {
    const { worker, error } = checkWorker({ name: val('wpName'), pay: val('wpPay'), startMonth: val('wpStart') }, thisMonth());
    if (error) return warn(error);
    await save('workers.add', async () => {
        const id = await repo.addWorker(worker);
        state.workers.push({ id, name: worker.name, startMonth: worker.startMonth, active: true, pays: [{ from: worker.startMonth, amount: worker.pay }], entries: [] });
        state.open = id;
    }, 'msg.workers.added', { name: worker.name });
}

export async function savePay() {
    const w = openWorker();
    if (!w) return;
    const { entry, error } = checkEntry({ amount: val('wpAmount'), month: val('wpForMonth'), date: val('wpDate'), kind: val('wpKind'), mode: val('wpMode'), note: val('wpNote') }, thisMonth());
    if (error) return warn(error);
    const full = { id: newId(), ...entry };
    await save('workers.pay', async () => {
        await repo.addEntry(w.id, full);
        w.entries = [...(w.entries || []), full];
    }, 'msg.workers.recorded', { amount: formatRupees(full.amount), name: w.name });
}

export async function saveEdit() {
    const w = openWorker();
    if (!w) return;
    const left = w.active === false;
    const { worker, error } = checkWorker({ name: val('wpName'), pay: left ? '1' : val('wpPay'), startMonth: val('wpStart') }, thisMonth());
    if (error) return warn(error);
    const from = left ? worker.startMonth : val('wpPayFrom');
    if (!isMonthKey(from)) return warn('msg.workers.bad_month');
    const started = withStart(w.pays, worker.startMonth);
    const pays = left || payFor({ ...w, startMonth: worker.startMonth, pays: started }, from) === worker.pay ? started : withPay(started, worker.startMonth, from, worker.pay);
    const patch = { name: worker.name, startMonth: worker.startMonth, pays };
    await save('workers.edit', async () => {
        await repo.updateWorker(w.id, patch);
        Object.assign(w, patch);
    }, 'msg.workers.saved');
}

export async function saveLeft() {
    const w = openWorker();
    const last = val('wpLastMonth');
    if (!w) return;
    if (!isMonthKey(last) || last < w.startMonth) return warn('msg.workers.bad_month');
    const patch = { active: false, pays: withPay(w.pays, w.startMonth, addMonthKey(last, 1), 0) };
    await save('workers.left', async () => {
        await repo.updateWorker(w.id, patch);
        Object.assign(w, patch);
    }, 'msg.workers.marked_left', { name: w.name });
}

export async function rejoin() {
    const w = openWorker();
    if (!w) return;
    const last = [...(w.pays || [])].reverse().find(p => Number(p.amount) > 0);
    if (!last) return showForm('edit');
    const patch = { active: true, pays: withPay(w.pays, w.startMonth, thisMonth(), Number(last.amount)) };
    await save('workers.rejoin', async () => {
        await repo.updateWorker(w.id, patch);
        Object.assign(w, patch);
    }, 'msg.workers.rejoined', { name: w.name, amount: formatRupees(last.amount) });
}

export async function removeEntry(workerId, entryId) {
    const w = state.workers.find(x => x.id === workerId);
    const entry = w?.entries?.find(e => e.id === entryId);
    if (!entry || Helpers.isBusy('workers.remove')) return;
    const ok = await UIManager.showModal(t('msg.workers.remove_confirm', { amount: formatRupees(entry.amount), name: w.name }), t('ui.workers.remove'), true);
    if (!ok) return;
    await save('workers.remove', async () => {
        await repo.removeEntry(w.id, entry);
        w.entries = w.entries.filter(e => e.id !== entryId);
    }, 'msg.workers.removed');
}

/** Signed out: nothing of the last owner's stays in memory. */
export function reset() {
    Object.assign(state, { workers: [], loaded: false, error: false, month: null, open: '', form: '', seq: state.seq + 1 });
}

export const WorkersManager = { init, render, reset, step, open, showForm, cancel, saveWorker, savePay, saveEdit, saveLeft, rejoin, removeEntry };
