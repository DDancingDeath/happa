/**
 * TIP scenarios (#217): each reports success on the happy path and the right
 * reason on its known failures.
 */
import { createTip, dayKeyOf } from '../tip/tip.js';
import { AppStartTest, APP_START_FAIL_MS } from '../tip/scenarios/app-start.js';
import { BillSaveTest, billSaveProps, AUTO_ROLLBACK_REASON } from '../tip/scenarios/bill-save.js';
import { PaymentRecordTest, paymentRecordProps, paymentErrorOutcome } from '../tip/scenarios/payment-record.js';
import { CashCloseTest, cashCloseProps } from '../tip/scenarios/cash-close.js';
import { SessionReadsTest, STARTUP_READS_WARN, STARTUP_READS_FAIL } from '../tip/scenarios/session-reads.js';
import { PrintTest, printProps } from '../tip/scenarios/print.js';
import { SyncTest, SYNC_LIMIT_MS, createSyncWatcher } from '../tip/scenarios/sync.js';
import { StockCheckpointTest, checkpointProps } from '../tip/scenarios/stock-checkpoint.js';
import { NumberChecksTest, numberChecksProps, claimToday } from '../tip/scenarios/number-checks.js';
import { MainThreadTest, createWatchdog, FREEZE_MS, WINDOW_MS, SLEEP_MS, TICK_MS, MAX_SAMPLES } from '../tip/scenarios/main-thread.js';
import { SCENARIOS } from '../tip/index.js';

const T0 = new Date(2026, 9, 23, 11, 0, 0).getTime();

function harness({ online = true } = {}) {
    let now = T0;
    const net = { online };
    const tip = createTip({ now: () => now, isOnline: () => net.online, appVersion: '1.6.0' });
    [AppStartTest, BillSaveTest, PaymentRecordTest, CashCloseTest, SessionReadsTest,
        PrintTest, SyncTest, StockCheckpointTest, NumberChecksTest, MainThreadTest].forEach(d => tip.declareTest(d));
    const outcome = (test) => {
        const c = tip.takeDelta()[dayKeyOf(now)]['1_6_0'][test];
        return { result: Object.keys(c.n)[0], reason: c.r ? Number(Object.keys(c.r)[0].replace(/^[a-z]+/, '')) : 0 };
    };
    return { tip, outcome, net, advance: (ms) => { now += ms; }, now: () => now };
}

describe('AppStart', () => {
    it('succeeds when the app shows quickly', () => {
        const h = harness();
        const run = h.tip.start('AppStart');
        h.advance(2000);
        run.complete();
        expect(h.outcome('AppStart')).toEqual({ result: 's', reason: 0 });
    });

    it('fails slow_start above the limit and load_failed when data did not load (online)', () => {
        const h = harness();
        const slow = h.tip.start('AppStart');
        h.advance(APP_START_FAIL_MS + 1);
        slow.complete();
        expect(h.outcome('AppStart')).toEqual({ result: 'f', reason: AppStartTest.reasons.slow_start });
        h.tip.start('AppStart').complete({ loadFailed: true });
        expect(h.outcome('AppStart')).toEqual({ result: 'f', reason: AppStartTest.reasons.load_failed });
    });

    it('is discarded when no app screen is expected (pending / outdated)', () => {
        const h = harness();
        const run = h.tip.start('AppStart');
        run.setFlag('blocked');
        run.complete();
        expect(h.outcome('AppStart').result).toBe('x');
    });
});

