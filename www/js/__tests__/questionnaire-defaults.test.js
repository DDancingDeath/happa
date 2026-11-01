/**
 * Owner questionnaire defaults (#111): Q7 expenses per ₹100 of sales (M19),
 * Q25 cash open for 14 hours (C10), Q48 Rates A–Z, Q52 phone contacts switch.
 * Figures: tests/oracle/questionnaire.test.js.
 */
import { expensePer100Sales } from '../utils/business-metrics.js';
import { insightsSettings } from '../utils/insights-config.js';
import { spendingTakeaways } from '../utils/takeaways.js';
import { openHours, LONG_SESSION_HOURS } from '../utils/cash-session.js';
import { sortItemsByName } from '../utils/item-catalog.js';
import { accessFor, hiddenPermissionClasses, normalizeRoleAccess } from '../utils/role-access.js';
import { Helpers } from '../utils/helpers.js';
import { AppState } from '../utils/state.js';
import { CashManagementManager } from '../modules/cash-management.js';

describe('Q7: expenses per ₹100 of sales (M19)', () => {
    const m = (sales, business) => ({ M1: { total: sales }, M4: { total: business } });
    test('business expenses only, one decimal, nudge above 10 (owner can change it)', () => {
        expect(expensePer100Sales(m(10000, 1234))).toEqual({ value: 12.3, high: true });
        expect(expensePer100Sales(m(10000, 1000))).toEqual({ value: 10, high: false });
        expect(expensePer100Sales(m(0, 500))).toBeNull();
        expect(expensePer100Sales(m(10000, 1234), insightsSettings({ expenseNudgePer100: 15 })).high).toBe(false);
    });
    test('Spending takeaway only when high', () => {
        const base = { business: 1234, topCategory: 'Rent' };
        expect(spendingTakeaways({ ...base, per100Sales: { value: 12.3, high: true }, nudgeAt: 10 })[0])
            .toEqual({ key: 'ui.tk.expenses_high_share', params: { value: 12.3, limit: 10 } });
        expect(spendingTakeaways({ ...base, per100Sales: { value: 8, high: false } }).some(x => x.key === 'ui.tk.expenses_high_share')).toBe(false);
    });
});

describe('Q25: cash open for 14 hours (C10)', () => {
    const at = (h) => new Date(2026, 10, 1, h, 0).getTime();
    const open = { signInTime: new Date(at(8)).toISOString(), signedOut: false };
    test('whole hours since opening; long from 14', () => {
        expect(openHours(open, at(21) + 59 * 60000)).toMatchObject({ hours: 13, long: false });
        expect(openHours(open, at(22))).toMatchObject({ hours: LONG_SESSION_HOURS, long: true });
        expect(openHours({ ...open, signedOut: true }, at(23))).toBeNull();
        expect(openHours({ signedOut: false }, at(23))).toBeNull();
    });
    test('Close cash shows it only when long', () => {
        document.body.innerHTML = '<div id="cashLongOpen" hidden></div>';
        CashManagementManager.todaySession = open;
        CashManagementManager.renderLongOpen(at(23));
        const box = document.getElementById('cashLongOpen');
        expect(box.hidden).toBe(false);
        expect(box.textContent).toContain('15 hours');
        CashManagementManager.renderLongOpen(at(12));
        expect(box.hidden).toBe(true);
    });
});

describe('Q48: Rates A–Z', () => {
    test('by the name shown, case ignored, ties stable', () => {
        const items = [{ id: '2', name: 'wheat', hindiName: 'गेहूं' }, { id: '1', name: 'Barley', hindiName: 'जौ' }, { id: '3', name: 'Wheat', hindiName: '' }];
        expect(sortItemsByName(items).map(i => i.id)).toEqual(['1', '2', '3']);
        expect(sortItemsByName(items.slice(0, 2), i => i.hindiName).map(i => i.id)).toEqual(['2', '1']);
    });
    test('the Rates table follows the name shown and the choice is kept on the phone', async () => {
        const { ItemsManager } = await import('../modules/items.js');
        Object.assign(AppState, { userRole: 'owner', settings: { showHindi: true }, items: [
            { id: 'a', name: 'Apple', hindiName: 'सेब', wholesaleRate: 1, retailRate: 1 },
            { id: 'b', name: 'Banana', hindiName: 'केला', wholesaleRate: 1, retailRate: 1 }
        ], wholesaleSales: [], retailSales: [], purchases: [] });
        document.body.innerHTML = '<input id="itemsSortAz" type="checkbox"><table><tbody id="itemsViewTableBody"></tbody></table>';
        localStorage.removeItem('happa.itemsSort');
        ItemsManager.setSortAz(true);
        expect(localStorage.getItem('happa.itemsSort')).toBe('az');
        expect(document.getElementById('itemsSortAz').checked).toBe(true);
        const text = document.getElementById('itemsViewTableBody').textContent;
        expect(text.indexOf('केला')).toBeLessThan(text.indexOf('सेब'));
        ItemsManager.setSortAz(false);
        expect(localStorage.getItem('happa.itemsSort')).toBe('used');
    });
});

describe('Q52: phone contacts switch', () => {
    test('on by default for managers and members; off hides the buttons and the picker does nothing', async () => {
        expect(accessFor('staff', null).contacts).toBe(true);
        expect(accessFor('manager', null).contacts).toBe(true);
        const off = { staff: { contacts: false } };
        expect(normalizeRoleAccess(off).staff.contacts).toBe(false);
        expect(hiddenPermissionClasses('staff', off)).toContain('no-perm-contacts');
        document.body.className = hiddenPermissionClasses('staff', off).join(' ');
        const select = jest.fn().mockResolvedValue([{ name: ['Ram'] }]);
        navigator.contacts = { select };
        window.ContactsManager = function ContactsManager() {};
        document.body.innerHTML = '<input id="n">';
        await Helpers.pickContact('n');
        expect(select).not.toHaveBeenCalled();
        document.body.className = '';
        await Helpers.pickContact('n');
        expect(document.getElementById('n').value).toBe('Ram');
        delete window.ContactsManager;
        delete navigator.contacts;
    });
});
