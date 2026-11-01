/**
 * @fileoverview The phone path (tools/audit/phone.js) on synthetic data: a phone loads
 * bills from the 1st of the previous month, older bills that still owe or were paid
 * since, the stock checkpoint, month snapshots and cash sessions through the app's
 * own loaders (FirebaseService against an in-memory Firestore). Every Money,
 * Insights, Statements and Today figure it shows must equal the oracle on the full
 * data, or be shown as unknown / approximate, and say so on screen.
 *
 * Data: the hand-made records of tests/fixtures/calculations/phone-path.json (Jul–Oct
 * 2026: older bills settled inside the window, stock-up weekly kg) plus a seeded
 * history from Jul 2025 (tests/fixtures/calculations/phone-path-history.js: more than
 * 13 months, whole-month snapshots, cash sessions with due-payment legs, two sessions
 * on one day). Made-up names and amounts only. The phone is opened three ways on the
 * audited day: the owner with a checkpoint rebuilt that day, the owner with the
 * checkpoint built at the previous month end, and a member with that one.
 *
 * A class of mismatch the app still has is listed in BUGS with its fix PR; its test is
 * marked `test.failing`, so the suite goes red as soon as the fix lands: then remove
 * the BUGS entry.
 */
import fs from 'fs';
import path from 'path';
import * as O from './oracle.js';
import { Collector } from '../../tools/audit/audit-lib.js';
import { auditPhone, billAt, dataAt, phoneDates, PHONE_PASSES } from '../../tools/audit/phone.js';
import { phonePathHistory, IDS, STOPPED_CUSTOMER } from '../fixtures/calculations/phone-path-history.js';

const CORE = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/calculations/phone-path.json'), 'utf8'));
const HISTORY = phonePathHistory();
const NOW = O.timeOf(CORE.now);
/** Audited: the 2nd (two days after the month-end checkpoint) and the fixture's "now", the 15th. */
const SECOND = O.timeOf('2026-10-02T21:00');
const ROOT = path.resolve(__dirname, '../..');
const ACCOUNTS = [{ name: 'Test bank', balance: 25000, type: 'asset' }, { name: 'Test loan', balance: 4000, type: 'liability' }];
const KEYS = ['items', 'purchases', 'wholesaleSales', 'retailSales', 'stockAdjustments', 'expenses', 'withdrawals', 'sessions'];

/** Days on which the backup has more than one cash session. */
const MULTI_SESSION_DAYS = (() => {
    const n = new Map();
    [...CORE.sessions, ...HISTORY.sessions].forEach(x => n.set(x.date, (n.get(x.date) || 0) + 1));
    return new Set([...n].filter(([, c]) => c > 1).map(([d]) => d));
})();

/**
 * Mismatch classes the app has today: name → [row predicate, fix PR]. Their rows are left
 * out of "every other figure" and asserted in their own `test.failing` test.
 */
const BUGS = {};
/** A known bug's test fails today; `test.failing` turns red once the fix makes it pass. */
const bugTest = (k) => (BUGS[k] ? test.failing : test);
const isBug = (m) => Object.values(BUGS).some(([is]) => is(m));
const rowsOf = (k) => C.mismatches.filter(BUGS[k][0]).map(m => `${m.spec} @ ${m.page} ${m.period}: oracle ${m.oracle}, app ${m.app}`);

const core = () => JSON.parse(JSON.stringify(Object.fromEntries(KEYS.map(k => [k, CORE[k]]))));
const data = () => JSON.parse(JSON.stringify(Object.fromEntries(KEYS.map(k => [k, [...CORE[k], ...HISTORY[k]]]))));

/**
 * VOID (#75, #99): the phone's Firestore also holds a voided copy of every hand-made bill (no
 * later payments: a void is refused with them) and expense. The oracle never sees them (the audit
 * compares with O.withoutVoided), so every figure the phone shows must leave them out:
 * the window and dues listeners, the stock checkpoint, month snapshots and rate history.
 */
