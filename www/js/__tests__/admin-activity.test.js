/**
 * Admin › Users counts and the per-person activity report (#145).
 */
import { jest } from '@jest/globals';
import { userCounts, activityByUser, activityRange, billCreatedMs } from '../utils/user-activity.js';
import { AdminManager } from '../modules/admin.js';
import { AuditService } from '../services/audit.js';
import { AppState } from '../utils/state.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { isRemovedProfile } from '../services/user-admin.js';
import { setLang } from '../i18n/index.js';

const NOW = new Date(2026, 10, 15, 12, 0, 0);
const at = (d, h = 10) => new Date(2026, 10, d, h, 0, 0).getTime();

describe('ADM-1 counts', () => {
    test('roles, waiting for approval and removed', () => {
        const users = [
            { role: 'owner', status: 'approved' }, { role: 'manager' }, { role: 'staff', status: 'approved' }, { role: 'staff' },
            { status: 'pending' }, { role: 'staff', status: 'pending' }, {}, { role: 'staff', status: 'disabled' }, { status: 'rejected' }
        ];
        expect(userCounts(users, isRemovedProfile)).toEqual({ owner: 1, manager: 1, member: 2, pending: 3, removed: 2, active: 4 });
    });
});

describe('activity ranges', () => {
    test('today, last 7 days, this month, last month (local days)', () => {
        expect(activityRange('today', NOW)).toEqual({ from: at(15, 0), to: at(16, 0) });
        expect(activityRange('week', NOW)).toEqual({ from: at(9, 0), to: at(16, 0) });
        expect(activityRange('month', NOW)).toEqual({ from: at(1, 0), to: at(16, 0) });
        expect(activityRange('last_month', NOW)).toEqual({ from: new Date(2026, 9, 1).getTime(), to: at(1, 0) });
    });
});

describe('ADM-2 / ADM-3 per person', () => {
    const bills = [
        { id: 'p1', userId: 'u1', timestamp: at(14), grandTotal: 1000.4 },
        { id: 'p2', userId: 'u1', createdAt: { toDate: () => new Date(at(15)) }, timestamp: at(1), grandTotal: 250 },
        { id: 'w1', createdBy: 'u2', timestamp: at(15, 9), saleTotal: 500, source: 'sales-tab' },
        { id: 'v1', userId: 'u2', timestamp: at(15), grandTotal: 999, voided: true },
        { id: 'o1', userId: 'u2', timestamp: at(15), openingBalance: { due: 100 }, payment: { due: 100 } },
        { id: 'old', userId: 'u1', timestamp: at(2), grandTotal: 70 }
    ];
    const audit = [
        { userId: 'u2', action: 'RECORD_PAYMENT', timestamp: at(15, 11) },
        { userId: 'u2', action: 'CLEAR_DUE', timestamp: at(14) },
        { userId: 'u1', action: 'EDIT_BILL', timestamp: at(13) },
        { userId: 'u1', action: 'VOID_BILL', timestamp: at(13) },
        { userId: 'u3', action: 'LOGIN', timestamp: at(12) },
        { userId: 'u3', action: 'LOGIN', timestamp: at(1) }
    ];

    test('counts bills and totals per author, actions from the audit log, inside the range only', () => {
        const rows = activityByUser({ bills, audit, ...activityRange('week', NOW) });
        expect(rows).toEqual([
            { uid: 'u1', bills: 2, billTotal: 1250, payments: 0, edits: 1, voids: 1, logins: 0, lastActive: at(15) },
            { uid: 'u2', bills: 1, billTotal: 500, payments: 2, edits: 0, voids: 0, logins: 0, lastActive: at(15, 11) },
            { uid: 'u3', bills: 0, billTotal: 0, payments: 0, edits: 0, voids: 0, logins: 1, lastActive: at(12) }
        ]);
    });

    test('a bill counts on the day it was first saved (server time first)', () => {
        expect(billCreatedMs(bills[1])).toBe(at(15));
        expect(billCreatedMs({ date: '14/11/2026' })).toBe(at(14, 0));
        expect(billCreatedMs({})).toBeNull();
    });
});

describe('Admin › Users page', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="adminTabsContainer"></div><div id="adminContainer"></div>';
        AppState.userRole = 'owner';
        AppState.currentUser = { uid: 'o1' };
        AppState.purchaseHistory = [{ id: 'p1', userId: 'm1', timestamp: Date.now(), grandTotal: 1234 }];
        AppState.retailSalesHistory = [];
        AppState.salesHistory = [];
        jest.spyOn(FirebaseService, 'loadUsers').mockResolvedValue([
            { id: 'o1', name: 'Owner', role: 'owner', status: 'approved' },
            { id: 'm1', name: 'Mohan', role: 'manager', status: 'approved' },
            { id: 'n1', name: 'New', status: 'pending' }
        ]);
    });
    afterEach(() => {
        jest.restoreAllMocks();
        setLang('en');
        AppState.userRole = null;
        AppState.currentUser = null;
        AppState.purchaseHistory = [];
    });

    test('shows the counts and, on tap, each person\'s activity', async () => {
        const since = jest.spyOn(AuditService, 'getLogsSince').mockResolvedValue([
            { userId: 'm1', action: 'RECORD_PAYMENT', timestamp: Date.now() }
        ]);
        await AdminManager.renderUsers();
        expect(document.getElementById('adminUserCounts').textContent)
            .toBe('Owner 1 · Managers 1 · Members 0 · Waiting for approval 1 · Removed 0');
        expect(since).not.toHaveBeenCalled();

        await AdminManager.showActivity('today');
        expect(since).toHaveBeenCalledWith(activityRange('today').from, 300);
        const row = document.querySelector('#adminActivity tr[data-uid="m1"]');
        expect([...row.cells].slice(0, 6).map(c => c.textContent)).toEqual(['Mohan', '1', '₹1,234', '1', '0', '0']);
        expect(document.querySelector('#adminActivityRange .active').dataset.range).toBe('today');
    });

    test('an audit read failure still shows the bills and says what is missing', async () => {
        jest.spyOn(AuditService, 'getLogsSince').mockRejectedValue(Object.assign(new Error('x'), { code: 'unavailable' }));
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        await AdminManager.renderUsers();
        await AdminManager.showActivity('week');
        expect(document.getElementById('adminActivity').textContent).toContain('The audit log could not be read');
        expect(document.querySelector('#adminActivity tr[data-uid="m1"]')).not.toBeNull();
    });

    test('managers never read the audit log', async () => {
        const since = jest.spyOn(AuditService, 'getLogsSince').mockResolvedValue([]);
        await AdminManager.renderUsers();
        AppState.userRole = 'manager';
        await AdminManager.showActivity('week');
        expect(since).not.toHaveBeenCalled();
    });

    test('Hindi', async () => {
        setLang('hi');
        jest.spyOn(AuditService, 'getLogsSince').mockResolvedValue([]);
        await AdminManager.renderUsers();
        expect(document.getElementById('adminUserCounts').textContent).toBe('मालिक 1 · मैनेजर 1 · सदस्य 0 · मंज़ूरी बाकी 1 · हटाए गए 0');
    });
});
