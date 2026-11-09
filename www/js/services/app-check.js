// @ts-check
/**
 * @fileoverview Firebase App Check in monitor mode (#89, docs/security.md "App Check").
 * Off until happa.config.json has appCheck.siteKey (firebaseConfig.js sets
 * window.APP_CHECK_SITE_KEY). With a key, the SDK is loaded after the first screen
 * and activated with reCAPTCHA v3; tokens go along with Auth and Firestore calls,
 * which the console only counts while enforcement stays off.
 * @module services/app-check
 */
import { loadScriptOnce } from '../utils/lazy-scripts.js';

export const APP_CHECK_SDK_URL = '/vendor/firebase/10.7.1/firebase-app-check-compat.js';
export const APP_CHECK_SDK_INTEGRITY = 'sha384-rxbD+YIVHadImwEcPc07/NNXIMwVf3RtXkQUgI0cE4GzDCFQ9IQ+kLvlefJ/Eb7E';

/** @param {Rec} win */
export function appCheckSiteKey(win) {
    const key = win.APP_CHECK_SITE_KEY;
    return typeof key === 'string' ? key.trim() : '';
}

/** The debug provider: a browser on localhost only (the APK is also https://localhost, so not there). @param {Rec} win */
export function useDebugProvider(win) {
    if (win.Capacitor?.isNativePlatform?.()) return false;
    return ['localhost', '127.0.0.1'].includes(win.location?.hostname);
}

/** @type {Promise<*>|null} */
let started = null;

/**
 * Starts App Check once; resolves to the App Check instance, or null when there is no key
 * or it could not start (never throws: monitor mode must not break the app).
 * @param {{win?: Rec, load?: (src: string, globalName?: string, integrity?: string) => Promise<*>}} [opts]
 */
export function startAppCheck({ win = /** @type {Rec} */ (/** @type {unknown} */ (window)), load = loadScriptOnce } = {}) {
    if (started) return started;
    const siteKey = appCheckSiteKey(win);
    if (!siteKey) return Promise.resolve(null);
    started = load(APP_CHECK_SDK_URL, undefined, APP_CHECK_SDK_INTEGRITY).then(() => {
        const fb = win.firebase;
        if (typeof fb?.appCheck !== 'function') throw new Error('App Check SDK missing');
        if (useDebugProvider(win) && !win.FIREBASE_APPCHECK_DEBUG_TOKEN) win.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
        const appCheck = fb.appCheck();
        appCheck.activate(new fb.appCheck.ReCaptchaV3Provider(siteKey), true);
        return appCheck;
    }).catch((/** @type {*} */ e) => {
        console.warn('App Check not started:', e?.message || e);
        started = null;
        return null;
    });
    return started;
}

/** Tests only. */
export function _resetAppCheck() {
    started = null;
}
