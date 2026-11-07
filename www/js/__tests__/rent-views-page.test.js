/**
 * Rent page views (#170): Property wise (cards -> detail grouped by type) and
 * Unit wise (filters, search) render from the same unit rows; one language at a time.
 * Those are This month in Advanced; Simple (#157 UX redesign) lists who owes, late first.
 */
const DATA = {
    properties: [{ id: 'P1', name: 'Gupta Bhawan' }, { id: 'P2', name: 'Arora Market' }],
    units: [
        { id: 'U1', propertyId: 'P1', label: '2B', type: 'flat', rent: 8000 },
        { id: 'U2', propertyId: 'P1', label: '3A', rent: 7000 },
        { id: 'U3', propertyId: 'P1', label: 'Shop 3', type: 'commercial', rent: 12000 },
        { id: 'U4', propertyId: 'P2', label: 'G1', type: 'godown', rent: 15000 }
    ],
    tenants: [{ id: 'T1', name: 'Ram' }, { id: 'T2', name: 'Shyam' }],
    leases: [
        { id: 'L1', unitId: 'U1', tenantId: 'T1', rent: 8000, dueDay: 10, status: 'active', startMonth: '2026-01' },
        { id: 'L3', unitId: 'U3', tenantId: 'T2', rent: 12000, dueDay: 28, status: 'active', startMonth: '2026-01' }
    ],
    linked: [],
    charges: []
};
jest.mock('../rentals/rent-store.js', () => ({
    snapshot: () => global.__rentData, truncatedKeys: () => [], isAttached: () => true, attach: jest.fn(), detach: jest.fn()
}));
jest.mock('../firebase/firestore-service.js', () => ({ FirebaseService: { loadUsers: jest.fn(async () => []) } }));
jest.mock('../ui/business-switcher.js', () => ({ rentalsRole: jest.fn(() => 'owner') }));
jest.mock('../ui/ui-manager.js', () => ({ UIManager: { showToast: jest.fn(), showModal: jest.fn() } }));
jest.mock('../utils/open-external.js', () => ({ openExternal: jest.fn() }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}) } }));

import { _test, RentalsModule } from '../rentals/rentals.js';
import { AppState } from '../utils/state.js';
import { saveLeaseReminders } from '../utils/reminders.js';
import { rentalsRole } from '../ui/business-switcher.js';
import { openExternal } from '../utils/open-external.js';
import { setLang, resetLangForTests } from '../i18n/index.js';
import { monthKey } from '../rentals/rent-math.js';

const M = monthKey();
global.__rentData = {
    ...DATA,
    charges: [
        { id: `L1_${M}`, leaseId: 'L1', unitId: 'U1', month: M, dueDay: 10, amount: 8000, paid: 8000, payments: [] },
        { id: `L3_${M}`, leaseId: 'L3', unitId: 'U3', month: M, dueDay: 28, amount: 12000, paid: 2000, payments: [] }
    ]
};

async function show(mode = 'advanced') {
    document.body.innerHTML = '<div id="rentals" class="tab active"><div id="rentalsNotice"></div><div id="rentalsBody"></div></div>';
    window.app = { rentals: { ...RentalsModule.api } };
    _test.state.page = 'rent';
    _test.state.mode = mode;
    _test.state.month = M;
    ['properties', 'units', 'tenants', 'leases', 'openCharges', 'monthCharges', 'monthExpenses'].forEach(k => _test.state.loaded.add(k));
    await _test.render();
    return document.getElementById('rentalsBody');
}

afterEach(() => { localStorage.clear(); resetLangForTests(); });

