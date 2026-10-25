/**
 * @fileoverview Login/register/logout gate (AuthManager, #96): pending,
 * rejected and deleted (no profile) users are signed straight back out;
 * approved and legacy (no status) users get in with their role; registration
 * writes a pending staff profile and never overwrites an existing one.
 */
import { AuthManager } from '../auth/authentication.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

let fake;
let auth;
let toast;

function installFirebase() {
    fake = createFakeFirestore();
    const user = { uid: 'u1', email: 'a@x.com', delete: jest.fn(async () => {}) };
    auth = {
        currentUser: null,
        signInWithEmailAndPassword: jest.fn(async () => ({ user })),
        createUserWithEmailAndPassword: jest.fn(async () => ({ user })),
        signOut: jest.fn(async () => {})
    };
    window.firebase = { ...fake.firebase, auth: () => auth };
    global.firebase = window.firebase;
    return user;
}

function loginForm(email = 'a@x.com', password = 'secret1') {
    document.body.innerHTML = `
      <div id="authScreen" style="display:flex"></div>
      <input id="loginEmail" value="${email}"><input id="loginPassword" value="${password}">
      <div class="auth-tab"></div><div class="auth-tab"></div>
      <form id="loginForm"></form><form id="registerForm"></form>
      <input id="registerName"><input id="registerEmail"><input id="registerPassword"><input id="registerConfirmPassword">
      <div id="toast"></div>`;
}

beforeEach(() => {
    installFirebase();
    loginForm();
    toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    window.initializeApp = jest.fn(async () => {});
    AppState.currentUser = null;
    AppState.userRole = 'staff';
    AppState.userName = 'User';
});

afterEach(() => {
    jest.restoreAllMocks();
    delete window.firebase;
    delete global.firebase;
    delete window.initializeApp;
});

describe('login gate', () => {
    test.each([
        ['pending', 'Your account is pending approval. Please wait for admin approval.'],
        ['rejected', 'Your account has been rejected. Please contact admin.']
    ])('%s user is signed out and kept on the login screen', async (status, message) => {
        fake.seed('users', [{ id: 'u1', name: 'A', email: 'a@x.com', role: 'staff', status }]);
        await AuthManager.handleLogin();
        expect(auth.signOut).toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith(message);
        expect(AppState.currentUser).toBeNull();
        expect(window.initializeApp).not.toHaveBeenCalled();
        expect(document.getElementById('authScreen').style.display).toBe('flex');
    });

    test('approved user gets in with their role and name', async () => {
        fake.seed('users', [{ id: 'u1', name: 'Asha', email: 'a@x.com', role: 'manager', status: 'active' }]);
        await AuthManager.handleLogin();
        expect(auth.signOut).not.toHaveBeenCalled();
        expect(AppState.currentUser.uid).toBe('u1');
        expect(AppState.userRole).toBe('manager');
        expect(AppState.userName).toBe('Asha');
        expect(window.initializeApp).toHaveBeenCalled();
        expect(document.getElementById('authScreen').style.display).toBe('none');
    });

    test('legacy profile without a status counts as approved', async () => {
        fake.seed('users', [{ id: 'u1', name: 'Old', email: 'a@x.com', role: 'owner' }]);
        await AuthManager.handleLogin();
        expect(AppState.userRole).toBe('owner');
        expect(window.initializeApp).toHaveBeenCalled();
    });

    test('a deleted user (no profile) is not let in', async () => {
        await AuthManager.handleLogin();
        expect(auth.signOut).toHaveBeenCalled();
        expect(AppState.currentUser).toBeNull();
        expect(window.initializeApp).not.toHaveBeenCalled();
    });

    // BUG: see #53 — a deleted user's login re-creates their profile as a pending request.
    test.skip('a deleted user does not come back as a pending request', async () => {
        await AuthManager.handleLogin();
        expect(fake.raw('users').has('u1')).toBe(false);
    });

    test('wrong password shows a readable message', async () => {
        auth.signInWithEmailAndPassword.mockRejectedValue(Object.assign(new Error('x'), { code: 'auth/wrong-password' }));
        await AuthManager.handleLogin();
        expect(toast).toHaveBeenCalledWith('Login failed. Incorrect password.', 4000);
        expect(AppState.currentUser).toBeNull();
    });

    test('empty email/password never calls Firebase', async () => {
        loginForm('', '');
        await AuthManager.handleLogin();
        expect(auth.signInWithEmailAndPassword).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith('Please enter email and password');
    });
});

