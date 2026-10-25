/**
 * @fileoverview Firestore quota guards (#194): detects "daily free limit
 * reached" (resource-exhausted) errors, shows one clear banner (app language) per
 * session, and keeps an estimated per-session document-read counter for
 * Diagnostics. Pure parts are exported for tests; firebase/firestore-meter.js
 * feeds them from the SDK.
 * @module utils/quota-guard
 */

import { t } from '../i18n/index.js';

/** Warn once when a single app session has read more documents than this. */
export const HEAVY_SESSION_READS = 3000;

const QUOTA_TEXT_PATTERN = /resource[-_ ]exhausted|quota exceeded/i;

/**
 * Whether an error (or logged message) means Firestore refused the request
 * because the project's quota is used up.
 * @param {*} err FirestoreError, Error, string or anything logged
 * @returns {boolean}
 */
export function isQuotaExhaustedError(err) {
    if (err === null || err === undefined) return false;
    if (typeof err === 'string') return QUOTA_TEXT_PATTERN.test(err);
    if (typeof err !== 'object') return false;
    const code = err.code;
    if (code === 'resource-exhausted' || code === 'RESOURCE_EXHAUSTED' || code === 8) return true;
    if (err.status === 429 || err.status === 'RESOURCE_EXHAUSTED') return true;
    return QUOTA_TEXT_PATTERN.test(String(err.message || ''));
}

/** Quota banner text in the app language. */
export const quotaBannerText = (lang) => (lang ? t('ui.quota.banner', null, lang) : t('ui.quota.banner'));

const BANNER_ID = 'quotaBanner';
const DISMISS_KEY = 'aadhatQuotaBannerDismissed';

/**
 * Per-session estimate of billed document reads, grouped by source label.
 * @param {{now?: Function, threshold?: number, onHeavy?: Function}} [opts]
 */
export function createReadCounter({ now = () => Date.now(), threshold = HEAVY_SESSION_READS, onHeavy = null } = {}) {
    const bySource = new Map();
    let total = 0;
    let warned = false;
    const since = now();
    return {
        add(source, n) {
            if (!(n > 0)) return;
            total += n;
            bySource.set(source, (bySource.get(source) || 0) + n);
            if (!warned && total > threshold) {
                warned = true;
                if (onHeavy) {
                    try { onHeavy(total, this.top(5)); } catch (_) { /* never break a read */ }
                }
            }
        },
        top(n = 5) {
            return [...bySource.entries()]
                .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
                .slice(0, n)
                .map(([source, reads]) => ({ source, reads }));
        },
        get total() { return total; },
        get since() { return since; },
        get warned() { return warned; }
    };
}

/** Billed reads of a one-shot query result (an empty server result still costs 1). */
export function readsForQueryGet(snap) {
    if (!snap || snap.metadata?.fromCache) return 0;
    return Math.max(1, snap.size || 0);
}

/** Billed reads of a one-shot document read. */
export function readsForDocGet(snap) {
    if (!snap || snap.metadata?.fromCache) return 0;
    return 1;
}

/**
 * Billed reads of one query-listener snapshot. `state.synced` remembers that
 * the listener already received its initial server result: before that the
 * whole result is charged, after it only added/modified documents.
 * Snapshots from the offline cache and this device's own pending writes are free.
 */
export function readsForQuerySnapshot(snap, state) {
    if (!snap || snap.metadata?.fromCache) return 0;
    if (!state.synced) {
        state.synced = true;
        return Math.max(1, snap.size || 0);
    }
    let changes = [];
    try { changes = typeof snap.docChanges === 'function' ? snap.docChanges() : []; } catch (_) { changes = []; }
    return changes.filter(c => c.type !== 'removed' && !c.doc?.metadata?.hasPendingWrites).length;
}

/** Billed reads of one document-listener snapshot. */
export function readsForDocSnapshot(snap, state) {
    if (!snap || snap.metadata?.fromCache) return 0;
    if (state.synced && snap.metadata?.hasPendingWrites) return 0;
    state.synced = true;
    return 1;
}

/**
 * Session-wide guard state: read counter + quota events. One per page load.
 * @param {{doc?: Document, storage?: Storage, log?: Object, onQuota?: Function, onHeavy?: Function}} [env]
 */
export function createQuotaGuard(env = {}) {
    const doc = env.doc !== undefined ? env.doc : (typeof document !== 'undefined' ? document : null);
    const storage = env.storage !== undefined ? env.storage : (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
    const log = env.log || console;
    const quota = { count: 0, firstAt: 0, lastAt: 0, lastSource: '' };
    let bannerShown = false;

    const reads = createReadCounter({
        threshold: env.threshold || HEAVY_SESSION_READS,
        onHeavy: (total, top) => {
            log.warn(`[Aadhat] This session has read about ${total} documents (free limit is 50,000/day for everyone). Top: ` +
                top.map(t => `${t.source}=${t.reads}`).join(', '));
            if (env.onHeavy) env.onHeavy(total, top);
        }
    });

    const dismissed = () => {
        try { return storage?.getItem(DISMISS_KEY) === '1'; } catch (_) { return false; }
    };

    function showBanner() {
        if (bannerShown || !doc?.body || dismissed()) return false;
        bannerShown = true;
        const el = doc.createElement('div');
        el.id = BANNER_ID;
        el.setAttribute('role', 'alert');
        el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99998;background:#fff3cd;color:#664d03;' +
            'border-bottom:2px solid #f0ad4e;padding:10px 40px 10px 12px;font:14px/1.4 Arial,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.15);';
        if (doc.getElementById('env-indicator')) el.style.paddingTop = '20px';
        const text = doc.createElement('div');
        text.textContent = `⚠️ ${quotaBannerText()}`;
        const close = doc.createElement('button');
        close.type = 'button';
        close.setAttribute('aria-label', t('ui.kbd.close'));
        close.textContent = '×';
        close.style.cssText = 'position:absolute;right:8px;top:6px;border:0;background:transparent;font-size:22px;line-height:1;color:#664d03;cursor:pointer;';
        close.addEventListener('click', () => {
            el.remove();
            try { storage?.setItem(DISMISS_KEY, '1'); } catch (_) { /* private mode */ }
        });
        el.append(text, close);
        doc.body.appendChild(el);
        return true;
    }

    return {
        reads,
        /** Records a quota error; shows the banner the first time in this session. */
        noteQuotaExhausted(source = 'unknown') {
            const t = Date.now();
            quota.count++;
            quota.lastAt = t;
            quota.lastSource = String(source).slice(0, 80);
            if (quota.count === 1) {
                quota.firstAt = t;
                log.warn(`[Aadhat] Firestore daily free limit reached (first seen: ${quota.lastSource}). Writes stay queued on this device.`);
                if (env.onQuota) {
                    try { env.onQuota(quota.lastSource); } catch (_) { /* logging must never throw */ }
                }
            }
            showBanner();
        },
        /** Retries the banner (e.g. once document.body exists). */
        showBanner,
        status() {
            return {
                reads: reads.total,
                since: reads.since,
                top: reads.top(5),
                heavy: reads.warned,
                quota: { ...quota }
            };
        }
    };
}
