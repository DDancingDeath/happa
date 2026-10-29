/**
 * Unit picker on the tenant form (owner: "unit option in tenant page"): vacant
 * units grouped by property; move-in and change of unit in one transaction
 * (rent-store assignUnit); an occupied (stale) unit is refused.
 */
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

let fake = createFakeFirestore({ occ: true });
global.__fakeDb = fake.db;
jest.mock('../firebase/firestore-service.js', () => ({ FirebaseService: { get db() { return global.__fakeDb; }, loadUsers: async () => [] } }));
jest.mock('../ui/business-switcher.js', () => ({ rentalsRole: jest.fn(() => 'member') }));
jest.mock('../ui/ui-manager.js', () => ({ UIManager: { showToast: jest.fn(), showModal: jest.fn(async () => true) } }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}) } }));

import { AppState } from '../utils/state.js';
import * as store from '../rentals/rent-store.js';
import { RentalsModule, _test } from '../rentals/rentals.js';
import { UIManager } from '../ui/ui-manager.js';
import { AuditService } from '../services/audit.js';
import { rentalsRole } from '../ui/business-switcher.js';
import { monthKey, addMonths } from '../rentals/rent-math.js';
import { vacantByProperty } from '../rentals/rent-views.js';
import { todayLocalISO, localISODaysAgo } from '../utils/dates.js';

const M = monthKey();
const PREV = addMonths(M, -1);
const leases = () => [...fake.raw('rent_leases').entries()].map(([id, d]) => ({ id, ...d }));
const lease = (over = {}) => ({ rent: 9000, dueDay: 10, startDate: todayLocalISO(), startMonth: M, proRate: false, deposit: 0, increasePct: 5, elecMode: 'included', ...over });
const meta = { archived: false, createdAt: 1, createdBy: 'x', updatedAt: 1, updatedBy: 'x' };

function seedAll() {
    fake = createFakeFirestore({ occ: true });
    global.__fakeDb = fake.db;
    fake.seed('rent_properties', [{ id: 'P1', name: 'Gupta Bhawan', kind: 'house', ...meta }, { id: 'P2', name: 'Arora Market', kind: 'shop', ...meta }]);
    fake.seed('rent_units', [
        { id: 'U1', propertyId: 'P1', label: '1A', type: 'flat', rent: 5000, leaseId: 'L1', ...meta },
        { id: 'U2', propertyId: 'P1', label: '2B', type: 'flat', rent: 7000, leaseId: null, ...meta },
        { id: 'U3', propertyId: 'P2', label: '7', type: 'commercial', rent: 9000, leaseId: null, ...meta },
        { id: 'U4', propertyId: 'P2', label: '8', type: 'commercial', rent: 9000, leaseId: 'LX', ...meta }
    ]);
    fake.seed('rent_tenants', [{ id: 'T1', name: 'Ram', phone: '9876543210', ...meta }, { id: 'T2', name: 'Sita', phone: '9876543211', ...meta },
        { id: 'TX', name: 'Om', phone: '9876543212', ...meta }]);
    const base = { rent: 5000, dueDay: 10, startMonth: PREV, startDate: `${PREV}-01`, endMonth: null, status: 'active', chargedThrough: M, elecMode: 'included', ...meta };
    fake.seed('rent_leases', [{ id: 'L1', unitId: 'U1', propertyId: 'P1', tenantId: 'T1', ...base }, { id: 'LX', unitId: 'U4', propertyId: 'P2', tenantId: 'TX', ...base }]);
    const charge = (month, paid) => ({ id: `L1_${month}`, leaseId: 'L1', unitId: 'U1', propertyId: 'P1', tenantId: 'T1', month, dueDay: 10, rent: 5000,
        electricity: null, amount: 5000, paid, open: paid < 5000, payments: paid ? [{ amount: paid, mode: 'cash', date: `${month}-05` }] : [] });
    fake.seed('rent_charges', [charge(PREV, 0), charge(M, 2000)]);
}

beforeAll(() => {
    AppState.currentUser = { uid: 'member1' };
    document.body.innerHTML = `<div id="rentals" class="tab active"><div id="rentalsNotice"></div><div id="rentalsBody"></div>
        <div id="rentDialog" hidden><div id="rentDialogBody"></div></div></div>`;
    window.app = { rentals: { ...RentalsModule.api } };
    _test.state.month = M;
});

beforeEach(() => {
    store.detach();
    store._resetSettingsCache();
    seedAll();
    UIManager.showToast.mockClear();
    UIManager.showModal.mockClear();
    rentalsRole.mockReturnValue('member');
});

