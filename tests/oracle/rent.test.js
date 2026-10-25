/**
 * Rent oracle (#170, docs/calculations.md RENT-1 … RENT-5): an independent,
 * deliberately simple recomputation of the rentals numbers from leases and
 * payments, compared with rentals/rent-math.js on generated histories.
 */
import fc from 'fast-check';
import { monthsToCharge, newCharge, applyPayment, monthSummary, leaseDues } from '../../www/js/rentals/rent-math.js';

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
    return { summary: monthSummary(list, month), dues: (id) => leaseDues(list, id).total };
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
            expect(got.summary).toEqual({ expected: want.expected, collected: want.collected, pending: want.pending, outstanding: want.outstanding });
            for (const l of leases) expect(got.dues(l.id)).toBe(want.perLease[l.id]);
        }), { seed: 170, numRuns: Number(process.env.FC_RUNS) || 100 });
    });
});
