/**
 * @fileoverview Editable bill date (#147): which days each role may pick, the time a
 * back-dated bill is saved with (BILL-TIME), and the three forms saving it.
 */
import { billDayRange, billTimeFor, validateBillDay } from '../utils/bill-date.js';
import { prepareBillDate, pickedBillDay, resetBillDate } from '../ui/bill-date-input.js';
import { PurchaseManager } from '../modules/purchase.js';
import { WholesaleSalesManager } from '../modules/wholesale-sales.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { AppState } from '../utils/state.js';
import { toLocalISODate } from '../utils/dates.js';
import { evaluateBill, buildCheckContext } from '../utils/bill-checks.js';
import { sampleItems } from '../../../tests/fixtures/sample-items.js';

const NOW = new Date(2026, 10, 1, 14, 30, 5); // 1 Nov 2026 14:30:05 IST

describe('utils/bill-date.js', () => {
    test('members and managers: back to editDays (default 2); the owner: the 1st of last month; never the future', () => {
        expect(billDayRange({ role: 'staff', now: NOW })).toEqual({ max: '2026-11-01', min: '2026-10-30', days: 2 });
        expect(billDayRange({ role: 'manager', roleAccess: { manager: { editDays: 0 } }, now: NOW })).toEqual({ max: '2026-11-01', min: '2026-11-01', days: 0 });
        expect(billDayRange({ role: 'owner', now: NOW })).toEqual({ max: '2026-11-01', min: '2026-10-01', days: null });
        const who = { role: 'staff', now: NOW };
        expect(validateBillDay('2026-10-30', who)).toBeNull();
        expect(validateBillDay('2026-10-29', who)).toEqual({ key: 'msg.billing.date_too_old', params: { days: 2 } });
        expect(validateBillDay('2026-11-02', who)).toEqual({ key: 'msg.billing.date_in_future' });
        expect(validateBillDay('', who)).toEqual({ key: 'msg.billing.choose_date' });
        expect(validateBillDay('2026-10-31', { role: 'staff', roleAccess: { staff: { editDays: 0 } }, now: NOW })).toEqual({ key: 'msg.billing.date_today_only' });
        expect(validateBillDay('2026-09-30', { role: 'owner', now: NOW })).toEqual({ key: 'msg.billing.date_before_last_month' });
        expect(validateBillDay('2026-10-01', { role: 'owner', now: NOW })).toBeNull();
    });

    test('the bill time: now for today, else that day at the current time of day (no UTC day shift)', () => {
        expect(billTimeFor('2026-11-01', NOW)).toBe(NOW);
        const at = billTimeFor('2026-10-30', NOW);
        expect([toLocalISODate(at), at.getHours(), at.getMinutes(), at.getSeconds()]).toEqual(['2026-10-30', 14, 30, 5]);
        // Just after midnight IST is still the picked day locally (the ISO string is the previous UTC day)
        const early = billTimeFor('2026-10-31', new Date(2026, 10, 1, 0, 10));
        expect(toLocalISODate(early)).toBe('2026-10-31');
        expect(early.toISOString().slice(0, 10)).toBe('2026-10-30');
    });
});

describe('the Date box', () => {
    beforeEach(() => {
        document.body.innerHTML = '<input type="date" id="billDate">';
        AppState.userRole = 'staff';
        AppState.settings = {};
    });

    test('defaults to today, limits the days, follows the clock unless another day is picked; locked while editing', () => {
        prepareBillDate('billDate');
        const input = document.getElementById('billDate');
        const today = toLocalISODate(new Date());
        expect([input.value, input.max, input.disabled]).toEqual([today, today, false]);
        expect(input.min < today).toBe(true);
        expect(pickedBillDay('billDate')).toBe(today);
        input.value = input.min;
        input.dispatchEvent(new Event('change'));
        expect(pickedBillDay('billDate')).toBe(input.min);
        prepareBillDate('billDate', { timestamp: new Date(2026, 9, 3, 11).getTime() });
        expect([input.value, input.disabled]).toEqual(['2026-10-03', true]);
        resetBillDate('billDate');
        expect([input.value, input.disabled, pickedBillDay('billDate')]).toEqual([today, false, today]);
    });

    test('a box never prepared (cold start) still keeps a day typed into it', () => {
        const input = document.getElementById('billDate');
        input.value = '2026-10-30';
        expect(pickedBillDay('billDate')).toBe('2026-10-30');
    });
});

describe('save checks see when a bill was entered (#147)', () => {
    const ctx = (recentBills) => ({ kind: 'retail', now: NOW.getTime(), thresholds: {}, catalogue: [], stock: {}, stockReady: true, credit: [], recentBills, oversellCanBlock: false });
    const items = [{ name: 'Rice', rate: 40, qty: 10, total: 400 }];
    test('a back-dated duplicate is caught by its entry time, not its day', () => {
        const yesterday = new Date(2026, 9, 31, 14, 29).getTime();
        const first = { id: 'a', customerName: 'Ram', items, total: 400, timestamp: yesterday, enteredAt: NOW.getTime() - 60000 };
        const draft = { kind: 'retail', id: 'b', items, total: 400, partyName: 'Ram', payment: { cash: 400, online: 0, due: 0 }, enteredAt: NOW.getTime(), date: new Date(yesterday).toISOString() };
        expect(evaluateBill(draft, ctx([first])).map(i => i.id)).toContain('duplicate');
    });
});

