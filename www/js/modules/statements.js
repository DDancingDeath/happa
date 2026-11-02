/**
 * @fileoverview Statements page (docs/insights-redesign.md §5.4): day book,
 * month statement, party ledger, item ledger and the CSV export, each with
 * WhatsApp, Print / PDF and CSV. Rows come from utils/statements.js and
 * utils/business-metrics.js; this module only renders and shares.
 * @module modules/statements
 */

import { AppState } from '../utils/state.js';
import { Helpers } from '../utils/helpers.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { UIManager } from '../ui/ui-manager.js';
import { t, getLang } from '../i18n/index.js';
import { formatRupees, formatAmount, formatKg } from '../utils/money.js';
import { formatDay, formatMonth, formatDayTime, toLocalISODate, parseLocalDate, todayLocalISO, monthStart, endOfLocalDayExclusive, addLocalDays } from '../utils/dates.js';
import { pickReplayBase } from '../utils/finance-calc.js';
import { historyLoadedFrom, isFullHistoryLoaded, ensureHistoryFrom } from '../utils/history-window.js';
import { openExternal } from '../utils/open-external.js';
import { moneySummary } from '../utils/business-metrics.js';
import { MoneyManager } from './money.js';
import {
    dayBook, partyLedger, partyChoices, itemLedger, exportLines, accountantLines, ACCOUNTANT_COLUMNS, csvLanguage, readCsvEnglish, writeCsvEnglish, plainLabel, isoMinute
} from '../utils/statements.js';
import { can } from '../utils/role-access.js';
import { getInsightsContext, setInsightsContext } from '../utils/insights-context.js';
import { monthBounds, monthKeyOf } from '../utils/month-snapshots.js';
import { Exporter } from '../services/exporter.js';
import { stampedCsv, stampLine, exportFilename } from '../utils/export-stamp.js';

const esc = (s) => Helpers.escapeHtml(String(s ?? ''));
const money = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '—' : formatRupees(Number(v)));
const KINDS = ['day', 'month', 'party', 'item', 'csv', 'accountant'];
/** Statements only the owner opens: their whole point is the file (#103). */
const OWNER_KINDS = ['csv', 'accountant'];
/** Statements whose files name customers or suppliers: confirm before exporting (#103). */
const NAMED_KINDS = ['day', 'party', 'item', 'csv', 'accountant'];

