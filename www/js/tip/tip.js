/**
 * @fileoverview Test in Production (TIP, #217): declared scenario tests that
 * run inside real user flows and report pass/fail counts from live devices.
 *
 * Pure apart from the injected `store` (localStorage-like) and clock, so it is
 * unit-tested directly. Browser wiring (error watcher, timers, Firestore sink)
 * lives in tip/index.js.
 *
 * Lifecycle: declareTest() → start() → setFlag()/setProps() → complete() or
 * completeAndFail(reason) → the test's evaluate(props, flags, ctx) returns
 * succeed / fail / warn / ignore / discard (+ reason). Runs left open when the
 * app is closed are reported as `abandoned` on the next launch; runs older
 * than their timeout as `expired`.
 *
 * "Do no harm": every public method swallows its own errors. Product code
 * never sees a TIP exception.
 * @module tip/tip
 */

/** Results evaluate() may return. `warn` = succeeded with a warning. */
export const RESULTS = ['succeed', 'fail', 'warn', 'ignore', 'discard'];

/** Short counter keys stored in tipHealth (keeps documents small). Reason
 * counters are keyed result + code, e.g. `f1` = failed with reason 1. */
export const RESULT_KEYS = {
    succeed: 's', fail: 'f', warn: 'w', ignore: 'i', discard: 'x',
    abandoned: 'a', expired: 'e', rolled_back: 'rb'
};

/** Results that count in the pass rate (ignore / discard / rolled_back don't). */
export const COUNTED_KEYS = ['s', 'w', 'f', 'a', 'e'];
/** Results that pass. */
export const PASS_KEYS = ['s', 'w'];
/** Results that produce a failure sample. */
const SAMPLE_KEYS = ['f', 'a', 'e', 'rb'];

/** Test reasons are 1..MAX_REASON; above that is reserved for the framework. */
export const MAX_REASON = 0x3FFF;
export const SYSTEM_REASONS = {
    abandoned: 0x4001,
    expired: 0x4002,
    errors_seen: 0x4003,
    evaluate_threw: 0x4004,
    rolled_back: 0x4005,
    bad_verdict: 0x4006
};

/** Duration bucket upper bounds (ms): b0 < 250 … b7 >= 30 s. */
export const DURATION_BUCKETS = [250, 500, 1000, 2000, 5000, 10000, 30000];

export const MAX_FAILURES_PER_DAY = 20;
export const MAX_PROPS = 12;
export const MAX_STRING = 64;
const HISTORY_LEN = 20;
const ABANDON_MAX_AGE_MS = 3 * 86400000;

export const STORE_KEYS = {
    active: 'aadhat.tip.active',
    pending: 'aadhat.tip.pending',
    failures: 'aadhat.tip.failures',
    failCount: 'aadhat.tip.failCount',
    testFailCount: 'aadhat.tip.testFailCount',
    history: 'aadhat.tip.history',
    rolledBack: 'aadhat.tip.rolledBack',
    tabs: 'aadhat.tip.tabs'
};

/** A tab whose heartbeat is older than this is gone; its open runs were abandoned. */
export const TAB_STALE_MS = 2 * 60 * 1000;

const ID_RE = /^[A-Za-z][A-Za-z0-9]{1,31}$/;
const PROP_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
/** Property keys that could carry personal data are never recorded. */
const PII_KEY_RE = /name|phone|mobile|customer|party|supplier|email|address|note|comment|remark|person|contact|aadhaar|gstin/i;
/** Long digit runs (phone / account numbers) and e-mail addresses. */
const PII_VALUE_RE = /\d{7,}|@/;

/**
 * Keep only safe properties: short keys without PII words, primitive values,
 * strings of at most MAX_STRING chars without phone-like digit runs, numbers
 * rounded to 2 decimals. At most MAX_PROPS keys.
 * @param {Object} input
 * @returns {{clean: Object, dropped: string[]}}
 */
