/**
 * Rent receipts (RENT-12) in the store, on the in-memory Firestore with
 * optimistic transactions: one receipt per payment with the next number of the
 * year, the right amounts, unique numbers when people pay at once, a payment
 * still saved when the receipt is refused, and cancel (void).
 */
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

const fake = createFakeFirestore({ occ: true });
jest.mock('../firebase/firestore-service.js', () => ({ FirebaseService: { get db() { return global.__fakeDb; }, serverTimestamp: () => 'SERVER_TIME' } }));
global.__fakeDb = fake.db;

import { AppState } from '../utils/state.js';
import * as store from '../rentals/rent-store.js';
import { istYear, receiptNo } from '../rentals/rent-math.js';

const YEAR = istYear();
const no = (n) => receiptNo(YEAR, n);
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx';
const charge = (id, over = {}) => ({
    id, leaseId: 'L1', unitId: 'U1', propertyId: 'P1', tenantId: 'T1', tenantName: 'Ram', unitLabel: '2B',
    month: id.split('_')[1], dueDay: 10, rent: 5000, electricity: null, amount: 5000, paid: 0, open: true, payments: [], ...over
});
const RC = { place: '2B, Gupta Bhawan', ut: 'flat', shopName: 'Gupta Aadhat' };
const pay = (id, amount, mode = 'cash') => store.recordPayment(id, { amount, mode, ref: '', date: '2026-10-05' }, RC);

beforeEach(() => {
    global.__fakeDb = fake.db;
    ['rent_charges', 'rent_receipts', 'rent_counters', 'rent_leases', 'rent_public', 'rent_settings'].forEach(c => fake.raw(c).clear());
    AppState.currentUser = { uid: 'u1' };
    AppState.userName = 'Hitesh';
    fake.seed('rent_leases', [{ id: 'L1', unitId: 'U1', tenantId: 'T1', status: 'active', rent: 5000, dueDay: 10, startMonth: '2026-01' }]);
    fake.seed('rent_settings', [{ id: 'default', receiptHeader: 'Sharma Rentals', receiptAddress: 'Main Road, Kanpur' }]);
});

test('a part payment issues R-YYYY-0001 with the month, rent, total, paid now, mode and balance; the next one 0002', async () => {
    fake.seed('rent_charges', [charge('L1_2026-10')]);
    const a = await pay('L1_2026-10', 2000);
    expect(a.receipt).toMatchObject({
        id: 'L1_2026-10_0', no: no(1), year: YEAR, seq: 1, chargeId: 'L1_2026-10', pi: 0, leaseId: 'L1', tenantId: 'T1',
        tenantName: 'Ram', place: '2B, Gupta Bhawan', ut: 'flat', months: ['2026-10'], rent: 5000, elec: null,
        total: 5000, paid: 2000, mode: 'cash', date: '2026-10-05', balance: 3000, by: 'u1', byName: 'Hitesh',
        biz: 'Sharma Rentals', bizAddr: 'Main Road, Kanpur', void: false
    });
    expect(a.receipt.createdAt).toEqual(expect.any(Number));
    expect(a.receiptRefused).toBeUndefined();
    expect(fake.raw('rent_receipts').get('L1_2026-10_0').no).toBe(no(1));
    expect(fake.raw('rent_receipts').get('L1_2026-10_0').createdAt).toBe('SERVER_TIME');
    expect(fake.raw('rent_charges').get('L1_2026-10').payments[0]).toMatchObject({ amount: 2000, rno: no(1), by: 'u1' });
    expect(fake.raw('rent_counters').get(`receipts_${YEAR}`)).toMatchObject({ last: 1, rid: 'L1_2026-10_0' });

    const b = await pay('L1_2026-10', 3000, 'upi');
    expect(b.receipt).toMatchObject({ no: no(2), pi: 1, paid: 3000, mode: 'upi', total: 5000, balance: 0 });
    expect(fake.raw('rent_counters').get(`receipts_${YEAR}`)).toMatchObject({ last: 2, rid: 'L1_2026-10_1' });
});

test('a meter-billed month carries its reading, units, rate and amount; other months have no electricity', async () => {
    const e = { prev: 100, curr: 150, rate: 8, units: 50, amount: 400 };
    fake.seed('rent_charges', [charge('L1_2026-10', { electricity: e, amount: 5400 }), charge('L1_2026-09')]);
    expect((await pay('L1_2026-10', 5400)).receipt).toMatchObject({ elec: e, rent: 5000, total: 5400, balance: 0 });
    expect((await pay('L1_2026-09', 5000)).receipt).toMatchObject({ elec: null, total: 5000 });
});

test('numbers stay unique when several people pay at the same moment (transactions retry)', async () => {
    const ids = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].map(m => `L1_${m}`);
    fake.seed('rent_charges', ids.map(id => charge(id)));
    const before = fake.stats.retries || 0;
    const res = await Promise.all(ids.map(id => pay(id, 1000)));
    const nos = res.map(r => r.receipt.no).sort();
    expect(nos).toEqual([1, 2, 3, 4, 5].map(no));
    expect(fake.raw('rent_counters').get(`receipts_${YEAR}`).last).toBe(5);
    expect([...fake.raw('rent_receipts').values()].map(r => r.no).sort()).toEqual(nos);
    expect((fake.stats.retries || 0) - before).toBeGreaterThan(0);
});

