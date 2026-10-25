import {
    normalizeRoleAccess, accessFor, canOpenTab, canEditBillWith, canDeleteBillWith, historyCutoff,
    hiddenPermissionClasses, billCreatedMs, ROLE_ACCESS_DEFAULTS
} from '../utils/role-access.js';
import { NavigationManager } from '../ui/navigation.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe('Roles & access settings (#84)', () => {
    test('missing settings keep today\'s behaviour (and the 2-day edit window of #87)', () => {
        expect(normalizeRoleAccess(undefined)).toEqual(ROLE_ACCESS_DEFAULTS);
        expect(canOpenTab('finance', 'staff')).toBe(false);
        expect(canOpenTab('reports', 'manager')).toBe(true);
        expect(canOpenTab('history', 'staff')).toBe(true);
        expect(accessFor('staff').editDays).toBe(2);
        expect(hiddenPermissionClasses('staff')).toEqual([]);
    });

    test('bad values fall back to defaults, days are clamped whole numbers, unknown keys dropped', () => {
        const n = normalizeRoleAccess({
            staff: { finance: 'yes', profit: false, editDays: 99, historyDays: '7.9', admin: true },
            manager: { editDays: -3, historyDays: 'x' },
            owner: { finance: false }
        });
        expect(n.staff).toMatchObject({ finance: false, profit: false, editDays: 30, historyDays: 7 });
        expect(n.staff).not.toHaveProperty('admin');
        expect(n.manager).toMatchObject({ editDays: 0, historyDays: 0 });
        expect(n).not.toHaveProperty('owner');
    });

    test('the owner always has everything; unknown roles get member access', () => {
        const raw = { manager: { finance: false }, staff: { reports: true, personalExpenses: false } };
        expect(canOpenTab('finance', 'owner', raw)).toBe(true);
        expect(canOpenTab('finance', 'manager', raw)).toBe(false);
        expect(canOpenTab('reports', 'staff', raw)).toBe(true);
        expect(canOpenTab('reports', 'stranger', raw)).toBe(true);
        expect(hiddenPermissionClasses('staff', raw)).toEqual(['no-perm-personalExpenses']);
        expect(hiddenPermissionClasses('owner', raw)).toEqual([]);
    });

    test('billCreatedMs reads a Timestamp, {seconds}, a local estimate; null when missing (#87)', () => {
        expect(billCreatedMs({ createdAt: { toMillis: () => 5 } })).toBe(5);
        expect(billCreatedMs({ createdAt: { seconds: 2, nanoseconds: 5e6 } })).toBe(2005);
        expect(billCreatedMs({ createdAt: 7 })).toBe(7);
        expect(billCreatedMs({})).toBeNull();
        expect(billCreatedMs({ createdAt: 'x' })).toBeNull();
    });

    test('bill edit window counts from the server createdAt, never the client timestamp', () => {
        const at = (ms) => ({ toMillis: () => ms });
        const own = { userId: 'u1', createdAt: at(NOW - DAY) };
        const old = { userId: 'u1', createdAt: at(NOW - 2 * DAY - 1) };
        const member = { uid: 'u1', role: 'staff', now: NOW };
        expect(canEditBillWith(own, member)).toBe(true);
        expect(canEditBillWith(old, member)).toBe(false);
        expect(canEditBillWith({ ...own, userId: 'u2' }, member)).toBe(false);
        expect(canEditBillWith({ userId: 'u1', timestamp: NOW + 30 * DAY }, member)).toBe(false);
        expect(canEditBillWith({ ...old, timestamp: NOW }, member)).toBe(false);
        expect(canEditBillWith({ ...own, userId: 'u2' }, { uid: 'm', role: 'manager', now: NOW })).toBe(true);
        expect(canEditBillWith(old, { uid: 'm', role: 'manager', now: NOW })).toBe(false);
        expect(canEditBillWith(old, { uid: 'o', role: 'owner', now: NOW })).toBe(true);
        expect(canEditBillWith({}, { uid: 'o', role: 'owner', now: NOW })).toBe(true);
        expect(canEditBillWith(old, { ...member, raw: { staff: { editDays: 5 } } })).toBe(true);
        expect(canEditBillWith(own, { ...member, raw: { staff: { editDays: 0 } } })).toBe(false);
    });

    test('bill delete: own bill inside the window (managers too); owner any bill', () => {
        const at = (ms) => ({ toMillis: () => ms });
        const others = { userId: 'u2', createdAt: at(NOW - DAY) };
        expect(canDeleteBillWith(others, { uid: 'm', role: 'manager', now: NOW })).toBe(false);
        expect(canDeleteBillWith({ ...others, userId: 'm' }, { uid: 'm', role: 'manager', now: NOW })).toBe(true);
        expect(canDeleteBillWith({ userId: 'u1', createdAt: at(NOW - 3 * DAY) }, { uid: 'u1', role: 'staff', now: NOW })).toBe(false);
        expect(canDeleteBillWith({ userId: 'u1', timestamp: NOW }, { uid: 'u1', role: 'staff', now: NOW })).toBe(false);
        expect(canDeleteBillWith({ total: 1 }, { uid: 'o', role: 'owner', now: NOW })).toBe(true);
    });

    test('history cutoff: none by default, N days back when set', () => {
        expect(historyCutoff('staff', undefined, NOW)).toBeNull();
        expect(historyCutoff('staff', { staff: { historyDays: 30 } }, NOW)).toBe(NOW - 30 * DAY);
        expect(historyCutoff('owner', { staff: { historyDays: 30 } }, NOW)).toBeNull();
    });
});

describe('direct navigation to a page that is off for the role', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="billing" class="tab"></div><div id="reports" class="tab"></div><nav class="nav-menu"></nav>';
        jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
    });
    afterEach(() => {
        jest.restoreAllMocks();
        AppState.userRole = 'staff';
        delete AppState.settings.roleAccess;
    });

    test('is refused and shows Billing instead; allowed once the owner turns it on', () => {
        AppState.userRole = 'staff';
        NavigationManager.showTabFromNav('reports');
        expect(document.getElementById('reports').classList.contains('active')).toBe(false);
        expect(document.getElementById('billing').classList.contains('active')).toBe(true);
        expect(UIManager.showToast).toHaveBeenCalledWith('This page is turned off for your role. Ask the owner.');

        AppState.settings.roleAccess = { staff: { reports: true } };
        NavigationManager.showTab('reports');
        expect(document.getElementById('reports').classList.contains('active')).toBe(true);
    });
});