test('vacant list: vacant units only, grouped by property (A–Z), the current unit kept, archived and empty properties left out', () => {
    const props = [{ id: 'P1', name: 'Gupta Bhawan' }, { id: 'P2', name: 'Arora Market' }, { id: 'P3', name: 'Empty' }];
    const units = [{ id: 'a', propertyId: 'P1', label: '2B' }, { id: 'b', propertyId: 'P1', label: '1A', leaseId: 'L1' },
        { id: 'c', propertyId: 'P2', label: '9' }, { id: 'd', propertyId: 'P2', label: '3', archived: true },
        { id: 'e', propertyId: 'P1', label: '0' }, { id: 'f', propertyId: 'P3', label: 'X', leaseId: 'L2' }, { id: 'g', propertyId: 'P9', label: 'orphan' }];
    const ids = (groups) => groups.map(g => [g.property.id, g.units.map(u => u.id)]);
    expect(ids(vacantByProperty(props, units))).toEqual([['P2', ['c']], ['P1', ['e', 'a']]]);
    expect(ids(vacantByProperty(props, units, 'b'))).toEqual([['P2', ['c']], ['P1', ['e', 'b', 'a']]]);
});

const unitDoc = (id) => ({ id, ...fake.raw('rent_units').get(id) });

test('assign: a new tenant into a vacant unit is one batch (no reads, works offline); a taken unit in the list is refused', async () => {
    const reads = fake.stats.reads;
    const orig = fake.db.runTransaction;
    fake.db.runTransaction = jest.fn(async () => { throw Object.assign(new Error('offline'), { code: 'unavailable' }); });
    const res = await store.moveIn({ unit: unitDoc('U2'), tenant: { name: 'Gita', phone: '9876500000' }, lease: lease({ rent: 7000 }), currentMonth: M });
    await expect(store.moveIn({ unit: unitDoc('U4'), tenant: { name: 'Om', phone: '9876500001' }, lease: lease(), currentMonth: M })).rejects.toThrow('unit_taken');
    expect(fake.db.runTransaction).not.toHaveBeenCalled();
    fake.db.runTransaction = orig;
    expect(fake.stats.reads - reads).toBe(0);
    expect(fake.raw('rent_tenants').get(res.tenantId)).toMatchObject({ name: 'Gita', phone: '9876500000' });
    expect(fake.raw('rent_leases').get(res.leaseId)).toMatchObject({ unitId: 'U2', propertyId: 'P1', tenantId: res.tenantId, status: 'active', chargedThrough: M });
    expect(fake.raw('rent_units').get('U2').leaseId).toBe(res.leaseId);
    expect(fake.raw('rent_charges').get(`${res.leaseId}_${M}`)).toMatchObject({ amount: 7000, tenantName: 'Gita', unitLabel: '2B' });
});

test('assign: an existing tenant without a lease moves in (unit, tenant and one query read)', async () => {
    const reads = fake.stats.reads;
    const res = await store.moveIn({ unit: { id: 'U3' }, tenantId: 'T2', lease: lease(), currentMonth: M, tenantName: 'Sita' });
    expect(fake.stats.reads - reads).toBe(3);
    expect(fake.raw('rent_leases').get(res.leaseId)).toMatchObject({ unitId: 'U3', propertyId: 'P2', tenantId: 'T2', status: 'active' });
    expect(fake.raw('rent_leases').get(res.leaseId).fromLeaseId).toBeUndefined();
    expect(fake.raw('rent_charges').get(`${res.leaseId}_${M}`)).toMatchObject({ tenantName: 'Sita', amount: 9000 });
});

test('change unit: the old lease ends with the move month, its charges and dues stay; the new lease starts on the new unit', async () => {
    const res = await store.moveIn({ unit: { id: 'U3' }, tenantId: 'T1', fromLeaseId: 'L1', endMonth: M, lease: lease(), currentMonth: M, tenantName: 'Ram' });
    expect(fake.raw('rent_leases').get('L1')).toMatchObject({ status: 'ended', endMonth: M, chargedThrough: M });
    expect(fake.raw('rent_units').get('U1').leaseId).toBeNull();
    expect(fake.raw('rent_units').get('U3').leaseId).toBe(res.leaseId);
    expect(fake.raw('rent_leases').get(res.leaseId)).toMatchObject({ unitId: 'U3', propertyId: 'P2', tenantId: 'T1', fromLeaseId: 'L1', status: 'active', chargedThrough: M });
    expect(res.charged).toBe(true);
    expect(fake.raw('rent_charges').get(`${res.leaseId}_${M}`)).toMatchObject({ amount: 9000, unitId: 'U3', tenantName: 'Ram', unitLabel: '7' });
    expect(fake.raw('rent_charges').get(`L1_${PREV}`)).toMatchObject({ paid: 0, open: true });
    expect(fake.raw('rent_charges').get(`L1_${M}`)).toMatchObject({ paid: 2000, open: true });
    expect(leases().filter(l => l.tenantId === 'T1' && l.status === 'active')).toHaveLength(1);
});

