/**
 * @fileoverview Helpers for screens that read the windowed history arrays.
 *
 * AppState history arrays (purchases, sales, expenses, stock adjustments,
 * withdrawals) only hold records from `historyLoadedFrom` onward (plus older
 * bills that still have a due). Screens that need an older range ask
 * FirebaseService to extend the window first, and show a loading state
 * instead of partial totals while that happens.
 *
 * FirebaseService is read from `window` (set in main.js) so this module has
 * no Firebase import and every call is defensive: with an older service that
 * has no window API, historyLoadedFrom is 0 (= full history loaded).
 * @module utils/history-window
 */

import { AppState } from './state.js';
import { t, getLang } from '../i18n/index.js';
import { formatDay } from './dates.js';

const service = () => (typeof window !== 'undefined' ? window.FirebaseService : null) || null;

/**
 * Normalise a range start to epoch ms.
 * @param {number|Date|null|undefined} from
 * @returns {number|null} null = "all history"
 */
export function toMs(from) {
    if (from === null || from === undefined) return null;
    if (from instanceof Date) return from.getTime();
    const n = Number(from);
    return Number.isFinite(n) ? n : NaN;
}

/**
 * Start of the loaded history window (ms epoch). 0 = full history loaded.
 * @returns {number}
 */
export function historyLoadedFrom() {
    const s = service();
    if (typeof s?.getHistoryWindowStart === 'function') {
        const v = Number(s.getHistoryWindowStart());
        if (Number.isFinite(v)) return v;
    }
    const v = Number(AppState.historyLoadedFrom);
    return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * @returns {boolean} true when every record is in AppState
 */
export function isFullHistoryLoaded() {
    const s = service();
    if (typeof s?.isFullHistoryLoaded === 'function') return !!s.isFullHistoryLoaded();
    return historyLoadedFrom() === 0;
}

/**
 * Does a range starting at `rangeStart` need records that are not loaded yet?
 * @param {number|Date|null} rangeStart - null/undefined = all history
 * @param {number} [loadedFrom] - defaults to the current window start
 * @returns {boolean}
 */
export function needsHistoryFrom(rangeStart, loadedFrom = historyLoadedFrom()) {
    if (!loadedFrom) return false;
    const ms = toMs(rangeStart);
    if (ms === null) return true;
    if (!Number.isFinite(ms)) return false;
    return ms < loadedFrom;
}

const inflight = new Map();

/**
 * Make sure AppState covers [rangeStart, now]. Concurrent calls for the same
 * range share one request.
 * @param {number|Date|null} rangeStart - null = all history
 * @returns {Promise<boolean>} true if the range is covered afterwards
 */
export function ensureHistoryFrom(rangeStart) {
    if (!needsHistoryFrom(rangeStart)) return Promise.resolve(true);
    const s = service();
    if (typeof s?.ensureHistoryFrom !== 'function') return Promise.resolve(false);
    const ms = toMs(rangeStart);
    const key = ms === null ? 'all' : String(ms);
    if (!inflight.has(key)) {
        const p = Promise.resolve()
            .then(() => s.ensureHistoryFrom(ms))
            .then(() => !needsHistoryFrom(rangeStart))
            .finally(() => inflight.delete(key));
        inflight.set(key, p);
    }
    return inflight.get(key);
}

let olderInflight = null;
let reachedEndFlag = false;
const gates = new Map();

// The window state above outlives a logout/login (no page reload), so reset it
// whenever the signed-in user changes or the window start moves forward (a new
// session starts from the default recent window; within a session it only
// ever moves back).
let sessionUid;
let sessionLoadedFrom = null;

function syncSession() {
    const uid = AppState.currentUser?.uid ?? null;
    const from = historyLoadedFrom();
    const isFull = from === 0;
    const changed = sessionLoadedFrom !== null && (
        uid !== sessionUid ||
        (sessionLoadedFrom === 0 ? !isFull : (!isFull && from > sessionLoadedFrom))
    );
    if (changed) {
        reachedEndFlag = false;
        gates.clear();
    }
    sessionUid = uid;
    sessionLoadedFrom = from;
}

/**
 * Extend the window back by `months` calendar months (one request at a time
 * app-wide; concurrent callers share it).
 * @param {number} [months=1]
 * @returns {Promise<{loadedFrom: number, reachedEnd: boolean}>}
 */
export function loadOlderHistory(months = 1) {
    syncSession();
    if (olderInflight) return olderInflight;
    const s = service();
    if (isFullHistoryLoaded() || typeof s?.loadOlderHistory !== 'function') {
        reachedEndFlag = true;
        return Promise.resolve({ loadedFrom: historyLoadedFrom(), reachedEnd: true });
    }
    olderInflight = Promise.resolve()
        .then(() => s.loadOlderHistory(months))
        .then((res) => {
            const reachedEnd = !!res?.reachedEnd || isFullHistoryLoaded();
            if (reachedEnd) reachedEndFlag = true;
            return { loadedFrom: res?.loadedFrom ?? historyLoadedFrom(), reachedEnd };
        })
        .finally(() => { olderInflight = null; });
    return olderInflight;
}

/** @returns {boolean} true when there is nothing older to load */
export function historyReachedEnd() {
    syncSession();
    return reachedEndFlag || isFullHistoryLoaded();
}

/** @returns {boolean} true while loadOlderHistory is running */
export function isLoadingOlderHistory() {
    return !!olderInflight;
}

/**
 * Range gate for renderers. Returns 'ready' when the range is loaded.
 * Otherwise starts loading it (once per owner+range), returns 'loading', and
 * calls `rerender` when done. If loading fails it returns 'error' until
 * {@link retryRange} is called for that owner.
 * @param {string} owner - Stable key for the screen (e.g. 'reports')
 * @param {number|Date|null} rangeStart - null = all history
 * @param {Function} rerender
 * @returns {'ready'|'loading'|'error'}
 */
export function rangeStatus(owner, rangeStart, rerender) {
    syncSession();
    if (!needsHistoryFrom(rangeStart)) {
        gates.delete(owner);
        return 'ready';
    }
    const ms = toMs(rangeStart);
    const key = ms === null ? 'all' : String(ms);
    const current = gates.get(owner);
    if (current && current.key === key) return current.status;

    const entry = { key, status: 'loading' };
    gates.set(owner, entry);
    ensureHistoryFrom(rangeStart).then(
        (covered) => {
            if (gates.get(owner) !== entry) return;
            if (covered) gates.delete(owner);
            else entry.status = 'error';
            rerender?.();
        },
        (err) => {
            console.error(`History load failed (${owner}):`, err);
            if (gates.get(owner) !== entry) return;
            entry.status = 'error';
            rerender?.();
        }
    );
    return 'loading';
}

/** Forget a failed load so the next render retries it. */
export function retryRange(owner) {
    gates.delete(owner);
}

/** Local midnight of the first day of the month `monthsBack` months ago. */
export function monthStart(monthsBack = 0, now = new Date()) {
    return new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
}

/** Short human date for notices, e.g. "1 Sep 2026". */
export function formatWindowDate(ms) {
    if (!ms) return '';
    return formatDay(ms, { lang: getLang() });
}

/**
 * Show/hide a range-loading notice and blur the figures in `scopes` while
 * their range is loading (so partial totals are never shown as final).
 * @param {HTMLElement|HTMLElement[]} scopes - Elements holding range figures;
 *   the notice is inserted before the first one.
 * @param {'ready'|'loading'|'error'} status
 * @param {Object} [opts]
 * @param {string} [opts.loadingText]
 * @param {string} [opts.errorText]
 * @param {Function} [opts.onRetry]
 */
export function applyRangeState(scopes, status, opts = {}) {
    const list = (Array.isArray(scopes) ? scopes : [scopes]).filter(Boolean);
    if (list.length === 0) return;
    const anchor = list[0];
    let notice = anchor.previousElementSibling;
    // The "older bills may be out of date" hint can sit between the notice and the list.
    while (notice && notice.classList.contains('history-stale-hint')) notice = notice.previousElementSibling;
    if (!notice || !notice.classList.contains('history-range-notice')) notice = null;

    list.forEach(el => el.classList.toggle('history-range-loading', status === 'loading'));

    if (status === 'ready') {
        notice?.remove();
        return;
    }
    if (!notice) {
        notice = document.createElement('div');
        notice.className = 'history-range-notice';
        notice.setAttribute('role', 'status');
        anchor.parentNode?.insertBefore(notice, anchor);
    }
    notice.classList.toggle('is-error', status === 'error');
    notice.textContent = '';
    const text = document.createElement('span');
    if (status === 'loading') {
        const spinner = document.createElement('span');
        spinner.className = 'history-range-spinner';
        notice.appendChild(spinner);
        text.textContent = opts.loadingText || t('ui.analytics.loading_older');
        notice.appendChild(text);
    } else {
        const from = formatWindowDate(historyLoadedFrom());
        text.textContent = opts.errorText || t('ui.hist.older_failed', { date: from });
        notice.appendChild(text);
        if (typeof opts.onRetry === 'function') {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'history-range-retry';
            btn.textContent = t('ui.hist.retry');
            btn.addEventListener('click', opts.onRetry);
            notice.appendChild(btn);
        }
    }
}

/**
 * Resolve a bill's current index by id (indices shift when live sync or
 * older-history loads add records). Falls back to `fallbackIndex` when no id.
 * @param {Array<Object>} history
 * @param {string|number|null|undefined} id
 * @param {number} [fallbackIndex=-1]
 * @returns {number}
 */
export function findBillIndex(history, id, fallbackIndex = -1) {
    if (!Array.isArray(history)) return -1;
    if (id === null || id === undefined || id === '') return fallbackIndex;
    return history.findIndex(b => b && String(b.id) === String(id));
}

/**
 * On-demand history in memory (older than the live window, not live-updated).
 * @returns {?{from: number, liveFrom: number, asOf: number}}
 */
export function onDemandHistoryInfo() {
    const s = service();
    return typeof s?.getOnDemandHistoryInfo === 'function' ? (s.getOnDemandHistoryInfo() || null) : null;
}

let refreshInflight = null;

/**
 * Re-fetch the on-demand range (one request at a time app-wide).
 * @returns {Promise<boolean>} false if the server couldn't be reached
 */
export function refreshOnDemandHistory() {
    const s = service();
    if (typeof s?.refreshOnDemandHistory !== 'function') return Promise.resolve(false);
    if (!refreshInflight) {
        refreshInflight = Promise.resolve()
            .then(() => s.refreshOnDemandHistory())
            .then((ok) => !!ok, (err) => {
                console.error('Refreshing older history failed:', err);
                return false;
            })
            .finally(() => { refreshInflight = null; });
    }
    return refreshInflight;
}

/**
 * Text of the "older bills aren't live" hint. Bills from `liveFrom` on are kept
 * up to date live; older ones were loaded on demand and only change on Refresh.
 * @param {{liveFrom: number}} info
 * @returns {string}
 */
export function staleHistoryHintText(info) {
    return t('ui.hist.stale', { date: formatWindowDate(info.liveFrom) });
}

/**
 * Subtle hint + Refresh button shown while on-demand (non-live) history is in
 * memory; removed otherwise (#132).
 * @param {HTMLElement} anchor - the hint is inserted before this element
 * @param {Object} opts
 * @param {string} opts.id - unique element id for this screen
 * @param {Function} [opts.onRefreshed] - re-render after a refresh
 * @param {(info: {liveFrom: number}) => boolean} [opts.isRelevant] - false hides
 *   the hint (e.g. no older bill is on screen)
 */
export function renderStaleHistoryHint(anchor, { id, onRefreshed, isRelevant } = {}) {
    if (!anchor || !id) return;
    let hint = document.getElementById(id);
    const info = onDemandHistoryInfo();
    if (!info || (typeof isRelevant === 'function' && !isRelevant(info))) {
        hint?.remove();
        return;
    }
    if (!hint) {
        hint = document.createElement('div');
        hint.id = id;
        hint.className = 'history-stale-hint';
        hint.setAttribute('role', 'status');
    }
    if (hint.nextElementSibling !== anchor) anchor.parentNode?.insertBefore(hint, anchor);
    if (hint.dataset.busy === '1') return;
    hint.textContent = '';
    const text = document.createElement('span');
    text.className = 'history-stale-text';
    text.textContent = staleHistoryHintText(info);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-stale-refresh';
    btn.textContent = t('ui.anom.refresh');
    btn.addEventListener('click', async () => {
        hint.dataset.busy = '1';
        btn.disabled = true;
        btn.textContent = t('ui.hist.refreshing');
        const ok = await refreshOnDemandHistory();
        delete hint.dataset.busy;
        if (!ok) {
            btn.disabled = false;
            btn.textContent = t('ui.hist.retry');
            text.textContent = t('ui.hist.refresh_failed');
            return;
        }
        renderStaleHistoryHint(anchor, { id, onRefreshed, isRelevant });
        onRefreshed?.();
    });
    hint.append(text, btn);
}
