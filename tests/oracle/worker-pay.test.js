/**
 * Worker pay oracle (#373, docs/calculations.md WP-1 … WP-10): an independent recomputation from
 * running totals (Σ pay − Σ paid up to a month, no month-to-month carry), compared with
 * utils/worker-pay.js on generated workers; plus the worked examples of advance recovery.
 */
import fc from 'fast-check';
import {
    payFor, workerLedger, paySummary, withPay, withStart, monthState, checkEntry, wholeRupees, payDue, payDueMonths
} from '../../www/js/utils/worker-pay.js';

const MONTHS = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
const NOW = '2026-06';

// Oracle: plain loops over the month list.
function oraclePay(w, m) {
    if (m < w.startMonth) return 0;
    let pay = 0;
    let at = '';
    for (const p of w.pays) if (p.from <= m && p.from >= at) { pay = p.amount; at = p.from; }
    return pay;
}
const oraclePaid = (w, m) => w.entries.filter(e => e.month === m).reduce((s, e) => s + e.amount, 0);
function oracleBalance(w, upto) {
    let owed = 0;
    for (const m of MONTHS) if (m <= upto) owed += oraclePay(w, m) - oraclePaid(w, m);
    return owed;
}
function oracleMonth(w, m) {
    const before = MONTHS.indexOf(m) ? oracleBalance(w, MONTHS[MONTHS.indexOf(m) - 1]) : 0;
    const pay = oraclePay(w, m);
    const paid = oraclePaid(w, m);
    const arrears = before > 0 ? before : 0;
    const credit = before < 0 ? -before : 0;
    const recovered = Math.min(pay, credit);
    // State in the words of WP-6, not from the balance: Y = pay + arrears, X = paid + advance used.
    const y = pay + arrears;
    const x = paid + recovered;
    const state = y === 0 ? null : x >= y ? 'paid' : x === 0 ? 'due' : 'part';
    return { pay, paid, opening: before, recovered, closing: oracleBalance(w, m), state, owed: y, covered: y === 0 ? 0 : Math.min(x, y) };
}

const month = fc.constantFrom(...MONTHS);
const workerArb = fc.record({
    startMonth: month,
    steps: fc.array(fc.record({ from: month, amount: fc.integer({ min: 0, max: 20000 }) }), { maxLength: 3 }),
    first: fc.integer({ min: 1000, max: 20000 }),
    entries: fc.array(fc.record({
        month, day: fc.integer({ min: 1, max: 28 }), amount: fc.integer({ min: 1, max: 15000 }),
        kind: fc.constantFrom('pay', 'advance'), dateMonth: month
    }), { maxLength: 10 })
}).map(({ startMonth, steps, first, entries }) => {
    const later = steps.filter(s => s.from > startMonth);
    const pays = [{ from: startMonth, amount: first }, ...later.filter((s, i) => later.findIndex(x => x.from === s.from) === i)];
    return {
        name: 'W', startMonth, active: true, pays,
        entries: entries.map((e, i) => ({ id: `e${i}`, month: e.month, date: `${e.dateMonth}-${String(e.day).padStart(2, '0')}`, amount: e.amount, kind: e.kind, mode: 'cash' }))
    };
});

describe('WP-1 … WP-6: each worker, month by month', () => {
    test('pay, paid, carried in, advance recovered, balance and state agree with running totals', () => {
        fc.assert(fc.property(workerArb, (w) => {
            const { months, balance } = workerLedger(w, NOW);
            for (const r of months) {
                if (!MONTHS.includes(r.month)) continue;
                expect(payFor(w, r.month)).toBe(oraclePay(w, r.month));
                const o = oracleMonth(w, r.month);
                expect({ pay: r.pay, paid: r.paid, opening: r.opening, recovered: r.recovered, closing: r.closing, state: r.state, owed: r.owed, covered: r.covered })
                    .toEqual(o);
            }
            expect(balance).toBe(oracleBalance(w, NOW));
        }), { numRuns: 200 });
    });
});

describe('WP-7 … WP-10: the page cards', () => {
    test('pay this month, paid out (by date), still to pay and advances carried', () => {
        fc.assert(fc.property(fc.array(workerArb, { maxLength: 5 }), month, (list, m) => {
            const s = paySummary(list, m);
            const balances = list.map(w => oracleBalance(w, m));
            expect(s.pay).toBe(list.reduce((t, w) => t + oraclePay(w, m), 0));
            expect(s.paidOut).toBe(list.reduce((t, w) => t + w.entries.filter(e => e.date.startsWith(m)).reduce((x, e) => x + e.amount, 0), 0));
            expect(s.toPay).toBe(balances.filter(b => b > 0).reduce((t, b) => t + b, 0));
            expect(s.advances).toBe(balances.filter(b => b < 0).reduce((t, b) => t - b, 0));
            const states = list.map(w => oracleMonth(w, m).state);
            expect(s.counts).toEqual({ paid: states.filter(x => x === 'paid').length, part: states.filter(x => x === 'part').length, due: states.filter(x => x === 'due').length });
        }), { numRuns: 200 });
    });
});

