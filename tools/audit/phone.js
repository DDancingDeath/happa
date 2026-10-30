/**
 * @fileoverview The phone path of the real-data number audit.
 *
 * The rest of the audit computes every figure with FULL history in memory. Phones
 * don't: they load a window (from the 1st of the previous month), older bills that
 * still have a due, the stock checkpoint, month snapshots (`monthStats`), the rate
 * history (`rateStats`) and cash sessions through their own loaders. Money,
 * Insights and Statements then compare periods with snapshots and partial figures.
 *
 * This module runs that path on a backup: the app's own FirebaseService against an
 * in-memory Firestore (www/js/__tests__/__mocks__/fake-firestore.js) seeded with
 * the backup as it stood at each moment (records dated after it removed, later due
 * payments undone). A phone that has been in use for months is simulated on one
 * timeline: on its first day the owner builds the month history and the rate
 * history; at the end of every month it opens again, so Money rolls the month
 * snapshots and Rate trends rolls the rate history forward, exactly as the app does.
 * On each audited day the window, dues listeners, checkpoint, snapshots and cash
 * sessions are loaded the way a phone loads them, and every Money, Insights,
 * Statements and Today figure is taken from the app's modules and compared with
 * the oracle on the full data of that moment.
 *
 * A figure the app leaves out on purpose (not loaded, no snapshot, a part month a
 * snapshot can't split) is counted as "shown as unknown", never as a mismatch,
 * provided the screen says so. No party names leave this file: rows carry spec IDs,
 * dates, amounts and counts.
 */
import fs from 'fs';
import path from 'path';
import * as O from '../../tests/oracle/oracle.js';
import { isoDay } from './audit-lib.js';
import { createFakeFirestore } from '../../www/js/__tests__/__mocks__/fake-firestore.js';
import { FirebaseService } from '@app/firebase/firestore-service.js';
import { AppState } from '@app/utils/state.js';
import { MoneyManager } from '@app/modules/money.js';
import { InsightsManager, soldKgByMonth } from '@app/modules/insights.js';
import { StatementsManager } from '@app/modules/statements.js';
import { DayManager } from '@app/modules/day.js';
import { CashManagementManager } from '@app/modules/cash-management.js';
import { RateTrendsManager } from '@app/modules/rate-trends.js';
import { newCursor } from '@app/utils/rate-trends.js';
import { outstandingDue } from '@app/utils/money.js';
import {
    moneySummary, comparisonRanges, change, itemSummary, partySummary, outstandingTotals, overdueParties, periodRange
} from '@app/utils/business-metrics.js';
import { figuresFromSnapshot, monthBounds, monthKeyOf, lastMonthKeys } from '@app/utils/month-snapshots.js';
import { dayBook } from '@app/utils/statements.js';
import { setInsightsContext, resetInsightsContextForTests } from '@app/utils/insights-context.js';

const DAY = 86400000;
const r2 = O.r2;
const num = (v) => { const x = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(x) ? x : 0; };
const evTime = (r) => (typeof r.timestamp === 'number' ? r.timestamp : O.timeOf(r.date));
const HISTORY = { purchases: 'purchases', wholesaleSales: 'wholesaleSales', retailSales: 'retailSales', stockAdjustments: 'stockAdjustments', expenses: 'expenses', withdrawals: 'withdrawals' };
const DO_NOT_FAKE = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    'queueMicrotask', 'hrtime', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'];

// ------------------------------------------------------------------ dates

/**
 * The audited "today"s: the backup's moment; the 1st, 2nd and 15th of its month
 * (of the month before when not reached yet); 31 March and 1 January of the
 * latest year that has reached them. Past days are looked at at 9 pm.
 * @param {number} nowMs
 * @returns {Array<{label: string, ms: number}>} oldest first
 */
export function phoneDates(nowMs) {
    const d = new Date(nowMs);
    const at = (y, m, day) => new Date(y, m, day, 21, 0).getTime();
    const out = [{ label: 'today', ms: nowMs }];
    [1, 2, 15].forEach(day => {
        let ms = at(d.getFullYear(), d.getMonth(), day);
        if (ms >= nowMs) ms = at(d.getFullYear(), d.getMonth() - 1, day);
        out.push({ label: `${day === 1 ? '1st' : day === 2 ? '2nd' : '15th'} of the month`, ms });
    });
    const mar = at(d.getFullYear(), 2, 31) < nowMs ? at(d.getFullYear(), 2, 31) : at(d.getFullYear() - 1, 2, 31);
    out.push({ label: '31 Mar', ms: mar });
    out.push({ label: '1 Jan', ms: at(d.getFullYear(), 0, 1) < nowMs ? at(d.getFullYear(), 0, 1) : at(d.getFullYear() - 1, 0, 1) });
    return out.sort((a, b) => a.ms - b.ms);
}

/** Parses `--phone-dates 2026-10-01,2026-03-31T21:00` (local time; a bare date means 9 pm). */
export function parsePhoneDates(text) {
    return String(text).split(',').map(s => s.trim()).filter(Boolean).map(s => {
        const ms = /T/.test(s) ? O.timeOf(s) : O.timeOf(`${s}T21:00`);
        if (!Number.isFinite(ms)) throw new Error(`Not a date: ${s}`);
        return { label: s, ms };
    }).sort((a, b) => a.ms - b.ms);
}

// ------------------------------------------------------------------ the data at a moment

