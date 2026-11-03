// @ts-check
/**
 * @fileoverview Startup timing marks (#13). Each step of app open records a
 * performance.mark ("aadhat:<step>") plus where its data came from, so slow
 * opens on a real phone can be diagnosed from Diagnostics or the console.
 * @module utils/startup-timings
 */

/** @type {Array<{name: string, t: number, detail: ?Rec}>} */
const marks = [];
/** @type {Rec} */
const info = {};
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * Record a startup step (first occurrence per page load only).
 * @param {string} name
 * @param {Rec} [detail]
 */
export function markStartup(name, detail) {
    if (marks.some(m => m.name === name)) return;
    try { performance.mark(`aadhat:${name}`, detail ? { detail } : undefined); } catch (_) { /* old WebView */ }
    marks.push({ name, t: Math.round(now()), detail: detail || null });
}

/**
 * Extra facts about the startup (e.g. per-listener fromCache / doc counts).
 * @param {string} key
 * @param {*} value
 */
export function noteStartup(key, value) {
    info[key] = value;
}

/** @returns {{marks: Array<{name: string, t: number, detail: ?Rec}>, info: Rec}} */
export function getStartupTimings() {
    return { marks: marks.map(m => ({ ...m })), info: JSON.parse(JSON.stringify(info)) };
}

/**
 * Rows for display: ms since page start and since the previous step.
 * @param {Array<{name: string, t: number}>} list
 * @returns {Array<{name: string, at: number, delta: number}>}
 */
export function startupRows(list = marks) {
    return list.map((m, i) => ({ name: m.name, at: m.t, delta: i ? m.t - list[i - 1].t : m.t }));
}

/** Logs the timings once the app is shown. */
export function logStartupTimings() {
    try {
        const rows = startupRows();
        const total = rows.length ? rows[rows.length - 1].at : 0;
        try { performance.measure('aadhat:startup', { start: 0, end: total }); } catch (_) { /* unsupported */ }
        console.info(`[Aadhat] startup ${total} ms`, rows.map(r => `${r.name} @${r.at} (+${r.delta})`).join(', '), info);
    } catch (_) { /* never break startup for diagnostics */ }
}
