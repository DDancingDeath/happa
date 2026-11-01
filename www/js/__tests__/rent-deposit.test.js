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
import { depositHeld, depositEntry, depositFill, depositsTotal, MAX_DEPOSIT_ENTRIES } from '../rentals/rent-math-ledger.js';

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
        // Exactly an old due with paise is paid off as it is (RENT-5), the same amount applyPayment takes;
        // a held with paise is refunded exactly, and adjusting it against a larger due is whole rupees.
        expect(depositEntry(l, 'adjust', 2500.5, 2500.5)).toEqual({ amount: 2500.5, held: 7499.5 });
        const paise = [e('received', 10000), e('adjust', 2500.5)];
        expect(() => depositEntry(paise, 'adjust', 7499.5, 10000)).toThrow('over');
        expect(depositEntry(paise, 'adjust', 7499, 10000)).toEqual({ amount: 7499, held: 0.5 });
        expect(depositEntry(paise, 'refund', 7499.5)).toEqual({ amount: 7499.5, held: 0 });
        expect(depositEntry([e('received', 1), e('adjust', 0.5)], 'refund', 0.5)).toEqual({ amount: 0.5, held: 0 });
        expect(depositEntry(l, 'received', 50000)).toEqual({ amount: 50000, held: 60000 });
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
        expect(depositFill('adjust', 7499.5, 10000)).toBe(7499);
        expect(depositFill('adjust', 7499.5, 2500.5)).toBe(2500.5);
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

    test('owner: an entry edited or removed, held follows; never below 0; an entry added meanwhile is kept', async () => {
        await add({ kind: 'received', amount: 10000 });
        const [r1] = fake.raw('rent_deposits').get('T1').entries;
        await add({ kind: 'refund', amount: 4000 });
        // The owner's dialog was opened before the refund: the refund stays.
        expect(await ds.changeDepositEntry({ tenantId: 'T1', entry: r1, fields: { amount: 9000 } })).toBe(5000);
        const doc = fake.raw('rent_deposits').get('T1');
        expect(doc.entries.map(x => [x.kind, x.amount])).toEqual([['received', 9000], ['refund', 4000]]);
        await expect(ds.changeDepositEntry({ tenantId: 'T1', entry: { ...r1, amount: 9000 } })).rejects.toThrow('over');
        await expect(ds.changeDepositEntry({ tenantId: 'T1', entry: r1 })).rejects.toThrow('changed');
        expect(fake.raw('rent_deposits').get('T1').held).toBe(5000);
    });

    test('an adjustment never changes an adjustment; the owner may not edit one', async () => {
        fake.seed('rent_charges', [{ id: 'L1_2026-10', ...charge('L1_2026-10') }]);
        await add({ kind: 'received', amount: 10000 });
        await add({ kind: 'adjust', amount: 5000, chargeId: 'L1_2026-10' });
        const adj = fake.raw('rent_deposits').get('T1').entries[1];
        await expect(ds.changeDepositEntry({ tenantId: 'T1', entry: adj })).rejects.toThrow('changed');
    });

    test('after a change of unit: adjusting an old-unit month updates its tagged row on the moved link, not the new unit\'s', async () => {
        fake.seed('rent_leases', [
            { id: 'L1', unitId: 'U1', tenantId: 'T1', status: 'ended', rent: 5000, dueDay: 10, startMonth: '2026-01', endMonth: '2026-10', movedTo: 'L2', shareToken: null },
            { id: 'L2', unitId: 'U2', tenantId: 'T1', status: 'active', rent: 6000, dueDay: 10, startMonth: '2026-10', fromLeaseId: 'L1', shareToken: TOKEN }
        ]);
        const newRow = { m: '2026-10', rent: 3000, elec: 0, units: 0, total: 3000, paid: 0, due: 3000, st: 'due', pd: [] };
        const oldRow = { m: '2026-10', rent: 2500, elec: 0, units: 0, total: 2500, paid: 0, due: 2500, st: 'due', pd: [], pl: '1A' };
        fake.seed('rent_public', [{ id: TOKEN, lid: 'L2', v: 1, months: [oldRow, newRow] }]);
        fake.seed('rent_charges', [{ id: 'L1_2026-10', ...charge('L1_2026-10', { rent: 2500, amount: 2500 }) }]);
        await ds.addDepositEntry({ tenantId: 'T1', tenantName: 'Ram', leaseId: 'L2', date: '2026-10-20', kind: 'received', amount: 8000 });
        await ds.addDepositEntry({ tenantId: 'T1', tenantName: 'Ram', leaseId: 'L2', date: '2026-10-20', kind: 'adjust', amount: 2500, chargeId: 'L1_2026-10' });
        const pub = fake.raw('rent_public').get(TOKEN);
        expect(pub.dep).toBe(5500);
        expect(pub.months).toHaveLength(2);
        expect(pub.months.find(x => x.pl)).toMatchObject({ pl: '1A', paid: 2500, due: 0 });
        expect(pub.months.find(x => !x.pl)).toMatchObject({ paid: 0, due: 3000 });
    });
});
