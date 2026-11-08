/**
 * @fileoverview "Continue with Google" (docs/google-sign-in.md) with a mocked Firebase Auth and
 * a mocked native plugin: off unless switched on; a new Google person gets a pending profile and
 * is signed out (never approved by the app); approved people get in; the popup falls back to a
 * redirect; an email with a password is linked only after that password; the Android app signs in
 * with the native picker's ID token. The real Android path needs a device test (docs).
 */
const fs = require('fs');
const path = require('path');
import { AuthManager, googleSignInMode, googleRedirectPending, GOOGLE_REDIRECT_KEY } from '../auth/authentication.js';
import { GoogleSignIn, googleErrorAction, googleEmail } from '../auth/google-signin.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { setLang, resetLangForTests } from '../i18n/index.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

const AUTH_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'auth.html'), 'utf8');
const ON = { googleSignIn: { web: true, android: true } };
const OFF = { googleSignIn: { web: false, android: false } };

let fake;
let auth;
let googleUser;
const $ = (id) => document.getElementById(id);
const text = (id) => $(id).textContent;
const authError = (code, extra = {}) => Object.assign(new Error(`Firebase: Error (${code}).`), { code }, extra);
const flush = () => new Promise((r) => setTimeout(r, 0));

class FakeGoogleProvider {
    constructor() { this.params = null; }
    setCustomParameters(p) { this.params = p; }
}
FakeGoogleProvider.credential = jest.fn((idToken, accessToken) => ({ providerId: 'google.com', idToken, accessToken }));

function installFirebase() {
    fake = createFakeFirestore();
    googleUser = { uid: 'g1', email: 'Asha@Gmail.com', displayName: 'Asha', providerData: [{ providerId: 'google.com', email: 'Asha@Gmail.com' }] };
    auth = {
        currentUser: null,
        signInWithPopup: jest.fn(async () => {
            expect(AuthManager.authFlowInProgress).toBe(true);
            return { user: googleUser };
        }),
        signInWithRedirect: jest.fn(async () => {}),
        getRedirectResult: jest.fn(async () => ({ user: googleUser })),
        signInWithCredential: jest.fn(async () => ({ user: googleUser })),
        signInWithEmailAndPassword: jest.fn(),
        signOut: jest.fn(async () => {})
    };
    const authFn = () => auth;
    authFn.GoogleAuthProvider = FakeGoogleProvider;
    window.firebase = { ...fake.firebase, auth: authFn };
    global.firebase = window.firebase;
}

function at(search) {
    window.history.replaceState({}, '', `/${search}`);
}

function renderCard() {
    document.body.innerHTML = `<div id="toast"></div>${AUTH_HTML}`;
    $('authScreen').style.display = 'flex';
}

beforeEach(async () => {
    installFirebase();
    at('?emulator=1&google=1');
    renderCard();
    jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    window.initializeApp = jest.fn(async () => {});
    window.app = { auth: { showTab: (tab) => AuthManager.showAuthTab(tab) } };
    AppState.currentUser = null;
    AppState.userRole = 'staff';
    AppState.userName = 'User';
    AuthManager.authFlowInProgress = false;
    GoogleSignIn.pendingLink = null;
    GoogleSignIn.busy = false;
    AuthManager.initAuthTabs();
    await AuthManager.loadGoogle();
    await flush();
});

afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    resetLangForTests();
    at('');
    delete window.firebase;
    delete global.firebase;
    delete window.initializeApp;
    delete window.app;
    delete window.Capacitor;
});

