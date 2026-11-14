/**
 * @fileoverview Live red/amber highlighting (#188) and the save gate (#37):
 * marks fields/rows with class + aria + reason text, shows the banner, colours
 * the card, blocks Save, debounces typing, and asks only at save time.
 */
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}), ACTIONS: { OVERRIDE_CHECK: 'OVERRIDE_CHECK' } } }));

import { BillChecksUI, CHECK_DEBOUNCE_MS, clearFieldError, readTypedNumber, showFieldError, BILL_CHECKS_BLOCKING_POLICY, AUTO_ROLLBACK_REASON } from '../ui/bill-highlight.js';
import { tip } from '../tip/index.js';
import { UIManager } from '../ui/ui-manager.js';
import { AuditService } from '../services/audit.js';
import { AppState } from '../utils/state.js';

const DOM = `
  <div id="testSection">
    <div class="bill-form-field"><label>Customer</label><input id="party"></div>
    <div class="bill-form-field"><label>Rate</label><input id="rate"></div>
    <table id="testTable"><tbody></tbody></table>
    <div class="pay-line"><input id="cash"></div>
    <div class="pay-line"><input id="due"></div>
    <div class="pay-line"><strong id="remaining"></strong></div>
    <button id="saveBtn">Save</button><button id="printBtn">Print</button>
  </div>`;

let state;

function renderRows() {
    document.querySelector('#testTable tbody').innerHTML = state.items.map(i => `<tr><td>${i.name}</td><td>${i.rate}</td><td>${i.qty}</td><td>${i.total}</td><td></td></tr>`).join('');
}

beforeAll(() => {
    BillChecksUI.register('test', {
        sectionId: 'testSection',
        tableSelector: '#testTable',
        saveButtons: '#saveBtn, #printBtn',
        getDraft: () => ({
            kind: 'wholesale',
            isEdit: false,
            id: 'n1',
            items: state.items,
            total: state.items.reduce((s, i) => s + i.total, 0),
            payment: { cash: readTypedNumber('cash') || 0, due: readTypedNumber('due') || 0 },
            partyName: document.getElementById('party').value,
            entry: { itemId: 'rice', name: 'Rice', rate: readTypedNumber('rate'), qty: null }
        }),
        fields: {
            party: { inputs: ['party'] },
            payment: { inputs: ['cash', 'due'], anchor: 'remaining' },
            'entry.rate': { inputs: ['rate'] }
        }
    });
});

beforeEach(() => {
    document.body.innerHTML = DOM;
    AppState.items = [{ id: 'rice', name: 'Rice', wholesaleRates: [40] }];
    AppState.stock = { rice: { quantity: 100, rate: 30 } };
    AppState.stockReady = true;
    AppState.salesHistory = [];
    AppState.settings = {};
    AppState.userRole = 'staff';
    AppState.currentUser = { uid: 'u1' };
    state = { items: [{ itemId: 'rice', name: 'Rice', rate: 40, qty: 10, total: 400 }] };
    renderRows();
});

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

const $ = (id) => document.getElementById(id);
const banner = () => document.querySelector('#testSection > .bill-check-notice');

