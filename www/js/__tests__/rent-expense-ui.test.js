/**
 * Rent page summary with property expenses (#157, RENT-17 / RENT-18) and the
 * Properties › 💸 Expenses dialog (rent-expense.js, loaded on use): any rentals
 * role adds one; only the owner gets edit / remove.
 */
jest.mock('../rentals/rent-store.js', () => ({
    snapshot: jest.fn(), truncatedKeys: () => [], isAttached: () => false, attach: jest.fn(), detach: jest.fn(), loadSettings: jest.fn()
}));
jest.mock('../rentals/rent-expense-store.js', () => ({
    listExpenses: jest.fn(), addExpense: jest.fn(async () => {}), updateExpense: jest.fn(async () => {}), deleteExpense: jest.fn(async () => {})
}));
jest.mock('../ui/business-switcher.js', () => ({ rentalsRole: jest.fn(() => 'member') }));
jest.mock('../ui/ui-manager.js', () => ({ UIManager: { showToast: jest.fn(), showModal: jest.fn(async () => true) } }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}) } }));
jest.mock('../services/telemetry.js', () => ({ TelemetryService: { logWarning: jest.fn() } }));

import * as store from '../rentals/rent-store.js';
import * as es from '../rentals/rent-expense-store.js';
import { rentalsRole } from '../ui/business-switcher.js';
import { RentalsModule, _test } from '../rentals/rentals.js';
import { monthKey } from '../rentals/rent-math.js';
import { AuditService } from '../services/audit.js';

// rent-expense.js is loaded with import() on first use, which can take many ticks on a busy machine:
// wait for what the step must produce rather than a fixed number of ticks.
const until = async (done, what) => {
    const end = Date.now() + 5000;
    while (!done()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise(r => setTimeout(r, 5));
    }
};
const MONTH = monthKey();
const SNAP = {
    properties: [{ id: 'P1', name: 'Gupta Bhawan', kind: 'house' }, { id: 'P2', name: 'Shiv Market', kind: 'shop' }],
    units: [{ id: 'U1', propertyId: 'P1', label: '2B', type: 'flat', rent: 5000, leaseId: 'L1' }, { id: 'U2', propertyId: 'P2', label: 'S1', type: 'commercial', rent: 8000, leaseId: null }],
    tenants: [{ id: 'T1', name: 'Ram Kumar', phone: '9876543210' }],
    leases: [{ id: 'L1', unitId: 'U1', propertyId: 'P1', tenantId: 'T1', rent: 5000, dueDay: 10, startMonth: MONTH, status: 'active', chargedThrough: MONTH }],
    linked: [],
    charges: [{ id: `L1_${MONTH}`, leaseId: 'L1', unitId: 'U1', tenantId: 'T1', month: MONTH, dueDay: 10, rent: 5000, amount: 5000, paid: 3000, payments: [] }],
    expenses: [{ id: 'E1', propertyId: 'P1', amount: 1200, month: MONTH }, { id: 'E2', propertyId: 'P2', amount: 800, month: MONTH }]
};
const cards = (root) => [...root.querySelector('.rent-cards').children].map(c => [...c.children].map(x => x.textContent.trim()).join(' '));
const body = () => document.getElementById('rentDialogBody');

beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = `<div id="rentals" class="tab active"><div id="rentalsNotice"></div><div id="rentalsBody"></div>
        <div id="rentDialog" hidden><div id="rentDialogBody"></div><div class="rent-dialog-actions"><button class="rent-btn rent-btn-primary">Save</button></div></div></div>`;
    store.snapshot.mockReturnValue(SNAP);
    es.listExpenses.mockResolvedValue([{ id: 'E1', propertyId: 'P1', unitId: 'U1', category: 'repairs', amount: 1200, date: `${MONTH}-03`, mode: 'cash', note: 'Tap', byName: 'Hitesh' }]);
    rentalsRole.mockReturnValue('member');
    _test.state.month = MONTH;
    _test.state.view = 'properties';
    _test.state.openProperty = '';
    ['properties', 'units', 'tenants', 'leases', 'openCharges', 'monthCharges', 'monthExpenses'].forEach(k => _test.state.loaded.add(k));
});