test('change unit back-dated to last month: refused while a later month has a payment; nothing written', async () => {
    await expect(store.moveIn({ unit: { id: 'U3' }, tenantId: 'T1', fromLeaseId: 'L1', endMonth: PREV, lease: lease({ startDate: `${PREV}-20`, startMonth: PREV }), currentMonth: M }))
        .rejects.toThrow('later_paid');
    expect(fake.raw('rent_leases').get('L1').status).toBe('active');
    expect(fake.raw('rent_units').get('U3').leaseId).toBeNull();
});

test('an occupied destination (stale list) or a tenant whose lease changed meanwhile is refused; nothing written', async () => {
    const before = leases().length;
    await expect(store.moveIn({ unit: { id: 'U4' }, tenantId: 'T2', lease: lease(), currentMonth: M })).rejects.toThrow('unit_taken');
    await expect(store.moveIn({ unit: { id: 'U2' }, tenantId: 'T1', lease: lease(), currentMonth: M })).rejects.toThrow('tenant_changed');
    await expect(store.moveIn({ unit: { id: 'U2' }, tenantId: 'T2', fromLeaseId: 'L1', endMonth: M, lease: lease(), currentMonth: M })).rejects.toThrow('tenant_changed');
    expect(leases()).toHaveLength(before);
    expect(fake.raw('rent_units').get('U2').leaseId).toBeNull();
    expect(fake.raw('rent_leases').get('L1').status).toBe('active');
});

test('vacate then reassign: the freed unit takes another tenant; the old tenant can move in again', async () => {
    await store.endLease('L1', M, M);
    expect(fake.raw('rent_units').get('U1').leaseId).toBeNull();
    const a = await store.moveIn({ unit: { id: 'U1' }, tenantId: 'T2', lease: lease({ rent: 5000 }), currentMonth: M });
    expect(fake.raw('rent_units').get('U1').leaseId).toBe(a.leaseId);
    const b = await store.moveIn({ unit: { id: 'U2' }, tenantId: 'T1', lease: lease({ rent: 7000 }), currentMonth: M });
    expect(fake.raw('rent_leases').get(b.leaseId)).toMatchObject({ unitId: 'U2', tenantId: 'T1', status: 'active' });
    expect(fake.raw('rent_leases').get('L1').status).toBe('ended');
});

test('a move on the 1st ends the old lease the month before: that month is charged once, on the new unit', async () => {
    fake.seed('rent_charges', [{ id: `L1_${M}`, leaseId: 'L1', unitId: 'U1', propertyId: 'P1', tenantId: 'T1', month: M, dueDay: 10, rent: 5000, amount: 5000, paid: 0, open: true, payments: [] }]);
    const res = await store.moveIn({ unit: { id: 'U3' }, tenantId: 'T1', fromLeaseId: 'L1', endMonth: PREV, lease: lease({ startDate: `${M}-01` }), currentMonth: M });
    expect(fake.raw('rent_leases').get('L1')).toMatchObject({ status: 'ended', endMonth: PREV, chargedThrough: PREV });
    expect(fake.raw('rent_charges').has(`L1_${M}`)).toBe(false);
    expect(fake.raw('rent_charges').get(`L1_${PREV}`)).toMatchObject({ open: true });
    expect(fake.raw('rent_charges').get(`${res.leaseId}_${M}`)).toMatchObject({ amount: 9000 });
});

