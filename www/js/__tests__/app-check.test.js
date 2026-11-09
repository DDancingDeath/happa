/**
 * App Check in monitor mode (#89): nothing loads without a site key; with one, reCAPTCHA v3
 * must load and report ready (within a timeout, and only online) before the self-hosted SDK
 * (SRI-pinned) is activated with reCAPTCHA v3 and token auto-refresh. Activating without a
 * working reCAPTCHA would leave every Firestore / Auth call waiting for a token forever.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readLazyAssets, readStaticAssets, RUNTIME_ONLY } = require('../../../scripts/check-sw-assets.js');
import {
    startAppCheck, useDebugProvider, _resetAppCheck, APP_CHECK_SDK_URL, APP_CHECK_SDK_INTEGRITY,
    RECAPTCHA_URL, RECAPTCHA_READY_TIMEOUT_MS
} from '../services/app-check.js';

const WWW = path.join(__dirname, '..', '..');

/** recaptcha: 'ready' (fires ready), 'never' (ready never fires), 'fail' (script error) */
function fakeWin({ siteKey = '6LcKey', hostname = 'myhappa.web.app', native = false, online = true, recaptcha = 'ready' } = {}) {
    const appCheck = { activate: jest.fn() };
    function ReCaptchaV3Provider(key) { this.key = key; }
    const appCheckFn = jest.fn(() => appCheck);
    appCheckFn.ReCaptchaV3Provider = ReCaptchaV3Provider;
    const listeners = {};
    const win = {
        APP_CHECK_SITE_KEY: siteKey,
        location: { hostname },
        navigator: { onLine: online },
        Capacitor: native ? { isNativePlatform: () => true } : undefined,
        firebase: { appCheck: appCheckFn },
        addEventListener: jest.fn((type, fn) => { (listeners[type] ||= []).push(fn); }),
        fire: (type) => (listeners[type] || []).splice(0).forEach((fn) => fn())
    };
    const state = { recaptcha };
    const load = jest.fn((src) => {
        if (src !== RECAPTCHA_URL) return Promise.resolve();
        if (state.recaptcha === 'fail') return Promise.reject(new Error('Failed to load script'));
        win.grecaptcha = { ready: (cb) => { if (state.recaptcha === 'ready') cb(); }, render: jest.fn() };
        return Promise.resolve();
    });
    return { win, load, state, appCheck, ReCaptchaV3Provider };
}

