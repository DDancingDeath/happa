/**
 * Tenant link store paths (third review of #24) on the in-memory Firestore:
 * the snapshot holds the NEWEST months, is rebuilt after the link is made, and
 * follows renames.
 */
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

const fake = createFakeFirestore();
jest.mock('../firebase/firestore-service.js', () => ({ FirebaseService: { get db() { return global.__fakeDb; } } }));
global.__fakeDb = fake.db;

import { AppState } from '../utils/state.js';
import * as store from '../rentals/rent-store.js';

const month = (i) => `${2021 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
const LEASE = { id: 'L1', unitId: 'U1', propertyId: 'P1', tenantId: 'T1', rent: 5000, dueDay: 10, startMonth: month(0), status: 'active', chargedThrough: month(69) };

beforeAll(() => {
    AppState.currentUser = { uid: 'owner1' };
    fake.seed('rent_leases', [{ ...LEASE }]);
    fake.seed('rent_charges', Array.from({ length: 70 }, (_, i) => ({
        id: `L1_${month(i)}`, leaseId: 'L1', month: month(i), dueDay: 10, rent: 5000, electricity: null,
        amount: 5000, paid: i < 60 ? 5000 : 0, open: i >= 60, payments: []
    })));
});

test('a new link shows the newest 36 of 70 months', async () => {
    const token = await store.makeShareLink(LEASE, { tenantName: 'Ram', place: 'Gali 2 · G1', shopName: 'Shop' });
    const snap = fake.raw('rent_public').get(token);
    expect(snap.months).toHaveLength(36);
    expect(snap.months[0].m).toBe(month(34));
    expect(snap.months[35].m).toBe(month(69));
    expect(fake.raw('rent_leases').get('L1').shareToken).toBe(token);
});

test('rebuild picks up a payment made while the link was being made; ignored once the token changed', async () => {
    const token = fake.raw('rent_leases').get('L1').shareToken;
    const c = fake.raw('rent_charges').get(`L1_${month(69)}`);
    fake.seed('rent_charges', [{ id: `L1_${month(69)}`, ...c, paid: 1000, payments: [{ amount: 1000, date: '2026-10-05' }] }]);
    expect(await store.rebuildShareSnapshot('L1', token, { tenantName: 'Ram', place: 'Gali 2 · G1', shopName: 'Shop' })).toBe(true);
    expect(fake.raw('rent_public').get(token).months[35]).toMatchObject({ paid: 1000, due: 4000 });
    expect(await store.rebuildShareSnapshot('L1', 'OtherTokenOtherTokenOther', {})).toBe(false);
});

test('renames reach the linked snapshot; unknown names keep the old ones', async () => {
    const token = fake.raw('rent_leases').get('L1').shareToken;
    const lease = { ...fake.raw('rent_leases').get('L1'), id: 'L1' };
    await store.renameInLink(lease, { tenantName: 'Ram Kumar', place: 'Gali 3 · G1' });
    expect(fake.raw('rent_public').get(token)).toMatchObject({ tenant: 'Ram Kumar', place: 'Gali 3 · G1' });
    await store.renameInLink(lease, { tenantName: undefined, place: '' });
    expect(fake.raw('rent_public').get(token)).toMatchObject({ tenant: 'Ram Kumar', place: 'Gali 3 · G1' });
});
