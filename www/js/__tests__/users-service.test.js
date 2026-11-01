/**
 * @fileoverview User-profile access for admin.js / users.js goes through
 * FirebaseService (#123): env prefix, client-side createdAt ordering, and the
 * exact fields the approve / role-change flows write.
 */
import fs from 'fs';
import path from 'path';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AdminManager } from '../modules/admin.js';
import { UsersManager } from '../modules/users.js';
import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

let fake;

beforeEach(() => {
    fake = createFakeFirestore();
    global.firebase = fake.firebase;
    window.COLLECTION_PREFIX = 'dev_';
    fake.seed('dev_users', [
        { id: 'old', name: 'Old', role: 'staff', status: 'active', createdAt: { toMillis: () => 1000 } },
        { id: 'legacy', name: 'Legacy', role: 'owner' },
        { id: 'new', name: 'New', status: 'pending', createdAt: { toMillis: () => 5000 } },
    ]);
    fake.seed('users', [{ id: 'prod', name: 'Prod user', role: 'owner' }]);
    AppState.currentUser = { uid: 'owner-1' };
    AppState.userRole = 'owner';
});

afterEach(() => {
    delete window.COLLECTION_PREFIX;
});

const userDoc = (id) => fake.raw('dev_users').get(id);

describe('FirebaseService user methods', () => {
    test('loadUsers reads the prefixed collection, newest first, legacy (no createdAt) last', async () => {
        const users = await FirebaseService.loadUsers();
        expect(users.map(u => u.id)).toEqual(['new', 'old', 'legacy']);
        expect(users[0]).toMatchObject({ id: 'new', name: 'New', status: 'pending' });
    });

    test('updateUser / deleteUserProfile touch only the prefixed profile', async () => {
        await FirebaseService.updateUser('old', { role: 'manager' });
        expect(userDoc('old')).toMatchObject({ role: 'manager', status: 'active', name: 'Old' });
        await FirebaseService.deleteUserProfile('legacy');
        expect(userDoc('legacy')).toBeUndefined();
        expect(fake.raw('users').get('prod')).toBeDefined();
    });

    test('countDocuments uses the prefix', async () => {
        expect(await FirebaseService.countDocuments('users')).toBe(3);
        expect(await FirebaseService.countDocuments('empty')).toBe(0);
    });
});

describe('admin flows write the same fields as before', () => {
    test('AdminManager.approveUser sets status, chosen role, approvedAt, approvedBy', async () => {
        document.body.innerHTML = '<select id="role-new"><option value="manager" selected>m</option></select>';
        await AdminManager.approveUser('new');
        expect(userDoc('new')).toMatchObject({ status: 'active', role: 'manager', approvedBy: 'owner-1' });
        expect(typeof userDoc('new').approvedAt).toBe('number');
    });

    test('UsersManager.approveUser / changeUserRole keep their field sets', async () => {
        await UsersManager.approveUser('new', 'staff');
        expect(userDoc('new')).toMatchObject({ status: 'active', role: 'staff' });
        expect(userDoc('new').approvedBy).toBeUndefined();
        await UsersManager.changeUserRole('old', 'manager');
        expect(userDoc('old')).toMatchObject({ role: 'manager' });
        expect(typeof userDoc('old').updatedAt).toBe('number');
    });

    test('admin.js and users.js no longer open Firestore directly', () => {
        for (const file of ['admin.js', 'users.js']) {
            const src = fs.readFileSync(path.join(__dirname, '..', 'modules', file), 'utf8');
            expect(src).not.toMatch(/firebase\.firestore\(\)|\.collection\(/);
        }
    });
});

describe('reset password and remove user (AadhatManagementApp#74)', () => {
    let auth;
    let modal;
    let toast;

    beforeEach(() => {
        auth = { sendPasswordResetEmail: jest.fn(async () => {}) };
        global.firebase = { ...fake.firebase, auth: () => auth };
        modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        jest.spyOn(UIManager, 'showLoading').mockImplementation(() => {});
        jest.spyOn(UIManager, 'hideLoading').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        document.body.innerHTML = '<div id="adminPendingUsers"></div><div id="adminActiveUsers"></div>'
            + '<div id="pendingUsersList"></div><div id="activeUsersList"></div>';
    });

    test('reset sends the Firebase Auth reset email after confirmation', async () => {
        await expect(AdminManager.resetUserPassword('old', 'old@x.com')).resolves.toBe(true);
        expect(modal.mock.calls[0][0]).toContain('old@x.com');
        expect(auth.sendPasswordResetEmail).toHaveBeenCalledWith('old@x.com');
        await expect(UsersManager.resetUserPassword('old', 'old@x.com')).resolves.toBe(true);
        expect(auth.sendPasswordResetEmail).toHaveBeenCalledTimes(2);
    });

    test('reset does nothing when cancelled, without an email, or for a non-owner', async () => {
        modal.mockResolvedValueOnce(false);
        expect(await AdminManager.resetUserPassword('old', 'old@x.com')).toBe(false);
        expect(await AdminManager.resetUserPassword('old', '')).toBe(false);
        AppState.userRole = 'manager';
        expect(await AdminManager.resetUserPassword('old', 'old@x.com')).toBe(false);
        expect(auth.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    test('reset failure is shown, not thrown', async () => {
        auth.sendPasswordResetEmail.mockRejectedValueOnce(new Error('auth/user-not-found'));
        expect(await AdminManager.resetUserPassword('old', 'old@x.com')).toBe(false);
        expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('auth/user-not-found'), 'error');
    });

    test('remove keeps a disabled profile without role, and hides it from both lists', async () => {
        fake.seed('dev_users', [{ id: 'old', name: 'Old', email: 'o@x', role: 'manager', rentRole: 'member', status: 'active', approvedBy: 'owner-1' }]);
        await expect(AdminManager.deleteUser('old', 'Old')).resolves.toBe(true);
        expect(modal.mock.calls[0][0]).toContain('Old');
        const doc = userDoc('old');
        expect(doc).toMatchObject({ status: 'disabled', disabledBy: 'owner-1', name: 'Old', email: 'o@x' });
        expect(doc).not.toHaveProperty('role');
        expect(doc).not.toHaveProperty('rentRole');
        expect(doc).not.toHaveProperty('approvedBy');
        expect(document.getElementById('adminActiveUsers').textContent).not.toContain('Old');
        expect(document.getElementById('adminPendingUsers').textContent).not.toContain('Old');
        await UsersManager.loadUsers();
        expect(document.getElementById('activeUsersList').textContent).not.toContain('Old');
        expect(document.getElementById('pendingUsersList').textContent).not.toContain('Old');
    });

    test('remove is refused when cancelled, for a non-owner, or for yourself', async () => {
        modal.mockResolvedValueOnce(false);
        expect(await UsersManager.deleteUser('old', 'Old')).toBe(false);
        expect(await AdminManager.deleteUser('owner-1', 'Me')).toBe(false);
        AppState.userRole = 'manager';
        expect(await AdminManager.deleteUser('old', 'Old')).toBe(false);
        expect(userDoc('old')).toMatchObject({ role: 'staff', status: 'active' });
    });
});