describe('switch (happa.config.json googleSignIn)', () => {
    const win = (search, extra = {}) => ({ location: new URL(`http://localhost/${search}`), ...extra });

    test('off by default: no mode, and the login card shows no Google button', async () => {
        expect(googleSignInMode(win(''), OFF)).toBeNull();
        expect(googleSignInMode(win(''))).toBeNull(); // the committed config
        at('');
        renderCard();
        await AuthManager.initGoogleSignIn();
        expect($('googleSignIn').hidden).toBe(true);
    });

    test('web when switched on; the emulator override only on localhost with ?emulator=1&google=1', () => {
        expect(googleSignInMode(win(''), { googleSignIn: { web: true } })).toBe('web');
        expect(googleSignInMode(win('?emulator=1&google=1'), OFF)).toBe('web');
        expect(googleSignInMode(win('?google=1'), OFF)).toBeNull();
        expect(googleSignInMode({ location: new URL('https://myhappa.web.app/?emulator=1&google=1') }, OFF)).toBeNull();
    });

    test('Android app: only with the android switch AND the plugin in the APK (its Firebase config added)', () => {
        const cap = (plugin) => ({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n) => plugin && n === 'FirebaseAuthentication' } });
        expect(googleSignInMode(win('', cap(true)), ON)).toBe('native');
        expect(googleSignInMode(win('', cap(false)), ON)).toBeNull();
        expect(googleSignInMode(win('', cap(true)), { googleSignIn: { web: true, android: false } })).toBeNull();
        expect(googleSignInMode(win('?emulator=1&google=1', cap(true)), OFF)).toBeNull();
    });

    test('switched on: the button shows, with the G logo inline (no image request) and its text in the app language', async () => {
        expect($('googleSignIn').hidden).toBe(false);
        expect($('googleSignInBtn').querySelector('svg path')).not.toBeNull();
        expect($('googleSignIn').querySelector('img')).toBeNull();
        setLang('hi');
        expect($('googleSignInBtn').textContent.trim()).toBe('Google से जारी रखें');
        setLang('en');
        expect($('googleSignInBtn').textContent.trim()).toBe('Continue with Google');
    });

    test('on Firebase Hosting the authDomain is the site itself (same-origin helper) only when the web switch is on', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'firebaseConfig.js'), 'utf8');
        const block = /\/\/ --- auth-domain[^\n]*\n([\s\S]*?)\/\/ --- end auth-domain ---/.exec(src);
        const authDomainFor = new Function(`${block[1]}; return authDomainFor;`)();
        expect(authDomainFor('myhappa.web.app', 'p.firebaseapp.com', true)).toBe('myhappa.web.app');
        expect(authDomainFor('myhappa--pr1-abc.web.app', 'p.firebaseapp.com', true)).toBe('myhappa--pr1-abc.web.app');
        expect(authDomainFor('myhappa.web.app', 'p.firebaseapp.com', false)).toBe('p.firebaseapp.com');
        expect(authDomainFor('localhost', 'p.firebaseapp.com', true)).toBe('p.firebaseapp.com');
        expect(authDomainFor('evil.example', 'p.firebaseapp.com', true)).toBe('p.firebaseapp.com');
    });
});

