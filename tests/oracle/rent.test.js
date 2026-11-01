/**
 * Rent oracle (#170, docs/calculations.md RENT-1 … RENT-5): an independent,
 * deliberately simple recomputation of the rentals numbers from leases and
 * payments, compared with rentals/rent-math.js on generated histories; RENT-13
 * (change of unit, the move month) against the same module; RENT-14 / RENT-15
 * (deposit ledger) on generated entries.
 */
import fc from 'fast-check';
import {
    monthsToCharge, newCharge, applyPayment, rentTotals, leaseDues, firstMonthRent, moveMonthRent, oldMonth,
    depositEntry, depositHeld, depositsTotal
} from '../../www/js/rentals/rent-math.js';

jest.mock('../../www/js/firebase/firestore-service.js', () => ({ FirebaseService: {} }));

const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];

// Oracle: whole rupees, plain loops, no shared helpers.
function oracle(leases, payments, month) {
    let expected = 0;
    let collected = 0;
    let outstanding = 0;
    const perLease = {};
    for (const l of leases) {
        perLease[l.id] = 0;
        for (const m of MONTHS) {
            if (m < l.start || m > month) continue;
            const rent = l.rent;
            const paid = payments.filter(p => p.lease === l.id && p.month === m).reduce((s, p) => s + p.amount, 0);
            if (m === month) { expected += rent; collected += paid; }
            outstanding += rent - paid;
            perLease[l.id] += rent - paid;
        }
    }
    return { expected, collected, pending: expected - collected, outstanding, perLease };
}

// App path: charges generated month by month, payments applied with applyPayment.
function app(leases, payments, month) {
    const charges = new Map();
    for (const l of leases) {
        let lease = { id: l.id, rent: l.rent, dueDay: 5, startMonth: l.start, status: 'active', chargedThrough: null };
        for (const m of MONTHS.filter(x => x <= month)) {
            const months = monthsToCharge(lease, m);
            months.forEach(mm => charges.set(`${l.id}_${mm}`, newCharge(lease, mm, { now: 0 })));
            if (months.length) lease = { ...lease, chargedThrough: months[months.length - 1] };
        }
    }
    for (const p of payments) {
        const c = charges.get(`${p.lease}_${p.month}`);
        const next = applyPayment(c, p.amount);
        Object.assign(c, { paid: next.paid, open: next.open });
    }
    const list = [...charges.values()];
    return { summary: rentTotals(list, month), dues: (id) => leaseDues(list, id).total };
}

const historyArb = fc.array(
    fc.record({ start: fc.constantFrom(...MONTHS), rent: fc.integer({ min: 0, max: 20000 }) }),
    { minLength: 1, maxLength: 5 }
).chain((ls) => {
    const leases = ls.map((l, i) => ({ id: `L${i}`, ...l }));
    return fc.tuple(
        fc.constant(leases),
        fc.array(fc.record({ lease: fc.integer({ min: 0, max: leases.length - 1 }), month: fc.constantFrom(...MONTHS), pct: fc.integer({ min: 1, max: 100 }) }), { maxLength: 12 }),
        fc.constantFrom(...MONTHS)
    );
});

describe('rent oracle (RENT-1 … RENT-5)', () => {
    test('app totals match the oracle on generated histories', () => {
        fc.assert(fc.property(historyArb, ([leases, rawPayments, month]) => {
            // Keep only payments the app accepts: charge exists, amount > 0 and within what is still due.
            const paidSoFar = {};
            const payments = [];
            for (const p of rawPayments) {
                const l = leases[p.lease];
                if (p.month < l.start || p.month > month) continue;
                const key = `${l.id}_${p.month}`;
                const left = l.rent - (paidSoFar[key] || 0);
                const amount = Math.floor(left * p.pct / 100);
                if (amount <= 0) continue;
                paidSoFar[key] = (paidSoFar[key] || 0) + amount;
                payments.push({ lease: l.id, month: p.month, amount });
            }
            const want = oracle(leases, payments, month);
            const got = app(leases, payments, month);
            expect(got.summary).toEqual({ expected: want.expected, collected: want.collected, pending: want.pending, due: want.outstanding });
            for (const l of leases) expect(got.dues(l.id)).toBe(want.perLease[l.id]);
        }), { seed: 170, numRuns: Number(process.env.FC_RUNS) || 100 });
    });
});