describe('registration', () => {
    function fill(name, email, password, confirm = password) {
        document.getElementById('registerName').value = name;
        document.getElementById('registerEmail').value = email;
        document.getElementById('registerPassword').value = password;
        document.getElementById('registerConfirmPassword').value = confirm;
    }

    test('writes a pending staff profile and signs out', async () => {
        fill('Ravi', 'a@x.com', 'secret1');
        await AuthManager.handleRegister();
        const profile = fake.raw('users').get('u1');
        expect(profile).toMatchObject({ name: 'Ravi', email: 'a@x.com', role: 'staff', status: 'pending' });
        expect(Object.keys(profile).sort()).toEqual(['createdAt', 'email', 'name', 'role', 'status']);
        expect(auth.signOut).toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith('Registration successful! Please wait for admin approval.');
    });

    test('never overwrites an existing (possibly approved) profile', async () => {
        fake.seed('users', [{ id: 'u1', name: 'Boss', email: 'a@x.com', role: 'owner', status: 'active' }]);
        expect(await AuthManager.createPendingProfile({ uid: 'u1' }, 'Ravi', 'a@x.com')).toBe(false);
        expect(fake.raw('users').get('u1')).toMatchObject({ role: 'owner', status: 'active' });
    });

    test.each([
        [['', 'a@x.com', 'secret1'], 'Please fill all fields'],
        [['Ravi', 'a@x.com', 'secret1', 'other12'], 'Passwords do not match'],
        [['Ravi', 'a@x.com', '12345'], 'Password must be at least 6 characters']
    ])('validates the form %#', async (args, message) => {
        fill(...args);
        await AuthManager.handleRegister();
        expect(auth.createUserWithEmailAndPassword).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith(message);
    });
});

describe('logout', () => {
    beforeEach(() => {
        AppState.currentUser = { uid: 'u1' };
        AppState.userRole = 'owner';
        AppState.userName = 'Boss';
        AppState.purchaseHistory = [{ id: 'p1' }];
    });
    afterEach(() => { AppState.purchaseHistory = []; });

    test('signs out and resets the user in AppState', async () => {
        jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        await AuthManager.handleLogout();
        expect(auth.signOut).toHaveBeenCalled();
        expect(AppState.currentUser).toBeNull();
        expect(AppState.userRole).toBe('staff');
        expect(AppState.userName).toBe('User');
        expect(document.getElementById('authScreen').style.display).toBe('flex');
    });

    test('cancelled confirmation keeps the user signed in', async () => {
        jest.spyOn(UIManager, 'showModal').mockResolvedValue(false);
        await AuthManager.handleLogout();
        expect(auth.signOut).not.toHaveBeenCalled();
        expect(AppState.userRole).toBe('owner');
    });

    // BUG: see #96 — logout keeps the previous user's bills in AppState (next login on a shared phone sees them until listeners refire).
    test.skip('clears the previous user\'s business data from AppState', async () => {
        jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        await AuthManager.handleLogout();
        expect(AppState.purchaseHistory).toEqual([]);
    });
});

describe('role-based restrictions', () => {
    beforeEach(() => {
        document.body.innerHTML = `
          <div id="financeTab"></div><div id="analyticsTab"></div><div id="salesTab"></div>
          <nav class="nav-menu">
            <a onclick="showTab('finance')"></a><a onclick="showTab('admin')"></a>
            <a onclick="showTab('diagnostics')"></a><a onclick="showTab('reports')"></a>
          </nav>
          <button data-requires-owner id="del"></button><button data-requires-manager id="exp"></button>`;
    });
    const shown = (sel) => document.querySelector(sel).style.display;

    test('staff: finance/admin/diagnostics/reports hidden, owner/manager buttons disabled', () => {
        AppState.userRole = 'staff';
        AuthManager.applyRoleBasedRestrictions();
        expect(shown('#financeTab')).toBe('none');
        expect([...document.querySelectorAll('.nav-menu a')].map(a => a.style.display)).toEqual(['none', 'none', 'none', 'none']);
        expect(document.getElementById('del').disabled).toBe(true);
        expect(document.getElementById('exp').disabled).toBe(true);
    });

    // Diagnostics is visible to managers for Number checks only (#216); errors/audit stay owner-only.
    test('manager: finance/reports/diagnostics visible, admin hidden, export allowed', () => {
        AppState.userRole = 'manager';
        AuthManager.applyRoleBasedRestrictions();
        expect([...document.querySelectorAll('.nav-menu a')].map(a => a.style.display)).toEqual(['block', 'none', 'block', 'block']);
        expect(document.getElementById('del').disabled).toBe(true);
        expect(document.getElementById('exp').disabled).toBe(false);
    });

    test('owner: everything visible and enabled', () => {
        AppState.userRole = 'owner';
        AuthManager.applyRoleBasedRestrictions();
        expect([...document.querySelectorAll('.nav-menu a')].every(a => a.style.display === 'block')).toBe(true);
        expect(document.getElementById('del').disabled).toBe(false);
    });

    test('Roles & access (#84): the owner\'s choices per role drive pages and sections', () => {
        AppState.settings.roleAccess = { staff: { reports: true, profit: false }, manager: { finance: false } };
        try {
            AppState.userRole = 'staff';
            AuthManager.applyRoleBasedRestrictions();
            expect([...document.querySelectorAll('.nav-menu a')].map(a => a.style.display)).toEqual(['none', 'none', 'none', 'block']);
            expect(document.body.classList.contains('no-perm-profit')).toBe(true);
            AppState.userRole = 'manager';
            AuthManager.applyRoleBasedRestrictions();
            expect(shown('#financeTab')).toBe('none');
            expect([...document.querySelectorAll('.nav-menu a')].map(a => a.style.display)).toEqual(['none', 'none', 'block', 'block']);
            expect(document.body.classList.contains('no-perm-profit')).toBe(false);
        } finally {
            delete AppState.settings.roleAccess;
        }
    });
});