describe('web popup', () => {
    test('a new Google person gets a pending staff profile, is signed out and waits for the owner', async () => {
        await AuthManager.signInWithGoogle();
        const provider = auth.signInWithPopup.mock.calls[0][0];
        expect(provider).toBeInstanceOf(FakeGoogleProvider);
        expect(provider.params).toEqual({ prompt: 'select_account' });
        const profile = fake.raw('users').get('g1');
        expect(profile).toMatchObject({ name: 'Asha', email: 'Asha@Gmail.com', role: 'staff', status: 'pending' });
        expect(auth.signOut).toHaveBeenCalled();
        expect(window.initializeApp).not.toHaveBeenCalled();
        expect(AppState.currentUser).toBeNull();
        expect(text('googleMessage')).toBe('Registration successful! Please wait for admin approval.');
        expect(AuthManager.authFlowInProgress).toBe(false);
    });

    test('an approved person gets in with the profile role (the same as an email sign-in)', async () => {
        fake.seed('users', [{ id: 'g1', name: 'Asha', email: 'asha@gmail.com', role: 'manager', status: 'approved' }]);
        await AuthManager.signInWithGoogle();
        expect(auth.signOut).not.toHaveBeenCalled();
        expect(AppState.currentUser).toBe(googleUser);
        expect(AppState.userRole).toBe('manager');
        expect(window.initializeApp).toHaveBeenCalledTimes(1);
        expect($('authScreen').style.display).toBe('none');
        expect(fake.raw('users').get('g1').status).toBe('approved');
    });

    test.each([
        ['pending', 'Your account is pending approval. Please wait for admin approval.'],
        ['rejected', 'Your account has been rejected. Please contact admin.'],
        ['disabled', 'This account has been removed. Please contact the owner.']
    ])('a %s profile is signed straight back out', async (status, message) => {
        fake.seed('users', [{ id: 'g1', name: 'Asha', email: 'asha@gmail.com', role: 'owner', status }]);
        await AuthManager.signInWithGoogle();
        expect(auth.signOut).toHaveBeenCalled();
        expect(window.initializeApp).not.toHaveBeenCalled();
        expect(text('googleMessage')).toBe(message);
        expect(fake.raw('users').get('g1')).toMatchObject({ role: 'owner', status });
    });

    test('closing the popup says nothing and ends the flow', async () => {
        auth.signInWithPopup.mockRejectedValueOnce(authError('auth/popup-closed-by-user'));
        await AuthManager.signInWithGoogle();
        expect(text('googleMessage')).toBe('');
        expect(AuthManager.authFlowInProgress).toBe(false);
        expect($('googleSignInBtn').disabled).toBe(false);
    });

    test('provider off / domain not authorised: "not set up yet", no profile', async () => {
        auth.signInWithPopup.mockRejectedValueOnce(authError('auth/unauthorized-domain'));
        await AuthManager.signInWithGoogle();
        expect(text('googleMessage')).toBe('Google sign-in is not set up yet. Please use email and password.');
        expect(fake.raw('users').has('g1')).toBe(false);
    });

    test('a Google account without an email is signed straight back out, no profile', async () => {
        googleUser.email = null;
        googleUser.providerData = [];
        await AuthManager.signInWithGoogle();
        expect(auth.signOut).toHaveBeenCalled();
        expect(text('googleMessage')).toBe('This Google account has no email address. Please use email and password.');
        expect(fake.raw('users').has('g1')).toBe(false);
    });

    test('a second tap while signing in does nothing', async () => {
        let resolve;
        auth.signInWithPopup.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
        const first = AuthManager.signInWithGoogle();
        await AuthManager.signInWithGoogle();
        expect(auth.signInWithPopup).toHaveBeenCalledTimes(1);
        expect($('googleSignInBtn').disabled).toBe(true);
        resolve({ user: googleUser });
        await first;
        expect($('googleSignInBtn').disabled).toBe(false);
    });
});

describe('redirect fallback', () => {
    test('a blocked popup redirects (the app stays held until the page comes back)', async () => {
        auth.signInWithPopup.mockRejectedValueOnce(authError('auth/popup-blocked'));
        await AuthManager.signInWithGoogle();
        expect(auth.signInWithRedirect).toHaveBeenCalledTimes(1);
        expect(googleRedirectPending()).toBe(true);
        expect(AuthManager.authFlowInProgress).toBe(true);
    });

    test('back from Google out of the back/forward cache (no reload): the hold on the app and the button is undone', async () => {
        auth.signInWithPopup.mockRejectedValueOnce(authError('auth/popup-blocked'));
        auth.signInWithRedirect.mockImplementationOnce(() => new Promise(() => {})); // the page navigates away
        AuthManager.signInWithGoogle();
        await flush();
        expect(AuthManager.authFlowInProgress).toBe(true);
        expect($('googleSignInBtn').disabled).toBe(true);
        window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
        expect(AuthManager.authFlowInProgress).toBe(true);
        window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
        expect(AuthManager.authFlowInProgress).toBe(false);
        expect($('googleSignInBtn').disabled).toBe(false);
        expect(googleRedirectPending()).toBe(false);
    });

    test('back from Google: the same profile check runs before the app starts', async () => {
        sessionStorage.setItem(GOOGLE_REDIRECT_KEY, String(Date.now()));
        expect(AuthManager.resumeGoogleRedirect()).toBe(true);
        expect(AuthManager.authFlowInProgress).toBe(true);
        await flush();
        await flush();
        expect(auth.getRedirectResult).toHaveBeenCalled();
        expect(fake.raw('users').get('g1')).toMatchObject({ status: 'pending', role: 'staff' });
        expect(window.initializeApp).not.toHaveBeenCalled();
        expect(sessionStorage.getItem(GOOGLE_REDIRECT_KEY)).toBeNull();
        expect(AuthManager.authFlowInProgress).toBe(false);
    });

    test('no redirect started (or a stale mark): nothing to resume', () => {
        expect(AuthManager.resumeGoogleRedirect()).toBe(false);
        sessionStorage.setItem(GOOGLE_REDIRECT_KEY, String(Date.now() - 60 * 60 * 1000));
        expect(AuthManager.resumeGoogleRedirect()).toBe(false);
        expect(sessionStorage.getItem(GOOGLE_REDIRECT_KEY)).toBeNull();
        expect(AuthManager.authFlowInProgress).toBe(false);
    });
});

