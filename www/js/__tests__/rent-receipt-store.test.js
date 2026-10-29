/**
 * Rent receipts (RENT-12) in the store, on the in-memory Firestore with
 * optimistic transactions: one receipt per payment with the next number of the
 * year, the right amounts, unique numbers when people pay at once, a payment
 * still saved when the receipt is refused, and cancel (void).
 */
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

const fake = createFakeFirestore({ occ: true });
jest.mock('../firebase/firestore-service.js', () => ({ FirebaseService: { get db() { return global.__fakeDb; } } }));
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
const RC = { tenantName: 'Ram Kumar', place: '2B, Gupta Bhawan', ut: 'flat', biz: 'Sharma Rentals', bizAddr: 'Main Road, Kanpur' };
const pay = (id, amount, mode = 'cash') => store.recordPayment(id, { amount, mode, ref: '', date: '2026-10-05' }, RC);

beforeEach(() => {
    global.__fakeDb = fake.db;
    ['rent_charges', 'rent_receipts', 'rent_counters', 'rent_leases', 'rent_public'].forEach(c => fake.raw(c).clear());
    AppState.currentUser = { uid: 'u1' };
    AppState.userName = 'Hitesh';
    fake.seed('rent_leases', [{ id: 'L1', unitId: 'U1', tenantId: 'T1', status: 'active', rent: 5000, dueDay: 10, startMonth: '2026-01' }]);
});

test('a part payment issues R-YYYY-0001 with the month, rent, total, paid now, mode and balance; the next one 0002', async () => {
    fake.seed('rent_charges', [charge('L1_2026-10')]);
    const a = await pay('L1_2026-10', 2000);
    expect(a.receipt).toMatchObject({
        id: 'L1_2026-10_0', no: no(1), year: YEAR, seq: 1, chargeId: 'L1_2026-10', pi: 0, leaseId: 'L1', tenantId: 'T1',
        tenantName: 'Ram Kumar', place: '2B, Gupta Bhawan', ut: 'flat', months: ['2026-10'], rent: 5000, elec: null,
        total: 5000, paid: 2000, mode: 'cash', date: '2026-10-05', balance: 3000, by: 'u1', byName: 'Hitesh',
        biz: 'Sharma Rentals', bizAddr: 'Main Road, Kanpur', void: false
    });
    expect(fake.raw('rent_receipts').get('L1_2026-10_0').no).toBe(no(1));
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

test('when the receipt is refused the payment is still saved, without a number', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    fake.seed('rent_charges', [charge('L1_2026-10')]);
    let receiptTries = 0;
    global.__fakeDb = {
        ...fake.db,
        runTransaction: (fn) => fake.db.runTransaction(async (tx) => {
            let withReceipt = false;
            const out = await fn({ ...tx, set: (ref, d, o) => { if (ref.path.startsWith('rent_receipts/')) withReceipt = true; return tx.set(ref, d, o); } });
            if (withReceipt) {
                receiptTries++;
                throw Object.assign(new Error('denied'), { code: 'permission-denied' });
            }
            return out;
        })
    };
    const res = await pay('L1_2026-10', 2000);
    expect(res).toMatchObject({ amount: 2000, paid: 2000, receipt: null });
    expect(receiptTries).toBe(3);
    expect(fake.raw('rent_charges').get('L1_2026-10').payments).toEqual([expect.not.objectContaining({ rno: expect.anything() })]);
    expect(fake.raw('rent_receipts').size).toBe(0);
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

test('a tenant\'s receipts, newest first, only theirs', async () => {
    fake.seed('rent_receipts', [
        { id: 'a', tenantId: 'T1', no: no(1), createdAt: 1 },
        { id: 'b', tenantId: 'T2', no: no(2), createdAt: 2 },
        { id: 'c', tenantId: 'T1', no: no(3), createdAt: 3 }
    ]);
    expect((await store.listReceipts('T1')).map(r => r.no)).toEqual([no(3), no(1)]);
});