const VOID_KEYS = ['purchases', 'retailSales', 'wholesaleSales', 'expenses'];
const voidedCopy = (b) => {
    const v = JSON.parse(JSON.stringify(b));
    delete v.payments;
    delete v.paidAt;
    return { ...v, id: `${b.id}-void`, billNumber: `${b.billNumber || b.id}-V`, voided: true, voidedBy: 'audit-void',
        voidedByName: 'Test', voidReason: 'Entered twice', voidedAt: b.timestamp ?? O.timeOf(b.date), openDue: false };
};
const withVoided = () => {
    const d = data();
    VOID_KEYS.forEach(k => { d[k] = [...d[k], ...CORE[k].map(voidedCopy)]; });
    return d;
};

let C;
let R;
beforeAll(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    C = new Collector();
    R = await auditPhone({ C, data: withVoided(), dates: [{ label: '2nd', ms: SECOND }, { label: 'fixture', ms: NOW }], appRoot: ROOT,
        stockEvidence: { firstDip: Infinity, cleanAgrees: true }, accounts: ACCOUNTS });
}, 600000);

const PAID = /^(M5|M6|M10|M11|M12|M13|M14|CMP_M6|CMP_M14|ST1_due|SNAP_days_profit)/;
const WEEKLY = /^I9_/;
const of = (re) => C.mismatches.filter(m => re.test(m.spec) && !isBug(m)).map(m => `${m.spec} @ ${m.page} ${m.period}: oracle ${m.oracle}, app ${m.app}`);
/** Rows compared as numbers (checked minus shown as unknown) for a spec on a page. */
const compared = (spec, page) => (C.checked[`phone|${spec}|${page}`] || 0) - C.unknowns.filter(u => u.spec === spec && u.page === page).length;
const pass = (tag, date = '2026-10-15') => R.dates.find(d => d.pass === tag && d.date === date);
const MONTH_END = 'owner, month-end checkpoint';
const MEMBER = 'member, month-end checkpoint';

describe('phone path (windowed history) on the fixture', () => {
    test('opens the phone three ways: owner (checkpoint rebuilt today), owner and member with the month-end checkpoint', () => {
        const ways = PHONE_PASSES.map(p => [p.role, p.tag || 'owner', null]);
        expect(R.dates.map(d => [d.role, d.pass, d.skipped || null])).toEqual([...ways, ...ways]);
        ['2026-10-02', '2026-10-15'].forEach(day => {
            expect(pass('owner', day)).toMatchObject({ checkpointAsOf: '2026-09-01', loadedFrom: '2026-09-01' });
            // Built on 30 Sep 23:00 (window from 1 Aug): the member keeps it and loads from its start.
            expect(pass(MEMBER, day)).toMatchObject({ checkpointAsOf: '2026-08-01', loadedFrom: '2026-08-01', rebuilt: 'kept' });
        });
        // The owner rolls it forward two days later (the window stays from 1 Aug), and rebuilds it once it is a week old.
        expect(pass(MONTH_END, '2026-10-02')).toMatchObject({ checkpointAsOf: '2026-09-01', loadedFrom: '2026-08-01' });
        expect(pass(MONTH_END, '2026-10-15')).toMatchObject({ checkpointAsOf: '2026-09-01' });
        R.dates.forEach(d => expect(d.counts.checked).toBeGreaterThan(500));
    });

    test('every page is audited', () => {
        const pages = new Set(Object.keys(C.checked).map(k => k.split('|')[2]));
        ['Money (phone)', 'Money screen (phone)', 'Statements day book (phone)', 'Today (phone)', 'Worth (phone)', 'Worth screen (phone)',
            'Month snapshot (monthStats)', 'Insights items (phone)', 'Insights to-do (phone)', 'Insights parties (phone)']
            .forEach(p => expect(pages.has(p)).toBe(true));
    });

    test('every other figure equals the oracle or is shown as unknown', () => {
        expect(C.mismatches.filter(m => !isBug(m)).map(m => `${m.spec} @ ${m.page} ${m.period}: oracle ${m.oracle}, app ${m.app}`)).toEqual([]);
    });

    test('the phone held voided bills (#75): none reached its bill lists, all are listed for History', () => {
        const copies = VOID_KEYS.reduce((a, k) => a + CORE[k].length, 0);
        expect(copies).toBeGreaterThan(5);
        expect(withVoided().retailSales.filter(b => b.voided).length).toBe(CORE.retailSales.length);
        R.dates.forEach(d => expect(d.voided).toEqual({ inAppState: 0, listed: expect.any(Number) }));
        expect(R.dates.some(d => d.voided.listed > 0)).toBe(true);
    });

    test('months before the window are shown as "not loaded", never as numbers', () => {
        expect(C.unknowns.some(u => u.spec === 'ST2' && /not loaded/.test(u.reason))).toBe(true);
        expect(C.mismatches.filter(m => /not_loaded_hidden|unknown_hidden|none_hidden|old_hidden/.test(m.spec))).toEqual([]);
    });

    test('a due paid / written off inside the window on an older bill counts (M5, M12–M14, ST1, snapshots)', () => {
        expect(of(PAID)).toEqual([]);
    });

    test('stock-up weekly kg from fewer than 8 loaded weeks is shown as approximate (I9)', () => {
        expect(of(WEEKLY)).toEqual([]);
        expect(C.unknowns.some(u => u.spec === 'I9_weeklyKg' && /approximate/.test(u.reason))).toBe(true);
    });
});