test('property wise (default): cards with type counts, then a property grouped by type', async () => {
    setLang('en');
    localStorage.clear();
    _test.state.view = 'properties';
    _test.state.openProperty = '';
    let root = await show();
    expect(root.textContent).toContain('2 flats · 1 commercial');
    expect(root.textContent).toContain('2 occupied · 1 vacant');
    expect(root.textContent).toMatch(/This month: ₹20,000 rent, ₹10,000 collected/);
    RentalsModule.api.openProperty('P1');
    root = document.getElementById('rentalsBody');
    const groups = [...root.querySelectorAll('.rent-group-title')].map(h => h.textContent);
    expect(groups).toEqual(['Flat (2)', 'Commercial / shop space (1)']);
    expect(root.textContent).toContain('Shop 3');
    expect(root.textContent).not.toContain('Shop Shop 3');
    expect(root.textContent).toContain('Part paid');
    expect(root.textContent).toContain('Vacant');
    expect(root.querySelectorAll('button[data-onclick*="rentals.pay"]').length).toBe(1);
});

test('unit wise: remembered per device, filters and search redraw only the list', async () => {
    setLang('en');
    _test.state.openProperty = '';
    await RentalsModule.api.setView('units');
    expect(localStorage.getItem('happa.rentView')).toBe('units');
    const root = await show();
    expect(root.querySelectorAll('[data-unit]').length).toBe(4);
    const search = root.querySelector('input[type=search]');
    await RentalsModule.api.filterUnits('q', 'shyam');
    expect(document.querySelector('input[type=search]')).toBe(search);
    expect([...root.querySelectorAll('[data-unit]')].map(e => e.getAttribute('data-unit'))).toEqual(['U3']);
    await RentalsModule.api.filterUnits('q', '');
    await RentalsModule.api.filterUnits('status', 'vacant');
    expect([...root.querySelectorAll('[data-unit]')].map(e => e.getAttribute('data-unit')).sort()).toEqual(['U2', 'U4']);
    RentalsModule.api.filterUnits('status', '');
});

test('Hindi: type words and counts in Hindi only', async () => {
    setLang('hi');
    _test.state.view = 'properties';
    _test.state.openProperty = '';
    const text = (await show()).textContent.replace(/Gupta Bhawan|Arora Market|Ram|Shyam|Shop 3|2B|3A|G1/g, '');
    expect(text).toContain('2 फ़्लैट · 1 कमर्शियल');
    expect(text).not.toMatch(/[A-Za-z]{3,}/);
});

test('no properties yet: the Rent page offers Add property, and the side menu marks only the open Rentals page', async () => {
    setLang('en');
    _test.state.view = 'properties';
    _test.state.openProperty = '';
    const saved = global.__rentData;
    global.__rentData = { ...DATA, properties: [], units: [], tenants: [], leases: [], charges: [] };
    try {
        await show();
        document.body.insertAdjacentHTML('afterbegin', '<nav class="nav-menu"><a data-biz="all" class="active">Settings</a><a data-biz="rentals" data-rent-nav="rent">Rent</a></nav>');
        _test.render();
        const add = document.querySelector('#rentalsBody button[data-onclick*="rentals.page(\'properties\')"]');
        expect(add.textContent).toBe('Add property');
        expect([...document.querySelectorAll('.nav-menu a.active')].map(a => a.textContent)).toEqual(['Rent']);
    } finally {
        global.__rentData = saved;
    }
});

