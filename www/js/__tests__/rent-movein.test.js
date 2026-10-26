import {
    firstMonthRent, mobile10, isDate, dateLabel, newCharge, increaseDue, buildRentReminderText, elecMode, tenantError, leaseError
} from '../rentals/rent-math.js';

test('first month (RENT-11): full rent by default; pro-rated by days from the start date when chosen', () => {
    expect(firstMonthRent(6000, '2026-10-16', false)).toBe(6000);
    expect(firstMonthRent(6200, '2026-10-16', true)).toBe(3200);
    expect(firstMonthRent(6000, '2026-02-01', true)).toBe(6000);
    expect(firstMonthRent(3000, '2028-02-29', true)).toBe(103);
    const lease = { id: 'L', rent: 6200, startMonth: '2026-10', firstRent: 3200, dueDay: 10 };
    expect(newCharge(lease, '2026-10')).toMatchObject({ rent: 3200, amount: 3200 });
    expect(newCharge(lease, '2026-11')).toMatchObject({ rent: 6200, amount: 6200 });
});

test('mobile numbers: 10-digit Indian mobile, with +91 / 0 / spaces accepted and stored as 10 digits', () => {
    expect(mobile10('98765 43210')).toBe('9876543210');
    expect(mobile10('+91 98765-43210')).toBe('9876543210');
    expect(mobile10('09876543210')).toBe('9876543210');
    expect(mobile10('5876543210')).toBe('');
    expect(mobile10('12345')).toBe('');
    expect(tenantError({ name: 'Sita', phone: '' })).toBe('msg.rent.bad_phone');
    expect(tenantError({ name: 'Sita', phone: '9876543210', phone2: '12' })).toBe('msg.rent.bad_phone');
    expect(tenantError({ name: 'Sita', phone: '9876543210' })).toBe('');
});

test('start date: real dates only, matching the start month; electricity mode checked', () => {
    expect(isDate('2026-02-29')).toBe(false);
    expect(isDate('2028-02-29')).toBe(true);
    expect(dateLabel('2026-10-05')).toBe('05/10/2026');
    const base = { rent: 1, dueDay: 10, increasePct: 5 };
    expect(leaseError({ ...base, startDate: '2026-10-05', startMonth: '2026-10' }, '2026-10')).toBe('');
    expect(leaseError({ ...base, startDate: '2026-10-05', startMonth: '2026-09' }, '2026-10')).toBe('msg.rent.bad_date');
    expect(leaseError({ ...base, startDate: '2026-10-05', startMonth: '2026-10', elecMode: 'solar' }, '2026-10')).toBe('msg.rent.bad_elec_mode');
    expect(elecMode({})).toBe('meter');
    expect(elecMode({ elecMode: 'own' })).toBe('own');
});

test('yearly increase counts from the start date anniversary; after a rent change, a year from that month', () => {
    const lease = { status: 'active', rent: 6000, startMonth: '2025-10', startDate: '2025-10-20', rentSince: '2025-10', increasePct: 5 };
    expect(increaseDue(lease, '2026-10', new Date(2026, 9, 19)).due).toBe(false);
    expect(increaseDue(lease, '2026-10', new Date(2026, 9, 20))).toMatchObject({ due: true, newRent: 6300 });
    expect(increaseDue({ ...lease, rentSince: '2026-11' }, '2027-10', new Date(2027, 9, 25)).due).toBe(false);
    expect(increaseDue({ ...lease, rentSince: '2026-11' }, '2027-11', new Date(2027, 10, 1)).due).toBe(true);
});

test('reminder header shows the start date', () => {
    const charges = [{ month: '2026-10', amount: 6000, paid: 0 }];
    expect(buildRentReminderText({ tenantName: 'Sita', charges, since: '2025-10-20' })).toContain('Tenant since 20/10/2025');
    expect(buildRentReminderText({ tenantName: 'Sita', charges, since: '2025-10-20', lang: 'hi' })).toContain('20/10/2025 से किरायेदार');
});
