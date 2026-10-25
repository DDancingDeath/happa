/**
 * @fileoverview Sign-in / register / reset results are written on the card itself
 * (above its button, role="alert"), in English and Hindi, instead of only a toast.
 */
const fs = require('fs');
const path = require('path');
import { AuthManager } from '../auth/authentication.js';
import { UIManager } from '../ui/ui-manager.js';
import { setLang, resetLangForTests } from '../i18n/index.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

const AUTH_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'auth.html'), 'utf8');

let fake;
let auth;
let toast;

const $ = (id) => document.getElementById(id);
const loginBtn = () => document.querySelector('#loginForm button[type="submit"]');
const registerBtn = () => document.querySelector('#registerForm button[type="submit"]');
const authError = (code) => Object.assign(new Error(`Firebase: Error (${code}).`), { code });

function renderCard() {
    document.body.innerHTML = AUTH_HTML;
    AuthManager.initAuthTabs();
    $('loginEmail').value = 'a@x.com';
    $('loginPassword').value = 'secret1';
}

beforeEach(() => {
    fake = createFakeFirestore();
    const user = { uid: 'u1', email: 'a@x.com', delete: jest.fn(async () => {}) };
    auth = {
        signInWithEmailAndPassword: jest.fn(async () => ({ user })),
        createUserWithEmailAndPassword: jest.fn(async () => ({ user })),
        sendPasswordResetEmail: jest.fn(async () => {}),
        signOut: jest.fn(async () => {})
    };
    window.firebase = { ...fake.firebase, auth: () => auth };
    global.firebase = window.firebase;
    toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    window.initializeApp = jest.fn(async () => {});
    window.app = { auth: { showTab: (tab) => AuthManager.showAuthTab(tab) } };
    renderCard();
});

afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
    resetLangForTests();
    delete window.firebase;
    delete global.firebase;
    delete window.initializeApp;
    delete window.app;
});

describe('login card message area', () => {
    test('sits directly above the Login button and is announced to screen readers', () => {
        const msg = $('loginMessage');
        expect(msg.nextElementSibling).toBe(loginBtn());
        expect(msg.getAttribute('role')).toBe('alert');
        expect(msg.getAttribute('aria-live')).toBe('assertive');
        expect($('registerMessage').nextElementSibling).toBe(registerBtn());
        expect($('registerMessage').getAttribute('role')).toBe('alert');
    });
});

describe.each([
    ['en', {
        'auth/user-not-found': 'No account with this email',
        'auth/wrong-password': 'Wrong password',
        'auth/invalid-credential': 'Wrong email or password',
        'auth/invalid-email': 'Invalid email address.',
        'auth/too-many-requests': 'Too many attempts. Please try again later.',
        'auth/network-request-failed': 'Network error. Check your internet connection.',
        'auth/user-disabled': 'This account has been disabled.',
        'auth/operation-not-allowed': 'Sign-in with email is turned off for this app. Please contact the owner.',
        'auth/internal-error': 'Something went wrong (auth/internal-error). Please try again.'
    }],
    ['hi', {
        'auth/user-not-found': 'इस ईमेल से कोई खाता नहीं है',
        'auth/wrong-password': 'पासवर्ड गलत है',
        'auth/invalid-credential': 'ईमेल या पासवर्ड गलत है',
        'auth/invalid-email': 'ईमेल गलत है।',
        'auth/too-many-requests': 'बहुत बार कोशिश हुई। थोड़ी देर बाद कोशिश करें।',
        'auth/network-request-failed': 'इंटरनेट नहीं चल रहा। कनेक्शन देखें।',
        'auth/user-disabled': 'यह खाता बंद कर दिया गया है।',
        'auth/operation-not-allowed': 'इस ऐप में ईमेल से लॉगिन बंद है। मालिक से बात करें।',
        'auth/internal-error': 'कुछ गड़बड़ हुई (auth/internal-error)। फिर से कोशिश करें।'
    }]
])('failed sign-in (%s)', (lang, expected) => {
    beforeEach(() => setLang(lang, { store: null }));

    test.each(Object.keys(expected))('%s is shown on the card', async (code) => {
        auth.signInWithEmailAndPassword.mockRejectedValue(authError(code));
        await AuthManager.handleLogin();
        expect($('loginMessage').textContent).toBe(expected[code]);
        expect($('loginMessage').classList.contains('error')).toBe(true);
        expect(toast).not.toHaveBeenCalled();
        expect(loginBtn().disabled).toBe(false);
        expect(loginBtn().textContent).toBe(lang === 'hi' ? 'लॉगिन' : 'Login');
    });

    test('an error without a code still names it', async () => {
        auth.signInWithEmailAndPassword.mockRejectedValue(new Error('boom'));
        await AuthManager.handleLogin();
        expect($('loginMessage').textContent).toBe(expected['auth/internal-error'].replace('auth/internal-error', 'unknown'));
    });
});