export function sanitizeProps(input) {
    const clean = {};
    const dropped = [];
    if (!input || typeof input !== 'object') return { clean, dropped };
    for (const [key, value] of Object.entries(input)) {
        const keyOk = PROP_KEY_RE.test(key) && !PII_KEY_RE.test(key) && Object.keys(clean).length < MAX_PROPS;
        let v = value;
        let valueOk;
        if (typeof v === 'number') {
            valueOk = Number.isFinite(v);
            v = Math.round(v * 100) / 100;
        } else if (typeof v === 'string') {
            valueOk = v.length <= MAX_STRING && !PII_VALUE_RE.test(v);
        } else {
            valueOk = v === null || typeof v === 'boolean';
        }
        if (keyOk && valueOk) clean[key] = v;
        else dropped.push(key);
    }
    return { clean, dropped };
}

/** Local calendar day as YYYYMMDD. */
export function dayKeyOf(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** App version usable as a Firestore map key ("1.6.0" → "1_6_0"). */
export function versionKey(version) {
    return String(version || 'unknown').replace(/[^A-Za-z0-9]/g, '_').slice(0, 20) || 'unknown';
}

/** Duration bucket key for ms. */
export function durationBucket(ms) {
    const v = Math.max(0, Number(ms) || 0);
    const i = DURATION_BUCKETS.findIndex(limit => v < limit);
    return `b${i === -1 ? DURATION_BUCKETS.length : i}`;
}

/**
 * Validate a test declaration. Throws on a bad one (callers that must not
 * break the app catch it; unit tests assert the throw).
 */
export function validateDeclaration(decl) {
    if (!decl || !ID_RE.test(decl.id || '')) throw new Error(`TIP: bad test id ${decl && decl.id}`);
    if (typeof decl.evaluate !== 'function') throw new Error(`TIP: ${decl.id} has no evaluate()`);
    const seen = new Set();
    for (const [name, code] of Object.entries(decl.reasons || {})) {
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(name)) throw new Error(`TIP: ${decl.id} bad reason name ${name}`);
        if (!Number.isInteger(code) || code < 1 || code > MAX_REASON) throw new Error(`TIP: ${decl.id}.${name} code out of range`);
        if (seen.has(code)) throw new Error(`TIP: ${decl.id} duplicate reason code ${code}`);
        seen.add(code);
    }
    const ab = decl.onAbandon;
    if (ab !== undefined && typeof ab !== 'function' && !['fail', 'ignore', 'discard'].includes(ab)) {
        throw new Error(`TIP: ${decl.id} bad onAbandon ${ab}`);
    }
    return true;
}

/**
 * Normalise what evaluate() returned.
 * @returns {{result: string, reason: string|null}}
 */
export function normalizeVerdict(value) {
    if (typeof value === 'string' && RESULTS.includes(value)) return { result: value, reason: null };
    if (value && typeof value === 'object' && RESULTS.includes(value.result)) return { result: value.result, reason: value.reason || null };
    return { result: 'fail', reason: 'bad_verdict' };
}

/**
 * Rollback decision (like CFR rollback): among the last `count` counted runs
 * of `policy.test`, the share that passed — didn't end with `policy.reason`
 * (or, without a reason, ended succeed/warn) — is below `policy.passrate` %.
 * @param {{test: string, reason?: string, passrate?: number, count?: number}} policy
 * @param {Array<{r: string, c: number}>} history - oldest first
 * @param {Object} [reasons] - the test's reason name → code map
 * @returns {{tripped: boolean, runs: number, passrate: number|null}}
 */
export function evaluatePolicy(policy, history, reasons = {}) {
    const count = Math.max(1, Math.round(Number(policy?.count) || 5));
    const threshold = Number.isFinite(Number(policy?.passrate)) ? Number(policy.passrate) : 25;
    const counted = (history || []).filter(h => COUNTED_KEYS.includes(h.r)).slice(-count);
    if (counted.length < count) return { tripped: false, runs: counted.length, passrate: null };
    const code = policy.reason ? reasons[policy.reason] : null;
    const passed = counted.filter(h => (code ? h.c !== code : PASS_KEYS.includes(h.r))).length;
    const passrate = Math.round((passed / counted.length) * 1000) / 10;
    return { tripped: passrate < threshold, runs: counted.length, passrate };
}

/**
 * Validate owner-entered policies (settings/app.tipPolicies); bad entries are
 * dropped. telemetryOnly defaults to true.
 * @returns {Object} key → policy
 */