describe('change of unit, the move month (RENT-13)', () => {
    test('RENT-13: days in the old unit up to the day before the move, rounded to the rupee', () => {
        // Independent count: walk the days.
        const oracle = (full, from, date) => {
            const [y, m, d] = date.split('-').map(Number);
            let covered = 0;
            let stayed = 0;
            for (let day = from; new Date(y, m - 1, day).getMonth() === m - 1; day++) {
                covered++;
                if (day < d) stayed++;
            }
            return Math.round(full * stayed / covered);
        };
        expect(moveMonthRent(6000, { startMonth: '2026-01' }, '2026-10', '2026-10-16')).toBe(2903);
        expect(moveMonthRent(5800, { startMonth: '2027-01' }, '2028-02', '2028-02-10')).toBe(1800);
        expect(moveMonthRent(5000, { startMonth: '2026-01' }, '2026-10', '2026-10-01')).toBe(0);
        // An old lease that started (pro-rated) in the move month: its charge covers the 11th–30th.
        expect(moveMonthRent(4000, { startMonth: '2026-11', startDate: '2026-11-11', firstRent: 2667 }, '2026-11', '2026-11-21')).toBe(oracle(4000, 11, '2026-11-21'));
        for (const [full, date] of [[5000, '2026-02-15'], [7777, '2026-09-30'], [12345, '2028-02-29'], [9000, '2026-12-02']]) {
            expect(moveMonthRent(full, { startMonth: '2020-01' }, date.slice(0, 7), date)).toBe(oracle(full, 1, date));
        }
        // The two sides of a move add up to the month's rent (same rent, both rounded).
        expect(moveMonthRent(6000, { startMonth: '2026-01' }, '2026-10', '2026-10-16') + firstMonthRent(6000, '2026-10-16', true)).toBe(6000);
    });

    test('RENT-13: more than the old share paid: the month closes at what is paid; fully paid stays as it is', () => {
        // Independent: the old month owes max(share + electricity, paid), never more than the charge, and nothing stays open above the share.
        const oracle = (ch, share) => {
            const e = ch.electricity ? ch.electricity.amount : 0;
            const amount = Math.min(ch.amount, Math.max(share + e, ch.paid));
            return { amount, due: Math.max(0, amount - ch.paid), unchanged: amount === ch.amount };
        };
        const cases = [
            [{ rent: 5000, amount: 5000, paid: 3000, electricity: null }, 2419],
            [{ rent: 5000, amount: 5300, paid: 3500, electricity: { amount: 300 } }, 2419],
            [{ rent: 5000, amount: 5000, paid: 5000, electricity: null }, 2419],
            [{ rent: 5000, amount: 5000, paid: 1000, electricity: null }, 2419],
            [{ rent: 5000, amount: 5000, paid: 0, electricity: null }, 2419]
        ];
        for (const [ch, share] of cases) {
            const o = oldMonth(ch, share);
            const want = oracle(ch, share);
            const amount = o.kept ? ch.amount : o.amount;
            expect({ amount, due: Math.max(0, amount - ch.paid), unchanged: o.kept || amount === ch.amount }).toEqual(want);
        }
        expect(oldMonth({ rent: 5000, amount: 5000, paid: 3000 }, 2419)).toMatchObject({ rent: 3000, amount: 3000, open: false, capped: true, kept: false });
        expect(oldMonth({ rent: 5000, amount: 5000, paid: 5000 }, 2419)).toMatchObject({ kept: true, capped: false });
    });
});

describe('deposit ledger (RENT-14, RENT-15)', () => {
    test('held = received − adjusted − refunded; adjust/refund never above what is held (or the month due); total = Σ held', () => {
        const opArb = fc.record({ kind: fc.constantFrom('received', 'adjust', 'refund'), amount: fc.integer({ min: 1, max: 30000 }), due: fc.integer({ min: 0, max: 20000 }) });
        fc.assert(fc.property(fc.array(fc.array(opArb, { maxLength: 15 }), { minLength: 1, maxLength: 4 }), (ledgers) => {
            const held = ledgers.map((ops) => {
                // Oracle: a running balance in whole rupees, refusing what it can't cover.
                let want = 0;
                const entries = [];
                for (const op of ops) {
                    const cap = op.kind === 'received' ? Infinity : op.kind === 'refund' ? want : Math.min(want, op.due);
                    const ok = op.amount <= cap;
                    let got = null;
                    try { got = depositEntry(entries, op.kind, op.amount, op.due); } catch (e) { got = null; }
                    expect(got !== null).toBe(ok);
                    if (!ok) continue;
                    want += op.kind === 'received' ? op.amount : -op.amount;
                    entries.push({ kind: op.kind, amount: op.amount });
                    expect(got.held).toBe(want);
                }
                expect(depositHeld(entries)).toBe(want);
                expect(want).toBeGreaterThanOrEqual(0);
                return want;
            });
            let sum = 0;
            for (const h of held) sum += h;
            expect(depositsTotal(held.map(h => ({ held: h })))).toBe(sum);
        }), { seed: 157, numRuns: Number(process.env.FC_RUNS) || 100 });
    });
});