describe.each([
    ['en', 'Your account is pending approval. Please wait for admin approval.', 'Your account has been rejected. Please contact admin.'],
    ['hi', 'आपका खाता मंज़ूरी के लिए रुका है। मालिक की मंज़ूरी का इंतज़ार करें।', 'आपका खाता मंज़ूर नहीं हुआ। मालिक से बात करें।']
])('after sign-in (%s)', (lang, pending, rejected) => {
    beforeEach(() => setLang(lang, { store: null }));

    test.each([['pending', pending], ['rejected', rejected]])('%s account is told so on the card', async (status, text) => {
        fake.seed('users', [{ id: 'u1', name: 'A', email: 'a@x.com', role: 'staff', status }]);
        await AuthManager.handleLogin();
        expect(auth.signOut).toHaveBeenCalled();
        expect($('loginMessage').textContent).toBe(text);
        expect(toast).not.toHaveBeenCalled();
    });
});

describe('behaviour', () => {
    test('button shows a loading state and is disabled while signing in; a second tap does nothing', async () => {
        let finish;
        auth.signInWithEmailAndPassword.mockImplementation(() => new Promise((_, reject) => { finish = () => reject(authError('auth/wrong-password')); }));
        const first = AuthManager.handleLogin();
        expect(loginBtn().disabled).toBe(true);
        expect(loginBtn().getAttribute('aria-busy')).toBe('true');
        expect(loginBtn().textContent).toBe('Signing in…');
        await AuthManager.handleLogin();
        expect(auth.signInWithEmailAndPassword).toHaveBeenCalledTimes(1);
        finish();
        await first;
        expect(loginBtn().disabled).toBe(false);
        expect(loginBtn().hasAttribute('aria-busy')).toBe(false);
        expect(loginBtn().textContent).toBe('Login');
    });

    test('editing a field clears the message', async () => {
        auth.signInWithEmailAndPassword.mockRejectedValue(authError('auth/wrong-password'));
        await AuthManager.handleLogin();
        expect($('loginMessage').textContent).toBe('Wrong password');
        $('loginPassword').value = 'secret2';
        $('loginPassword').dispatchEvent(new Event('input', { bubbles: true }));
        expect($('loginMessage').textContent).toBe('');
    });

    test('switching tab clears the message', async () => {
        auth.signInWithEmailAndPassword.mockRejectedValue(authError('auth/invalid-credential'));
        await AuthManager.handleLogin();
        document.querySelectorAll('.auth-tab')[1].click();
        expect($('loginMessage').textContent).toBe('');
        expect($('loginForm').classList.contains('hidden')).toBe(true);
    });

    test('message text is never parsed as HTML', () => {
        AuthManager.showMessage('login', '<img src=x onerror=alert(1)>');
        expect($('loginMessage').querySelector('img')).toBeNull();
        expect($('loginMessage').textContent).toBe('<img src=x onerror=alert(1)>');
    });
});

