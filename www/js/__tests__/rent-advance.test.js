/**
 * Advance carried forward (#157, RENT-16): more than is due on the lease's latest
 * month pays it off and the rest is the month's advance; the next month is
 * created paid from it (the rest carried on); an advance left when the lease ends
 * goes into the deposit ledger. Math (rent-math.js) and the store on the
 * in-memory Firestore with optimistic transactions.
 */
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

const fake = createFakeFirestore({ occ: true });
jest.mock('../firebase/firestore-service.js', () => ({ FirebaseService: { get db() { return global.__fakeDb; }, serverTimestamp: () => 'SERVER_TIME' } }));
global.__fakeDb = fake.db;

import { AppState } from '../utils/state.js';
import * as store from '../rentals/rent-store.js';
import * as ds from '../rentals/rent-deposit-store.js';
import { applyPayment, withAdvance, receiptAmounts, payOldestFirst, payAmount } from '../rentals/rent-math.js';
import { receiptReceived, advanceLeft } from '../rentals/rent-math-ledger.js';
import { receiptRows } from '../rentals/rent-receipt.js';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx';
const charge = (month, over = {}) => ({
    id: `L1_${month}`, leaseId: 'L1', unitId: 'U1', propertyId: 'P1', tenantId: 'T1', tenantName: 'Ram', unitLabel: '2B',
    month, dueDay: 10, rent: 5000, electricity: null, amount: 5000, paid: 0, open: true, payments: [], ...over
});
const lease = (over = {}) => ({ id: 'L1', unitId: 'U1', propertyId: 'P1', tenantId: 'T1', status: 'active', rent: 5000, dueDay: 10, startMonth: '2026-01', chargedThrough: '2026-10', ...over });
const pay = (id, amount) => store.recordPayment(id, { amount, mode: 'cash', ref: '', date: '2026-10-05' });

describe('RENT-16 math', () => {
    test('more than due: the month is paid off, the rest is advance (only when allowed)', () => {
        const c = charge('2026-10', { paid: 1000 });
        expect(() => applyPayment(c, 6000)).toThrow('over');
        expect(applyPayment(c, 6000, true)).toEqual({ amount: 4000, paid: 5000, open: false, adv: 2000, carried: 2000 });
        expect(applyPayment({ ...c, adv: 500 }, 4500, true)).toMatchObject({ adv: 500, carried: 1000 });
        expect(applyPayment(c, 3000, true)).toEqual({ amount: 3000, paid: 4000, open: true });
        // Whole rupees typed; a due with paise is paid off exactly and the advance keeps the paise.
        expect(applyPayment(charge('2026-10', { amount: 5000.5 }), 6000.4, true)).toMatchObject({ amount: 5000.5, adv: 999.5 });
        expect(() => applyPayment(charge('2026-10', { paid: 5000 }), 100, true)).toThrow('over');
    });

    test('a new month starts paid from the advance; more than its amount carries on', () => {
        const e = { ref: '', date: '2026-11-01', at: 1, by: 'u1', byName: 'H' };
        const n = charge('2026-11');
        expect(withAdvance(n, 0, e)).toBe(n);
        expect(withAdvance(n, 2000, e)).toMatchObject({ paid: 2000, open: true, payments: [{ amount: 2000, mode: 'advance', by: 'u1' }] });
        expect(withAdvance(n, 2000, e)).not.toHaveProperty('adv');
        expect(withAdvance(n, 7000, e)).toMatchObject({ paid: 5000, open: false, adv: 2000, payments: [{ amount: 5000, mode: 'advance' }] });
        expect(withAdvance({ ...n, amount: 0, rent: 0, open: false }, 700, e)).toMatchObject({ paid: 0, payments: [], adv: 700 });
    });

    test('receipt: paid for the month, the advance and the total received (RENT-12)', () => {
        const r = receiptAmounts(charge('2026-10', { paid: 5000 }), { amount: 5000, adv: 2000 });
        expect(r).toMatchObject({ paid: 5000, adv: 2000, balance: 0 });
        expect(receiptReceived(r)).toBe(7000);
        expect(receiptAmounts(charge('2026-10'), { amount: 100 })).not.toHaveProperty('adv');
        const rows = receiptRows({ ...r, months: ['2026-10'], mode: 'cash' }, 'en').map(([k, v]) => `${k}: ${v}`);
        expect(rows).toEqual(expect.arrayContaining(['Paid now: ₹5,000', 'Advance for next month: ₹2,000', 'Total received: ₹7,000']));
        expect(receiptRows({ ...r, adv: undefined, months: ['2026-10'], mode: 'cash' }, 'en').map(([k]) => k)).not.toContain('Advance for next month');
    });
});

