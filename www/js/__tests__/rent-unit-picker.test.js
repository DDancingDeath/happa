/**
 * Unit picker on the tenant form (owner: "unit option in tenant page"): vacant
 * units grouped by property; move-in and change of unit in one transaction
 * (rent-store moveIn, rent-unit changeUnit); an occupied (stale) unit is refused;
 * the move month pro-rated on both units (RENT-13); the tenant link carried over.
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
import { monthKey, addMonths, firstMonthRent } from '../rentals/rent-math.js';
import { vacantByProperty } from '../rentals/rent-views.js';
import { todayLocalISO, localISODaysAgo } from '../utils/dates.js';
import { changeUnit, moveMonthRent } from '../rentals/rent-unit.js';
import { buildPublicSnapshot } from '../rentals/rent-public.js';

const M = monthKey();
const PREV = addMonths(M, -1);
const leases = () => [...fake.raw('rent_leases').entries()].map(([id, d]) => ({ id, ...d }));
const lease = (over = {}) => ({ rent: 9000, dueDay: 10, startDate: todayLocalISO(), startMonth: M, proRate: false, deposit: 0, increasePct: 5, elecMode: 'included', ...over });
const meta = { archived: false, createdAt: 1, createdBy: 'x', updatedAt: 1, updatedBy: 'x' };
const dim = new Date(Number(M.slice(0, 4)), Number(M.slice(5, 7)), 0).getDate();
const NAMES = { oldLabel: '1A', old: { place: '1A, Gupta Bhawan', unitType: 'flat' }, now: { place: '7, Arora Market', unitType: 'commercial' } };
// As the change dialog saves it (rent-unit.js): no split unless oldRent is given ('auto' = worked out from the charge).
const change = (over = {}) => changeUnit({
    unitId: 'U3', tenantId: 'T1', tenantName: 'Ram', fromLeaseId: 'L1', endMonth: M, lease: lease(), oldRent: null, names: NAMES, currentMonth: M, ...over
});
// Only Date is faked (the dialogs wait with real timers): today = day `day` of this month.
const at = (day) => jest.useFakeTimers({
    now: new Date(`${M}-${String(day).padStart(2, '0')}T12:00:00`),
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'nextTick', 'hrtime', 'performance']
});
afterEach(() => jest.useRealTimers());

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
    const res = await change();
    expect(fake.raw('rent_leases').get('L1')).toMatchObject({ status: 'ended', endMonth: M, chargedThrough: M, movedTo: res.leaseId });
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
    await expect(change({ endMonth: PREV, lease: lease({ startDate: `${PREV}-20`, startMonth: PREV }) })).rejects.toThrow('later_paid');
    expect(fake.raw('rent_leases').get('L1').status).toBe('active');
    expect(fake.raw('rent_units').get('U3').leaseId).toBeNull();
});

test('an occupied destination (stale list) or a tenant whose lease changed meanwhile is refused; nothing written', async () => {
    const before = leases().length;
    await expect(store.moveIn({ unit: { id: 'U4' }, tenantId: 'T2', lease: lease(), currentMonth: M })).rejects.toThrow('unit_taken');
    await expect(store.moveIn({ unit: { id: 'U2' }, tenantId: 'T1', lease: lease(), currentMonth: M })).rejects.toThrow('tenant_changed');
    await expect(change({ unitId: 'U2', tenantId: 'T2' })).rejects.toThrow('tenant_changed');
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
    const res = await change({ endMonth: PREV, lease: lease({ startDate: `${M}-01` }), oldRent: 'auto' });
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

// ---------- RENT-13: the move month pro-rated on both units ----------

test('change of unit, pro-rated: the old month goes down to its days (+ electricity) in the same write; the new lease starts pro-rated', async () => {
    fake.seed('rent_charges', [{ ...fake.raw('rent_charges').get(`L1_${M}`), id: `L1_${M}`, electricity: { prev: 1, curr: 31, rate: 10, units: 30, amount: 300 }, amount: 5300 }]);
    const date = `${M}-16`;
    const x = Math.round(5000 * 15 / dim);
    const next = Math.round(9000 * (dim - 15) / dim);
    const res = await change({ lease: lease({ startDate: date, proRate: true, firstRent: next }), oldRent: 'auto' });
    expect(moveMonthRent(5000, {}, M, date)).toBe(x);
    expect(fake.raw('rent_charges').get(`L1_${M}`)).toMatchObject({ rent: x, amount: x + 300, paid: 2000, open: true });
    expect(fake.raw('rent_leases').get(res.leaseId)).toMatchObject({ proRate: true, firstRent: next, fromLeaseId: 'L1' });
    expect(fake.raw('rent_charges').get(`${res.leaseId}_${M}`)).toMatchObject({ rent: next, amount: next });
});

test('change of unit: an owner/manager amount for the old month is used; below what is already paid, the old month is left as it is', async () => {
    const kept = await change({ lease: lease({ startDate: `${M}-16`, proRate: true, firstRent: 4000 }), oldRent: 1500 });
    expect(kept.oldKept).toBe(true);
    expect(fake.raw('rent_leases').get('L1').status).toBe('ended');
    expect(fake.raw('rent_charges').get(`L1_${M}`)).toMatchObject({ rent: 5000, amount: 5000, paid: 2000 });
    expect(fake.raw('rent_charges').get(`${kept.leaseId}_${M}`)).toMatchObject({ amount: 4000 });
    seedAll();
    await change({ lease: lease({ startDate: `${M}-16` }), oldRent: 2100 });
    expect(fake.raw('rent_charges').get(`L1_${M}`)).toMatchObject({ rent: 2100, amount: 2100, open: true });
});

test('a member moves a tenant who already paid the move month: no error; the old month stays paid, the new unit is pro-rated', async () => {
    at(16);
    fake.seed('rent_charges', [{ ...fake.raw('rent_charges').get(`L1_${M}`), id: `L1_${M}`, paid: 5000, open: false, payments: [{ amount: 5000, mode: 'cash', date: `${M}-05` }] }]);
    await showTenants();
    const p = _test.toUnit({ id: 'T1', name: 'Ram' }, 'U3');
    await waitFor('rentSplitOn');
    expect(document.getElementById('rentSplitOn').checked).toBe(true);
    RentalsModule.api.dialogClose(true);
    await p;
    const next = firstMonthRent(9000, `${M}-16`, true);
    expect(UIManager.showModal).toHaveBeenCalledWith(expect.stringMatching(/already paid, so it stays as it is/), 'Change unit', true);
    expect(UIManager.showToast).not.toHaveBeenCalledWith(expect.anything(), 'error');
    const lease2 = leases().find(l => l.fromLeaseId === 'L1');
    expect(lease2).toMatchObject({ proRate: true, firstRent: next, unitId: 'U3' });
    expect(fake.raw('rent_charges').get(`L1_${M}`)).toMatchObject({ rent: 5000, amount: 5000, paid: 5000, open: false });
    expect(fake.raw('rent_charges').get(`${lease2.id}_${M}`)).toMatchObject({ amount: next });
});

test('change of unit with a tenant link: the new lease takes the same link; history of both units, receipts, no Moved out', async () => {
    const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx';
    const charges = [...fake.raw('rent_charges').entries()].map(([id, c]) => ({ id, ...c }));
    charges.find(c => c.month === M).payments[0].rno = 'R-2026-0007';
    fake.seed('rent_charges', charges);
    const l1 = { id: 'L1', ...fake.raw('rent_leases').get('L1'), shareToken: TOKEN };
    fake.seed('rent_leases', [l1]);
    fake.seed('rent_public', [{ id: TOKEN, ...buildPublicSnapshot({ lease: l1, tenantName: 'Ram', place: '1A, Gupta Bhawan', unitType: 'flat', charges, now: 1 }) }]);
    const date = `${M}-16`;
    const res = await change({ lease: lease({ startDate: date, proRate: true, firstRent: 4645 }), oldRent: 'auto' });
    expect(fake.raw('rent_leases').get('L1')).toMatchObject({ shareToken: null, movedTo: res.leaseId, status: 'ended' });
    expect(fake.raw('rent_leases').get(res.leaseId).shareToken).toBe(TOKEN);
    const pub = fake.raw('rent_public').get(TOKEN);
    expect(pub).toMatchObject({ lid: res.leaseId, place: '7, Arora Market', ut: 'commercial', ended: false, endMonth: null, rent: 9000, since: `${PREV}-01` });
    const old = pub.months.filter(x => x.pl === '1A, Gupta Bhawan' && x.pt === 'flat');
    expect(old.map(x => x.m)).toEqual([PREV, M]);
    expect(old[1]).toMatchObject({ rent: Math.round(5000 * 15 / dim), paid: 2000, py: [{ a: 2000, r: 'R-2026-0007' }] });
    expect(pub.months.find(x => x.m === M && !x.pl)).toMatchObject({ rent: 4645 });
    // A later payment of the old unit's dues still shows on the same link.
    await store.recordPayment(`L1_${PREV}`, { amount: 1000, mode: 'cash', ref: '', date: `${M}-20` });
    const after = fake.raw('rent_public').get(TOKEN);
    expect(after.months.find(x => x.m === PREV && x.pl)).toMatchObject({ paid: 1000, due: 4000 });
    expect(after.months.filter(x => x.m === PREV)).toHaveLength(1);
});

test('Add unit with an existing tenant: another phone moving that tenant in between the reads and the commit makes it retry and refuse', async () => {
    const orig = fake.db.runTransaction;
    let once = true;
    fake.db.runTransaction = (fn) => orig(async (tx) => {
        const out = await fn(tx);
        if (once) {
            once = false;
            fake.seed('rent_leases', [{ id: 'LO', unitId: 'U3', propertyId: 'P2', tenantId: 'T2', status: 'active', startMonth: M }]);
            fake.seed('rent_tenants', [{ id: 'T2', name: 'Sita', phone: '9876543211', ...meta, updatedAt: 2 }]);
        }
        return out;
    });
    const units = fake.raw('rent_units').size;
    await expect(store.moveIn({ unit: { propertyId: 'P1', label: '9Z', rent: 4000, type: 'flat' }, newUnit: true, tenantId: 'T2', lease: lease(), currentMonth: M }))
        .rejects.toThrow('tenant_changed');
    fake.db.runTransaction = orig;
    expect(fake.stats.retries).toBe(1);
    expect(fake.raw('rent_units').size).toBe(units);
    expect(leases().filter(l => l.tenantId === 'T2')).toHaveLength(1);
});

// ---------- the tenant page ----------

const set = (id, v) => { document.getElementById(id).value = v; };
async function waitFor(id) {
    const open = () => document.getElementById(id) && !document.getElementById('rentDialog').hidden;
    for (let i = 0; i < 100 && !open(); i++) await new Promise(r => setTimeout(r));
    expect(open()).toBeTruthy();
}
async function picker() {
    for (let i = 0; i < 100 && !document.querySelector('#rentTenantUnit optgroup'); i++) await new Promise(r => setTimeout(r));
    return document.getElementById('rentTenantUnit');
}
async function showTenants() {
    store.attach(M, (k) => _test.state.loaded.add(k));
    await fake.settle();
    _test.state.page = 'tenants';
    _test.render();
}

test('tenant form: "No unit" and the vacant units grouped by property (picker loaded on first use)', async () => {
    await showTenants();
    const sel = await picker();
    expect(sel.options[0]).toMatchObject({ value: '', textContent: 'No unit' });
    const groups = [...sel.querySelectorAll('optgroup')].map(g => [g.label, [...g.querySelectorAll('option')].map(o => o.value)]);
    expect(groups).toEqual([['Arora Market', ['U3']], ['Gupta Bhawan', ['U2']]]);
});

test('add a tenant with a unit: the move-in fields, then tenant and lease saved together', async () => {
    await showTenants();
    await picker();
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
    at(16);
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
    at(16);
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
    expect(fake.raw('rent_charges').get(`${lease2.id}_${M}`)).toMatchObject({ amount: firstMonthRent(7000, `${M}-16`, true) });
});

test('change of unit with a tenant link: the link moves to the new unit for a member or a manager (no new link)', async () => {
    const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx';
    for (const role of ['member', 'manager']) {
        store.detach();
        seedAll();
        UIManager.showToast.mockClear();
        at(16);
        fake.seed('rent_leases', [{ ...fake.raw('rent_leases').get('L1'), id: 'L1', shareToken: TOKEN }]);
        rentalsRole.mockReturnValue(role);
        await showTenants();
        const p = _test.toUnit({ id: 'T1', name: 'Ram' }, 'U2');
        await waitFor('rentTRent');
        RentalsModule.api.dialogClose(true);
        await p;
        expect(UIManager.showToast).toHaveBeenCalledWith(expect.stringMatching(/tenant link now shows the new unit/), 'success');
        const moved = leases().find(l => l.fromLeaseId === 'L1');
        expect(moved.shareToken).toBe(TOKEN);
        expect(fake.raw('rent_leases').get('L1').shareToken).toBeNull();
    }
});

test('change dialog: "Pro-rate move month" ticked with both amounts filled in; members can\'t change them; unticked = full rent on both', async () => {
    at(16);
    await showTenants();
    const p = _test.toUnit({ id: 'T1', name: 'Ram' }, 'U2');
    await waitFor('rentSplitOn');
    const x = Math.round(5000 * 15 / dim);
    expect(document.getElementById('rentSplitOn').checked).toBe(true);
    expect(document.getElementById('rentSplitOld').value).toBe(String(x));
    expect(document.getElementById('rentSplitNew').value).toBe(String(firstMonthRent(7000, `${M}-16`, true)));
    expect(document.getElementById('rentSplitOld').readOnly).toBe(true);
    expect(document.getElementById('rentTProRate').closest('label').hidden).toBe(true);
    // The date changes: the amounts follow.
    set('rentTDate', `${M}-11`);
    document.getElementById('rentTDate').dispatchEvent(new Event('change'));
    expect(document.getElementById('rentSplitOld').value).toBe(String(Math.round(5000 * 10 / dim)));
    set('rentTDate', `${M}-16`);
    document.getElementById('rentTDate').dispatchEvent(new Event('change'));
    RentalsModule.api.dialogClose(true);
    await p;
    expect(UIManager.showModal).toHaveBeenCalledWith(expect.stringMatching(/split by days/), 'Change unit', true);
    expect(fake.raw('rent_charges').get(`L1_${M}`)).toMatchObject({ rent: x, amount: x });

    store.detach();
    seedAll();
    rentalsRole.mockReturnValue('manager');
    await showTenants();
    const q = _test.toUnit({ id: 'T1', name: 'Ram' }, 'U2');
    await waitFor('rentSplitOn');
    expect(document.getElementById('rentSplitOld').readOnly).toBe(false);
    const box = document.getElementById('rentSplitOn');
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(document.getElementById('rentSplitBox').hidden).toBe(true);
    RentalsModule.api.dialogClose(true);
    await q;
    expect(UIManager.showModal).toHaveBeenLastCalledWith(expect.stringMatching(/Both units are charged the full rent/), 'Change unit', true);
    expect(fake.raw('rent_charges').get(`L1_${M}`)).toMatchObject({ rent: 5000, amount: 5000 });
    const moved = leases().find(l => l.fromLeaseId === 'L1');
    expect(moved.proRate).toBe(false);
    expect(fake.raw('rent_charges').get(`${moved.id}_${M}`)).toMatchObject({ amount: 7000 });
});

test('a manager may change the pre-filled amounts (within the month\'s rent)', async () => {
    at(16);
    rentalsRole.mockReturnValue('manager');
    await showTenants();
    const p = _test.toUnit({ id: 'T1', name: 'Ram' }, 'U2');
    await waitFor('rentSplitOn');
    set('rentSplitOld', '9999');
    RentalsModule.api.dialogClose(true);
    await p;
    expect(UIManager.showToast).toHaveBeenCalledWith(expect.stringMatching(/up to that month's rent/), 'error');
    const q = _test.toUnit({ id: 'T1', name: 'Ram' }, 'U2');
    await waitFor('rentSplitOn');
    set('rentSplitOld', '2600');
    set('rentSplitNew', '3000');
    RentalsModule.api.dialogClose(true);
    await q;
    expect(fake.raw('rent_charges').get(`L1_${M}`)).toMatchObject({ rent: 2600, amount: 2600 });
    const moved = leases().find(l => l.fromLeaseId === 'L1');
    expect(moved).toMatchObject({ proRate: true, firstRent: 3000 });
});

test('a member\'s change on the 1st with this month already charged: the old lease ends last month, that charge goes (no old-unit rent this month)', async () => {
    at(2);
    fake.seed('rent_charges', [{ ...fake.raw('rent_charges').get(`L1_${M}`), id: `L1_${M}`, paid: 0, open: true, payments: [] }]);
    await showTenants();
    const p = _test.toUnit({ id: 'T1', name: 'Ram' }, 'U2');
    await waitFor('rentSplitOn');
    set('rentTDate', `${M}-01`);
    document.getElementById('rentTDate').dispatchEvent(new Event('change'));
    expect(document.getElementById('rentSplitOldL').hidden).toBe(true);
    expect(document.getElementById('rentSplitHelp').textContent).toMatch(/nothing is charged for the old unit/);
    RentalsModule.api.dialogClose(true);
    await p;
    expect(UIManager.showToast).not.toHaveBeenCalledWith(expect.anything(), 'error');
    expect(fake.raw('rent_leases').get('L1')).toMatchObject({ status: 'ended', endMonth: PREV, chargedThrough: PREV });
    expect(fake.raw('rent_charges').has(`L1_${M}`)).toBe(false);
    const moved = leases().find(l => l.fromLeaseId === 'L1');
    expect(fake.raw('rent_charges').get(`${moved.id}_${M}`)).toMatchObject({ amount: 7000 });
});

test('change of unit keeps the old lease terms (due day, yearly %, deposit, electricity); the rent is the new unit\'s', async () => {
    at(16);
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
