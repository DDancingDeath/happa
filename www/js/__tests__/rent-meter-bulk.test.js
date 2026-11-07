/**
 * Bulk meter readings (REM-7, #157 PR7): the sheet lists every tenancy on our meter still without this month's
 * reading; each filled row goes through the one-reading transaction (store.recordMeter), one after another.
 */
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

let fake = createFakeFirestore();
global.__fakeDb = fake.db;
jest.mock('../firebase/firestore-service.js', () => ({ FirebaseService: { get db() { return global.__fakeDb; }, loadUsers: async () => [] } }));
jest.mock('../ui/business-switcher.js', () => ({ rentalsRole: jest.fn(() => 'member') }));
jest.mock('../ui/ui-manager.js', () => ({ UIManager: { showToast: jest.fn(), showModal: jest.fn(async () => true) } }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}) } }));

import { AppState } from '../utils/state.js';
import * as store from '../rentals/rent-store.js';
import { RentalsModule, _test } from '../rentals/rentals.js';
import { UIManager } from '../ui/ui-manager.js';
import { rentalsRole } from '../ui/business-switcher.js';
import { AuditService } from '../services/audit.js';
import { meterBill } from '../rentals/rent-math.js';
import { meterPending } from '../rentals/rent-views.js';
import { setLang, resetLangForTests } from '../i18n/index.js';

const M = '2028-02';
const meta = { archived: false, createdAt: 1, createdBy: 'x', updatedAt: 1, updatedBy: 'x' };
const lease = (id, unitId, tenantId, elecMode) => ({ id, unitId, propertyId: 'P1', tenantId, rent: 5000, dueDay: 10, increasePct: 5, deposit: 0, status: 'active', startDate: '2027-06-01', startMonth: '2027-06', chargedThrough: M, elecMode, ...meta });
const charge = (leaseId, unitId, tenantId, over = {}) => ({ id: `${leaseId}_${M}`, leaseId, unitId, propertyId: 'P1', tenantId, month: M, dueDay: 10, rent: 5000, amount: 5000, paid: 0, open: true, payments: [], electricity: null, createdAt: 1, updatedAt: 1, ...over });
const flush = () => new Promise(r => setTimeout(r));
const body = () => document.getElementById('rentDialogBody');
const set = (id, v) => { document.getElementById(id).value = v; };
/** Saves the sheet; with a refused row the results stay open: returns their text, then closes them. */
async function save(p) {
    RentalsModule.api.dialogClose(true);
    for (let i = 0; i < 200 && !UIManager.showToast.mock.calls.length; i++) await flush();
    const text = document.getElementById('rentDialog').hidden ? '' : body().textContent;
    RentalsModule.api.dialogClose(false);
    await p;
    await fake.settle();
    return text;
}

beforeAll(() => {
    AppState.currentUser = { uid: 'member1' };
    document.body.innerHTML = `<div id="rentals" class="tab active"><div id="rentalsNotice"></div><div id="rentalsBody"></div>
        <div id="rentDialog" hidden><div id="rentDialogBody"></div></div></div>`;
    window.app = { rentals: { ...RentalsModule.api } };
});

beforeEach(async () => {
    setLang('en');
    fake = createFakeFirestore({ occ: true });
    global.__fakeDb = fake.db;
    store._resetSettingsCache();
    fake.seed('rent_properties', [{ id: 'P1', name: 'Gupta Bhawan', kind: 'house', ...meta }]);
    fake.seed('rent_units', [
        { id: 'U1', propertyId: 'P1', label: '1A', type: 'flat', rent: 5000, leaseId: 'L1', lastReading: 1260, meterRate: 8, ...meta },
        { id: 'U2', propertyId: 'P1', label: '2B', type: 'flat', rent: 5000, leaseId: 'L2', lastReading: 300, meterRate: 10, ...meta },
        { id: 'U3', propertyId: 'P1', label: '3C', type: 'flat', rent: 5000, leaseId: 'L3', lastReading: 50, meterRate: 9, ...meta },
        { id: 'U4', propertyId: 'P1', label: '4D', type: 'flat', rent: 5000, leaseId: 'L4', ...meta }
    ]);
    fake.seed('rent_tenants', ['Ram', 'Sita', 'Om', 'Gita'].map((name, i) => ({ id: `T${i + 1}`, name, phone: `987654321${i}`, ...meta })));
    fake.seed('rent_leases', [lease('L1', 'U1', 'T1', 'meter'), lease('L2', 'U2', 'T2', 'meter'), lease('L3', 'U3', 'T3', 'meter'), lease('L4', 'U4', 'T4', 'included')]);
    fake.seed('rent_charges', [
        charge('L1', 'U1', 'T1'),
        charge('L2', 'U2', 'T2', { paid: 5300, open: false }),
        charge('L3', 'U3', 'T3'),
        charge('L4', 'U4', 'T4')
    ]);
    store.detach();
    _test.state.month = M;
    _test.state.loaded = new Set();
    store.attach(M, (k) => _test.state.loaded.add(k));
    await fake.settle();
    UIManager.showToast.mockClear();
    AuditService.log.mockClear();
});

afterEach(() => {
    RentalsModule.api.dialogClose(false);
    resetLangForTests();
});

