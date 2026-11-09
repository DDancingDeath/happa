/**
 * App Check in monitor mode (#89): nothing loads without a site key; with one, the
 * self-hosted SDK (SRI-pinned, lazy) is activated with reCAPTCHA v3 and token auto-refresh,
 * and the debug provider is used only in a browser on localhost.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readLazyAssets, readStaticAssets } = require('../../../scripts/check-sw-assets.js');
import { startAppCheck, useDebugProvider, _resetAppCheck, APP_CHECK_SDK_URL, APP_CHECK_SDK_INTEGRITY } from '../services/app-check.js';

const WWW = path.join(__dirname, '..', '..');

function fakeWin({ siteKey, hostname = 'myhappa.web.app', native = false } = {}) {
    const appCheck = { activate: jest.fn() };
    function ReCaptchaV3Provider(key) { this.key = key; }
    const appCheckFn = jest.fn(() => appCheck);
    appCheckFn.ReCaptchaV3Provider = ReCaptchaV3Provider;
    return {
        win: {
            APP_CHECK_SITE_KEY: siteKey,
            location: { hostname },
            Capacitor: native ? { isNativePlatform: () => true } : undefined,
            firebase: { appCheck: appCheckFn }
        },
        appCheck,
        ReCaptchaV3Provider
    };
}

describe('App Check monitor mode (#89)', () => {
    beforeEach(() => _resetAppCheck());

    test.each([[undefined], [''], ['   ']])('no key (%p): the SDK is never loaded', async (siteKey) => {
        const { win } = fakeWin({ siteKey });
        const load = jest.fn();
        await expect(startAppCheck({ win, load })).resolves.toBeNull();
        expect(load).not.toHaveBeenCalled();
        expect(win.firebase.appCheck).not.toHaveBeenCalled();
    });

    test('with a key: loads the pinned SDK once and activates reCAPTCHA v3 with auto-refresh', async () => {
        const { win, appCheck, ReCaptchaV3Provider } = fakeWin({ siteKey: '6LcKey' });
        const load = jest.fn().mockResolvedValue(undefined);
        const [a, b] = await Promise.all([startAppCheck({ win, load }), startAppCheck({ win, load })]);
        expect(a).toBe(appCheck);
        expect(b).toBe(appCheck);
        expect(load).toHaveBeenCalledTimes(1);
        expect(load).toHaveBeenCalledWith(APP_CHECK_SDK_URL, undefined, APP_CHECK_SDK_INTEGRITY);
        expect(appCheck.activate).toHaveBeenCalledTimes(1);
        const [provider, autoRefresh] = appCheck.activate.mock.calls[0];
        expect(provider).toBeInstanceOf(ReCaptchaV3Provider);
        expect(provider.key).toBe('6LcKey');
        expect(autoRefresh).toBe(true);
        expect(win.FIREBASE_APPCHECK_DEBUG_TOKEN).toBeUndefined();
    });

    test('the debug provider only in a browser on localhost, never in the APK (also https://localhost)', async () => {
        expect(useDebugProvider({ location: { hostname: 'localhost' } })).toBe(true);
        expect(useDebugProvider({ location: { hostname: '127.0.0.1' } })).toBe(true);
        expect(useDebugProvider({ location: { hostname: 'myhappa.web.app' } })).toBe(false);
        expect(useDebugProvider({ location: { hostname: 'localhost' }, Capacitor: { isNativePlatform: () => true } })).toBe(false);

        const { win } = fakeWin({ siteKey: '6LcKey', hostname: 'localhost' });
        await startAppCheck({ win, load: jest.fn().mockResolvedValue(undefined) });
        expect(win.FIREBASE_APPCHECK_DEBUG_TOKEN).toBe(true);
        _resetAppCheck();
        const apk = fakeWin({ siteKey: '6LcKey', hostname: 'localhost', native: true });
        await startAppCheck({ win: apk.win, load: jest.fn().mockResolvedValue(undefined) });
        expect(apk.win.FIREBASE_APPCHECK_DEBUG_TOKEN).toBeUndefined();
    });

    test('a failed load never throws (monitor mode must not break the app) and can be retried', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { win, appCheck } = fakeWin({ siteKey: '6LcKey' });
        const load = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
        await expect(startAppCheck({ win, load })).resolves.toBeNull();
        await expect(startAppCheck({ win, load })).resolves.toBe(appCheck);
        console.warn.mockRestore();
    });

    test('the vendored SDK matches its SRI hash, is lazy (not precached) and not a <script> in index.html', () => {
        const body = fs.readFileSync(path.join(WWW, APP_CHECK_SDK_URL));
        expect(APP_CHECK_SDK_INTEGRITY).toBe('sha384-' + crypto.createHash('sha384').update(body).digest('base64'));
        expect(readLazyAssets()).toContain(APP_CHECK_SDK_URL);
        expect(readStaticAssets()).not.toContain(APP_CHECK_SDK_URL);
        expect(fs.readFileSync(path.join(WWW, 'index.html'), 'utf8')).not.toMatch(/app-check/);
    });

    test('firebaseConfig.js hands the configured key to the page', () => {
        const src = fs.readFileSync(path.join(WWW, 'firebaseConfig.js'), 'utf8');
        expect(src).toMatch(/const appCheckSiteKey = "[\w-]*";\r?\n/);
        expect(src).toContain('window.APP_CHECK_SITE_KEY = appCheckSiteKey;');
    });
});
