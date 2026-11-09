/**
 * Test in Production library (#217): lifecycle, evaluate rules, abandoned /
 * expired runs, error watcher, counter batching, failure-sample cap, no-PII
 * guard and the rollback decision.
 */
import {
    createTip, sanitizeProps, evaluatePolicy, normalizePolicies, validateDeclaration, durationBucket,
    dayKeyOf, mergeDelta, SYSTEM_REASONS, MAX_FAILURES_PER_DAY, STORE_KEYS, TAB_STALE_MS
} from '../tip/tip.js';
import { planFlush, buildHealthDoc, buildFailureDoc, makeDeviceId, FLUSH_INTERVAL_MS } from '../tip/report.js';

class MemoryStore {
    constructor() { this.data = {}; }
    getItem(k) { return k in this.data ? this.data[k] : null; }
    setItem(k, v) { this.data[k] = String(v); }
    removeItem(k) { delete this.data[k]; }
}

const T0 = new Date(2026, 9, 23, 10, 0, 0).getTime();
const DAY = dayKeyOf(T0);

function setup({ online = true, store = new MemoryStore(), tabId, start = T0 } = {}) {
    let now = start;
    const clock = { advance: (ms) => { now += ms; }, now: () => now };
    const tip = createTip({ now: () => now, store, appVersion: '1.6.0', buildId: 'b1', isOnline: () => online, tabId });
    tip.declareTest({
        id: 'Demo',
        reasons: { bad_total: 1, slow: 2 },
        timeoutMs: 60000,
        evaluate(props, flags, ctx) {
            if (flags.skip) return 'discard';
            if (props.ok === false) return { result: 'fail', reason: 'bad_total' };
            if (ctx.durationMs > 5000) return { result: 'warn', reason: 'slow' };
            return 'succeed';
        }
    });
    return { tip, clock, store };
}

const counts = (tip, test = 'Demo') => tip.takeDelta()[DAY]?.['1_6_0']?.[test];

describe('TIP lifecycle and evaluate', () => {
    it('succeed: counts the result and a duration bucket', () => {
        const { tip, clock } = setup();
        const run = tip.start('Demo', { props: { ok: true } });
        clock.advance(300);
        run.complete();
        expect(counts(tip)).toEqual({ n: { s: 1 }, d: { b1: 1 }, ms: 300 });
        expect(tip.activeCount()).toBe(0);
    });

    it('fail / warn / discard with reason codes from the declaration', () => {
        const { tip, clock } = setup();
        tip.start('Demo', { props: { ok: false } }).complete();
        const slow = tip.start('Demo');
        clock.advance(6000);
        slow.complete();
        tip.start('Demo', { flags: { skip: true } }).complete();
        expect(counts(tip)).toMatchObject({ n: { f: 1, w: 1, x: 1 }, r: { f1: 1, w2: 1 } });
    });

    it('completeAndFail skips evaluate; setProps/setFlag feed evaluate; a run completes once', () => {
        const { tip } = setup();
        const run = tip.start('Demo');
        run.setProps({ ok: false });
        run.complete();
        run.complete();
        tip.start('Demo').completeAndFail('slow');
        const flagged = tip.start('Demo');
        flagged.setFlag('skip');
        flagged.complete();
        expect(counts(tip).n).toEqual({ f: 2, x: 1 });
    });

    it('a throwing evaluate is reported as fail(evaluate_threw), never thrown', () => {
        const { tip } = setup();
        tip.declareTest({ id: 'Broken', evaluate() { throw new Error('bug'); } });
        expect(() => tip.start('Broken').complete()).not.toThrow();
        expect(counts(tip, 'Broken')).toMatchObject({ n: { f: 1 }, r: { [`f${SYSTEM_REASONS.evaluate_threw}`]: 1 } });
    });

    it('unknown test or disabled TIP returns a no-op handle', () => {
        const { tip } = setup();
        expect(() => tip.start('Nope').complete()).not.toThrow();
        tip.setEnabled(false);
        tip.start('Demo').complete();
        expect(tip.hasPending()).toBe(false);
    });

    it('rejects bad declarations (reason codes 1..0x3FFF, unique)', () => {
        const ev = () => 'succeed';
        expect(() => validateDeclaration({ id: 'X1', evaluate: ev, reasons: { a: 0 } })).toThrow();
        expect(() => validateDeclaration({ id: 'X1', evaluate: ev, reasons: { a: 0x4000 } })).toThrow();
        expect(() => validateDeclaration({ id: 'X1', evaluate: ev, reasons: { a: 1, b: 1 } })).toThrow();
        expect(() => validateDeclaration({ id: 'bad id', evaluate: ev })).toThrow();
        expect(validateDeclaration({ id: 'X1', evaluate: ev, reasons: { a: 1, b: 0x3FFF } })).toBe(true);
    });
});

