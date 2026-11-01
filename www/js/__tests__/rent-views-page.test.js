/**
 * Rent page views (#170): Property wise (cards -> detail grouped by type) and
 * Unit wise (filters, search) render from the same unit rows; one language at a time.
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
jest.mock('../ui/business-switcher.js', () => ({ rentalsRole: () => 'owner' }));
jest.mock('../ui/ui-manager.js', () => ({ UIManager: { showToast: jest.fn(), showModal: jest.fn() } }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}) } }));

import { _test, RentalsModule } from '../rentals/rentals.js';
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

function show() {
    document.body.innerHTML = '<div id="rentals" class="tab active"><div id="rentalsNotice"></div><div id="rentalsBody"></div></div>';
    window.app = { rentals: { ...RentalsModule.api } };
    _test.state.page = 'rent';
    _test.state.month = M;
    ['properties', 'units', 'tenants', 'leases', 'openCharges', 'monthCharges', 'monthExpenses'].forEach(k => _test.state.loaded.add(k));
    _test.render();
    return document.getElementById('rentalsBody');
}

afterEach(() => { localStorage.clear(); resetLangForTests(); });

test('property wise (default): cards with type counts, then a property grouped by type', () => {
    setLang('en');
    localStorage.clear();
    _test.state.view = 'properties';
    _test.state.openProperty = '';
    let root = show();
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
    expect(root.querySelectorAll('button[onclick*="rentals.pay"]').length).toBe(1);
});

test('unit wise: remembered per device, filters and search redraw only the list', () => {
    setLang('en');
    _test.state.openProperty = '';
    RentalsModule.api.setView('units');
    expect(localStorage.getItem('happa.rentView')).toBe('units');
    const root = show();
    expect(root.querySelectorAll('[data-unit]').length).toBe(4);
    const search = root.querySelector('input[type=search]');
    RentalsModule.api.filterUnits('q', 'shyam');
    expect(document.querySelector('input[type=search]')).toBe(search);
    expect([...root.querySelectorAll('[data-unit]')].map(e => e.getAttribute('data-unit'))).toEqual(['U3']);
    RentalsModule.api.filterUnits('q', '');
    RentalsModule.api.filterUnits('status', 'vacant');
    expect([...root.querySelectorAll('[data-unit]')].map(e => e.getAttribute('data-unit')).sort()).toEqual(['U2', 'U4']);
    RentalsModule.api.filterUnits('status', '');
});

test('Hindi: type words and counts in Hindi only', () => {
    setLang('hi');
    _test.state.view = 'properties';
    _test.state.openProperty = '';
    const text = show().textContent.replace(/Gupta Bhawan|Arora Market|Ram|Shyam|Shop 3|2B|3A|G1/g, '');
    expect(text).toContain('2 फ़्लैट · 1 कमर्शियल');
    expect(text).not.toMatch(/[A-Za-z]{3,}/);
});

test('no properties yet: the Rent page offers Add property, and the side menu marks only the open Rentals page', () => {
    setLang('en');
    _test.state.view = 'properties';
    _test.state.openProperty = '';
    const saved = global.__rentData;
    global.__rentData = { ...DATA, properties: [], units: [], tenants: [], leases: [], charges: [] };
    try {
        show();
        document.body.insertAdjacentHTML('afterbegin', '<nav class="nav-menu"><a data-biz="all" class="active">Settings</a><a data-biz="rentals" data-rent-nav="rent">Rent</a></nav>');
        _test.render();
        const add = document.querySelector('#rentalsBody button[onclick*="rentals.page(\'properties\')"]');
        expect(add.textContent).toBe('Add property');
        expect([...document.querySelectorAll('.nav-menu a.active')].map(a => a.textContent)).toEqual(['Rent']);
    } finally {
        global.__rentData = saved;
    }
});