test('Rent page: expenses and net this month in all; each property card names its expenses; the property its own', () => {
    _test.state.page = 'rent';
    _test.render();
    const root = document.getElementById('rentalsBody');
    expect(cards(root)).toContain('Expenses this month ₹2,000');
    expect(cards(root)).toContain('Net this month ₹1,000');
    expect(root.textContent).toContain('expenses ₹1,200');
    RentalsModule.api.openProperty('P2');
    expect(cards(document.getElementById('rentalsBody'))).toContain('Expenses this month ₹800');
    expect(cards(document.getElementById('rentalsBody'))).toContain('Net this month -₹800');
});

test('Properties › 💸 Expenses: the list (no edit for a member), then Add saves a whole-rupee expense for a unit', async () => {
    _test.state.page = 'properties';
    _test.render();
    expect(document.getElementById('rentalsBody').innerHTML).toContain("window.app.rentals.expenses('P1')");
    RentalsModule.api.expenses('P1');
    await until(() => body().textContent.includes('Repairs · 2B'), 'the list');
    expect(es.listExpenses).toHaveBeenCalledWith('P1');
    expect(body().textContent).toContain('Repairs · 2B · Cash');
    expect([...body().querySelectorAll('li button')]).toHaveLength(0);
    RentalsModule.api.expenseAction('add', 'P1', '');
    await until(() => document.getElementById('rentExpCat'), 'the form');
    document.getElementById('rentExpCat').value = 'tax';
    document.getElementById('rentExpUnit').value = 'U1';
    document.getElementById('rentExpAmount').value = '2499.6';
    RentalsModule.api.dialogClose(true);
    await until(() => AuditService.log.mock.calls.length > 0, 'the save');
    expect(es.addExpense).toHaveBeenCalledWith(expect.objectContaining({ propertyId: 'P1', unitId: 'U1', category: 'tax', amount: 2500, mode: 'cash' }));
    expect(AuditService.log).toHaveBeenCalledWith('RENT_EXPENSE', expect.objectContaining({ amount: 2500 }));
});

test('the owner gets edit and remove on each expense', async () => {
    rentalsRole.mockReturnValue('owner');
    RentalsModule.api.expenses('P1');
    await until(() => body().querySelector('li'), 'the list');
    expect([...body().querySelectorAll('li button')].map(b => b.textContent.trim())).toHaveLength(2);
    RentalsModule.api.expenseAction('delete', 'P1', 'E1');
    await until(() => es.deleteExpense.mock.calls.length > 0, 'the delete');
    expect(es.deleteExpense).toHaveBeenCalledWith('E1');
});

test('an expense on a unit removed since keeps it when the owner edits the amount', async () => {
    rentalsRole.mockReturnValue('owner');
    es.listExpenses.mockResolvedValue([{ id: 'E9', propertyId: 'P1', unitId: 'U-gone', category: 'repairs', amount: 700, date: `${MONTH}-03`, mode: 'cash', note: '' }]);
    RentalsModule.api.expenses('P1');
    await until(() => body().textContent.includes('Removed unit'), 'the list');
    expect(body().textContent).toContain('Repairs · Removed unit · Cash');
    RentalsModule.api.expenseAction('edit', 'P1', 'E9');
    await until(() => document.getElementById('rentExpAmount'), 'the form');
    document.getElementById('rentExpAmount').value = '900';
    RentalsModule.api.dialogClose(true);
    await until(() => es.updateExpense.mock.calls.length > 0, 'the save');
    expect(es.updateExpense).toHaveBeenCalledWith('E9', expect.objectContaining({ unitId: 'U-gone', amount: 900 }));
});