describe('TIP abandoned / expired / error watcher', () => {
    it('runs left open by a previous session are reported as abandoned on next launch', () => {
        const store = new MemoryStore();
        const first = setup({ store });
        first.tip.start('Demo');
        first.tip.takeDelta();
        const second = setup({ store, start: T0 + TAB_STALE_MS + 1000 });
        expect(second.tip.recoverAbandoned()).toBe(1);
        expect(counts(second.tip)).toMatchObject({ n: { a: 1 }, r: { [`a${SYSTEM_REASONS.abandoned}`]: 1 } });
        expect(second.tip.recoverAbandoned()).toBe(0);
    });

    it('two open tabs: no double counting, and a live tab\'s runs are not "abandoned"', () => {
        const store = new MemoryStore();
        const a = setup({ store, tabId: 'tabA' });
        const b = setup({ store, tabId: 'tabB' });
        const runA = a.tip.start('Demo');
        const runB = b.tip.start('Demo');
        expect(b.tip.recoverAbandoned()).toBe(0);
        expect(a.tip.recoverAbandoned()).toBe(0);
        runA.complete();
        expect(JSON.parse(store.getItem(STORE_KEYS.active))).toEqual({ [runB.id]: expect.objectContaining({ tab: 'tabB' }) });
        runB.complete();
        b.tip.start('Demo').complete();
        // One flush (from either tab) takes everything once; the other finds nothing.
        expect(a.tip.takeDelta()[DAY]['1_6_0'].Demo.n.s).toBe(3);
        expect(b.tip.hasPending()).toBe(false);
        expect(b.tip.takeDelta()).toEqual({});
        expect(a.tip.history('Demo')).toHaveLength(3);
    });

    it('a tab whose heartbeat went stale (> 2 min) has its open runs recovered by another tab, once', () => {
        const store = new MemoryStore();
        const a = setup({ store, tabId: 'tabA' });
        const b = setup({ store, tabId: 'tabB' });
        a.tip.start('Demo');
        b.tip.start('Demo');
        b.clock.advance(TAB_STALE_MS - 1000);
        b.tip.heartbeat();
        expect(b.tip.recoverAbandoned()).toBe(0); // tabA still fresh enough
        b.clock.advance(2000);
        b.tip.heartbeat();
        expect(b.tip.recoverAbandoned()).toBe(1); // tabA gone; tabB's own run untouched
        expect(b.tip.activeCount()).toBe(1);
        expect(b.tip.recoverAbandoned()).toBe(0);
        // a tab that closes for good (endTab) is recovered right away
        const c = setup({ store, tabId: 'tabC', start: b.clock.now() });
        c.tip.start('Demo');
        c.tip.endTab();
        expect(b.tip.recoverAbandoned()).toBe(1);
    });

    it('onAbandon lets a scenario discard/ignore an abandoned run (e.g. queued offline save)', () => {
        const store = new MemoryStore();
        const a = setup({ store, tabId: 'tabA' });
        a.tip.declareTest({ id: 'Queued', onAbandon: (flags) => (flags.offline ? 'discard' : 'fail'), evaluate: () => 'succeed' });
        a.tip.start('Queued', { flags: { offline: true } });
        a.tip.start('Queued', { flags: { offline: false } });
        a.tip.endTab();
        const b = setup({ store, tabId: 'tabB' });
        b.tip.declareTest({ id: 'Queued', onAbandon: (flags) => (flags.offline ? 'discard' : 'fail'), evaluate: () => 'succeed' });
        expect(b.tip.recoverAbandoned()).toBe(2);
        expect(counts(b.tip, 'Queued').n).toEqual({ x: 1, a: 1 });
        expect(b.tip.takeFailures().map(f => f.result)).toEqual(['abandoned']);
        expect(() => validateDeclaration({ id: 'Q1', onAbandon: 'maybe', evaluate: () => 'succeed' })).toThrow();
    });

    it('AppStart completes before the auto-save restore prompt (main.js order)', () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
        const done = src.indexOf('appStart.complete();');
        expect(done).toBeGreaterThan(0);
        expect(done).toBeLessThan(src.indexOf('BillingManager.checkAutoSave();'));
    });

    it('a run past its timeout is reported as expired by sweep()', () => {
        const { tip, clock } = setup();
        tip.start('Demo');
        clock.advance(30000);
        tip.sweep();
        expect(tip.activeCount()).toBe(1);
        clock.advance(31000);
        tip.sweep();
        expect(counts(tip)).toMatchObject({ n: { e: 1 }, r: { [`e${SYSTEM_REASONS.expired}`]: 1 } });
    });

    it('errors seen during a run turn a pass into warn(errors_seen)', () => {
        const { tip } = setup();
        const run = tip.start('Demo');
        tip.noteError();
        run.complete();
        tip.noteError(); // no open run: ignored
        expect(counts(tip)).toMatchObject({ n: { w: 1 }, r: { [`w${SYSTEM_REASONS.errors_seen}`]: 1 } });
    });
});

