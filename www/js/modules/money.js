/**
 * @fileoverview Money page (docs/insights-redesign.md §5.2): profit, cash,
 * spending and worth for one period, each with "vs previous" and "vs last
 * year", a plain takeaway and "tap any number to see what makes it up".
 * Every figure comes from utils/business-metrics.js; this module only reads
 * AppState, month snapshots and cash sessions, and renders.
 * @module modules/money
 */

import { AppState } from '../utils/state.js';
import { Helpers } from '../utils/helpers.js';
import { SAVED_ON_PHONE_KEY } from '../utils/storage-full.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
import { UIManager } from '../ui/ui-manager.js';
import { FinanceBreakdownSheet } from '../ui/finance-breakdown-sheet.js';
import { t, tn, getLang } from '../i18n/index.js';
import { formatRupees, formatAmount, normalizeLabourSettings } from '../utils/money.js';
import { labourSummary, labourToPayByDay, labourCalcText, periodLabourGap } from '../utils/labour.js';
import { formatMonth, formatDay, toLocalISODate, parseAnyBillDate, monthStart, addLocalDays, periodBounds, localDayKeys, endUpToNow } from '../utils/dates.js';
import { pickReplayBase, billsInRange } from '../utils/finance-calc.js';
import { historyLoadedFrom, isFullHistoryLoaded, ensureHistoryFrom, refreshOnDemandHistory } from '../utils/history-window.js';
import { lastCountedSession } from '../utils/cash-session.js';
import { refusedForClock } from '../utils/clock-skew.js';
import {
    moneySummary, periodRange, comparisonRanges, change, outstandingTotals, netWorth,
    itemSummary, biggestChange, profitPerDay, billTime, roundTo, sharePct, addsUp, netMoneyByDay,
    accountsTotal
} from '../utils/business-metrics.js';
import { insightsSettings } from '../utils/insights-config.js';
import { getInsightsContext, setInsightsContext } from '../utils/insights-context.js';
import {
    buildSnapshot, figuresFromSnapshot, rangeFigures, monthsToRoll, monthBounds,
    monthKeysBetween, lastMonthKeys, monthKeyOf, snapshotsFrom, staleToRebuild
} from '../utils/month-snapshots.js';
import { profitTakeaways, cashTakeaways, spendingTakeaways, worthTakeaways } from '../utils/takeaways.js';
import { can } from '../utils/role-access.js';
import { dataSignature } from '../utils/render-memo.js';

const esc = (s) => Helpers.escapeHtml(String(s ?? ''));
const money = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : formatRupees(v));
const SECTIONS = ['profit', 'cash', 'spending', 'worth'];
const SESSION_TTL_MS = 10 * 60 * 1000;
const ACCOUNTS_KEY = 'financeCustomAccounts';
const listIds = new WeakMap();
let nextListId = 1;
const listId = (list) => {
    if (!Array.isArray(list) || !list.length) return 0;
    if (!listIds.has(list)) listIds.set(list, nextListId++);
    return listIds.get(list);
};

/** True when a route's page is in the app (a link to a page not shipped yet is hidden). */
export function routeAvailable(link) {
    if (typeof document === 'undefined' || !link) return false;
    return !!(document.getElementById(link) || document.getElementById(String(link).split('-')[0]));
}

const TAKEAWAY_RUPEES = ['amount', 'taken', 'kept'];

/** Takeaway params with the ₹ amounts grouped like the cards ("4,927"). */
export function takeawayParams(params) {
    if (!params) return params;
    const out = { ...params };
    TAKEAWAY_RUPEES.forEach(k => { if (typeof out[k] === 'number') out[k] = formatAmount(out[k]); });
    return out;
}

/** Renders takeaways as escaped sentences; a link becomes a small button. */
export function takeawayHtml(list) {
    return (list || []).map(x => {
        const text = esc(t(x.key, takeawayParams(x.params)));
        const link = x.link && routeAvailable(x.link) ? ` <button type="button" class="ins-link" data-go="${esc(x.link)}">${esc(t('ui.money.open'))} ›</button>` : '';
        return `<p>${text}${link}</p>`;
    }).join('');
}

/**
 * "▲ 12% vs Sep · ▼ 3% vs Oct 2025" (arrows and words, not only colour). A comparison whose other
 * figure is not known (bills not loaded, no month snapshot, a stale one) is said: "vs Oct 2025: not known".
 * @param {Array<{c: ?Object, label: string, unknown?: boolean, unknownText?: string}>} items
 */
export function compareHtml(items) {
    const parts = (items || []).filter(x => x && (x.c || x.unknown)).map(({ c, label, unknownText }) => {
        if (!c) return `<span class="ins-cmp ins-cmp-none">${esc(unknownText || t('ui.money.vs_not_known', { when: label }))}</span>`;
        const arrow = c.dir === 'up' ? '▲' : c.dir === 'down' ? '▼' : '＝';
        const text = c.dir === 'same' ? t('ui.money.same_as', { when: label }) : t('ui.money.pct_vs', { pct: Math.abs(c.pct), when: label });
        return `<span class="ins-cmp ins-cmp-${c.dir}">${arrow} ${esc(text)}</span>`;
    });
    return parts.length ? parts.join('<span class="ins-dot"> · </span>') : `<span class="ins-cmp ins-cmp-none">${esc(t('ui.money.no_comparison'))}</span>`;
}

/** One compareHtml item: the change from `then`, or "not known" when `then` is missing. */
export function vsItem(now, then, label) {
    return { c: change(now, then), label, unknown: !Number.isFinite(then) };
}