/** A bill as it stood at `at`: later due payments / write-offs taken back off it. */
export function billAt(bill, at) {
    const pays = Array.isArray(bill.payments) ? bill.payments : [];
    const later = pays.filter(p => (p.at ?? O.timeOf(p.date)) > at);
    if (!later.length) return bill;
    let cash = 0;
    let online = 0;
    let off = 0;
    later.forEach(p => {
        if (p.kind === 'writeOff') off += num(p.amount);
        else if (p.cash !== undefined || p.online !== undefined) { cash += num(p.cash); online += num(p.online); } else cash += num(p.amount);
    });
    const out = { ...bill, payments: pays.filter(p => !later.includes(p)) };
    if (bill.payment && typeof bill.payment === 'object') {
        const p = { ...bill.payment };
        if (p.cash !== undefined) p.cash = r2(num(p.cash) - cash);
        if (p.online !== undefined) p.online = r2(num(p.online) - online);
        if (p.writtenOff !== undefined) p.writtenOff = r2(num(p.writtenOff) - off);
        if (p.due !== undefined) p.due = r2(num(p.due) + cash + online + off);
        out.payment = p;
    }
    if (bill.cashPayment !== undefined) out.cashPayment = r2(num(bill.cashPayment) - cash);
    if (bill.onlinePayment !== undefined) out.onlinePayment = r2(num(bill.onlinePayment) - online);
    if (bill.dueAmount !== undefined) out.dueAmount = r2(num(bill.dueAmount) + cash + online + off);
    if (out.cleared) out.cleared = false;
    // The app keeps `openDue` in step with the due on every payment write.
    if (bill.openDue !== undefined) out.openDue = outstandingDue(out) > 0.005;
    return out;
}

/** The backup as it stood at `at`: nothing dated later, later payments undone, sessions up to that day. */
export function dataAt(data, at) {
    const day = isoDay(at);
    const upTo = (list) => (list || []).filter(r => !(evTime(r) > at));
    const bills = (list) => upTo(list).map(b => billAt(b, at));
    return {
        items: data.items,
        purchases: bills(data.purchases),
        wholesaleSales: bills(data.wholesaleSales),
        retailSales: bills(data.retailSales),
        stockAdjustments: upTo(data.stockAdjustments),
        expenses: (data.expenses || []).filter(e => !(O.timeOf(e.date) > at)),
        withdrawals: (data.withdrawals || []).filter(w => !(O.timeOf(w.date) > at)),
        sessions: (data.sessions || []).filter(s => String(s.date) <= day).map(s => ({
            ...s, duePayments: (s.duePayments || []).filter(l => !((l.at ?? O.timeOf(l.date)) > at))
        }))
    };
}

// ------------------------------------------------------------------ the phone

const settle = async (fake, rounds = 12) => {
    for (let i = 0; i < rounds; i++) {
        await fake.settle();
        await new Promise(r => setTimeout(r, 0));
    }
};

/** Seeds the in-memory Firestore with the backup as it stood at `at` (app-written docs stay). */
function seedAt(fake, data, at) {
    const now = dataAt(data, at);
    Object.keys(HISTORY).forEach(k => {
        fake.raw(k).clear();
        fake.seed(k, now[k]);
    });
    fake.raw('cashManagement').clear();
    fake.seed('cashManagement', now.sessions);
    fake.raw('items').clear();
    fake.seed('items', now.items);
    // Outdated apps stopped writing timestamp-less docs long ago: no legacy scans.
    fake.seed('stockCheckpoints', [{ id: 'legacyScan', ...Object.fromEntries(Object.keys(HISTORY).map(c => [c, { v: 2, complete: true, foundAt: 0 }])) }]);
    return now;
}

async function openApp(fake) {
    FirebaseService.cleanup();
    await FirebaseService.setupRealtimeListeners();
    await FirebaseService.getStock();
    await settle(fake);
}

/** Every module's in-memory state back to a fresh app start. */
function freshModules() {
    Object.assign(MoneyManager, { snapshots: {}, snapshotsLoaded: false, sessionCache: new Map(), drawerCache: null, building: false, lastSummary: null, summaryCache: { sig: null, map: new Map(), computed: 0 } });
    Object.assign(InsightsManager, { seasonDocs: null, seasonLoading: null });
    RateTrendsManager.yearDocs.clear();
    RateTrendsManager.statsByItem.clear();
    RateTrendsManager.meta = undefined;
    RateTrendsManager.rolling = null;
    CashManagementManager.todaySession = null;
    resetInsightsContextForTests();
}

/**
 * Opens the app at `at` as a phone does: the stock checkpoint is (re)built by the
 * owner device first (full read once), then the app opens again and reads only the
 * window, the dues and the checkpoint.
 */
async function phoneOpen(fake, at) {
    jest.setSystemTime(new Date(at));
    fake.raw('stockCheckpoints').delete('current');
    freshModules();
    await openApp(fake);
    const rebuilt = await FirebaseService.rebuildStockCheckpoint();
    await settle(fake);
    freshModules();
    await openApp(fake);
    return { rebuilt: rebuilt.status, loadedFrom: AppState.historyLoadedFrom, checkpoint: FirebaseService.getStockCheckpointState() };
}

/** Owner's first day: "Build history" (month snapshots) and the rate-history backfill. */
async function firstDay(fake) {
    await MoneyManager.buildHistory();
    localStorage.setItem('aadhatRateStatsBudget', '20000');
    localStorage.setItem('aadhatRateStatsBackfill', JSON.stringify(newCursor(Date.now())));
    await RateTrendsManager.runBackfill();
    await settle(fake);
}

/** What a phone does on every open of Money and Rate trends: roll the month snapshots and the rate history. */
async function rollEverything(fake) {
    await MoneyManager.loadSnapshots();
    await RateTrendsManager.rollForward({ force: true });
    await settle(fake);
}

