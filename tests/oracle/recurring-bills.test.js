/**
 * Recurring bills oracle (#437, docs/calculations.md RB-1 … RB-11): an independent recomputation from
 * running totals (Σ bills − Σ paid up to a period, no period-to-period carry), periods found by testing
 * every month, compared with utils/recurring-bills.js on generated bill items; plus worked examples.
 */
import fc from 'fast-check';
import {
    periodsUpTo, billLedger, itemView, billsSummary, billsDue, billsDueDays, checkEntry, checkItem, unusualBill, entryPeriods, dueDateOf
} from '../../www/js/utils/recurring-bills.js';

const MONTHS = [];
for (let y = 2025; y <= 2026; y++) for (let m = 1; m <= 12; m++) MONTHS.push(`${y}-${String(m).padStart(2, '0')}`);
const mIdx = (k) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5)) - 1;

// ---- Oracle: plain loops, written from the spec's words ----
function oPeriods(item, upto) {
    const out = [];
    for (let i = mIdx(item.startMonth); i <= mIdx(upto); i++) {
        const k = `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
        if ((i - mIdx(item.startMonth)) % item.cadence !== 0) continue;
        if (item.endMonth && k > item.endMonth) continue;
        out.push(k);
    }
    return out;
}
// The period an entry's month falls in: the newest period starting on or before it (before the start: the first).
function oSlot(item, month) {
    const all = oPeriods(item, month < item.startMonth ? item.startMonth : month);
    return all.length ? all[all.length - 1] : item.startMonth;
}
function oBill(item, p) {
    const bills = item.entries.filter(e => e.kind === 'bill' && oSlot(item, e.period) === p);
    if (bills.length) return bills[bills.length - 1].amount;
    return item.expected > 0 ? item.expected : null;
}
const oPaid = (item, p) => item.entries.filter(e => e.kind === 'pay' && oSlot(item, e.period) === p).reduce((s, e) => s + e.amount, 0);
function oBalance(item, upto) {
    return oPeriods(item, upto).reduce((s, p) => s + (oBill(item, p) ?? 0) - oPaid(item, p), 0);
}
function oRow(item, p, today) {
    const list = oPeriods(item, p);
    const before = list.length > 1 ? oBalance(item, list[list.length - 2]) : 0;
    const bill = oBill(item, p);
    const paid = oPaid(item, p);
    const after = before + (bill ?? 0) - paid;
    const arrears = Math.max(0, before);
    const credit = Math.max(0, -before);
    const y = (bill ?? 0) + arrears;
    const x = paid + Math.min(credit, bill ?? 0);
    const due = `${p}-${String(item.dueDay).padStart(2, '0')}`;
    // Overdue: still owed after this bill, and either its due date has passed or what was owed from before is not paid off
    const overdue = after > 0 && (today > due || paid < arrears);
    let state;
    if (bill === null) state = 'nobill';
    else if (after <= 0) state = 'paid';
    else if (overdue) state = 'overdue';
    else if (x > 0) state = 'part';
    else state = 'due';
    return { period: p, due, bill, paid, opening: before, closing: after, owed: y, covered: Math.min(x, y), overdue, state };
}
function oNextDue(item, today) {
    const list = oPeriods(item, today.slice(0, 7));
    const cur = list[list.length - 1];
    if (cur && oRow(item, cur, today).state !== 'paid') return `${cur}-${String(item.dueDay).padStart(2, '0')}`;
    const later = oPeriods(item, '2099-12').find(p => p > (cur || '0000'));
    return later ? `${later}-${String(item.dueDay).padStart(2, '0')}` : null;
}
function oPlusDays(day, n) {
    const d = new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8)) + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function oDue(items, day) {
    const soon = oPlusDays(day, 3);
    const out = { count: 0, due: 0, nobill: 0 };
    for (const item of items) {
        const list = oPeriods(item, soon.slice(0, 7));
        if (!list.length) continue;
        const r = oRow(item, list[list.length - 1], day);
        const amount = r.due <= soon ? Math.max(0, r.closing) : Math.max(0, Math.min(r.closing, r.opening - r.paid));
        const missing = r.bill === null && r.due <= soon;
        if (amount > 0 || missing) {
            out.count++;
            out.due += amount;
            if (missing) out.nobill++;
        }
    }
    return out;
}

// ---- Generators ----
const month = fc.constantFrom(...MONTHS);
const dayArb = fc.record({ m: month, d: fc.integer({ min: 1, max: 28 }) }).map(({ m, d }) => `${m}-${String(d).padStart(2, '0')}`);
const itemArb = fc.record({
    startMonth: month,
    cadence: fc.constantFrom(1, 2, 3, 6, 12),
    dueDay: fc.integer({ min: 1, max: 28 }),
    expected: fc.oneof(fc.constant(0), fc.integer({ min: 100, max: 5000 })),
    end: fc.option(month, { nil: '' }),
    entries: fc.array(fc.record({
        kind: fc.constantFrom('bill', 'pay', 'pay'), period: month, day: fc.integer({ min: 1, max: 28 }), dateMonth: month,
        amount: fc.integer({ min: 0, max: 6000 })
    }), { maxLength: 12 })
}).map(({ startMonth, cadence, dueDay, expected, end, entries }) => ({
    name: 'Bill', startMonth, cadence, dueDay, expected, active: !end || end < startMonth ? true : false,
    endMonth: end && end >= startMonth ? end : '',
    entries: entries.map((e, i) => ({
        id: `e${i}`, kind: e.kind, period: e.period, date: `${e.dateMonth}-${String(e.day).padStart(2, '0')}`,
        amount: e.kind === 'pay' ? Math.max(1, e.amount) : e.amount, ...(e.kind === 'pay' ? { mode: 'cash' } : {})
    }))
}));

describe('RB-1 … RB-7: each bill item, period by period', () => {
    test('periods, bill, paid, carried in, balance, state and overdue agree with running totals', () => {
        fc.assert(fc.property(itemArb, month, dayArb, (item, upto, today) => {
            expect(periodsUpTo(item, upto)).toEqual(oPeriods(item, upto));
            const { periods, balance } = billLedger(item, upto, today);
            for (const r of periods) {
                const o = oRow(item, r.period, today);
                expect({ period: r.period, due: r.due, bill: r.bill, paid: r.paid, opening: r.opening, closing: r.closing, owed: r.owed, covered: r.covered, overdue: r.overdue, state: r.state }).toEqual(o);
            }
            expect(balance).toBe(oBalance(item, upto));
        }), { numRuns: 300 });
    });

    test('RB-10 next due: the current bill while it is not paid, else the next one (none after a stop)', () => {
        fc.assert(fc.property(itemArb, dayArb, (item, today) => {
            expect(itemView(item, today).nextDue).toBe(oNextDue(item, today));
        }), { numRuns: 300 });
    });
});

describe('RB-8, RB-9: the page cards', () => {
    test('Due now, credit carried, Paid this month (by date) and the counts', () => {
        fc.assert(fc.property(fc.array(itemArb, { maxLength: 5 }), dayArb, (list, today) => {
            const s = billsSummary(list, today);
            const balances = list.map(i => oBalance(i, today.slice(0, 7)));
            expect(s.dueNow).toBe(balances.filter(b => b > 0).reduce((t, b) => t + b, 0));
            expect(s.credit).toBe(balances.filter(b => b < 0).reduce((t, b) => t - b, 0));
            expect(s.paidMonth).toBe(list.flatMap(i => i.entries).filter(e => e.kind === 'pay' && e.date.startsWith(today.slice(0, 7))).reduce((t, e) => t + e.amount, 0));
            const states = list.map(i => oPeriods(i, today.slice(0, 7))).map((ps, n) => (ps.length ? oRow(list[n], ps[ps.length - 1], today).state : null));
            for (const k of ['paid', 'part', 'due', 'overdue', 'nobill']) expect(s.counts[k]).toBe(states.filter(x => x === k).length);
        }), { numRuns: 300 });
    });
});

describe('RB-11: bills due on Today', () => {
    test('items due within 3 days or overdue, what is due by then, and those with no amount', () => {
        fc.assert(fc.property(fc.array(itemArb, { maxLength: 5 }), dayArb, (list, day) => {
            expect(billsDue(list, day)).toEqual(oDue(list, day));
            const days = billsDueDays(list, day, 3);
            expect(Object.keys(days)).toEqual([day, oPlusDays(day, 1), oPlusDays(day, 2)]);
            for (const [k, v] of Object.entries(days)) expect(v).toEqual(oDue(list, k));
        }), { numRuns: 300 });
    });
});

describe('worked examples', () => {
    const elec = (entries, extra = {}) => ({ name: 'Electricity', cadence: 2, dueDay: 10, startMonth: '2026-01', expected: 0, active: true, endMonth: '', entries, ...extra });
    const bill = (period, amount, id = `b${period}${amount}`) => ({ id, kind: 'bill', period, date: `${period}-02`, amount });
    const pay = (period, amount, date = `${period}-08`) => ({ id: `p${period}${amount}${date}`, kind: 'pay', period, date, amount, mode: 'cash' });
    const row = (item, p, today = '2026-12-31') => billLedger(item, '2026-12', today).periods.find(r => r.period === p);

    test('bimonthly electricity with a varying amount: bills every 2 months on the 10th', () => {
        const item = elec([bill('2026-01', 1240), pay('2026-01', 1240), bill('2026-03', 1580), pay('2026-03', 1580), bill('2026-05', 990)]);
        expect(periodsUpTo(item, '2026-06')).toEqual(['2026-01', '2026-03', '2026-05']);
        expect(dueDateOf(item, '2026-05')).toBe('2026-05-10');
        expect(billLedger(item, '2026-06', '2026-06-01').periods.map(r => [r.bill, r.state])).toEqual([[1240, 'paid'], [1580, 'paid'], [990, 'overdue']]);
        expect(itemView(item, '2026-05-05')).toMatchObject({ balance: 990, nextDue: '2026-05-10', current: { state: 'due', owed: 990 } });
        expect(itemView(item, '2026-04-20').nextDue).toBe('2026-05-10');
    });

    test('a part payment, then the rest', () => {
        const part = elec([bill('2026-01', 1240), pay('2026-01', 500)]);
        expect(itemView(part, '2026-01-09').current).toMatchObject({ state: 'part', covered: 500, owed: 1240, closing: 740 });
        expect(itemView(part, '2026-01-11').current).toMatchObject({ state: 'overdue', closing: 740, overdue: true });
        const rest = elec([...part.entries, pay('2026-01', 740, '2026-01-12')]);
        expect(itemView(rest, '2026-01-12')).toMatchObject({ balance: 0, current: { state: 'paid' }, nextDue: '2026-03-10' });
    });

    test('an overpayment carries as a credit to the next bill', () => {
        const item = elec([bill('2026-01', 1240), pay('2026-01', 1500), bill('2026-03', 1580)]);
        expect(row(item, '2026-01')).toMatchObject({ state: 'paid', closing: -260 });
        expect(billsSummary([item], '2026-02-15')).toMatchObject({ dueNow: 0, credit: 260 });
        expect(row(item, '2026-03', '2026-03-05')).toMatchObject({ opening: -260, owed: 1580, covered: 260, state: 'part', closing: 1320 });
    });

    test('unpaid carries forward: the next bill is overdue at once for what was carried in', () => {
        const item = elec([bill('2026-01', 1240), bill('2026-03', 1580)]);
        const mar = billLedger(item, '2026-03', '2026-03-01').periods[1];
        expect(mar).toMatchObject({ opening: 1240, owed: 2820, closing: 2820, overdue: true, state: 'overdue' });
        expect(billsDue([item], '2026-03-01')).toEqual({ count: 1, due: 1240, nobill: 0 });
        expect(billsDue([item], '2026-03-07')).toEqual({ count: 1, due: 2820, nobill: 0 });
    });

    test('a stopped item: no bill after its last month; what is owed stays', () => {
        const item = elec([bill('2026-01', 1240), bill('2026-03', 1580), pay('2026-03', 1000)], { active: false, endMonth: '2026-03' });
        expect(periodsUpTo(item, '2026-12')).toEqual(['2026-01', '2026-03']);
        expect(itemView(item, '2026-08-01')).toMatchObject({ balance: 1820, nextDue: '2026-03-10', current: { period: '2026-03', state: 'overdue' } });
        const paid = elec([bill('2026-01', 1240), pay('2026-01', 1240)], { active: false, endMonth: '2026-02' });
        expect(itemView(paid, '2026-08-01')).toMatchObject({ balance: 0, nextDue: null });
    });

    test('a start mid-year: quarterly from July', () => {
        const item = { ...elec([]), cadence: 3, startMonth: '2026-07', dueDay: 5 };
        expect(periodsUpTo(item, '2027-03')).toEqual(['2026-07', '2026-10', '2027-01']);
        expect(itemView(item, '2026-05-20')).toMatchObject({ current: null, nextDue: '2026-07-05', periods: [] });
        expect(entryPeriods(item, '2026-05-20')).toEqual(['2026-07']);
    });

    test('a period with no bill entered yet: "amount not entered"; the usual amount stands in when set', () => {
        const item = elec([]);
        expect(itemView(item, '2026-01-05').current).toMatchObject({ bill: null, state: 'nobill', closing: 0 });
        expect(billsDue([item], '2026-01-07')).toEqual({ count: 1, due: 0, nobill: 1 });
        expect(billsDue([item], '2026-01-06')).toEqual({ count: 0, due: 0, nobill: 0 });
        const usual = { ...item, expected: 1200 };
        expect(itemView(usual, '2026-01-05').current).toMatchObject({ bill: 1200, source: 'expected', state: 'due' });
    });

    test('a correction is a newer bill entry for the same period: the newest counts', () => {
        const item = elec([bill('2026-01', 12400, 'b1'), bill('2026-01', 1240, 'b2')]);
        expect(row(item, '2026-01').bill).toBe(1240);
    });

    test('Today: due within 3 days, across a month end', () => {
        const monthly = { ...elec([bill('2026-02', 700)]), cadence: 1, startMonth: '2026-02', dueDay: 1 };
        expect(billsDue([monthly], '2026-01-28')).toEqual({ count: 0, due: 0, nobill: 0 });
        expect(billsDue([monthly], '2026-01-29')).toEqual({ count: 1, due: 700, nobill: 0 });
    });

    test('unusual bill: more than 3 times the last one (or the usual amount)', () => {
        const item = elec([bill('2026-01', 1000)]);
        expect(unusualBill(item, '2026-03', 3000)).toBeNull();
        expect(unusualBill(item, '2026-03', 3001)).toBe(1000);
        expect(unusualBill(elec([]), '2026-01', 9000)).toBeNull();
        expect(unusualBill(elec([], { expected: 500 }), '2026-01', 1501)).toBe(500);
    });

    test('form checks', () => {
        const item = elec([]);
        expect(checkEntry({ kind: 'pay', amount: '500', period: '2026-03', date: '2026-03-04', mode: 'online' }, item, '2026-03-04').entry)
            .toEqual({ kind: 'pay', period: '2026-03', date: '2026-03-04', amount: 500, mode: 'online' });
        expect(checkEntry({ kind: 'bill', amount: '0', period: '2026-05', date: '2026-03-04' }, item, '2026-03-04').entry).toEqual({ kind: 'bill', period: '2026-05', date: '2026-03-04', amount: 0 });
        expect(checkEntry({ kind: 'pay', amount: '0', period: '2026-03', date: '2026-03-04' }, item, '2026-03-04').error).toBe('msg.rbills.bad_amount');
        expect(checkEntry({ kind: 'pay', amount: '5', period: '2026-02', date: '2026-03-04' }, item, '2026-03-04').error).toBe('msg.rbills.bad_period');
        expect(checkEntry({ kind: 'pay', amount: '5', period: '2026-07', date: '2026-03-04' }, item, '2026-03-04').error).toBe('msg.rbills.bad_period');
        expect(checkEntry({ kind: 'pay', amount: '5', period: '2026-03', date: '2026-03-05' }, item, '2026-03-04').error).toBe('msg.rbills.bad_date');
        const f = { name: ' Water ', cadence: '1', dueDay: '28', startMonth: '2026-03', expected: '', note: ' K-55 ' };
        expect(checkItem(f, '2026-03').item).toEqual({ name: 'Water', cadence: 1, dueDay: 28, startMonth: '2026-03', expected: 0, note: 'K-55' });
        expect(checkItem({ ...f, cadence: '4' }, '2026-03').error).toBe('msg.rbills.bad_cadence');
        expect(checkItem({ ...f, dueDay: '31' }, '2026-03').error).toBe('msg.rbills.bad_due_day');
        expect(checkItem({ ...f, expected: '1.5' }, '2026-03').error).toBe('msg.rbills.bad_amount');
        expect(checkItem({ ...f, startMonth: '2027-04' }, '2026-03').error).toBe('msg.rbills.bad_month');
    });
});
