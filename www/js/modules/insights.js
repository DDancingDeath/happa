/**
 * @fileoverview Insights page (docs/insights-redesign.md §5.3): a short to-do
 * list, items, parties and seasons. Seasons hosts the Rate trends and Product
 * traffic views (the same module as Reports › Trends, moved here with mount()).
 * Every figure comes from utils/business-metrics.js; this module only renders.
 * @module modules/insights
 */

import { AppState } from '../utils/state.js';
import { Helpers } from '../utils/helpers.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { t, getLang } from '../i18n/index.js';
import { formatRupees } from '../utils/money.js';
import { formatMonth, formatDay } from '../utils/dates.js';
import { pickReplayBase } from '../utils/finance-calc.js';
import { historyLoadedFrom, isFullHistoryLoaded, ensureHistoryFrom } from '../utils/history-window.js';
import { findDeadStock } from '../utils/dead-stock.js';
import { can, canOpenSection } from '../utils/role-access.js';
import {
    moneySummary, periodRange, comparisonRanges, change, itemSummary, belowCostSales, lowProfitItems,
    purchaseItems, partySummary, stoppedComingCheck, overdueParties, seasonIndex, stockUpItems
} from '../utils/business-metrics.js';
import { insightsSettings } from '../utils/insights-config.js';
import { getInsightsContext, setInsightsContext, contextMonth } from '../utils/insights-context.js';
import { figuresFromSnapshot, monthKeyOf, monthKeysBetween, snapshotCustomers as customersOfSnapshot } from '../utils/month-snapshots.js';
import { MoneyManager } from './money.js';

const esc = (s) => Helpers.escapeHtml(String(s ?? ''));
const money = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : formatRupees(v));
const SECTIONS = ['actions', 'items', 'parties', 'seasons'];
const ROUTE_SECTION = { trends: ['seasons', 'trends'], traffic: ['seasons', 'traffic'] };
const DAY_MS = 86400000;

/** Display name of an item row in the chosen language. */
const nameOf = (r) => (getLang() === 'hi' ? r.itemHi || r.item : r.item) || t('ui.insights.bill_adjustments');

/**
 * kg sold (retail + wholesale) per item and 'YYYY-MM' from rateStats year docs (RT4).
 * @param {Array<{itemId: string, months: Object}>} docs
 * @returns {Map<string, Object<string, number>>}
 */
export function soldKgByMonth(docs) {
    const out = new Map();
    (docs || []).forEach(d => {
        if (!d || !d.itemId) return;
        const m = out.get(d.itemId) || {};
        Object.entries(d.months || {}).forEach(([k, b]) => {
            const key = String(k).replace(/^m/, '');
            if (!/^\d{4}-\d{2}$/.test(key)) return;
            m[key] = (m[key] || 0) + (Number(b?.retail?.kg) || 0) + (Number(b?.wholesale?.kg) || 0);
        });
        out.set(d.itemId, m);
    });
    return out;
}

/** Heat level 0–4 of a season index. */
export const heatLevel = (v) => (v === null || v === undefined ? 0 : v >= 1.5 ? 4 : v >= 1.15 ? 3 : v >= 0.85 ? 2 : 1);