test('Add unit with an existing tenant races a move-in of the same tenant on another phone: only one wins', async () => {
    const results = await Promise.allSettled([
        store.moveIn({ unit: { propertyId: 'P1', label: '9Z', rent: 4000, type: 'flat' }, newUnit: true, tenantId: 'T2', lease: lease(), currentMonth: M }),
        store.moveIn({ unit: { id: 'U2' }, tenantId: 'T2', lease: lease(), currentMonth: M })
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected').reason.message).toBe('tenant_changed');
    expect(leases().filter(l => l.tenantId === 'T2' && l.status === 'active')).toHaveLength(1);
});

test('a write by another phone between the reads and the commit makes the transaction retry and refuse', async () => {
    const orig = fake.db.runTransaction;
    let once = true;
    fake.db.runTransaction = (fn) => orig(async (tx) => {
        const out = await fn(tx);
        if (once) {
            once = false;
            fake.seed('rent_leases', [{ id: 'LO', unitId: 'U3', propertyId: 'P2', tenantId: 'T2', status: 'active', startMonth: M }]);
            fake.seed('rent_tenants', [{ id: 'T2', name: 'Sita', phone: '9876543211', ...meta }]);
        }
        return out;
    });
    await expect(store.moveIn({ unit: { id: 'U2' }, tenantId: 'T2', lease: lease(), currentMonth: M })).rejects.toThrow('tenant_changed');
    fake.db.runTransaction = orig;
    expect(fake.stats.retries).toBe(1);
    expect(fake.raw('rent_units').get('U2').leaseId).toBeNull();
});

// ---------- the tenant page ----------

const set = (id, v) => { document.getElementById(id).value = v; };
async function waitFor(id) {
    const open = () => document.getElementById(id) && !document.getElementById('rentDialog').hidden;
    for (let i = 0; i < 100 && !open(); i++) await new Promise(r => setTimeout(r));
    expect(open()).toBeTruthy();
}
async function showTenants() {
    store.attach(M, (k) => _test.state.loaded.add(k));
    await fake.settle();
    _test.state.page = 'tenants';
    _test.render();
}

test('tenant form: "No unit" and the vacant units grouped by property', async () => {
    await showTenants();
    const sel = document.getElementById('rentTenantUnit');
    expect(sel.options[0]).toMatchObject({ value: '', textContent: 'No unit' });
    const groups = [...sel.querySelectorAll('optgroup')].map(g => [g.label, [...g.querySelectorAll('option')].map(o => o.value)]);
    expect(groups).toEqual([['Arora Market', ['U3']], ['Gupta Bhawan', ['U2']]]);
});

test('add a tenant with a unit: the move-in fields, then tenant and lease saved together', async () => {
    await showTenants();
    set('rentTenantName', 'Gita');
    set('rentTenantPhone', '98765 00000');
    set('rentTenantUnit', 'U3');
    const p = RentalsModule.api.addTenant();
    await waitFor('rentTRent');
    expect(document.getElementById('rentTRent').value).toBe('9000');
    RentalsModule.api.dialogClose(true);
    await p;
    const tn = [...fake.raw('rent_tenants').entries()].find(([, d]) => d.name === 'Gita');
    expect(tn).toBeTruthy();
    expect(leases().find(l => l.tenantId === tn[0])).toMatchObject({ unitId: 'U3', status: 'active', rent: 9000 });
});

test('edit a tenant: another unit asks first (with the dues) and changes the unit', async () => {
    await showTenants();
    const p = _test.editTenant('T1');
    await waitFor('rentEditUnit');
    expect(document.getElementById('rentEditUnit').value).toBe('U1');
    set('rentEditUnit', 'U2');
    RentalsModule.api.dialogClose(true);
    await waitFor('rentTRent');
    expect(document.getElementById('rentTRent').value).toBe('7000');
    RentalsModule.api.dialogClose(true);
    await p;
    expect(UIManager.showModal).toHaveBeenCalledWith(expect.stringMatching(/Flat 1A, Gupta Bhawan.*Flat 2B, Gupta Bhawan.*8,000/), 'Change unit', true);
    expect(fake.raw('rent_leases').get('L1').status).toBe('ended');
    expect(fake.raw('rent_units').get('U2').leaseId).toBeTruthy();
    expect(AuditService.log).toHaveBeenCalledWith('RENT_UNIT_CHANGE', expect.objectContaining({ fromLeaseId: 'L1' }));
});

test('a non-owner back-dating a start more than 2 days: clear message, nothing saved', async () => {
    await showTenants();
    const before = leases().length;
    const p = _test.toUnit({ id: 'T2', name: 'Sita' }, 'U2');
    await waitFor('rentTDate');
    set('rentTDate', localISODaysAgo(3));
    RentalsModule.api.dialogClose(true);
    await p;
    expect(UIManager.showToast).toHaveBeenCalledWith(expect.stringMatching(/more than 2 days back needs the owner/), 'error');
    expect(leases()).toHaveLength(before);
});

test('change of unit when the first charge fails: no claim it was charged; the next charge pass adds it', async () => {
    await showTenants();
    const orig = fake.db.runTransaction;
    let fail = true;
    fake.db.runTransaction = (fn) => orig((tx) => fn({
        ...tx,
        set: (ref, data, o) => {
            if (fail && ref.path.startsWith('rent_charges/')) { fail = false; throw Object.assign(new Error('offline'), { code: 'unavailable' }); }
            return tx.set(ref, data, o);
        }
    }));
    const p = _test.toUnit({ id: 'T1', name: 'Ram' }, 'U2');
    await waitFor('rentTRent');
    RentalsModule.api.dialogClose(true);
    await p;
    fake.db.runTransaction = orig;
    expect(UIManager.showToast).toHaveBeenCalledWith(expect.stringMatching(/rent is added from its first month/), 'success');
    const lease2 = leases().find(l => l.fromLeaseId === 'L1');
    expect(fake.raw('rent_charges').has(`${lease2.id}_${M}`)).toBe(false);
    await fake.settle();
    _test.state.charged.clear();
    await _test.maybeCharge();
    expect(fake.raw('rent_charges').get(`${lease2.id}_${M}`)).toMatchObject({ amount: 7000 });
});

test('change of unit with a tenant link: a manager gets a new link; a member is told the old one shows Moved out', async () => {
    fake.seed('rent_leases', [{ ...fake.raw('rent_leases').get('L1'), id: 'L1', shareToken: 'AbCdEfGhIjKlMnOpQrStUvWx' }]);
    await showTenants();
    const p = _test.toUnit({ id: 'T1', name: 'Ram' }, 'U2');
    await waitFor('rentTRent');
    RentalsModule.api.dialogClose(true);
    await p;
    expect(UIManager.showToast).toHaveBeenCalledWith(expect.stringMatching(/old tenant link now shows Moved out/), 'success');
    store.detach();
    seedAll();
    fake.seed('rent_leases', [{ ...fake.raw('rent_leases').get('L1'), id: 'L1', shareToken: 'AbCdEfGhIjKlMnOpQrStUvWx' }]);
    rentalsRole.mockReturnValue('manager');
    await showTenants();
    const q = _test.toUnit({ id: 'T1', name: 'Ram' }, 'U2');
    await waitFor('rentTRent');
    RentalsModule.api.dialogClose(true);
    await q;
    expect(leases().find(l => l.fromLeaseId === 'L1').shareToken).toBeTruthy();
});

test('change of unit keeps the old lease terms (due day, yearly %, deposit, electricity); the rent is the new unit\'s', async () => {
    fake.seed('rent_leases', [{ ...fake.raw('rent_leases').get('L1'), id: 'L1', dueDay: 5, increasePct: 8, deposit: 15000, elecMode: 'own' }]);
    await showTenants();
    const p = _test.toUnit({ id: 'T1', name: 'Ram' }, 'U3');
    await waitFor('rentTRent');
    const v = (id) => document.getElementById(id).value;
    expect([v('rentTRent'), v('rentTDay'), v('rentTPct'), v('rentTDeposit'), v('rentTElec')]).toEqual(['9000', '5', '8', '15000', 'own']);
    RentalsModule.api.dialogClose(true);
    await p;
    expect(leases().find(l => l.fromLeaseId === 'L1')).toMatchObject({ rent: 9000, dueDay: 5, increasePct: 8, deposit: 15000, elecMode: 'own' });
});

test('offline, an existing tenant can\'t move in: the message says a connection is needed', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await showTenants();
    const orig = fake.db.runTransaction;
    fake.db.runTransaction = async () => { throw Object.assign(new Error('offline'), { code: 'unavailable' }); };
    const p = _test.toUnit({ id: 'T2', name: 'Sita' }, 'U2');
    await waitFor('rentTRent');
    RentalsModule.api.dialogClose(true);
    await p;
    fake.db.runTransaction = orig;
    expect(UIManager.showToast).toHaveBeenCalledWith(expect.stringMatching(/No internet/), 'error');
    expect(fake.raw('rent_units').get('U2').leaseId).toBeNull();
});

test('a unit taken on another phone (stale list): clear message, nothing saved', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await showTenants();
    fake.seed('rent_units', [{ id: 'U3', propertyId: 'P2', label: '7', type: 'commercial', rent: 9000, leaseId: 'LZ', ...meta }]);
    const before = leases().length;
    const p = _test.toUnit({ id: 'T2', name: 'Sita' }, 'U3');
    await waitFor('rentTRent');
    RentalsModule.api.dialogClose(true);
    await p;
    expect(UIManager.showToast).toHaveBeenCalledWith(expect.stringMatching(/no longer vacant/), 'error');
    expect(leases()).toHaveLength(before);
});
