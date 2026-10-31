// -------------------- AUTHENTICATION MODULE --------------------

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { t } from '../i18n/index.js';
import { APP_IDENTITY } from '../config/app-identity.js';
import { canOpenPage, hiddenPermissionClasses } from '../utils/role-access.js';
import { userProfile, createProfileIfMissing } from '../firebase/repos/users.js';
import { afterLoginFailure, loginWaitMs, waitParts } from '../utils/login-backoff.js';
import { safeSetItem } from '../utils/storage-full.js';

const BACKOFF_KEY = 'happaLoginBackoff';

const readBackoff = () => {
    try {
        return JSON.parse(localStorage.getItem(BACKOFF_KEY) || 'null');
    } catch (_) {
        return null;
    }
};

const clearBackoff = () => {
    try { localStorage.removeItem(BACKOFF_KEY); } catch (_) { /* nothing stored */ }
};

/** "Try again in N s / N min" for a sign-in wait (#105). */
function loginWaitText(ms) {
    const p = waitParts(ms);
    return 'minutes' in p ? t('msg.auth.wait_minutes', p) : t('msg.auth.wait_seconds', p);
}

const FORM_IDS = { login: 'loginForm', register: 'registerForm', reset: 'resetForm' };

const NETWORK = 'msg.auth.err_network';
const NOT_ALLOWED = 'msg.auth.err_operation_not_allowed';
const CONFIG_ERROR = 'msg.auth.err_configuration';

/** Firebase Auth error code -> catalogue key, per flow (login / register / reset). */
const AUTH_ERROR_KEYS = {
    login: {
        'auth/user-not-found': 'msg.auth.err_user_not_found',
        'auth/wrong-password': 'msg.auth.err_wrong_password',
        // Returned instead of the two above while email enumeration protection is on
        'auth/invalid-credential': 'msg.auth.err_invalid_credential',
        'auth/invalid-login-credentials': 'msg.auth.err_invalid_credential',
        'auth/invalid-email': 'msg.auth.err_invalid_email',
        'auth/too-many-requests': 'msg.auth.err_too_many_requests',
        'auth/network-request-failed': NETWORK,
        'auth/user-disabled': 'msg.auth.err_user_disabled',
        'auth/operation-not-allowed': NOT_ALLOWED
    },
    register: {
        'auth/email-already-in-use': 'msg.auth.err_email_in_use',
        'auth/invalid-email': 'msg.auth.err_invalid_email',
        'auth/weak-password': 'msg.auth.err_weak_password',
        'auth/too-many-requests': 'msg.auth.err_too_many_requests',
        'auth/network-request-failed': NETWORK,
        'auth/operation-not-allowed': NOT_ALLOWED
    },
    reset: {
        'auth/invalid-email': 'msg.auth.err_invalid_email_format',
        'auth/user-not-found': 'msg.auth.err_reset_user_not_found',
        'auth/user-disabled': 'msg.auth.err_user_disabled',
        'auth/network-request-failed': NETWORK,
        'auth/too-many-requests': 'msg.auth.err_too_many_resets',
        'auth/operation-not-allowed': NOT_ALLOWED,
        'auth/missing-android-pkg-name': CONFIG_ERROR,
        'auth/missing-continue-uri': CONFIG_ERROR,
        'auth/missing-ios-bundle-id': CONFIG_ERROR,
        'auth/invalid-continue-uri': CONFIG_ERROR,
        'auth/unauthorized-continue-uri': CONFIG_ERROR
    }
};

/**
 * Readable text for a failed sign-in / registration / reset, in the app language.
 * Unknown errors fall back to a generic message that names the code.
 * @param {{code?: string}|null|undefined} error
 * @param {'login'|'register'|'reset'} flow
 * @returns {string}
 */
function authErrorMessage(error, flow) {
    const code = error?.code;
    const key = code && AUTH_ERROR_KEYS[flow]?.[code];
    return key ? t(key) : t('msg.auth.err_unknown', { code: code || 'unknown' });
}

