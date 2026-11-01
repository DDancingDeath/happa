/**
 * Reminders on Today (#86): udhaar to collect / pay (REM-1) and rent due (REM-2).
 */
import { jest } from '@jest/globals';
import { overdueReminder, saveRentReminder, rentReminder, unitsWithDue, noteRent } from '../utils/reminders.js';
import { DayManager } from '../modules/day.js';
import { AppState } from '../utils/state.js';
import { setLang } from '../i18n/index.js';

const TODAY = new Date(2026, 10, 15, 10, 0, 0);
const daysAgo = (n) => `${String(new Date(2026, 10, 15 - n).getDate()).padStart(2, '0')}/${String(new Date(2026, 10, 15 - n).getMonth() + 1).padStart(2, '0')}/2026`;
const bill = (name, due, age, extra = {}) => ({ id: `${name}-${age}-${due}`, customerName: name, date: daysAgo(age), grandTotal: due, payment: { cash: 0, online: 0, due }, ...extra });

const memStore = () => ({ v: {}, getItem(k) { return this.v[k] ?? null; }, setItem(k, val) { this.v[k] = String(val); } });

describe('REM-1 who to collect from / pay', () => {
    test('only dues older than 30 days, oldest bucket first then the biggest, top 3 and a count of the rest', () => {
        const bills = [
            bill('Asha', 500, 10),
            bill('Ravi', 900, 40), bill('ravi ', 100, 35),
            bill('Mohan', 300, 95),
            bill('Sita', 2000, 45),
            bill('Gopal', 50, 70),
            bill('Lata', 400, 50, { cleared: true }),
            bill('Old', 800, 200, { voided: true })
        ];
        const r = overdueReminder(bills, { today: TODAY });
        expect(r.parties.map(p => [p.name, p.total, p.oldestDays])).toEqual([['Mohan', 300, 95], ['Gopal', 50, 70], ['Sita', 2000, 45]]);
        expect(r.more).toBe(1);
        expect(r.total).toBe(300 + 50 + 2000 + 1000);
        expect(overdueReminder([bill('Asha', 500, 10)], { today: TODAY })).toEqual({ parties: [], more: 0, total: 0 });
    });
});

describe('REM-2 rent due', () => {
    test('only for the same person and month, and only when something is due', () => {
        const s = memStore();
        saveRentReminder(s, { uid: 'u1', month: '2026-11', due: 12000, late: 2, dueUnits: 3, at: 5 });
        expect(rentReminder(s, 'u1', '2026-11')).toEqual({ due: 12000, late: 2, dueUnits: 3, at: 5 });
        expect(rentReminder(s, 'u2', '2026-11')).toBeNull();
        expect(rentReminder(s, 'u1', '2026-12')).toBeNull();
        saveRentReminder(s, { uid: 'u1', month: '2026-11', due: 0, late: 0, dueUnits: 0 });
        expect(rentReminder(s, 'u1', '2026-11')).toBeNull();
        expect(rentReminder({ getItem: () => '{bad' }, 'u1', '2026-11')).toBeNull();
        expect(unitsWithDue([{ due: 10 }, { due: 0 }, { due: 5 }])).toBe(2);
    });
});

describe('Rent page note (REM-2)', () => {
    afterEach(() => { localStorage.clear(); AppState.currentUser = null; });
    const month = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0');
    const rows = [{ due: 5000, late: true }, { due: 0 }, { due: 2500.5, late: false }];

    test('kept for the current month with complete data only', () => {
        AppState.currentUser = { uid: 'u9' };
        noteRent({ month, errors: new Set() }, rows, []);
        expect(rentReminder(localStorage, 'u9', month)).toEqual({ due: 7500.5, late: 1, dueUnits: 2, at: expect.any(Number) });
        localStorage.clear();
        noteRent({ month, errors: new Set(['monthCharges']) }, rows, []);
        noteRent({ month, errors: new Set() }, rows, ['openCharges']);
        noteRent({ month: '2001-01', errors: new Set() }, rows, []);
        expect(rentReminder(localStorage, 'u9', month)).toBeNull();
    });
});

describe('Today › Reminders card', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="todayReminders" hidden></div>';
        AppState.currentUser = { uid: 'u1' };
        AppState.settings = {};
        AppState.retailSalesHistory = [bill('Ravi', 900, 40)];
        AppState.salesHistory = [bill('Hotel Raj', 5000, 61, { source: 'sales-tab', total: 5000 })];
        AppState.purchaseHistory = [bill('Farmer Ram', 700, 33)];
        localStorage.clear();
    });
    afterEach(() => {
        setLang('en');
        AppState.userRole = null;
        AppState.rentRole = undefined;
        AppState.retailSalesHistory = [];
        AppState.salesHistory = [];
        AppState.purchaseHistory = [];
        jest.restoreAllMocks();
    });

    test('the owner sees who to collect from and who to pay; nothing is read', () => {
        AppState.userRole = 'owner';
        DayManager.renderReminders(TODAY);
        const host = document.getElementById('todayReminders');
        expect(host.hidden).toBe(false);
        expect(host.querySelector('[data-reminder="collect"]').textContent).toContain('Ravi');
        expect(host.querySelector('[data-reminder="collect_wholesale"]').textContent).toContain('Hotel Raj');
        expect(host.querySelector('[data-reminder="collect_wholesale"] button').getAttribute('onclick')).toBe("window.app.nav.showTab('wholesale-outstanding')");
        expect(host.querySelector('[data-reminder="collect"] button').getAttribute('onclick')).toBe("window.app.day.openDues('retail')");
        expect(host.querySelector('[data-reminder="pay"]').textContent).toContain('Farmer Ram');
        expect(host.querySelector('[data-reminder="rent"]')).toBeNull();
    });

    test('rent due shows for a rentals role once Rentals was opened this month', () => {
        AppState.userRole = 'owner';
        saveRentReminder(localStorage, { uid: 'u1', month: '2026-11', due: 12000, late: 2, dueUnits: 3, at: TODAY.getTime() });
        DayManager.renderReminders(TODAY);
        const rent = document.querySelector('[data-reminder="rent"]').textContent;
        expect(rent).toContain('₹12,000');
        expect(rent).toContain('3 units owe rent · 2 late');
    });

    test('a member without Wholesale sees no wholesale party', () => {
        AppState.userRole = 'staff';
        AppState.settings = { roleAccess: { staff: { wholesale: false } } };
        DayManager.renderReminders(TODAY);
        expect(document.querySelector('[data-reminder="collect"]').textContent).toContain('Ravi');
        expect(document.querySelector('[data-reminder="collect_wholesale"]')).toBeNull();
    });

    test('Hindi', () => {
        setLang('hi');
        AppState.userRole = 'owner';
        DayManager.renderReminders(TODAY);
        const host = document.getElementById('todayReminders');
        expect(host.querySelector('.today-reminders-title').textContent).toBe('याद दिलाना');
        expect(host.querySelector('[data-reminder="pay"]').textContent).toContain('33 दिन');
    });
});