describe('RENT-5 / RENT-16: an overpayment pays the oldest unpaid months first', () => {
    const open = [charge('2026-08', { paid: 4000 }), charge('2026-09'), charge('2026-10')];
    test('oldest first; only what is left after every unpaid month is the latest month\'s advance', () => {
        expect(payOldestFirst(open, 7000, '2026-10')).toEqual([
            { id: 'L1_2026-08', month: '2026-08', amount: 1000 }, { id: 'L1_2026-09', month: '2026-09', amount: 5000 }, { id: 'L1_2026-10', month: '2026-10', amount: 1000 }]);
        const p = payOldestFirst(open, 13000, '2026-10');
        expect(p[2]).toEqual({ id: 'L1_2026-10', month: '2026-10', amount: 5000, adv: 2000 });
        expect(p.map(payAmount)).toEqual([1000, 5000, 7000]);
        // Not the active lease's latest month (moved out, or it is already paid): nothing may be left over.
        expect(() => payOldestFirst(open, 13000, '2026-11')).toThrow('over');
        expect(() => payOldestFirst(open, 13000, undefined)).toThrow('over');
        expect(payOldestFirst(open, 11000, undefined)).toHaveLength(3);
        expect(() => payOldestFirst(open, 0, '2026-10')).toThrow('amount');
        const paise = [charge('2026-09', { amount: 1234.5 }), charge('2026-10')];
        // An old due with paise is paid off exactly and the parts still add up to the typed amount (paid exactly).
        expect(payOldestFirst(paise, 6235, '2026-10').map(payAmount)).toEqual([1234.5, 5000.5]);
        expect(payOldestFirst(paise, 3000, '2026-10').map(payAmount)).toEqual([1234.5, 1765.5]);
        // Exactly the total due with paise: nothing left over, also without a latest month.
        expect(payOldestFirst(paise, 6234.5, '2026-10')).toEqual([{ id: 'L1_2026-09', month: '2026-09', amount: 1234.5 }, { id: 'L1_2026-10', month: '2026-10', amount: 5000 }]);
        expect(payOldestFirst(paise, 6234.5, undefined).map(payAmount)).toEqual([1234.5, 5000]);
        const p2 = payOldestFirst(paise, 10000, '2026-10');
        expect(applyPayment(paise[1], payAmount(p2[1]), true, true)).toMatchObject({ amount: 5000, adv: 3765.5 });
    });

    test('a change of unit: the advance the old lease leaves (last month, plus one later month given back)', () => {
        const cs = [charge('2026-09', { adv: 0 }), charge('2026-10', { adv: 1500 }),
            charge('2026-11', { paid: 2000, payments: [{ amount: 2000, mode: 'advance' }], adv: 500 })];
        expect(advanceLeft(cs, 'L1', '2026-11')).toBe(500);
        expect(advanceLeft(cs, 'L1', '2026-10')).toBe(4000);
        expect(advanceLeft(cs, 'L9', '2026-10')).toBe(0);
    });
});