export function normalizePolicies(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [key, p] of Object.entries(raw)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key) || !p || typeof p !== 'object' || !ID_RE.test(p.test || '')) continue;
        const passrate = Number(p.passrate);
        const count = Number(p.count);
        out[key] = {
            test: p.test,
            reason: typeof p.reason === 'string' && p.reason ? p.reason : null,
            passrate: p.passrate != null && Number.isFinite(passrate) ? Math.min(100, Math.max(0, passrate)) : 25,
            count: p.count != null && Number.isFinite(count) ? Math.min(HISTORY_LEN, Math.max(1, Math.round(count))) : 5,
            telemetryOnly: p.telemetryOnly !== false
        };
    }
    return out;
}

const NOOP_RUN = Object.freeze({
    id: null,
    setFlag() { return this; },
    setProps() { return this; },
    complete() {},
    completeAndFail() {},
    discard() {}
});

/** Deep-add counter delta `b` into `a` (both {day: {ver: {test: {n, r, d, ms}}}}). */
export function mergeDelta(a, b) {
    const out = a || {};
    for (const [day, vers] of Object.entries(b || {})) {
        out[day] = out[day] || {};
        for (const [ver, testsMap] of Object.entries(vers || {})) {
            out[day][ver] = out[day][ver] || {};
            for (const [test, c] of Object.entries(testsMap || {})) {
                const dst = out[day][ver][test] = out[day][ver][test] || {};
                for (const group of ['n', 'r', 'd']) {
                    if (!c[group]) continue;
                    dst[group] = dst[group] || {};
                    for (const [k, v] of Object.entries(c[group])) dst[group][k] = (dst[group][k] || 0) + v;
                }
                if (c.ms) dst.ms = (dst.ms || 0) + c.ms;
            }
        }
    }
    return out;
}

/**
 * Create a TIP instance.
 * @param {Object} [opts]
 * @param {Function} [opts.now] - ms clock
 * @param {Object} [opts.store] - localStorage-like (getItem/setItem)
 * @param {string} [opts.appVersion]
 * @param {string} [opts.buildId]
 * @param {Function} [opts.isOnline] - () => boolean
 * @param {Function} [opts.onChange] - called after a result is recorded
 * @param {Function} [opts.log] - (message, error) for swallowed errors
 */
