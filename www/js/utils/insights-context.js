/**
 * @fileoverview Shared period and item for Money, Insights (incl. the Rate
 * trends and Product traffic views it hosts) and Statements
 * (docs/insights-redesign.md §5.3). Kept for the session in sessionStorage,
 * so switching page keeps "Oct 2026" and the chosen item.
 * @module utils/insights-context
 */

const KEY = 'aadhat.insightsContext';
const PRESETS = /^(this-month|last-month|this-year|last-year|last-30|all|month:\d{4}-\d{2})$/;

const store = () => {
    try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; }
};

let ctx = null;

function load() {
    if (ctx) return ctx;
    ctx = { preset: 'this-month', itemId: null };
    try {
        const raw = JSON.parse(store()?.getItem(KEY) || 'null');
        if (raw && PRESETS.test(String(raw.preset))) ctx.preset = raw.preset;
        if (raw && typeof raw.itemId === 'string' && raw.itemId) ctx.itemId = raw.itemId;
    } catch { /* ignore a broken value */ }
    return ctx;
}

/** @returns {{preset: string, itemId: ?string}} */
export function getInsightsContext() {
    return { ...load() };
}

/**
 * @param {{preset?: string, itemId?: ?string}} patch
 * @returns {{preset: string, itemId: ?string}}
 */
export function setInsightsContext(patch = {}) {
    const c = load();
    if (patch.preset !== undefined && PRESETS.test(String(patch.preset))) c.preset = patch.preset;
    if (patch.itemId !== undefined) c.itemId = patch.itemId || null;
    try { store()?.setItem(KEY, JSON.stringify(c)); } catch { /* storage full or blocked */ }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('aadhat:insightscontext', { detail: { ...c } }));
    }
    return { ...c };
}

/** Month key ('YYYY-MM') a one-month view (Product traffic) should open on for a preset. */
export function contextMonth(preset, now = new Date()) {
    const m = /^month:(\d{4}-\d{2})$/.exec(String(preset));
    if (m) return m[1];
    const d = preset === 'last-month' ? new Date(now.getFullYear(), now.getMonth() - 1, 1) : now;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Test helper. */
export function resetInsightsContextForTests() {
    ctx = null;
    try { store()?.removeItem(KEY); } catch { /* ignore */ }
}
