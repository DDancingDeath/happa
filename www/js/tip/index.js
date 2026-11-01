/**
 * @fileoverview Test in Production wiring for the browser (#217): the shared
 * TIP instance, the scenario declarations, the error watcher hook, expiry
 * sweeps and batched reporting (counters at most once per 30 min per device,
 * failure samples debounced). No Firestore import here: main.js passes a sink
 * (FirebaseService.writeTip) so this module has no import cycles.
 * Every function swallows its own errors ("do no harm").
 * @module tip/index
 */

import { createTip, dayKeyOf, STORE_KEYS } from './tip.js';
import { planFlush, makeDeviceId } from './report.js';
import { addDays } from './health-stats.js';
import { AppStartTest } from './scenarios/app-start.js';
import { BillSaveTest } from './scenarios/bill-save.js';
import { PaymentRecordTest } from './scenarios/payment-record.js';
import { CashCloseTest } from './scenarios/cash-close.js';
import { SessionReadsTest } from './scenarios/session-reads.js';
import { PrintTest } from './scenarios/print.js';
import { SyncTest } from './scenarios/sync.js';
import { StockCheckpointTest } from './scenarios/stock-checkpoint.js';
import { NumberChecksTest } from './scenarios/number-checks.js';
import { MainThreadTest } from './scenarios/main-thread.js';
import { APP_VERSION } from '../version.js';

export const SCENARIOS = [AppStartTest, BillSaveTest, PaymentRecordTest, CashCloseTest, SessionReadsTest,
    PrintTest, SyncTest, StockCheckpointTest, NumberChecksTest, MainThreadTest];

const KEYS = {
    lastFlush: 'aadhat.tip.lastFlush',
    lastFailureFlush: 'aadhat.tip.lastFailureFlush',
    device: 'aadhat.tip.device'
};
const SWEEP_MS = 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const WRITE_WAIT_MS = 20 * 1000;
/** Failure-sample retry pause after a failed write (rules not deployed yet, quota …). */
const FAILURE_BACKOFF_MS = 30 * 60 * 1000;
/** Counters older than this are dropped instead of written. */
const MAX_PENDING_DAYS = 7;

const store = (() => {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; }
})();
const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const warn = (msg, e) => { try { console.warn(`[TIP] ${msg}:`, e?.code || e?.message || e); } catch (_) { /* never */ } };

let targets = Object.fromEntries(SCENARIOS.map(s => [s.id, s.target]));
let sink = null;
let flushing = false;
let started = false;

export const tip = createTip({ store, appVersion: APP_VERSION, isOnline, log: warn });
SCENARIOS.forEach(decl => {
    try { tip.declareTest(decl); } catch (e) { warn('declare failed', e); }
});
// Runs left open by a tab that is gone (app closed / killed) were abandoned;
// runs of other open tabs (fresh heartbeat) are left alone.
tip.heartbeat();
tip.recoverAbandoned();
if (typeof window !== 'undefined') {
    try {
        setInterval(() => tip.heartbeat(), HEARTBEAT_MS);
        // Another tab closed for good: recover its open runs now instead of after TAB_STALE_MS.
        window.addEventListener('storage', (e) => {
            if (e.key === STORE_KEYS.tabs) tip.recoverAbandoned();
        });
        window.addEventListener('pagehide', (e) => { if (!e.persisted) tip.endTab(); });
        window.addEventListener('pageshow', () => tip.heartbeat());
    } catch (e) { warn('tab wiring failed', e); }
}

const readNum = (key) => {
    try { return Number(store?.getItem(key)) || 0; } catch (_) { return 0; }
};
const writeNum = (key, value) => {
    try { store?.setItem(key, String(value)); } catch (_) { /* ignore */ }
};

/** Pass-rate targets per test (defaults from the declarations, settings/app.tipTargets overrides). */
export function tipTargets() {
    return { ...targets };
}

