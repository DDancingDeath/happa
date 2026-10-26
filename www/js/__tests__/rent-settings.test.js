/**
 * Settings › Rentals (rent_settings/default): defaults fill a NEW lease (due
 * day, yearly %, tenant link, header); existing leases keep their own values;
 * the form is view-only for rentals members and saves normalized values.
 */
jest.mock('../rentals/rent-store.js', () => ({
    snapshot: jest.fn(), truncatedKeys: () => [], isAttached: () => false, attach: jest.fn(), detach: jest.fn(),
    loadSettings: jest.fn(), saveSettings: jest.fn(async (v) => v),
    moveIn: jest.fn(async () => ({ unitId: 'U1', tenantId: 'T1', leaseId: 'L9', charged: true })),
    makeShareLink: jest.fn(async () => 'tok'), updateLease: jest.fn(async () => {})
}));
jest.mock('../ui/business-switcher.js', () => ({ rentalsRole: jest.fn(() => 'manager') }));
jest.mock('../ui/ui-manager.js', () => ({ UIManager: { showToast: jest.fn(), showModal: jest.fn() } }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}) } }));

import * as store from '../rentals/rent-store.js';
import { rentalsRole } from '../ui/business-switcher.js';
import { RentalsModule, _test } from '../rentals/rentals.js';
import { mount, save } from '../rentals/rent-settings.js';
import { normalizeRentSettings, monthKey, RENT_SETTINGS_DEFAULTS } from '../rentals/rent-math.js';
import { AppState } from '../utils/state.js';

const flush = () => new Promise(r => setTimeout(r));
const SNAP = {
    properties: [{ id: 'P1', name: 'Gupta Bhawan' }],
    units: [{ id: 'U1', propertyId: 'P1', label: 'G1', rent: 4000, leaseId: null }],
    tenants: [{ id: 'T1', name: 'Ram' }],
    leases: [{ id: 'L1', unitId: 'U0', tenantId: 'T0', rent: 3000, dueDay: 3, increasePct: 8, startMonth: '2025-01' }],
    linked: [], charges: []
};

beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = `<div id="rentals" class="tab active"><div id="rentalsNotice"></div><div id="rentalsBody"></div>
        <div id="rentDialog" hidden><div id="rentDialogBody"></div></div></div>`;
    store.snapshot.mockReturnValue(SNAP);
    _test.state.month = monthKey();
    AppState.settings = { shopName: 'Gupta Aadhat' };
    rentalsRole.mockReturnValue('manager');
});

async function moveInWith(settings) {
    store.loadSettings.mockResolvedValue(normalizeRentSettings(settings));
    const done = _test.moveIn('T1');
    await flush();
    const form = {
        day: document.getElementById('rentTDay').value,
        pct: document.getElementById('rentTPct').value
    };
    RentalsModule.api.dialogClose(true);
    await done;
    return form;
}

test('normalizeRentSettings: defaults when missing, invalid values fall back, text cleaned', () => {
    expect(normalizeRentSettings(null)).toEqual({ ...RENT_SETTINGS_DEFAULTS });
    expect(normalizeRentSettings({ dueDay: 29, increasePct: -1, meterRate: 'x', tenantLink: 'yes', receiptHeader: 5 }))
        .toEqual({ dueDay: 10, increasePct: 5, meterRate: null, tenantLink: false, receiptHeader: '5' });
    expect(normalizeRentSettings({ dueDay: 5, increasePct: 7.5, meterRate: '8.5', tenantLink: true, receiptHeader: ' *Sharma*  Rentals ' }))
        .toEqual({ dueDay: 5, increasePct: 7.5, meterRate: 8.5, tenantLink: true, receiptHeader: 'Sharma Rentals' });
});

test('a new lease gets the Rentals defaults and, when on, a tenant link with the header', async () => {
    const form = await moveInWith({ dueDay: 5, increasePct: 7, tenantLink: true, receiptHeader: 'Sharma Rentals' });
    expect(form).toEqual({ day: '5', pct: '7' });
    expect(store.moveIn).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'T1', lease: expect.objectContaining({ rent: 4000, dueDay: 5, increasePct: 7 }) }));
    expect(store.makeShareLink).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'L9', unitId: 'U1', tenantId: 'T1', dueDay: 5, status: 'active' }),
        expect.objectContaining({ tenantName: 'Ram', place: expect.stringContaining('Gupta Bhawan'), shopName: 'Sharma Rentals' }));
    expect(SNAP.leases[0]).toMatchObject({ dueDay: 3, increasePct: 8 });
});

test('no settings saved yet: due day 10, 5 %, no link; header falls back to the business name', async () => {
    const form = await moveInWith(null);
    expect(form).toEqual({ day: '10', pct: '5' });
    expect(store.makeShareLink).not.toHaveBeenCalled();
});

test('settings unreadable: built-in defaults, the move-in still works', async () => {
    store.loadSettings.mockRejectedValue(Object.assign(new Error('x'), { code: 'unavailable' }));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const done = _test.moveIn('T1');
    await flush();
    expect(document.getElementById('rentTDay').value).toBe('10');
    RentalsModule.api.dialogClose(true);
    await done;
    expect(store.moveIn).toHaveBeenCalledWith(expect.objectContaining({ lease: expect.objectContaining({ dueDay: 10, increasePct: 5 }) }));
});

test('a rentals member moving a tenant in gets the defaults but makes no link', async () => {
    rentalsRole.mockReturnValue('member');
    await moveInWith({ dueDay: 7, tenantLink: true });
    expect(store.moveIn).toHaveBeenCalledWith(expect.objectContaining({ lease: expect.objectContaining({ dueDay: 7 }) }));
    expect(store.makeShareLink).not.toHaveBeenCalled();
});

test('the old Rentals › Access page opens Settings › Roles & access', async () => {
    const nav = await import('../ui/navigation.js');
    const go = jest.spyOn(nav.NavigationManager, 'showTabFromNav').mockImplementation(() => {});
    rentalsRole.mockReturnValue('owner');
    await RentalsModule.enter('access');
    expect(go).toHaveBeenCalledWith('settings-roles');
});

test('Settings › Rentals form: view-only without edit rights; saves normalized values', async () => {
    store.loadSettings.mockResolvedValue(normalizeRentSettings({ dueDay: 12, meterRate: 9, receiptHeader: '<b>x</b>' }));
    const el = document.createElement('div');
    document.body.appendChild(el);
    await mount(el, { editable: false });
    expect(document.getElementById('rentSetDueDay').disabled).toBe(true);
    expect(document.getElementById('rentSetSave')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
    await mount(el, { editable: true });
    expect(document.getElementById('rentSetDueDay').value).toBe('12');
    document.getElementById('rentSetDueDay').value = '15';
    document.getElementById('rentSetMeterRate').value = '';
    document.getElementById('rentSetTenantLink').checked = true;
    const saved = await save();
    expect(store.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ dueDay: 15, meterRate: null, tenantLink: true }));
    expect(saved).toMatchObject({ dueDay: 15, tenantLink: true });
});
