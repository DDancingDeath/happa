// -------------------- AUTHENTICATION MODULE --------------------

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { t } from '../i18n/index.js';
import { APP_IDENTITY } from '../config/app-identity.js';

const usersCollection = () => (window.getCollection ? window.getCollection('users') : 'users');

const AuthManager = {
    authFlowInProgress: false,

    // Creates the pending Firestore profile for an auth user that doesn't have one yet.
    // Runs in a transaction (which always reads from the server, never the offline cache)
    // so an existing - possibly already approved - profile is never overwritten.
    // Returns true if a profile was created, false if one already existed.
    async createPendingProfile(user, name, email) {
        const db = firebase.firestore();
        const ref = db.collection(usersCollection()).doc(user.uid);
        return db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (snap.exists) {
                return false;
            }
            tx.set(ref, {
                name: name || email.split('@')[0],
                email: email,
                role: 'staff', // Default role for new registrations - can be changed by admin
                status: 'pending',
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            return true;
        });
    },

    // An auth account can exist without a Firestore profile if an earlier registration was
    // interrupted. Sign in with the supplied password and finish creating the profile.
    async recoverExistingRegistration(name, email, password) {
        let credential;
        try {
            credential = await firebase.auth().signInWithEmailAndPassword(email, password);
        } catch (e) {
            return t('msg.auth.already_registered_forgot');
        }
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
    },

    // Handle login
    async handleLogin() {
        // Check Firebase initialization
        if (typeof firebase === 'undefined') {
            UIManager.showToast(t('msg.auth.firebase_not_loaded_refresh_page'));
            console.error('Firebase is undefined!');
            return;
        }
        
        const emailInput = document.getElementById('loginEmail');
        const passwordInput = document.getElementById('loginPassword');
        
        if (!emailInput || !passwordInput) {
            UIManager.showToast(t('msg.auth.form_elements_not_found'));
            console.error('Form inputs not found!');
            return;
        }
        
        const email = emailInput.value.trim();
        const password = passwordInput.value;
        
        if (!email || !password) {
            UIManager.showToast(t('msg.auth.enter_email_password'));
            return;
        }
        
        UIManager.showLoading();
        
        try {
            const userCredential = await firebase.auth().signInWithEmailAndPassword(email, password);
            
            const userId = userCredential.user.uid;
            const userRef = firebase.firestore().collection(usersCollection()).doc(userId);
            let userDoc = await userRef.get();
            
            if (!userDoc.exists) {
                // Orphaned auth account (interrupted registration): create the pending profile
                // so the user isn't stuck between "please register" and "email already in use".
                const created = await this.createPendingProfile(userCredential.user, '', email);
                if (created) {
                    await firebase.auth().signOut();
                    UIManager.hideLoading();
                    UIManager.showToast(t('msg.common.account_pending_approval_wait_admin'));
                    return;
                }
                // The profile exists on the server; the first read came from a stale cache.
                userDoc = await userRef.get({ source: 'server' });
            }
            
            if (userDoc.data().status === 'pending') {
                // Re-check the server so a stale cached copy can't hide a recent approval
                userDoc = await userRef.get({ source: 'server' }).catch(() => userDoc);
            }
            
            const userData = userDoc.data();
            
            if (userData.status === 'pending') {
                await firebase.auth().signOut();
                UIManager.hideLoading();
                UIManager.showToast(t('msg.common.account_pending_approval_wait_admin'));
                return;
            }
            
            if (userData.status === 'rejected') {
                await firebase.auth().signOut();
                UIManager.hideLoading();
                UIManager.showToast(t('msg.common.account_has_been_rejected_contact'));
                return;
            }
            
            AppState.currentUser = userCredential.user;
            AppState.userRole = userData.role || 'staff';
            AppState.userName = userData.name || 'User';
            
            UIManager.showToast(t('msg.auth.login_successful'));
            
            // Hide auth screen and initialize app
            document.getElementById('authScreen').style.display = 'none';
            
            // Initialize the app
            if (window.initializeApp) {
                await window.initializeApp();
            }
            
            UIManager.hideLoading();
            
        } catch (error) {
            console.error('Login error:', error);
            console.error('Error code:', error.code);
            console.error('Error message:', error.message);
            console.error('Error stack:', error.stack);
            
            UIManager.hideLoading();
            
            const reasons = {
                'auth/invalid-email': 'msg.auth.err_invalid_email',
                'auth/user-disabled': 'msg.auth.err_user_disabled',
                'auth/user-not-found': 'msg.auth.err_user_not_found',
                'auth/wrong-password': 'msg.auth.err_wrong_password',
                'auth/invalid-credential': 'msg.auth.err_invalid_credential',
                'auth/network-request-failed': 'msg.auth.err_network',
                'auth/too-many-requests': 'msg.auth.err_too_many_requests'
            };
            const reason = reasons[error.code] ? t(reasons[error.code]) : error.message;
            UIManager.showToast(t('msg.auth.login_failed', { reason }), 4000);
        }
    },

    // Handle registration
    async handleRegister() {
        const name = document.getElementById('registerName').value.trim();
        const email = document.getElementById('registerEmail').value.trim();
        const password = document.getElementById('registerPassword').value;
        const confirmPassword = document.getElementById('registerConfirmPassword')?.value;
        
        if (!name || !email || !password) {
            UIManager.showToast(t('msg.auth.fill_all_fields'));
            return;
        }
        
        if (confirmPassword && password !== confirmPassword) {
            UIManager.showToast(t('msg.auth.passwords_do_not_match'));
            return;
        }
        
        if (password.length < 6) {
            UIManager.showToast(t('msg.auth.password_must_at_least_6'));
            return;
        }
        
        UIManager.showLoading();
        // Suppresses the app's onAuthStateChanged initialization for the temporary sign-ins below
        this.authFlowInProgress = true;
        
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
            
            UIManager.hideLoading();
            UIManager.showToast(t('msg.auth.registration_successful_wait_admin_approval'));
            
            this.showAuthTab('login');
            
        } catch (error) {
            console.error('Registration error:', error);
            
            if (error.code === 'auth/email-already-in-use') {
                try {
                    const message = await this.recoverExistingRegistration(name, email, password);
                    UIManager.hideLoading();
                    if (message) {
                        UIManager.showToast(message, 4000);
                    } else {
                        UIManager.showToast(t('msg.auth.registration_successful_wait_admin_approval'));
                    }
                    this.showAuthTab('login');
                    return;
                } catch (recoveryError) {
                    console.error('Registration recovery error:', recoveryError);
                    error = recoveryError;
                }
            }
            
            UIManager.hideLoading();
            
            const reasons = {
                'auth/email-already-in-use': 'msg.auth.err_email_in_use',
                'auth/invalid-email': 'msg.auth.err_invalid_email',
                'auth/weak-password': 'msg.auth.err_weak_password'
            };
            const reason = reasons[error.code] ? t(reasons[error.code]) : error.message;
            UIManager.showToast(t('msg.auth.registration_failed', { reason }), 4000);
        } finally {
            this.authFlowInProgress = false;
        }
    },

    // Handle forgot password
    async handleForgotPassword() {
        const emailInput = document.getElementById('loginEmail');
        let email = emailInput?.value?.trim();
        
        if (!email) {
            email = prompt(t('msg.auth.enter_email_address_reset_password'));
            if (!email) {
                return;
            }
            email = email.trim();
        }
        
        if (!email) {
            UIManager.showToast(t('msg.auth.enter_email_address'));
            return;
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            UIManager.showToast(t('msg.auth.enter_valid_email_address'));
            return;
        }
        
        try {
            UIManager.showLoading();
            
            // Configure action code settings for password reset
            const actionCodeSettings = {
                url: APP_IDENTITY.siteUrl,
                handleCodeInApp: false
            };
            
            await firebase.auth().sendPasswordResetEmail(email, actionCodeSettings);
            
            UIManager.hideLoading();
            UIManager.showToast(t('msg.auth.password_reset_email_sent_check', { email }), 5000);
        } catch (error) {
            console.error('Password reset error:', error);
            console.error('Error code:', error.code);
            console.error('Error message:', error.message);
            
            UIManager.hideLoading();
            
            const configError = 'msg.auth.err_configuration';
            const reasons = {
                'auth/invalid-email': 'msg.auth.err_invalid_email_format',
                'auth/user-not-found': 'msg.auth.err_reset_user_not_found',
                'auth/network-request-failed': 'msg.auth.err_network',
                'auth/too-many-requests': 'msg.auth.err_too_many_resets',
                'auth/missing-android-pkg-name': configError,
                'auth/missing-continue-uri': configError,
                'auth/missing-ios-bundle-id': configError,
                'auth/invalid-continue-uri': configError,
                'auth/unauthorized-continue-uri': configError
            };
            const reason = reasons[error.code] ? t(reasons[error.code]) : error.message;
            UIManager.showToast(t('msg.auth.reset_email_failed', { reason }), 5000);
        }
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
            UIManager.showToast(t('msg.auth.logout_failed', { message: error.message }));
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

    // Apply role-based UI restrictions
    applyRoleBasedRestrictions() {
        const isOwnerOrManager = AppState.userRole === 'owner' || AppState.userRole === 'manager';
        const isOwner = AppState.userRole === 'owner';
        const isStaff = AppState.userRole === 'staff';
        
        // Update username display in navigation
        const userNameDisplay = document.getElementById('currentUserName');
        if (userNameDisplay) {
            const roleBadge = isOwner ? ' 👑' : (isOwnerOrManager ? ' 🔑' : '');
            userNameDisplay.textContent = (AppState.userName || 'User') + roleBadge;
        }
        
        // Hide/show tabs based on role
        const restrictedTabs = {
            'financeTab': isOwnerOrManager,
            'analyticsTab': isOwnerOrManager,
            'salesTab': !isStaff
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
                if (tabId === 'finance' && !isOwnerOrManager) {
                    item.style.display = 'none';
                } else if (tabId === 'finance' && isOwnerOrManager) {
                    item.style.display = 'block';
                }
                
                if (tabId === 'analytics' && !isOwnerOrManager) {
                    item.style.display = 'none';
                } else if (tabId === 'analytics' && isOwnerOrManager) {
                    item.style.display = 'block';
                }
                
                // Anomalies (#187): owner/manager only until #84 decides otherwise
                if (tabId === 'anomalies') {
                    item.style.display = isOwnerOrManager ? 'block' : 'none';
                }
                
                // Rate trends (#65): owner/manager only (purchase and wholesale rates)
                if (tabId === 'rate-trends') {
                    item.style.display = isOwnerOrManager ? 'block' : 'none';
                }

                // App health / Test in Production (#217): owner/manager only
                if (tabId === 'health') {
                    item.style.display = isOwnerOrManager ? 'block' : 'none';
                }
                
                // Diagnostics: owner; managers see only Number checks (#216)
                if (tabId === 'diagnostics') {
                    item.style.display = isOwnerOrManager ? 'block' : 'none';
                }
                
                if (tabId === 'admin' && !isOwner) {
                    item.style.display = 'none';
                } else if (tabId === 'admin' && isOwner) {
                    item.style.display = 'block';
                }
                
                if (tabId === 'sales' && isStaff) {
                    item.style.display = 'none';
                } else if (tabId === 'sales' && !isStaff) {
                    item.style.display = 'block';
                }
                
                if (tabId === 'wholesale-sales' && isStaff) {
                    item.style.display = 'none';
                } else if (tabId === 'wholesale-sales' && !isStaff) {
                    item.style.display = 'block';
                }
                
                if (tabId === 'reports' && isStaff) {
                    item.style.display = 'none';
                } else if (tabId === 'reports' && !isStaff) {
                    item.style.display = 'block';
                }
            }
        });
        
        // Restrict sensitive buttons
        const deleteButtons = document.querySelectorAll('[data-requires-owner]');
        deleteButtons.forEach(btn => {
            if (!isOwner) {
                btn.disabled = true;
                btn.style.opacity = '0.5';
                btn.title = 'Only owners can perform this action';
            }
        });
        
        // Restrict data export
        const exportButtons = document.querySelectorAll('[data-requires-manager]');
        exportButtons.forEach(btn => {
            if (!isOwnerOrManager) {
                btn.disabled = true;
                btn.style.opacity = '0.5';
                btn.title = 'Only managers and owners can export data';
            }
        });
    }
};
// Export AuthManager
export { AuthManager };