describe('This month in Simple', () => {
    const OWES = () => ({
        ...DATA,
        tenants: [...DATA.tenants, { id: 'T3', name: 'Hari' }],
        charges: [
            ...global.__rentData.charges,
            { id: 'L3_2025-11', leaseId: 'L3', unitId: 'U3', tenantId: 'T2', month: '2025-11', dueDay: 28, amount: 12000, paid: 0, payments: [] },
            { id: 'L9_2025-12', leaseId: 'L9', unitId: 'U2', tenantId: 'T3', tenantName: 'Hari', month: '2025-12', dueDay: 10, amount: 5000, paid: 0, payments: [] }
        ]
    });
    let saved;
    beforeEach(() => { saved = global.__rentData; global.__rentData = OWES(); AppState.currentUser = { uid: 'u1' }; setLang('en'); });
    afterEach(() => { global.__rentData = saved; });

    test('collected of the month rent, who owes (a moved-out tenant once, late first), paid folded, one filled button', async () => {
        const root = await show('simple');
        expect(root.textContent).toContain('Collected ₹10,000 of ₹20,000');
        expect(root.textContent).toContain('Total due (all months): ₹27,000');
        const owing = [...root.querySelectorAll('#rentalsBody > .rent-list > [data-lease]')].map(e => e.getAttribute('data-lease'));
        expect(owing).toEqual(['L3', 'L9']);
        const hari = root.querySelector('[data-lease="L9"]').textContent;
        expect(hari).toContain('Moved out');
        expect(hari).toContain('3A, Gupta Bhawan');
        expect(root.querySelector('details.rent-more').textContent).toContain('Ram');
        expect(root.textContent).toContain('2 vacant units');
        expect(root.querySelectorAll('.rent-btn-primary').length).toBe(1);
        expect(root.querySelector('.rent-filters, .rent-prop-card')).toBeNull();
    });

    test('Needs attention shows what Today shows (REM-2, REM-4) and opens the action', async () => {
        saveLeaseReminders(localStorage, { uid: 'u1', month: M, items: [{ kind: 'increase', place: 'Flat 2B, Gupta Bhawan', tenant: 'Ram', pct: 5, newRent: 8400 }] });
        const root = await show('simple');
        const rows = [...root.querySelectorAll('.rent-attn-row')];
        expect(rows[0].textContent).toContain('2 units owe rent · 1 late');
        expect(rows[0].textContent).toContain('₹27,000');
        expect(rows[1].textContent).toContain('rent increase due: 5% → ₹8,400');
        expect(rows[1].getAttribute('data-onclick')).toBe("rentals.editLease('L1')");
        RentalsModule.api.onlyLate(true);
        expect([...document.querySelectorAll('#rentalsBody > .rent-list > [data-lease]')].map(e => e.getAttribute('data-lease'))).toEqual(['L3', 'L9']);
        RentalsModule.api.onlyLate(false);
    });

    test('no properties: the start hint, and the page settles (no render loop from the lease reminders)', async () => {
        global.__rentData = { ...DATA, properties: [], units: [], tenants: [], leases: [], charges: [] };
        const root = await show('simple');
        expect(root.textContent).toContain('Start by adding a property and its units.');
        let renders = 0;
        new MutationObserver(() => { renders++; }).observe(root, { childList: true });
        await new Promise(r => setTimeout(r, 300));
        expect(renders).toBeLessThanOrEqual(1);
    });

    test('the choice is kept per user; Property wise / Unit wise open Advanced', async () => {
        await show('simple');
        RentalsModule.api.setMode('advanced');
        expect(localStorage.getItem('happa.rentMode.u1')).toBe('advanced');
        RentalsModule.api.setMode('simple');
        expect(localStorage.getItem('happa.rentMode.u1')).toBe('simple');
        await RentalsModule.api.setView('properties');
        expect(_test.state.mode).toBe('advanced');
        expect(localStorage.getItem('happa.rentMode.u1')).toBe('advanced');
    });
});