export function createTip(opts = {}) {
    const now = opts.now || (() => Date.now());
    const store = opts.store || null;
    const isOnline = opts.isOnline || (() => true);
    const log = opts.log || (() => {});
    const tabId = String(opts.tabId || `t${Math.random().toString(36).slice(2, 10)}`);
    const tests = new Map();
    const active = new Map();
    let enabled = true;
    let policies = {};
    let appVersion = opts.appVersion || 'unknown';
    let buildId = opts.buildId || '';
    let seq = 0;

    // Shared state lives in the store (localStorage is shared by every tab of
    // the app), so every operation re-reads it before changing it: two open
    // tabs never double-count or overwrite each other. `mem` keeps working
    // when there is no store or it fails (private mode / full).
    const mem = {};
    const read = (key, fallback) => {
        try {
            const raw = store ? store.getItem(key) : null;
            if (raw) return JSON.parse(raw);
        } catch (_) { /* fall back to memory */ }
        return mem[key] !== undefined ? JSON.parse(JSON.stringify(mem[key])) : fallback;
    };
    const write = (key, value) => {
        mem[key] = value;
        try { if (store) store.setItem(key, JSON.stringify(value)); } catch (_) { /* full / private mode */ }
    };
    const guard = (label, fn, fallback) => {
        try { return fn(); } catch (e) { log(`TIP ${label} failed`, e); return fallback; }
    };

    /** This tab is alive (other tabs only recover runs of tabs silent for > TAB_STALE_MS). */
    function heartbeat() {
        const tabs = read(STORE_KEYS.tabs, {});
        const t = now();
        Object.keys(tabs).forEach(id => { if (t - tabs[id] > 86400000) delete tabs[id]; });
        tabs[tabId] = t;
        write(STORE_KEYS.tabs, tabs);
    }

    /** Replace this tab's entries in the shared active-run map, keep other tabs'. */
    const persistActive = () => {
        const all = read(STORE_KEYS.active, {});
        Object.keys(all).forEach(id => { if (all[id]?.tab === tabId) delete all[id]; });
        active.forEach((run, id) => { all[id] = { t: run.test, s: run.startedAt, f: run.flags, v: run.version, tab: tabId }; });
        write(STORE_KEYS.active, all);
    };

    /** A test with `maxSamplesPerDay` keeps at most that many samples a day, so it can't use up the shared budget. */
    function overTestCap(testId, day) {
        const cap = tests.get(testId)?.maxSamplesPerDay;
        if (!Number.isFinite(cap)) return false;
        const fc = read(STORE_KEYS.testFailCount, {});
        const counts = fc.day === day && fc.counts ? fc.counts : {};
        const n = counts[testId] || 0;
        if (n >= cap) return true;
        write(STORE_KEYS.testFailCount, { day, counts: { ...counts, [testId]: n + 1 } });
        return false;
    }

    function nextFailureSeq(day) {
        const fc = read(STORE_KEYS.failCount, {});
        const n = fc.day === day ? fc.n : 0;
        if (n >= MAX_FAILURES_PER_DAY) return 0;
        write(STORE_KEYS.failCount, { day, n: n + 1 });
        return n + 1;
    }

    /** Count one result and keep a failure sample when needed. */
    function record(testId, result, reasonCode, reasonName, durationMs, { version, at, flags, props, errors }) {
        const key = RESULT_KEYS[result];
        const day = dayKeyOf(at);
        const c = { n: { [key]: 1 } };
        if (reasonCode) c.r = { [`${key}${reasonCode}`]: 1 };
        if (COUNTED_KEYS.includes(key) && durationMs != null) {
            c.d = { [durationBucket(durationMs)]: 1 };
            c.ms = Math.round(durationMs);
        }
        write(STORE_KEYS.pending, mergeDelta(read(STORE_KEYS.pending, {}), { [day]: { [versionKey(version)]: { [testId]: c } } }));

        const history = read(STORE_KEYS.history, {});
        const h = history[testId] = (history[testId] || []);
        h.push({ r: key, c: reasonCode || 0 });
        if (h.length > HISTORY_LEN) h.splice(0, h.length - HISTORY_LEN);
        write(STORE_KEYS.history, history);

        const failure = SAMPLE_KEYS.includes(key);
        if (failure && !overTestCap(testId, day)) {
            const n = nextFailureSeq(day);
            if (n) {
                const failures = read(STORE_KEYS.failures, []);
                failures.push({
                    seq: n, day, test: testId, result, reason: reasonCode || 0,
                    reasonName: reasonName || '', flags: flags || {}, props: props || {},
                    durationMs: durationMs == null ? null : Math.round(durationMs),
                    errors: errors || 0, at, appVersion: version || appVersion, buildId
                });
                write(STORE_KEYS.failures, failures);
            }
        }
        if (opts.onChange) guard('onChange', () => opts.onChange({ testId, result, failure }));
    }

    function reasonCodeOf(test, name) {
        if (!name) return 0;
        if (SYSTEM_REASONS[name]) return SYSTEM_REASONS[name];
        return (test && test.reasons && test.reasons[name]) || 0;
    }

    function finish(run, { failReason = null, expired = false, extraProps = null } = {}) {
        if (!active.has(run.id)) return;
        active.delete(run.id);
        persistActive();
        const test = tests.get(run.test);
        if (extraProps) Object.assign(run.props, sanitizeProps(extraProps).clean);
        const at = now();
        const durationMs = Math.max(0, at - run.startedAt);
        const ctx = { durationMs, errors: run.errors, expired, online: guard('isOnline', isOnline, true) };
        let verdict;
        if (failReason) {
            verdict = { result: 'fail', reason: failReason };
        } else {
            try {
                verdict = normalizeVerdict(test.evaluate({ ...run.props }, { ...run.flags }, ctx));
            } catch (e) {
                log(`TIP ${run.test}.evaluate threw`, e);
                verdict = { result: 'fail', reason: 'evaluate_threw' };
            }
        }
        let { result, reason } = verdict;
        if (expired && (result === 'succeed' || result === 'warn')) {
            result = 'expired';
            reason = 'expired';
        } else if (result === 'succeed' && run.errors > 0) {
            result = 'warn';
            reason = 'errors_seen';
        }
        record(run.test, result, reasonCodeOf(test, reason), reason, durationMs, {
            version: run.version, at, flags: run.flags, props: run.props, errors: run.errors
        });
        checkPolicies(run.test);
    }

    function makeRun(run) {
        return {
            id: run.id,
            setFlag(name, value = true) {
                guard('setFlag', () => {
                    if (!active.has(run.id)) return;
                    Object.assign(run.flags, sanitizeProps({ [name]: value }).clean);
                    persistActive();
                });
                return this;
            },
            setProps(props) {
                guard('setProps', () => {
                    if (active.has(run.id)) Object.assign(run.props, sanitizeProps(props).clean);
                });
                return this;
            },
            complete(props) { guard('complete', () => finish(run, { extraProps: props })); },
            completeAndFail(reason, props) {
                guard('completeAndFail', () => finish(run, { failReason: String(reason || 'fail'), extraProps: props }));
            },
            discard() {
                guard('discard', () => {
                    if (!active.delete(run.id)) return;
                    persistActive();
                    record(run.test, 'discard', 0, null, null, { version: run.version, at: now() });
                });
            }
        };
    }

    function checkPolicies(testId) {
        Object.keys(policies).forEach(key => {
            if (policies[key].test === testId) policyState(key);
        });
    }

    /** Evaluate a policy; reports `rolled_back` once per day while it is tripped. */
    function policyState(key) {
        const policy = policies[key];
        if (!policy) return { tripped: false, active: false, runs: 0, passrate: null };
        const test = tests.get(policy.test);
        const state = evaluatePolicy(policy, read(STORE_KEYS.history, {})[policy.test], test ? test.reasons : {});
        if (state.tripped) {
            const day = dayKeyOf(now());
            const seen = read(STORE_KEYS.rolledBack, {});
            if (seen[key] !== day) {
                seen[key] = day;
                write(STORE_KEYS.rolledBack, seen);
                record(policy.test, 'rolled_back', SYSTEM_REASONS.rolled_back, 'rolled_back', null, {
                    version: appVersion, at: now(),
                    flags: { policy: key, telemetryOnly: policy.telemetryOnly },
                    props: { passrate: state.passrate, runs: state.runs }
                });
            }
        }
        return { ...state, active: state.tripped && !policy.telemetryOnly, telemetryOnly: policy.telemetryOnly };
    }

    return {
        /** Register a scenario test. Throws on a bad declaration. */
        declareTest(decl) {
            validateDeclaration(decl);
            tests.set(decl.id, { reasons: {}, timeoutMs: 120000, ...decl });
            return decl.id;
        },

        /** Start a run; returns a handle (a no-op handle when disabled or on error). */
        start(testId, { flags, props } = {}) {
            return guard('start', () => {
                if (!enabled || !tests.has(testId)) return NOOP_RUN;
                const t = now();
                const run = {
                    id: `${testId}-${tabId}-${t.toString(36)}-${(seq++).toString(36)}`,
                    test: testId,
                    startedAt: t,
                    flags: sanitizeProps(flags).clean,
                    props: sanitizeProps(props).clean,
                    errors: 0,
                    version: appVersion
                };
                active.set(run.id, run);
                heartbeat();
                persistActive();
                return makeRun(run);
            }, NOOP_RUN);
        },

        /** Error watcher: count an error against every open run. */
        noteError() {
            guard('noteError', () => active.forEach(run => { run.errors += 1; }));
        },

        /** Report runs past their timeout as expired. */
        sweep() {
            guard('sweep', () => {
                const t = now();
                [...active.values()].forEach(run => {
                    const limit = tests.get(run.test)?.timeoutMs || 120000;
                    if (t - run.startedAt > limit) finish(run, { expired: true });
                });
            });
        },

        /**
         * Runs left open by a tab that is gone (app closed / killed / crashed:
         * its heartbeat is older than TAB_STALE_MS) are reported with the
         * test's abandon policy: `onAbandon` ('fail' default → `abandoned`,
         * 'ignore', 'discard', or a function of the saved flags). Runs of this
         * tab and of live tabs are left alone. Safe to call repeatedly.
         * @returns {number} runs recovered
         */
        recoverAbandoned() {
            return guard('recoverAbandoned', () => {
                const saved = read(STORE_KEYS.active, {});
                const tabs = read(STORE_KEYS.tabs, {});
                const t = now();
                let n = 0;
                Object.entries(saved || {}).forEach(([id, r]) => {
                    if (!r || r.tab === tabId || active.has(id)) return;
                    if (r.tab && tabs[r.tab] && t - tabs[r.tab] <= TAB_STALE_MS) return;
                    delete saved[id];
                    const test = tests.get(r.t);
                    if (!test || t - (Number(r.s) || 0) > ABANDON_MAX_AGE_MS) return;
                    const flags = r.f || {};
                    let policy = 'fail';
                    try {
                        policy = typeof test.onAbandon === 'function' ? test.onAbandon(flags) : (test.onAbandon || 'fail');
                    } catch (e) { log(`TIP ${r.t}.onAbandon threw`, e); }
                    const at = Number(r.s) || t;
                    if (policy === 'discard' || policy === 'ignore') {
                        record(r.t, policy, 0, null, null, { version: r.v || appVersion, at });
                    } else {
                        record(r.t, 'abandoned', SYSTEM_REASONS.abandoned, 'abandoned', null, { version: r.v || appVersion, at, flags });
                    }
                    n++;
                });
                write(STORE_KEYS.active, saved);
                return n;
            }, 0);
        },

        setEnabled(value) { enabled = value !== false; },
        isEnabled() { return enabled; },
        setVersion(version, build) { appVersion = version || appVersion; buildId = build || buildId; },
        getVersion() { return { appVersion, buildId }; },
        setPolicies(raw) { guard('setPolicies', () => { policies = normalizePolicies(raw); }); },
        getPolicies() { return { ...policies }; },

        /**
         * True only when the policy tripped AND it is not telemetry-only: the
         * feature should switch to its safe behaviour.
         */
        isRolledBack(key) {
            return guard('isRolledBack', () => policyState(key).active, false);
        },
        policyState(key) {
            return guard('policyState', () => policyState(key), { tripped: false, active: false, runs: 0, passrate: null });
        },

        /** Counter delta not yet written (all tabs); clears it in one read-modify-write. */
        takeDelta() {
            const out = read(STORE_KEYS.pending, {});
            write(STORE_KEYS.pending, {});
            return out;
        },
        /** Put back a delta whose write failed. */
        restoreDelta(delta) {
            guard('restoreDelta', () => write(STORE_KEYS.pending, mergeDelta(read(STORE_KEYS.pending, {}), delta)));
        },
        hasPending() { return Object.keys(read(STORE_KEYS.pending, {})).length > 0; },

        takeFailures() {
            const out = read(STORE_KEYS.failures, []);
            write(STORE_KEYS.failures, []);
            return out;
        },
        restoreFailures(list) {
            guard('restoreFailures', () => {
                write(STORE_KEYS.failures, [...(list || []), ...read(STORE_KEYS.failures, [])].slice(0, MAX_FAILURES_PER_DAY * 2));
            });
        },
        hasFailures() { return read(STORE_KEYS.failures, []).length > 0; },

        /** Mark this tab alive (call every ~30 s). */
        heartbeat() { guard('heartbeat', heartbeat); },
        /** This tab is closing for good: other tabs may recover its open runs right away. */
        endTab() {
            guard('endTab', () => {
                const tabs = read(STORE_KEYS.tabs, {});
                delete tabs[tabId];
                write(STORE_KEYS.tabs, tabs);
            });
        },
        tabId() { return tabId; },

        /** For tests / diagnostics. */
        activeCount() { return active.size; },
        history(testId) { return [...(read(STORE_KEYS.history, {})[testId] || [])]; },
        tests() { return [...tests.keys()]; },
        reasonsOf(testId) { return { ...(tests.get(testId)?.reasons || {}) }; }
    };
}