describe('advance in the store', () => {
    beforeEach(() => {
        global.__fakeDb = fake.db;
        ['rent_deposits', 'rent_charges', 'rent_leases', 'rent_public', 'rent_receipts', 'rent_counters'].forEach(c => fake.raw(c).clear());
        AppState.currentUser = { uid: 'u1' };
        AppState.userName = 'Hitesh';
    });

    test('overpaying the latest month carries the rest; an older month refuses more than due', async () => {
        fake.seed('rent_leases', [lease()]);
        fake.seed('rent_charges', [charge('2026-09'), charge('2026-10')]);
        await expect(pay('L1_2026-09', 6000)).rejects.toThrow('over');
        expect(await pay('L1_2026-10', 7000)).toMatchObject({ amount: 5000, adv: 2000 });
        const ch = fake.raw('rent_charges').get('L1_2026-10');
        expect(ch).toMatchObject({ paid: 5000, open: false, adv: 2000 });
        expect(ch.payments[0]).toMatchObject({ amount: 5000, adv: 2000, mode: 'cash' });
    });

    test('a receipt issued with an overpayment carries the advance', async () => {
        fake.seed('rent_leases', [lease()]);
        fake.seed('rent_charges', [charge('2026-10')]);
        const res = await store.recordPayment('L1_2026-10', { amount: 7000, mode: 'upi', ref: '', date: '2026-10-05' }, { place: '2B', ut: 'flat' });
        expect(res.receipt).toMatchObject({ paid: 5000, adv: 2000, balance: 0, total: 5000 });
    });

    test('the next month is created paid from the advance and the month before cleared; the tenant link shows both', async () => {
        fake.seed('rent_leases', [lease({ shareToken: TOKEN })]);
        fake.seed('rent_public', [{ id: TOKEN, lid: 'L1', v: 1, months: [] }]);
        fake.seed('rent_charges', [charge('2026-10', { paid: 5000, open: false, adv: 7000, payments: [{ amount: 5000, adv: 7000 }] })]);
        expect(await store.chargeLease('L1', '2026-12', { tenantName: 'Ram', unitLabel: '2B' })).toBe(2);
        const ch = (m) => fake.raw('rent_charges').get(`L1_${m}`);
        expect(ch('2026-10').adv).toBe(0);
        expect(ch('2026-11')).toMatchObject({ paid: 5000, open: false, adv: 0, payments: [{ amount: 5000, mode: 'advance', by: 'u1' }] });
        expect(ch('2026-12')).toMatchObject({ paid: 2000, open: true, payments: [{ amount: 2000, mode: 'advance' }] });
        expect(ch('2026-12')).not.toHaveProperty('adv');
        const months = fake.raw('rent_public').get(TOKEN).months;
        expect(months.map(x => [x.m, x.paid, x.adv || 0])).toEqual([['2026-10', 5000, 0], ['2026-11', 5000, 0], ['2026-12', 2000, 0]]);
    });

    test('an advance left when the lease ended goes into the deposit ledger (once); not while it is active', async () => {
        fake.seed('rent_leases', [lease()]);
        fake.seed('rent_charges', [charge('2026-10', { paid: 5000, open: false, adv: 2000 })]);
        expect(await ds.advanceToDeposit('L1_2026-10')).toBe(0);
        fake.seed('rent_leases', [lease({ status: 'ended', endMonth: '2026-10' })]);
        expect(await ds.advanceToDeposit('L1_2026-10')).toBe(2000);
        expect(fake.raw('rent_charges').get('L1_2026-10').adv).toBe(0);
        const dep = fake.raw('rent_deposits').get('T1');
        expect(dep).toMatchObject({ held: 2000, tenantName: 'Ram' });
        expect(dep.entries[0]).toMatchObject({ kind: 'received', amount: 2000, mode: 'advance', chargeId: 'L1_2026-10', month: '2026-10', leaseId: 'L1' });
        expect(await ds.advanceToDeposit('L1_2026-10')).toBe(0);
        expect((await ds.advancesLeft()).length).toBe(0);
    });

    test('a move-out before a month paid only from the advance takes it back, then it goes into the deposit', async () => {
        fake.seed('rent_units', [{ id: 'U1', propertyId: 'P1', label: '2B', leaseId: 'L1' }]);
        fake.seed('rent_leases', [lease({ chargedThrough: '2026-11' })]);
        fake.seed('rent_charges', [charge('2026-10', { paid: 5000, open: false }),
            charge('2026-11', { paid: 2000, payments: [{ amount: 2000, mode: 'advance' }], adv: 0 })]);
        await store.endLease('L1', '2026-10', '2026-11');
        expect(fake.raw('rent_charges').get('L1_2026-11')).toBeUndefined();
        expect(fake.raw('rent_charges').get('L1_2026-10').adv).toBe(2000);
        expect(await ds.advanceToDeposit('', 'L1')).toBe(2000);
        expect(fake.raw('rent_deposits').get('T1').held).toBe(2000);
        // A later month with a cash payment still stops it.
        fake.seed('rent_leases', [lease({ id: 'L2', chargedThrough: '2026-11' })]);
        fake.seed('rent_charges', [charge('2026-10', { id: 'L2_2026-10', leaseId: 'L2' }),
            charge('2026-11', { id: 'L2_2026-11', leaseId: 'L2', paid: 3000, payments: [{ amount: 2000, mode: 'advance' }, { amount: 1000, mode: 'cash' }] })]);
        await expect(store.endLease('L2', '2026-10', '2026-11')).rejects.toThrow('later_paid');
    });

    test('a change of unit: the new lease\'s first month is paid from the old lease\'s advance', async () => {
        fake.seed('rent_leases', [lease({ status: 'ended', endMonth: '2026-10', chargedThrough: '2026-10', movedTo: 'L2' }),
            lease({ id: 'L2', unitId: 'U2', startMonth: '2026-10', startDate: '2026-10-16', proRate: true, firstRent: 3097, rent: 6000, chargedThrough: null, fromLeaseId: 'L1' })]);
        fake.seed('rent_charges', [charge('2026-10', { rent: 2903, amount: 2903, paid: 2903, open: false, adv: 2000 })]);
        expect(await store.chargeLease('L2', '2026-11', { tenantName: 'Ram', unitLabel: 'G2' })).toBe(2);
        expect(fake.raw('rent_charges').get('L1_2026-10').adv).toBe(0);
        expect(fake.raw('rent_charges').get('L2_2026-10')).toMatchObject({ amount: 3097, paid: 2000, open: true, payments: [{ amount: 2000, mode: 'advance' }] });
        expect(fake.raw('rent_charges').get('L2_2026-11')).toMatchObject({ paid: 0, payments: [] });
    });
});
