// -------------------- RATE TRENDS MODULE (#65) --------------------
// Owner/manager page. Rates: the past comes from a one-time owner-triggered
// backfill over all bills (weekly and monthly kg-weighted rates in one
// rateStats doc per item and year; resumable, read budget per day, stops on a
// quota error); after that backfill (the cutoff, rateStats/_meta.backfillAt)
// the rate line follows the rate set on the Items page, rebuilt from
// rateHistory. The bill roll-forward keeps running so kg, bills and amounts
// stay current for every week and month. Product traffic: items moved per
// month, one item week by week, and day by day from the bills already loaded. Math lives in utils/rate-trends.js,
// utils/item-rate-series.js and utils/product-traffic.js.

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { t, getLang } from '../i18n/index.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { isQuotaExhaustedError } from '../utils/quota-guard.js';
import { chartScaleMax } from './reports.js';
import { RATE_FIELDS, fieldLabel } from '../utils/rate-history.js';
import {
    DEFAULT_DAILY_READ_BUDGET, DIRECTION_KEYS, CONFIDENCE_KEYS, READ_BUDGET_OPTIONS,
    addMonths, addWeeks, aggregateBills, backfillDays, estimateBackfillReads, explainOutlook, finalizeStats,
    istDayStartMs, istMonthKey, istMonthStartMs, istWeekStart, itemsByUsage, monthBuckets, monthLabel, monthSeries,
    newCursor, parseCursor, planRollForward, rollForwardWindow, runBackfillReads, seasonalOutlookCombined,
    trendRows, weekBuckets, yearOverlay
} from '../utils/rate-trends.js';
import { ITEM_RATE_KINDS, cutoffMonth, cutoffWeek, itemRateSeries, mergeHistoryEntries, rateChangeRows } from '../utils/item-rate-series.js';
import {
    comparisonMonths, dailyDetailAvailable, dailyTraffic, isSettledYear, monthBucketsFor, recentMonths, trafficRows,
    weeklyItemRows, weeksBackStart, TRAFFIC_KINDS
} from '../utils/product-traffic.js';

const CURSOR_KEY = 'aadhatRateStatsBackfill';
const BUDGET_KEY = 'aadhatRateStatsBudget';
const ROLL_KEY = 'aadhatRateStatsRoll';
const HISTORY_CACHE_PREFIX = 'aadhatRateHistory_';
const YEAR_CACHE_PREFIX = 'aadhatRateStatsYear_';
const ROLL_EVERY_MS = 6 * 60 * 60 * 1000;
const ROLL_RETRY_MS = 60 * 1000;
const ROLL_RETRIES = 5;
/** Server read cap for the roll-forward (item-year docs of this and maybe last year). */
const ROLL_SERVER_MAX = 300;
/** Read caps: Items-page rate changes per item, item docs per traffic year. */
const HISTORY_MAX = 500;
const YEAR_MAX = 300;
const TRAFFIC_WEEK_OPTIONS = [12, 26, 52, 104];
const META_TTL_MS = 5 * 60 * 1000;
const COLORS = { purchase: '#2563eb', retail: '#059669', wholesale: '#d97706', bought: '#93c5fd', sold: '#6ee7b7' };
const YEAR_COLORS = ['#dc2626', '#2563eb', '#059669', '#7c3aed', '#d97706'];
const DASH = [5, 4];
const STOP_KEYS = { quota: 'ui.trends.stop_quota', budget: 'ui.trends.stop_budget', error: 'ui.trends.stop_error', save: 'ui.trends.stop_save' };

const esc = (v) => Helpers.escapeHtml(v == null ? '' : String(v));
const canSee = () => AppState.userRole === 'owner' || AppState.userRole === 'manager';
const isOwner = () => AppState.userRole === 'owner';
const rupees = (n) => (n === null || n === undefined ? '—' : `₹${Number(n).toFixed(2)}`);
const num = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');
const kgText = (n) => `${num(n)} kg`;
const pctText = (p) => (p === null || p === undefined ? '—' : `${p > 0 ? '+' : ''}${Math.round(p)}%`);
const dateText = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toLocaleDateString('en-IN') : '—');
const isDenied = (e) => e?.code === 'permission-denied' || /permission/i.test(String(e?.message || ''));
const KIND_KEYS = { purchase: 'ui.trends.purchase', wholesale: 'ui.trends.wholesale', retail: 'ui.trends.retail' };

function loadedBills() {
    return {
        purchase: AppState.purchaseHistory || [],
        retail: AppState.retailSalesHistory || [],
        wholesale: AppState.salesHistory || []
    };
}

function itemLabel(item) {
    if (!item) return '';
    if (getLang() === 'hi' && item.hindiName) return item.hindiName;
    return item.name || item.hindiName || '';
}

function itemName(itemId) {
    const item = (AppState.items || []).find(i => i.id === itemId);
    return item ? itemLabel(item) : t('ui.trends.removed_item');
}

function readBudget() {
    const v = Number(localStorage.getItem(BUDGET_KEY));
    return READ_BUDGET_OPTIONS.includes(v) ? v : DEFAULT_DAILY_READ_BUDGET;
}

function loadCursor() {
    try { return parseCursor(localStorage.getItem(CURSOR_KEY)); } catch (_) { return null; }
}

function storeCursor(cursor) {
    try {
        localStorage.setItem(CURSOR_KEY, JSON.stringify(cursor));
    } catch (e) {
        console.warn('Rate trends: could not save the backfill position:', e?.name || e);
    }
}

function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
}

function writeJson(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        console.warn('Rate trends: could not keep data on this device:', e?.name || e);
    }
}

const compactSection = (s) => ({ kg: Number(s?.kg) || 0, bills: Number(s?.bills) || 0, amount: Number(s?.amount) || 0 });
const compactBucket = (b) => ({
    bills: Number(b?.bills) || 0,
    purchase: compactSection(b?.purchase), wholesale: compactSection(b?.wholesale), retail: compactSection(b?.retail)
});
/** Year doc reduced to what the month overview needs (kept on the device). */
const compactYearDoc = (d) => {
    const months = {};
    Object.keys(d.months || {}).forEach(k => { months[k] = compactBucket(d.months[k]); });
    return { itemId: d.itemId, year: String(d.year), weeks: {}, months };
};

