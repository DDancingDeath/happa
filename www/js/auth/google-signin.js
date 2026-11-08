/**
 * @fileoverview "Continue with Google" (docs/google-sign-in.md). Loaded with import() only when
 * happa.config.json switches it on (AuthManager.initGoogleSignIn); never precached.
 *  - Web / PWA: signInWithPopup; when the browser can't open the popup, a full-page redirect
 *    (getRedirectResult on the way back, AuthManager.resumeGoogleRedirect).
 *  - Android app: popups and redirects don't work in the WebView, so the native account picker
 *    of @capacitor-firebase/authentication (skipNativeAuth) gives a Google ID token and the JS SDK
 *    signs in with it (signInWithCredential).
 * Either way AuthManager.completeSignIn decides: a new person gets a pending profile and waits
 * for the owner, exactly like an email registration (never approved by the app). An email that
 * already has a password here (auth/account-exists-with-different-credential) is linked after
 * one password sign-in.
 * @module auth/google-signin
 */

import { t } from '../i18n/index.js';
import { markGoogleRedirect, clearGoogleRedirect } from './authentication.js';

const CANCELLED = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled', 'auth/redirect-cancelled-by-user']);
// The browser can't open the popup (blocked, or an environment without popups): redirect instead
const USE_REDIRECT = new Set(['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment']);
// Console setup not done (provider off, domain not authorised, wrong client): docs/google-sign-in.md
const NOT_SET_UP = new Set([
    'auth/operation-not-allowed', 'auth/unauthorized-domain', 'auth/configuration-not-found',
    'auth/invalid-oauth-client-id', 'auth/invalid-api-key', 'auth/app-not-authorized',
    'auth/invalid-oauth-provider', 'auth/admin-restricted-operation', 'auth/unauthorized-continue-uri'
]);
const MESSAGE_KEYS = {
    'auth/network-request-failed': 'msg.auth.err_network',
    'auth/user-disabled': 'msg.auth.err_user_disabled',
    'auth/too-many-requests': 'msg.auth.err_too_many_requests',
    'auth/credential-already-in-use': 'msg.auth.google_in_use',
    'auth/provider-already-linked': 'msg.auth.google_in_use',
    'auth/email-already-in-use': 'msg.auth.google_in_use',
    'auth/invalid-credential': 'msg.auth.google_failed',
    'auth/web-storage-unsupported': 'msg.auth.google_failed',
    'happa/no-id-token': 'msg.auth.google_failed',
    'happa/no-email': 'msg.auth.google_no_email'
};

/**
 * What to do with a failed Google sign-in.
 * Native plugin errors carry no code, only a message (cancelled, no account, DEVELOPER_ERROR).
 * @param {{code?: string, message?: string}} error
 * @returns {{action: 'ignore'|'redirect'|'link'|'message', key?: string, params?: Object}}
 */
export function googleErrorAction(error) {
    const code = error?.code || '';
    const message = String(error?.message || '');
    if (CANCELLED.has(code)) return { action: 'ignore' };
    if (USE_REDIRECT.has(code)) return { action: 'redirect' };
    if (code === 'auth/account-exists-with-different-credential') return { action: 'link' };
    if (NOT_SET_UP.has(code)) return { action: 'message', key: 'msg.auth.google_not_set_up' };
    if (MESSAGE_KEYS[code]) return { action: 'message', key: MESSAGE_KEYS[code] };
    if (!code) {
        if (/cancel/i.test(message)) return { action: 'ignore' };
        // ApiException 10 / DEVELOPER_ERROR: SHA-1 or the web client missing in the Firebase console
        if (/\bDEVELOPER_ERROR\b|^\[?10\]?[:\s]|developer console/i.test(message)) return { action: 'message', key: 'msg.auth.google_not_set_up' };
        return { action: 'message', key: 'msg.auth.google_failed' };
    }
    return { action: 'message', key: 'msg.auth.err_unknown', params: { code } };
}

/** The email Google gave (the account's own, else the Google profile's). */
export function googleEmail(user) {
    if (!user) return null;
    return user.email || (user.providerData || []).find((p) => p?.providerId === 'google.com')?.email || null;
}