describe('last year from whole-month snapshots (13+ months of history)', () => {
    test('Money vs last year is compared from snapshots, including the % shown', () => {
        ['M1_sales', 'M4_businessExpenses', 'M6_profit', 'M14_net', 'M16_purchases'].forEach(k => expect(compared(k, 'Money vs last year (phone, snapshots)')).toBeGreaterThan(0));
        expect(compared('CMP_M6_profit', 'Money vs last year (phone, snapshots)')).toBeGreaterThan(0);
    });

    test('item "vs last year", the M11 last-year line and stopped coming from snapshot customer lists are compared', () => {
        expect(compared('I1_vsLastYear', 'Insights items (phone)')).toBeGreaterThan(0);
        expect(compared('M11_lastYearLine', 'Money chart M11 (phone, snapshots)')).toBeGreaterThanOrEqual(3);
        expect(O.stoppedComing(data(), NOW, 60)).toEqual([STOPPED_CUSTOMER.toLowerCase()]);
        // Bills from 60 days back are needed: the owner with the month-end checkpoint on the 2nd has them (from 1 Aug) and
        // takes last Sep–Nov from the snapshots; a window from the 1st of last month can't tell, nor the member (no snapshots).
        expect(pass(MONTH_END, '2026-10-02').stopped).toEqual({ known: true, from: 'snapshots', found: 1 });
        expect(pass('owner', '2026-10-02').stopped.known).toBe(false);
        expect(pass(MEMBER, '2026-10-02').stopped.known).toBe(false);
        expect(of(/^I3_stoppedComing/)).toEqual([]);
    });
});

