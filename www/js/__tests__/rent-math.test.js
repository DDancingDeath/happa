import {
    monthKey, addMonths, monthRange, monthLabel, monthsToCharge, newCharge, chargeDue, chargeStatus,
    applyPayment, rentTotals, leaseDues, buildRentReminderText, leaseError, tenantError, unitError,
    propertyError, increaseDue, meterBill, applyMeter, MAX_BACKFILL_MONTHS, DEFAULT_DUE_DAY, DEFAULT_INCREASE_PCT,
    proRateRent, firstMonthRent, moveMonthRent, moveMonthSplit, changeUnitPlan, moveInError, receiptAmounts, paidEarlier
} from '../rentals/rent-math.js';

const lease = (over = {}) => ({
    id: 'L1', unitId: 'U1', propertyId: 'P1', tenantId: 'T1', rent: 5000, dueDay: 5,
    startMonth: '2026-08', endMonth: null, status: 'active', chargedThrough: null, ...over
});

describe('months', () => {
    test('monthKey is local time and addMonths crosses years', () => {
        expect(monthKey(new Date(2026, 0, 31, 23, 59))).toBe('2026-01');
        expect(addMonths('2026-12', 1)).toBe('2027-01');
        expect(addMonths('2027-01', -1)).toBe('2026-12');
        expect(monthRange('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
        expect(monthRange('2026-03', '2026-02')).toEqual([]);
        expect(monthLabel('2026-10')).toBe('Oct 2026');
        expect(monthLabel('2026-10', 'hi')).toBe('अक्टूबर 2026');
    });
});

describe('monthsToCharge', () => {
    test('from the start month, then only after chargedThrough', () => {
        expect(monthsToCharge(lease(), '2026-10')).toEqual(['2026-08', '2026-09', '2026-10']);
        expect(monthsToCharge(lease({ chargedThrough: '2026-09' }), '2026-10')).toEqual(['2026-10']);
        expect(monthsToCharge(lease({ chargedThrough: '2026-10' }), '2026-10')).toEqual([]);
    });

    test('nothing for ended/invalid leases or a future start; stops at the end month', () => {
        expect(monthsToCharge(lease({ status: 'ended' }), '2026-10')).toEqual([]);
        expect(monthsToCharge(lease({ startMonth: '2026-11' }), '2026-10')).toEqual([]);
        expect(monthsToCharge(lease({ startMonth: 'bad' }), '2026-10')).toEqual([]);
        expect(monthsToCharge(lease({ endMonth: '2026-09' }), '2026-12')).toEqual(['2026-08', '2026-09']);
    });

    test('all missing months, oldest first (charged one month per write)', () => {
        const months = monthsToCharge(lease({ startMonth: '2024-11' }), '2026-10');
        expect(months).toHaveLength(MAX_BACKFILL_MONTHS);
        expect(months[0]).toBe('2024-11');
        expect(months[months.length - 1]).toBe('2026-10');
    });

    test('start month: at most 24 months back, at most next month', () => {
        const ok = { rent: 1, dueDay: 10, increasePct: 5 };
        expect(leaseError({ ...ok, startMonth: '2024-11' }, '2026-10')).toBe('');
        expect(leaseError({ ...ok, startMonth: '2024-10' }, '2026-10')).toBe('msg.rent.start_too_old');
        expect(leaseError({ ...ok, startMonth: '2026-12' }, '2026-10')).toBe('msg.rent.start_too_old');
    });

    test('newCharge is open with nothing paid (a 0 rent month is closed)', () => {
        const c = newCharge(lease(), '2026-10', { tenantName: 'Ram', unitLabel: 'G1', now: 1 });
        expect(c).toMatchObject({ leaseId: 'L1', month: '2026-10', rent: 5000, electricity: null, amount: 5000, paid: 0, open: true, payments: [], tenantName: 'Ram' });
        expect(newCharge(lease({ rent: 0 }), '2026-10').open).toBe(false);
    });
});

describe('payments and status', () => {
    const charge = { month: '2026-10', dueDay: 5, amount: 5000, paid: 0 };

    test('partial then full payment', () => {
        const a = applyPayment(charge, 2000);
        expect(a).toEqual({ amount: 2000, paid: 2000, open: true });
        const b = applyPayment({ ...charge, paid: a.paid }, 3000);
        expect(b).toEqual({ amount: 3000, paid: 5000, open: false });
    });

    test('rejects zero, negative, NaN and more than due; rounds to paise', () => {
        expect(() => applyPayment(charge, 0)).toThrow('amount');
        expect(() => applyPayment(charge, -5)).toThrow('amount');
        expect(() => applyPayment(charge, 'x')).toThrow('amount');
        expect(() => applyPayment({ ...charge, paid: 4000 }, 1000.5)).toThrow('over');
        expect(() => applyPayment({ ...charge, payments: Array(12).fill({ amount: 1 }) }, 1)).toThrow('too_many');
        expect(applyPayment({ amount: 0.3, paid: 0.1 }, 0.2)).toEqual({ amount: 0.2, paid: 0.3, open: false });
    });

    test('status: due before the due day, late after it, partial, paid', () => {
        expect(chargeStatus(charge, new Date(2026, 9, 5))).toEqual({ status: 'due', late: false, due: 5000 });
        expect(chargeStatus(charge, new Date(2026, 9, 6)).late).toBe(true);
        expect(chargeStatus({ ...charge, paid: 100 }, new Date(2026, 9, 1)).status).toBe('partial');
        expect(chargeStatus({ ...charge, paid: 5000 }, new Date(2027, 0, 1))).toEqual({ status: 'paid', late: false, due: 0 });
    });
});

describe('totals', () => {
    const charges = [
        { leaseId: 'A', month: '2026-09', amount: 5000, paid: 1000 },
        { leaseId: 'A', month: '2026-10', amount: 5000, paid: 0 },
        { leaseId: 'B', month: '2026-10', amount: 3000, paid: 3000 },
        { leaseId: 'B', month: '2026-11', amount: 3000, paid: 0 }
    ];

    test('month totals (RENT-1..4) ignore later months; without a month, due is over all charges', () => {
        expect(rentTotals(charges, '2026-10')).toEqual({ expected: 8000, collected: 3000, pending: 5000, due: 9000 });
        expect(rentTotals(charges)).toEqual({ expected: 0, collected: 0, pending: 0, due: 12000 });
    });

    test('lease dues are oldest first (RENT-5)', () => {
        const d = leaseDues(charges, 'A');
        expect(d.charges.map(c => c.month)).toEqual(['2026-09', '2026-10']);
        expect(d.total).toBe(9000);
        expect(chargeDue({ amount: 1, paid: 2 })).toBe(0);
    });
});

describe('reminder text', () => {
    const charges = [{ month: '2026-09', amount: 5000, paid: 1000 }, { month: '2026-10', amount: 5000, paid: 5000 }, { month: '2026-11', amount: 5000, paid: 0 }];
    const latinAndDevanagari = (s) => s.split('\n').some(l => /[A-Za-z]{2,}/.test(l.replace(/Ram Kumar|Gali 2|G1/g, '')) && /[\u0900-\u097F]/.test(l));

    test('English only: months up to the last month, total, WhatsApp marks removed from names', () => {
        const text = buildRentReminderText({ tenantName: '*Ram*\nKumar', place: 'Gali 2 · G1', charges, lastMonth: '2026-10' });
        expect(text).toContain('Namaste Ram Kumar ji');
        expect(text).toContain('1. Sep 2026 · ₹4,000');
        expect(text).not.toContain('Nov 2026');
        expect(text).toContain('*Total due: ₹4,000*');
        expect(text).not.toMatch(/[\u0900-\u097F]/);
    });

    test('Hindi only, never mixed with English', () => {
        const text = buildRentReminderText({ tenantName: 'Ram Kumar', place: 'Gali 2 · G1', charges, lastMonth: '2026-11', lang: 'hi' });
        expect(text).toContain('नमस्ते Ram Kumar जी');
        expect(text).toContain('1. सितंबर 2026 · ₹4,000');
        expect(text).toContain('2. नवंबर 2026 · ₹5,000');
        expect(text).toContain('*कुल बकाया: ₹9,000*');
        expect(latinAndDevanagari(text)).toBe(false);
    });
});

describe('rent increase reminder (RENT-6)', () => {
    const l = (over = {}) => ({ status: 'active', rent: 5000, startMonth: '2025-10', increasePct: 5, ...over });

    test('defaults: due day 10, increase 5%', () => {
        expect(DEFAULT_DUE_DAY).toBe(10);
        expect(DEFAULT_INCREASE_PCT).toBe(5);
        expect(increaseDue(l({ increasePct: undefined }), '2026-10')).toMatchObject({ due: true, pct: 5, newRent: 5250 });
    });

    test('due 12 months after the rent was last set; custom %; never for ended leases or 0%', () => {
        expect(increaseDue(l(), '2026-09').due).toBe(false);
        expect(increaseDue(l(), '2026-10')).toEqual({ due: true, pct: 5, newRent: 5250, from: '2026-10' });
        expect(increaseDue(l({ rentSince: '2026-10' }), '2026-12').due).toBe(false);
        expect(increaseDue(l({ increasePct: 10 }), '2027-01').newRent).toBe(5500);
        expect(increaseDue(l({ status: 'ended' }), '2027-01').due).toBe(false);
        expect(increaseDue(l({ increasePct: 0 }), '2027-01').due).toBe(false);
    });
});

describe('electricity sub-meter (RENT-7)', () => {
    test('units × rate; bad readings rejected', () => {
        expect(meterBill({ prev: '100', curr: '150.5', rate: '8' })).toEqual({ prev: 100, curr: 150.5, rate: 8, units: 50.5, amount: 404 });
        expect(() => meterBill({ prev: 150, curr: 100, rate: 8 })).toThrow('reading');
        expect(() => meterBill({ prev: 0, curr: 10, rate: -1 })).toThrow('reading');
        expect(() => meterBill({ prev: 'x', curr: 10, rate: 1 })).toThrow('reading');
    });

    test('charge = rent + electricity; replacing a reading keeps the rent; never below what is paid', () => {
        const charge = { rent: 5000, amount: 5000, paid: 0 };
        expect(applyMeter(charge, { amount: 400 })).toEqual({ rent: 5000, amount: 5400, open: true });
        expect(applyMeter({ amount: 5400, electricity: { amount: 400 }, paid: 5400 }, { amount: 480 })).toEqual({ rent: 5000, amount: 5480, open: true });
        expect(applyMeter({ rent: 5000, amount: 5400, paid: 5400 }, { amount: 400 }).open).toBe(false);
        expect(() => applyMeter({ rent: 5000, amount: 5400, paid: 5300 }, { amount: 100 })).toThrow('below_paid');
    });
});

describe('form checks', () => {
    test('return a msg.rent.* key or empty', () => {
        expect(propertyError({ name: ' ' })).toBe('msg.rent.name_required');
        expect(propertyError({ name: 'A', address: 'x'.repeat(201) })).toBe('msg.rent.too_long');
        expect(unitError({ label: 'G1', rent: -1 })).toBe('msg.rent.bad_amount');
        expect(tenantError({ name: 'Ram', phone: '9876543210' })).toBe('');
        expect(leaseError({ rent: 5000, dueDay: 29, startMonth: '2026-10' })).toBe('msg.rent.bad_due_day');
        expect(leaseError({ rent: 5000, dueDay: 5, startMonth: '2026-13' })).toBe('msg.rent.bad_month');
        expect(leaseError({ rent: 5000, dueDay: 5, startMonth: '2026-10', deposit: 10000 })).toBe('');
        expect(leaseError({ rent: 5000, dueDay: 10, startMonth: '2026-10', increasePct: 101 })).toBe('msg.rent.bad_percent');
    });
});

describe('pro-rating: first month (RENT-11) and the move month (RENT-13)', () => {
    const from = { id: 'L1', rent: 6000, startMonth: '2027-06', startDate: '2027-06-01', chargedThrough: '2028-02' };

    test('proRateRent rounds rent × days ÷ days to the rupee', () => {
        expect(proRateRent(6000, 15, 31)).toBe(2903);
        expect(proRateRent(5000, 0, 29)).toBe(0);
        expect(proRateRent(4000, 30, 30)).toBe(4000);
    });

    test('leap February has 29 days, a common one 28', () => {
        expect(firstMonthRent(5800, '2028-02-29', true)).toBe(200);
        expect(firstMonthRent(5600, '2027-02-28', true)).toBe(200);
        expect(moveMonthRent(5800, from, '2028-02', '2028-02-15')).toBe(2800);
        expect(moveMonthRent(5600, from, '2027-02', '2027-02-15')).toBe(2800);
    });

    test('a move on the 1st: the old lease ends the month before and the new unit pays the full month', () => {
        expect(moveMonthSplit(from, [], '2028-03-01', 9000)).toMatchObject({ month: '2028-03', endMonth: '2028-02', old: null, next: 9000 });
        expect(firstMonthRent(9000, '2028-03-01', true)).toBe(9000);
    });

    test('a move on the 31st: 30 days in the old unit, 1 in the new one', () => {
        expect(moveMonthSplit(from, [], '2028-01-31', 3100)).toEqual({
            month: '2028-01', endMonth: '2028-01', ch: undefined, full: 6000, old: 5806, oldEnd: '2028-01-30', next: 100
        });
    });

    test('the share is of the month\'s charge (rent changed, electricity kept apart) or a pro-rated first month from its start day', () => {
        const ch = { leaseId: 'L1', month: '2028-02', rent: 5000, electricity: { amount: 480 }, amount: 5480 };
        expect(moveMonthSplit(from, [ch], '2028-02-19', 15000)).toMatchObject({ ch, full: 5000, old: 3103, oldEnd: '2028-02-18', next: 5690 });
        const late = { id: 'L2', rent: 7000, startMonth: '2028-02', startDate: '2028-02-10', firstRent: 4828 };
        // 10 Feb – 19 Feb of the 20 days 10 – 29 Feb the first charge covers.
        expect(moveMonthSplit(late, [], '2028-02-20', 6000)).toMatchObject({ full: 4828, old: 2414 });
    });
});

describe('change of unit plan (RENT-13)', () => {
    const from = { id: 'L1', rent: 5000, startMonth: '2027-06', startDate: '2027-06-01', chargedThrough: '2028-02' };
    const lease = { rent: 15000, startDate: '2028-02-19' };
    const ch = { leaseId: 'L1', month: '2028-02', rent: 5000, electricity: null, amount: 5000, paid: 4000 };

    test('members get the worked-out amounts; the old month is capped at what is paid', () => {
        const p = changeUnitPlan(from, [ch], lease);
        expect(p).toMatchObject({ firstRent: 5690, oldRent: 'auto', paidOld: { rent: 4000, amount: 4000, open: false, capped: true } });
        expect(changeUnitPlan(from, [ch], lease, { typed: { old: '1', next: '1' } }).firstRent).toBe(5690);
    });

    test('owner / manager amounts: within 0 … the rent; an own old amount is kept as typed', () => {
        expect(changeUnitPlan(from, [], lease, { mgr: true, typed: { old: '2500.505', next: '15000' } })).toMatchObject({ firstRent: 15000, oldRent: 2500.51, paidOld: null });
        expect(changeUnitPlan(from, [], lease, { mgr: true, typed: { old: '3103', next: '15001' } })).toEqual({ error: 'msg.rent.bad_split' });
        expect(changeUnitPlan(from, [], lease, { mgr: true, typed: { old: '5001', next: '1' } })).toEqual({ error: 'msg.rent.bad_split' });
        expect(changeUnitPlan(from, [], lease, { mgr: true, typed: { old: '', next: '' } })).toMatchObject({ firstRent: 0, oldRent: 0 });
    });

    test('not pro-rated: no amounts; members can\'t move back into a month charged ahead', () => {
        expect(changeUnitPlan(from, [ch], lease, { on: false })).toMatchObject({ oldRent: null, paidOld: null });
        expect(changeUnitPlan({ ...from, chargedThrough: '2028-03' }, [], { rent: 9000, startDate: '2028-02-01' })).toEqual({ error: 'msg.rent.change_backdate' });
        expect(changeUnitPlan({ ...from, chargedThrough: '2028-03' }, [], { rent: 9000, startDate: '2028-02-01' }, { mgr: true, on: false }).error).toBeUndefined();
    });
});

describe('move-in checks', () => {
    const lease = { rent: 6500, dueDay: 10, startDate: '2028-02-20', startMonth: '2028-02', increasePct: 5, elecMode: 'meter' };

    test('lease first, then the start-date window, then the opening meter (empty = not given)', () => {
        expect(moveInError(lease, null, '2028-02')).toBe('');
        expect(moveInError({ ...lease, dueDay: 29 }, { reading: -1, rate: 8 }, '2028-02', '2028-02-21')).toBe('msg.rent.bad_due_day');
        expect(moveInError(lease, { reading: -1, rate: 8 }, '2028-02', '2028-02-21')).toBe('msg.rent.move_date_window');
        expect(moveInError(lease, { reading: -1, rate: 8 }, '2028-02', '2028-02-18')).toBe('msg.rent.bad_reading');
        expect(moveInError(lease, { reading: 300, rate: NaN }, '2028-02')).toBe('msg.rent.bad_reading');
        expect(moveInError(lease, { reading: null, rate: null }, '2028-02')).toBe('');
        expect(moveInError(lease, { reading: 0, rate: 7.5 }, '2028-02')).toBe('');
    });
});

describe('receipt amounts (RENT-12)', () => {
    test('from the charge as written with the payment: total, paid now, balance after it, paid earlier', () => {
        const ch = { month: '2028-02', rent: 9000, electricity: { amount: 432.25 }, amount: 9432.25, paid: 9432.25 };
        const r = receiptAmounts(ch, { amount: 5432 });
        expect(r).toEqual({ months: ['2028-02'], rent: 9000, elec: { amount: 432.25 }, total: 9432.25, paid: 5432, balance: 0 });
        expect(paidEarlier(r)).toBe(4000.25);
        expect(receiptAmounts({ month: '2028-02', rent: 5000, amount: 5000, paid: 2000 }, { amount: 2000 })).toMatchObject({ elec: null, balance: 3000 });
    });
});