export const StatementsManager = {
    kind: null,
    day: null,
    month: null,
    partyKind: 'customer',
    partyKey: null,
    itemKey: null,
    csvFrom: null,
    csvTo: null,
    current: null,

    init(route) {
        this.showOwnerParts();
        if (route && KINDS.includes(route)) this.open(route);
        else this.back();
    },

    /** Export buttons and the export-only statements are the owner's (#103). */
    showOwnerParts() {
        const owner = Exporter.allowed();
        document.querySelectorAll('#statements [data-owner-only]').forEach(el => { el.hidden = !owner; });
    },

    back() {
        this.kind = null;
        const list = document.getElementById('statementsList');
        const view = document.getElementById('statementsView');
        if (list) list.hidden = false;
        if (view) view.hidden = true;
    },

    open(kind) {
        if (!KINDS.includes(kind)) return;
        this.showOwnerParts();
        if (OWNER_KINDS.includes(kind) && !Exporter.allowed()) {
            this.back();
            return;
        }
        this.kind = kind;
        const list = document.getElementById('statementsList');
        const view = document.getElementById('statementsView');
        if (list) list.hidden = true;
        if (view) view.hidden = false;
        const now = new Date();
        if (!this.day) this.day = todayLocalISO();
        if (!this.month) {
            const m = /^month:(\d{4}-\d{2})$/.exec(getInsightsContext().preset);
            this.month = m ? m[1] : monthKeyOf(now.getTime());
        }
        if (!this.itemKey) this.itemKey = getInsightsContext().itemId;
        if (!this.csvFrom) this.csvFrom = toLocalISODate(monthStart(now));
        if (!this.csvTo) this.csvTo = todayLocalISO();
        this.renderControls();
        this.renderCsvOption();
        this.render();
    },

    /** Chooses the party the ledger opens on next (Insights › Parties row). */
    selectParty(partyKey, kind = 'customer') {
        this.partyKey = partyKey || null;
        this.partyKind = kind === 'supplier' ? 'supplier' : 'customer';
    },

    /** Party ledger for a party (from Insights › Parties or Outstanding). */
    openParty(partyKey, kind = 'customer') {
        this.partyKey = partyKey;
        this.partyKind = kind === 'supplier' ? 'supplier' : 'customer';
        this.open('party');
    },

    src() {
        return {
            purchases: AppState.purchaseHistory || [],
            wholesaleSales: AppState.salesHistory || [],
            retailSales: AppState.retailSalesHistory || [],
            stockAdjustments: AppState.stockAdjustments || [],
            expenses: AppState.expensesHistory || [],
            withdrawals: AppState.withdrawalsHistory || []
        };
    },

    covered(from) {
        return isFullHistoryLoaded() || (Number.isFinite(from) && from >= historyLoadedFrom());
    },

    /** The range's cash sessions (Money's loader and cache): their due legs count payments on old bills. */
    sessions(r) {
        return MoneyManager.sessions(r, () => { if (this.isOpen()) this.render(); });
    },

    isOpen() {
        const el = document.getElementById('statements');
        return !!el && el.classList.contains('active');
    },

    duesCaveat(sessions) {
        return sessions.complete === false ? `<div class="ins-caveat">⚠ ${esc(t('ui.money.caveat_dues'))}</div>` : '';
    },

    /** Section permissions (Roles & access): lines a role may not see are left out of the screen and every export. */
    perms() {
        const may = (p) => can(AppState.userRole, p, AppState.settings?.roleAccess);
        return { profit: may('profit'), personalExpenses: may('personalExpenses'), stockValue: may('stockValue'), purchaseRates: may('purchaseRates') };
    },

    /** CSV language: the app's, or English when "CSV in English" is on. */
    csvLang() { return csvLanguage(getLang(), readCsvEnglish()); },

    setCsvEnglish(on) {
        writeCsvEnglish(!!on);
        this.renderCsvOption();
        this.render();
    },

    renderCsvOption() {
        const el = document.getElementById('statementsCsvOption');
        if (!el) return;
        el.hidden = getLang() !== 'hi';
        el.innerHTML = el.hidden ? '' : `<label class="st-check"><input type="checkbox" id="statementsCsvEnglish"${readCsvEnglish() ? ' checked' : ''} onchange="window.app.statements.setCsvEnglish(this.checked)"> ${esc(t('ui.statements.csv_english'))}</label>`;
    },

    renderControls() {
        const lang = getLang();
        const heading = { day: 'ui.statements.day_book', month: 'ui.statements.month', party: 'ui.statements.party', item: 'ui.statements.item', csv: 'ui.statements.csv', accountant: 'ui.statements.accountant' }[this.kind];
        const h = document.getElementById('statementsHeading');
        if (h) h.textContent = t(heading);
        let html = '';
        if (this.kind === 'day') {
            html = `<label>${esc(t('ui.statements.pick_day'))} <input type="date" class="form-control" value="${esc(this.day)}" onchange="window.app.statements.set('day', this.value)"></label>`;
        } else if (this.kind === 'month') {
            const now = new Date();
            const opts = Array.from({ length: 24 }, (_, i) => monthKeyOf(monthStart(now, -i).getTime()));
            html = `<label>${esc(t('ui.statements.pick_month'))} <select class="form-control" onchange="window.app.statements.set('month', this.value)">${opts.map(k => `<option value="${k}"${k === this.month ? ' selected' : ''}>${esc(formatMonth(monthBounds(k).from, { lang }))}</option>`).join('')}</select></label>`;
        } else if (this.kind === 'party') {
            const parties = partyChoices(this.src(), this.partyKind);
            if (!this.partyKey || !parties.some(p => p.key === this.partyKey)) this.partyKey = parties[0]?.key || null;
            html = `<div class="ins-tabs ins-subtabs"><button type="button" class="ins-tab${this.partyKind === 'customer' ? ' active' : ''}" onclick="window.app.statements.set('partyKind', 'customer')">${esc(t('ui.insights.customers'))}</button>`
                + `<button type="button" class="ins-tab${this.partyKind === 'supplier' ? ' active' : ''}" onclick="window.app.statements.set('partyKind', 'supplier')">${esc(t('ui.insights.suppliers'))}</button></div>`
                + `<label>${esc(t('ui.insights.party'))} <select class="form-control" onchange="window.app.statements.set('partyKey', this.value)">${parties.map(p => `<option value="${esc(p.key)}"${p.key === this.partyKey ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>`;
        } else if (this.kind === 'item') {
            const items = (AppState.items || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
            if (!this.itemKey || !items.some(i => i.id === this.itemKey)) this.itemKey = items[0]?.id || null;
            html = `<label>${esc(t('ui.insights.item'))} <select class="form-control" onchange="window.app.statements.set('itemKey', this.value)">${items.map(i => `<option value="${esc(i.id)}"${i.id === this.itemKey ? ' selected' : ''}>${esc(lang === 'hi' ? i.hindiName || i.name : i.name)}</option>`).join('')}</select></label>`;
        } else if (this.kind === 'csv' || this.kind === 'accountant') {
            html = `<label>${esc(t('ui.statements.from'))} <input type="date" class="form-control" value="${esc(this.csvFrom)}" onchange="window.app.statements.set('csvFrom', this.value)"></label>`
                + `<label>${esc(t('ui.statements.to'))} <input type="date" class="form-control" value="${esc(this.csvTo)}" onchange="window.app.statements.set('csvTo', this.value)"></label>`;
        }
        const el = document.getElementById('statementsControls');
        if (el) el.innerHTML = html;
    },

    set(field, value) {
        if (!['day', 'month', 'partyKind', 'partyKey', 'itemKey', 'csvFrom', 'csvTo'].includes(field)) return;
        this[field] = value;
        if (field === 'partyKind') this.partyKey = null;
        if (field === 'itemKey') setInsightsContext({ itemId: value });
        this.renderControls();
        this.render();
    },

    render() {
        const doc = document.getElementById('statementsDoc');
        if (!doc || !this.kind) return;
        const fn = { day: 'renderDay', month: 'renderMonth', party: 'renderParty', item: 'renderItem', csv: 'renderCsv', accountant: 'renderAccountant' }[this.kind];
        this.current = { ...this[fn](), period: this.periodOf() };
        doc.innerHTML = this.current.html;
    },

    /** The period an export covers (its stamp and audit row): ISO days, `from` null = all loaded bills. */
    periodOf() {
        const loadedFrom = isFullHistoryLoaded() ? null : toLocalISODate(new Date(historyLoadedFrom()));
        if (this.kind === 'day') return { from: this.day, to: this.day };
        if (this.kind === 'month') {
            const b = monthBounds(this.month);
            return { from: toLocalISODate(new Date(b.from)), to: toLocalISODate(addLocalDays(new Date(b.to), -1)) };
        }
        if (this.kind === 'csv' || this.kind === 'accountant') return { from: this.csvFrom, to: this.csvTo };
        return { from: loadedFrom, to: todayLocalISO() };
    },

    notLoaded(label, from) {
        return {
            title: label, html: `<div class="ins-empty"><p>${esc(t('ui.money.older_not_loaded', { period: label }))}</p><button type="button" class="btn btn-primary" onclick="window.app.statements.loadOlder(${Number.isFinite(from) ? from : 'null'})">${esc(t('ui.money.load_older'))}</button></div>`,
            share: '', csvHeader: [], csvRows: []
        };
    },

    async loadOlder(from) {
        try {
            const ok = await ensureHistoryFrom(from === null ? null : new Date(from));
            if (!ok) UIManager.showToast(t('msg.money.could_not_load'));
        } catch (e) {
            console.error('Statements: loading older bills failed:', e);
            UIManager.showToast(t('msg.money.could_not_load'));
        }
        this.renderControls();
        this.render();
    },

    kindLabel(kind, lang) {
        return t(`ui.statements.k_${String(kind).replace(/[A-Z]/g, ch => `_${ch.toLowerCase()}`)}`, null, lang);
    },

    renderDay() {
        const lang = getLang();
        const d = parseLocalDate(this.day) || new Date();
        const from = d.getTime();
        const to = endOfLocalDayExclusive(d).getTime();
        const title = `${t('ui.statements.day_book')} · ${formatDay(d, { lang })}`;
        if (!this.covered(from)) return this.notLoaded(formatDay(d, { lang }), from);
        const perms = this.perms();
        const cl = this.csvLang();
        const tc = (k) => t(k, null, cl);
        const sessions = this.sessions({ from, to });
        const { rows, totals } = dayBook(this.src(), { from, to }, { personal: perms.personalExpenses, sessions: sessions.list });
        const isToday = this.day === todayLocalISO();
        const timeOf = (r) => (r.t ? formatDayTime(r.t, { lang }).split(', ').pop() : '');
        const body = rows.map(r => `<tr><td>${esc(timeOf(r))}</td><td>${esc(this.kindLabel(r.kind))}</td><td>${esc([r.billNo, r.party, r.note].filter(Boolean).join(' · '))}</td><td class="num">${money(r.amount)}</td><td class="num">${r.due ? money(r.due) : ''}</td></tr>`).join('');
        const tot = [
            ['ui.statements.t_sales', totals.sales, totals.salesCount], ['ui.statements.t_purchases', totals.purchases, totals.purchaseCount],
            ['ui.statements.t_expenses', totals.expenses], ['ui.statements.t_withdrawals', totals.withdrawals],
            ['ui.statements.t_due_received', totals.dueReceived], ['ui.statements.t_due_paid', totals.duePaid]
        ];
        const html = (isToday ? `<p class="ins-hint"><button type="button" class="ins-link" onclick="window.app.nav.showTab('day')">${esc(t('ui.statements.today_link'))} ›</button></p>` : '')
            + `<h3 class="st-title">${esc(title)}</h3>`
            + this.duesCaveat(sessions)
            + `<div class="ins-scroll"><table class="ins-table"><thead><tr><th>${esc(t('ui.statements.time'))}</th><th>${esc(t('ui.statements.what'))}</th><th>${esc(t('ui.statements.details'))}</th><th class="num">${esc(t('ui.money.amount'))}</th><th class="num">${esc(t('ui.statements.due'))}</th></tr></thead><tbody>${body || `<tr><td colspan="5">${esc(t('ui.statements.nothing'))}</td></tr>`}</tbody></table></div>`
            + (isToday ? '' : `<div class="st-totals">${tot.map(([k, v, c]) => `<div class="ins-row"><span>${esc(t(k))}${c !== undefined ? ` (${c})` : ''}</span><span data-metric-export="${k === 'ui.statements.t_sales' ? 'M1' : k === 'ui.statements.t_purchases' ? 'M16' : 'M4'}">${money(v)}</span></div>`).join('')}</div>`);
        let share = [title, ...tot.map(([k, v]) => `${t(k)}: ${formatRupees(v)}`)].join('\n');
        // Today's totals have one home (Today); today's day book lists the bills only.
        if (isToday) share = [title, ...rows.map(r => [timeOf(r), this.kindLabel(r.kind), r.billNo, r.party, r.note, formatRupees(r.amount)].filter(Boolean).join(' · '))].join('\n');
        const csvHeader = [tc('ui.statements.time'), tc('ui.statements.what'), tc('ui.statements.bill_no'), tc('ui.insights.party'), tc('ui.statements.details'), tc('ui.money.amount'), tc('ui.statements.cash'), tc('ui.statements.online'), tc('ui.statements.due')];
        const csvRows = rows.map(r => [isoMinute(r.t), this.kindLabel(r.kind, cl), r.billNo, r.party, r.note, r.amount, r.cash, r.online, r.due]);
        return { title, html, share, csvHeader, csvRows };
    },

    renderMonth() {
        const lang = getLang();
        const b = monthBounds(this.month);
        const to = Math.min(b.to, Date.now() + 1);
        const label = formatMonth(b.from, { lang });
        const title = `${t('ui.statements.month')} · ${label}`;
        if (!this.covered(b.from)) return this.notLoaded(label, b.from);
        const base = pickReplayBase({ checkpoint: FirebaseService.getStockCheckpointState?.() || null, fullHistory: isFullHistoryLoaded(), from: b.from });
        const sessions = this.sessions({ from: b.from, to });
        const m = moneySummary({ ...this.src(), items: AppState.items || [], base, sessions: sessions.list, duesComplete: sessions.complete !== false }, { from: b.from, to });
        const perms = this.perms();
        const cl = this.csvLang();
        // [label, value, spec ID, permission needed]
        const lines = [
            ['ui.money.sales', m.M1.total, 'M1'], ['ui.money.cogs_minus', m.M2, 'M2', 'profit'], ['ui.money.gross_eq', m.M3.total, 'M3', 'profit'],
            ['ui.money.business_minus', m.M4.total, 'M4'], ['ui.money.bad_debts_minus', m.M5, 'M5'], ['ui.money.profit_eq', m.M6.total, 'M6', 'profit'],
            ['ui.money.labour_line', m.M7, 'M7'], ['ui.money.personal_expenses', m.M8.total, 'M8', 'personalExpenses'], ['ui.money.withdrawals', m.M9, 'M9'],
            ['ui.money.kept', m.M10, 'M10', 'profit'], ['ui.money.money_in', m.M12.total, 'M12'], ['ui.money.money_out', m.M13.total, 'M13'],
            ['ui.money.net_money', m.M14, 'M14'], ['ui.money.bought', m.M16.total, 'M16'],
            ...(m.M17 ? [['ui.money.opening_stock', m.M17.opening, null, 'stockValue'], ['ui.money.closing_stock', m.M17.closing, null, 'stockValue']] : [])
        ].filter(([, , , perm]) => !perm || perms[perm]);
        const caveats = perms.profit ? m.caveats : m.caveats.filter(c => c.key === 'dues');
        const html = `<h3 class="st-title">${esc(title)}</h3>`
            + lines.map(([k, v, id, perm]) => `<div class="ins-row${/eq$|kept|net_money/.test(k) ? ' ins-total' : ''}${id ? '' : ' ins-sub'}"${perm ? ` data-perm="${perm}"` : ''}><span>${esc(t(k))}</span><span${id ? ` data-metric-export="${id}"` : ''}>${money(v)}</span></div>`).join('')
            + caveats.map(c => `<div class="ins-caveat"${c.key === 'dues' ? '' : ' data-perm="profit"'}>⚠ ${esc(t(`ui.money.caveat_${c.key}`, { qty: c.qty, amount: formatAmount(c.estimate ?? c.amount ?? c.gap ?? 0) }))}</div>`).join('');
        const share = [title, ...lines.map(([k, v]) => `${plainLabel(t(k))}: ${v === null ? '—' : formatRupees(v)}`)].join('\n');
        return { title, html, share, csvHeader: [t('ui.statements.what', null, cl), t('ui.money.amount', null, cl)], csvRows: lines.map(([k, v]) => [plainLabel(t(k, null, cl)), v === null ? '' : v]) };
    },

    renderParty() {
        const lang = getLang();
        if (!this.partyKey) return { title: t('ui.statements.party'), html: `<p class="ins-empty-text">${esc(t('ui.insights.no_parties'))}</p>`, share: '', csvHeader: [], csvRows: [] };
        const l = partyLedger(this.src(), this.partyKey, this.partyKind);
        const title = `${t('ui.statements.party')} · ${l.name}`;
        const matches = Math.abs(l.closing - l.due) <= 1;
        const word = (v) => t(this.partyKind === 'supplier' ? 'ui.statements.to_pay' : 'ui.statements.to_receive', { amount: formatRupees(Math.abs(v)) });
        const body = l.rows.map(r => `<tr><td>${esc(formatDay(r.t, { lang }))}</td><td>${esc([this.kindLabel(r.kind), r.billNo].filter(Boolean).join(' · '))}</td><td class="num">${r.debit ? money(r.debit) : ''}</td><td class="num">${r.credit ? money(r.credit) : ''}</td><td class="num">${money(r.balance)}</td></tr>`).join('');
        const loadedNote = isFullHistoryLoaded() ? '' : `<p class="ins-hint">${esc(t('ui.statements.loaded_only'))} <button type="button" class="ins-link" onclick="window.app.statements.loadOlder(null)">${esc(t('ui.money.load_older'))}</button></p>`;
        const html = `<h3 class="st-title">${esc(title)}</h3>`
            + `<div class="ins-hero st-balance"><div class="ins-hero-label">${esc(t('ui.statements.balance'))}</div><div class="ins-hero-value" data-metric-export="O4">${esc(word(l.closing))}</div>`
            + `<div class="ins-compare">${matches ? `✓ ${esc(t('ui.statements.matches_outstanding'))}` : `⚠ ${esc(t('ui.statements.differs_outstanding', { amount: formatRupees(l.due) }))}`}</div></div>`
            + loadedNote
            + `<div class="ins-scroll"><table class="ins-table"><thead><tr><th>${esc(t('ui.statements.date'))}</th><th>${esc(t('ui.statements.what'))}</th><th class="num">${esc(t(this.partyKind === 'supplier' ? 'ui.statements.bought_col' : 'ui.statements.sold_col'))}</th><th class="num">${esc(t('ui.statements.paid_col'))}</th><th class="num">${esc(t('ui.statements.balance'))}</th></tr></thead><tbody>${body || `<tr><td colspan="5">${esc(t('ui.statements.nothing'))}</td></tr>`}</tbody></table></div>`;
        const share = [title, word(l.closing), ...l.rows.slice(-10).map(r => `${formatDay(r.t, { lang })} ${this.kindLabel(r.kind)} ${r.billNo} ${r.debit ? `+${formatRupees(r.debit)}` : `−${formatRupees(r.credit)}`} = ${formatRupees(r.balance)}`)].join('\n');
        const cl = this.csvLang();
        const tc = (k) => t(k, null, cl);
        const csvHeader = [tc('ui.statements.date'), tc('ui.statements.what'), tc('ui.statements.bill_no'), tc(this.partyKind === 'supplier' ? 'ui.statements.bought_col' : 'ui.statements.sold_col'), tc('ui.statements.paid_col'), tc('ui.statements.balance')];
        const csvRows = l.rows.map(r => [toLocalISODate(new Date(r.t)), this.kindLabel(r.kind, cl), r.billNo, r.debit || '', r.credit || '', r.balance]);
        return { title, html, share, csvHeader, csvRows };
    },

    renderItem() {
        const lang = getLang();
        const item = (AppState.items || []).find(i => i.id === this.itemKey);
        if (!item) return { title: t('ui.statements.item'), html: `<p class="ins-empty-text">${esc(t('ui.statements.nothing'))}</p>`, share: '', csvHeader: [], csvRows: [] };
        const name = lang === 'hi' ? item.hindiName || item.name : item.name;
        const title = `${t('ui.statements.item')} · ${name}`;
        if (!isFullHistoryLoaded()) {
            const n = this.notLoaded(name, null);
            n.html = `<p class="ins-hint">${esc(t('ui.statements.item_needs_all'))}</p>${n.html}`;
            return n;
        }
        const l = itemLedger(this.src(), AppState.items || [], this.itemKey);
        const perms = this.perms();
        const cl = this.csvLang();
        const tc = (k) => t(k, null, cl);
        // Average cost and purchase rates need purchaseRates; stock value needs stockValue; below-cost needs profit.
        const showCost = perms.purchaseRates;
        const rateOf = (r) => (r.kind === 'purchase' && !perms.purchaseRates ? '' : r.rate);
        const body = l.rows.map(r => {
            const below = r.belowCost && perms.profit;
            return `<tr${below || r.beforeBought ? ' class="st-flag"' : ''}><td>${esc(r.t ? formatDay(r.t, { lang }) : '')}</td><td>${esc([this.kindLabel(r.kind), r.billNo, r.party].filter(Boolean).join(' · '))}${below ? ` ⚠ <span data-perm="profit">${esc(t('ui.statements.below_cost'))}</span>` : ''}${r.beforeBought ? ` ⚠ ${esc(t('ui.statements.before_bought'))}` : ''}</td><td class="num">${r.qty > 0 ? '+' : ''}${formatKg(r.qty)}</td><td class="num">${formatKg(r.balanceQty)}</td>${showCost ? `<td class="num" data-perm="purchaseRates">${formatAmount(r.avgCost, { decimals: 2 })}</td>` : ''}</tr>`;
        }).join('');
        const closing = perms.stockValue && perms.purchaseRates
            ? t('ui.statements.kg_at', { kg: formatKg(l.closing.qty), rate: formatAmount(l.closing.rate, { decimals: 2 }), value: formatRupees(l.closing.value) })
            : t('ui.statements.kg_left', { kg: formatKg(l.closing.qty) });
        const html = `<h3 class="st-title">${esc(title)}</h3>`
            + `<div class="ins-row ins-total"><span>${esc(t('ui.statements.closing_stock'))}</span><span data-metric-export="S4"${perms.stockValue ? ' data-perm="stockValue"' : ''}>${esc(closing)}</span></div>`
            + `<div class="ins-scroll"><table class="ins-table"><thead><tr><th>${esc(t('ui.statements.date'))}</th><th>${esc(t('ui.statements.what'))}</th><th class="num">${esc(t('ui.insights.kg'))}</th><th class="num">${esc(t('ui.statements.stock_kg'))}</th>${showCost ? `<th class="num" data-perm="purchaseRates">${esc(t('ui.statements.avg_cost'))}</th>` : ''}</tr></thead><tbody>${body || `<tr><td colspan="5">${esc(t('ui.statements.nothing'))}</td></tr>`}</tbody></table></div>`;
        const share = [title, closing].join('\n');
        const csvHeader = [tc('ui.statements.date'), tc('ui.statements.what'), tc('ui.statements.bill_no'), tc('ui.insights.party'), tc('ui.insights.kg'), tc('ui.statements.rate'), tc('ui.statements.stock_kg'), ...(showCost ? [tc('ui.statements.avg_cost')] : [])];
        const csvRows = l.rows.map(r => [r.t ? toLocalISODate(new Date(r.t)) : '', this.kindLabel(r.kind, cl), r.billNo, r.party, r.qty, rateOf(r), r.balanceQty, ...(showCost ? [r.avgCost] : [])]);
        return { title, html, share, csvHeader, csvRows };
    },

    renderCsv() {
        const lang = getLang();
        const from = (parseLocalDate(this.csvFrom) || new Date()).getTime();
        const toD = parseLocalDate(this.csvTo) || new Date();
        const to = endOfLocalDayExclusive(toD).getTime();
        const label = `${formatDay(from, { lang })} – ${formatDay(toD, { lang })}`;
        const title = `${t('ui.statements.csv')} · ${label}`;
        if (!this.covered(from)) return this.notLoaded(label, from);
        const rows = exportLines(this.src(), AppState.items || [], { from, to });
        const bills = new Set(rows.map(r => `${r.type}|${r.billNo}|${r.date}`)).size;
        const html = `<h3 class="st-title">${esc(title)}</h3><p>${esc(t('ui.statements.csv_ready', { lines: rows.length, bills }))}</p>`;
        const cl = this.csvLang();
        const rates = this.perms().purchaseRates;
        const csvHeader = ['date', 'type', 'bill_no', 'party', 'item', 'kg', 'rate', 'line_amount', 'labour', 'amount_after_labour', 'bill_total', 'cash', 'online', 'due']
            .map(k => t(`ui.statements.csv_${k}`, null, cl));
        // Without purchaseRates the purchase lines keep kg and the bill's money, not the rate per kg.
        const csvRows = rows.map(r => {
            const hide = r.type === 'purchase' && !rates;
            return [r.date, this.kindLabel(r.type, cl), r.billNo, r.party, r.item, r.qty, hide ? '' : r.rate, hide ? '' : r.lineAmount, r.labour, hide ? '' : r.amount, r.billTotal, r.cash, r.online, r.due];
        });
        return { title, html, share: `${title}\n${t('ui.statements.csv_ready', { lines: rows.length, bills })}`, csvHeader, csvRows };
    },

    renderAccountant() {
        const lang = getLang();
        const from = (parseLocalDate(this.csvFrom) || new Date()).getTime();
        const toD = parseLocalDate(this.csvTo) || new Date();
        const to = endOfLocalDayExclusive(toD).getTime();
        const label = `${formatDay(from, { lang })} – ${formatDay(toD, { lang })}`;
        const title = `${t('ui.statements.accountant')} · ${label}`;
        if (!this.covered(from)) return this.notLoaded(label, from);
        const sessions = this.sessions({ from, to });
        const rows = accountantLines(this.src(), { from, to }, { sessions: sessions.list });
        const bills = rows.filter(r => r.entry === 'bill').length;
        const ready = t('ui.statements.accountant_ready', { bills, payments: rows.length - bills });
        const html = `<h3 class="st-title">${esc(title)}</h3>${this.duesCaveat(sessions)}`
            + `<p>${esc(ready)}</p>`
            + `<p class="ins-hint">${esc(t('ui.statements.accountant_hint'))}</p>`;
        const blank = (v) => (v === null || v === undefined ? '' : v);
        const csvRows = rows.map(r => [isoMinute(r.t), r.entry, r.billType, r.billNo, r.party, blank(r.total), r.cash, r.online, blank(r.due), blank(r.payment)]);
        return { title, html, share: `${title}\n${ready}`, csvHeader: [...ACCOUNTANT_COLUMNS], csvRows, csvLang: 'en' };
    },

    // ---- share (owner only, confirmed, stamped and audited: services/exporter.js, #103)

    exportJob(format, produce) {
        const cur = this.current;
        return Exporter.run({
            kind: this.kind, format, period: { ...cur.period, label: format === 'csv' ? '' : cur.title }, rows: cur.csvRows.length,
            names: NAMED_KINDS.includes(this.kind), produce
        });
    },

    shareWhatsApp() {
        if (!this.current || !this.current.share) return Promise.resolve(false);
        return this.exportJob('whatsapp', (stamp) => {
            openExternal(`https://wa.me/?text=${encodeURIComponent(`${stamp.shop}\n${this.current.share}\n${stampLine(stamp)}`)}`);
        });
    },

    downloadCsv() {
        if (!this.current || !this.current.csvHeader.length) return Promise.resolve(false);
        const lang = this.current.csvLang || this.csvLang();
        return this.exportJob('csv', (stamp) => {
            const csv = stampedCsv(this.current.csvHeader, this.current.csvRows, stamp, lang);
            return Exporter.saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), exportFilename(stamp, this.kind, 'csv'), { shareFirst: false });
        });
    },

    print() {
        if (!this.current) return Promise.resolve(false);
        return this.exportJob('print', (stamp) => Exporter.printPage({
            title: this.current.title, html: this.current.html, stampText: stampLine(stamp), lang: getLang()
        }));
    }
};
