/**
 * @fileoverview TIP Health page maths (#217): pure aggregation of tipHealth
 * documents into pass rates per test per day / app version, top failure
 * reasons, duration percentiles and affected devices.
 * @module tip/health-stats
 */

import { COUNTED_KEYS, PASS_KEYS, SYSTEM_REASONS, DURATION_BUCKETS } from './tip.js';

export const DEFAULT_TARGET = 95;
export const MIN_RUNS_FOR_BANNER = 5;

const sumKeys = (n, keys) => keys.reduce((s, k) => s + (Number(n?.[k]) || 0), 0);

/** Pass rate in % (1 decimal) of a result-count map, or null when nothing counted. */
export function passRate(n) {
    const counted = sumKeys(n, COUNTED_KEYS);
    if (!counted) return null;
    return Math.round((sumKeys(n, PASS_KEYS) / counted) * 1000) / 10;
}

/** Runs that count in the pass rate. */
export const countedRuns = (n) => sumKeys(n, COUNTED_KEYS);
/** Failed runs (fail + abandoned + expired). */
export const failedRuns = (n) => sumKeys(n, ['f', 'a', 'e']);

function addInto(dst, src) {
    for (const [k, v] of Object.entries(src || {})) dst[k] = (dst[k] || 0) + (Number(v) || 0);
    return dst;
}

/** Day key n days before YYYYMMDD. */
export function addDays(dayKey, n) {
    const y = Number(dayKey.slice(0, 4));
    const m = Number(dayKey.slice(4, 6));
    const d = Number(dayKey.slice(6, 8));
    const dt = new Date(y, m - 1, d + n);
    return `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
}

/** The last `count` days ending at `today`, newest first. */
export function lastDays(today, count) {
    return Array.from({ length: count }, (_, i) => addDays(today, -i));
}

/**
 * Approximate percentile (ms) from duration buckets: the upper bound of the
 * bucket that holds it (the last bucket reports its lower bound, "≥").
 */
export function percentileFromBuckets(d, p) {
    const counts = DURATION_BUCKETS.map((_, i) => Number(d?.[`b${i}`]) || 0);
    counts.push(Number(d?.[`b${DURATION_BUCKETS.length}`]) || 0);
    const total = counts.reduce((a, b) => a + b, 0);
    if (!total) return null;
    const rank = Math.ceil((p / 100) * total);
    let seen = 0;
    for (let i = 0; i < counts.length; i++) {
        seen += counts[i];
        if (seen >= rank) return DURATION_BUCKETS[Math.min(i, DURATION_BUCKETS.length - 1)];
    }
    return DURATION_BUCKETS[DURATION_BUCKETS.length - 1];
}

/**
 * Reason name for a code.
 * @param {string} test
 * @param {number|string} code
 * @param {Object} reasonsByTest - {test: {name: code}}
 */
export function reasonName(test, code, reasonsByTest = {}) {
    const c = Number(code);
    const own = Object.entries(reasonsByTest[test] || {}).find(([, v]) => v === c);
    if (own) return own[0];
    const sys = Object.entries(SYSTEM_REASONS).find(([, v]) => v === c);
    return sys ? sys[0] : `reason_${c}`;
}

/**
 * Aggregate tipHealth docs.
 * @param {Array<Object>} docs - {deviceId, day, platform, appVersion, v: {ver: {test: {n, r, d, ms}}}}
 * @param {{reasonsByTest?: Object}} [opts]
 */
export function aggregateHealth(docs, { reasonsByTest = {} } = {}) {
    const byTestDay = {};
    const byTestVersion = {};
    const totals = {};
    const reasonCounts = {};
    const buckets = {};
    const devices = {};
    const deviceTests = {};

    (docs || []).forEach(doc => {
        if (!doc || !doc.v || typeof doc.v !== 'object') return;
        const dev = devices[doc.deviceId] = devices[doc.deviceId] || {
            deviceId: doc.deviceId, uid: doc.uid || '', platform: doc.platform || '', appVersion: doc.appVersion || '', lastDay: '', runs: 0, failed: 0
        };
        if ((doc.day || '') >= dev.lastDay) {
            dev.lastDay = doc.day || '';
            dev.appVersion = doc.appVersion || dev.appVersion;
            dev.platform = doc.platform || dev.platform;
            dev.uid = doc.uid || dev.uid;
        }
        for (const [ver, testsMap] of Object.entries(doc.v)) {
            for (const [test, c] of Object.entries(testsMap || {})) {
                const n = c?.n || {};
                ((byTestDay[test] = byTestDay[test] || {})[doc.day] = addInto(byTestDay[test][doc.day] || {}, n));
                ((byTestVersion[test] = byTestVersion[test] || {})[ver] = addInto(byTestVersion[test][ver] || {}, n));
                totals[test] = addInto(totals[test] || {}, n);
                buckets[test] = addInto(buckets[test] || {}, c?.d);
                for (const [rk, count] of Object.entries(c?.r || {})) {
                    const m = /^([a-z]+)(\d+)$/.exec(rk);
                    // Top *failure* reasons: failed, abandoned, expired
                    if (!m || !['f', 'a', 'e'].includes(m[1])) continue;
                    const key = `${test}|${m[2]}`;
                    reasonCounts[key] = (reasonCounts[key] || 0) + (Number(count) || 0);
                }
                dev.runs += countedRuns(n);
                dev.failed += failedRuns(n);
                const dt = (deviceTests[test] = deviceTests[test] || {});
                dt[doc.deviceId] = (dt[doc.deviceId] || 0) + failedRuns(n);
            }
        }
    });

    const reasons = Object.entries(reasonCounts)
        .map(([key, count]) => {
            const [test, code] = key.split('|');
            return { test, code: Number(code), name: reasonName(test, code, reasonsByTest), count };
        })
        .filter(r => r.count > 0)
        .sort((a, b) => b.count - a.count || a.test.localeCompare(b.test));

    const durations = {};
    Object.entries(buckets).forEach(([test, d]) => {
        durations[test] = { p50: percentileFromBuckets(d, 50), p90: percentileFromBuckets(d, 90) };
    });

    const devicesByTest = {};
    Object.entries(deviceTests).forEach(([test, m]) => {
        const ids = Object.keys(m);
        devicesByTest[test] = { total: ids.length, failing: ids.filter(id => m[id] > 0).length };
    });

    return {
        tests: Object.keys(totals).sort(),
        byTestDay,
        byTestVersion,
        totals,
        reasons,
        durations,
        devices: Object.values(devices).sort((a, b) => b.failed - a.failed || b.runs - a.runs),
        devicesByTest
    };
}

/**
 * Tests below their target on `day` with at least `minRuns` counted runs
 * (Today banner).
 * @returns {Array<{test: string, rate: number, target: number, runs: number}>}
 */
export function belowTarget(docs, { day, targets = {}, defaultTarget = DEFAULT_TARGET, minRuns = MIN_RUNS_FOR_BANNER } = {}) {
    const agg = aggregateHealth((docs || []).filter(d => d && d.day === day));
    return agg.tests
        .map(test => {
            const n = agg.totals[test];
            const target = Number.isFinite(Number(targets[test])) ? Number(targets[test]) : defaultTarget;
            return { test, rate: passRate(n), target, runs: countedRuns(n) };
        })
        .filter(x => x.runs >= minRuns && x.rate !== null && x.rate < x.target)
        .sort((a, b) => a.rate - b.rate);
}