describe('live marks', () => {
    test('a payment problem marks cash + due red with aria and one reason under the split row', () => {
        $('cash').value = '100';
        BillChecksUI.run('test');

        for (const id of ['cash', 'due']) {
            expect($(id).classList.contains('bill-check-block')).toBe(true);
            expect($(id).getAttribute('aria-invalid')).toBe('true');
        }
        const msg = $('remaining').closest('.pay-line').nextElementSibling;
        expect(msg.classList.contains('bill-check-msg')).toBe(true);
        expect(msg.textContent).toMatch(/^⛔ Cash \+ Online \+ Due is ₹300 less [^\u0900-\u097F]*$/);
        expect($('cash').getAttribute('aria-describedby')).toBe(msg.id);

        expect(banner().hidden).toBe(false);
        expect(banner().getAttribute('aria-live')).toBe('polite');
        expect(banner().textContent).toContain('⛔ 1 problem — check before saving');
        expect($('testSection').classList.contains('bill-checks-block')).toBe(true);
        expect($('saveBtn').getAttribute('aria-disabled')).toBe('true');
        expect($('printBtn').classList.contains('bill-check-save-blocked')).toBe(true);
    });

    test('fixing the problem removes every mark', () => {
        $('cash').value = '100';
        BillChecksUI.run('test');
        $('cash').value = '400';
        BillChecksUI.run('test');
        expect(document.querySelectorAll('.bill-check-msg, .bill-check-line, [aria-invalid]')).toHaveLength(0);
        expect(banner().hidden).toBe(true);
        expect($('testSection').className).toBe('');
        expect($('saveBtn').hasAttribute('aria-disabled')).toBe(false);
    });

    test('a line warning marks its row amber with a reason row; only warnings → amber card, Save enabled', () => {
        state.items[0] = { itemId: 'rice', name: 'Rice', rate: 90, qty: 10, total: 900 };
        renderRows();
        $('cash').value = '900';
        BillChecksUI.run('test');
        const rows = document.querySelectorAll('#testTable tbody tr');
        expect(rows[0].classList.contains('bill-check-warn')).toBe(true);
        expect(rows[1].className).toBe('bill-check-line');
        expect(rows[1].textContent).toContain('⚠️ Rate ₹90 is 2.3× the usual ₹40');
        expect($('testSection').classList.contains('bill-checks-warn')).toBe(true);
        expect($('saveBtn').hasAttribute('aria-disabled')).toBe(false);
    });

    test('the same problem on the rate box and its line is counted once in the banner', () => {
        state.items[0] = { itemId: 'rice', name: 'Rice', rate: 90, qty: 10, total: 900 };
        renderRows();
        $('cash').value = '900';
        $('rate').value = '90';
        BillChecksUI.run('test');
        expect($('rate').classList.contains('bill-check-warn')).toBe(true);
        expect(banner().textContent).toContain('1 problem — check before saving');
    });

    test('bill-level problems (duplicate) are listed in the banner', () => {
        AppState.salesHistory = [{ id: 'old', customerName: '', timestamp: Date.now() - 5000, total: 400, items: [{ itemId: 'rice', rate: 40, quantity: 10 }] }];
        $('cash').value = '400';
        BillChecksUI.run('test');
        expect(banner().querySelector('li').textContent).toMatch(/^⚠️ Same bill was saved \d+ s ago/);
    });

    test('a typed rate is flagged on its own box; banner tap scrolls/focuses the first problem', () => {
        $('cash').value = '400';
        $('rate').value = '0';
        BillChecksUI.run('test');
        expect($('rate').classList.contains('bill-check-block')).toBe(true);
        expect($('saveBtn').hasAttribute('aria-disabled')).toBe(false); // the typed line is not on the bill yet
        $('rate').scrollIntoView = jest.fn();
        banner().querySelector('button').click();
        expect($('rate').scrollIntoView).toHaveBeenCalled();
        expect(document.activeElement).toBe($('rate'));
    });

    test('typing is debounced: nothing until the user pauses, no popups', () => {
        jest.useFakeTimers();
        const modal = jest.spyOn(UIManager, 'showModal');
        const toast = jest.spyOn(UIManager, 'showToast');
        $('cash').value = '400';
        BillChecksUI.run('test'); // clean; binds the input listener
        $('cash').value = '1';
        $('cash').dispatchEvent(new Event('input', { bubbles: true }));
        jest.advanceTimersByTime(CHECK_DEBOUNCE_MS - 1);
        expect($('cash').classList.contains('bill-check-block')).toBe(false);
        jest.advanceTimersByTime(1);
        expect($('cash').classList.contains('bill-check-block')).toBe(true);
        expect(modal).not.toHaveBeenCalled();
        expect(toast).not.toHaveBeenCalled();
    });
});