describe('cash sessions, due-payment legs and Today', () => {
    test('the loaders return every session of the period with its legs; each due payment is listed once in the day book', () => {
        expect(compared('SESS_loaded', 'Money (phone)')).toBeGreaterThan(0);
        expect(compared('SESS_legs', 'Money (phone)')).toBeGreaterThan(0);
        expect(compared('SESS_dayLoaded', 'Statements day book (phone)')).toBeGreaterThan(0);
        expect(compared('ST1_duePaymentRows', 'Statements day book (phone)')).toBeGreaterThan(0);
        expect(of(/^(SESS_|ST1_duePaymentRows|T_session)/)).toEqual([]);
        // 15 Oct: two sessions with legs; the in-window bill's payment is on the bill and a leg (counted once).
        const d = dataAt(data(), NOW);
        expect(d.sessions.filter(s => s.date === '2026-10-15').map(s => [s.id, s.duePayments.length])).toEqual([[IDS.canonical, 2], [IDS.legacy, 1]]);
        expect(O.duePaymentsIn({ purchase: d.purchases, retail: d.retailSales, wholesale: d.wholesaleSales }, d.sessions.filter(s => s.date === '2026-10-15'),
            O.dayRange(NOW))).toMatchObject({ receivedCount: 2, paidCount: 1, paidCash: 2900, paidOnline: 1500 });
    });

    test('Today uses the backup\'s session for the day as expected value, and the app loads that session', () => {
        R.dates.forEach(info => expect(info.todaySessions).toEqual({ backup: info.date === '2026-10-15' ? 2 : 1, loaded: 'first' }));
        expect(compared('T_sessionLoaded', 'Today (phone)')).toBe(6);
        expect(compared('T_sessionLegs', 'Today (phone)')).toBe(6);
    });

    test('a member with the month-end checkpoint has not loaded the old bills paid today: their legs carry them', () => {
        expect(pass('owner').paidTodayNotLoaded).toBe(0);
        expect(pass(MEMBER).paidTodayNotLoaded).toBe(2);
        // The old purchase paid at 16:00 is a leg of the day's open session: Today counts it (T8, T9, T11, T14).
        // Checked on every row, the known-bug rows included.
        expect(C.mismatches.filter(m => /^T(8|9|11|14)_/.test(m.spec)).map(m => `${m.spec} @ ${m.period}`)).toEqual([]);
    });

    // Fixed by PR #176 (day.js: Today counts the legs of every session of the day).
    test('Today counts the legs of every session of the day (T6–T14)', () => {
        expect([...MULTI_SESSION_DAYS]).toEqual(['2026-10-15']);
        expect(compared('T_sessionsAll', 'Today (phone)')).toBe(6);
        expect(of(/^T([6-9]|1[0-4])_/).filter(r => r.includes(' @ Today (phone) '))).toEqual([]);
    });
});

describe('figures the phone path used to skip', () => {
    test('M15 net worth and its drawer term (last counted cash, accounts) on Money › Worth', () => {
        expect(compared('M15_netWorth', 'Worth (phone)')).toBe(6);
        expect(compared('M15_netWorth', 'Worth screen (phone)')).toBe(6);
        expect(compared('C9_drawer', 'Worth (phone)')).toBe(6);
        const d = dataAt(data(), NOW);
        // The legacy session of 15 Oct is the last one counted (the day's own is still open).
        expect(O.lastCountedCash(d.sessions)).toEqual({ date: '2026-10-15', amount: 5600 });
    });

    test('M17 opening and closing stock value, on the summary and on screen', () => {
        expect(compared('M17_opening', 'Money (phone)')).toBeGreaterThan(0);
        expect(compared('M17_closing', 'Money screen (phone)')).toBeGreaterThan(0);
    });

    test('Insights I2 (retail / wholesale per item), I7 (low profit), I8 (below cost), I11 (purchases by item)', () => {
        ['I2_itemRetail', 'I2_itemWholesale', 'I11_amount', 'I11_labour', 'I11_kg'].forEach(s => expect(compared(s, 'Insights items (phone)')).toBeGreaterThan(0));
        ['I7_lowProfitItems', 'I8_belowCostTimes', 'I8_belowCostLost'].forEach(s => expect(compared(s, 'Insights to-do (phone)')).toBeGreaterThan(0));
        // The data has them: mustard sells at about cost this month, some lines below cost, labour on purchases.
        const oct = [new Date(2026, 9, 1).getTime(), NOW + 1];
        expect(O.lowProfitItems(data(), oct)).toContain('mustard');
        expect(Object.keys(O.belowCost(data(), oct)).length).toBeGreaterThan(0);
        expect(Object.values(O.purchaseItems(data(), oct)).some(r => r.labour > 0)).toBe(true);
    });
});

