/**
 * @fileoverview Speed check probes and the suspect analysis (#83), ported from
 * the staging perf-probe. Each probe returns null when its browser API is
 * missing, so the report always has something. Suspects carry an id and
 * params only; the Diagnostics page words them with t('ui.speed.<id>…').
 * Reads nothing from Firestore. Spec: docs/calculations.md DIAG-SCORE.
 * @module utils/perf-probe
 */

const MB = 1048576;

export function probeMemory(perf = globalThis.performance) {
    const m = perf?.memory;
    if (!m) return null;
    return {
        usedMB: Math.round(m.usedJSHeapSize / MB),
        limitMB: Math.round(m.jsHeapSizeLimit / MB),
        usedRatio: m.jsHeapSizeLimit ? m.usedJSHeapSize / m.jsHeapSizeLimit : 0
    };
}

export function probeDevice(nav = globalThis.navigator) {
    if (!nav) return null;
    return { deviceMemoryGB: nav.deviceMemory ?? null, cpuCores: nav.hardwareConcurrency ?? null };
}

export function probeNetwork(nav = globalThis.navigator) {
    if (!nav) return null;
    const c = nav.connection || nav.mozConnection || nav.webkitConnection;
    return {
        online: nav.onLine !== false,
        effectiveType: c?.effectiveType ?? null,
        downlinkMbps: c?.downlink ?? null,
        rttMs: c?.rtt ?? null,
        saveData: !!c?.saveData
    };
}

export function probeServiceWorker(nav = globalThis.navigator) {
    if (!nav?.serviceWorker) return { supported: false };
    return { supported: true, hasController: !!nav.serviceWorker.controller };
}

export function probeNavigation(perf = globalThis.performance) {
    const n = perf?.getEntriesByType?.('navigation')?.[0];
    if (!n) return null;
    return {
        pageLoadMs: Math.max(0, Math.round(n.loadEventEnd - n.startTime)),
        domContentLoadedMs: Math.max(0, Math.round(n.domContentLoadedEventEnd - n.startTime))
    };
}

/** JSON length of a value (null when it can't be serialised). */
export function approxBytes(value) {
    if (value === null || value === undefined) return 0;
    try {
        const s = JSON.stringify(value);
        return s ? s.length : 0;
    } catch (_) {
        return null;
    }
}

const APP_STATE_LISTS = ['purchaseHistory', 'retailSalesHistory', 'salesHistory', 'expenses', 'items', 'stock',
    'cashSessions', 'notifications', 'users'];

/** Sizes of the big AppState lists, largest first. */
export function probeAppState(state) {
    const byName = {};
    const collections = [];
    let totalBytes = 0;
    if (!state || typeof state !== 'object') return { collections, totalBytes, byName };
    for (const name of APP_STATE_LISTS) {
        const value = state[name];
        if (value === undefined || value === null) continue;
        const count = Array.isArray(value) ? value.length : typeof value === 'object' ? Object.keys(value).length : 1;
        const bytes = approxBytes(value);
        if (typeof bytes === 'number') totalBytes += bytes;
        const entry = { name, count, approxBytes: bytes };
        collections.push(entry);
        byName[name] = entry;
    }
    collections.sort((a, b) => (b.approxBytes || 0) - (a.approxBytes || 0));
    return { collections, totalBytes, byName };
}

const longTasks = { list: [], observer: null };

/** Starts recording main-thread tasks over 50 ms (call once at start; a no-op without the API). */
export function startLongTaskRecorder(Observer = globalThis.PerformanceObserver) {
    if (longTasks.observer) return true;
    if (typeof Observer === 'undefined' || !Observer) return false;
    try {
        const obs = new Observer(list => {
            for (const e of list.getEntries()) {
                longTasks.list.push({ startTime: e.startTime, durationMs: e.duration });
                if (longTasks.list.length > 100) longTasks.list.shift();
            }
        });
        obs.observe({ entryTypes: ['longtask'] });
        longTasks.observer = obs;
        return true;
    } catch (_) {
        return false;
    }
}

export function probeLongTasks(windowMs = 60000, perf = globalThis.performance) {
    const now = perf?.now ? perf.now() : 0;
    const recent = longTasks.list.filter(task => task.startTime >= now - windowMs);
    let totalMs = 0;
    recent.forEach(task => { totalMs += task.durationMs; });
    return { count: recent.length, totalMs: Math.round(totalMs) };
}

/** Test hook. */
export function _resetLongTasks(list = []) {
    longTasks.list = list;
}