describe('BillSave', () => {
    const bill = (extra = {}) => ({
        items: [{ total: 1000 }, { total: 500 }], grandTotal: 1500,
        payment: { cash: 1000, online: 0, due: 500 }, customerName: 'Ramesh', ...extra
    });

    it('props carry no party name; happy path succeeds', () => {
        const props = billSaveProps('retailSales', bill(), T0);
        expect(props).toEqual({ kind: 'retailSales', lines: 2, total100: 1500, totalsOk: true, overridden: false });
        const h = harness();
        h.tip.start('BillSave', { props }).complete();
        expect(h.outcome('BillSave')).toEqual({ result: 's', reason: 0 });
    });

    it('totals_mismatch when cash + online + due ≠ total', () => {
        const h = harness();
        h.tip.start('BillSave', { props: billSaveProps('purchases', bill({ payment: { cash: 1000, online: 0, due: 0 } }), T0) }).complete();
        expect(h.outcome('BillSave')).toEqual({ result: 'f', reason: BillSaveTest.reasons.totals_mismatch });
    });

    it('write_rejected when the server refuses the write', () => {
        const h = harness();
        h.tip.start('BillSave', { props: billSaveProps('purchases', bill(), T0) }).completeAndFail('write_rejected', { code: 'permission-denied' });
        expect(h.outcome('BillSave')).toEqual({ result: 'f', reason: BillSaveTest.reasons.write_rejected });
    });

    it('blocked_valid_bill (warn) when the owner overrode a block for this bill', () => {
        const h = harness();
        const props = billSaveProps('wholesaleSales', bill({ overrides: [{ rule: 'oversell', at: T0 - 1000 }] }), T0);
        expect(props.overridden).toBe(true);
        expect(billSaveProps('wholesaleSales', bill({ overrides: [{ rule: 'oversell', at: T0 - 86400000 }] }), T0).overridden).toBe(false);
        h.tip.start('BillSave', { props }).complete();
        expect(h.outcome('BillSave')).toEqual({ result: 'w', reason: BillSaveTest.reasons.blocked_valid_bill });
    });

    it('app closed with the save queued offline → abandoned run is discarded, online → abandoned (fail)', () => {
        const data = {};
        const store = { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
        const first = createTip({ now: () => T0, store, tabId: 'old' });
        first.declareTest(BillSaveTest);
        first.start('BillSave', { flags: { offline: true } });
        first.start('BillSave', { flags: { offline: false } });
        first.endTab();
        const next = createTip({ now: () => T0 + 1000, store, tabId: 'new', appVersion: '1.6.0' });
        next.declareTest(BillSaveTest);
        expect(next.recoverAbandoned()).toBe(2);
        const c = next.takeDelta()[dayKeyOf(T0)].unknown.BillSave;
        expect(c.n).toEqual({ x: 1, a: 1 });
    });

    it('auto-rollback overrides do not count as "blocked valid bill"', () => {
        expect(billSaveProps('wholesaleSales', bill({ overrides: [{ rule: 'oversell', reason: AUTO_ROLLBACK_REASON, at: T0 }] }), T0).overridden).toBe(false);
    });

    it('not acknowledged online → fail; offline save → discarded', () => {
        const online = harness();
        online.tip.start('BillSave', { props: billSaveProps('purchases', bill(), T0) });
        online.advance(BillSaveTest.timeoutMs + 1);
        online.tip.sweep();
        expect(online.outcome('BillSave')).toEqual({ result: 'f', reason: BillSaveTest.reasons.not_acknowledged });
        const offline = harness({ online: false });
        offline.tip.start('BillSave', { flags: { offline: true }, props: billSaveProps('purchases', bill(), T0) });
        offline.advance(BillSaveTest.timeoutMs + 1);
        offline.tip.sweep();
        expect(offline.outcome('BillSave').result).toBe('x');
    });
});

describe('PaymentRecord', () => {
    const fresh = { grandTotal: 1000, payment: { cash: 0, online: 0, due: 1000 } };
    const written = { payment: { cash: 400, online: 0, due: 600, total: 400 } };

    it('succeeds when the bill adds up and the open drawer got the leg', () => {
        const h = harness();
        h.tip.start('PaymentRecord').complete(paymentRecordProps(fresh, written, { sessionOpen: true, legWritten: true }));
        expect(h.outcome('PaymentRecord')).toEqual({ result: 's', reason: 0 });
    });

    it('cash_leg_missing when the session was open but no leg was written (#201)', () => {
        const h = harness();
        h.tip.start('PaymentRecord').complete(paymentRecordProps(fresh, written, { sessionOpen: true, legWritten: false }));
        expect(h.outcome('PaymentRecord')).toEqual({ result: 'f', reason: PaymentRecordTest.reasons.cash_leg_missing });
    });

    it('totals_mismatch, bill_missing, and a retried payment is ignored', () => {
        const h = harness();
        h.tip.start('PaymentRecord').complete(paymentRecordProps(fresh, { payment: { cash: 400, online: 0, due: 900 } }, {}));
        expect(h.outcome('PaymentRecord')).toEqual({ result: 'f', reason: PaymentRecordTest.reasons.totals_mismatch });
        h.tip.start('PaymentRecord').complete(paymentRecordProps(null, null, {}));
        expect(h.outcome('PaymentRecord')).toEqual({ result: 'f', reason: PaymentRecordTest.reasons.bill_missing });
        h.tip.start('PaymentRecord').complete(paymentRecordProps(fresh, written, { retried: true }));
        expect(h.outcome('PaymentRecord').result).toBe('i');
    });

    it('errors: offline / over-due are not app failures', () => {
        expect(paymentErrorOutcome({ code: 'unavailable' }, false)).toBe('discard');
        expect(paymentErrorOutcome({}, true)).toBe('discard');
        expect(paymentErrorOutcome({ code: 'exceeds-due' }, false)).toBe('ignore');
        expect(paymentErrorOutcome({ code: 'permission-denied' }, false)).toBe('fail');
    });
});

describe('CashClose', () => {
    const session = { id: 's1', duePayments: [{}, {}] };

    it('succeeds for a normal close and warns on a large difference', () => {
        const h = harness();
        h.tip.start('CashClose', { props: cashCloseProps({ session, expected: 5000, counted: 4990, difference: -10 }) }).complete();
        expect(h.outcome('CashClose')).toEqual({ result: 's', reason: 0 });
        h.tip.start('CashClose', { props: cashCloseProps({ session, expected: 5000, counted: 2000, difference: -3000 }) }).complete();
        expect(h.outcome('CashClose')).toEqual({ result: 'w', reason: CashCloseTest.reasons.large_difference });
    });

    it('fails on a negative or non-number expected cash and a wrong difference', () => {
        const h = harness();
        h.tip.start('CashClose', { props: cashCloseProps({ session, expected: -50, counted: 0, difference: 50 }) }).complete();
        expect(h.outcome('CashClose')).toEqual({ result: 'f', reason: CashCloseTest.reasons.negative_expected });
        h.tip.start('CashClose', { props: cashCloseProps({ session, expected: NaN, counted: 0, difference: 0 }) }).complete();
        expect(h.outcome('CashClose')).toEqual({ result: 'f', reason: CashCloseTest.reasons.expected_not_number });
        h.tip.start('CashClose', { props: cashCloseProps({ session, expected: 100, counted: 100, difference: 5 }) }).complete();
        expect(h.outcome('CashClose')).toEqual({ result: 'f', reason: CashCloseTest.reasons.difference_mismatch });
        h.tip.start('CashClose', { props: cashCloseProps({ session: null }) }).complete();
        expect(h.outcome('CashClose')).toEqual({ result: 'f', reason: CashCloseTest.reasons.no_session });
    });

    it('write_failed when the save errors', () => {
        const h = harness();
        h.tip.start('CashClose', { props: cashCloseProps({ session, expected: 1, counted: 1, difference: 0 }) }).completeAndFail('write_failed');
        expect(h.outcome('CashClose')).toEqual({ result: 'f', reason: CashCloseTest.reasons.write_failed });
    });
});

describe('SessionReads (#159)', () => {
    const record = (props) => {
        const h = harness();
        h.tip.start('SessionReads').complete(props);
        return h.outcome('SessionReads');
    };
    const { reasons } = SessionReadsTest;

    it('passes a normal start, warns on a heavy one, fails a very heavy one', () => {
        expect(record({ startupReads: 450 })).toEqual({ result: 's', reason: 0 });
        expect(record({ startupReads: STARTUP_READS_WARN + 1 })).toEqual({ result: 'w', reason: reasons.heavy_startup });
        expect(record({ startupReads: STARTUP_READS_FAIL + 1 })).toEqual({ result: 'f', reason: reasons.heavy_startup });
    });

    it('read meter alerts are failures', () => {
        expect(record({ heavy: true, reads: 3001 })).toEqual({ result: 'f', reason: reasons.heavy_session });
        expect(record({ quota: true, reads: 10 })).toEqual({ result: 'f', reason: reasons.quota_exhausted });
    });
});

describe('Print (#161)', () => {
    const record = (outcome, error) => {
        const h = harness();
        h.tip.start('Print').complete(printProps(outcome, error));
        return h.outcome('Print');
    };
    const { reasons } = PrintTest;

    it('passes a printed job; a cancelled one is not judged', () => {
        expect(record('printed')).toEqual({ result: 's', reason: 0 });
        expect(record('cancelled')).toEqual({ result: 'i', reason: 0 });
    });

    it('a send that fails on a connected printer fails; connect / set-up problems and may-have-printed warn', () => {
        expect(record('failed', { kind: 'timeout_connect' })).toEqual({ result: 'w', reason: reasons.connect_failed });
        expect(record('failed', { kind: 'dropped' })).toEqual({ result: 'f', reason: reasons.send_failed });
        expect(record('failed', new Error('plugin said no'))).toEqual({ result: 'f', reason: reasons.send_failed });
        expect(record('failed', { kind: 'bluetooth_off' })).toEqual({ result: 'w', reason: reasons.printer_not_ready });
        expect(record('uncertain', { kind: 'timeout_write' })).toEqual({ result: 'w', reason: reasons.may_have_printed });
    });
});

describe('Sync (#161)', () => {
    it('passes when the waiting changes reach the server', () => {
        const h = harness();
        const w = createSyncWatcher((o) => h.tip.start('Sync', o));
        w.update({ online: true, pending: 1 });
        w.update({ online: true, pending: 3 });
        h.advance(20000);
        w.update({ online: true, pending: 0 });
        expect(h.outcome('Sync')).toEqual({ result: 's', reason: 0 });
    });

    it('fails when changes still wait online after the limit; offline is not judged', () => {
        const h = harness();
        const w = createSyncWatcher((o) => h.tip.start('Sync', o));
        w.update({ online: true, pending: 2 });
        h.advance(SYNC_LIMIT_MS + 1);
        h.tip.sweep();
        expect(h.outcome('Sync')).toEqual({ result: 'f', reason: SyncTest.reasons.not_flushed });

        const h2 = harness();
        const w2 = createSyncWatcher((o) => h2.tip.start('Sync', o));
        w2.update({ online: true, pending: 1 });
        w2.update({ online: false, pending: 1 });
        h2.advance(60000);
        w2.update({ online: true, pending: 0 });
        expect(h2.outcome('Sync')).toEqual({ result: 'x', reason: 0 });
    });

    it('a run that went to the background is not judged', () => {
        const h = harness();
        const w = createSyncWatcher((o) => h.tip.start('Sync', o));
        w.update({ online: true, pending: 1 });
        w.hidden();
        h.advance(SYNC_LIMIT_MS + 1);
        h.tip.sweep();
        expect(h.outcome('Sync')).toEqual({ result: 'x', reason: 0 });
    });

    it('sign-out discards an open run', () => {
        const h = harness();
        const w = createSyncWatcher((o) => h.tip.start('Sync', o));
        w.update({ online: true, pending: 1 });
        w.update({ online: true, pending: 0, stopped: true });
        expect(h.outcome('Sync')).toEqual({ result: 'x', reason: 0 });
        expect(h.tip.activeCount()).toBe(0);
    });
});

describe('StockCheckpoint (#161)', () => {
    const record = (result, released = null, online = true) => {
        const h = harness({ online });
        h.tip.start('StockCheckpoint').complete(checkpointProps(result, released));
        return h.outcome('StockCheckpoint');
    };
    const { reasons } = StockCheckpointTest;

    it('passes a build; another phone building or a fresh checkpoint is not judged', () => {
        expect(record({ status: 'built' })).toEqual({ result: 's', reason: 0 });
        expect(record({ status: 'leased' })).toEqual({ result: 'i', reason: 0 });
        expect(record({ status: 'fresh' })).toEqual({ result: 'i', reason: 0 });
    });

    it('a failed build must release its lease', () => {
        expect(record({ status: 'too-large' }, true)).toEqual({ result: 'f', reason: reasons.too_large });
        expect(record({ status: 'offline' }, true)).toEqual({ result: 'x', reason: 0 });
        expect(record({ status: 'offline' }, false)).toEqual({ result: 'x', reason: 0 });
        expect(record({ status: 'too-large' }, false)).toEqual({ result: 'f', reason: reasons.lease_not_released });
        expect(record({ status: 'too-large' }, false, false)).toEqual({ result: 'x', reason: 0 });
        expect(record({ status: 'conflict' }, true)).toEqual({ result: 'w', reason: reasons.conflict });
        expect(record(null)).toEqual({ result: 'f', reason: reasons.rebuild_error });
        expect(record(null, null, false)).toEqual({ result: 'x', reason: 0 });
    });

    it('a run that expires before the rebuild answers is not judged', () => {
        const h = harness();
        h.tip.start('StockCheckpoint');
        h.advance(StockCheckpointTest.timeoutMs + 1);
        h.tip.sweep();
        expect(h.outcome('StockCheckpoint')).toEqual({ result: 'x', reason: 0 });
    });
});

describe('NumberChecks (#161)', () => {
    const record = (results) => {
        const h = harness();
        h.tip.start('NumberChecks').complete(numberChecksProps(results));
        return h.outcome('NumberChecks');
    };

    it('passes when every check passes, fails with the first failed check, no amounts', () => {
        expect(record([{ id: 'AC1', status: 'skip' }, { id: 'AC2', status: 'pass' }])).toEqual({ result: 's', reason: 0 });
        expect(record([{ id: 'AC2', status: 'pass' }, { id: 'AC4', status: 'fail', rows: [{ expected: 500 }] }, { id: 'AC5', status: 'fail' }]))
            .toEqual({ result: 'f', reason: NumberChecksTest.reasons.ac4 });
        expect(numberChecksProps([{ id: 'AC4', status: 'fail', rows: [{ expected: 500 }] }])).toEqual({ checked: 1, failed: 1, first: 'AC4', failedIds: 'AC4' });
        expect(record([{ id: 'AC1', status: 'skip' }])).toEqual({ result: 'i', reason: 0 });
    });

    it('runs at most once a day per phone', () => {
        const store = { v: null, getItem() { return this.v; }, setItem(_, v) { this.v = v; } };
        expect(claimToday(store, '20261101')).toBe(true);
        expect(claimToday(store, '20261101')).toBe(false);
        expect(claimToday(store, '20261102')).toBe(true);
    });
});

describe('MainThread watchdog (#83)', () => {
    /** Ticks every TICK_MS for `ms` (the page on screen). */
    const run = (h, w, ms) => {
        for (let t = 0; t < ms; t += TICK_MS) {
            h.advance(TICK_MS);
            w.tick(h.now());
        }
    };
    const counts = (h) => (h.tip.takeDelta()[dayKeyOf(h.now())] || {})['1_6_0']?.MainThread || { n: {}, r: {} };
    const setup = () => {
        const h = harness();
        return { h, w: createWatchdog(() => h.tip.start('MainThread')) };
    };

    it('a window on screen with no freeze passes; a 5-second block fails as frozen', () => {
        const { h, w } = setup();
        w.tick(h.now());
        run(h, w, WINDOW_MS);
        h.advance(FREEZE_MS + 200);
        w.tick(h.now());
        const c = counts(h);
        expect(c.n).toEqual({ s: 1, f: 1 });
        expect(Object.keys(c.r)).toEqual([`f${MainThreadTest.reasons.frozen}`]);
    });

    it('time away is never a gap: a stretch on screen is judged when it lasted a minute, else not', () => {
        const { h, w } = setup();
        w.tick(h.now());
        run(h, w, 90000);
        w.hidden(h.now());
        h.advance(30000);
        w.tick(h.now());
        run(h, w, 10000);
        w.hidden(h.now());
        expect(counts(h).n).toEqual({ s: 1, x: 1 });
        expect(h.tip.activeCount()).toBe(0);
    });

    it('a screen frozen until the user leaves the app still fails', () => {
        const { h, w } = setup();
        w.tick(h.now());
        run(h, w, 10000);
        h.advance(FREEZE_MS + 500);
        w.hidden(h.now());
        expect(counts(h).n).toEqual({ f: 1 });
    });

    it('a short block or the phone asleep is not a freeze', () => {
        const { h, w } = setup();
        w.tick(h.now());
        h.advance(FREEZE_MS - TICK_MS);
        w.tick(h.now());
        h.advance(SLEEP_MS + 1);
        w.tick(h.now());
        w.hidden(h.now());
        const { n } = counts(h);
        expect(n.f).toBeUndefined();
        expect(n.s).toBeUndefined();
        expect(MainThreadTest.evaluate({ checked: true, longestMs: 900 }, {}, { expired: true })).toBe('discard');
    });

    it('keeps at most MAX_SAMPLES failure samples a day, leaving the shared budget to the other tests', () => {
        const { h, w } = setup();
        w.tick(h.now());
        for (let i = 0; i < MAX_SAMPLES + 3; i++) {
            h.advance(FREEZE_MS + 100);
            w.tick(h.now());
        }
        h.tip.start('BillSave').complete({ saveFailed: true });
        const samples = h.tip.takeFailures();
        expect(samples.filter(s => s.test === 'MainThread').length).toBe(MAX_SAMPLES);
        expect(counts(h).n.f).toBe(MAX_SAMPLES + 3);
    });
});
describe('every scenario is declared and has a Health label', () => {
    it('lists the 10 tests', () => {
        expect(SCENARIOS.map(s => s.id)).toEqual(['AppStart', 'BillSave', 'PaymentRecord', 'CashClose', 'SessionReads',
            'Print', 'Sync', 'StockCheckpoint', 'NumberChecks', 'MainThread']);
    });
});