describe('App Check monitor mode (#89)', () => {
    beforeEach(() => {
        _resetAppCheck();
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        jest.useRealTimers();
        console.warn.mockRestore();
    });

    test.each([[undefined], [''], ['   ']])('no key (%p): nothing is loaded', async (siteKey) => {
        const { win, load } = fakeWin({ siteKey: siteKey ?? null });
        await expect(startAppCheck({ win, load })).resolves.toBeNull();
        expect(load).not.toHaveBeenCalled();
        expect(win.firebase.appCheck).not.toHaveBeenCalled();
    });

    test('with a key: reCAPTCHA first (explicit, no badge), then the pinned SDK, activated once with v3 and auto-refresh', async () => {
        const { win, load, appCheck, ReCaptchaV3Provider } = fakeWin();
        const [a, b] = await Promise.all([startAppCheck({ win, load }), startAppCheck({ win, load })]);
        expect(a).toBe(appCheck);
        expect(b).toBe(appCheck);
        expect(await startAppCheck({ win, load })).toBe(appCheck);
        expect(load.mock.calls).toEqual([[RECAPTCHA_URL], [APP_CHECK_SDK_URL, undefined, APP_CHECK_SDK_INTEGRITY]]);
        expect(RECAPTCHA_URL).toBe('https://www.google.com/recaptcha/api.js?render=explicit');
        expect(appCheck.activate).toHaveBeenCalledTimes(1);
        const [provider, autoRefresh] = appCheck.activate.mock.calls[0];
        expect(provider).toBeInstanceOf(ReCaptchaV3Provider);
        expect(provider.key).toBe('6LcKey');
        expect(autoRefresh).toBe(true);
        expect(win.FIREBASE_APPCHECK_DEBUG_TOKEN).toBeUndefined();
    });

    test('reCAPTCHA never ready: gives up after the timeout and never activates; a later call retries', async () => {
        jest.useFakeTimers();
        const { win, load, state, appCheck } = fakeWin({ recaptcha: 'never' });
        const pending = startAppCheck({ win, load });
        await jest.advanceTimersByTimeAsync(RECAPTCHA_READY_TIMEOUT_MS);
        await expect(pending).resolves.toBeNull();
        expect(appCheck.activate).not.toHaveBeenCalled();
        expect(load).not.toHaveBeenCalledWith(APP_CHECK_SDK_URL, undefined, APP_CHECK_SDK_INTEGRITY);

        state.recaptcha = 'ready';
        await expect(startAppCheck({ win, load })).resolves.toBe(appCheck);
        expect(appCheck.activate).toHaveBeenCalledTimes(1);
    });

    test('reCAPTCHA script fails to load (blocked): never activates', async () => {
        const { win, load, appCheck } = fakeWin({ recaptcha: 'fail' });
        await expect(startAppCheck({ win, load })).resolves.toBeNull();
        expect(appCheck.activate).not.toHaveBeenCalled();
        expect(load).toHaveBeenCalledTimes(1);
    });

    test('offline: skipped (nothing loaded); the online event then activates it', async () => {
        const { win, load, appCheck } = fakeWin({ online: false });
        await expect(startAppCheck({ win, load })).resolves.toBeNull();
        await startAppCheck({ win, load });
        expect(load).not.toHaveBeenCalled();
        expect(win.addEventListener).toHaveBeenCalledTimes(1);

        win.navigator.onLine = true;
        win.fire('online');
        await new Promise((r) => setTimeout(r, 0));
        expect(appCheck.activate).toHaveBeenCalledTimes(1);
    });

    test('the debug provider only in a browser on localhost, never in the APK (also https://localhost)', async () => {
        expect(useDebugProvider({ location: { hostname: 'localhost' } })).toBe(true);
        expect(useDebugProvider({ location: { hostname: '127.0.0.1' } })).toBe(true);
        expect(useDebugProvider({ location: { hostname: 'myhappa.web.app' } })).toBe(false);
        expect(useDebugProvider({ location: { hostname: 'localhost' }, Capacitor: { isNativePlatform: () => true } })).toBe(false);

        const local = fakeWin({ hostname: 'localhost' });
        await startAppCheck({ win: local.win, load: local.load });
        expect(local.win.FIREBASE_APPCHECK_DEBUG_TOKEN).toBe(true);
        _resetAppCheck();
        const apk = fakeWin({ hostname: 'localhost', native: true });
        await startAppCheck({ win: apk.win, load: apk.load });
        expect(apk.win.FIREBASE_APPCHECK_DEBUG_TOKEN).toBeUndefined();
    });

    test('the vendored SDK matches its SRI hash, reuses an existing grecaptcha, and is neither precached nor installed', () => {
        const body = fs.readFileSync(path.join(WWW, APP_CHECK_SDK_URL));
        expect(APP_CHECK_SDK_INTEGRITY).toBe('sha384-' + crypto.createHash('sha384').update(body).digest('base64'));
        // initializeV3: only when self.grecaptcha is missing does the SDK add its own api.js tag
        expect(body.toString()).toMatch(/var a=D\(!1\);return a\?de\(t,r,a,o,n\):function\(e\)\{const t=document\.createElement\("script"\);t\.src=he/);
        expect(RUNTIME_ONLY).toContain(APP_CHECK_SDK_URL);
        expect(readLazyAssets()).not.toContain(APP_CHECK_SDK_URL);
        expect(readStaticAssets()).not.toContain(APP_CHECK_SDK_URL);
        expect(fs.readFileSync(path.join(WWW, 'index.html'), 'utf8')).not.toMatch(/app-check/);
    });

    test('firebaseConfig.js hands the configured key to the page', () => {
        const src = fs.readFileSync(path.join(WWW, 'firebaseConfig.js'), 'utf8');
        expect(src).toMatch(/const appCheckSiteKey = "[\w-]*";\r?\n/);
        expect(src).toContain('window.APP_CHECK_SITE_KEY = appCheckSiteKey;');
    });
});