describe('WP-11: salaries due on Today', () => {
    test('workers still owed at the end of the month and what they are owed, this month and the next ones', () => {
        fc.assert(fc.property(fc.array(workerArb, { maxLength: 5 }), month, (list, m) => {
            const owed = list.map(w => oracleBalance(w, m)).filter(b => b > 0);
            expect(payDue(list, m)).toEqual({ count: owed.length, due: owed.reduce((t, b) => t + b, 0) });
            expect(payDue(list, m).due).toBe(paySummary(list, m).toPay);
            const months = payDueMonths(list, m, 3);
            expect(Object.keys(months)).toHaveLength(3);
            for (const [k, v] of Object.entries(months)) expect(v).toEqual(payDue(list, k));
        }), { numRuns: 200 });
    });

    test('due from the 1st of the month: an unpaid month counts at once; an advance ahead does not', () => {
        const pays = [{ from: '2026-01', amount: 9000 }];
        const ramu = { name: 'Ramu', startMonth: '2026-01', active: true, pays, entries: [] };
        const ahead = { ...ramu, entries: [{ id: 'a', month: '2026-01', date: '2026-01-05', amount: 12000, kind: 'advance', mode: 'cash' }] };
        expect(payDue([ramu, ahead], '2026-01')).toEqual({ count: 1, due: 9000 });
        expect(payDue([ramu, ahead], '2026-02')).toEqual({ count: 2, due: 18000 + 6000 });
        expect(payDue([], '2026-01')).toEqual({ count: 0, due: 0 });
    });
});

describe('worked examples', () => {
    const w = (entries, pays = [{ from: '2026-01', amount: 9000 }]) => ({ name: 'Ramu', startMonth: '2026-01', active: true, pays, entries });
    const e = (month, amount, date = `${month}-15`, kind = 'pay') => ({ id: `${month}${amount}`, month, date, amount, kind, mode: 'cash' });
    const row = (worker, m) => workerLedger(worker, m).months.find(r => r.month === m);

    test('a mid-month advance counts towards that month: part-paid, then paid', () => {
        expect(row(w([e('2026-01', 3000, '2026-01-12', 'advance')]), '2026-01')).toMatchObject({ state: 'part', covered: 3000, owed: 9000, closing: 6000 });
        expect(row(w([e('2026-01', 3000, '2026-01-12', 'advance'), e('2026-01', 6000, '2026-02-01')]), '2026-01')).toMatchObject({ state: 'paid', closing: 0 });
    });

    test('carry-forward: an unpaid month is owed in the next one (₹Y due = 2 months)', () => {
        expect(row(w([]), '2026-02')).toMatchObject({ opening: 9000, owed: 18000, state: 'due', closing: 18000 });
        expect(row(w([e('2026-02', 9000)]), '2026-02')).toMatchObject({ state: 'part', covered: 9000, owed: 18000, closing: 9000 });
    });

    test('advance recovery: an advance bigger than the pay pays the next month first', () => {
        const big = w([e('2026-01', 15000, '2026-01-05', 'advance')]);
        expect(row(big, '2026-01')).toMatchObject({ state: 'paid', closing: -6000 });
        expect(row(big, '2026-02')).toMatchObject({ opening: -6000, recovered: 6000, state: 'part', covered: 6000, owed: 9000, closing: 3000 });
        expect(paySummary([big], '2026-01')).toMatchObject({ toPay: 0, advances: 6000, paidOut: 15000, pay: 9000 });
        expect(paySummary([big], '2026-02')).toMatchObject({ toPay: 3000, advances: 0, paidOut: 0 });
    });

    test('paid out this month (WP-8) counts the date, not the month it pays', () => {
        const late = w([e('2026-01', 9000, '2026-02-02')]);
        expect(paySummary([late], '2026-01').paidOut).toBe(0);
        expect(paySummary([late], '2026-02').paidOut).toBe(9000);
    });

    test('a raise counts from its month; leaving stops the pay; what is owed stays', () => {
        const pays = withPay([{ from: '2026-01', amount: 9000 }], '2026-01', '2026-03', 10000);
        expect(['2026-02', '2026-03'].map(m => payFor({ startMonth: '2026-01', pays }, m))).toEqual([9000, 10000]);
        const left = withPay(pays, '2026-01', '2026-04', 0);
        const worker = w([e('2026-01', 9000), e('2026-02', 9000)], left);
        expect(payFor(worker, '2026-05')).toBe(0);
        expect(workerLedger(worker, '2026-06').balance).toBe(10000);
        expect(row(worker, '2026-06')).toMatchObject({ state: 'due', owed: 10000 });
        expect(withStart(pays, '2026-02')).toEqual([{ from: '2026-02', amount: 9000 }, { from: '2026-03', amount: 10000 }]);
        expect(withPay(pays, '2026-01', '2025-10', 8000)).toEqual([{ from: '2026-01', amount: 8000 }]);
    });

    test('no state when nothing is owed; entries for a later month wait', () => {
        expect(monthState(0, 0, 0).state).toBeNull();
        expect(monthState(0, -500, -500).state).toBeNull();
        expect(workerLedger(w([e('2026-03', 9000)]), '2026-02').balance).toBe(18000);
    });

    test('form checks: whole rupees, no future month or date', () => {
        expect(['500', ' 12 ', '0', '1.5', '-3', '', '10000001'].map(wholeRupees)).toEqual([500, 12, null, null, null, null, null]);
        const base = { amount: '500', month: '2026-06', date: '2026-06-01', kind: 'advance', mode: 'online' };
        expect(checkEntry(base, '2026-06').entry).toEqual({ month: '2026-06', date: '2026-06-01', amount: 500, kind: 'advance', mode: 'online' });
        expect(checkEntry({ ...base, month: '2026-07' }, '2026-06').error).toBe('msg.workers.bad_month');
        expect(checkEntry({ ...base, date: '2026-07-01' }, '2026-06').error).toBe('msg.workers.bad_date');
    });
});
