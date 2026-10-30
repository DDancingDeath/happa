/**
 * @fileoverview The phone path (tools/audit/phone.js) on an anonymised fixture:
 * a phone loads bills from the 1st of the previous month, older bills that still
 * owe, the stock checkpoint, month snapshots and cash sessions through the app's
 * own loaders (FirebaseService against an in-memory Firestore). Every Money,
 * Insights, Statements and Today figure it shows must equal the oracle on the
 * full data, or be shown as unknown / approximate.
 *
 * Fixture: tests/fixtures/calculations/phone-path.json (made-up names and amounts).
 * A class of mismatch the app still has is listed in BUGS with its issue; its
 * test is skipped until the fix (ORACLE_RUN_SKIPPED=1 runs it).
 */
import fs from 'fs';
import path from 'path';
import * as O from './oracle.js';
import { Collector } from '../../tools/audit/audit-lib.js';
import { auditPhone, billAt, dataAt, phoneDates } from '../../tools/audit/phone.js';

const FIX = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/calculations/phone-path.json'), 'utf8'));
const NOW = O.timeOf(FIX.now);
const ROOT = path.resolve(__dirname, '../..');

/** Mismatch classes the app has today: spec pattern → issue. */
const BUGS = {
    paidInsideWindow: '#163'
};
const bugTest = (k) => (BUGS[k] && !process.env.ORACLE_RUN_SKIPPED ? test.skip : test);

const data = () => JSON.parse(JSON.stringify({
    items: FIX.items, purchases: FIX.purchases, wholesaleSales: FIX.wholesaleSales, retailSales: FIX.retailSales,
    stockAdjustments: FIX.stockAdjustments, expenses: FIX.expenses, withdrawals: FIX.withdrawals, sessions: FIX.sessions
}));

let C;
beforeAll(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    C = new Collector();
    await auditPhone({ C, data: data(), dates: [{ label: 'fixture', ms: NOW }], appRoot: ROOT, stockEvidence: { firstDip: Infinity, cleanAgrees: true } });
}, 120000);

const PAID = /^(M5|M6|M10|M11|M12|M13|M14|CMP_M6|CMP_M14|ST1_due|SNAP_days_profit)/;
const WEEKLY = /^I9_/;
const of = (re) => C.mismatches.filter(m => re.test(m.spec)).map(m => `${m.spec} @ ${m.page} ${m.period}: oracle ${m.oracle}, app ${m.app}`);

describe('phone path (windowed history) on the fixture', () => {
    test('loads the window from the 1st of the previous month, with the stock checkpoint', () => {
        // The audit ran at least Money, Insights, Statements and Today on that state.
        const pages = new Set(Object.keys(C.checked).map(k => k.split('|')[2]));
        ['Money (phone)', 'Money screen (phone)', 'Statements day book (phone)', 'Today (phone)', 'Worth (phone)', 'Month snapshot (monthStats)']
            .forEach(p => expect(pages.has(p)).toBe(true));
    });

    test('every other figure equals the oracle or is shown as unknown', () => {
        expect(C.mismatches.filter(m => !PAID.test(m.spec) && !WEEKLY.test(m.spec)).map(m => `${m.spec} @ ${m.page} ${m.period}`)).toEqual([]);
    });

    test('months before the window are shown as "not loaded", never as numbers', () => {
        expect(C.unknowns.some(u => u.spec === 'ST2' && /not loaded/.test(u.reason))).toBe(true);
        expect(C.mismatches.filter(m => /not_loaded_hidden|unknown_hidden/.test(m.spec))).toEqual([]);
    });

    bugTest('paidInsideWindow')('a due paid / written off inside the window on an older bill counts (M5, M12–M14, ST1, snapshots)', () => {
        expect(of(PAID)).toEqual([]);
    });

    bugTest('weeklyKgApprox')('stock-up weekly kg from fewer than 8 loaded weeks is shown as approximate (I9)', () => {
        expect(of(WEEKLY)).toEqual([]);
        expect(C.unknowns.some(u => u.spec === 'I9_weeklyKg' && /approximate/.test(u.reason))).toBe(true);
    });
});

describe('the backup at a moment (simulation input)', () => {
    test('a later due payment is taken back off the bill; earlier ones stay', () => {
        const bill = FIX.retailSales.find(b => b.id === 'r-aug-paid');
        const before = billAt(bill, O.timeOf('2026-10-01T12:00'));
        expect(before.payments).toEqual([]);
        expect(before.payment).toMatchObject({ cash: 600, due: 3000 });
        expect(before.openDue).toBe(true);
        expect(O.paidAtSave(before)).toEqual(O.paidAtSave(bill));
        expect(billAt(bill, NOW)).toBe(bill);
    });

    test('nothing dated after the moment is in the data', () => {
        const at = O.timeOf('2026-09-01T00:00');
        const d = dataAt(data(), at);
        expect([...d.purchases, ...d.retailSales].every(b => b.timestamp <= at)).toBe(true);
        expect(d.expenses.map(e => e.id)).toEqual(['e1']);
    });

    test('the audited days: today, the 1st, 2nd and 15th, 31 Mar and 1 Jan', () => {
        const days = phoneDates(O.timeOf('2026-10-26T13:40')).map(d => new Date(d.ms).toISOString().slice(0, 10));
        expect(days).toEqual(['2026-01-01', '2026-03-31', '2026-10-01', '2026-10-02', '2026-10-15', '2026-10-26']);
    });
});