const AuthManager = {
    authFlowInProgress: false,
    busy: { login: false, register: false, reset: false },

    /**
     * Writes `text` into the card's inline message area (above its button).
     * textContent only, so nothing in the text is ever parsed as HTML.
     * Falls back to a toast if the area isn't on the page.
     * @param {'login'|'register'} form
     * @param {string} text
     * @param {'error'|'success'|'info'} [kind]
     */
    showMessage(form, text, kind = 'error') {
        const el = document.getElementById(`${form}Message`);
        if (!el) {
            UIManager.showToast(text, 4000);
            return;
        }
        el.classList.remove('error', 'success', 'info');
        el.classList.add(kind);
        el.textContent = text;
    },

    clearMessage(form) {
        const el = document.getElementById(`${form}Message`);
        if (el) el.textContent = '';
    },

    /**
     * Show-password eye (#105): switches the field between hidden and plain text.
     * @param {string} inputId
     * @param {HTMLElement} [btn] - the eye button (its pressed state and label follow)
     * @returns {boolean} true when the password is now shown
     */
    togglePassword(inputId, btn) {
        const input = document.getElementById(inputId);
        if (!input) return false;
        const show = input.type === 'password';
        this.setPasswordShown(input, btn || document.querySelector(`[data-password-toggle="${inputId}"]`), show);
        input.focus();
        return show;
    },

    setPasswordShown(input, btn, show) {
        input.type = show ? 'text' : 'password';
        // A toggle button: the label stays "Show password", the pressed state says whether it is shown
        if (btn) btn.setAttribute('aria-pressed', String(show));
    },

    /** Every password field back to hidden (switching cards, after signing in). */
    hidePasswords() {
        document.querySelectorAll('[data-password-toggle]').forEach(btn => {
            const input = document.getElementById(btn.dataset.passwordToggle);
            if (input) this.setPasswordShown(input, btn, false);
        });
    },

    /** Loading state on the card's submit button; disabled so a double tap can't submit twice. */
    setBusy(form, busy, labelKey) {
        if (form in this.busy) this.busy[form] = busy;
        const btn = document.querySelector(`#${FORM_IDS[form] || 'loginForm'} button[type="submit"]`);
        if (!btn) return;
        if (busy) {
            if (btn.dataset.idleLabel === undefined) btn.dataset.idleLabel = btn.textContent;
            if (labelKey) btn.textContent = t(labelKey);
            btn.disabled = true;
            btn.setAttribute('aria-busy', 'true');
        } else {
            if (btn.dataset.idleLabel !== undefined) btn.textContent = btn.dataset.idleLabel;
            delete btn.dataset.idleLabel;
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
        }
    },

    // Creates the pending Firestore profile for an auth user that doesn't have one yet.
    // Runs in a transaction (which always reads from the server, never the offline cache)
    // so an existing - possibly already approved - profile is never overwritten.
    // Returns true if a profile was created, false if one already existed.
    async createPendingProfile(user, name, email) {
        return createProfileIfMissing(user.uid, {
            name: name || email.split('@')[0],
            email: email,
            role: 'staff', // Default role for new registrations - can be changed by admin
            status: 'pending'
        });
    },

    // An auth account can exist without a Firestore profile if an earlier registration was
    // interrupted. Sign in with the supplied password and finish creating the profile.
    // This is a password try too, so it shares the Login card's backoff (#105).
    async recoverExistingRegistration(name, email, password) {
        const wait = loginWaitMs(readBackoff(), Date.now());
        if (wait > 0) return loginWaitText(wait);
        let credential;
        try {
            credential = await firebase.auth().signInWithEmailAndPassword(email, password);
        } catch (e) {
            const backoff = afterLoginFailure(readBackoff(), Date.now(), e?.code);
            safeSetItem(BACKOFF_KEY, JSON.stringify(backoff));
            const after = loginWaitMs(backoff, Date.now());
            return after > 0
                ? `${t('msg.auth.already_registered_forgot')} ${loginWaitText(after)}`
                : t('msg.auth.already_registered_forgot');
        }
        clearBackoff();
        try {
            const created = await this.createPendingProfile(credential.user, name, email);
            return created ? null : t('msg.auth.already_registered_login');
        } finally {
            await firebase.auth().signOut();
        }
    },

    // Show/Hide authentication tabs
    showAuthTab(tab) {
        const tabs = document.querySelectorAll('.auth-tab');
        const loginForm = document.getElementById('loginForm');
        const registerForm = document.getElementById('registerForm');
        
        if (!loginForm || !registerForm) {
            console.error('Forms not found!');
            return false;
        }
        
        if (tabs.length < 2) {
            console.error('Not enough tabs found!');
            return false;
        }
        
        // Remove active from all tabs and hide all forms
        tabs.forEach((t, i) => {
            t.classList.remove('active');
        });
        loginForm.classList.add('hidden');
        registerForm.classList.add('hidden');
        this.clearMessage('login');
        this.clearMessage('register');
        this.hidePasswords();
        
        // Show selected tab
        if (tab === 'login') {
            tabs[0].classList.add('active');
            loginForm.classList.remove('hidden');
        } else if (tab === 'register') {
            tabs[1].classList.add('active');
            registerForm.classList.remove('hidden');
        }
        
        return false;
    },

    // Initialize auth tab switching
    initAuthTabs() {
        const tabs = document.querySelectorAll('.auth-tab');
        if (tabs.length === 0) {
            setTimeout(() => this.initAuthTabs(), 10);
            return;
        }
        tabs.forEach((tab, index) => {
            tab.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                const tabType = index === 0 ? 'login' : 'register';
                AuthManager.showAuthTab(tabType);
            });
        });
        // Editing a field clears that card's message
        Object.entries(FORM_IDS).forEach(([form, id]) => {
            document.getElementById(id)?.addEventListener('input', () => this.clearMessage(form));
        });
    },

    // Handle login
    async handleLogin() {
        if (this.busy.login || this.busy.reset) return;
        this.clearMessage('login');

        // Check Firebase initialization
        if (typeof firebase === 'undefined') {
            this.showMessage('login', t('msg.auth.firebase_not_loaded_refresh_page'));
            console.error('Firebase is undefined!');
            return;
        }
        
        const emailInput = document.getElementById('loginEmail');
        const passwordInput = document.getElementById('loginPassword');
        
        if (!emailInput || !passwordInput) {
            this.showMessage('login', t('msg.auth.form_elements_not_found'));
            console.error('Form inputs not found!');
            return;
        }
        
        const email = emailInput.value.trim();
        const password = passwordInput.value;
        
        if (!email || !password) {
            this.showMessage('login', t('msg.auth.enter_email_password'));
            return;
        }
        
        // Too many wrong tries on this phone: wait first (#105)
        const wait = loginWaitMs(readBackoff(), Date.now());
        if (wait > 0) {
            this.showMessage('login', loginWaitText(wait));
            return;
        }
        
        this.setBusy('login', true, 'ui.auth.signing_in');
        
        try {
            const userCredential = await firebase.auth().signInWithEmailAndPassword(email, password);
            clearBackoff();
            
            const userId = userCredential.user.uid;
            const profile = userProfile(userId);
            let userDoc = await profile.read();
            
            if (!userDoc.exists) {
                // Orphaned auth account (interrupted registration): create the pending profile
                // so the user isn't stuck between "please register" and "email already in use".
                const created = await this.createPendingProfile(userCredential.user, '', email);
                if (created) {
                    await firebase.auth().signOut();
                    this.showMessage('login', t('msg.common.account_pending_approval_wait_admin'), 'info');
                    return;
                }
                // The profile exists on the server; the first read came from a stale cache.
                userDoc = await profile.read({ source: 'server' });
            }
            
            if (userDoc.data.status === 'pending') {
                // Re-check the server so a stale cached copy can't hide a recent approval
                userDoc = await profile.read({ source: 'server' }).catch(() => userDoc);
            }
            
            const userData = userDoc.data;
            
            if (userData.status === 'pending') {
                await firebase.auth().signOut();
                this.showMessage('login', t('msg.common.account_pending_approval_wait_admin'), 'info');
                return;
            }
            
            if (userData.status === 'rejected' || userData.status === 'disabled') {
                await firebase.auth().signOut();
                this.showMessage('login', t(userData.status === 'disabled' ? 'msg.common.account_removed_contact_owner' : 'msg.common.account_has_been_rejected_contact'));
                return;
            }
            
            AppState.currentUser = userCredential.user;
            AppState.userRole = userData.role || 'staff';
            AppState.userName = userData.name || 'User';
            
            UIManager.showToast(t('msg.auth.login_successful'));
            this.hidePasswords();
            
            // Hide auth screen and initialize app
            document.getElementById('authScreen').style.display = 'none';
            
            // Initialize the app
            if (window.initializeApp) {
                await window.initializeApp();
            }
            
        } catch (error) {
            console.error('Login error:', error?.code, error?.message);
            const backoff = afterLoginFailure(readBackoff(), Date.now(), error?.code);
            safeSetItem(BACKOFF_KEY, JSON.stringify(backoff));
            const wait = loginWaitMs(backoff, Date.now());
            this.showMessage('login', wait > 0
                ? `${authErrorMessage(error, 'login')} ${loginWaitText(wait)}`
                : authErrorMessage(error, 'login'));
        } finally {
            this.setBusy('login', false);
            UIManager.hideLoading();
        }
    },

    // Handle registration
    async handleRegister() {
        if (this.busy.register) return;
        this.clearMessage('register');

        const name = document.getElementById('registerName').value.trim();
        const email = document.getElementById('registerEmail').value.trim();
        const password = document.getElementById('registerPassword').value;
        const confirmPassword = document.getElementById('registerConfirmPassword')?.value;
        
        if (!name || !email || !password) {
            this.showMessage('register', t('msg.auth.fill_all_fields'));
            return;
        }
        
        if (confirmPassword && password !== confirmPassword) {
            this.showMessage('register', t('msg.auth.passwords_do_not_match'));
            return;
        }
        
        if (password.length < 6) {
            this.showMessage('register', t('msg.auth.password_must_at_least_6'));
            return;
        }
        
        this.setBusy('register', true, 'ui.auth.creating_account');
        // Suppresses the app's onAuthStateChanged initialization for the temporary sign-ins below
        this.authFlowInProgress = true;
        
        // After a successful registration the user is sent to the Login card with the result there
        const doneOnLoginCard = (text) => {
            this.showAuthTab('login');
            this.showMessage('login', text, 'success');
        };
        
        try {
            const userCredential = await firebase.auth().createUserWithEmailAndPassword(email, password);
            
            try {
                await this.createPendingProfile(userCredential.user, name, email);
            } catch (profileError) {
                // Roll back so a retry doesn't fail with "email already in use"
                await userCredential.user.delete().catch(() => {});
                throw profileError;
            }
            
            await firebase.auth().signOut();
            
            doneOnLoginCard(t('msg.auth.registration_successful_wait_admin_approval'));
            
        } catch (error) {
            console.error('Registration error:', error?.code, error?.message);
            
            if (error.code === 'auth/email-already-in-use') {
                try {
                    const message = await this.recoverExistingRegistration(name, email, password);
                    if (message) {
                        this.showAuthTab('login');
                        this.showMessage('login', message, 'info');
                    } else {
                        doneOnLoginCard(t('msg.auth.registration_successful_wait_admin_approval'));
                    }
                    return;
                } catch (recoveryError) {
                    console.error('Registration recovery error:', recoveryError);
                    error = recoveryError;
                }
            }
            
            this.showMessage('register', authErrorMessage(error, 'register'));
        } finally {
            this.authFlowInProgress = false;
            this.setBusy('register', false);
            UIManager.hideLoading();
        }
    },

    // "Forgot password?" opens an email field on the Login card
    handleForgotPassword() {
        const form = document.getElementById('resetForm');
        const toggle = document.getElementById('resetToggle');
        if (!form) return;
        const open = form.hidden;
        form.hidden = !open;
        toggle?.setAttribute('aria-expanded', String(open));
        if (!open) return;
        const resetEmail = document.getElementById('resetEmail');
        const loginEmail = document.getElementById('loginEmail')?.value?.trim();
        if (resetEmail && !resetEmail.value && loginEmail) resetEmail.value = loginEmail;
        resetEmail?.focus();
    },

    // Sends the reset link; the result is shown in the Login card's message area
    async handleSendPasswordReset() {
        if (this.busy.reset || this.busy.login) return;
        this.clearMessage('login');

        const email = document.getElementById('resetEmail')?.value?.trim();
        if (!email) {
            this.showMessage('login', t('msg.auth.enter_email_address'));
            return;
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            this.showMessage('login', t('msg.auth.enter_valid_email_address'));
            return;
        }
        
        this.setBusy('reset', true);
        this.showMessage('login', t('msg.auth.sending_reset_email'), 'info');
        
        try {
            // Configure action code settings for password reset
            const actionCodeSettings = {
                url: APP_IDENTITY.siteUrl,
                handleCodeInApp: false
            };
            
            await firebase.auth().sendPasswordResetEmail(email, actionCodeSettings);
            
            this.showMessage('login', t('msg.auth.password_reset_email_sent_check', { email }), 'success');
        } catch (error) {
            console.error('Password reset error:', error?.code, error?.message);
            this.showMessage('login', t('msg.auth.reset_email_failed', { reason: authErrorMessage(error, 'reset') }));
        } finally {
            this.setBusy('reset', false);
            UIManager.hideLoading();
        }
    },

    /**
     * Shows a result of the app's own sign-in checks (pending / rejected / no profile /
     * outdated app) on the Login card, e.g. when the check runs from onAuthStateChanged.
     */
    showLoginNotice(text, kind = 'error') {
        this.showMessage('login', text, kind);
    },

    // Handle logout
    async handleLogout() {
        const confirmed = await UIManager.showModal(t('msg.auth.are_sure_want_logout'), t('msg.auth.confirm_logout'), true);
        
        if (!confirmed) return;
        
        UIManager.showLoading();
        
        try {
            await firebase.auth().signOut();
            AppState.currentUser = null;
            AppState.userRole = 'staff';
            AppState.userName = 'User';
            
            document.getElementById('authScreen').style.display = 'flex';
            UIManager.hideLoading();
            UIManager.showToast(t('msg.auth.logged_out_successfully'));
        } catch (error) {
            console.error('Logout error:', error);
            UIManager.hideLoading();
            UIManager.showToast(t('msg.auth.logout_failed', { message: authErrorMessage(error, 'login') }));
        }
    },

    // Update user display in settings
    updateUserDisplay() {
        const userNameDisplay = document.getElementById('userNameDisplay');
        const userRoleDisplay = document.getElementById('userRoleDisplay');
        const userEmailDisplay = document.getElementById('userEmail');
        
        if (userNameDisplay) userNameDisplay.textContent = AppState.userName;
        if (userRoleDisplay) userRoleDisplay.textContent = Helpers.roleLabel(AppState.userRole).toUpperCase();
        
        const user = AppState.currentUser || firebase.auth().currentUser;
        if (userEmailDisplay && user) {
            userEmailDisplay.textContent = user.email || '-';
        }
    },

    // Apply role-based UI restrictions (pages and sections per Roles & access, #84)
    applyRoleBasedRestrictions() {
        const isOwnerOrManager = AppState.userRole === 'owner' || AppState.userRole === 'manager';
        const isOwner = AppState.userRole === 'owner';
        const roleAccess = AppState.settings?.roleAccess;
        const mayOpen = (tabId) => canOpenPage(tabId, AppState.userRole, roleAccess);
        
        // Update username display in navigation
        const userNameDisplay = document.getElementById('currentUserName');
        if (userNameDisplay) {
            const roleBadge = isOwner ? ' 👑' : (isOwnerOrManager ? ' 🔑' : '');
            userNameDisplay.textContent = (AppState.userName || 'User') + roleBadge;
        }
        
        // Hide/show tabs based on role
        const restrictedTabs = {
            'salesTab': mayOpen('wholesale-sales')
        };
        
        Object.entries(restrictedTabs).forEach(([tabId, allowed]) => {
            const tab = document.getElementById(tabId);
            if (tab) {
                tab.style.display = allowed ? 'block' : 'none';
            }
        });
        
        // Hide/show nav menu items
        const navItems = document.querySelectorAll('.nav-menu a');
        navItems.forEach(item => {
            const onclick = item.getAttribute('onclick');
            const tabId = onclick?.match(/showTab\('([^']+)'/)?.[1];
            if (tabId) {
                if (['money', 'insights', 'statements', 'wholesale-sales'].includes(tabId)) {
                    item.style.display = mayOpen(tabId) ? '' : 'none';
                }
                
                // Anomalies (#187): owner/manager only until #84 decides otherwise
                if (tabId === 'anomalies') {
                    item.style.display = isOwnerOrManager ? '' : 'none';
                }
                
                // App health / Test in Production (#217): owner/manager only
                if (tabId === 'health') {
                    item.style.display = isOwnerOrManager ? '' : 'none';
                }
                
                // Diagnostics: owner; managers see only Number checks (#216)
                if (tabId === 'diagnostics') {
                    item.style.display = isOwnerOrManager ? '' : 'none';
                }
                
                if (tabId === 'admin' && !isOwner) {
                    item.style.display = 'none';
                } else if (tabId === 'admin' && isOwner) {
                    item.style.display = '';
                }
                
                if (tabId === 'sales') {
                    item.style.display = mayOpen('wholesale-sales') ? '' : 'none';
                }
            }
        });

        // Sections marked data-perm="<permission>" (styles.css hides them via these body classes)
        if (document.body) {
            [...document.body.classList].filter(c => c.startsWith('no-perm-')).forEach(c => document.body.classList.remove(c));
            hiddenPermissionClasses(AppState.userRole, roleAccess).forEach(c => document.body.classList.add(c));
        }
        
        // Restrict sensitive buttons
        const deleteButtons = document.querySelectorAll('[data-requires-owner]');
        deleteButtons.forEach(btn => {
            if (!isOwner) {
                btn.disabled = true;
                btn.style.opacity = '0.5';
                btn.title = t('ui.auth.owner_only');
            }
        });
        
        // Restrict data export
        const exportButtons = document.querySelectorAll('[data-requires-manager]');
        exportButtons.forEach(btn => {
            if (!isOwnerOrManager) {
                btn.disabled = true;
                btn.style.opacity = '0.5';
                btn.title = t('ui.auth.manager_only_export');
            }
        });
    }
};
// Export AuthManager
export { AuthManager, authErrorMessage };