async function openSheet() {
    body().innerHTML = '';
    const p = RentalsModule.api.meters();
    for (let i = 0; i < 100 && !document.getElementById('rentMC0'); i++) await flush();
    return { p };
}

test('REM-7 meterPending: active tenancies on our meter whose month has no reading', () => {
    const d = store.snapshot();
    expect(meterPending(d, M).map(x => x.lease.id)).toEqual(['L1', 'L2', 'L3']);
    expect(meterPending({ ...d, charges: d.charges.map(c => (c.leaseId === 'L1' ? { ...c, electricity: { amount: 1 } } : c)) }, M).map(x => x.lease.id)).toEqual(['L2', 'L3']);
});

test('two rows saved through the one-reading transaction (amounts = meterBill), one refused below what is paid, one empty row skipped', async () => {
    const { p } = await openSheet();
    expect(body().querySelectorAll('[data-meter-row]')).toHaveLength(3);
    expect(document.getElementById('rentMP0').type).toBe('hidden');
    expect(document.getElementById('rentMR0').readOnly).toBe(true);
    set('rentMC0', '1360');
    set('rentMC1', '310');
    RentalsModule.api.meterPreview();
    await flush();
    expect(document.getElementById('rentMB0').textContent).toBe('100 units × ₹8 = ₹800');
    const results = await save(p);
    expect(fake.raw('rent_charges').get(`L1_${M}`)).toMatchObject({ amount: 5800, electricity: meterBill({ prev: 1260, curr: 1360, rate: 8 }) });
    expect(fake.raw('rent_units').get('U1')).toMatchObject({ lastReading: 1360, meterRate: 8 });
    // 10 units × ₹10 = ₹100 → ₹5,100, below the ₹5,300 already paid: refused, nothing written.
    expect(fake.raw('rent_charges').get(`L2_${M}`)).toMatchObject({ amount: 5000, electricity: null });
    expect(fake.raw('rent_charges').get(`L3_${M}`).electricity).toBeNull();
    expect(UIManager.showToast).toHaveBeenCalledWith('1 saved, 1 not saved.', 'error');
    expect(results).toContain('✓ Flat 1A, Gupta Bhawan: ₹800');
    expect(results).toContain('✗ Flat 2B, Gupta Bhawan: More than this is already paid');
    expect(AuditService.log).toHaveBeenCalledTimes(1);
});

test('a bad row keeps the sheet open at that row; nothing entered keeps it open too', async () => {
    const { p } = await openSheet();
    RentalsModule.api.dialogClose(true);
    expect(document.getElementById('rentDialog').hidden).toBe(false);
    expect(document.getElementById('rentMB0').textContent).toBe('Enter at least one reading.');
    set('rentMC1', '200');
    RentalsModule.api.dialogClose(true);
    expect(document.getElementById('rentDialog').hidden).toBe(false);
    expect(document.getElementById('rentMB1').textContent).toMatch(/Check the meter readings/);
    expect(document.activeElement.id).toBe('rentMC1');
    RentalsModule.api.dialogClose(false);
    await p;
    expect(fake.raw('rent_charges').get(`L2_${M}`).electricity).toBeNull();
});

test('a reading entered on another phone meanwhile is not replaced (a member cannot replace one)', async () => {
    const { p } = await openSheet();
    set('rentMC0', '1300');
    set('rentMC2', '60');
    fake.seed('rent_charges', [charge('L1', 'U1', 'T1', { amount: 5400, electricity: { prev: 1260, curr: 1310, rate: 8, units: 50, amount: 400 } })]);
    await fake.settle();
    const results = await save(p);
    expect(fake.raw('rent_charges').get(`L1_${M}`).electricity.curr).toBe(1310);
    expect(fake.raw('rent_charges').get(`L3_${M}`)).toMatchObject({ amount: 5090 });
    expect(results).toContain('✗ Flat 1A, Gupta Bhawan: Entered on another phone meanwhile; not changed');
});

test('a manager whose phone has not seen a reading yet does not replace it (checked in the transaction)', async () => {
    rentalsRole.mockReturnValue('manager');
    const { p } = await openSheet();
    set('rentMC0', '1300');
    // Saved on another phone; this phone's listener has not caught up.
    fake.raw('rent_charges').set(`L1_${M}`, { ...fake.raw('rent_charges').get(`L1_${M}`), amount: 5400, electricity: { prev: 1260, curr: 1310, rate: 8, units: 50, amount: 400 } });
    const results = await save(p);
    expect(fake.raw('rent_charges').get(`L1_${M}`)).toMatchObject({ amount: 5400, electricity: { curr: 1310 } });
    expect(results).toContain('✗ Flat 1A, Gupta Bhawan: Entered on another phone meanwhile; not changed');
    rentalsRole.mockReturnValue('member');
});

test('Needs attention (Simple) counts the readings to enter and opens the sheet', async () => {
    _test.state.page = 'rent';
    _test.state.mode = 'simple';
    _test.state.detail = '';
    await _test.render();
    const row = [...document.querySelectorAll('#rentalsBody .rent-attn-row')].find(b => b.textContent.includes('Meter readings'));
    expect(row.textContent).toContain('Meter readings: 3 to enter');
    expect(row.getAttribute('data-onclick')).toBe('rentals.meters()');
});