/** Simple inline-SVG bars; `faint` is an optional second series (last year). */
export function barsSvg(values, { faint = null, labels = [], height = 120, onTap = 'data-day' } = {}) {
    const n = values.length;
    if (!n) return '';
    const all = [...values, ...(faint || [])].filter(v => Number.isFinite(v));
    const max = Math.max(1, ...all.map(Math.abs));
    const hasNeg = all.some(v => v < 0);
    const zero = hasNeg ? height / 2 : height - 14;
    const scale = (hasNeg ? height / 2 - 4 : height - 18) / max;
    const w = 100 / n;
    const bars = values.map((v, i) => {
        if (!Number.isFinite(v)) return '';
        const h = Math.max(1, Math.abs(v) * scale);
        const y = v >= 0 ? zero - h : zero;
        const tag = labels[i] ? ` ${onTap}="${esc(labels[i].key || '')}"` : '';
        return `<rect class="ins-bar ${v < 0 ? 'neg' : ''}" x="${(i * w + w * 0.15).toFixed(2)}%" y="${y.toFixed(1)}" width="${(w * 0.7).toFixed(2)}%" height="${h.toFixed(1)}"${tag}><title>${esc(labels[i]?.title || '')}</title></rect>`;
    }).join('');
    let line = '';
    if (faint && faint.some(Number.isFinite)) {
        const pts = faint.map((v, i) => (Number.isFinite(v) ? `${((i + 0.5) * w).toFixed(2)},${(zero - v * scale).toFixed(1)}` : null)).filter(Boolean);
        line = `<svg width="100%" height="${height}" viewBox="0 0 100 ${height}" preserveAspectRatio="none">`
            + `<polyline class="ins-faint" points="${pts.join(' ')}" vector-effect="non-scaling-stroke"/></svg>`;
    }
    const ticks = labels.map((l, i) => (l && l.tick ? `<text x="${((i + 0.5) * w).toFixed(2)}%" y="${height - 2}" class="ins-tick">${esc(l.tick)}</text>` : '')).join('');
    // Only the last-year line is stretched; bars and labels use % / px so the text keeps its shape.
    return `<svg class="ins-svg" width="100%" height="${height}" role="img" style="height:${height}px">`
        + `<line class="ins-axis" x1="0" x2="100%" y1="${zero}" y2="${zero}"/>${bars}${line}${ticks}</svg>`;
}