describe('save gate', () => {
    test('a money block stops the save with the same toast as before and focuses the field, even for the owner', async () => {
        AppState.userRole = 'owner';
        const toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        $('due').value = '400';
        const result = await BillChecksUI.confirmSave('test');
        expect(result.ok).toBe(false);
        expect(toast).toHaveBeenCalledWith('Enter the name — a bill with Due needs a customer/supplier name.');
        expect(document.activeElement).toBe($('party'));
    });

    test('an overridable block stops a member; owner/manager must give a reason, stored as overrides + audit', async () => {
        state.items[0] = { itemId: 'rice', name: 'Rice', rate: 40, qty: 110, total: 4400 };
        $('cash').value = '4400';
        const toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        expect((await BillChecksUI.confirmSave('test')).ok).toBe(false);
        expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('Rice: selling 110 kg, only 100 kg'));

        AppState.userRole = 'manager';
        BillChecksUI.run('test');
        expect($('saveBtn').classList.contains('bill-check-save-override')).toBe(true);
        expect($('saveBtn').hasAttribute('aria-disabled')).toBe(false);

        const html = jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async (body) => {
            document.body.insertAdjacentHTML('beforeend', `<div id="m">${body}</div>`);
            return true;
        });
        expect((await BillChecksUI.confirmSave('test')).ok).toBe(false); // blank reason
        expect(toast).toHaveBeenLastCalledWith('Write a reason to save anyway');

        html.mockImplementation(async (body) => {
            document.getElementById('m')?.remove();
            document.body.insertAdjacentHTML('beforeend', `<div id="m">${body}</div>`);
            $('billCheckOverrideReason').value = ' truck unloading now ';
            return true;
        });
        const ok = await BillChecksUI.confirmSave('test');
        expect(ok).toMatchObject({ ok: true, flags: [] });
        expect(ok.overrides).toEqual([{ rule: 'oversell', reason: 'truck unloading now', by: 'u1', at: expect.any(Number) }]);
        expect(AuditService.log).toHaveBeenCalledWith('OVERRIDE_CHECK', { kind: 'test', rules: ['oversell'], reason: 'truck unloading now' });
        expect(html.mock.calls[1][0]).not.toContain('<script');
    });

    test('warnings need one confirm; accepted ones come back as flags, declined stops', async () => {
        state.items[0] = { itemId: 'rice', name: 'Rice', rate: 90, qty: 10, total: 900 };
        $('cash').value = '900';
        const modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(false);
        expect((await BillChecksUI.confirmSave('test')).ok).toBe(false);
        expect(modal).toHaveBeenCalledWith(expect.stringMatching(/^Rate ₹90 is 2\.3× .*\n\nSave anyway\?$/), 'Check before saving', true, { confirmLabel: 'Save anyway' });
        modal.mockResolvedValue(true);
        const ok = await BillChecksUI.confirmSave('test');
        expect(ok.ok).toBe(true);
        expect(ok.flags).toEqual([expect.objectContaining({ rule: 'rate-high', by: 'u1' })]);
        expect(ok.flags[0].en).toBe('Rate ₹90.00 is 2.3× the usual ₹40.00');
        expect(modal).toHaveBeenCalledTimes(2);
    });

    test('OD-02 at Save: an extreme rate not confirmed yet asks "Fix rate" first; confirmed, the one-tap 2× "Save anyway?" is not stacked on it', async () => {
        state.items[0] = { itemId: 'rice', name: 'Rice', rate: 400, qty: 10, total: 4000 };
        renderRows();
        $('cash').value = '4000';
        const toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        const modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        const dialog = () => document.querySelector('.rate-check-sheet');

        const fixed = BillChecksUI.confirmSave('test');
        await Promise.resolve();
        expect(dialog().querySelector('#rateCheckMessage').textContent).toBe('Rice 10 kg × ₹400 = ₹4,000. Today\'s rate ₹40 would give ₹400.');
        expect(document.activeElement.dataset.choice).toBe('fix');
        dialog().querySelector('[data-choice="fix"]').click();
        expect((await fixed).ok).toBe(false);
        expect(toast).toHaveBeenLastCalledWith('Change the rate of Rice on the bill, then save.', 'warning');
        expect(state.items[0]).not.toHaveProperty('rateCheck');

        const confirmed = BillChecksUI.confirmSave('test');
        await Promise.resolve();
        dialog().querySelector('[data-choice="confirm"]').click();
        const result = await confirmed;
        expect(result).toEqual({ ok: true, flags: [], overrides: [] });
        expect(state.items[0].rateCheck).toEqual({ rate: 400, todayRate: 40, by: 'u1', byName: expect.any(String), at: expect.any(Number) });
        expect(modal).not.toHaveBeenCalled();
        // Saved again: confirmed already, nothing asked
        expect(await BillChecksUI.confirmSave('test')).toEqual({ ok: true, flags: [], overrides: [] });
        expect(dialog()).toBeNull();
    });

    test('clean bill saves with no dialog', async () => {
        $('cash').value = '400';
        const modal = jest.spyOn(UIManager, 'showModal');
        expect(await BillChecksUI.confirmSave('test')).toEqual({ ok: true, flags: [], overrides: [] });
        expect(modal).not.toHaveBeenCalled();
    });

    test('auto rollback (#217): members stay blocked; owner/manager get a warning and the override is recorded as auto-rollback', async () => {
        state.items[0] = { itemId: 'rice', name: 'Rice', rate: 40, qty: 110, total: 4400 };
        $('cash').value = '4400';
        const toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        const modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        const html = jest.spyOn(UIManager, 'showModalWithHtml');
        jest.spyOn(tip, 'isRolledBack').mockReturnValue(true);

        // A member who could not override before is still blocked
        expect((await BillChecksUI.confirmSave('test')).ok).toBe(false);
        expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('Rice: selling 110 kg'));
        expect(modal).not.toHaveBeenCalled();

        AppState.userRole = 'manager';
        const ok = await BillChecksUI.confirmSave('test');
        expect(tip.isRolledBack).toHaveBeenCalledWith(BILL_CHECKS_BLOCKING_POLICY);
        expect(html).not.toHaveBeenCalled(); // no reason prompt
        expect(modal).toHaveBeenCalledTimes(1); // one "save anyway?" confirm
        expect(ok).toMatchObject({ ok: true, flags: [] });
        expect(ok.overrides).toEqual([{ rule: 'oversell', reason: AUTO_ROLLBACK_REASON, by: 'u1', at: expect.any(Number) }]);
        expect(AuditService.log).toHaveBeenCalledWith('OVERRIDE_CHECK', { kind: 'test', rules: ['oversell'], reason: AUTO_ROLLBACK_REASON });

        modal.mockResolvedValue(false); // declining the confirm saves nothing and records nothing
        AuditService.log.mockClear();
        expect((await BillChecksUI.confirmSave('test')).ok).toBe(false);
        expect(AuditService.log).not.toHaveBeenCalled();
    });

    test('billFields: flags only when present; overrides are kept across edits', () => {
        expect(BillChecksUI.billFields({ flags: [], overrides: [] })).toEqual({});
        const original = { flags: [{ rule: 'x' }], overrides: [{ rule: 'oversell', reason: 'a' }] };
        expect(BillChecksUI.billFields({ flags: [], overrides: [{ rule: 'oversell', reason: 'b' }] }, original))
            .toEqual({ flags: [], overrides: [{ rule: 'oversell', reason: 'a' }, { rule: 'oversell', reason: 'b' }] });
    });
});