export const RateTrendsManager = {
    meta: undefined,
    metaAt: 0,
    metaError: null,
    estimate: null,
    statsByItem: new Map(),
    itemId: null,
    docs: [],
    monthB: [],
    weekB: [],
    series: null,
    seriesItemId: null,
    seriesNote: null,
    range: '24',
    view: 'chart',
    period: 'week',
    weeks: 6,
    compareKind: 'purchase',
    section: 'rates',
    running: false,
    progress: null,
    lastStop: null,
    rolling: null,
    yearDocs: new Map(),
    trafficWeeks: 26,
    trafficMonth: null,
    trafficItemId: null,
    traffic: null,

    async init() {
        const denied = document.getElementById('rtDenied');
        const body = document.getElementById('rtBody');
        if (!canSee()) {
            if (denied) denied.style.display = 'block';
            if (body) body.style.display = 'none';
            return;
        }
        if (denied) denied.style.display = 'none';
        if (body) body.style.display = '';
        this.showSection();
        this.fillItemPicker();
        await this.loadMeta();
        this.renderStatus();
        if (this.meta?.backfillDone) this.rollForward().catch(e => console.warn('Rate trends roll-forward failed:', e));
        if (this.section === 'traffic') await this.loadTraffic();
        else await this.loadItem();
    },

    /** Language switched: redraw from memory (no reads). */
    refreshForLanguage() {
        if (!canSee() || !document.getElementById('rtBody')) return;
        this.fillItemPicker();
        this.renderStatus();
        this.render();
        if (this.section === 'traffic') {
            this.fillTrafficPickers();
            this.renderTraffic();
            const docs = this.statsByItem.get(this.trafficItemId);
            if (docs) this.renderWeekly(docs);
        }
    },

    cutoffMs() {
        return this.meta?.backfillDone ? Number(this.meta.backfillAt) || 0 : 0;
    },

    fillItemPicker() {
        const select = document.getElementById('rtItem');
        if (!select) return;
        const ranked = itemsByUsage(AppState.items || [], loadedBills());
        if (!this.itemId || !ranked.some(r => r.item.id === this.itemId)) this.itemId = ranked[0]?.item.id || null;
        select.innerHTML = ranked.length
            ? ranked.map(r => `<option value="${esc(r.item.id)}"${r.item.id === this.itemId ? ' selected' : ''}>${esc(itemLabel(r.item))}</option>`).join('')
            : `<option value="">${esc(t('ui.trends.no_items'))}</option>`;
    },

    async loadMeta(force = false) {
        if (!force && this.meta !== undefined && Date.now() - this.metaAt < META_TTL_MS) return this.meta;
        try {
            this.meta = await FirebaseService.loadRateStatsMeta();
            this.metaError = null;
        } catch (e) {
            this.meta = null;
            this.metaError = isDenied(e) ? 'denied' : (isQuotaExhaustedError(e) ? 'quota' : 'offline');
            console.warn('Rate trends: status not read:', e?.code || e);
        }
        this.metaAt = Date.now();
        return this.meta;
    },

    setSection(value) {
        this.section = value === 'traffic' ? 'traffic' : 'rates';
        this.showSection();
        if (this.section === 'traffic') return this.loadTraffic();
        return this.loadItem();
    },

    showSection() {
        const rates = document.getElementById('rtRatesSection');
        const traffic = document.getElementById('rtTrafficSection');
        if (rates) rates.style.display = this.section === 'rates' ? '' : 'none';
        if (traffic) traffic.style.display = this.section === 'traffic' ? '' : 'none';
        document.getElementById('rtTabRates')?.classList.toggle('active', this.section === 'rates');
        document.getElementById('rtTabTraffic')?.classList.toggle('active', this.section === 'traffic');
    },

    // ---------- backfill status card ----------

    renderStatus() {
        const el = document.getElementById('rtStatus');
        if (!el) return;
        if (this.metaError === 'denied') {
            el.innerHTML = `<div class="rt-note">${esc(t('ui.trends.rules_not_published'))}</div>`;
            return;
        }
        const cursor = loadCursor();
        const budget = readBudget();
        const budgetSelect = `<label class="rt-budget">${esc(t('ui.trends.reads_per_day'))}
            <select onchange="window.app.rateTrends.setBudget(this.value)">${READ_BUDGET_OPTIONS.map(v =>
        `<option value="${v}"${v === budget ? ' selected' : ''}>${v.toLocaleString('en-IN')}</option>`).join('')}</select></label>`;
        let html = '';
        if (this.running) {
            html = `<div class="rt-note">${esc(t('ui.trends.building'))}<br><span class="rt-muted" id="rtProgress">${esc(this.progressText())}</span></div>`;
        } else if (cursor) {
            const stop = this.lastStop ? `<div class="rt-warn">${esc(t(STOP_KEYS[this.lastStop]))}</div>` : '';
            html = `${stop}<div class="rt-note">${esc(t('ui.trends.paused', { bills: num(cursor.bills), reads: num(cursor.reads) }))}</div>
                ${isOwner() ? `<div class="rt-actions"><button class="btn btn-primary" onclick="window.app.rateTrends.continueBackfill()">${esc(t('ui.trends.continue'))}</button></div>${budgetSelect}` : ''}`;
        } else if (this.meta?.backfillDone) {
            const stop = this.lastStop ? `<div class="rt-warn">${esc(t(STOP_KEYS[this.lastStop]))}</div>` : '';
            html = `${stop}<div class="rt-ok">${esc(t('ui.trends.built', { bills: num(this.meta.bills), date: dateText(this.meta.backfillAt) }))}</div>
                ${isOwner() ? `<div class="rt-actions"><button class="btn btn-secondary" onclick="window.app.rateTrends.startBackfill()">${esc(t('ui.trends.rebuild'))}</button></div>` : ''}`;
        } else if (isOwner()) {
            const est = this.estimate;
            const estText = est ? t('ui.trends.est_reads', { reads: num(est.reads) }) : t('ui.trends.est_unknown');
            html = `<div class="rt-note">${esc(t('ui.trends.need_history'))}</div>
                <div class="rt-actions"><button class="btn btn-primary" onclick="window.app.rateTrends.startBackfill()">${esc(t('ui.trends.build_btn', { est: estText }))}</button></div>
                ${budgetSelect}
                <div class="rt-muted">${esc(t('ui.trends.free_limit'))}</div>`;
            if (!est && this.metaError !== 'quota') this.loadEstimate().then(() => { if (this.estimate) this.renderStatus(); }).catch(() => {});
        } else {
            html = `<div class="rt-note">${esc(t('ui.trends.ask_owner'))}</div>`;
        }
        el.innerHTML = html;
    },

    progressText() {
        return this.progress ? t('ui.trends.progress', { bills: num(this.progress.bills), reads: num(this.progress.reads) }) : '';
    },

    setBudget(value) {
        const v = Number(value);
        if (READ_BUDGET_OPTIONS.includes(v)) localStorage.setItem(BUDGET_KEY, String(v));
        this.renderStatus();
    },

    async loadEstimate() {
        if (this.estimate) return this.estimate;
        const bills = loadedBills();
        const loaded = bills.purchase.length + bills.retail.length + bills.wholesale.length;
        const oldest = await FirebaseService.oldestBillTimestamp();
        const reads = estimateBackfillReads({
            loadedBills: loaded, loadedFrom: Number(AppState.historyLoadedFrom) || 0, oldest, now: Date.now(), items: (AppState.items || []).length
        });
        this.estimate = { reads, oldest };
        return this.estimate;
    },

    async startBackfill() {
        if (!isOwner() || this.running) return;
        let est = null;
        try { est = await this.loadEstimate(); } catch (e) { console.warn('Rate trends: estimate failed:', e?.code || e); }
        const budget = readBudget();
        const days = est ? backfillDays(est.reads, budget) : null;
        const reads = est ? est.reads.toLocaleString('en-IN') : '';
        const msg = !est ? t('msg.trends.backfill_confirm')
            : days > 1 ? t('msg.trends.backfill_confirm_days', { reads, days, perDay: budget.toLocaleString('en-IN') })
            : t('msg.trends.backfill_confirm_reads', { reads });
        const ok = await UIManager.showModal(msg, t('msg.trends.build_rate_history'), true);
        if (!ok) return;
        const now = Date.now();
        const cursor = newCursor(now);
        storeCursor(cursor);
        try {
            await FirebaseService.saveRateStatsMeta({ startedAt: now, byUserId: AppState.currentUser?.uid || '', by: AppState.userName || '' });
        } catch (e) {
            if (isDenied(e)) {
                localStorage.removeItem(CURSOR_KEY);
                this.metaError = 'denied';
                this.renderStatus();
                return;
            }
            console.warn('Rate trends: start not recorded:', e?.code || e);
        }
        await this.runBackfill();
    },

    continueBackfill() {
        if (!isOwner() || this.running) return Promise.resolve();
        return this.runBackfill();
    },

    async runBackfill() {
        const cursor = loadCursor();
        if (!cursor) return;
        this.running = true;
        this.lastStop = null;
        this.progress = null;
        this.renderStatus();
        try {
            if (cursor.phase === 'read') {
                const result = await runBackfillReads({
                    cursor,
                    items: AppState.items || [],
                    budget: readBudget(),
                    fetchPage: (coll, after, limit) => FirebaseService.loadBillPageById(coll, after, limit),
                    saveCursor: storeCursor,
                    isQuotaError: isQuotaExhaustedError,
                    onProgress: (c) => {
                        this.progress = { bills: c.bills, reads: c.reads };
                        const el = document.getElementById('rtProgress');
                        if (el) el.textContent = this.progressText();
                    }
                });
                if (result.status !== 'read-done') {
                    this.lastStop = STOP_KEYS[result.status] ? result.status : 'error';
                    if (result.error) console.warn('Rate trends backfill stopped:', result.error?.code || result.error);
                    return;
                }
            }
            await this.finishBackfill(cursor);
        } finally {
            this.running = false;
            this.renderStatus();
        }
    },

    async finishBackfill(cursor) {
        const stats = finalizeStats(cursor.acc);
        const writes = Object.keys(stats).map(id => ({ id, data: stats[id] }));
        try {
            await FirebaseService.saveRateStats(writes);
            const meta = {
                backfillDone: true,
                backfillAt: Date.now(),
                bills: cursor.bills,
                reads: cursor.reads,
                months: writes.reduce((n, w) => n + Object.keys(w.data.months).length, 0),
                by: AppState.userName || '',
                byUserId: AppState.currentUser?.uid || ''
            };
            await FirebaseService.saveRateStatsMeta(meta);
            this.meta = { ...(this.meta || {}), ...meta };
            this.metaAt = Date.now();
            this.metaError = null;
            localStorage.removeItem(CURSOR_KEY);
            this.statsByItem.clear();
            this.yearDocs.clear();
            this.series = null;
            UIManager.showToast(t('msg.trends.rate_history_built'));
            // Months still being edited come from the loaded bills, not the backfill snapshot.
            await this.rollForward({ force: true });
            await this.loadItem();
        } catch (e) {
            this.lastStop = 'save';
            console.warn('Rate trends: saving stats failed:', e?.code || e);
        }
    },

    // ---------- roll-forward from loaded bills ----------

    /**
     * Brings the stats of months fully covered by the loaded history in line
     * with the loaded bills (kg, bills, amounts and bill rates of every item).
     * Runs only online once the bill listeners have server data (offline-cached
     * bills may be stale and would overwrite correct docs); compares with the
     * server copy of those months, so a wrong doc written by another device is
     * repaired, and writes only changed month docs.
     */
    rollForward({ force = false } = {}) {
        if (!canSee() || !AppState.currentUser) return Promise.resolve('not-allowed');
        if (this.rolling) return this.rolling;
        const run = async () => {
            const uid = AppState.currentUser.uid;
            let last = null;
            try { last = JSON.parse(localStorage.getItem(ROLL_KEY) || 'null'); } catch (_) { last = null; }
            if (!force && last && last.uid === uid && Date.now() - Number(last.at) < ROLL_EVERY_MS) return 'recent';
            const markDone = () => localStorage.setItem(ROLL_KEY, JSON.stringify({ uid, at: Date.now() }));
            // Not marked done: retried later.
            if (navigator.onLine === false || !FirebaseService.historyServerSynced()) return 'not-synced';
            const meta = await this.loadMeta();
            if (!meta?.backfillDone) {
                if (this.metaError !== 'offline') markDone();
                return this.metaError || 'no-backfill';
            }
            const win = rollForwardWindow(Number(AppState.historyLoadedFrom) || 0, Date.now());
            const fromMs = Math.min(istMonthStartMs(win.fromMonth), istDayStartMs(win.fromWeek));
            const computed = finalizeStats(aggregateBills(loadedBills(), AppState.items || [], { fromMs }));
            let server;
            try {
                server = await FirebaseService.loadServerRateStatsFromYear(win.fromYear, ROLL_SERVER_MAX);
            } catch (e) {
                console.warn('Rate trends roll-forward: stored months not read from the server:', e?.code || e);
                return 'server-unreadable';
            }
            if (server.more) return 'too-many';
            const writes = planRollForward(computed, server.docs, win);
            if (writes.length) {
                await FirebaseService.saveRateStats(writes);
                writes.forEach(w => {
                    this.statsByItem.delete(w.data.itemId);
                    this.yearDocs.delete(w.data.year);
                });
            }
            markDone();
            return writes.length ? 'written' : 'current';
        };
        const p = run().finally(() => { this.rolling = null; });
        this.rolling = p;
        return p;
    },

    /** Background roll-forward a little after startup (owner/manager devices). */
    scheduleRollForward(delayMs = 20000, attempt = 0) {
        if (!canSee()) return;
        setTimeout(() => {
            this.rollForward()
                .then(result => {
                    if ((result === 'not-synced' || result === 'server-unreadable') && attempt < ROLL_RETRIES) {
                        this.scheduleRollForward(ROLL_RETRY_MS, attempt + 1);
                    }
                })
                .catch(e => console.warn('Rate trends roll-forward failed:', e?.code || e));
        }, delayMs);
    },

    // ---------- item view ----------

    async selectItem(itemId) {
        this.itemId = itemId || null;
        await this.loadItem();
    },

    setRange(value) {
        this.range = value;
        this.render();
    },

    setPeriod(value) {
        this.period = value === 'month' ? 'month' : 'week';
        this.render();
    },

    setView(value) {
        this.view = value === 'table' ? 'table' : 'chart';
        this.render();
    },

    setWeeks(value) {
        const w = Number(value);
        this.weeks = [4, 6, 8].includes(w) ? w : 6;
        this.renderOutlook();
    },

    setCompareKind(value) {
        this.compareKind = value === 'sale' ? 'sale' : 'purchase';
        this.drawYearChart();
    },

    /** Year docs of one item (one read per year of history; cached for the session). */
    async itemYearDocs(itemId) {
        let docs = this.statsByItem.get(itemId);
        if (!docs) {
            docs = await FirebaseService.loadRateStatsForItem(itemId);
            this.statsByItem.set(itemId, docs);
        }
        return docs;
    },

    async loadItem() {
        const itemId = this.itemId;
        if (!itemId || this.metaError === 'denied') {
            this.setDocs([]);
            this.series = null;
            this.render();
            return;
        }
        let docs;
        try {
            docs = await this.itemYearDocs(itemId);
        } catch (e) {
            docs = [];
            if (isDenied(e)) {
                this.metaError = 'denied';
                this.renderStatus();
            }
            console.warn('Rate trends: stats not read:', e?.code || e);
        }
        if (itemId !== this.itemId) return;
        this.setDocs(docs);
        if (this.seriesItemId !== itemId) this.series = null;
        this.render();
        await this.loadItemSeries(itemId);
        if (itemId === this.itemId) this.render();
    },

    setDocs(docs) {
        this.docs = docs || [];
        this.monthB = monthBuckets(this.docs);
        this.weekB = weekBuckets(this.docs);
    },

    /**
     * Items-page rate changes of one item after the cutoff, newest first.
     * Kept per item on this device; only entries newer than the last kept one
     * are read (≤ HISTORY_MAX reads, 1 read when nothing changed).
     */
    async loadHistoryEntries(itemId, cutoff) {
        const key = `${HISTORY_CACHE_PREFIX}${itemId}`;
        let cache = readJson(key);
        if (!cache || cache.v !== 1 || cache.cutoff !== cutoff || !Array.isArray(cache.entries)) cache = { v: 1, cutoff, entries: [] };
        const since = cache.entries.reduce((m, e) => Math.max(m, Number(e.at) || 0), cutoff);
        let fresh;
        try {
            fresh = await FirebaseService.loadRateHistory(itemId, HISTORY_MAX, { since });
        } catch (e) {
            e.cachedEntries = cache.entries;
            throw e;
        }
        const keep = fresh
            .filter(e => RATE_FIELDS[e.field] && Number(e.at) > cutoff)
            .map(e => ({ id: e.id, field: e.field, old: e.old ?? null, new: e.new ?? null, at: Number(e.at) }));
        const entries = mergeHistoryEntries(cache.entries, keep).slice(0, HISTORY_MAX);
        writeJson(key, { v: 1, cutoff, entries });
        return entries;
    },

    async loadItemSeries(itemId) {
        const cutoff = this.cutoffMs();
        const item = (AppState.items || []).find(i => i.id === itemId);
        if (!cutoff || !item) {
            this.series = null;
            this.seriesNote = null;
            this.seriesItemId = itemId;
            return;
        }
        let entries = [];
        let note = null;
        try {
            entries = await this.loadHistoryEntries(itemId, cutoff);
        } catch (e) {
            // Rules not published yet (or offline): fall back to the current Items-page rate.
            note = isDenied(e) ? 'denied' : 'offline';
            entries = note === 'offline' ? (e.cachedEntries || []) : [];
            console.warn('Rate trends: Items-page rate changes not read:', e?.code || e);
        }
        if (itemId !== this.itemId) return;
        this.series = itemRateSeries(item, entries, { cutoffMs: cutoff, now: Date.now() });
        this.seriesNote = note;
        this.seriesItemId = itemId;
    },

    /** First month shown (null = all). */
    rangeStart() {
        if (this.range === 'all') return null;
        const n = Number(this.range) || 24;
        return addMonths(istMonthKey(Date.now()), -(n - 1));
    },

    /** First period shown for the current Weekly / Monthly choice (null = all). */
    periodStart() {
        const from = this.rangeStart();
        if (!from) return null;
        return this.period === 'week' ? istWeekStart(istMonthStartMs(from)) : from;
    },

    visibleRows() {
        const rows = trendRows(this.period === 'week' ? this.weekB : this.monthB, this.period);
        const from = this.periodStart();
        return from ? rows.filter(r => r.period >= from) : rows;
    },

    nextPeriod(p) {
        return this.period === 'week' ? addWeeks(p, 1) : addMonths(p, 1);
    },

    /** Every period from the first to the last of `list` (sorted keys). */
    periodAxis(list) {
        const sorted = [...new Set(list)].sort();
        const out = [];
        if (sorted.length) for (let p = sorted[0]; p && p <= sorted[sorted.length - 1]; p = this.nextPeriod(p)) out.push(p);
        return out;
    },

    /**
     * Rate line per kind: bill averages up to the cutoff period, Items-page
     * time-weighted rate from the cutoff period on (both in the cutoff period).
     */
    lineData() {
        const rows = this.visibleRows();
        const cut = this.period === 'week' ? cutoffWeek(this.cutoffMs()) : cutoffMonth(this.cutoffMs());
        const from = this.periodStart();
        const bills = {};
        const items = {};
        ITEM_RATE_KINDS.forEach(k => {
            bills[k] = {};
            items[k] = {};
            rows.forEach(r => { if (r[k] !== null && (!cut || r.period <= cut)) bills[k][r.period] = r[k]; });
            const values = (this.period === 'week' ? this.series?.[k]?.weekly : this.series?.[k]?.monthly) || {};
            Object.keys(values).forEach(p => { if (!from || p >= from) items[k][p] = values[p]; });
        });
        const periods = this.periodAxis([...rows.map(r => r.period), ...ITEM_RATE_KINDS.flatMap(k => Object.keys(items[k]))]);
        return { periods, bills, items, cut, rows };
    },

    render() {
        const chart = document.getElementById('rtChartView');
        const table = document.getElementById('rtTableView');
        if (chart) chart.style.display = this.view === 'chart' ? '' : 'none';
        if (table) table.style.display = this.view === 'table' ? '' : 'none';
        this.renderSourceNote();
        this.renderOutlook();
        if (this.view === 'chart') {
            this.drawRateChart();
            this.drawVolumeChart();
            this.drawYearChart();
        } else {
            this.renderTable();
            this.renderSteps();
        }
    },

    renderSourceNote() {
        const el = document.getElementById('rtSourceNote');
        if (!el) return;
        const cutoff = this.cutoffMs();
        if (!cutoff) {
            el.innerHTML = '';
            return;
        }
        const parts = [esc(t('ui.trends.source_note', { date: dateText(cutoff) }))];
        if (this.seriesNote === 'denied') parts.push(`<span class="rt-warn-inline">${esc(t('ui.trends.items_history_off'))}</span>`);
        if (this.seriesNote === 'offline') parts.push(`<span class="rt-warn-inline">${esc(t('ui.trends.items_history_offline'))}</span>`);
        el.innerHTML = parts.join('<br>');
    },

    outlookFor(kind) {
        const cut = cutoffMonth(this.cutoffMs());
        return seasonalOutlookCombined({
            bills: monthSeries(this.monthB, kind),
            items: (cut && this.series?.[kind]?.monthly) || {},
            cutoffMonth: cut
        }, { now: Date.now(), weeks: this.weeks });
    },

    renderOutlook() {
        const el = document.getElementById('rtOutlook');
        if (!el) return;
        if (!this.monthB.length && !this.series) {
            el.innerHTML = `<div class="rt-empty">${esc(t('ui.trends.no_history_item'))}</div>`;
            return;
        }
        el.innerHTML = ITEM_RATE_KINDS.map(kind => {
            const label = fieldLabel(kind);
            const o = this.outlookFor(kind);
            const why = explainOutlook(o);
            if (o.status !== 'ok') {
                return `<div class="rt-outlook rt-outlook-none"><div class="rt-outlook-head">${esc(t('ui.trends.not_enough', { label }))}</div>
                    <div class="rt-muted">${esc(why)}</div></div>`;
            }
            const arrow = o.direction === 'up' ? '▲' : o.direction === 'down' ? '▼' : '▬';
            return `<div class="rt-outlook rt-outlook-${o.direction}">
                <div class="rt-outlook-head"><span class="rt-arrow">${arrow}</span> ${esc(label)}: ${esc(t(DIRECTION_KEYS[o.direction]))}</div>
                <div class="rt-outlook-meta"><span class="rt-conf rt-conf-${o.confidence}">${esc(t(CONFIDENCE_KEYS[o.confidence]))}</span>
                    ${esc(t('ui.trends.years_of_data', { n: o.seasons }))}</div>
                <div class="rt-muted">${esc(why)}</div></div>`;
        }).join('');
    },

    periodLabel(p, withYear = true) {
        const lang = getLang();
        if (this.period === 'month') return monthLabel(p, lang, withYear);
        const day = Number(p.slice(8, 10));
        return t('ui.trends.week_of', { date: `${day} ${monthLabel(p.slice(0, 7), lang, withYear)}` });
    },

    renderTable() {
        const el = document.getElementById('rtTable');
        if (!el) return;
        const { periods, bills, items, cut, rows } = this.lineData();
        const byPeriod = new Map(rows.map(r => [r.period, r]));
        if (!periods.length) {
            el.innerHTML = `<div class="rt-empty">${esc(t('ui.trends.no_data'))}</div>`;
            return;
        }
        const body = periods.slice().reverse().map(p => {
            const r = byPeriod.get(p);
            const fromItems = cut && p > cut;
            const rate = (k) => rupees(fromItems ? items[k][p] : bills[k][p]);
            if (!r && !fromItems) return '';
            return `<tr><td>${esc(this.periodLabel(p))}</td><td>${rate('purchase')}</td><td>${rate('wholesale')}</td><td>${rate('retail')}</td>
                <td class="rt-src">${esc(t(fromItems ? 'ui.trends.src_items' : 'ui.trends.src_bills'))}</td>
                <td class="${r?.margin < 0 ? 'rt-neg' : ''}">${rupees(r ? r.margin : null)}</td>
                <td>${kgText(r?.kgBought)}</td><td>${kgText(r?.kgSold)}</td><td>${r ? r.bills : 0}</td></tr>`;
        }).join('');
        el.innerHTML = `<table class="rt-table"><thead><tr>
            <th>${esc(t(this.period === 'week' ? 'ui.trends.th_week' : 'ui.trends.th_month'))}</th><th>${esc(t('ui.trends.purchase'))}</th><th>${esc(t('ui.trends.wholesale'))}</th>
            <th>${esc(t('ui.trends.retail'))}</th><th>${esc(t('ui.trends.rate_source'))}</th><th>${esc(t('ui.trends.margin_kg'))}</th>
            <th>${esc(t('ui.trends.bought'))}</th><th>${esc(t('ui.trends.sold'))}</th><th>${esc(t('ui.trends.bills'))}</th></tr></thead>
            <tbody>${body}</tbody></table>`;
    },

    renderSteps() {
        const el = document.getElementById('rtSteps');
        if (!el) return;
        const cutoff = this.cutoffMs();
        if (!cutoff) {
            el.innerHTML = `<div class="rt-empty">${esc(t('ui.trends.steps_after_history'))}</div>`;
            return;
        }
        const rows = rateChangeRows(this.series);
        const current = ITEM_RATE_KINDS.map(k => `${esc(t(KIND_KEYS[k]))}: ${rupees(this.series?.[k]?.current ?? null)}`).join(' · ');
        const head = `<div class="rt-muted">${esc(t('ui.trends.current_items_rate'))} ${current}</div>`;
        if (!rows.length) {
            el.innerHTML = `${head}<div class="rt-empty">${esc(t('ui.trends.no_items_changes', { date: dateText(cutoff) }))}</div>`;
            return;
        }
        el.innerHTML = `${head}<table class="rt-table"><thead><tr><th>${esc(t('ui.trends.th_date'))}</th><th>${esc(t('ui.trends.th_rate'))}</th>
            <th>${esc(t('ui.trends.th_change'))}</th></tr></thead><tbody>
            ${rows.map(r => `<tr><td>${esc(dateText(r.at))}</td><td>${esc(t(KIND_KEYS[r.kind]))}</td><td>${rupees(r.from)} → ${rupees(r.to)}</td></tr>`).join('')}
            </tbody></table>`;
    },

    // ---------- charts (same hand-drawn canvas approach as Reports) ----------

    prepCanvas(id, height) {
        const canvas = document.getElementById(id);
        if (!canvas || !canvas.getContext) return null;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        canvas.width = Math.max(280, canvas.parentElement?.offsetWidth || 600);
        canvas.height = height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return { canvas, ctx };
    },

    noData(c) {
        c.ctx.font = '14px Arial';
        c.ctx.fillStyle = '#888';
        c.ctx.textAlign = 'center';
        c.ctx.fillText(t('ui.trends.no_data'), c.canvas.width / 2, c.canvas.height / 2);
    },

    /**
     * Lines over shared x labels with a min–max y scale (rates sit far above 0).
     * series: [{values: Array<number|null>, color, width?, dash?}]
     * marker: optional {index, label} vertical line.
     */
    drawLines(c, labels, series, marker = null) {
        const { ctx, canvas } = c;
        const values = series.flatMap(s => s.values).filter(v => v !== null && v !== undefined);
        if (!values.length) return this.noData(c);
        let lo = Math.min(...values);
        let hi = Math.max(...values);
        const pad = Math.max((hi - lo) * 0.1, hi * 0.02, 0.5);
        lo = Math.max(0, lo - pad);
        hi += pad;
        const left = 46;
        const right = 12;
        const top = 14;
        const bottom = 34;
        const w = canvas.width - left - right;
        const h = canvas.height - top - bottom;
        const step = labels.length > 1 ? w / (labels.length - 1) : 0;
        const xAt = (i) => left + (labels.length > 1 ? i * step : w / 2);
        const yAt = (v) => top + h - ((v - lo) / (hi - lo)) * h;
        const setDash = (d) => { if (ctx.setLineDash) ctx.setLineDash(d); };

        ctx.strokeStyle = '#e5e7eb';
        ctx.lineWidth = 1;
        ctx.fillStyle = '#6b7280';
        ctx.font = '10px Arial';
        ctx.textAlign = 'right';
        for (let g = 0; g <= 4; g++) {
            const v = lo + ((hi - lo) * g) / 4;
            const y = yAt(v);
            ctx.beginPath();
            ctx.moveTo(left, y);
            ctx.lineTo(canvas.width - right, y);
            ctx.stroke();
            ctx.fillText(`₹${v.toFixed(v < 100 ? 1 : 0)}`, left - 4, y + 3);
        }
        ctx.textAlign = 'center';
        const every = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(w / 46))));
        labels.forEach((l, i) => {
            if (i !== labels.length - 1 && (i % every !== 0 || labels.length - 1 - i < every)) return;
            const last = i === labels.length - 1 && labels.length > 1;
            ctx.textAlign = last ? 'right' : (i === 0 && labels.length > 1 ? 'left' : 'center');
            ctx.fillText(l, last ? xAt(i) + 4 : xAt(i), canvas.height - 14);
        });

        if (marker && marker.index >= 0 && marker.index < labels.length) {
            const x = xAt(marker.index);
            ctx.strokeStyle = '#6b7280';
            ctx.lineWidth = 1.5;
            setDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(x, top - 4);
            ctx.lineTo(x, top + h);
            ctx.stroke();
            setDash([]);
            ctx.fillStyle = '#374151';
            ctx.textAlign = x > canvas.width - 90 ? 'right' : 'left';
            ctx.fillText(marker.label, x + (ctx.textAlign === 'right' ? -4 : 4), top + 2);
        }

        series.forEach(s => {
            ctx.strokeStyle = s.color;
            ctx.fillStyle = s.color;
            ctx.lineWidth = s.width || 2.5;
            setDash(s.dash || []);
            ctx.beginPath();
            let drawing = false;
            s.values.forEach((v, i) => {
                if (v === null || v === undefined) {
                    drawing = false;
                    return;
                }
                if (!drawing) ctx.moveTo(xAt(i), yAt(v));
                else ctx.lineTo(xAt(i), yAt(v));
                drawing = true;
            });
            ctx.stroke();
            setDash([]);
            s.values.forEach((v, i) => {
                if (v === null || v === undefined) return;
                ctx.beginPath();
                ctx.arc(xAt(i), yAt(v), s.dash ? 2 : 3, 0, Math.PI * 2);
                ctx.fill();
            });
        });
        return undefined;
    },

    axisLabel(p) {
        const lang = getLang();
        if (this.period === 'week') return `${Number(p.slice(8, 10))} ${monthLabel(p.slice(0, 7), lang, false)}`;
        return `${monthLabel(p, lang, false)} ${p.slice(2, 4)}`;
    },

    drawRateChart() {
        const c = this.prepCanvas('rtRateChart', 240);
        if (!c) return;
        const { periods, bills, items, cut } = this.lineData();
        const series = [];
        ITEM_RATE_KINDS.forEach(k => {
            series.push({ values: periods.map(p => bills[k][p] ?? null), color: COLORS[k], dash: DASH, width: 2 });
            if (cut) series.push({ values: periods.map(p => items[k][p] ?? null), color: COLORS[k] });
        });
        const marker = cut ? { index: periods.indexOf(cut), label: t('ui.trends.cutoff_marker') } : null;
        this.drawLines(c, periods.map(p => this.axisLabel(p)), series, marker);
    },

    drawVolumeChart() {
        const c = this.prepCanvas('rtVolumeChart', 150);
        if (!c) return;
        const { ctx, canvas } = c;
        const rows = this.visibleRows();
        const periods = this.periodAxis(rows.map(r => r.period));
        if (!periods.length) return this.noData(c);
        const byPeriod = new Map(rows.map(r => [r.period, r]));
        const max = chartScaleMax(rows.flatMap(r => [r.kgBought, r.kgSold]));
        const left = 46;
        const bottom = 20;
        const h = canvas.height - bottom - 8;
        const slot = (canvas.width - left - 12) / periods.length;
        const barW = Math.max(1, Math.min(14, slot / 2 - 1));
        ctx.fillStyle = '#6b7280';
        ctx.font = '10px Arial';
        ctx.textAlign = 'right';
        ctx.fillText(kgText(max), left - 4, 14);
        ctx.fillText('0', left - 4, canvas.height - bottom);
        periods.forEach((p, i) => {
            const r = byPeriod.get(p);
            const x = left + i * slot + slot / 2 - barW;
            const hb = r ? (r.kgBought / max) * h : 0;
            const hs = r ? (r.kgSold / max) * h : 0;
            ctx.fillStyle = COLORS.bought;
            ctx.fillRect(x, canvas.height - bottom - hb, barW, hb);
            ctx.fillStyle = COLORS.sold;
            ctx.fillRect(x + barW + 1, canvas.height - bottom - hs, barW, hs);
        });
        return undefined;
    },

    drawYearChart() {
        const c = this.prepCanvas('rtYearChart', 220);
        if (!c) return;
        const series = monthSeries(this.monthB, this.compareKind);
        const years = [...new Set(Object.keys(series).map(m => Number(m.slice(0, 4))))].sort((a, b) => b - a).slice(0, YEAR_COLORS.length);
        const overlay = yearOverlay(series, years);
        const thisYear = Number(istMonthKey(Date.now()).slice(0, 4));
        const lang = getLang();
        const labels = Array.from({ length: 12 }, (_, i) => monthLabel(`2000-${String(i + 1).padStart(2, '0')}`, lang, false));
        this.drawLines(c, labels, years.map((y, i) => ({ values: overlay[y], color: YEAR_COLORS[i], width: y === thisYear ? 3.5 : 2 })));
        const legend = document.getElementById('rtYearLegend');
        if (legend) legend.innerHTML = years.map((y, i) => `<span><i style="background:${YEAR_COLORS[i]}"></i>${y}</span>`).join('');
    },

    // ---------- product traffic ----------

    fillTrafficPickers() {
        const lang = getLang();
        const monthSelect = document.getElementById('rtTrafficMonth');
        const months = recentMonths(Date.now(), 24);
        if (!this.trafficMonth || !months.includes(this.trafficMonth)) this.trafficMonth = months[0];
        if (monthSelect) {
            monthSelect.innerHTML = months.map(m => `<option value="${esc(m)}"${m === this.trafficMonth ? ' selected' : ''}>${esc(monthLabel(m, lang))}</option>`).join('');
        }
        const itemSelect = document.getElementById('rtTrafficItem');
        const ranked = itemsByUsage(AppState.items || [], loadedBills());
        if (!this.trafficItemId) this.trafficItemId = this.traffic?.rows?.[0]?.itemId || ranked[0]?.item.id || null;
        if (itemSelect) {
            itemSelect.innerHTML = ranked.length
                ? ranked.map(r => `<option value="${esc(r.item.id)}"${r.item.id === this.trafficItemId ? ' selected' : ''}>${esc(itemLabel(r.item))}</option>`).join('')
                : `<option value="">${esc(t('ui.trends.no_items'))}</option>`;
        }
        const weeksSelect = document.getElementById('rtTrafficWeeks');
        if (weeksSelect) {
            weeksSelect.innerHTML = TRAFFIC_WEEK_OPTIONS.map(n =>
                `<option value="${n}"${n === this.trafficWeeks ? ' selected' : ''}>${esc(t('ui.trends.last_n_weeks', { n }))}</option>`).join('');
        }
    },

    setTrafficWeeks(value) {
        const n = Number(value);
        this.trafficWeeks = TRAFFIC_WEEK_OPTIONS.includes(n) ? n : 26;
        return this.loadWeekly();
    },

    setTrafficMonth(month) {
        this.trafficMonth = month;
        return this.loadTraffic();
    },

    setTrafficItem(itemId) {
        this.trafficItemId = itemId || null;
        const select = document.getElementById('rtTrafficItem');
        if (select && select.value !== itemId) select.value = itemId;
        this.renderDaily();
        return this.loadWeekly();
    },

    /**
     * Every item's year doc for one year (≤ YEAR_MAX reads). Settled years are
     * kept on the device per backfill, so reopening them costs no reads.
     */
    async yearStats(year) {
        if (this.yearDocs.has(year)) return this.yearDocs.get(year);
        const at = Number(this.meta?.backfillAt) || 0;
        const settled = isSettledYear(year, Date.now());
        if (settled) {
            const cached = readJson(`${YEAR_CACHE_PREFIX}${year}`);
            if (cached && cached.at === at && Array.isArray(cached.docs)) {
                const res = { docs: cached.docs, more: !!cached.more };
                this.yearDocs.set(year, res);
                return res;
            }
        }
        const res = await FirebaseService.loadRateStatsForYear(year, YEAR_MAX);
        const compact = { docs: res.docs.filter(d => d.itemId && String(d.year) === year).map(compactYearDoc), more: res.more };
        this.yearDocs.set(year, compact);
        if (settled) writeJson(`${YEAR_CACHE_PREFIX}${year}`, { at, ...compact });
        return compact;
    },

    async monthStats(month) {
        const res = await this.yearStats(month.slice(0, 4));
        return { docs: monthBucketsFor(res.docs, month), more: res.more };
    },

    async loadTraffic() {
        if (!canSee()) return;
        await this.loadMeta();
        this.fillTrafficPickers();
        const month = this.trafficMonth;
        if (this.metaError === 'denied') {
            this.traffic = { month, state: 'denied', rows: [] };
        } else if (!this.meta?.backfillDone) {
            this.traffic = { month, state: 'no-history', rows: [] };
        } else {
            this.traffic = { month, state: 'loading', rows: [] };
            this.renderTraffic();
            const { prev, lastYear } = comparisonMonths(month);
            try {
                const [cur, p, ly] = await Promise.all([
                    this.monthStats(month),
                    this.monthStats(prev).catch(() => null),
                    this.monthStats(lastYear).catch(() => null)
                ]);
                if (month !== this.trafficMonth) return;
                this.traffic = { month, state: 'ok', more: cur.more, rows: trafficRows(cur.docs, p?.docs ?? null, ly?.docs ?? null) };
            } catch (e) {
                if (month !== this.trafficMonth) return;
                this.traffic = { month, state: isDenied(e) ? 'denied' : 'error', rows: [] };
                console.warn('Rate trends: month not read:', e?.code || e);
            }
        }
        if (!this.trafficItemId && this.traffic.rows[0]) this.trafficItemId = this.traffic.rows[0].itemId;
        this.fillTrafficPickers();
        this.renderTraffic();
        await this.loadWeekly();
    },

    /** One item week by week over the chosen number of weeks (its year docs: one read per year). */
    async loadWeekly() {
        const itemId = this.trafficItemId;
        const el = document.getElementById('rtWeekly');
        if (!el) return;
        if (!itemId || this.metaError === 'denied' || !this.meta?.backfillDone) {
            el.innerHTML = `<div class="rt-empty">${esc(t(this.meta?.backfillDone ? 'ui.trends.no_data' : 'ui.trends.traffic_needs_history'))}</div>`;
            return;
        }
        let docs;
        try {
            docs = await this.itemYearDocs(itemId);
        } catch (e) {
            console.warn('Rate trends: item weeks not read:', e?.code || e);
            if (itemId === this.trafficItemId) el.innerHTML = `<div class="rt-warn">${esc(t('ui.trends.traffic_error'))}</div>`;
            return;
        }
        if (itemId !== this.trafficItemId) return;
        this.renderWeekly(docs);
    },

    renderWeekly(docs) {
        const el = document.getElementById('rtWeekly');
        if (!el) return;
        const now = Date.now();
        const rows = weeklyItemRows(weekBuckets(docs), weeksBackStart(now, this.trafficWeeks), istWeekStart(now));
        if (!rows.some(r => r.kg > 0)) {
            el.innerHTML = `<div class="rt-empty">${esc(t('ui.trends.no_data'))}</div>`;
            return;
        }
        const lang = getLang();
        const label = (w) => `${Number(w.slice(8, 10))} ${monthLabel(w.slice(0, 7), lang)}`;
        const cell = (s) => (s.kg > 0 ? `${kgText(s.kg)} <span class="rt-muted">(${s.bills})</span>` : '—');
        el.innerHTML = `<table class="rt-table"><thead><tr><th>${esc(t('ui.trends.th_week'))}</th><th>${esc(t('ui.trends.th_total_kg'))}</th>
            ${TRAFFIC_KINDS.map(k => `<th>${esc(t(KIND_KEYS[k]))}</th>`).join('')}</tr></thead><tbody>
            ${rows.map(r => `<tr><td>${esc(t('ui.trends.week_of', { date: label(r.week) }))}</td><td>${r.kg > 0 ? `<strong>${kgText(r.kg)}</strong>` : '—'}</td>
                ${TRAFFIC_KINDS.map(k => `<td>${cell(r[k])}</td>`).join('')}</tr>`).join('')}
            </tbody></table>`;
    },

    renderTraffic() {
        const el = document.getElementById('rtTrafficTable');
        if (!el) return;
        const tr = this.traffic;
        const lang = getLang();
        if (!tr) {
            el.innerHTML = '';
        } else if (tr.state === 'loading') {
            el.innerHTML = `<div class="rt-empty">${esc(t('ui.trends.loading'))}</div>`;
        } else if (tr.state === 'denied') {
            el.innerHTML = `<div class="rt-note">${esc(t('ui.trends.rules_not_published'))}</div>`;
        } else if (tr.state === 'no-history') {
            el.innerHTML = `<div class="rt-note">${esc(t('ui.trends.traffic_needs_history'))}</div>`;
        } else if (tr.state === 'error') {
            el.innerHTML = `<div class="rt-warn">${esc(t('ui.trends.traffic_error'))}</div>`;
        } else if (!tr.rows.length) {
            el.innerHTML = `<div class="rt-empty">${esc(t('ui.trends.traffic_empty', { month: monthLabel(tr.month, lang) }))}</div>`;
        } else {
            const { prev, lastYear } = comparisonMonths(tr.month);
            const cell = (s) => `${kgText(s.kg)}<div class="rt-muted">${esc(t('ui.trends.n_bills', { n: s.bills }))}</div>`;
            const rows = tr.rows.map(r => `<tr class="rt-click${r.itemId === this.trafficItemId ? ' rt-selected' : ''}" data-item="${esc(r.itemId)}"
                onclick="window.app.rateTrends.setTrafficItem('${Helpers.escapeJsAttr(r.itemId)}')">
                <td>${esc(itemName(r.itemId))}</td><td><strong>${kgText(r.kg)}</strong></td>
                ${TRAFFIC_KINDS.map(k => `<td>${cell(r[k])}</td>`).join('')}
                <td>${r.bills}</td><td>${rupees(r.amount)}</td>
                <td class="${r.vsPrev < 0 ? 'rt-neg' : ''}">${pctText(r.vsPrev)}</td>
                <td class="${r.vsLastYear < 0 ? 'rt-neg' : ''}">${pctText(r.vsLastYear)}</td></tr>`).join('');
            el.innerHTML = `<table class="rt-table"><thead><tr><th>${esc(t('ui.trends.th_item'))}</th><th>${esc(t('ui.trends.th_total_kg'))}</th>
                ${TRAFFIC_KINDS.map(k => `<th>${esc(t(KIND_KEYS[k]))}</th>`).join('')}
                <th>${esc(t('ui.trends.bills'))}</th><th>${esc(t('ui.trends.th_amount'))}</th>
                <th>${esc(t('ui.trends.vs_month', { month: monthLabel(prev, lang) }))}</th>
                <th>${esc(t('ui.trends.vs_month', { month: monthLabel(lastYear, lang) }))}</th></tr></thead>
                <tbody>${rows}</tbody></table>
                ${tr.more ? `<div class="rt-muted">${esc(t('ui.trends.traffic_more', { n: YEAR_MAX }))}</div>` : ''}`;
        }
        this.renderDaily();
    },

    renderDaily() {
        const el = document.getElementById('rtDaily');
        if (!el) return;
        const itemId = this.trafficItemId;
        const month = this.trafficMonth;
        const lang = getLang();
        if (!itemId || !month) {
            el.innerHTML = `<div class="rt-empty">${esc(t('ui.trends.no_data'))}</div>`;
            return;
        }
        document.querySelectorAll('#rtTrafficTable tr.rt-click').forEach(tr => tr.classList.toggle('rt-selected', tr.dataset.item === itemId));
        const head = `<tr><th></th>${TRAFFIC_KINDS.map(k => `<th>${esc(t(KIND_KEYS[k]))}</th>`).join('')}</tr>`;
        const cells = (d) => TRAFFIC_KINDS.map(k => `<td>${d[k].kg > 0 ? `${kgText(d[k].kg)} <span class="rt-muted">(${d[k].bills})</span>` : '—'}</td>`).join('');
        if (!dailyDetailAvailable(month, AppState.historyLoadedFrom)) {
            const row = this.traffic?.month === month ? this.traffic.rows.find(r => r.itemId === itemId) : null;
            const total = row || { purchase: { kg: 0, bills: 0 }, wholesale: { kg: 0, bills: 0 }, retail: { kg: 0, bills: 0 } };
            el.innerHTML = `<div class="rt-note">${esc(t('ui.trends.daily_unavailable'))}</div>
                <table class="rt-table"><thead>${head}</thead><tbody><tr><td>${esc(monthLabel(month, lang))}</td>${cells(total)}</tr></tbody></table>`;
            return;
        }
        const d = dailyTraffic(loadedBills(), AppState.items || [], itemId, month);
        const moved = (x) => TRAFFIC_KINDS.some(k => x[k].kg > 0);
        if (!moved(d.total)) {
            el.innerHTML = `<div class="rt-empty">${esc(t('ui.trends.no_movement', { month: monthLabel(month, lang) }))}</div>`;
            return;
        }
        const weekRows = d.weeks.map(w => `<tr class="rt-week"><td>${esc(t('ui.trends.week_n', { n: w.week, from: w.from, to: w.to }))}</td>${cells(w)}</tr>`).join('');
        const dayRows = d.days.filter(moved).map(x => `<tr><td>${esc(`${Number(x.day.slice(8, 10))} ${monthLabel(month, lang, false)}`)}</td>${cells(x)}</tr>`).join('');
        el.innerHTML = `<div class="rt-muted">${esc(t('ui.trends.daily_hint'))}</div>
            <table class="rt-table"><thead>${head}</thead><tbody>${weekRows}
            <tr class="rt-total"><td>${esc(t('ui.trends.total'))}</td>${cells(d.total)}</tr>
            ${dayRows}</tbody></table>`;
    }
};
