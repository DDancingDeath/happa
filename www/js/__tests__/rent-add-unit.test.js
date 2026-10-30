/**
 * Add unit with its tenant (owner request): one batch creates the unit, the
 * tenant, the lease and the first month's charge; a form error saves nothing;
 * "not occupied" saves only the vacant unit as before.
 */
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

const fake = createFakeFirestore();
global.__fakeDb = fake.db;
jest.mock('../firebase/firestore-service.js', () => ({ FirebaseService: { get db() { return global.__fakeDb; }, loadUsers: async () => [] } }));
jest.mock('../ui/business-switcher.js', () => ({ rentalsRole: () => 'member' }));
jest.mock('../ui/ui-manager.js', () => ({ UIManager: { showToast: jest.fn(), showModal: jest.fn(async () => true) } }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}) } }));

import { AppState } from '../utils/state.js';
import * as store from '../rentals/rent-store.js';
import { RentalsModule, _test } from '../rentals/rentals.js';
import { UIManager } from '../ui/ui-manager.js';
import { monthKey } from '../rentals/rent-math.js';
import { todayLocalISO } from '../utils/dates.js';

const M = monthKey();
const raw = (c) => [...fake.raw(c).entries()].map(([id, d]) => ({ id, ...d }));

beforeAll(() => {
    AppState.currentUser = { uid: 'member1' };
    document.body.innerHTML = `<div id="rentals" class="tab active"><div id="rentalsNotice"></div><div id="rentalsBody"></div>
        <div id="rentDialog" hidden><div id="rentDialogBody"></div></div></div>`;
    window.app = { rentals: { ...RentalsModule.api } };
    _test.state.month = M;
});

const set = (id, v) => { const el = document.getElementById(id); if (el.type === 'checkbox') el.checked = !!v; else el.value = v; };

async function addUnitWith(fill) {
    const p = RentalsModule.api.addUnit('P1');
    // The dialog opens after Settings › Rentals defaults are read.
    for (let i = 0; i < 50 && document.getElementById('rentDialog').hidden; i++) await new Promise(r => setTimeout(r));
    set('rentUnitLabel', 'S1');
    set('rentUnitType', 'commercial');
    set('rentUnitRent', '6000');
    fill();
    RentalsModule.api.dialogClose(true);
    await p;
}

test('store.moveIn: unit, new tenant, lease (start date, own meter) and first charge in one batch', async () => {
    const res = await store.moveIn({
        unit: { propertyId: 'P1', label: 'S9', rent: 5000, type: 'flat' }, newUnit: true,
        tenant: { name: 'Gita', phone: '9876500000' },
        lease: { rent: 5000, dueDay: 10, startDate: `${M}-01`, proRate: false, deposit: 10000, increasePct: 5, elecMode: 'own', meterNo: 'CN-1' },
        meter: null, currentMonth: M
    });
    const lease = fake.raw('rent_leases').get(res.leaseId);
    expect(lease).toMatchObject({ startDate: `${M}-01`, startMonth: M, chargedThrough: M, elecMode: 'own', meterNo: 'CN-1', deposit: 10000, unitId: res.unitId });
    expect(fake.raw('rent_units').get(res.unitId)).toMatchObject({ leaseId: res.leaseId, type: 'flat' });
    expect(fake.raw('rent_tenants').get(res.tenantId)).toMatchObject({ name: 'Gita', phone: '9876500000' });
    expect(fake.raw('rent_charges').get(`${res.leaseId}_${M}`)).toMatchObject({ amount: 5000, paid: 0, open: true });
});

test('Add unit, occupied: one save creates all four (pro-rated first month when ticked)', async () => {
    const before = raw('rent_leases').length;
    await addUnitWith(() => {
        set('rentTOn', true);
        set('rentTName', 'Sita');
        set('rentTPhone', '+91 98765 43210');
        set('rentTRent', '6000');
        set('rentTDate', todayLocalISO());
        set('rentTElec', 'meter');
        set('rentTOpen', '1200');
        set('rentTRate', '9');
    });
    const lease = raw('rent_leases').slice(before)[0];
    expect(lease).toMatchObject({ rent: 6000, startDate: todayLocalISO(), elecMode: 'meter', chargedThrough: M });
    expect(fake.raw('rent_tenants').get(lease.tenantId)).toMatchObject({ name: 'Sita', phone: '9876543210' });
    expect(fake.raw('rent_units').get(lease.unitId)).toMatchObject({ label: 'S1', type: 'commercial', leaseId: lease.id, lastReading: 1200, meterRate: 9 });
    expect(fake.raw('rent_charges').get(`${lease.id}_${M}`)).toMatchObject({ amount: 6000 });
});