/** Reason name → code per test, for the Health page. */
export function tipReasons() {
    return Object.fromEntries(SCENARIOS.map(s => [s.id, { ...s.reasons }]));
}

/**
 * Apply settings/app: tipEnabled (default on), tipPolicies, tipTargets.
 * @param {Object|null} settings
 */
export function configureTip(settings) {
    try {
        tip.setEnabled(settings?.tipEnabled !== false);
        tip.setPolicies(settings?.tipPolicies || {});
        const t = settings?.tipTargets;
        if (t && typeof t === 'object') {
            Object.entries(t).forEach(([id, v]) => {
                const n = Number(v);
                if (targets[id] !== undefined && Number.isFinite(n)) targets[id] = Math.min(100, Math.max(0, n));
            });
        }
    } catch (e) { warn('configure failed', e); }
}

/** Device id for the signed-in user (random per install + uid hash). */
export function tipDeviceId(uid) {
    try {
        let base = store?.getItem(KEYS.device);
        if (!base) {
            base = Math.random().toString(36).slice(2, 10);
            store?.setItem(KEYS.device, base);
        }
        return makeDeviceId(base, uid);
    } catch (_) {
        return makeDeviceId('nostore', uid);
    }
}

/** Error watcher hook (TelemetryService.captureError calls this). */
export function noteTipError() {
    try { tip.noteError(); } catch (_) { /* never */ }
}

function dropOldDays(delta, now) {
    const oldest = addDays(dayKeyOf(now), -MAX_PENDING_DAYS);
    Object.keys(delta || {}).forEach(day => { if (day < oldest) delete delta[day]; });
    return delta;
}

const withTimeout = (promise) => Promise.race([
    promise,
    // Still unacknowledged: Firestore keeps it queued; don't hold the flush lock.
    new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), WRITE_WAIT_MS))
]);

/**
 * Write what is due (see report.planFlush). Never throws.
 * @param {{force?: boolean}} [opts] - force ignores the 30-min spacing (tests / sign-out)
 */
export async function flushTip({ force = false } = {}) {
    if (!sink || flushing || !isOnline()) return;
    try {
        const now = Date.now();
        const plan = planFlush({
            now,
            lastFlushAt: force ? 0 : readNum(KEYS.lastFlush),
            lastFailureFlushAt: force ? 0 : readNum(KEYS.lastFailureFlush),
            hasPending: tip.hasPending(),
            hasFailures: tip.hasFailures()
        });
        if (!plan.counters && !plan.failures) return;
        flushing = true;
        const delta = plan.counters ? dropOldDays(tip.takeDelta(), now) : null;
        const failures = plan.failures ? tip.takeFailures() : null;
        if (plan.counters) writeNum(KEYS.lastFlush, now);
        if (plan.failures) writeNum(KEYS.lastFailureFlush, now);
        try {
            const res = await withTimeout(sink({ delta, failures }));
            if (res?.retryFailures?.length) tip.restoreFailures(res.retryFailures);
        } catch (e) {
            warn('report not written', e);
            if (delta) tip.restoreDelta(delta);
            if (failures) {
                tip.restoreFailures(failures);
                writeNum(KEYS.lastFailureFlush, now + FAILURE_BACKOFF_MS);
            }
        }
    } catch (e) {
        warn('flush failed', e);
    } finally {
        flushing = false;
    }
}

/**
 * Start sweeps and reporting once the user is signed in.
 * @param {{sink: Function, buildId?: string}} opts
 */
export function startTipReporting({ sink: writer, buildId } = {}) {
    try {
        sink = writer || sink;
        tip.setVersion(APP_VERSION, buildId);
        if (started || typeof window === 'undefined') return;
        started = true;
        setInterval(() => { tip.sweep(); tip.recoverAbandoned(); flushTip(); }, SWEEP_MS);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') { tip.sweep(); flushTip(); }
        });
        flushTip();
    } catch (e) { warn('start failed', e); }
}