test('without Settings › Rentals the shared business name heads the receipt, with no address', async () => {
    fake.raw('rent_settings').clear();
    fake.seed('rent_charges', [charge('L1_2026-10')]);
    expect((await pay('L1_2026-10', 2000)).receipt).toMatchObject({ biz: 'Gupta Aadhat', bizAddr: '' });
    fake.seed('rent_charges', [charge('L1_2026-09')]);
    const r = await store.recordPayment('L1_2026-09', { amount: 1000, mode: 'cash', ref: '', date: '2026-10-05' }, { ...RC, shopName: '' });
    expect(r.receipt).toMatchObject({ biz: '', bizAddr: '' });
});

// A transaction with a receipt fails `fails` times with `code`, then works.
function failReceipts(code, fails = Infinity) {
    let tries = 0;
    global.__fakeDb = {
        ...fake.db,
        runTransaction: (fn) => fake.db.runTransaction(async (tx) => {
            let withReceipt = false;
            const out = await fn({ ...tx, set: (ref, d, o) => { if (ref.path.startsWith('rent_receipts/')) withReceipt = true; return tx.set(ref, d, o); } });
            if (withReceipt && tries++ < fails) throw Object.assign(new Error(code), { code });
            return out;
        })
    };
    return () => tries;
}

test('a refused receipt (permission-denied) is not retried: the payment is saved once without a number and flagged', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    fake.seed('rent_charges', [charge('L1_2026-10')]);
    const tries = failReceipts('permission-denied');
    const res = await pay('L1_2026-10', 2000);
    expect(res).toMatchObject({ amount: 2000, paid: 2000, receipt: null, receiptRefused: 'permission-denied' });
    expect(tries()).toBe(1);
    expect(fake.raw('rent_charges').get('L1_2026-10').payments).toEqual([expect.not.objectContaining({ rno: expect.anything() })]);
    expect(fake.raw('rent_receipts').size).toBe(0);
});

test('aborted / failed-precondition: one more try with the receipt, then the error (nothing saved)', async () => {
    fake.seed('rent_charges', [charge('L1_2026-10')]);
    let tries = failReceipts('aborted', 1);
    expect((await pay('L1_2026-10', 2000)).receipt).toMatchObject({ no: no(1) });
    expect(tries()).toBe(2);

    fake.seed('rent_charges', [charge('L1_2026-09')]);
    tries = failReceipts('failed-precondition');
    await expect(pay('L1_2026-09', 1000)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(tries()).toBe(2);
    expect(fake.raw('rent_charges').get('L1_2026-09').payments).toEqual([]);
});

test('other errors are not retried (more than is due)', async () => {
    fake.seed('rent_charges', [charge('L1_2026-10')]);
    await expect(pay('L1_2026-10', 6000)).rejects.toThrow('over');
    expect(fake.raw('rent_counters').size).toBe(0);
});

test('the tenant link shows the receipt number; cancelling drops it and marks the receipt and the charge', async () => {
    fake.seed('rent_leases', [{ id: 'L1', unitId: 'U1', tenantId: 'T1', status: 'active', rent: 5000, dueDay: 10, startMonth: '2026-01', shareToken: TOKEN }]);
    fake.seed('rent_public', [{ id: TOKEN, lid: 'L1', v: 1, months: [] }]);
    fake.seed('rent_charges', [charge('L1_2026-10')]);
    await pay('L1_2026-10', 2000);
    expect(fake.raw('rent_public').get(TOKEN).months[0].py).toEqual([{ d: '2026-10-05', a: 2000, r: no(1) }]);

    AppState.currentUser = { uid: 'boss' };
    AppState.userName = 'Owner';
    expect(await store.voidReceipt('L1_2026-10_0', 'wrong month')).toBe(true);
    expect(fake.raw('rent_receipts').get('L1_2026-10_0')).toMatchObject({
        no: no(1), paid: 2000, void: true, voidBy: 'boss', voidByName: 'Owner', voidReason: 'wrong month'
    });
    expect(fake.raw('rent_charges').get('L1_2026-10')).toMatchObject({ voided: [0], paid: 2000 });
    expect(fake.raw('rent_public').get(TOKEN).months[0].py).toEqual([{ d: '2026-10-05', a: 2000 }]);
    expect(await store.voidReceipt('L1_2026-10_0', 'again')).toBe(false);
});

test('a tenant\'s receipts, newest first, only theirs (server Timestamps, older numbers, one still being written)', async () => {
    const ts = (ms) => ({ seconds: Math.floor(ms / 1000), nanoseconds: 0, toDate: () => new Date(ms) });
    fake.seed('rent_receipts', [
        { id: 'a', tenantId: 'T1', no: no(1), createdAt: 1000 },
        { id: 'b', tenantId: 'T2', no: no(2), createdAt: ts(2000) },
        { id: 'c', tenantId: 'T1', no: no(3), createdAt: ts(3000) },
        { id: 'd', tenantId: 'T1', no: no(4), createdAt: ts(5000) }
    ]);
    expect((await store.listReceipts('T1')).map(r => r.no)).toEqual([no(4), no(3), no(1)]);
    fake.seed('rent_receipts', [{ id: 'e', tenantId: 'T1', no: no(5), createdAt: null }]);
    expect((await store.listReceipts('T1')).map(r => r.no)).toEqual([no(5), no(4), no(3), no(1)]);
});
