import {
    newShareToken, isShareToken, publicMonth, buildPublicSnapshot, withMonth, withLease, withNames, publicLink, PUBLIC_MONTHS
} from '../rentals/rent-public.js';
import { buildRentReminderText } from '../rentals/rent-math.js';

const nodeCrypto = require('crypto').webcrypto;
const lease = { id: 'L1', rent: 5000, dueDay: 10, status: 'active', endMonth: null, tenantId: 'T1' };
const charge = (m, over = {}) => ({ leaseId: 'L1', month: m, dueDay: 10, rent: 5000, electricity: null, amount: 5000, paid: 0, payments: [], ...over });

test('share token: 144 random bits, base64url, never repeats', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newShareToken(nodeCrypto)));
    expect(tokens.size).toBe(200);
    for (const tk of tokens) {
        expect(tk).toMatch(/^[A-Za-z0-9_-]{24}$/);
        expect(isShareToken(tk)).toBe(true);
    }
    expect(isShareToken('short')).toBe(false);
    expect(isShareToken('../../etc/passwd/xxxxxxxxxxxxxxxx')).toBe(false);
});

test('a month as the tenant sees it (RENT-8): rent, electricity, total, paid, dates, due, status', () => {
    const c = charge('2026-09', {
        electricity: { prev: 100, curr: 150, rate: 8, units: 50, amount: 400 }, amount: 5400, paid: 2000,
        payments: [{ amount: 1000, date: '2026-09-12', by: 'u1', byName: 'Asha' }, { amount: 1000, date: '2026-09-05', by: 'u2' }]
    });
    expect(publicMonth(c, new Date(2026, 9, 1))).toEqual({
        m: '2026-09', rent: 5000, elec: 400, units: 50, total: 5400, paid: 2000, due: 3400, dd: 10, st: 'late', pd: ['2026-09-05', '2026-09-12']
    });
    expect(publicMonth(charge('2026-10', { paid: 5000 }), new Date(2026, 9, 20)).st).toBe('paid');
});

test('snapshot: only this lease, no phone or ids beyond the lease id, newest months kept', () => {
    const charges = [charge('2026-08'), charge('2026-09'), { ...charge('2026-09'), leaseId: 'OTHER' }];
    const s = buildPublicSnapshot({ lease, tenantName: 'Ram', place: 'Gali 2 · G1', shopName: 'Shop', charges, now: 1 });
    expect(Object.keys(s).sort()).toEqual(['dueDay', 'endMonth', 'ended', 'lid', 'months', 'place', 'rent', 'shop', 'tenant', 'updatedAt', 'v']);
    expect(s.months.map(m => m.m)).toEqual(['2026-08', '2026-09']);
    expect(JSON.stringify(s)).not.toMatch(/phone|tenantId|unitId|by"|byName|Asha/);
    let big = s;
    for (let i = 0; i < 50; i++) big = withMonth(big, charge(`20${30 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`), 2);
    expect(big.months).toHaveLength(PUBLIC_MONTHS);
});

test('updates: a payment replaces its month; move-out drops later months and marks ended', () => {
    const s = buildPublicSnapshot({ lease, charges: [charge('2026-09'), charge('2026-10')], now: 1 });
    const paid = withMonth(s, charge('2026-10', { paid: 5000, payments: [{ amount: 5000, date: '2026-10-08' }] }), 2);
    expect(paid.months.find(m => m.m === '2026-10')).toMatchObject({ paid: 5000, due: 0, st: 'paid', pd: ['2026-10-08'] });
    expect(paid.months).toHaveLength(2);
    const out = withLease(paid, { ...lease, status: 'ended', endMonth: '2026-09' }, 3);
    expect(out).toMatchObject({ ended: true, endMonth: '2026-09' });
    expect(out.months.map(m => m.m)).toEqual(['2026-09']);
    expect(withLease(s, { ...lease, rent: 5250 }).rent).toBe(5250);
});

test('snapshot carries the unit type (known types only) and renames can change it', () => {
    const s = buildPublicSnapshot({ lease, tenantName: 'Ram', place: '2B, Gupta Bhawan', unitType: 'flat', charges: [] });
    expect(s.ut).toBe('flat');
    expect(buildPublicSnapshot({ lease, unitType: 'castle', charges: [] }).ut).toBeUndefined();
    expect(withNames(s, { unitType: 'commercial', place: 'Shop 3, Gupta Bhawan' }, 2)).toMatchObject({ ut: 'commercial', place: 'Shop 3, Gupta Bhawan', tenant: 'Ram' });
});

test('link: public site path /r/<token>; dev data and emulator marked', () => {
    expect(publicLink('https://myhappa.web.app', 'A'.repeat(24))).toBe(`https://myhappa.web.app/r/${'A'.repeat(24)}`);
    expect(publicLink('http://127.0.0.1:8099', 'tok', { dev: true, emulator: true })).toBe('http://127.0.0.1:8099/r/tok?d=1&emulator=1');
});

test('WhatsApp reminder carries the link when it is on, in one language', () => {
    const charges = [charge('2026-10')];
    const en = buildRentReminderText({ tenantName: 'Ram', charges, link: 'https://myhappa.web.app/r/abc' });
    expect(en).toContain('See your rent history: https://myhappa.web.app/r/abc');
    const hi = buildRentReminderText({ tenantName: 'Ram', charges, link: 'https://x/r/abc', lang: 'hi' });
    expect(hi).toContain('अपने किराये का हिसाब देखें: https://x/r/abc');
    expect(buildRentReminderText({ tenantName: 'Ram', charges })).not.toContain('/r/');
});