describe('register card', () => {
    function fill(name, email, password, confirm = password) {
        $('registerName').value = name;
        $('registerEmail').value = email;
        $('registerPassword').value = password;
        $('registerConfirmPassword').value = confirm;
    }

    test.each([
        ['en', 'auth/weak-password', 'Password is too weak.'],
        ['hi', 'auth/network-request-failed', 'इंटरनेट नहीं चल रहा। कनेक्शन देखें।'],
        ['en', 'auth/operation-not-allowed', 'Sign-in with email is turned off for this app. Please contact the owner.']
    ])('(%s) %s is shown on the Register card', async (lang, code, text) => {
        setLang(lang, { store: null });
        AuthManager.showAuthTab('register');
        fill('Ravi', 'r@x.com', 'secret1');
        auth.createUserWithEmailAndPassword.mockRejectedValue(authError(code));
        await AuthManager.handleRegister();
        expect($('registerMessage').textContent).toBe(text);
        expect(registerBtn().disabled).toBe(false);
        expect(toast).not.toHaveBeenCalled();
    });

    test.each([
        ['en', 'Registration successful! Please wait for admin approval.'],
        ['hi', 'रजिस्टर हो गया! मालिक की मंज़ूरी का इंतज़ार करें।']
    ])('(%s) success moves to the Login card with the result shown there', async (lang, text) => {
        setLang(lang, { store: null });
        AuthManager.showAuthTab('register');
        fill('Ravi', 'r@x.com', 'secret1');
        await AuthManager.handleRegister();
        expect($('registerForm').classList.contains('hidden')).toBe(true);
        expect($('loginMessage').textContent).toBe(text);
        expect($('loginMessage').classList.contains('success')).toBe(true);
    });
});

describe('reset password', () => {
    const openReset = () => AuthManager.handleForgotPassword();

    test('"Forgot password?" is a full-size button that opens an inline email field, never prompt()', () => {
        window.prompt = jest.fn();
        const toggle = $('resetToggle');
        expect(toggle.tagName).toBe('BUTTON');
        expect(toggle.classList.contains('auth-reset-toggle')).toBe(true);
        expect($('resetForm').hidden).toBe(true);
        openReset();
        expect($('resetForm').hidden).toBe(false);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect($('resetEmail').value).toBe('a@x.com');
        expect(window.prompt).not.toHaveBeenCalled();
        openReset();
        expect($('resetForm').hidden).toBe(true);
    });

    test('an empty reset email is reported inline and nothing is sent', async () => {
        $('loginEmail').value = '';
        openReset();
        await AuthManager.handleSendPasswordReset();
        expect(auth.sendPasswordResetEmail).not.toHaveBeenCalled();
        expect($('loginMessage').textContent).not.toBe('');
        expect($('loginMessage').classList.contains('error')).toBe(true);
    });

    test.each([
        ['en', 'Password reset email sent to a@x.com! Check your inbox and spam folder.'],
        ['hi', 'पासवर्ड बदलने का ईमेल a@x.com पर भेजा गया! इनबॉक्स और स्पैम देखें।']
    ])('(%s) success is shown on the Login card', async (lang, text) => {
        setLang(lang, { store: null });
        openReset();
        await AuthManager.handleSendPasswordReset();
        expect(auth.sendPasswordResetEmail).toHaveBeenCalledWith('a@x.com', expect.any(Object));
        expect($('loginMessage').textContent).toBe(`✅ ${text}`);
        expect($('loginMessage').classList.contains('success')).toBe(true);
        expect(toast).not.toHaveBeenCalled();
    });

    test.each([
        ['en', 'auth/user-not-found', 'Failed to send reset email. No account found with this email. Please check the email or register.'],
        ['hi', 'auth/too-many-requests', 'पासवर्ड बदलने का ईमेल नहीं गया। बहुत बार कोशिश हुई। थोड़ी देर बाद कोशिश करें।']
    ])('(%s) %s is shown on the Login card', async (lang, code, text) => {
        setLang(lang, { store: null });
        auth.sendPasswordResetEmail.mockRejectedValue(authError(code));
        openReset();
        await AuthManager.handleSendPasswordReset();
        expect($('loginMessage').textContent).toBe(text);
        expect($('loginMessage').classList.contains('error')).toBe(true);
        expect(loginBtn().disabled).toBe(false);
        expect(document.querySelector('#resetForm button[type="submit"]').disabled).toBe(false);
    });
});