describe('field error (Field pattern)', () => {
    test('shows the message under the field with aria-invalid / aria-describedby, survives live checks, clears on edit', () => {
        jest.useFakeTimers();
        const rate = document.getElementById('rate');
        expect(showFieldError('rate', 'Please enter a valid rate')).toBe(true);
        const msg = document.getElementById('rate-error');
        expect(msg.textContent).toBe('Please enter a valid rate');
        expect(msg.getAttribute('role')).toBe('alert');
        expect(rate.closest('.bill-form-field').nextElementSibling).toBe(msg);
        expect(rate.getAttribute('aria-invalid')).toBe('true');
        expect(rate.getAttribute('aria-describedby')).toBe('rate-error');
        expect(document.activeElement).toBe(rate);

        document.getElementById('party').dispatchEvent(new Event('input', { bubbles: true }));
        jest.advanceTimersByTime(CHECK_DEBOUNCE_MS + 10);
        expect(document.getElementById('rate-error')).not.toBeNull();

        rate.value = '40';
        rate.dispatchEvent(new Event('input', { bubbles: true }));
        expect(document.getElementById('rate-error')).toBeNull();
        expect(rate.hasAttribute('aria-invalid')).toBe(false);
        expect(rate.hasAttribute('aria-describedby')).toBe(false);
        clearFieldError('rate');
        expect(showFieldError('missing', 'x')).toBe(false);
    });

    test('live checks keep aria-invalid on an input while its field error is shown', () => {
        jest.useFakeTimers();
        const rate = document.getElementById('rate');
        rate.dataset.billCheck = 'warn';
        rate.setAttribute('aria-invalid', 'true');
        showFieldError('rate', 'Please enter a valid rate');
        document.getElementById('party').dispatchEvent(new Event('input', { bubbles: true }));
        jest.advanceTimersByTime(CHECK_DEBOUNCE_MS + 10);
        expect(rate.dataset.billCheck).toBeUndefined();
        expect(rate.getAttribute('aria-invalid')).toBe('true');
        expect(rate.getAttribute('aria-describedby')).toBe('rate-error');
        clearFieldError('rate');
        expect(rate.hasAttribute('aria-invalid')).toBe(false);
    });
});