describe('TIP batching and failure samples', () => {
    it('accumulates counters until taken; restoreDelta puts a failed write back', () => {
        const { tip } = setup();
        tip.start('Demo').complete();
        tip.start('Demo').complete();
        const delta = tip.takeDelta();
        expect(delta[DAY]['1_6_0'].Demo.n.s).toBe(2);
        expect(tip.hasPending()).toBe(false);
        tip.restoreDelta(delta);
        tip.start('Demo').complete();
        expect(counts(tip).n.s).toBe(3);
    });

    it('pending counters survive an app restart (localStorage)', () => {
        const store = new MemoryStore();
        setup({ store }).tip.start('Demo').complete();
        expect(counts(setup({ store }).tip).n.s).toBe(1);
    });

    it('keeps at most 20 failure samples per device per day, numbered 1..20', () => {
        const { tip } = setup();
        for (let i = 0; i < 25; i++) tip.start('Demo', { props: { ok: false } }).complete();
        const samples = tip.takeFailures();
        expect(samples).toHaveLength(MAX_FAILURES_PER_DAY);
        expect(samples.map(s => s.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
        expect(samples[0]).toMatchObject({ test: 'Demo', result: 'fail', reason: 1, reasonName: 'bad_total', appVersion: '1.6.0', buildId: 'b1', day: DAY });
        expect(counts(tip).n.f).toBe(25);
    });

    it('planFlush: counters at most once per 30 minutes, failures debounced', () => {
        expect(planFlush({ now: T0, lastFlushAt: T0 - 60000, hasPending: true, hasFailures: false }).counters).toBe(false);
        expect(planFlush({ now: T0, lastFlushAt: T0 - FLUSH_INTERVAL_MS, hasPending: true }).counters).toBe(true);
        expect(planFlush({ now: T0, lastFlushAt: 0, hasPending: false }).counters).toBe(false);
        expect(planFlush({ now: T0, lastFailureFlushAt: T0 - 5000, hasFailures: true }).failures).toBe(false);
        expect(planFlush({ now: T0, lastFailureFlushAt: T0 - 61000, hasFailures: true }).failures).toBe(true);
    });

    it('buildHealthDoc turns every counter into an increment; failure docs carry no extra fields', () => {
        const inc = (n) => ({ inc: n });
        const doc = buildHealthDoc({
            deviceId: 'abc', day: DAY, uid: 'u1', delta: { '1_6_0': { Demo: { n: { s: 2 }, d: { b1: 2 }, ms: 600 } } },
            appVersion: '1.6.0', buildId: 'b', platform: 'web', inc, serverTime: 'TS'
        });
        expect(doc.v['1_6_0'].Demo).toEqual({ n: { s: { inc: 2 } }, d: { b1: { inc: 2 } }, ms: { inc: 600 } });
        expect(Object.keys(doc).sort()).toEqual(['appVersion', 'buildId', 'day', 'deviceId', 'platform', 'uid', 'updatedAt', 'v']);
        const f = buildFailureDoc({ uid: 'u1', deviceId: 'abc', platform: 'web', serverTime: 'TS',
            failure: { seq: 1, day: DAY, test: 'Demo', result: 'fail', reason: 1, reasonName: 'bad_total', flags: {}, props: {}, durationMs: null, errors: 0, at: T0, appVersion: '1.6.0', buildId: 'b' } });
        expect(f).not.toHaveProperty('durationMs');
        expect(f).not.toHaveProperty('seq');
    });

    it('device id is lowercase alphanumeric and differs per user on the same install', () => {
        const a = makeDeviceId('k3j4h5g6', 'uidA');
        expect(a).toMatch(/^[a-z0-9]{6,20}$/);
        expect(makeDeviceId('k3j4h5g6', 'uidB')).not.toBe(a);
    });

    it('mergeDelta adds nested counters and helpers bucket durations', () => {
        const a = { [DAY]: { v: { T: { n: { s: 1 }, ms: 5 } } } };
        mergeDelta(a, { [DAY]: { v: { T: { n: { s: 2, f: 1 }, ms: 5 } } } });
        expect(a[DAY].v.T).toEqual({ n: { s: 3, f: 1 }, ms: 10 });
        expect(durationBucket(100)).toBe('b0');
        expect(durationBucket(30000)).toBe('b7');
    });
});

describe('TIP no-PII guard', () => {
    it('drops PII-looking keys, long strings, phone-like values and objects', () => {
        const { clean, dropped } = sanitizeProps({
            customerName: 'Ramesh', phone: '98765', partyId: 'x', note: 'hi', supplier: 'y',
            kind: 'retail', lines: 3, ok: true, long: 'x'.repeat(65), mobileLike: 'call 9876543210',
            email: 'a@b.c', nested: { a: 1 }, total100: 1234.567
        });
        expect(clean).toEqual({ kind: 'retail', lines: 3, ok: true, total100: 1234.57 });
        expect(dropped.sort()).toEqual(['customerName', 'email', 'long', 'mobileLike', 'nested', 'note', 'partyId', 'phone', 'supplier'].sort());
    });

    it('never stores dropped properties on a run', () => {
        const { tip } = setup();
        tip.start('Demo', { props: { ok: false, customer: 'Ramesh', name: 'R' } }).complete({ phone: '1' });
        const [sample] = tip.takeFailures();
        expect(sample.props).toEqual({ ok: false });
        expect(JSON.stringify(sample)).not.toMatch(/Ramesh/);
    });
});

describe('TIP rollback decision', () => {
    const policy = { test: 'Demo', reason: 'bad_total', passrate: 25, count: 5, telemetryOnly: false };

    it('evaluatePolicy needs `count` runs and trips below the pass rate', () => {
        const fail = { r: 'f', c: 1 };
        const ok = { r: 's', c: 0 };
        expect(evaluatePolicy(policy, [fail, fail, fail, fail], { bad_total: 1 })).toMatchObject({ tripped: false, passrate: null });
        expect(evaluatePolicy(policy, [ok, fail, fail, fail, fail], { bad_total: 1 })).toMatchObject({ tripped: true, passrate: 20 });
        expect(evaluatePolicy(policy, [ok, ok, fail, fail, fail], { bad_total: 1 })).toMatchObject({ tripped: false, passrate: 40 });
        // other failure reasons don't count against a reason-specific policy
        expect(evaluatePolicy(policy, Array(5).fill({ r: 'f', c: 2 }), { bad_total: 1 }).tripped).toBe(false);
        // ignore / discard are not runs
        expect(evaluatePolicy(policy, [fail, fail, fail, fail, { r: 'x', c: 0 }], { bad_total: 1 }).tripped).toBe(false);
    });

    it('isRolledBack only when tripped and not telemetry-only; reports rolled_back once per day', () => {
        const { tip } = setup();
        tip.setPolicies({ demoFeature: policy, watchOnly: { ...policy, telemetryOnly: true } });
        expect(tip.isRolledBack('demoFeature')).toBe(false);
        for (let i = 0; i < 5; i++) tip.start('Demo', { props: { ok: false } }).complete();
        expect(tip.isRolledBack('demoFeature')).toBe(true);
        expect(tip.isRolledBack('watchOnly')).toBe(false);
        expect(tip.policyState('watchOnly')).toMatchObject({ tripped: true, active: false, telemetryOnly: true });
        const c = counts(tip);
        expect(c.n.rb).toBe(2); // one per policy, once per day
        expect(c.r[`rb${SYSTEM_REASONS.rolled_back}`]).toBe(2);
        const samples = tip.takeFailures().filter(s => s.result === 'rolled_back');
        expect(samples.map(s => s.flags)).toEqual([
            { policy: 'demoFeature', telemetryOnly: false }, { policy: 'watchOnly', telemetryOnly: true }
        ]);
    });

    it('normalizePolicies defaults to telemetry-only and drops bad entries', () => {
        expect(normalizePolicies({
            billChecksBlocking: { test: 'BillSave', reason: 'blocked_valid_bill', passrate: 25, count: 5 },
            'bad key': { test: 'BillSave' },
            noTest: { reason: 'x' }
        })).toEqual({
            billChecksBlocking: { test: 'BillSave', reason: 'blocked_valid_bill', passrate: 25, count: 5, telemetryOnly: true }
        });
    });

    it('a broken store never throws into product code', () => {
        const store = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
        const { tip } = setup({ store });
        expect(() => tip.start('Demo').complete()).not.toThrow();
        expect(tip.takeDelta()[DAY]['1_6_0'].Demo.n.s).toBe(1);
        expect(STORE_KEYS.active).toBe('aadhat.tip.active');
    });
});