describe('Tenants and the tenant screen', () => {
    async function tenants(mode = 'simple') {
        await show(mode);
        _test.state.page = 'tenants';
        _test.state.detail = '';
        await _test.render();
        return document.getElementById('rentalsBody');
    }
    afterEach(() => { rentalsRole.mockReturnValue('owner'); _test.state.tenantList = { q: '', filter: 'all', sort: 'name' }; });

    test('Simple: one row per tenant (no inline form, no buttons on rows), one filled Add tenant; search redraws only the list', async () => {
        setLang('en');
        const root = await tenants();
        expect([...root.querySelectorAll('[data-tenant]')].map(e => e.getAttribute('data-tenant'))).toEqual(['T1', 'T2']);
        expect(root.querySelector('.rent-form, #rentTenantName')).toBeNull();
        expect(root.querySelectorAll('.rent-btn-primary').length).toBe(1);
        expect(root.querySelector('[data-tenant="T2"]').textContent).toContain('Shop 3, Gupta Bhawan');
        RentalsModule.api.tenantList('q', 'shop 3');
        expect([...root.querySelectorAll('[data-tenant]')].map(e => e.getAttribute('data-tenant'))).toEqual(['T2']);
    });

    test('a row opens the tenant screen; the ⋯ menu follows the role; Back returns to the list', async () => {
        setLang('en');
        await tenants();
        RentalsModule.api.openTenant('T2');
        let root = document.getElementById('rentalsBody');
        expect(root.querySelector('#rentDetailTitle').textContent).toBe('Shyam');
        const menu = () => [...document.querySelectorAll('.rent-menu-list button')].map(b => b.getAttribute('data-onclick').match(/rentals\.(\w+)/)[1]);
        expect(menu()).toEqual(['editTenant', 'agreement', 'shareLink', 'changeUnit']);
        expect(root.querySelector('[data-onclick^="rentals.moveOut"]').className).toContain('rent-btn-danger');
        expect(root.querySelectorAll('.rent-btn-primary').length).toBe(1);
        rentalsRole.mockReturnValue('member');
        _test.render();
        expect(menu()).toEqual(['editTenant', 'changeUnit']);
        RentalsModule.api.back();
        await new Promise(r => setTimeout(r, 20));
        root = document.getElementById('rentalsBody');
        expect(root.querySelector('#rentDetailTitle')).toBeNull();
        expect(root.querySelectorAll('[data-tenant]').length).toBe(2);
    });

    test('WhatsApp on the tenant screen asks for everything owed, the old unit after a change too', async () => {
        setLang('en');
        const saved = global.__rentData;
        global.__rentData = { ...DATA, tenants: [{ id: 'T1', name: 'Ram', phone: '9876543210' }, DATA.tenants[1]], charges: [
            { id: 'L0_2025-12', leaseId: 'L0', unitId: 'U4', tenantId: 'T1', unitLabel: 'G1', month: '2025-12', dueDay: 10, amount: 5000, paid: 0 },
            { id: `L1_${M}`, leaseId: 'L1', unitId: 'U1', tenantId: 'T1', month: M, dueDay: 10, amount: 8000, paid: 0 }
        ] };
        try {
            await tenants();
            RentalsModule.api.openTenant('T1');
            expect(document.getElementById('rentalsBody').textContent).toContain('Owes ₹13,000');
            RentalsModule.api.remindTenant('T1');
            const url = decodeURIComponent(openExternal.mock.calls.at(-1)[0]);
            expect(url).toContain('Dec 2025');
            expect(url).toContain('₹13,000');
        } finally {
            global.__rentData = saved;
            _test.state.detail = '';
        }
    });

    test('Back after opening the same tenant again returns to the list (each screen has its own history entry)', async () => {
        await tenants();
        RentalsModule.api.openTenant('T1');
        await RentalsModule.api.page('tenants');
        _test.state.page = 'tenants';
        RentalsModule.api.openTenant('T1');
        RentalsModule.api.back();
        await new Promise(r => setTimeout(r, 20));
        expect(document.getElementById('rentDetailTitle')).toBeNull();
    });

    test('Advanced: filters and the details on each row', async () => {
        setLang('en');
        const root = await tenants('advanced');
        expect(root.querySelector('[data-tenant="T1"]').textContent).toContain('₹8,000/month, due on day 10');
        RentalsModule.api.tenantList('filter', 'owes');
        expect([...document.querySelectorAll('[data-tenant]')].map(e => e.getAttribute('data-tenant'))).toEqual(['T2']);
        RentalsModule.api.tenantList('filter', 'all');
    });
});

