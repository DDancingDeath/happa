/**
 * Rentals › Record payment offers the receipt (RENT-12): the payment carries the
 * place for the receipt (without the type word + its type), the receipt shows the
 * header and address from Settings › Rentals, and rent-receipt.js is loaded only
 * then (also for a tenant's Receipts list). Saved without a receipt: a warning
 * and the Receipts list with Issue receipt.
 */
jest.mock('../rentals/rent-store.js', () => ({
    snapshot: jest.fn(), truncatedKeys: () => [], isAttached: () => false, attach: jest.fn(), detach: jest.fn(),
    loadSettings: jest.fn(), recordPayment: jest.fn()
}));
jest.mock('../rentals/rent-receipt.js', () => ({ showReceipt: jest.fn(), showHistory: jest.fn(), action: jest.fn() }));
jest.mock('../ui/business-switcher.js', () => ({ rentalsRole: jest.fn(() => 'member') }));
jest.mock('../ui/ui-manager.js', () => ({ UIManager: { showToast: jest.fn(), showModal: jest.fn() } }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}) } }));

import * as store from '../rentals/rent-store.js';
import * as receipt from '../rentals/rent-receipt.js';
import { RentalsModule, _test } from '../rentals/rentals.js';
import { normalizeRentSettings, monthKey } from '../rentals/rent-math.js';
import { AuditService } from '../services/audit.js';
import { UIManager } from '../ui/ui-manager.js';

const flush = () => new Promise(r => setTimeout(r));
const MONTH = monthKey();
const CHARGE = { id: `L1_${MONTH}`, leaseId: 'L1', unitId: 'U1', tenantId: 'T1', tenantName: 'Ram', unitLabel: '2B', month: MONTH, dueDay: 10, rent: 5000, amount: 5000, paid: 0, payments: [] };
const SNAP = {
    properties: [{ id: 'P1', name: 'Gupta Bhawan', kind: 'house' }],
    units: [{ id: 'U1', propertyId: 'P1', label: '2B', type: 'flat', rent: 5000, leaseId: 'L1' }],
    tenants: [{ id: 'T1', name: 'Ram Kumar', phone: '9876543210' }],
    leases: [{ id: 'L1', unitId: 'U1', propertyId: 'P1', tenantId: 'T1', rent: 5000, dueDay: 10, startMonth: MONTH, status: 'active', chargedThrough: MONTH }],
    linked: [], charges: [CHARGE]
};
const RECEIPT = { id: `L1_${MONTH}_0`, no: 'R-2026-0001', leaseId: 'L1', tenantId: 'T1' };

beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = `<div id="rentals" class="tab active"><div id="rentalsNotice"></div><div id="rentalsBody"></div>
        <div id="rentDialog" hidden><div id="rentDialogBody"></div><div class="rent-dialog-actions"><button class="rent-btn rent-btn-primary">Save</button></div></div></div>`;
    store.snapshot.mockReturnValue(SNAP);
    store.loadSettings.mockResolvedValue(normalizeRentSettings({ receiptHeader: 'Sharma Rentals', receiptAddress: 'Main Road, Kanpur' }));
    store.recordPayment.mockResolvedValue({ amount: 2000, paid: 2000, open: true, receipt: RECEIPT });
    _test.state.month = MONTH;
});

test('a payment carries the receipt names, then the receipt opens (module loaded on use)', async () => {
    const done = _test.pay('L1');
    await flush();
    document.getElementById('rentPayAmount').value = '2000';
    RentalsModule.api.dialogClose(true);
    await done;
    await flush();
    expect(store.recordPayment).toHaveBeenCalledWith(CHARGE.id, expect.objectContaining({ amount: 2000, mode: 'cash' }), {
        place: '2B, Gupta Bhawan', ut: 'flat'
    });
    expect(UIManager.showToast).toHaveBeenCalledWith('✓ Payment of ₹2,000 saved', 'success');
    expect(AuditService.log).toHaveBeenCalledWith('RENT_PAYMENT', expect.objectContaining({ amount: 2000, receipt: 'R-2026-0001' }));
    expect(receipt.showReceipt).toHaveBeenCalledWith(expect.objectContaining({
        canVoid: false, head: { biz: 'Sharma Rentals', bizAddr: 'Main Road, Kanpur' }
    }), RECEIPT);
    const env = receipt.showReceipt.mock.calls[0][0];
    expect(env.linkOf('L1')).toBe('');
});

test('saved without a receipt (refused): a distinct warning, then the Receipts list with Issue receipt', async () => {
    store.recordPayment.mockResolvedValue({ amount: 2000, paid: 2000, open: true, receipt: null, noReceipt: true });
    const done = _test.pay('L1');
    await flush();
    RentalsModule.api.dialogClose(true);
    await done;
    await flush();
    expect(UIManager.showToast).toHaveBeenCalledWith('Payment saved, but no receipt was issued — tap Issue receipt', 'warning');
    expect(UIManager.showToast).not.toHaveBeenCalledWith(expect.anything(), 'success');
    expect(receipt.showReceipt).not.toHaveBeenCalled();
    expect(receipt.showHistory).toHaveBeenCalledWith(expect.objectContaining({ rcOf: expect.any(Function) }), 'T1');
    expect(receipt.showHistory.mock.calls[0][0].rcOf(CHARGE)).toEqual({ place: '2B, Gupta Bhawan', ut: 'flat' });
});

test('Receipts on a tenant opens their payment history; managers may cancel', async () => {
    _test.state.page = 'tenants';
    _test.state.loaded = new Set(['properties', 'units', 'tenants', 'leases', 'openCharges', 'monthCharges']);
    _test.render();
    expect(document.getElementById('rentalsBody').innerHTML).toContain("window.app.rentals.receipts('T1')");
    await RentalsModule.api.receipts('T1');
    expect(receipt.showHistory).toHaveBeenCalledWith(expect.objectContaining({ canVoid: false }), 'T1');
    await RentalsModule.api.receiptAction('open', 'x');
    expect(receipt.action).toHaveBeenCalledWith(expect.any(Object), 'open', 'x');
});

test('the receipt dialog has no Save button; form dialogs keep it', async () => {
    const env = (await (async () => { await RentalsModule.api.receipts('T1'); return receipt.showHistory.mock.calls[0][0]; })());
    env.dialog('<p>x</p>', { info: true });
    expect(document.querySelector('#rentDialog .rent-btn-primary').hidden).toBe(true);
    env.dialog('<input id="a">');
    expect(document.querySelector('#rentDialog .rent-btn-primary').hidden).toBe(false);
    RentalsModule.api.dialogClose(false);
});