test('an existing tenant moving in: the first charge carries the tenant name', async () => {
    const res = await store.moveIn({
        unit: { id: 'UV', propertyId: 'P1', label: 'V1' }, newUnit: false, tenantId: 'TX', tenantName: 'Rekha',
        lease: { rent: 4000, dueDay: 10, startDate: `${M}-01`, proRate: false, deposit: 0, increasePct: 5, elecMode: 'included' },
        currentMonth: M
    }).catch(() => null);
    // the fake's update needs the unit to exist
    expect(res).toBeNull();
    fake.seed('rent_units', [{ id: 'UV', propertyId: 'P1', label: 'V1', leaseId: null }]);
    fake.seed('rent_tenants', [{ id: 'TX', name: 'Rekha', phone: '9876543219' }]);
    const ok = await store.moveIn({
        unit: { id: 'UV', propertyId: 'P1', label: 'V1' }, newUnit: false, tenantId: 'TX', tenantName: 'Rekha',
        lease: { rent: 4000, dueDay: 10, startDate: `${M}-01`, proRate: false, deposit: 0, increasePct: 5, elecMode: 'included' },
        currentMonth: M
    });
    expect(fake.raw('rent_charges').get(`${ok.leaseId}_${M}`)).toMatchObject({ tenantName: 'Rekha', unitLabel: 'V1', tenantId: 'TX' });
});

test('names tenants see: no guessed "Flat" for an untyped unit; the property kind is used when it says', () => {
    const ix = {
        properties: new Map([['PH', { id: 'PH', name: 'Old House', kind: 'house' }], ['PS', { id: 'PS', name: 'Arora Market', kind: 'shop' }]]),
        units: new Map([['A', { id: 'A', propertyId: 'PH', label: 'Upper' }], ['B', { id: 'B', propertyId: 'PS', label: '7' }],
            ['C', { id: 'C', propertyId: 'PH', label: '2B', type: 'flat' }]]),
        tenants: new Map(), leases: new Map()
    };
    expect(_test.placeOf(ix, 'A')).toBe('Upper, Old House');
    expect(_test.linkPlace(ix, 'A')).toEqual({ place: 'Upper, Old House', unitType: null });
    expect(_test.placeOf(ix, 'B')).toBe('Shop 7, Arora Market');
    expect(_test.linkPlace(ix, 'B').unitType).toBe('commercial');
    expect(_test.placeOf(ix, 'C')).toBe('Flat 2B, Old House');
});

test('a form error (bad phone) saves nothing at all', async () => {
    const counts = ['rent_units', 'rent_tenants', 'rent_leases', 'rent_charges'].map(c => raw(c).length);
    UIManager.showToast.mockClear();
    await addUnitWith(() => {
        set('rentTOn', true);
        set('rentTName', 'Bad');
        set('rentTPhone', '12345');
    });
    expect(['rent_units', 'rent_tenants', 'rent_leases', 'rent_charges'].map(c => raw(c).length)).toEqual(counts);
    expect(UIManager.showToast).toHaveBeenCalledWith(expect.stringMatching(/10-digit/), 'error');
});

test('not occupied: only the vacant unit is saved, as before', async () => {
    const counts = ['rent_tenants', 'rent_leases', 'rent_charges'].map(c => raw(c).length);
    const units = raw('rent_units').length;
    await addUnitWith(() => set('rentTOn', false));
    expect(['rent_tenants', 'rent_leases', 'rent_charges'].map(c => raw(c).length)).toEqual(counts);
    const unit = raw('rent_units').slice(units)[0];
    expect(unit).toMatchObject({ label: 'S1', type: 'commercial', leaseId: null });
});

test('a payment right after a move-in waits for the move-in to reach the server, then saves', async () => {
    fake.db.waitForPendingWrites = jest.fn(async () => {
        fake.seed('rent_charges', [{ id: 'LZ_2026-10', leaseId: 'LZ', month: '2026-10', amount: 5000, paid: 0, open: true, payments: [] }]);
    });
    fake.seed('rent_leases', [{ id: 'LZ', status: 'active' }]);
    const res = await store.recordPayment('LZ_2026-10', { amount: 1000, mode: 'cash', ref: '', date: '2026-10-26' });
    expect(fake.db.waitForPendingWrites).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ paid: 1000, open: true });
    delete fake.db.waitForPendingWrites;
});