function googleProvider() {
    const provider = new firebase.auth.GoogleAuthProvider();
    // Always show the account chooser, so a shared phone can pick the right person
    provider.setCustomParameters({ prompt: 'select_account' });
    return provider;
}

const $ = (id) => document.getElementById(id);

export const GoogleSignIn = {
    busy: false,
    /** { credential, email } while the link form waits for the password */
    pendingLink: null,
    /** The AuthManager whose flow left for Google's page (redirect fallback), until the page is back */
    redirectingFrom: null,

    /**
     * Back (browser Back) from Google's page to this same page from the back/forward cache: no reload,
     * so nothing would finish the redirect. Undo its hold on the app and the button.
     */
    onPageShow(event) {
        const manager = this.redirectingFrom;
        if (!event?.persisted || !manager) return;
        this.redirectingFrom = null;
        clearGoogleRedirect();
        manager.authFlowInProgress = false;
        this.setBusy(false);
    },

    setBusy(busy) {
        this.busy = busy;
        const btn = $('googleSignInBtn');
        if (!btn) return;
        btn.disabled = busy;
        if (busy) btn.setAttribute('aria-busy', 'true');
        else btn.removeAttribute('aria-busy');
    },

    /**
     * The button's tap. Nothing is awaited before the popup opens, so the browser still
     * counts it as the user's tap (no popup blocker).
     * @param {Object} manager - AuthManager
     * @param {'web'|'native'} mode
     */
    async start(manager, mode, win = window) {
        if (this.busy || manager.busy.login || manager.busy.register || manager.busy.googleLink) return;
        manager.clearMessage('google');
        this.closeLink();
        this.setBusy(true);
        // Keeps main.js's onAuthStateChanged from starting the app before the profile check
        manager.authFlowInProgress = true;
        let redirecting = false;
        try {
            const result = await (mode === 'native'
                ? this.nativeSignIn(win)
                : firebase.auth().signInWithPopup(googleProvider()));
            await this.finish(manager, result?.user);
        } catch (error) {
            redirecting = await this.handleError(manager, error, { allowRedirect: mode === 'web' });
        } finally {
            if (!redirecting) manager.authFlowInProgress = false;
            this.setBusy(false);
        }
    },

    /** Android app: the native account picker's ID token, then the JS SDK signs in with it. */
    async nativeSignIn(win) {
        const plugin = win.Capacitor?.Plugins?.FirebaseAuthentication;
        if (!plugin) throw Object.assign(new Error('Google sign-in plugin missing'), { code: 'auth/operation-not-supported-in-this-environment' });
        const res = await plugin.signInWithGoogle({ skipNativeAuth: true });
        const idToken = res?.credential?.idToken;
        if (!idToken) throw Object.assign(new Error('Google gave no ID token'), { code: 'happa/no-id-token' });
        const credential = firebase.auth.GoogleAuthProvider.credential(idToken, res.credential.accessToken || null);
        return firebase.auth().signInWithCredential(credential);
    },

    /** Signed in with Google: the profile check (a new person gets a pending profile). */
    async finish(manager, user) {
        if (!user) return;
        const email = googleEmail(user);
        try {
            if (!email) throw Object.assign(new Error('Google account without email'), { code: 'happa/no-email' });
            await manager.completeSignIn(user, {
                email,
                name: user.displayName || '',
                form: 'google',
                createdKey: 'msg.auth.registration_successful_wait_admin_approval',
                createdKind: 'success'
            });
        } catch (error) {
            // Never leave a Google sign-in half done (signed in, no checked profile)
            await firebase.auth().signOut().catch(() => {});
            throw error;
        }
    },

    /** @returns {Promise<boolean>} true when the page is going to Google (redirect) */
    async handleError(manager, error, { allowRedirect }) {
        console.warn('Google sign-in:', error?.code || '', error?.message || '');
        const what = googleErrorAction(error);
        if (what.action === 'ignore') return false;
        if (what.action === 'redirect' && allowRedirect) {
            markGoogleRedirect();
            this.redirectingFrom = manager;
            try {
                await firebase.auth().signInWithRedirect(googleProvider());
                return true;
            } catch (e) {
                this.redirectingFrom = null;
                clearGoogleRedirect();
                return this.handleError(manager, e, { allowRedirect: false });
            }
        }
        if (what.action === 'link') {
            this.openLink(manager, error);
            return false;
        }
        manager.showMessage('google', t(what.key || 'msg.auth.google_failed', what.params));
        return false;
    },

    /** After the redirect fallback: the page is back, maybe signed in with Google. */
    async completeRedirect(manager) {
        manager.authFlowInProgress = true;
        try {
            const result = await firebase.auth().getRedirectResult();
            await this.finish(manager, result?.user || firebase.auth().currentUser);
        } catch (error) {
            await this.handleError(manager, error, { allowRedirect: false });
        } finally {
            clearGoogleRedirect();
            manager.authFlowInProgress = false;
        }
    },

    /**
     * The email already has a password here: ask for it once, then add Google to that account
     * (same uid, same profile and approval).
     */
    openLink(manager, error) {
        const credential = error?.credential || firebase.auth.GoogleAuthProvider.credentialFromError?.(error) || null;
        const form = $('googleLinkForm');
        if (!credential || !form) {
            manager.showMessage('google', t('msg.auth.google_failed'));
            return;
        }
        const email = error.email || error.customData?.email || '';
        this.pendingLink = { credential, email };
        const emailInput = $('googleLinkEmail');
        if (emailInput) {
            emailInput.value = email;
            emailInput.readOnly = !!email;
        }
        const hint = $('googleLinkHint');
        if (hint) hint.textContent = email ? t('msg.auth.google_link_hint', { email }) : t('msg.auth.google_link_hint_no_email');
        manager.clearMessage('googleLink');
        form.hidden = false;
        const btn = $('googleSignInBtn');
        if (btn) btn.hidden = true;
        form.scrollIntoView?.({ block: 'nearest' });
        (email ? $('googleLinkPassword') : emailInput)?.focus();
    },

    closeLink() {
        const form = $('googleLinkForm');
        if (form) form.hidden = true;
        const pwd = $('googleLinkPassword');
        if (pwd) pwd.value = '';
        const btn = $('googleSignInBtn');
        if (btn) btn.hidden = false;
    },

    cancelLink(manager) {
        this.pendingLink = null;
        manager.clearMessage('googleLink');
        this.closeLink();
    },

    /** The link form's submit: password sign-in (shared backoff), link Google, then the profile check. */
    async submitLink(manager) {
        const link = this.pendingLink;
        if (!link || manager.busy.googleLink || manager.busy.login) return;
        manager.clearMessage('googleLink');
        const email = link.email || $('googleLinkEmail')?.value.trim() || '';
        const password = $('googleLinkPassword')?.value || '';
        if (!email || !password) {
            manager.showMessage('googleLink', t('msg.auth.enter_email_password'));
            return;
        }
        manager.setBusy('googleLink', true, 'ui.auth.signing_in');
        manager.authFlowInProgress = true;
        try {
            const { credential, message } = await manager.passwordTry(email, password);
            if (!credential) {
                manager.showMessage('googleLink', message);
                return;
            }
            try {
                await credential.user.linkWithCredential(link.credential);
                this.pendingLink = null;
                this.closeLink();
                await manager.completeSignIn(credential.user, { email: credential.user.email || email, form: 'google' });
            } catch (error) {
                await firebase.auth().signOut().catch(() => {});
                throw error;
            }
        } catch (error) {
            console.warn('Google link:', error?.code || '', error?.message || '');
            const what = googleErrorAction(error);
            manager.showMessage(this.pendingLink ? 'googleLink' : 'google', t(what.key || 'msg.auth.google_failed', what.params));
        } finally {
            manager.authFlowInProgress = false;
            manager.setBusy('googleLink', false);
        }
    }
};

if (typeof window !== 'undefined') window.addEventListener('pageshow', (event) => GoogleSignIn.onPageShow(event));