describe('an email that already has a password: link after one password sign-in', () => {
    const googleCredential = { providerId: 'google.com', idToken: 'tok' };
    let passwordUser;

    beforeEach(() => {
        passwordUser = { uid: 'p1', email: 'asha@shop.in', linkWithCredential: jest.fn(async () => ({ user: passwordUser })) };
        auth.signInWithPopup.mockRejectedValueOnce(authError('auth/account-exists-with-different-credential',
            { email: 'asha@shop.in', credential: googleCredential }));
    });

    test('asks for that email\'s password, then links Google to the same account and opens the app', async () => {
        fake.seed('users', [{ id: 'p1', name: 'Asha', email: 'asha@shop.in', role: 'staff', status: 'approved' }]);
        auth.signInWithEmailAndPassword.mockResolvedValueOnce({ user: passwordUser });
        await AuthManager.signInWithGoogle();
        expect($('googleLinkForm').hidden).toBe(false);
        expect($('googleSignInBtn').hidden).toBe(true);
        expect($('googleLinkEmail').value).toBe('asha@shop.in');
        expect($('googleLinkEmail').readOnly).toBe(true);
        expect(text('googleLinkHint')).toContain('asha@shop.in already has a password here');
        expect(auth.signInWithEmailAndPassword).not.toHaveBeenCalled();

        $('googleLinkEmail').value = 'someone@else.in'; // read-only; the Google account's email is used
        $('googleLinkPassword').value = 'secret1';
        await AuthManager.linkGoogle();
        expect(auth.signInWithEmailAndPassword).toHaveBeenCalledWith('asha@shop.in', 'secret1');
        expect(passwordUser.linkWithCredential).toHaveBeenCalledWith(googleCredential);
        expect(window.initializeApp).toHaveBeenCalledTimes(1);
        expect(AppState.currentUser).toBe(passwordUser);
        expect($('googleLinkForm').hidden).toBe(true);
        expect(AuthManager.authFlowInProgress).toBe(false);
    });

    test('a wrong password links nothing and counts towards the sign-in backoff', async () => {
        auth.signInWithEmailAndPassword.mockRejectedValue(authError('auth/wrong-password'));
        await AuthManager.signInWithGoogle();
        $('googleLinkPassword').value = 'nope';
        await AuthManager.linkGoogle();
        expect(passwordUser.linkWithCredential).not.toHaveBeenCalled();
        expect(text('googleLinkMessage')).toBe('Wrong password');
        expect(localStorage.getItem('happaLoginBackoff')).not.toBeNull();
        expect(window.initializeApp).not.toHaveBeenCalled();
        expect($('googleLinkForm').hidden).toBe(false);
    });

    test('a pending account stays pending after linking', async () => {
        fake.seed('users', [{ id: 'p1', name: 'Asha', email: 'asha@shop.in', role: 'staff', status: 'pending' }]);
        auth.signInWithEmailAndPassword.mockResolvedValueOnce({ user: passwordUser });
        await AuthManager.signInWithGoogle();
        $('googleLinkPassword').value = 'secret1';
        await AuthManager.linkGoogle();
        expect(passwordUser.linkWithCredential).toHaveBeenCalled();
        expect(auth.signOut).toHaveBeenCalled();
        expect(window.initializeApp).not.toHaveBeenCalled();
        expect(text('googleMessage')).toBe('Your account is pending approval. Please wait for admin approval.');
    });

    test('Google already linked to another account: signed out, told so', async () => {
        auth.signInWithEmailAndPassword.mockResolvedValueOnce({ user: passwordUser });
        passwordUser.linkWithCredential.mockRejectedValueOnce(authError('auth/credential-already-in-use'));
        await AuthManager.signInWithGoogle();
        $('googleLinkPassword').value = 'secret1';
        await AuthManager.linkGoogle();
        expect(auth.signOut).toHaveBeenCalled();
        expect(window.initializeApp).not.toHaveBeenCalled();
        expect(text('googleLinkMessage')).toBe('This Google account is already linked to another account here.');
    });

    test('"Not now" closes the form and forgets the Google credential', async () => {
        await AuthManager.signInWithGoogle();
        AuthManager.cancelGoogleLink();
        expect($('googleLinkForm').hidden).toBe(true);
        expect($('googleSignInBtn').hidden).toBe(false);
        expect(GoogleSignIn.pendingLink).toBeNull();
        await AuthManager.linkGoogle();
        expect(auth.signInWithEmailAndPassword).not.toHaveBeenCalled();
    });
});