export async function probeStorage(nav = globalThis.navigator) {
    if (!nav?.storage?.estimate) return null;
    try {
        const est = await nav.storage.estimate();
        return {
            usageMB: est.usage ? Math.round(est.usage / MB) : 0,
            quotaMB: est.quota ? Math.round(est.quota / MB) : 0,
            usedRatio: est.quota ? (est.usage || 0) / est.quota : 0
        };
    } catch (_) {
        return null;
    }
}

export const THRESHOLDS = Object.freeze({
    history: { warn: 1500, bad: 3000 },
    items: { bad: 800 },
    stockKeys: { bad: 1500 },
    memoryUsedMB: { bad: 250 },
    memoryRatio: { bad: 0.8 },
    deviceMemoryGB: { bad: 2 },
    pageLoadMs: { bad: 5000 },
    longTaskCount: { bad: 8 },
    storageRatio: { bad: 0.85 }
});

/** Points taken off the score of 100 per suspect (DIAG-SCORE). */
export const SEVERITY_COST = Object.freeze({ high: 25, med: 12, low: 4 });
const RANK = { high: 3, med: 2, low: 1 };

const suspect = (severity, id, params = {}) => ({ severity, id, params });

/**
 * Ranked suspects and a 0–100 score (DIAG-SCORE: 100 − 25 per high − 12 per
 * medium − 4 per low suspect, never below 0).
 * @param {Object} p probes: memory, device, network, sw, navigation, appState, longTasks, storage
 * @returns {{score: number, suspects: Array<{severity: string, id: string, params: Object}>}}
 */
export function analyseProbes(p = {}) {
    const out = [];
    for (const list of ['purchaseHistory', 'retailSalesHistory', 'salesHistory']) {
        const c = p.appState?.byName?.[list];
        if (!c) continue;
        if (c.count >= THRESHOLDS.history.bad) out.push(suspect('high', 'history_large', { list, count: c.count }));
        else if (c.count >= THRESHOLDS.history.warn) out.push(suspect('med', 'history_growing', { list, count: c.count }));
    }
    const items = p.appState?.byName?.items;
    if (items && items.count >= THRESHOLDS.items.bad) out.push(suspect('med', 'items_many', { count: items.count }));
    const stock = p.appState?.byName?.stock;
    if (stock && stock.count >= THRESHOLDS.stockKeys.bad) out.push(suspect('med', 'stock_many', { count: stock.count }));
    if (p.memory) {
        if (p.memory.usedRatio >= THRESHOLDS.memoryRatio.bad) {
            out.push(suspect('high', 'memory_full', { percent: Math.round(p.memory.usedRatio * 100), used: p.memory.usedMB, limit: p.memory.limitMB }));
        } else if (p.memory.usedMB >= THRESHOLDS.memoryUsedMB.bad) {
            out.push(suspect('med', 'memory_high', { used: p.memory.usedMB }));
        }
    }
    if (p.device?.deviceMemoryGB && p.device.deviceMemoryGB <= THRESHOLDS.deviceMemoryGB.bad) {
        out.push(suspect('med', 'low_ram', { gb: p.device.deviceMemoryGB }));
    }
    if (p.network && !p.network.online) out.push(suspect('high', 'offline'));
    else if (p.network && (p.network.effectiveType === '2g' || p.network.effectiveType === 'slow-2g')) {
        out.push(suspect('high', 'slow_network', { type: p.network.effectiveType }));
    }
    if (p.sw?.supported && !p.sw.hasController) out.push(suspect('low', 'no_service_worker'));
    if (p.navigation && p.navigation.pageLoadMs >= THRESHOLDS.pageLoadMs.bad) {
        out.push(suspect('med', 'slow_start', { seconds: (p.navigation.pageLoadMs / 1000).toFixed(1) }));
    }
    if (p.longTasks && p.longTasks.count >= THRESHOLDS.longTaskCount.bad) {
        out.push(suspect('high', 'long_tasks', { count: p.longTasks.count, ms: p.longTasks.totalMs }));
    }
    if (p.storage && p.storage.usedRatio >= THRESHOLDS.storageRatio.bad) {
        out.push(suspect('med', 'storage_full', { percent: Math.round(p.storage.usedRatio * 100), used: p.storage.usageMB, quota: p.storage.quotaMB }));
    }
    let score = 100;
    out.forEach(s => { score -= SEVERITY_COST[s.severity]; });
    out.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
    return { score: Math.max(0, score), suspects: out };
}

/**
 * Runs every probe now (storage is async).
 * @param {Object} state AppState
 * @returns {Promise<Object>} probes for analyseProbes
 */
export async function runProbes(state) {
    return {
        memory: probeMemory(),
        device: probeDevice(),
        network: probeNetwork(),
        sw: probeServiceWorker(),
        navigation: probeNavigation(),
        appState: probeAppState(state),
        longTasks: probeLongTasks(),
        storage: await probeStorage()
    };
}