describe('the Date box after a first save attempt', () => {
    test('locked on the attempt\'s day; prepare leaves it; reset unlocks', async () => {
        const { lockBillDate } = await import('../ui/bill-date-input.js');
        document.body.innerHTML = '<input type="date" id="saleDate">';
        AppState.userRole = 'staff';
        prepareBillDate('saleDate');
        lockBillDate('saleDate', new Date(2026, 9, 31, 9).getTime());
        const input = document.getElementById('saleDate');
        expect([input.value, input.disabled]).toEqual(['2026-10-31', true]);
        prepareBillDate('saleDate');
        expect([input.value, input.disabled]).toEqual(['2026-10-31', true]);
        resetBillDate('saleDate');
        expect(input.disabled).toBe(false);
    });
});

describe('saving a back-dated bill', () => {
    const PURCHASE_DOM = `
      <select id="billItem"><option value="0">Rice</option></select><input id="billRate"><input id="newWeight">
      <div id="weightsDisplay"></div><span id="totalWeights"></span><span id="totalPackets"></span>
      <table id="billTable"><tbody></tbody></table><div id="weightBreakdownSection"></div>
      <span id="billTotal"></span><span id="totalPacketsInBill"></span>
      <input type="checkbox" id="autoLaborCharge"><input id="manualLaborCharges" value="0"><span id="laborCalculation"></span>
      <span id="amountPayable"></span><span id="totalPayment"></span>
      <input id="onlinePayment"><input id="cashPayment"><input id="dueAmount"><strong id="purchaseSplitRemaining"></strong>
      <input type="checkbox" id="onlineCheckbox"><input type="checkbox" id="cashCheckbox"><input type="checkbox" id="dueCheckbox">
      <input id="customerName"><input id="billComments"><input type="checkbox" id="billPrintComments">
      <input type="date" id="billDate"><button id="saveBillBtn"></button><button id="printBillBtn"></button><div id="toast"></div>`;
    let saved;
    let toast;

    beforeEach(() => {
        jest.useFakeTimers({ now: NOW, doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'nextTick', 'queueMicrotask'] });
        document.body.innerHTML = PURCHASE_DOM;
        toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        jest.spyOn(UIManager, 'showLoading').mockImplementation(() => {});
        jest.spyOn(UIManager, 'hideLoading').mockImplementation(() => {});
        jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
        jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(Helpers, 'generateBillNumber').mockImplementation(async (prefix) => `${prefix}20261101-001`);
        jest.spyOn(AuditService, 'log').mockResolvedValue(undefined);
        saved = jest.spyOn(FirebaseService, 'savePurchase').mockResolvedValue(undefined);
        AppState.items = sampleItems();
        AppState.stock = {};
        AppState.stockReady = true;
        AppState.settings = { laborRate: 6, heavyWeightThreshold: 30 };
        AppState.currentUser = { uid: 'u1' };
        AppState.userRole = 'staff';
        AppState.purchaseHistory = [];
        PurchaseManager.setBillItems([{ itemId: sampleItems()[0].id, name: 'Rice', rate: 30, qty: 10, weights: [10], total: 300 }]);
        document.getElementById('cashPayment').value = '300';
        prepareBillDate('billDate');
    });
    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        PurchaseManager.setBillItems([]);
        PurchaseManager.setPendingBill(null);
    });

    const pick = (day) => {
        const input = document.getElementById('billDate');
        input.value = day;
        input.dispatchEvent(new Event('change'));
    };

    test('a purchase dated yesterday counts on yesterday (timestamp, date); enteredAt keeps when it was entered', async () => {
        pick('2026-10-31');
        const bill = await PurchaseManager.saveBillToHistory();
        expect(saved).toHaveBeenCalledTimes(1);
        const at = new Date(bill.timestamp);
        expect([toLocalISODate(at), at.getHours(), at.getMinutes()]).toEqual(['2026-10-31', 14, 30]);
        expect(bill.date).toBe(at.toISOString());
        expect(bill.enteredAt).toBe(NOW.getTime());
        // the form is back on today
        expect(document.getElementById('billDate').value).toBe('2026-11-01');
    });

    test('a day outside the role\'s window is refused before anything is saved', async () => {
        document.getElementById('billDate').min = '';
        pick('2026-10-20');
        expect(await PurchaseManager.saveBillToHistory()).toBeUndefined();
        expect(saved).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith('You can date a bill only up to 2 days back', 'warning');
    });

    test('today: the save time, as before', async () => {
        const bill = await PurchaseManager.saveBillToHistory();
        expect([bill.timestamp, bill.enteredAt, bill.date]).toEqual([NOW.getTime(), NOW.getTime(), NOW.toISOString()]);
    });

    test('a bill dated more than a day back is flagged by the save checks (Q20)', () => {
        pick('2026-10-30');
        const draft = PurchaseManager.getCheckDraft();
        const issues = evaluateBill(draft, buildCheckContext(AppState, 'purchase', { now: NOW.getTime() }));
        expect(issues.find(i => i.id === 'date-backdated')).toMatchObject({ severity: 'warn', en: 'Bill is dated 2 days back' });
    });

    test('wholesale: the en-IN date of the picked day', async () => {
        document.body.insertAdjacentHTML('beforeend', '<input type="date" id="wholesaleDate">');
        prepareBillDate('wholesaleDate');
        const input = document.getElementById('wholesaleDate');
        input.value = '2026-10-31';
        input.dispatchEvent(new Event('change'));
        expect(WholesaleSalesManager.getCheckDraft().date).toBe(new Date(2026, 9, 31, 14, 30, 5).toLocaleString('en-IN'));
    });
});