// ------------------------------------------------------------------ reading the screens

const shownNumber = (text) => {
    const s = String(text ?? '').replace(/[,\s₹]/g, '').replace(/−/g, '-');
    const m = s.match(/^([+-]?)(\d+(?:\.\d+)?)/);
    return m ? (m[1] === '-' ? -1 : 1) * Number(m[2]) : NaN;
};
const shown = (id) => shownNumber(document.getElementById(id)?.textContent);
const tpl = (root, name) => fs.readFileSync(path.join(root, 'www', 'templates', name), 'utf8');

// ------------------------------------------------------------------ comparisons

/**
 * Audits the phone path for each date and records into the collector (scope 'phone').
 * @param {Object} args
 * @param {import('./audit-lib.js').Collector} args.C
 * @param {Object} args.data loadBackup().data
 * @param {Array<{label: string, ms: number}>} args.dates
 * @param {string} args.appRoot checkout whose www/ templates are used
 * @param {{firstDip: number, cleanAgrees: boolean}} args.stockEvidence from the full-history audit
 * @returns {Promise<{dates: Array<Object>, evidence: Object}>}
 */
export async function auditPhone({ C, data, dates, appRoot, stockEvidence }) {
    jest.useRealTimers();
    jest.useFakeTimers({ doNotFake: DO_NOT_FAKE });
    if (FirebaseService.loadCashSessionsBetween?.mockRestore) FirebaseService.loadCashSessionsBetween.mockRestore();
    const fake = createFakeFirestore();
    const savedFirebase = global.firebase;
    global.firebase = fake.firebase;
    AppState.currentUser = { uid: 'audit-owner' };
    AppState.userRole = 'owner';
    AppState.userName = 'Audit';
    AppState.settings = { showHindi: false };
    localStorage.clear();

    const T = { money: tpl(appRoot, 'money.html'), statements: tpl(appRoot, 'statements.html') };
    const scope = 'phone';
    const tolOf = { money: 1, kg: 0.01, count: 0 };
    const cmp = (spec, page, period, oracle, app, full, end, unit = 'money') =>
        C.compare({ spec, page, period, oracle, app, unit, scope, extra: { full: full === undefined ? null : full, end } });
    const unknown = (spec, page, period, reason, oracle, unit = 'money') => C.unknown({ spec, page, period, reason, oracle, unit, scope });

    // Timeline: the first day, every month end in between, every audited day.
    const firstBill = Math.min(...['purchases', 'wholesaleSales', 'retailSales'].flatMap(k => (data[k] || []).map(evTime)).filter(Number.isFinite));
    const fm = new Date(Number.isFinite(firstBill) ? firstBill : dates[0].ms);
    const start = Math.min(dates[0].ms, new Date(fm.getFullYear(), fm.getMonth() + 1, 0, 22, 0).getTime());
    const events = [{ ms: start, kind: 'first' }];
    for (let d = new Date(new Date(start).getFullYear(), new Date(start).getMonth() + 1, 0, 23, 0); d.getTime() < dates[dates.length - 1].ms;
        d = new Date(d.getFullYear(), d.getMonth() + 2, 0, 23, 0)) {
        if (d.getTime() > start) events.push({ ms: d.getTime(), kind: 'roll' });
    }
    dates.forEach(x => events.push({ ms: x.ms, kind: 'audit', label: x.label }));
    events.sort((a, b) => a.ms - b.ms || (a.kind === 'first' ? -1 : b.kind === 'first' ? 1 : 0));

    const summary = [];
    try {
        for (const ev of events) {
            seedAt(fake, data, ev.ms);
            const open = await phoneOpen(fake, ev.ms);
            if (ev.kind === 'first') {
                await firstDay(fake);
                await rollEverything(fake);
                if (!events.some(e => e.kind === 'audit' && e.ms === ev.ms)) continue;
            }
            if (ev.kind === 'roll') { await rollEverything(fake); continue; }
            if (ev.kind === 'first') continue;
            await rollEverything(fake);
            const info = await auditOneDay({ fake, data, at: ev.ms, label: ev.label, open, cmp, unknown, T });
            summary.push(info);
        }
    } finally {
        FirebaseService.cleanup();
        global.firebase = savedFirebase;
        jest.useRealTimers();
    }

    const ofScope = (row) => row.full !== null && row.full !== undefined && Number.isFinite(Number(row.full))
        && Math.abs(Number(row.app) - Number(row.full)) <= (tolOf[row.unit] ?? 1) + 1e-9;
    return {
        dates: summary,
        evidence: {
            // Same number as the app with full history, on an item that went below zero before the period ended,
            // and the same figures without those items agree (checked by the full-history audit).
            negativeStock: (row) => ofScope(row) && stockEvidence.cleanAgrees && Number.isFinite(row.end) && stockEvidence.firstDip < row.end,
            sameAsFull: ofScope
        }
    };
}

