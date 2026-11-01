/**
 * Security deposit ledger (#157, RENT-14 / RENT-15): the math in rent-math.js and
 * the store on the in-memory Firestore (optimistic transactions): received /
 * refund entries, an adjustment that pays a month from the deposit in the same
 * write (no receipt), never above what is held or due, the owner's edits, and the
 * balance on the tenant link.
 */
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

const fake = createFakeFirestore({ occ: true });
jest.mock('../firebase/firestore-service.js', () => ({ FirebaseService: { get db() { return global.__fakeDb; }, serverTimestamp: () => 'SERVER_TIME' } }));
global.__fakeDb = fake.db;

import { AppState } from '../utils/state.js';
import * as ds from '../rentals/rent-deposit-store.js';
import { depositHeld, depositEntry, depositFill, depositsTotal, MAX_DEPOSIT_ENTRIES } from '../rentals/rent-math.js';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx';
const charge = (id, over = {}) => ({
    leaseId: 'L1', unitId: 'U1', propertyId: 'P1', tenantId: 'T1', tenantName: 'Ram', unitLabel: '2B',
    month: id.split('_')[1], dueDay: 10, rent: 5000, electricity: null, amount: 5000, paid: 0, open: true, payments: [], ...over
});
const add = (p) => ds.addDepositEntry({ tenantId: 'T1', tenantName: 'Ram', leaseId: 'L1', date: '2026-10-05', ...p });
const e = (kind, amount) => ({ kind, amount });

describe('RENT-14 / RENT-15 math', () => {
    test('held = received − adjusted − refunded; the total adds the ledgers', () => {
        expect(depositHeld([])).toBe(0);
        expect(depositHeld([e('received', 10000), e('adjust', 2500), e('refund', 4000), e('received', 1000)])).toBe(4500);
        expect(depositsTotal([{ held: 4500 }, { held: 3000 }, { held: 0.5 }])).toBe(7500.5);
    });

    test('a new entry: whole rupees, never above what is held (refund) or held and due (adjust)', () => {
        expect(depositEntry([], 'received', 9999.6)).toEqual({ amount: 10000, held: 10000 });
        const l = [e('received', 10000)];
        expect(depositEntry(l, 'refund', 4000)).toEqual({ amount: 4000, held: 6000 });
        expect(() => depositEntry(l, 'refund', 10001)).toThrow('over');
        expect(depositEntry(l, 'adjust', 3000, 5000)).toEqual({ amount: 3000, held: 7000 });
        expect(() => depositEntry(l, 'adjust', 6000, 5000)).toThrow('over');
        expect(() => depositEntry([e('received', 2000)], 'adjust', 3000, 5000)).toThrow('over');
        // Exactly an old due with paise is paid off as it is (RENT-5).
        expect(depositEntry(l, 'adjust', 2500.5, 2500.5)).toEqual({ amount: 2500.5, held: 7499.5 });
        expect(() => depositEntry(l, 'received', 0)).toThrow('amount');
        expect(() => depositEntry(l, 'gift', 100)).toThrow('amount');
        expect(() => depositEntry(Array(MAX_DEPOSIT_ENTRIES).fill(e('received', 1)), 'received', 1)).toThrow('too_many');
    });

    test('filled in: the agreed deposit while nothing is held, all held for a refund, min(held, due) to adjust', () => {
        expect(depositFill('received', 0, 0, 15000)).toBe(15000);
        expect(depositFill('received', 5000, 0, 15000)).toBe('');
        expect(depositFill('refund', 7000)).toBe(7000);
        expect(depositFill('adjust', 7000, 5000)).toBe(5000);
        expect(depositFill('adjust', 3000, 5000)).toBe(3000);
    });
});