describe('what the screen says when a comparison can\'t be made', () => {
    test('"Nothing to compare with yet" when neither comparison can be made', () => {
        expect(C.unknowns.some(u => /^CMP_/.test(u.spec) && /Nothing to compare with yet/.test(u.reason))).toBe(true);
        expect(of(/^CMP_.*_none_hidden$/)).toEqual([]);
    });

    // Fixed by PR #174 (money.js compareHtml: "vs {label}: not known").
    test('"vs {label}: not known" next to the comparison that is shown (no snapshot / part month)', () => {
        expect(of(/^CMP_.*_not_known_hidden$/)).toEqual([]);
        expect(C.unknowns.some(u => /^CMP_/.test(u.spec) && /not known/.test(u.reason))).toBe(true);
    });
});

describe('the backup at a moment (simulation input)', () => {
    test('a later due payment is taken back off the bill; earlier ones stay', () => {
        const bill = CORE.retailSales.find(b => b.id === 'r-aug-paid');
        const before = billAt(bill, O.timeOf('2026-10-01T12:00'));
        expect(before.payments).toEqual([]);
        expect(before.payment).toMatchObject({ cash: 600, due: 3000 });
        expect(before.openDue).toBe(true);
        expect(O.paidAtSave(before)).toEqual(O.paidAtSave(bill));
        expect(billAt(bill, NOW)).toBe(bill);
    });

    test('paidAt follows the payments still on the bill', () => {
        const bill = { id: 'b', date: '2026-09-01', total: 100, payment: { cash: 100, online: 0, due: 0 }, paidAt: 30, openDue: false,
            payments: [{ id: 'p1', amount: 50, cash: 50, online: 0, at: 10 }, { id: 'p2', amount: 50, cash: 50, online: 0, at: 30 }] };
        expect(billAt(bill, 20)).toMatchObject({ paidAt: 10, openDue: true, payment: { cash: 50, due: 50 } });
        expect('paidAt' in billAt(bill, 5)).toBe(false);
    });

    test('nothing dated after the moment is in the data; a session signed out later is still open', () => {
        const at = O.timeOf('2026-09-01T00:00');
        const d = dataAt(core(), at);
        expect([...d.purchases, ...d.retailSales].every(b => b.timestamp <= at)).toBe(true);
        expect(d.expenses.map(e => e.id)).toEqual(['e1']);
        const morning = dataAt(data(), O.timeOf('2026-10-15T11:00'));
        const legacy = morning.sessions.find(s => s.id === IDS.legacy);
        expect(legacy).toMatchObject({ signedOut: false, closingBalance: null });
        expect(legacy.duePayments).toHaveLength(1);
        // Not opened yet at 11:00; legs (ISO `timestamp`) recorded later are left out.
        expect(morning.sessions.some(s => s.id === IDS.canonical)).toBe(false);
        expect(dataAt(data(), O.timeOf('2026-10-15T16:30')).sessions.find(s => s.id === IDS.canonical).duePayments).toHaveLength(1);
    });

    test('the seeded history: same seed, same data; more than 13 months', () => {
        expect(JSON.stringify(phonePathHistory())).toBe(JSON.stringify(HISTORY));
        const first = Math.min(...HISTORY.retailSales.map(b => b.timestamp));
        expect(new Date(first).toISOString().slice(0, 7)).toBe('2025-07');
        expect(new Set(HISTORY.retailSales.map(b => O.monthOf(b.timestamp))).size).toBeGreaterThan(13);
    });

    test('the audited days: today, the 1st, 2nd and 15th, 31 Mar and 1 Jan', () => {
        const days = phoneDates(O.timeOf('2026-10-26T13:40')).map(d => new Date(d.ms).toISOString().slice(0, 10));
        expect(days).toEqual(['2026-01-01', '2026-03-31', '2026-10-01', '2026-10-02', '2026-10-15', '2026-10-26']);
    });
});