describe('Android app (native picker, mocked plugin)', () => {
    let plugin;
    beforeEach(() => {
        plugin = { signInWithGoogle: jest.fn(async () => ({ credential: { idToken: 'google-id-token', accessToken: 'at' } })) };
        window.Capacitor = { isNativePlatform: () => true, isPluginAvailable: () => true, Plugins: { FirebaseAuthentication: plugin } };
    });

    test('signs in with the ID token in the JS SDK; no popup; the same approval gate', async () => {
        await GoogleSignIn.start(AuthManager, 'native');
        expect(plugin.signInWithGoogle).toHaveBeenCalledWith({ skipNativeAuth: true });
        expect(FakeGoogleProvider.credential).toHaveBeenCalledWith('google-id-token', 'at');
        expect(auth.signInWithCredential).toHaveBeenCalledWith({ providerId: 'google.com', idToken: 'google-id-token', accessToken: 'at' });
        expect(auth.signInWithPopup).not.toHaveBeenCalled();
        expect(fake.raw('users').get('g1')).toMatchObject({ status: 'pending', role: 'staff' });
        expect(window.initializeApp).not.toHaveBeenCalled();
    });

    test('picker cancelled: nothing shown; console not set up (DEVELOPER_ERROR): "not set up yet"; never a redirect', async () => {
        plugin.signInWithGoogle.mockRejectedValueOnce(new Error('activity is cancelled by the user.'));
        await GoogleSignIn.start(AuthManager, 'native');
        expect(text('googleMessage')).toBe('');
        plugin.signInWithGoogle.mockRejectedValueOnce(new Error('10: DEVELOPER_ERROR'));
        await GoogleSignIn.start(AuthManager, 'native');
        expect(text('googleMessage')).toBe('Google sign-in is not set up yet. Please use email and password.');
        expect(auth.signInWithCredential).not.toHaveBeenCalled();
        expect(auth.signInWithRedirect).not.toHaveBeenCalled();
        expect(AuthManager.authFlowInProgress).toBe(false);
    });

    test('an email with a password: the same link form', async () => {
        auth.signInWithCredential.mockRejectedValueOnce(authError('auth/account-exists-with-different-credential',
            { email: 'asha@shop.in', credential: { providerId: 'google.com' } }));
        await GoogleSignIn.start(AuthManager, 'native');
        expect($('googleLinkForm').hidden).toBe(false);
    });
});

describe('googleErrorAction / googleEmail', () => {
    test.each([
        [{ code: 'auth/popup-closed-by-user' }, 'ignore'],
        [{ code: 'auth/cancelled-popup-request' }, 'ignore'],
        [{ code: 'auth/popup-blocked' }, 'redirect'],
        [{ code: 'auth/operation-not-supported-in-this-environment' }, 'redirect'],
        [{ code: 'auth/account-exists-with-different-credential' }, 'link'],
        [{ code: 'auth/operation-not-allowed' }, 'message'],
        [{ message: 'No credentials available' }, 'message']
    ])('%j → %s', (error, action) => {
        expect(googleErrorAction(error).action).toBe(action);
    });

    test('unknown codes name the code; Google profile email is the fallback', () => {
        expect(googleErrorAction({ code: 'auth/internal-error' })).toEqual({ action: 'message', key: 'msg.auth.err_unknown', params: { code: 'auth/internal-error' } });
        expect(googleEmail({ email: null, providerData: [{ providerId: 'google.com', email: 'x@gmail.com' }] })).toBe('x@gmail.com');
        expect(googleEmail(null)).toBeNull();
    });
});