describe('deposit store', () => {
    beforeEach(() => {
        global.__fakeDb = fake.db;
        ['rent_deposits', 'rent_charges', 'rent_leases', 'rent_public'].forEach(c => fake.raw(c).clear());
        AppState.currentUser = { uid: 'u1' };
        AppState.userName = 'Hitesh';
        fake.seed('rent_leases', [{ id: 'L1', unitId: 'U1', tenantId: 'T1', status: 'active', rent: 5000, dueDay: 10, startMonth: '2026-01' }]);
    });

    test('received creates the ledger, refund reduces it; each entry is signed by the writer', async () => {
        expect(await ds.loadDeposit('T1')).toBeNull();
        expect(await add({ kind: 'received', amount: 10000, mode: 'upi', note: 'At move-in' })).toEqual({ amount: 10000, held: 10000 });
        expect(await add({ kind: 'refund', amount: 4000, mode: 'cash' })).toEqual({ amount: 4000, held: 6000 });
        const doc = fake.raw('rent_deposits').get('T1');
        expect(doc).toMatchObject({ tenantId: 'T1', tenantName: 'Ram', held: 6000, createdBy: 'u1', updatedBy: 'u1' });
        expect(doc.entries).toEqual([
            expect.objectContaining({ kind: 'received', amount: 10000, mode: 'upi', note: 'At move-in', by: 'u1', byName: 'Hitesh', leaseId: 'L1', date: '2026-10-05' }),
            expect.objectContaining({ kind: 'refund', amount: 4000, mode: 'cash' })
        ]);
        await expect(add({ kind: 'refund', amount: 6001 })).rejects.toThrow('over');
        expect((await ds.depositsHeld()).map(l => [l.tenantId, l.held])).toEqual([['T1', 6000]]);
    });

    test('an adjustment pays the month from the deposit in the same write (mode deposit, no receipt)', async () => {
        fake.seed('rent_charges', [{ id: 'L1_2026-10', ...charge('L1_2026-10', { paid: 1000, payments: [{ amount: 1000, mode: 'cash' }] }) }]);
        await add({ kind: 'received', amount: 10000 });
        await expect(add({ kind: 'adjust', amount: 4001, chargeId: 'L1_2026-10' })).rejects.toThrow('over');
        expect(await add({ kind: 'adjust', amount: 4000, chargeId: 'L1_2026-10' })).toEqual({ amount: 4000, held: 6000 });
        const ch = fake.raw('rent_charges').get('L1_2026-10');
        expect(ch).toMatchObject({ paid: 5000, open: false, updatedBy: 'u1' });
        expect(ch.payments[1]).toEqual(expect.objectContaining({ amount: 4000, mode: 'deposit', ref: '', by: 'u1' }));
        expect(ch.payments[1]).not.toHaveProperty('rno');
        expect(fake.raw('rent_deposits').get('T1').entries[1]).toMatchObject({ kind: 'adjust', amount: 4000, chargeId: 'L1_2026-10', month: '2026-10' });
        expect(fake.raw('rent_deposits').get('T1').entries[1]).not.toHaveProperty('mode');
        await expect(add({ kind: 'adjust', amount: 100, chargeId: 'L1_2026-09' })).rejects.toThrow('missing');
    });

    test('the tenant link shows the balance, written with the entry', async () => {
        fake.seed('rent_leases', [{ id: 'L1', unitId: 'U1', tenantId: 'T1', status: 'active', rent: 5000, dueDay: 10, startMonth: '2026-01', shareToken: TOKEN }]);
        fake.seed('rent_public', [{ id: TOKEN, lid: 'L1', v: 1, months: [] }]);
        fake.seed('rent_charges', [{ id: 'L1_2026-10', ...charge('L1_2026-10') }]);
        await add({ kind: 'received', amount: 8000 });
        expect(fake.raw('rent_public').get(TOKEN).dep).toBe(8000);
        await add({ kind: 'adjust', amount: 5000, chargeId: 'L1_2026-10' });
        const pub = fake.raw('rent_public').get(TOKEN);
        expect(pub.dep).toBe(3000);
        expect(pub.months).toEqual([expect.objectContaining({ m: '2026-10', paid: 5000, due: 0 })]);
    });

    test('owner: an entry edited or removed, held follows; never below 0', async () => {
        await add({ kind: 'received', amount: 10000 });
        await add({ kind: 'refund', amount: 4000 });
        const entries = fake.raw('rent_deposits').get('T1').entries;
        expect(await ds.setDepositEntries({ tenantId: 'T1', entries: [{ ...entries[0], amount: 9000 }, entries[1]] })).toBe(5000);
        await expect(ds.setDepositEntries({ tenantId: 'T1', entries: [entries[1]] })).rejects.toThrow('over');
        expect(fake.raw('rent_deposits').get('T1').held).toBe(5000);
    });
});
