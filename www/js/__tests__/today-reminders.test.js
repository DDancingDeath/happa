/**
 * Reminders on Today (#86): udhaar to collect / pay (REM-1) and rent due (REM-2).
 */
import { jest } from '@jest/globals';
import { overdueReminder, saveRentReminder, rentReminder, unitsWithDue } from '../utils/reminders.js';
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
        const collect = host.querySelector('[data-reminder="collect"]').textContent;
        expect(collect).toContain('Hotel Raj');
        expect(collect).toContain('Ravi');
        expect(collect.indexOf('Hotel Raj')).toBeLessThan(collect.indexOf('Ravi'));
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
        const collect = document.querySelector('[data-reminder="collect"]').textContent;
        expect(collect).toContain('Ravi');
        expect(collect).not.toContain('Hotel Raj');
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