export const MoneyManager = {
    section: 'profit',
    snapshots: {},
    snapshotsLoaded: false,
    staleSeen: {},
    sessionCache: new Map(),
    building: false,
    lastSummary: null,
    summaryCache: { sig: null, map: new Map(), computed: 0 },

    /** Opens the page (from the side menu or a route like money-cash). */
    init(section) {
        if (section && SECTIONS.includes(section)) this.section = section;
        this.setupTaps();
        const sel = document.getElementById('moneyPreset');
        const { preset } = getInsightsContext();
        if (sel) sel.value = /^month:/.test(preset) ? 'this-month' : preset;
        this.showSection(this.section);
        this.render();
        this.loadSnapshots().catch(e => console.error('Money: month snapshots failed:', e));
    },

    setSection(section) {
        if (!SECTIONS.includes(section)) return;
        this.section = section;
        this.showSection(section);
        this.render();
    },

    showSection(section) {
        document.querySelectorAll('#money [data-money-pane]').forEach(el => { el.hidden = el.dataset.moneyPane !== section; });
        document.querySelectorAll('#money [data-money-section]').forEach(b => {
            const on = b.dataset.moneySection === section;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', String(on));
        });
    },

    setPreset(preset) {
        setInsightsContext({ preset });
        this.render();
    },

    /** ‹ / ›: one month (month periods) or one year (year periods) back / forward. */
    step(dir) {
        const now = new Date();
        const r = this.range();
        const { preset } = getInsightsContext();
        if (/year$/.test(preset)) {
            setInsightsContext({ preset: preset === 'this-year' ? (dir < 0 ? 'last-year' : 'this-year') : (dir > 0 ? 'this-year' : 'last-year') });
        } else {
            const from = Number.isFinite(r.from) ? new Date(r.from) : now;
            const target = monthStart(from, dir);
            if (target > now) return;
            const key = monthKeyOf(target.getTime());
            setInsightsContext({ preset: key === monthKeyOf(now.getTime()) ? 'this-month' : `month:${key}` });
        }
        const sel = document.getElementById('moneyPreset');
        const p = getInsightsContext().preset;
        if (sel) sel.value = /^month:/.test(p) ? '' : p;
        this.render();
    },

    cfg() {
        return insightsSettings(AppState.settings?.insights);
    },

    can(permission) {
        return can(AppState.userRole, permission, AppState.settings?.roleAccess);
    },

    range() {
        return periodRange(getInsightsContext().preset, new Date(), this.cfg());
    },

    periodLabel(r = this.range()) {
        const lang = getLang();
        const { preset } = getInsightsContext();
        if (r.month) {
            const label = formatMonth(r.from, { lang });
            if (preset !== 'this-month') return label;
            const day = new Date().getDate();
            return day === 1 ? formatDay(r.from, { lang }) : t('ui.money.month_to_date', { month: label, day });
        }
        if (preset === 'last-30') return t('ui.money.p_last_30');
        if (/year$/.test(preset)) return String(new Date(r.from).getFullYear());
        return t('ui.money.p_all');
    },

    /** Bills, expenses… as the calculation layer wants them. */
    input(from, sessions = []) {
        const base = pickReplayBase({
            checkpoint: FirebaseService.getStockCheckpointState?.() || null,
            fullHistory: isFullHistoryLoaded(),
            from
        });
        return {
            purchases: AppState.purchaseHistory || [],
            wholesaleSales: AppState.salesHistory || [],
            retailSales: AppState.retailSalesHistory || [],
            stockAdjustments: AppState.stockAdjustments || [],
            expenses: AppState.expensesHistory || [],
            withdrawals: AppState.withdrawalsHistory || [],
            items: AppState.items || [],
            sessions: sessions.list || [],
            duesComplete: sessions.complete !== false,
            base
        };
    },

    /** Loaded bills cover [from, …)? */
    covered(from) {
        if (isFullHistoryLoaded()) return true;
        return Number.isFinite(from) && from >= historyLoadedFrom();
    },

    /**
     * Cash sessions for a range (their due-payment legs count payments on bills no longer loaded).
     * `onLoad` runs when a pending load settles (Statements re-renders with them).
     */
    sessions({ from, to }, onLoad = null) {
        if (isFullHistoryLoaded()) return { list: [], complete: true };
        const end = Math.min(to, Date.now());
        if (!Number.isFinite(from) || end - from > 62 * 86400000) return { list: [], complete: false };
        const { first, last } = periodBounds(from, end);
        const key = `${first}|${last}`;
        const hit = this.sessionCache.get(key);
        if (hit && hit.list && Date.now() - hit.at < SESSION_TTL_MS) return { list: hit.list, complete: true };
        if (!hit || (!hit.pending && Date.now() - hit.at >= SESSION_TTL_MS)) {
            const [a, b] = key.split('|');
            const waiters = new Set();
            this.sessionCache.set(key, { pending: true, at: Date.now(), list: hit?.list || null, waiters });
            const settle = () => waiters.forEach(fn => {
                try { fn(); } catch (e) { console.error('Money: sessions listener failed:', e); }
            });
            Promise.resolve(FirebaseService.loadCashSessionsBetween?.(a, b)).then(list => {
                this.sessionCache.set(key, { pending: false, at: Date.now(), list: list || [] });
                if (this.isOpen()) this.render();
                settle();
            }).catch(e => {
                console.error('Money: loading cash sessions failed:', e);
                this.sessionCache.set(key, { pending: false, at: Date.now(), list: null });
                settle();
            });
        }
        if (onLoad) this.sessionCache.get(key)?.waiters?.add(onLoad);
        return { list: hit?.list || [], complete: false };
    },

    isOpen() {
        const el = document.getElementById('money');
        return !!el && el.classList.contains('active');
    },

    /**
     * M15 drawer term: the last 30 days of cash sessions, always fetched on
     * their own (sessions() returns none once full history is loaded, because
     * its due legs are then on the bills; the drawer balance is not).
     */
    drawerSessions(now = new Date()) {
        const a = toLocalISODate(addLocalDays(now, -30));
        const b = toLocalISODate(now);
        const key = `${a}|${b}`;
        const hit = this.drawerCache;
        const fresh = hit && hit.key === key && Date.now() - hit.at < SESSION_TTL_MS;
        if (!fresh && !(hit && hit.pending && hit.key === key)) {
            this.drawerCache = { key, pending: true, at: Date.now(), list: hit?.list || [] };
            Promise.resolve(FirebaseService.loadCashSessionsBetween?.(a, b)).then(list => {
                this.drawerCache = { key, pending: false, at: Date.now(), list: list || [] };
                if (this.isOpen()) this.render();
            }).catch(e => {
                console.error('Money: loading drawer sessions failed:', e);
                this.drawerCache = { key, pending: false, at: Date.now(), list: hit?.list || [] };
            });
        }
        return this.drawerCache?.list || [];
    },

    /**
     * moneySummary for a range, kept until the data changes (AppState.dataVersion,
     * the loaded arrays and history window; render-memo's dataSignature), so a tab
     * switch or a re-render reuses every period it has already worked out.
     */
    summary(r, { sessions = null, detail = false } = {}) {
        const sig = dataSignature();
        if (this.summaryCache.sig !== sig) this.summaryCache = { sig, map: new Map(), computed: this.summaryCache.computed };
        const s = sessions || { list: [], complete: true };
        const key = (d) => `${r.from}|${r.to}|${d ? 1 : 0}|${listId(s.list)}|${s.complete !== false}`;
        const map = this.summaryCache.map;
        const hit = map.get(key(true)) || (!detail && map.get(key(false)));
        if (hit) return hit;
        const m = moneySummary(this.input(r.from, s), r, { detail });
        this.summaryCache.computed += 1;
        map.set(key(detail), m);
        return m;
    },

    /** Figures for a comparison range: computed when loaded, else from month snapshots. */
    figuresFor(r, now = new Date()) {
        if (!r) return null;
        if (this.covered(r.from)) {
            const m = this.summary(r);
            return { M1: m.M1.total, M4: m.M4.total, M6: m.M6.total, M14: m.M14, M16: m.M16.total, computed: true };
        }
        return rangeFigures(this.snapshots, r.from, r.to);
    },

    /** Renders the open section. */
    render() {
        const page = document.getElementById('money');
        if (!page) return;
        const now = new Date();
        const r = this.range();
        const label = document.getElementById('moneyPeriodLabel');
        if (label) label.textContent = this.periodLabel(r);
        if (!this.covered(r.from)) {
            this.renderNotLoaded(r);
            return;
        }
        this.showBody(true);
        const sessions = this.sessions(r);
        const m = this.summary(r, { sessions, detail: true });
        this.lastSummary = m;
        const cmpR = comparisonRanges(r);
        const prev = this.figuresFor(cmpR.previous, now);
        const ly = this.figuresFor(cmpR.lastYear, now);
        const lang = getLang();
        const labels = {
            prev: r.month ? formatMonth(cmpR.previous?.from, { lang, year: false }) : t('ui.money.before'),
            ly: r.month ? formatMonth(cmpR.lastYear?.from, { lang }) : t('ui.money.last_year')
        };
        const ctx = { m, prev, ly, labels, r, now, cfg: this.cfg() };
        this.renderProfit(ctx);
        if (this.section === 'cash') this.renderCash(ctx);
        if (this.section === 'spending') this.renderSpending(ctx);
        if (this.section === 'worth') this.renderWorth(ctx);
        this.renderChecks(ctx);
    },

    /** Shows the figures, or hides all of them behind the "not loaded" message. */
    showBody(show) {
        const body = document.getElementById('moneyBody');
        if (body) body.hidden = !show;
        const box = document.getElementById('moneyNotLoaded');
        if (box) {
            box.hidden = show;
            if (show) box.innerHTML = '';
        }
    },

    renderNotLoaded(r) {
        this.showBody(false);
        this.lastSummary = null;
        this.html('moneyNotLoaded', `<div class="ins-empty"><p>${esc(t('ui.money.older_not_loaded', { period: this.periodLabel(r) }))}</p>`
            + `<button type="button" class="btn btn-primary" onclick="window.app.money.loadOlder()">${esc(t('ui.money.load_older'))}</button></div>`);
        this.html('moneyChecks', '');
    },

    async loadOlder() {
        const r = this.range();
        try {
            const ok = await ensureHistoryFrom(Number.isFinite(r.from) ? new Date(r.from) : null);
            if (!ok) UIManager.showToast(t('msg.money.could_not_load'));
        } catch (e) {
            console.error('Money: loading older bills failed:', e);
            UIManager.showToast(t('msg.money.could_not_load'));
        }
        this.render();
    },

    caveatsHtml(m, ids) {
        const list = (m.caveats || []).filter(c => c.ids.some(id => ids.includes(id)));
        return list.map(c => {
            const params = { qty: c.qty, amount: formatAmount(c.estimate ?? c.amount ?? c.gap ?? 0) };
            return `<div class="ins-caveat">⚠ ${esc(t(`ui.money.caveat_${c.key}`, params))}</div>`;
        }).join('');
    },

    renderProfit({ m, prev, ly, labels, r, now }) {
        const vsPrev = change(m.M6.total, prev?.M6 ?? null);
        const vsLy = change(m.M6.total, ly?.M6 ?? null);
        this.text('moneyProfitValue', money(m.M6.total));
        this.html('moneyProfitCompare', compareHtml([vsItem(m.M6.total, prev?.M6, labels.prev), vsItem(m.M6.total, ly?.M6, labels.ly)]));
        const onProfit = this.section === 'profit';
        const driverRows = onProfit ? this.itemDriver(m, r) : null;
        this.html('moneyProfitTakeaway', takeawayHtml(profitTakeaways({
            profit: m.M6.total, vsLastYear: vsLy, vsPrevious: vsPrev, lastYearLabel: labels.ly, previousLabel: labels.prev,
            driver: driverRows, uncosted: m.caveats.find(c => c.key === 'uncosted') || null,
            salesVsLastYear: change(m.M1.total, ly?.M1 ?? null)
        })));
        this.html('moneyProfitCaveats', this.caveatsHtml(m, ['M2', 'M6']));
        this.text('moneySales', money(m.M1.total));
        const splitLink = routeAvailable('insights-items')
            ? ` <button type="button" class="ins-link" data-go="insights-items" data-metric-ref="I2">${esc(t('ui.money.split_link'))} ›</button>` : '';
        this.html('moneySalesSplit', `<span data-metric-ref="M1">${esc(tn('ui.money.bills', m.M1.count))}</span>${splitLink}`);
        this.text('moneyCogs', money(m.M2));
        this.text('moneyGross', m.M3.total === null ? '—' : `${money(m.M3.total)}${m.M3.per100 !== null ? ` · ${t('ui.money.per100', { value: roundTo(m.M3.per100, 1) })}` : ''}`);
        this.text('moneyBusinessTerm', money(m.M4.total));
        this.text('moneyBadDebts', money(m.M5));
        this.text('moneyProfitTerm', money(m.M6.total));
        this.text('moneyPurchases', `${money(m.M16.total)} · ${tn('ui.money.bills', m.M16.count)}`);
        this.renderStockMovement(m);
        if (onProfit) this.renderProfitChart(m, r, now);
    },

    /** I6: the item whose profit changed most vs the previous period (loaded bills only). */
    itemDriver(m, r) {
        const prevR = comparisonRanges(r).previous;
        if (!prevR || !this.covered(prevR.from) || m.M6.total === null) return null;
        const prevM = this.summary(prevR, { detail: true });
        if (prevM.M6.total === null) return null;
        const key = (x) => ({ ...x, key: x.itemKey });
        const best = biggestChange(itemSummary(m).map(key), itemSummary(prevM).map(key), x => x.profit || 0);
        if (!best || !best.key) return null;
        return { name: getLang() === 'hi' ? best.row.itemHi || best.row.item : best.row.item, diff: best.diff };
    },

    renderStockMovement(m) {
        const s = m.M17;
        if (!s) { this.html('moneyStockMovement', `<p class="ins-hint">${esc(t('ui.money.caveat_history'))}</p>`); return; }
        const row = (k, v, card) => `<div class="ins-row ins-tap" data-breakdown="${card}" role="button" tabindex="0"><span>${esc(t(k))}</span><span>${money(v)}</span></div>`;
        this.html('moneyStockMovement', row('ui.money.opening_stock', s.opening, 'stockOpening')
            + row('ui.money.plus_bought', s.purchases, 'stockPurchases')
            + row('ui.money.cogs_minus', s.cogs, 'cogs')
            + row('ui.money.corrections', s.adjustments, 'stockAdjustments')
            + row('ui.money.closing_stock', s.closing, 'stockClosing')
            + (Math.abs(s.gap) > 1 ? `<div class="ins-caveat ins-tap" data-breakdown="stockCheck" role="button" tabindex="0">⚠ ${esc(t('ui.money.caveat_gap', { amount: formatAmount(s.gap) }))}</div>` : `<div class="ins-ok">✓ ${esc(t('ui.money.check_ok'))}</div>`));
    },

    /** M11: 13 months of profit, last year as a faint line. */
    renderProfitChart(m, r, now) {
        const keys = lastMonthKeys(now.getTime(), 13);
        const current = monthKeyOf(now.getTime());
        const lang = getLang();
        const valueOf = (k) => {
            if (k === current && r.month === current) return m.M6.total;
            const b = monthBounds(k);
            if (this.covered(b.from)) return this.summary({ from: b.from, to: endUpToNow(b.to, now) }).M6.total;
            return figuresFromSnapshot(this.snapshots[k])?.M6 ?? null;
        };
        const vals = keys.map(valueOf);
        const lyKey = (k) => { const [y, mo] = k.split('-').map(Number); return `${y - 1}-${String(mo).padStart(2, '0')}`; };
        const lyVals = keys.map(k => figuresFromSnapshot(this.snapshots[lyKey(k)])?.M6 ?? null);
        const labels = keys.map((k, i) => ({ key: k, tick: i % 3 === 0 || i === keys.length - 1 ? formatMonth(monthBounds(k).from, { lang, year: false }) : '', title: `${formatMonth(monthBounds(k).from, { lang })}: ${money(vals[i])}` }));
        this.html('moneyProfitChart', barsSvg(vals.map(v => (v === null ? NaN : v)), { faint: lyVals.map(v => (v === null ? NaN : v)), labels, onTap: 'data-month' }));
        this.html('moneyProfitLegend', `<span class="ins-key ins-key-bar"></span> ${esc(t('ui.money.this_year'))} <span class="ins-key ins-key-line"></span> ${esc(t('ui.money.last_year'))}`);
        const missing = keys.some((k, i) => vals[i] === null) || lyVals.every(v => v === null);
        const cmpR = comparisonRanges(r);
        const cmpKeys = [cmpR.previous, cmpR.lastYear].filter(x => x && !this.covered(x.from)).flatMap(x => monthKeysBetween(x.from, x.to));
        const stale = [...keys, ...keys.map(lyKey), ...cmpKeys].some(k => this.snapshots[k]?.stale);
        const canBuild = this.writesSnapshots();
        this.html('moneyBuildHistory', (missing || stale) && canBuild
            ? `<p class="ins-hint">${esc(t(stale ? 'ui.money.stale_hint' : 'ui.money.build_hint'))}</p><button type="button" class="btn btn-secondary" ${this.building ? 'disabled' : ''} onclick="window.app.money.buildHistory()">${esc(t(this.building ? 'ui.money.building' : 'ui.money.build_history'))}</button>`
            : '');
    },

    renderCash({ m, prev, ly, labels, r }) {
        this.text('moneyNetCash', money(m.M14));
        this.html('moneyCashCompare', compareHtml([vsItem(m.M14, prev?.M14, labels.prev), vsItem(m.M14, ly?.M14, labels.ly)]));
        this.html('moneyCashTakeaway', takeawayHtml(cashTakeaways({ net: m.M14, out: m.M13, profit: this.can('profit') ? m.M6.total : null, salesDue: m.M1.due })));
        this.html('moneyCashCaveats', this.caveatsHtml(m, ['M12', 'M14']));
        this.text('moneyIn', money(m.M12.total));
        this.text('moneyOut', money(m.M13.total));
        this.html('moneyInSplit', `<span data-metric-ref="M12">${esc(t('ui.money.cash_online', { cash: formatRupees(m.M12.cash), online: formatRupees(m.M12.online) }))}</span>`);
        this.html('moneyOutSplit', `<span data-metric-ref="M13">${esc(t('ui.money.cash_online', { cash: formatRupees(m.M13.cash), online: formatRupees(m.M13.online) }))}</span>`);
        // Day by day (net money in, M14 per day), only for a month.
        if (!r.month) { this.html('moneyCashChart', ''); return; }
        const keys = localDayKeys(r.from, Math.min(r.to, Date.now()));
        const net = netMoneyByDay(m.detail, keys);
        const lang = getLang();
        const labelsD = keys.map((k, i) => ({ key: k, tick: i % 7 === 0 ? String(Number(k.slice(8))) : '', title: `${formatDay(k, { lang, year: false })}: ${money(net[i])}` }));
        this.html('moneyCashChart', barsSvg(net, { labels: labelsD, onTap: 'data-day' }));
    },

    renderSpending({ m, prev, ly, labels, r }) {
        this.text('moneyBusiness', money(m.M4.total));
        const vsLy = change(m.M4.total, ly?.M4 ?? null);
        this.html('moneySpendCompare', compareHtml([vsItem(m.M4.total, prev?.M4, labels.prev), vsItem(m.M4.total, ly?.M4, labels.ly)]));
        const cats = m.M4.byCategory || [];
        const catName = (k) => (k === 'untagged' ? t('ui.money.untagged') : k === 'other' ? t('ui.money.other') : k);
        this.html('moneySpendTakeaway', takeawayHtml(spendingTakeaways({
            business: m.M4.total, vsLastYear: vsLy, topCategory: cats[0] ? catName(cats[0].category) : null,
            withdrawn: m.M9, kept: m.M10, personal: m.M8.total,
            show: { profit: this.can('profit'), personal: this.can('personalExpenses') }
        })));
        this.html('moneySpendCaveats', this.caveatsHtml(m, ['M4']));
        const max = Math.max(1, ...cats.map(c => c.total));
        this.html('moneyCategories', cats.length
            ? cats.map(c => `<div class="ins-barrow ins-tap" data-breakdown="business" role="button" tabindex="0"><span class="ins-barname">${esc(catName(c.category))}</span><span class="ins-bartrack"><span class="ins-barfill" style="width:${sharePct(c.total, max)}%"></span></span><span class="ins-barval">${money(c.total)}</span></div>`).join('')
            : `<p class="ins-empty-text">${esc(t('ui.money.no_expenses'))}</p>`);
        this.text('moneyPersonal', money(m.M8.total));
        this.text('moneyWithdrawn', money(m.M9));
        this.text('moneyKept', money(m.M10));
        this.renderWithdrawals(m);
        this.renderLabour(r);
    },

    /** Labour for the period (one home for periods; Today has today's): T-LAB-1 deducted (M7), T-LAB-2 to pay per day (M18). */
    renderLabour(r) {
        const bills = billsInRange(AppState.purchaseHistory || [], r.from, r.to);
        const settings = AppState.settings || {};
        const { deducted } = labourSummary(bills, settings);
        const { laborRate: rate, labourPackageKg: packageKg } = normalizeLabourSettings(settings);
        const toPay = { ...labourToPayByDay(bills, settings, b => { const t = billTime(b); return t === null ? null : toLocalISODate(new Date(t)); }), packageKg, rate };
        this.text('moneyLabour', money(deducted.amount));
        this.text('moneyLabourBills', tn('ui.today.labour_deducted_bills', deducted.bills));
        this.text('moneyLabourToPay', money(toPay.amount));
        this.text('moneyLabourCalc', labourCalcText(toPay, 'ui.money.labour_to_pay_calc'));
        const gap = periodLabourGap(toPay.amount, deducted.amount);
        const key = { same: 'ui.today.labour_same', more: 'ui.today.labour_more', less: 'ui.today.labour_less' }[gap.kind];
        this.text('moneyLabourDiff', t(key, { amount: formatRupees(gap.amount) }));
        return { deducted, toPay };
    },

    renderWithdrawals(m) {
        const rows = (m.detail?.withdrawn || []).slice().sort((a, b) => (b.t || 0) - (a.t || 0));
        const lang = getLang();
        this.html('moneyWithdrawalList', rows.length
            ? rows.map(w => `<div class="ins-row"><span>${esc(w.party || '—')}${w.note ? ` · ${esc(w.note)}` : ''}<br><small>${esc(formatDay(w.t, { lang }))}</small></span><span>${money(w.amount)}</span></div>`).join('')
            : `<p class="ins-empty-text">${esc(t('ui.money.no_withdrawals'))}</p>`);
        const people = [...new Set((AppState.withdrawalsHistory || []).map(w => w.person).filter(Boolean))];
        this.html('moneyWdPeople', people.map(p => `<option value="${esc(p)}">`).join(''));
    },

    toggleWithdrawalForm() {
        const f = document.getElementById('moneyWithdrawalForm');
        if (!f) return;
        f.hidden = !f.hidden;
        const d = document.getElementById('moneyWdDate');
        if (d) d.max = toLocalISODate(new Date());
        if (d && !d.value) d.value = toLocalISODate(new Date());
    },

    saveWithdrawal() {
        return Helpers.runExclusive('withdrawal', '[data-withdrawal-save]', () => this._saveWithdrawal());
    },

    _saveWithdrawal() {
        const val = (id) => (document.getElementById(id)?.value || '').trim();
        const amount = parseFloat(val('moneyWdAmount'));
        const person = val('moneyWdPerson');
        const date = val('moneyWdDate');
        if (!(amount > 0)) { UIManager.showToast(t('msg.common.enter_valid_amount'), 'error'); return; }
        if (!person) { UIManager.showToast(t('msg.finance.enter_who_withdrew_money'), 'error'); return; }
        if (!date || !parseAnyBillDate(date)) { UIManager.showToast(t('msg.finance.select_date'), 'error'); return; }
        // Its timestamp is the later of now and that day; the rules refuse a future one
        if (toLocalISODate(parseAnyBillDate(date)) > toLocalISODate(new Date())) { UIManager.showToast(t('msg.finance.withdrawal_date_future'), 'error'); return; }
        const failed = (e) => {
            console.error('Money: saving withdrawal failed:', e);
            refusedForClock(e)
                .then(clock => UIManager.showToast(t(clock ? 'msg.common.phone_clock_wrong_save' : 'msg.finance.error_recording_withdrawal'), 'error'))
                .catch(err => console.error('Money: withdrawal failure toast:', err));
        };
        let committed;
        try {
            ({ committed } = FirebaseService.startSaveWithdrawal({ amount, person, purpose: val('moneyWdPurpose') || 'Personal Use', date, createdAt: new Date().toISOString() }));
        } catch (e) {
            failed(e);
            return;
        }
        // Saved on the phone at once (also offline); a refused write is taken out again
        committed.catch(e => {
            failed(e);
            this.render();
        });
        AuditService.note(AuditService.ACTIONS.RECORD_WITHDRAWAL, { amount, person, date });
        ['moneyWdAmount', 'moneyWdPerson', 'moneyWdPurpose'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        const f = document.getElementById('moneyWithdrawalForm');
        if (f) f.hidden = true;
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        UIManager.showToast(t(offline ? SAVED_ON_PHONE_KEY : 'msg.finance.withdrawal_recorded_successfully'), 'success');
        this.render();
    },

    accounts() {
        try {
            const list = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]');
            return Array.isArray(list) ? list : [];
        } catch { return []; }
    },

    accountsTotal() {
        return accountsTotal(this.accounts());
    },

    saveAccount() {
        const name = (document.getElementById('moneyAccName')?.value || '').trim();
        const balance = parseFloat(document.getElementById('moneyAccBalance')?.value);
        const type = document.getElementById('moneyAccType')?.value === 'liability' ? 'liability' : 'asset';
        if (!name || !Number.isFinite(balance)) { UIManager.showToast(t('msg.common.enter_valid_amount'), 'error'); return; }
        const list = this.accounts().filter(a => a.name !== name);
        list.push({ name, balance, type, icon: type === 'asset' ? '🏦' : '🤝' });
        try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list)); } catch { /* storage blocked */ }
        ['moneyAccName', 'moneyAccBalance'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        this.render();
    },

    removeAccount(index) {
        const list = this.accounts();
        list.splice(index, 1);
        try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list)); } catch { /* storage blocked */ }
        this.render();
    },

    renderWorth({ m, now }) {
        const dues = outstandingTotals({ purchases: AppState.purchaseHistory, wholesaleSales: AppState.salesHistory, retailSales: AppState.retailSalesHistory });
        const stock = m.stockNow;
        const drawerSessions = this.drawerSessions(now);
        const last = lastCountedSession(drawerSessions);
        const drawer = last ? Number(last.closingBalance) : 0;
        const accounts = this.accountsTotal();
        const worth = netWorth({ stock, receivable: dues.receivable.total, payable: dues.payable.total, accounts, drawer }, this.cfg());
        const seeStock = this.can('stockValue');
        this.text('moneyWorthValue', seeStock ? money(worth) : '—');
        const lyMonth = monthStart(now, -12);
        const lyClose = figuresFromSnapshot(this.snapshots[monthKeyOf(lyMonth.getTime())])?.closing;
        const sinceLabel = formatMonth(lyMonth, { lang: getLang() });
        // Compared on the stock + dues part only (old dues and accounts are not kept per month).
        const cmp = { ...vsItem(stock, lyClose, t('ui.money.stock_vs', { when: sinceLabel })), unknownText: t('ui.money.stock_vs_not_known', { when: sinceLabel }) };
        this.html('moneyWorthCompare', seeStock && Number.isFinite(stock) && (cmp.c || cmp.unknown) ? compareHtml([cmp]) : '');
        this.html('moneyWorthTakeaway', seeStock ? takeawayHtml(worthTakeaways({ worth, change: null, receivable: dues.receivable.total, sinceLabel })) : '');
        const term = (label, value, link, ref) => `<div class="ins-row"><span>${esc(t(label))}</span><span><span${ref ? ` data-metric-ref="${ref}"` : ''}>${money(value)}</span> <button type="button" class="ins-link" data-go="${link}">${esc(t(`ui.money.home_${link.replace(/-/g, '_')}`))} ›</button></span></div>`;
        const cfg = this.cfg();
        this.html('moneyWorthTerms',
            (seeStock && cfg.netWorthTerms.includes('stock') ? term('ui.money.stock_value', stock, 'stock', 'S4') : '')
            + (cfg.netWorthTerms.includes('receivable') ? term('ui.money.to_receive', dues.receivable.total, 'due', 'O4') : '')
            + (cfg.netWorthTerms.includes('drawer') ? term(last ? 'ui.money.drawer_last' : 'ui.money.drawer_none', drawer, 'cash-management', 'C9') : '')
            + (cfg.netWorthTerms.includes('accounts') ? `<div class="ins-row"><span>${esc(t('ui.money.other_accounts'))}</span><span data-input>${money(accounts)}</span></div>` : '')
            + term('ui.money.to_pay', -dues.payable.total, 'due', 'O3')
            + (seeStock ? `<div class="ins-row ins-total"><span>${esc(t('ui.money.net_worth'))}</span><span data-metric-ref="M15">${money(worth)}</span></div>` : ''));
        const list = this.accounts();
        this.html('moneyAccounts', list.length
            ? list.map((a, i) => `<div class="ins-row"><span>${esc(a.icon || '')} ${esc(a.name)}</span><span>${a.type === 'liability' ? '−' : ''}${money(Number(a.balance) || 0)} <button type="button" class="ins-link" onclick="window.app.money.removeAccount(${i})" aria-label="${esc(t('ui.money.acc_remove'))}">✕</button></span></div>`).join('')
            : `<p class="ins-empty-text">${esc(t('ui.money.no_accounts'))}</p>`);
    },

    /** AC12 / AC5: the page's dues agree with Outstanding's rule, items add up to sales. */
    renderChecks({ m }) {
        const items = itemSummary(m);
        const okItems = addsUp(items, 'sales', m.M1.total);
        const okStock = !m.M17 || Math.abs(m.M17.gap) <= 100;
        const ok = okItems && okStock;
        this.html('moneyChecks', `<button type="button" class="ins-checkline ${ok ? 'ok' : 'warn'}" data-go="diagnostics">${ok ? '✓' : '⚠'} ${esc(t(ok ? 'ui.money.checks_ok' : 'ui.money.checks_warn'))}</button>`);
    },

    // ---- month snapshots

    async loadSnapshots() {
        if (this.snapshotsLoaded || !FirebaseService.loadMonthStats) return;
        const role = AppState.userRole;
        if (role !== 'owner' && role !== 'manager') return;
        this.snapshotsLoaded = true;
        this.listenSnapshots();
        try {
            this.snapshots = await FirebaseService.loadMonthStats(snapshotsFrom(Date.now()), 40);
            this.noteStaleSeen();
            await this.rollSnapshots();
            if (this.isOpen()) this.render();
        } catch (e) {
            console.error('Money: month snapshots failed:', e);
            this.snapshotsLoaded = false;
        }
    },

    /** When this device first saw each stale snapshot (its own clock; see staleToRebuild). */
    noteStaleSeen(seen = Date.now()) {
        Object.entries(this.snapshots || {}).forEach(([k, doc]) => {
            if (doc?.stale && !Number.isFinite(this.staleSeen[k])) this.staleSeen[k] = seen;
            if (!doc?.stale) delete this.staleSeen[k];
        });
    },

    /** Stale marks written by this device, and full history arriving (a rebuild can then run). */
    listenSnapshots() {
        if (this.listening || typeof window === 'undefined') return;
        this.listening = true;
        window.addEventListener('aadhat:monthstale', (e) => this.onMonthStale(e.detail));
        window.addEventListener('aadhat:historyextended', (e) => {
            if (e.detail?.from !== 0 || !this.snapshotsLoaded) return;
            this.rollSnapshots().then(() => { if (this.isOpen()) this.render(); })
                .catch(err => console.error('Money: rebuilding month snapshots failed:', err));
        });
    },

    onMonthStale({ months = [], at } = {}) {
        if (!this.snapshotsLoaded) return;
        const seen = Date.now();
        months.forEach(k => {
            this.snapshots[k] = { ...(this.snapshots[k] || { month: k }), stale: true, staleAt: at };
            this.staleSeen[k] = seen;
        });
        if (this.isOpen()) this.render();
    },

    /** Rolls the current / previous month and rebuilds stale older months (one run at a time). */
    rollSnapshots() {
        const run = (this.rollChain || Promise.resolve()).then(() => this.rollNow());
        this.rollChain = run.catch(() => {});
        return run;
    },

    /**
     * Owner/manager phones that load every expense write the shared month snapshots; a phone
     * that didn't load the personal expense rows (#98) would store them without, so it only reads.
     */
    writesSnapshots() {
        const role = AppState.userRole;
        return (role === 'owner' || role === 'manager') && !!FirebaseService.personalRowsLoaded?.();
    },

    /** Rebuilds the current / previous month snapshot from the loaded bills (≤ 2 writes, every 6 h). */
    async rollNow() {
        if (!this.writesSnapshots()) return;
        const now = Date.now();
        const keys = monthsToRoll(this.snapshots, { now, loadedFrom: isFullHistoryLoaded() ? 0 : historyLoadedFrom() });
        const docs = keys.map(k => this.snapshotFor(k, now)).filter(Boolean);
        if (docs.length) {
            docs.forEach(d => { this.snapshots[d.month] = d; delete this.staleSeen[d.month]; });
            await FirebaseService.saveMonthStats(docs);
        }
        await this.rebuildStale(now);
    },

    /**
     * Stale months before the previous one, rebuilt from the full history when it was read after
     * the stale mark was seen here (staleToRebuild): 1 read + 1 write each, no bill reads.
     * @returns {Promise<number>} snapshots written
     */
    async rebuildStale(now = Date.now()) {
        if (!isFullHistoryLoaded() || !FirebaseService.rebuildMonthStat) return 0;
        const fetchedAt = FirebaseService.getFullHistoryFetchedAt?.() || 0;
        let written = 0;
        for (const k of staleToRebuild(this.snapshots, { now, fetchedAt, seenAt: this.staleSeen })) {
            const doc = this.snapshotFor(k, now);
            if (!doc) continue;
            const res = await FirebaseService.rebuildMonthStat(doc, this.snapshots[k].staleAt);
            this.snapshots[k] = res.doc;
            if (res.status === 'newer') this.staleSeen[k] = Date.now();
            else delete this.staleSeen[k];
            if (res.status === 'written') written += 1;
        }
        return written;
    },

    snapshotFor(month, now = Date.now()) {
        const b = monthBounds(month);
        const input = this.input(b.from);
        if (!input.base) return null;
        const m = moneySummary(input, { from: b.from, to: Math.min(b.to, now + 1) }, { detail: true });
        return buildSnapshot(month, m, input, now);
    },

    /** Owner/manager: load all bills once and write one snapshot per month. */
    async buildHistory() {
        if (this.building || !this.writesSnapshots()) return;
        this.building = true;
        this.render();
        try {
            const ok = await ensureHistoryFrom(null);
            if (!ok) throw new Error('full history not loaded');
            // Bills read before a stale mark was seen may miss the change behind it: read them again.
            const seen = Object.values(this.staleSeen).filter(Number.isFinite);
            if (seen.length && !((FirebaseService.getFullHistoryFetchedAt?.() || 0) > Math.max(...seen))) await refreshOnDemandHistory();
            const all = [...(AppState.purchaseHistory || []), ...(AppState.salesHistory || []), ...(AppState.retailSalesHistory || [])]
                .map(b => parseAnyBillDate(b.timestamp ?? b.date)?.getTime()).filter(Number.isFinite);
            const now = Date.now();
            const fetchedAt = FirebaseService.getFullHistoryFetchedAt?.() || 0;
            const prevFrom = monthStart(now, -1).getTime();
            const floor = monthBounds(snapshotsFrom(now)).from;
            // Months a stale mark can reach (read back, older than the two rolled ones) are written guarded.
            const markable = (k) => { const f = monthBounds(k).from; return f >= floor && f < prevFrom; };
            const docs = monthKeysBetween(Math.min(...all, now), now + 1).map(k => this.snapshotFor(k, now)).filter(Boolean);
            const plain = docs.filter(x => !markable(x.month));
            plain.forEach(x => { this.snapshots[x.month] = x; delete this.staleSeen[x.month]; });
            await FirebaseService.saveMonthStats(plain);
            const results = await Promise.all(docs.filter(x => markable(x.month)).map(x => {
                const known = this.snapshots[x.month];
                const handled = known?.stale && fetchedAt > this.staleSeen[x.month] ? { staleAt: known.staleAt } : null;
                return FirebaseService.saveMonthStatGuarded(x, handled).then(res => ({ res, known }));
            }));
            let written = plain.length;
            results.forEach(({ res, known }) => {
                const k = res.doc.month;
                this.snapshots[k] = res.doc;
                if (res.status === 'written') {
                    delete this.staleSeen[k];
                    written += 1;
                } else if (!Number.isFinite(this.staleSeen[k]) || res.doc.staleAt !== known?.staleAt) {
                    this.staleSeen[k] = Date.now();
                }
            });
            UIManager.showToast(t('msg.money.history_built', { count: written }), 'success');
        } catch (e) {
            console.error('Money: building month history failed:', e);
            UIManager.showToast(t('msg.money.could_not_load'));
        } finally {
            this.building = false;
            this.render();
        }
    },

    // ---- taps

    setupTaps() {
        const page = document.getElementById('money');
        if (!page || page.dataset.taps) return;
        page.dataset.taps = '1';
        const handler = (e) => {
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            const go = e.target.closest('[data-go]');
            if (go) { e.preventDefault(); window.app?.nav?.showTab(go.dataset.go); return; }
            const day = e.target.closest('[data-day]');
            if (day && day.dataset.day) { window.app?.nav?.showTab('cash-management'); return; }
            const month = e.target.closest('[data-month]');
            if (month && month.dataset.month) { setInsightsContext({ preset: month.dataset.month === monthKeyOf(Date.now()) ? 'this-month' : `month:${month.dataset.month}` }); this.render(); return; }
            const el = e.target.closest('[data-breakdown]');
            if (!el) return;
            if (e.type === 'keydown') e.preventDefault();
            this.openBreakdown(el.dataset.breakdown);
        };
        page.addEventListener('click', handler);
        page.addEventListener('keydown', handler);
    },

    openBreakdown(cardId) {
        const r = this.range();
        FinanceBreakdownSheet.open(cardId, {
            getSummary: () => this.summary(r, { sessions: this.sessions(r), detail: true }).finance,
            periodLabel: this.periodLabel(r)
        });
    },

    text(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    },

    html(id, value) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = value;
    }
};

export { profitPerDay };