async function auditOneDay({ fake, data, at, label, open, cmp, unknown, T }) {
    const now = dataAt(data, at);
    const day = isoDay(at);
    const fullBase = { state: {}, from: -Infinity };
    const full = (range, detail = true) => moneySummary({ ...now, sessions: [], base: fullBase }, range, { detail });
    const sessionOn = (d) => now.sessions.filter(s => s.date === d);
    const info = {
        label, date: day, loadedFrom: open.loadedFrom ? isoDay(open.loadedFrom) : 'all', rebuilt: open.rebuilt,
        checkpointAsOf: open.checkpoint ? isoDay(open.checkpoint.asOf) : null,
        bills: { loaded: ['purchaseHistory', 'salesHistory', 'retailSalesHistory'].reduce((a, k) => a + (AppState[k] || []).length, 0),
            all: now.purchases.length + now.wholesaleSales.length + now.retailSales.length },
        snapshots: 0, rateStatsDocs: 0
    };
    const P = (what) => `${day} · ${what}`;

    // ---------------- Money: each period, its previous period and last year
    document.body.innerHTML = T.money;
    document.getElementById('money').classList.add('active');
    for (const preset of ['this-month', 'last-month', 'last-30', 'this-year']) {
        resetInsightsContextForTests();
        setInsightsContext({ preset });
        MoneyManager.init('profit');
        await settle(fake);
        info.snapshots = Object.keys(MoneyManager.snapshots || {}).length;
        const r = MoneyManager.range();
        const end = Math.min(r.to, at + 1);
        if (!MoneyManager.covered(r.from)) {
            const box = document.getElementById('moneyNotLoaded');
            const said = box && !box.hidden && /load/i.test(box.textContent);
            const o = O.metrics(now, [r.from, r.to]);
            if (said) unknown('M1–M17', 'Money (phone)', P(preset), 'period not loaded: "load older bills" shown', o.M1_sales);
            else cmp('M1–M17_not_loaded_hidden', 'Money (phone)', P(preset), 1, 0, null, end, 'count');
            continue;
        }
        const sessions = MoneyManager.sessions(r);
        const m = MoneyManager.summary(r, { sessions, detail: true });
        const f = full(r);
        const o = O.metrics(now, [r.from, r.to]);
        [['M1_sales', m.M1.total, f.M1.total], ['M2_cogs', m.M2, f.M2], ['M3_gross', m.M3.total, f.M3.total], ['M4_businessExpenses', m.M4.total, f.M4.total],
            ['M5_badDebts', m.M5, f.M5], ['M6_profit', m.M6.total, f.M6.total], ['M7_labour', m.M7, f.M7], ['M8_personalExpenses', m.M8.total, f.M8.total],
            ['M9_withdrawals', m.M9, f.M9], ['M10_kept', m.M10, f.M10], ['M12_inCash', m.M12.cash, f.M12.cash], ['M12_inOnline', m.M12.online, f.M12.online],
            ['M13_outCash', m.M13.cash, f.M13.cash], ['M13_outOnline', m.M13.online, f.M13.online], ['M14_net', m.M14, f.M14], ['M16_purchases', m.M16.total, f.M16.total]]
            .forEach(([k, v, fv]) => {
                if (v === null) unknown(k, 'Money (phone)', P(preset), '"—" (cost of goods sold not known)', o[k]);
                else cmp(k, 'Money (phone)', P(preset), o[k], v, fv, end);
            });
        cmp('M1_saleCount', 'Money (phone)', P(preset), o.M1_saleCount, m.M1.count, f.M1.count, end, 'count');
        cmp('M16_purchaseCount', 'Money (phone)', P(preset), o.M16_purchaseCount, m.M16.count, f.M16.count, end, 'count');
        const dues = m.caveats.find(c => c.key === 'dues');
        if (dues) unknown('M12–M14', 'Money (phone)', P(preset), '"payments may be missing" shown (sessions not loaded)', o.M14_net);
        // Screen headline figures.
        const scr = {};
        MoneyManager.init('profit');
        Object.assign(scr, { M1_sales: shown('moneySales'), M2_cogs: shown('moneyCogs'), M6_profit: shown('moneyProfitValue'), M16_purchases: shown('moneyPurchases') });
        MoneyManager.init('cash');
        scr.M14_net = shown('moneyNetCash');
        MoneyManager.init('spending');
        Object.assign(scr, { M4_businessExpenses: shown('moneyBusiness'), M8_personalExpenses: shown('moneyPersonal'), M9_withdrawals: shown('moneyWithdrawn'), M7_labour: shown('moneyLabour') });
        const fullOf = { M1_sales: f.M1.total, M2_cogs: f.M2, M6_profit: f.M6.total, M16_purchases: f.M16.total, M14_net: f.M14,
            M4_businessExpenses: f.M4.total, M8_personalExpenses: f.M8.total, M9_withdrawals: f.M9, M7_labour: f.M7 };
        Object.entries(scr).forEach(([k, v]) => {
            if (Number.isNaN(v) && (k === 'M2_cogs' || k === 'M6_profit') && m.M2 === null) return;
            cmp(k, 'Money screen (phone)', P(preset), Math.round(o[k]), v, fullOf[k] === null ? null : Math.round(fullOf[k]), end);
        });

        // Previous period and last year (figuresFor: the loaded bills, else month snapshots).
        const cr = comparisonRanges(r);
        for (const [which, range] of [['previous', cr.previous], ['last year', cr.lastYear]]) {
            if (!range) continue;
            const fig = MoneyManager.figuresFor(range);
            const oo = O.metrics(now, [range.from, range.to]);
            const ff = full(range, false);
            const period = P(`${preset} vs ${which} (${isoDay(range.from)}…${isoDay(range.to - 1)})`);
            const source = MoneyManager.covered(range.from) ? 'bills' : 'snapshots';
            const page = `Money vs ${which} (phone, ${source})`;
            [['M1_sales', 'M1', ff.M1.total], ['M4_businessExpenses', 'M4', ff.M4.total], ['M6_profit', 'M6', ff.M6.total], ['M14_net', 'M14', ff.M14], ['M16_purchases', 'M16', ff.M16.total]]
                .forEach(([k, key, fv]) => {
                    const v = fig ? fig[key] : null;
                    if (v === null || v === undefined) {
                        if (Math.abs(oo[k]) > 0.5) unknown(k, page, period, fig ? 'part month from snapshots: only sales and profit' : 'no snapshot for a month: "no comparison"', oo[k]);
                        return;
                    }
                    cmp(k, page, period, oo[k], v, fv, range.to);
                });
            // The % shown (CMP) from the app's own now/then vs the oracle's (and the app's own with full history, as evidence).
            [['M6_profit', 'M6', m.M6.total, f.M6.total, ff.M6.total], ['M14_net', 'M14', m.M14, f.M14, ff.M14],
                ['M4_businessExpenses', 'M4', m.M4.total, f.M4.total, ff.M4.total]].forEach(([k, key, nowV, fullNow, fullThen]) => {
                const a = change(nowV, fig ? fig[key] ?? null : null);
                const w = change(o[k], oo[k]);
                const fa = change(fullNow, fullThen);
                if (!a && !w) return;
                if (!a) { unknown(`CMP_${k}`, page, period, '"no comparison" shown', w.pct, 'count'); return; }
                // Whole-% rounding of numbers within ₹1 of each other may differ by 1.
                cmp(`CMP_${k}`, page, period, w ? w.pct : null, w && Math.abs(a.pct - w.pct) <= 1 ? w.pct : a.pct, fa ? fa.pct : null, range.to, 'count');
            });
        }

        if (preset === 'this-month') {
            // M11: 13 months of profit as drawn (bars), last year (faint line) from snapshots.
            MoneyManager.init('profit');
            const bars = {};
            document.querySelectorAll('#moneyProfitChart rect[data-month]').forEach(rect => {
                bars[rect.dataset.month] = shownNumber(rect.querySelector('title')?.textContent.split(': ').pop());
            });
            lastMonthKeys(at, 13).forEach(k => {
                const b = monthBounds(k);
                const to = Math.min(b.to, r.to);
                const oo = O.metrics(now, [b.from, to]);
                const fromSnap = !MoneyManager.covered(b.from);
                const page = `Money chart M11 (phone, ${fromSnap ? 'snapshots' : 'bills'})`;
                if (!(k in bars)) {
                    if (Math.abs(oo.M6_profit) > 0.5) unknown('M11_profitByMonth', page, P(k), 'bar left out (no snapshot / profit not known)', oo.M6_profit);
                    return;
                }
                cmp('M11_profitByMonth', page, P(k), Math.round(oo.M6_profit), bars[k], Math.round(full({ from: b.from, to }, false).M6.total ?? NaN), to);
                const [y, mo] = k.split('-').map(Number);
                const lyKey = `${y - 1}-${String(mo).padStart(2, '0')}`;
                const ly = figuresFromSnapshot(MoneyManager.snapshots[lyKey])?.M6;
                const lyb = monthBounds(lyKey);
                const lyo = O.metrics(now, [lyb.from, lyb.to]).M6_profit;
                if (ly === null || ly === undefined) { if (Math.abs(lyo) > 0.5) unknown('M11_lastYearLine', 'Money chart M11 (phone, snapshots)', P(lyKey), 'no point drawn (no snapshot)', lyo); return; }
                cmp('M11_lastYearLine', 'Money chart M11 (phone, snapshots)', P(lyKey), lyo, ly, null, lyb.to);
            });

            // Month snapshots as stored: each figure vs the oracle for the part of the month they were built over.
            Object.entries(MoneyManager.snapshots || {}).forEach(([k, doc]) => {
                if (!doc || !doc.m) return;
                const b = monthBounds(k);
                const to = Math.min(b.to, (doc.builtAt || at) + 1);
                const oo = O.metrics(now, [b.from, to]);
                const ff = full({ from: b.from, to }, false);
                const page = 'Month snapshot (monthStats)';
                const per = P(`snapshot ${k}${to < b.to ? ` (to ${isoDay(to - 1)})` : ''}`);
                [['M1_sales', 'M1', ff.M1.total], ['M2_cogs', 'M2', ff.M2], ['M4_businessExpenses', 'M4', ff.M4.total], ['M5_badDebts', 'M5', ff.M5],
                    ['M6_profit', 'M6', ff.M6.total], ['M7_labour', 'M7', ff.M7], ['M8_personalExpenses', 'M8', ff.M8.total], ['M9_withdrawals', 'M9', ff.M9],
                    ['M14_net', 'M14', ff.M14], ['M16_purchases', 'M16', ff.M16.total]].forEach(([spec, key, fv]) => {
                    const v = doc.m[key];
                    if (v === null || v === undefined) { if (Math.abs(oo[spec]) > 0.5) unknown(spec, page, per, 'stored as unknown', oo[spec]); return; }
                    cmp(spec, page, per, oo[spec], v, fv, to);
                });
                cmp('M1_saleCount', page, per, oo.M1_saleCount, doc.m.M1c, ff.M1.count, to, 'count');
                const days = Object.values(doc.days || {});
                const daySales = days.reduce((a, d) => a + (d.s || 0), 0);
                cmp('SNAP_days_sales', page, per, oo.M1_sales, r2(daySales), ff.M1.total, to);
                if (doc.m.M6 !== null) cmp('SNAP_days_profit', page, per, oo.M6_profit, r2(days.reduce((a, d) => a + (d.p || 0), 0)), ff.M6.total, to);
                if (doc.m.close !== null && doc.m.close !== undefined) cmp('SNAP_close', page, per, O.finance(now, [b.from, to]).F8_check.closing, doc.m.close, ff.M17?.closing, to);
            });
        }
    }

    // ---------------- Money › Worth terms (dues from the dues listeners, stock from the checkpoint)
    const wantDues = O.dueTotals(now);
    const dues = outstandingTotals({ purchases: AppState.purchaseHistory, wholesaleSales: AppState.salesHistory, retailSales: AppState.retailSalesHistory });
    const fullDues = outstandingTotals(now);
    cmp('O3_payableTotal', 'Worth (phone)', P('now'), wantDues.payable, dues.payable.total, fullDues.payable.total, at + 1);
    cmp('O4_receivableTotal', 'Worth (phone)', P('now'), wantDues.receivable, dues.receivable.total, fullDues.receivable.total, at + 1);
    cmp('O3_payableCount', 'Worth (phone)', P('now'), wantDues.payableCount, dues.payable.count, fullDues.payable.count, at + 1, 'count');
    cmp('O4_receivableCount', 'Worth (phone)', P('now'), wantDues.receivableCount, dues.receivable.count, fullDues.receivable.count, at + 1, 'count');
    const thisMonth = periodRange('this-month', new Date(at));
    const mNow = MoneyManager.summary(thisMonth, { sessions: MoneyManager.sessions(thisMonth), detail: false });
    const stockFull = full(thisMonth, false).stockNow;
    if (mNow.stockNow === null) unknown('S4_total', 'Worth (phone)', P('now'), '"—" (stock value not known)', O.finance(now).F6_stockValue);
    else cmp('S4_total', 'Worth (phone)', P('now'), O.finance(now).F6_stockValue, mNow.stockNow, stockFull, at + 1);
    const stockWant = O.stockReplay(now).perItem;
    Object.entries(stockWant).forEach(([k, v]) => {
        const a = (AppState.stock || {})[k] || { quantity: 0, rate: 0 };
        cmp('S1_quantity', 'Stock (phone)', P('item'), v.qty, a.quantity, null, at + 1, 'kg');
    });

    // ---------------- Insights
    InsightsManager.seasonDocs = null;
    await InsightsManager.loadSeasons().catch(() => null);
    info.rateStatsDocs = (InsightsManager.seasonDocs || []).length;
    for (const preset of ['this-month', 'last-month']) {
        resetInsightsContextForTests();
        setInsightsContext({ preset });
        const r = InsightsManager.range();
        const end = Math.min(r.to, at + 1);
        if (!InsightsManager.covered(r.from)) { unknown('I1–I4', 'Insights (phone)', P(preset), 'period not loaded', 0); continue; }
        const m = moneySummary(InsightsManager.input(r.from), r, { detail: true });
        const f = full(r);
        const o = O.metrics(now, [r.from, r.to]);
        const appItems = new Map(itemSummary(m).map(x => [x.itemKey, x]));
        const fullItems = new Map(itemSummary(f).map(x => [x.itemKey, x]));
        new Set([...Object.keys(o.I1_itemSales), ...appItems.keys()]).forEach(k => {
            cmp('I1_itemSales', 'Insights items (phone)', P(`${preset} item`), o.I1_itemSales[k] || 0, appItems.get(k)?.sales || 0, fullItems.get(k)?.sales || 0, end);
            if (k && m.M2 !== null) cmp('I1_itemCogs', 'Insights items (phone)', P(`${preset} item`), o.I1_itemCogs[k] || 0, appItems.get(k)?.cogs || 0, fullItems.get(k)?.cogs || 0, end);
        });
        const src = { purchases: AppState.purchaseHistory || [], wholesaleSales: AppState.salesHistory || [], retailSales: AppState.retailSalesHistory || [] };
        [['sales', 'I3_customers'], ['purchases', 'I4_suppliers']].forEach(([kind, spec]) => {
            const got = new Map(partySummary(src, kind, r).map(p => [p.key, p.total]));
            const fullGot = new Map(partySummary(now, kind, r).map(p => [p.key, p.total]));
            new Set([...Object.keys(o[spec]), ...got.keys()]).forEach(k => cmp(spec, 'Insights parties (phone)', P(`${preset} party`), o[spec][k] || 0, got.get(k) || 0, fullGot.get(k) || 0, end));
        });
        // Item "vs last year" (from the bills when loaded, else whole-month snapshots).
        const ly = comparisonRanges(r).lastYear;
        const lyItems = InsightsManager.lastYearItems(r);
        const lyWant = O.metrics(now, [ly.from, ly.to]).I1_itemSales;
        const anyLy = Object.values(lyWant).some(v => Math.abs(v) > 0.5);
        if (!lyItems) {
            if (anyLy) unknown('I1_vsLastYear', 'Insights items (phone)', P(preset), 'item "vs last year" shown as "—"', Object.keys(lyWant).length, 'count');
        } else {
            const got = new Map(lyItems.map(x => [x.key, x.sales]));
            new Set([...Object.keys(lyWant), ...got.keys()]).forEach(k => cmp('I1_vsLastYear', 'Insights items (phone)', P(`${preset} item last year`), lyWant[k] || 0, got.get(k) || 0, null, ly.to));
        }
    }
    // Stopped coming (I3), weekly kg (I9), overdue parties (I10): "now" figures.
    const nowD = new Date(at);
    const src = { purchases: AppState.purchaseHistory || [], wholesaleSales: AppState.salesHistory || [], retailSales: AppState.retailSalesHistory || [] };
    const stopped = InsightsManager.stoppedCheck(src, nowD);
    const stoppedWant = O.stoppedComing(now, at, InsightsManager.cfg().stoppedComingDays);
    if (!stopped.known) {
        document.body.innerHTML = '<div id="insights" class="active"><div id="insightsPartiesTakeaway"></div><table id="insightsCustomersTable"></table><table id="insightsSuppliersTable"></table><div id="insightsStoppedCard"><div id="insightsStopped"></div></div></div>';
        InsightsManager.partyKind = 'sales';
        resetInsightsContextForTests();
        InsightsManager.renderParties(InsightsManager.range());
        const said = /ins-caveat/.test(document.getElementById('insightsStopped')?.innerHTML || '');
        if (said) unknown('I3_stoppedComing', 'Insights parties (phone)', P('now'), 'unknown shown ("load older bills")', stoppedWant.length, 'count');
        else cmp('I3_stoppedComing_unknown_hidden', 'Insights parties (phone)', P('now'), 1, 0, null, at + 1, 'count');
    } else {
        const got = new Set(stopped.list.map(p => p.key));
        const missing = stoppedWant.filter(k => !got.has(k)).length;
        const extra = [...got].filter(k => !stoppedWant.includes(k)).length;
        cmp('I3_stoppedComing', 'Insights parties (phone)', P('now'), stoppedWant.length, stoppedWant.length - missing + extra, null, at + 1, 'count');
    }
    const weeklyRes = InsightsManager.weeklySoldKg(nowD);
    const weekly = weeklyRes instanceof Map ? weeklyRes : weeklyRes?.byItem || null;
    const weeksLoaded = weeklyRes && !(weeklyRes instanceof Map) ? weeklyRes.weeks : null;
    const weeklyWant = O.weeklySoldKg(now, at);
    const fullWeekly = (() => {
        const m = moneySummary({ ...now, sessions: [], base: fullBase }, { from: at - 56 * DAY, to: at + 1 }, { detail: true });
        return new Map(itemSummary(m).map(x => [x.itemKey, x.qty / 8]));
    })();
    if (!weekly) {
        if (Object.values(weeklyWant).some(v => v > 0)) unknown('I9_weeklyKg', 'Insights stock-up (phone)', P('now'), 'no stock-up card (under 2 weeks of bills loaded)', 0, 'kg');
    } else if (weeksLoaded !== null && weeksLoaded < 8 - 1e-9) {
        unknown('I9_weeklyKg', 'Insights stock-up (phone)', P('now'), 'approximate: "from the last N weeks" (under 8 weeks of bills loaded)', null, 'kg');
    } else {
        new Set([...Object.keys(weeklyWant), ...weekly.keys()]).forEach(k => {
            if (!k) return;
            cmp('I9_weeklyKg', 'Insights stock-up (phone)', P('item'), weeklyWant[k] || 0, r2(weekly.get(k) || 0), r2(fullWeekly.get(k) || 0), at + 1, 'kg');
        });
    }
    const cfg = InsightsManager.cfg();
    [['sales', [...(AppState.retailSalesHistory || []), ...(AppState.salesHistory || [])], [...now.retailSales, ...now.wholesaleSales]],
        ['purchases', AppState.purchaseHistory || [], now.purchases]].forEach(([kind, mine, all]) => {
        const a = overdueParties(mine, nowD, cfg);
        const w = O.overdue(all, at, cfg.overdueDays);
        const fa = overdueParties(all, nowD, cfg);
        cmp('I10_overdueTotal', `Insights to-do (phone, ${kind})`, P('now'), w.total, a.total, fa.total, at + 1);
        cmp('I10_overdueParties', `Insights to-do (phone, ${kind})`, P('now'), w.parties, a.parties, fa.parties, at + 1, 'count');
    });
    // Season calendar (I5) reads kg sold per month from rateStats (RT4), as the phone loaded them.
    const kgDocs = soldKgByMonth(InsightsManager.seasonDocs || []);
    const kgWant = O.rateBuckets({ purchase: now.purchases, retail: now.retailSales, wholesale: now.wholesaleSales }, now.items, O.monthOf);
    const firstSeasonYear = String(nowD.getFullYear() - 2);
    Object.entries(kgWant).forEach(([item, byM]) => Object.entries(byM).forEach(([mk, byK]) => {
        if (mk.slice(0, 4) < firstSeasonYear) return;
        const want = r2((byK.retail?.kg || 0) + (byK.wholesale?.kg || 0));
        if (!want) return;
        const b = monthBounds(mk);
        cmp('I5_soldKgByMonth', 'Insights seasons (phone, rateStats)', P(`${mk} item`), want, r2(kgDocs.get(item)?.[mk] || 0), null, Math.min(b.to, at + 1), 'kg');
    }));

    // ---------------- Statements: month statement (ST2) for the 24 months listed, day book (ST1) for the loaded days
    document.body.innerHTML = T.statements;
    document.getElementById('statements').classList.add('active');
    StatementsManager.kind = null;
    const months = Array.from({ length: 24 }, (_, i) => monthKeyOf(new Date(nowD.getFullYear(), nowD.getMonth() - i, 1).getTime()));
    const ST2 = { M1: 'M1_sales', M2: 'M2_cogs', M3: 'M3_gross', M4: 'M4_businessExpenses', M5: 'M5_badDebts', M6: 'M6_profit', M7: 'M7_labour', M8: 'M8_personalExpenses',
        M9: 'M9_withdrawals', M10: 'M10_kept', M14: 'M14_net', M16: 'M16_purchases' };
    for (const k of months) {
        Object.assign(StatementsManager, { month: k });
        StatementsManager.open('month');
        await settle(fake);
        StatementsManager.render();
        const b = monthBounds(k);
        const to = Math.min(b.to, at + 1);
        const doc = document.getElementById('statementsDoc');
        const oo = O.metrics(now, [b.from, to]);
        if (!StatementsManager.covered(b.from)) {
            if (/load/i.test(doc.textContent) && doc.querySelector('button')) {
                if (Math.abs(oo.M1_sales) + Math.abs(oo.M16_purchases) > 0.5) unknown('ST2', 'Statements month (phone)', P(k), 'month not loaded: "load older bills" shown', oo.M1_sales);
            } else cmp('ST2_not_loaded_hidden', 'Statements month (phone)', P(k), 1, 0, null, to, 'count');
            continue;
        }
        const ff = full({ from: b.from, to }, false);
        const fv = { M1: ff.M1.total, M2: ff.M2, M3: ff.M3.total, M4: ff.M4.total, M5: ff.M5, M6: ff.M6.total, M7: ff.M7, M8: ff.M8.total, M9: ff.M9, M10: ff.M10, M14: ff.M14, M16: ff.M16.total };
        doc.querySelectorAll('[data-metric-export]').forEach(el => {
            const id = el.dataset.metricExport;
            const spec = ST2[id];
            if (!spec) return;
            const v = shownNumber(el.textContent);
            if (Number.isNaN(v) && /—/.test(el.textContent)) { unknown(spec, 'Statements month (phone)', P(k), '"—"', oo[spec]); return; }
            cmp(spec, 'Statements month (phone)', P(k), Math.round(oo[spec]), v, Math.round(fv[id] ?? NaN), to);
        });
    }
    const loadedFrom = AppState.historyLoadedFrom || 0;
    for (let d = new Date(Math.max(loadedFrom, at - 62 * DAY)); d.getTime() <= at; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
        const key = isoDay(d.getTime());
        StatementsManager.day = key;
        StatementsManager.open('day');
        await settle(fake);
        StatementsManager.render();
        const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const to = from + DAY;
        const noon = Math.min(from + 12 * 3600000, at);
        const sess = sessionOn(key);
        const want = O.today(now, noon, sess[0] || null);
        const wantW = O.finance(now, [from, to]).F11_withdrawals;
        const sessions = MoneyManager.sessions({ from, to });
        const { totals } = dayBook(StatementsManager.src(), { from, to }, { personal: true, sessions: sessions.list });
        const page = 'Statements day book (phone)';
        const rows = [['ST1_sales', want.T2_sales, totals.sales], ['ST1_purchases', want.T1_purchases, totals.purchases],
            ['ST1_expenses', r2(want.T4_businessExpenses + want.T5_personalExpenses), totals.expenses], ['ST1_withdrawals', wantW, totals.withdrawals],
            ['ST1_dueReceived', want.T13_dueReceived, totals.dueReceived], ['ST1_duePaid', want.T14_duePaid, totals.duePaid]];
        rows.forEach(([spec, w, a]) => cmp(spec, page, P(key), w, a, null, to));
        cmp('ST1_saleCount', page, P(key), want.T2_saleCount, totals.salesCount, null, to, 'count');
        if (key !== day) {
            const shownTotals = [...document.querySelectorAll('#statementsDoc .st-totals .ins-row span:last-child')].map(el => shownNumber(el.textContent));
            rows.forEach(([spec, w], i) => cmp(`${spec}_screen`, page, P(key), Math.round(w), shownTotals[i], null, to));
        }
    }

    // ---------------- Today (its cash session from the app's own loader)
    const todayIds = {
        T1_purchases: 'todayTotalPurchases', T2_sales: 'todayTotalSales', T3_labour: 'todayLaborCost',
        T4_businessExpenses: 'todayBusinessExpenses', T5_personalExpenses: 'todayPersonalExpenses',
        T6_cashIn: 'todayCashReceived', T7_onlineIn: 'todayOnlineReceived', T8_cashOut: 'todayCashPaid', T9_onlineOut: 'todayOnlinePaid',
        T10_totalIn: 'todayTotalIn', T11_totalOut: 'todayTotalOut', T13_dueReceived: 'todayDueReceived', T14_duePaid: 'todayDuePaid',
        T15_dueToReceive: 'todayDueToReceive', T16_dueToPay: 'todayDueToPay'
    };
    const ids = [...Object.values(todayIds), 'todayPurchaseCount', 'todaySaleCount', 'todayNetCashFlow', 'todayCashFlowLabel', 'todayTotalCashFlow',
        'todayBusinessExpenseCount', 'todayPersonalExpenseCount', 'todayPurchaseItems', 'todaySaleItems'];
    document.body.innerHTML = ids.map(id => `<div id="${id}"></div>`).join('');
    CashManagementManager.todaySession = null;
    DayManager.loadTodaySession();
    await settle(fake);
    DayManager.loadTodayData();
    const session = CashManagementManager.todaySession || null;
    const want = O.today(now, at, session);
    Object.entries(todayIds).forEach(([k, id]) => cmp(k, 'Today (phone)', P('today'), Math.round(want[k]), shown(id), null, at + 1));
    const net = shown('todayNetCashFlow');
    cmp('T12_net', 'Today (phone)', P('today'), Math.round(want.T12_net), /outflow/i.test(document.getElementById('todayCashFlowLabel').textContent) ? -net : net, null, at + 1);
    cmp('T1_purchaseCount', 'Today (phone)', P('today'), want.T1_purchaseCount, shown('todayPurchaseCount'), null, at + 1, 'count');
    cmp('T2_saleCount', 'Today (phone)', P('today'), want.T2_saleCount, shown('todaySaleCount'), null, at + 1, 'count');
    document.body.innerHTML = '';
    return info;
}
