/**
 * Tenants › 💰 Deposit (#157, RENT-14 / RENT-15): the ledger dialog loads only on
 * use (rent-deposit.js), shows the agreed and held amounts and the entries, the
 * owner (only) edits / removes received or refunded entries, an adjustment picks
 * an open month and is filled with min(held, due), and Deposits held adds up.
 */
jest.mock('../rentals/rent-store.js', () => ({
    snapshot: jest.fn(), truncatedKeys: () => [], isAttached: () => false, attach: jest.fn(), detach: jest.fn(), loadSettings: jest.fn()
}));
jest.mock('../rentals/rent-deposit-store.js', () => ({
    loadDeposit: jest.fn(), depositsHeld: jest.fn(), addDepositEntry: jest.fn(), changeDepositEntry: jest.fn(), advancesLeft: jest.fn(async () => []), advanceToDeposit: jest.fn()
}));
jest.mock('../ui/business-switcher.js', () => ({ rentalsRole: jest.fn(() => 'member') }));
jest.mock('../ui/ui-manager.js', () => ({ UIManager: { showToast: jest.fn(), showModal: jest.fn(async () => true) } }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}) } }));
jest.mock('../services/telemetry.js', () => ({ TelemetryService: { logWarning: jest.fn() } }));

import * as store from '../rentals/rent-store.js';
import * as ds from '../rentals/rent-deposit-store.js';
import { rentalsRole } from '../ui/business-switcher.js';
import { RentalsModule, _test } from '../rentals/rentals.js';
import { monthKey, addMonths } from '../rentals/rent-math.js';
import { AuditService } from '../services/audit.js';

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r)); };
const MONTH = monthKey();
const PREV = addMonths(MONTH, -1);
const ch = (month, paid) => ({ id: `L1_${month}`, leaseId: 'L1', unitId: 'U1', tenantId: 'T1', month, dueDay: 10, rent: 5000, amount: 5000, paid, payments: [] });
const SNAP = {
    properties: [{ id: 'P1', name: 'Gupta Bhawan', kind: 'house' }],
    units: [{ id: 'U1', propertyId: 'P1', label: '2B', type: 'flat', rent: 5000, leaseId: 'L1' }],
    tenants: [{ id: 'T1', name: 'Ram Kumar', phone: '9876543210' }],
    leases: [{ id: 'L1', unitId: 'U1', propertyId: 'P1', tenantId: 'T1', rent: 5000, dueDay: 10, startMonth: PREV, deposit: 15000, status: 'active', chargedThrough: MONTH }],
    linked: [], charges: [ch(PREV, 1000), ch(MONTH, 0)]
};
const LEDGER = {
    tenantId: 'T1', tenantName: 'Ram Kumar', held: 7000, entries: [
        { kind: 'received', amount: 10000, date: '2026-09-01', mode: 'upi', note: 'At move-in', byName: 'Hitesh' },
        { kind: 'adjust', amount: 3000, date: '2026-10-05', chargeId: 'L1_x', month: PREV, byName: 'Hitesh' }
    ]
};
const body = () => document.getElementById('rentDialogBody').textContent.replace(/\s+/g, ' ');
const cards = () => [...document.querySelectorAll('#rentDialogBody .rent-card')].map(c => [...c.children].map(x => x.textContent.trim()).join(' '));
const buttons = () => [...document.querySelectorAll('#rentDialogBody button')].map(b => b.textContent.trim());

beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = `<div id="rentals" class="tab active"><div id="rentalsNotice"></div><div id="rentalsBody"></div>
        <div id="rentDialog" hidden><div id="rentDialogBody"></div><div class="rent-dialog-actions"><button class="rent-btn rent-btn-primary">Save</button></div></div></div>`;
    store.snapshot.mockReturnValue(SNAP);
    ds.loadDeposit.mockResolvedValue(LEDGER);
    ds.addDepositEntry.mockResolvedValue({ amount: 4000, held: 3000 });
    rentalsRole.mockReturnValue('member');
    _test.state.month = MONTH;
});

test('the Tenants page offers 💰 Deposit per tenant and Deposits held', () => {
    _test.state.page = 'tenants';
    ['properties', 'units', 'tenants', 'leases', 'openCharges', 'monthCharges', 'monthExpenses'].forEach(k => _test.state.loaded.add(k));
    _test.render();
    const html = document.getElementById('rentalsBody').innerHTML;
    expect(html).toContain("window.app.rentals.deposit('T1')");
    expect(html).toContain('window.app.rentals.deposits()');
});

test('the ledger: agreed and held (RENT-14), entries newest first; a member gets no edit / remove', async () => {
    RentalsModule.api.deposit('T1');
    await flush();
    expect(ds.loadDeposit).toHaveBeenCalledWith('T1');
    const text = body();
    expect(text).toContain('Security deposit: Ram Kumar');
    expect(cards()).toEqual(['Agreed deposit ₹15,000', 'Deposit held ₹7,000']);
    expect(text.indexOf('Adjusted against rent')).toBeLessThan(text.indexOf('Received · UPI'));
    expect(buttons()).toEqual(['Deposit received', 'Adjust against dues', 'Refund deposit']);
});

test('the owner may edit or remove a received entry, never an adjustment', async () => {
    rentalsRole.mockReturnValue('owner');
    RentalsModule.api.deposit('T1');
    await flush();
    const edits = [...document.querySelectorAll('#rentDialogBody li')].map(li => li.querySelectorAll('button').length);
    expect(edits).toEqual([0, 2]);
});

test('adjust against dues: an open month, filled with min(held, due), saved with that month', async () => {
    RentalsModule.api.depositAction('adjust', 'T1');
    await flush();
    const sel = document.getElementById('rentDepCharge');
    expect([...sel.options].map(o => o.value)).toEqual([`L1_${PREV}`, `L1_${MONTH}`]);
    expect(document.getElementById('rentPayAmount').value).toBe('4000');
    sel.value = `L1_${MONTH}`;
    RentalsModule.api.fillDue(sel);
    expect(document.getElementById('rentPayAmount').value).toBe('5000');
    RentalsModule.api.dialogClose(true);
    await flush();
    expect(ds.addDepositEntry).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: 'T1', tenantName: 'Ram Kumar', leaseId: 'L1', kind: 'adjust', amount: 5000, chargeId: `L1_${MONTH}`
    }));
    expect(AuditService.log).toHaveBeenCalledWith('RENT_DEPOSIT', expect.objectContaining({ kind: 'adjust', amount: 4000, held: 3000 }));
});

test('Deposits held lists every held deposit and the total (RENT-15)', async () => {
    ds.depositsHeld.mockResolvedValue([{ tenantId: 'T2', tenantName: 'Sita', held: 5000 }, { tenantId: 'T1', tenantName: 'Ram Kumar', held: 7000 }]);
    RentalsModule.api.deposits();
    await flush();
    const text = body();
    expect(cards()).toEqual(['Total deposits held ₹12,000']);
    expect(text.indexOf('Ram Kumar')).toBeLessThan(text.indexOf('Sita'));
});