export const InsightsManager = {
    section: 'actions',
    seasonView: 'calendar',
    itemsType: 'both',
    partyKind: 'sales',
    seasonDocs: null,
    seasonLoading: null,
    rateTrends: null,

    init(route) {
        const [section, view] = ROUTE_SECTION[route] || [route];
        if (SECTIONS.includes(section)) this.section = section;
        if (view) this.seasonView = view;
        if (this.section === 'seasons' && !this.maySeasons()) this.section = 'actions';
        this.setupTaps();
        const sel = document.getElementById('insightsPreset');
        const { preset } = getInsightsContext();
        if (sel) sel.value = /^month:/.test(preset) ? '' : preset;
        this.showSection();
        this.render();
        MoneyManager.loadSnapshots().then(() => { if (this.isOpen()) this.render(); })
            .catch(e => console.error('Insights: month snapshots failed:', e));
    },

    setSection(section) {
        if (!SECTIONS.includes(section)) return;
        if (section === 'seasons' && !this.maySeasons()) return;
        this.section = section;
        this.showSection();
        this.render();
    },

    setItemsType(type) {
        this.itemsType = ['both', 'retail', 'wholesale'].includes(type) ? type : 'both';
        this.render();
    },

    setPartyKind(kind) {
        this.partyKind = kind === 'purchases' ? 'purchases' : 'sales';
        this.render();
    },

    setSeasonView(view) {
        this.seasonView = ['calendar', 'trends', 'traffic'].includes(view) ? view : 'calendar';
        this.render();
    },

    setPreset(preset) {
        setInsightsContext({ preset });
        this.render();
    },

    step(dir) {
        const now = new Date();
        const r = this.range();
        const { preset } = getInsightsContext();
        if (/year$/.test(preset)) {
            setInsightsContext({ preset: dir < 0 ? 'last-year' : 'this-year' });
        } else {
            const from = Number.isFinite(r.from) ? new Date(r.from) : now;
            const target = new Date(from.getFullYear(), from.getMonth() + dir, 1);
            if (target > now) return;
            const key = monthKeyOf(target.getTime());
            setInsightsContext({ preset: key === monthKeyOf(now.getTime()) ? 'this-month' : `month:${key}` });
        }
        const sel = document.getElementById('insightsPreset');
        const p = getInsightsContext().preset;
        if (sel) sel.value = /^month:/.test(p) ? '' : p;
        this.render();
    },

    cfg() { return insightsSettings(AppState.settings?.insights); },

    /** Section permission (Roles & access), e.g. 'profit'. */
    may(permission) { return can(AppState.userRole, permission, AppState.settings?.roleAccess); },

    /** Seasons hosts Rate trends / Product traffic: their role rule applies. */
    maySeasons() { return canOpenSection('insights', 'seasons', AppState.userRole, AppState.settings?.roleAccess); },
    range() { return periodRange(getInsightsContext().preset, new Date(), this.cfg()); },

    showSection() {
        document.querySelectorAll('#insights [data-insights-pane]').forEach(el => { el.hidden = el.dataset.insightsPane !== this.section; });
        const mark = (sel, attr, value) => document.querySelectorAll(sel).forEach(b => {
            const on = b.dataset[attr] === value;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', String(on));
        });
        mark('#insights [data-insights-section]', 'insightsSection', this.section);
        document.querySelectorAll('#insights [data-insights-section="seasons"]').forEach(b => { b.hidden = !this.maySeasons(); });
        mark('#insights [data-items-type]', 'itemsType', this.itemsType);
        mark('#insights [data-party-kind]', 'partyKind', this.partyKind);
        mark('#insights [data-season-view]', 'seasonView', this.seasonView);
    },

    covered(from) {
        if (isFullHistoryLoaded()) return true;
        return Number.isFinite(from) && from >= historyLoadedFrom();
    },

    input(from) {
        return {
            purchases: AppState.purchaseHistory || [],
            wholesaleSales: AppState.salesHistory || [],
            retailSales: AppState.retailSalesHistory || [],
            stockAdjustments: AppState.stockAdjustments || [],
            expenses: AppState.expensesHistory || [],
            withdrawals: AppState.withdrawalsHistory || [],
            items: AppState.items || [],
            base: pickReplayBase({ checkpoint: FirebaseService.getStockCheckpointState?.() || null, fullHistory: isFullHistoryLoaded(), from })
        };
    },

    isOpen() {
        const el = document.getElementById('insights');
        return !!el && el.classList.contains('active');
    },

    render() {
        if (!document.getElementById('insights')) return;
        this.showSection();
        const r = this.range();
        const label = document.getElementById('insightsPeriodLabel');
        if (label) label.textContent = this.periodLabel(r);
        const ok = this.covered(r.from);
        const m = ok ? moneySummary(this.input(r.from), r, { detail: true }) : null;
        if (this.section === 'actions') this.renderActions(m, r);
        if (this.section === 'items') this.renderItems(m, r);
        if (this.section === 'parties') this.renderParties(r);
        if (this.section === 'seasons') this.renderSeasons(r);
        this.renderChecks(m);
    },

    periodLabel(r) {
        const lang = getLang();
        if (r.month) return formatMonth(r.from, { lang });
        const { preset } = getInsightsContext();
        if (preset === 'last-30') return t('ui.money.p_last_30');
        return String(new Date(r.from).getFullYear());
    },

    actionCard(icon, text, go, button, extra = '') {
        return `<div class="ins-action"><span class="ins-action-icon" aria-hidden="true">${icon}</span><div><div>${esc(text)}</div>`
            + `${extra}${go ? `<button type="button" class="btn btn-secondary" data-go="${esc(go)}">${esc(button)} ›</button>` : ''}</div></div>`;
    },

    renderActions(m) {
        const now = new Date();
        const cfg = this.cfg();
        const sales = [...(AppState.retailSalesHistory || []), ...(AppState.salesHistory || [])];
        const owed = overdueParties(sales, now, cfg);
        const owe = overdueParties(AppState.purchaseHistory || [], now, cfg);
        let dues = '';
        if (owed.parties > 0) dues += this.actionCard('⏰', t('ui.insights.act_overdue', { n: owed.parties, amount: formatRupees(owed.total), days: cfg.overdueDays }), 'due', t('ui.insights.open_outstanding'));
        if (owe.parties > 0) dues += this.actionCard('📤', t('ui.insights.act_you_owe', { n: owe.parties, amount: formatRupees(owe.total), days: cfg.overdueDays }), 'due', t('ui.insights.open_outstanding'));
        this.html('insightsActionsDues', dues);
        if (!m) {
            this.html('insightsActionsBelow', `<p class="ins-empty-text">${esc(t('ui.money.older_not_loaded', { period: this.periodLabel(this.range()) }))}</p>`);
            ['insightsActionsLow', 'insightsActionsStock'].forEach(id => this.html(id, ''));
        } else {
            // ₹ lost and ₹ per ₹100 are profit figures: not built for roles without 'profit'.
            const showProfit = this.may('profit');
            const below = showProfit ? belowCostSales(m).slice(0, 3) : [];
            this.html('insightsActionsBelow', below.map(b => this.actionCard('📉',
                t('ui.insights.act_below_cost', { item: nameOf(b), times: b.times, kg: b.qty, amount: formatRupees(b.lost) }), null, '',
                `<button type="button" class="btn btn-secondary" data-item="${esc(b.itemKey)}">${esc(t('ui.insights.see_trend'))} ›</button>`)).join(''));
            const low = showProfit ? lowProfitItems(itemSummary(m), cfg).slice(0, 3) : [];
            this.html('insightsActionsLow', low.map(x => this.actionCard('🪙',
                t(x.per100 < 0 ? 'ui.insights.act_loss_item' : 'ui.insights.act_low_profit', { item: nameOf(x), value: Math.round(x.per100 * 10) / 10, sales: formatRupees(x.sales) }),
                'insights-items', t('ui.insights.see_items'))).join(''));
            if (this.maySeasons()) this.renderStockUp();
            else this.html('insightsActionsStock', '');
        }
        const deadCount = this.deadStockCount(now);
        this.html('insightsActionsLinks',
            (deadCount > 0 ? this.actionCard('💤', t('ui.insights.act_dead_stock', { n: deadCount }), 'stock', t('ui.insights.open_stock')) : '')
            + this.actionCard('🔎', t('ui.insights.act_anomalies'), 'anomalies', t('ui.insights.open_anomalies')));
        const any = ['insightsActionsDues', 'insightsActionsBelow', 'insightsActionsLow', 'insightsActionsStock']
            .some(id => (document.getElementById(id)?.innerHTML || '').trim());
        if (!any) this.html('insightsActionsDues', `<div class="ins-ok">✓ ${esc(t('ui.insights.nothing_urgent'))}</div>`);
    },

    deadStockCount(now) {
        try {
            const rows = findDeadStock({
                stock: AppState.stock || {}, items: AppState.items || [],
                sources: { purchases: AppState.purchaseHistory, wholesaleSales: AppState.salesHistory, retailSales: AppState.retailSalesHistory },
                now: now.getTime(), minDays: 30, windowStart: isFullHistoryLoaded() ? 0 : historyLoadedFrom()
            });
            return rows.length;
        } catch (e) {
            console.warn('Insights: dead stock not worked out:', e);
            return 0;
        }
    },

    /** I9 needs the season calendar (rateStats); shown once it is loaded. */
    renderStockUp() {
        if (!this.seasonDocs) {
            this.loadSeasons().then(() => { if (this.isOpen() && this.section === 'actions') this.renderStockUp(); }).catch(() => {});
            this.html('insightsActionsStock', '');
            return;
        }
        const now = new Date();
        const weekly = this.weeklySoldKg(now);
        if (!weekly) { this.html('insightsActionsStock', ''); return; }
        const rows = this.seasonRows().map(r => {
            const st = AppState.stock?.[r.itemKey];
            return { ...r, qty: Number(st?.quantity) || 0, weeklyKg: weekly.get(r.itemKey) || 0 };
        });
        const list = stockUpItems(rows, now, {}, this.cfg()).slice(0, 3);
        const lang = getLang();
        this.html('insightsActionsStock', list.map(x => this.actionCard('🌾', t('ui.insights.act_stock_up', {
            item: x.name, month: formatMonth(new Date(now.getFullYear(), x.busyMonth, 1), { lang, year: false }), weeks: x.weeksToBusy, cover: Math.round(x.coverWeeks * 10) / 10
        }), null, '', `<button type="button" class="btn btn-secondary" data-item="${esc(x.itemKey)}">${esc(t('ui.insights.see_trend'))} ›</button>`)).join(''));
    },

    /**
     * kg sold per week over the last 8 weeks (or the weeks of bills loaded, if fewer),
     * per item key: one summary for all items. null under 2 loaded weeks.
     */
    weeklySoldKg(now) {
        const end = now.getTime();
        const from = Math.max(end - 56 * DAY_MS, isFullHistoryLoaded() ? -Infinity : historyLoadedFrom());
        const weeks = (end - from) / (7 * DAY_MS);
        if (!(weeks >= 2)) return null;
        const m = moneySummary(this.input(from), { from, to: end + 1 }, { detail: true });
        return new Map(itemSummary(m).map(r => [r.itemKey, r.qty / weeks]));
    },

    renderItems(m, r) {
        if (!m) {
            this.html('insightsItemsTable', `<tr><td>${esc(t('ui.money.older_not_loaded', { period: this.periodLabel(r) }))}</td></tr>`);
            return;
        }
        const rows = itemSummary(m, { type: this.itemsType });
        const ly = this.lastYearItems(r);
        const lyByKey = new Map((ly || []).map(x => [x.key, x]));
        const profitKnown = m.M2 !== null;
        const head = `<thead><tr><th>${esc(t('ui.insights.item'))}</th><th class="num">${esc(t('ui.money.sales'))}</th>`
            + `${profitKnown ? `<th class="num" data-perm="profit">${esc(t('ui.money.profit'))}</th><th class="num" data-perm="profit">${esc(t('ui.insights.per100'))}</th>` : ''}`
            + `<th class="num">${esc(t('ui.insights.vs_last_year'))}</th></tr></thead>`;
        const body = rows.map(x => {
            const c = change(x.sales, lyByKey.get(x.itemKey)?.sales ?? null);
            const cmp = c ? `${c.dir === 'up' ? '▲' : c.dir === 'down' ? '▼' : '＝'} ${Math.abs(c.pct)}%` : '—';
            return `<tr data-item="${esc(x.itemKey)}"><td>${esc(nameOf(x))}</td><td class="num">${money(x.sales)}</td>`
                + `${profitKnown ? `<td class="num" data-perm="profit">${money(x.profit)}</td><td class="num" data-perm="profit">${x.per100 === null ? '—' : Math.round(x.per100 * 10) / 10}</td>` : ''}`
                + `<td class="num">${esc(cmp)}</td></tr>`;
        }).join('');
        this.html('insightsItemsTable', rows.length ? head + `<tbody>${body}</tbody>` : `<tr><td>${esc(t('ui.insights.no_sales'))}</td></tr>`);
        const known = rows.filter(x => x.itemKey && x.profit !== null);
        const best = known.slice().sort((a, b) => b.profit - a.profit)[0];
        const weak = known.filter(x => x.sales >= this.cfg().lowMarginMinSales).sort((a, b) => a.per100 - b.per100)[0];
        let tk = '';
        if (best) tk += `<p data-perm="profit">${esc(t('ui.insights.tk_best_item', { item: nameOf(best), amount: formatRupees(best.profit) }))}</p>`;
        if (weak && weak !== best) tk += `<p data-perm="profit">${esc(t('ui.insights.tk_weak_item', { item: nameOf(weak), value: Math.round(weak.per100 * 10) / 10 }))}</p>`;
        if (!profitKnown) tk += `<p>${esc(t('ui.tk.profit_unknown'))}</p>`;
        this.html('insightsItemsTakeaway', tk);
        const unc = m.caveats.find(c => c.key === 'uncosted');
        this.html('insightsItemsCaveats', unc ? `<div class="ins-caveat">⚠ ${esc(t('ui.money.caveat_uncosted', { qty: unc.qty, amount: Math.round(unc.estimate) }))}</div>` : '');
        const total = m.M1.total || 0;
        const pct = (v) => (total ? Math.round((v / total) * 100) : 0);
        this.html('insightsSplit', `<div class="ins-row"><span>${esc(t('ui.insights.retail'))}</span><span>${money(m.M1.retail.total)} · ${pct(m.M1.retail.total)}%</span></div>`
            + `<div class="ins-row"><span>${esc(t('ui.insights.wholesale'))}</span><span>${money(m.M1.wholesale.total)} · ${pct(m.M1.wholesale.total)}%</span></div>`);
        const bought = purchaseItems(AppState.purchaseHistory || [], AppState.items || [], r);
        const paid = this.may('purchaseRates');
        this.html('insightsBoughtTable', bought.length
            ? `<thead><tr><th>${esc(t('ui.insights.item'))}</th><th class="num">${esc(t('ui.insights.kg'))}</th>${paid ? `<th class="num" data-perm="purchaseRates">${esc(t('ui.insights.paid'))}</th>` : ''}</tr></thead><tbody>`
                + bought.map(x => `<tr data-item="${esc(x.itemKey)}"><td>${esc(nameOf(x))}</td><td class="num">${Math.round(x.qty)}</td>${paid ? `<td class="num" data-perm="purchaseRates">${money(x.amount)}</td>` : ''}</tr>`).join('') + '</tbody>'
            : `<tr><td>${esc(t('ui.insights.no_purchases'))}</td></tr>`);
    },

    /** Item rows of the same period last year: computed when loaded, else from snapshots (whole months). */
    lastYearItems(r) {
        const ly = comparisonRanges(r).lastYear;
        if (!ly) return null;
        if (this.covered(ly.from)) {
            return itemSummary(moneySummary(this.input(ly.from), ly, { detail: true })).map(x => ({ key: x.itemKey, sales: x.sales }));
        }
        const snaps = MoneyManager.snapshots || {};
        const keys = monthKeysBetween(ly.from, ly.to);
        // Snapshots keep items per whole month only: a part period (e.g. 1–3 Oct) has no fair comparison.
        const whole = (ms) => { const d = new Date(ms); return d.getDate() === 1 && d.getHours() === 0 && d.getMinutes() === 0; };
        if (!whole(r.from) || !whole(r.to) || !whole(ly.from) || !whole(ly.to)) return null;
        const docs = keys.map(k => figuresFromSnapshot(snaps[k]));
        if (!docs.length || docs.some(d => !d)) return null;
        const out = new Map();
        docs.forEach(d => d.items.forEach(x => out.set(x.key, { key: x.key, sales: (out.get(x.key)?.sales || 0) + x.sales })));
        return [...out.values()];
    },

    renderParties(r) {
        const src = { purchases: AppState.purchaseHistory || [], wholesaleSales: AppState.salesHistory || [], retailSales: AppState.retailSalesHistory || [] };
        if (!this.covered(r.from)) {
            this.html('insightsPartiesTakeaway', `<p>${esc(t('ui.money.older_not_loaded', { period: this.periodLabel(r) }))}</p>`);
            ['insightsCustomersTable', 'insightsSuppliersTable', 'insightsStopped'].forEach(id => this.html(id, ''));
            return;
        }
        const kind = this.partyKind;
        const rows = partySummary(src, kind, r);
        const lang = getLang();
        const table = (list) => (list.length
            ? `<thead><tr><th>${esc(t('ui.insights.party'))}</th><th class="num">${esc(t(kind === 'sales' ? 'ui.money.sales' : 'ui.insights.paid'))}</th><th class="num">${esc(t('ui.insights.bills'))}</th><th class="num">${esc(t('ui.insights.last_bill'))}</th></tr></thead><tbody>`
                + list.map(p => `<tr data-party="${esc(p.key)}"><td>${esc(p.name || t('ui.insights.walk_in'))}</td><td class="num">${money(p.total)}</td><td class="num">${p.count}</td><td class="num">${esc(p.last ? formatDay(p.last, { lang, year: false }) : '—')}</td></tr>`).join('') + '</tbody>'
            : `<tr><td>${esc(t('ui.insights.no_parties'))}</td></tr>`);
        const cust = document.getElementById('insightsCustomersTable');
        const sup = document.getElementById('insightsSuppliersTable');
        if (cust) cust.hidden = kind !== 'sales';
        if (sup) sup.hidden = kind !== 'purchases';
        this.html(kind === 'sales' ? 'insightsCustomersTable' : 'insightsSuppliersTable', table(rows));
        const total = rows.reduce((a, p) => a + p.total, 0);
        const top5 = rows.filter(p => p.key).slice(0, 5).reduce((a, p) => a + p.total, 0);
        const lyCheck = kind === 'sales' ? this.stoppedCheck(src, new Date()) : { list: [], known: true };
        const stopped = lyCheck.list;
        let tk = total > 0 ? `<p>${esc(t(kind === 'sales' ? 'ui.insights.tk_top5_customers' : 'ui.insights.tk_top5_suppliers', { pct: Math.round((top5 / total) * 100) }))}</p>` : '';
        if (stopped.length) tk += `<p>${esc(t('ui.insights.tk_stopped', { n: stopped.length, days: this.cfg().stoppedComingDays }))}</p>`;
        this.html('insightsPartiesTakeaway', tk);
        const card = document.getElementById('insightsStoppedCard');
        if (card) card.hidden = kind !== 'sales';
        let stoppedHtml;
        if (!lyCheck.known) {
            stoppedHtml = `<div class="ins-caveat">⚠ ${esc(t('ui.insights.stopped_unknown'))}</div>`
                + `<button type="button" class="btn btn-secondary" onclick="window.app.insights.loadOlder()">${esc(t('ui.money.load_older'))}</button>`;
        } else if (stopped.length) {
            stoppedHtml = stopped.slice(0, 20).map(p => `<div class="ins-row"><span>${esc(p.name)}</span><span>${esc(p.last
                ? t('ui.insights.last_on', { date: formatDay(p.last, { lang }) })
                : t('ui.insights.last_before', { date: formatDay(historyLoadedFrom(), { lang }) }))}</span></div>`).join('');
        } else {
            stoppedHtml = `<p class="ins-empty-text">${esc(t('ui.insights.none_stopped'))}</p>`;
        }
        this.html('insightsStopped', stoppedHtml);
    },

    /** I4 using the loaded bills and, for months not loaded, last year's month snapshots. */
    stoppedCheck(src, now) {
        const snaps = MoneyManager.snapshots || {};
        const snapshotCustomers = {};
        Object.entries(snaps).forEach(([k, doc]) => { if (doc) snapshotCustomers[k] = customersOfSnapshot(doc); });
        return stoppedComingCheck(src, now, this.cfg(), {
            loadedFrom: isFullHistoryLoaded() ? 0 : historyLoadedFrom(),
            snapshotCustomers
        });
    },

    async loadOlder() {
        const now = new Date();
        try {
            await ensureHistoryFrom(new Date(now.getFullYear() - 1, now.getMonth() - 1, 1));
        } catch (e) {
            console.error('Insights: loading older bills failed:', e);
        }
        this.render();
    },

    // ---- seasons

    async loadSeasons() {
        if (this.seasonDocs) return this.seasonDocs;
        if (this.seasonLoading) return this.seasonLoading;
        this.seasonLoading = (async () => {
            const RT = await this.loadRateTrends();
            await RT.loadMeta();
            const y = new Date().getFullYear();
            const years = [String(y - 2), String(y - 1), String(y)];
            const all = [];
            for (const year of years) {
                const res = await RT.yearStats(year);
                all.push(...(res.docs || []));
            }
            this.seasonDocs = all;
            return all;
        })().finally(() => { this.seasonLoading = null; });
        return this.seasonLoading;
    },

    async loadRateTrends() {
        if (!this.rateTrends) this.rateTrends = (await import('./rate-trends.js')).RateTrendsManager;
        return this.rateTrends;
    },

    /** Items with a season index, most kg first. */
    seasonRows() {
        const byItem = soldKgByMonth(this.seasonDocs || []);
        const items = new Map((AppState.items || []).map(i => [i.id, i]));
        const lang = getLang();
        return [...byItem.entries()].map(([itemKey, kg]) => {
            const it = items.get(itemKey);
            const total = Object.values(kg).reduce((a, b) => a + b, 0);
            const name = it ? (lang === 'hi' ? it.hindiName || it.name : it.name) : itemKey;
            return { itemKey, name, total, index: seasonIndex(kg) };
        }).filter(r => r.index && r.total > 0).sort((a, b) => b.total - a.total);
    },

    renderSeasons(r) {
        const cal = document.getElementById('insightsCalendarCard');
        const host = document.getElementById('insightsTrendsHost');
        if (this.seasonView !== 'calendar') {
            if (cal) cal.hidden = true;
            const { itemId } = getInsightsContext();
            this.loadRateTrends().then(RT => RT.mount(host, {
                section: this.seasonView === 'traffic' ? 'traffic' : 'rates',
                itemId,
                month: contextMonth(getInsightsContext().preset)
            })).catch(e => console.warn('Insights: rate trends not loaded:', e?.message || e));
            return;
        }
        if (cal) cal.hidden = false;
        // The Rate trends view goes back to its own page while the calendar shows.
        if (this.rateTrends) this.rateTrends.home();
        if (!this.seasonDocs) {
            this.html('insightsCalendar', `<p class="ins-empty-text">${esc(t('ui.insights.loading_seasons'))}</p>`);
            this.loadSeasons().then(() => { if (this.isOpen() && this.section === 'seasons') this.renderSeasons(r); })
                .catch(e => {
                    console.warn('Insights: seasons not loaded:', e?.message || e);
                    this.html('insightsCalendar', `<p class="ins-empty-text">${esc(t('ui.insights.seasons_unavailable'))}</p>`);
                });
            return;
        }
        const rows = this.seasonRows().slice(0, 15);
        if (!rows.length) {
            this.html('insightsCalendar', `<p class="ins-empty-text">${esc(t('ui.insights.seasons_need_year'))}</p>`);
            this.html('insightsSeasonTakeaway', '');
            return;
        }
        const lang = getLang();
        const months = Array.from({ length: 12 }, (_, i) => formatMonth(new Date(2000, i, 1), { lang, year: false }));
        const now = new Date();
        const head = `<thead><tr><th></th>${months.map((m, i) => `<th${i === now.getMonth() ? ' class="ins-now"' : ''}>${esc(m.slice(0, 3))}</th>`).join('')}</tr></thead>`;
        const body = rows.map(x => `<tr><th scope="row">${esc(x.name)}</th>${x.index.map((v, i) => `<td class="h${heatLevel(v)}" data-item="${esc(x.itemKey)}" data-cal-month="${i}" title="${esc(`${x.name} · ${months[i]}: ${v === null ? '—' : `${v}×`}`)}"></td>`).join('')}</tr>`).join('');
        this.html('insightsCalendar', `<table class="ins-heat">${head}<tbody>${body}</tbody></table>`);
        const next = [1, 2].map(k => new Date(now.getFullYear(), now.getMonth() + k, 1).getMonth());
        const busy = rows.map(x => ({ x, v: Math.max(...next.map(m => x.index[m] ?? 0)), m: next.find(m => (x.index[m] ?? 0) === Math.max(...next.map(mm => x.index[mm] ?? 0))) }))
            .filter(b => b.v >= this.cfg().seasonBusy).sort((a, b) => b.v - a.v)[0];
        this.html('insightsSeasonTakeaway', busy
            ? `<p>${esc(t('ui.insights.tk_season', { item: busy.x.name, times: Math.round(busy.v * 10) / 10, month: months[busy.m] }))}</p>`
            : `<p>${esc(t('ui.insights.tk_no_season'))}</p>`);
    },

    renderChecks(m) {
        if (!m) { this.html('insightsChecks', ''); return; }
        const items = itemSummary(m);
        const parties = partySummary({ purchases: AppState.purchaseHistory, wholesaleSales: AppState.salesHistory, retailSales: AppState.retailSalesHistory }, 'sales', m.range);
        const ok = Math.abs(items.reduce((a, x) => a + x.sales, 0) - m.M1.total) <= 1 && Math.abs(parties.reduce((a, x) => a + x.total, 0) - m.M1.total) <= 1;
        this.html('insightsChecks', `<button type="button" class="ins-checkline ${ok ? 'ok' : 'warn'}" data-go="diagnostics">${ok ? '✓' : '⚠'} ${esc(t(ok ? 'ui.insights.checks_ok' : 'ui.money.checks_warn'))}</button>`);
    },

    setupTaps() {
        const page = document.getElementById('insights');
        if (!page || page.dataset.taps) return;
        page.dataset.taps = '1';
        page.addEventListener('click', (e) => {
            const go = e.target.closest('[data-go]');
            if (go) { e.preventDefault(); window.app?.nav?.showTab(go.dataset.go); return; }
            const cell = e.target.closest('[data-cal-month]');
            if (cell) {
                const now = new Date();
                const m = Number(cell.dataset.calMonth);
                const y = m > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear();
                const key = `${y}-${String(m + 1).padStart(2, '0')}`;
                setInsightsContext({ itemId: cell.dataset.item, preset: key === monthKeyOf(now.getTime()) ? 'this-month' : `month:${key}` });
                this.seasonView = 'traffic';
                this.section = 'seasons';
                this.render();
                return;
            }
            const party = e.target.closest('[data-party]');
            if (party && party.dataset.party && window.app?.statements) {
                Promise.resolve(window.app.statements.selectParty(party.dataset.party, this.partyKind === 'purchases' ? 'supplier' : 'customer'))
                    .then(() => window.app.nav.showTab('statements-party'))
                    .catch(err => console.warn('Insights: party ledger not opened:', err?.message || err));
                return;
            }
            const item = e.target.closest('[data-item]');
            if (item && item.dataset.item) {
                setInsightsContext({ itemId: item.dataset.item });
                this.section = 'seasons';
                this.seasonView = 'trends';
                this.render();
            }
        });
    },

    html(id, value) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = value;
    }
};
