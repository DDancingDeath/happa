// @ts-check
/**
 * @fileoverview Firebase App Check in monitor mode (#89, docs/security.md "App Check").
 * Off until happa.config.json has appCheck.siteKey (firebaseConfig.js sets
 * window.APP_CHECK_SITE_KEY). With a key, after the first screen: reCAPTCHA v3 is loaded
 * and must report ready first, then the SDK is loaded and activated (it reuses
 * self.grecaptcha). The SDK's own reCAPTCHA loader has no error path, so activating
 * without a working reCAPTCHA would leave every Firestore / Auth call waiting on a token.
 * @module services/app-check
 */
import { loadScriptOnce } from '../utils/lazy-scripts.js';

export const APP_CHECK_SDK_URL = '/vendor/firebase/10.7.1/firebase-app-check-compat.js';
export const APP_CHECK_SDK_INTEGRITY = 'sha384-rxbD+YIVHadImwEcPc07/NNXIMwVf3RtXkQUgI0cE4GzDCFQ9IQ+kLvlefJ/Eb7E';
// The SDK renders its own invisible widget; render=explicit keeps reCAPTCHA from adding a badge.
export const RECAPTCHA_URL = 'https://www.google.com/recaptcha/api.js?render=explicit';
export const RECAPTCHA_READY_TIMEOUT_MS = 5000;

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

/**
 * Resolves when grecaptcha is ready to render, rejects after `timeoutMs`.
 * @param {Rec} win
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
export function whenRecaptchaReady(win, timeoutMs) {
    return new Promise((resolve, reject) => {
        const g = win.grecaptcha;
        if (typeof g?.ready !== 'function') {
            reject(new Error('reCAPTCHA missing'));
            return;
        }
        const timer = setTimeout(() => reject(new Error('reCAPTCHA not ready')), timeoutMs);
        g.ready(() => {
            clearTimeout(timer);
            if (typeof win.grecaptcha?.render === 'function') resolve();
            else reject(new Error('reCAPTCHA not usable'));
        });
    });
}

/** @type {Promise<*>|null} */
let started = null;
/** @type {*} */
let activated = null;
let retryArmed = false;

/**
 * @typedef {{win?: Rec, load?: (src: string, globalName?: string, integrity?: string) => Promise<*>, timeoutMs?: number}} StartOpts
 */

/** @param {StartOpts} opts */
function retryWhenOnline(opts) {
    const win = opts.win;
    if (retryArmed || typeof win?.addEventListener !== 'function') return;
    retryArmed = true;
    win.addEventListener('online', () => {
        retryArmed = false;
        startAppCheck(opts);
    }, { once: true });
}

/**
 * Starts App Check once; resolves to the App Check instance, or null when there is no key
 * or it could not start yet (never throws: monitor mode must not break the app). After a
 * failure a later call (next idle, or the 'online' event) tries again.
 * @param {StartOpts} [opts]
 */
export function startAppCheck(opts = {}) {
    const { win = /** @type {Rec} */ (/** @type {unknown} */ (window)), load = loadScriptOnce, timeoutMs = RECAPTCHA_READY_TIMEOUT_MS } = opts;
    const all = { win, load, timeoutMs };
    if (activated) return Promise.resolve(activated);
    if (started) return started;
    const siteKey = appCheckSiteKey(win);
    if (!siteKey) return Promise.resolve(null);
    if (win.navigator?.onLine === false) {
        retryWhenOnline(all);
        return Promise.resolve(null);
    }
    started = load(RECAPTCHA_URL)
        .then(() => whenRecaptchaReady(win, timeoutMs))
        .then(() => load(APP_CHECK_SDK_URL, undefined, APP_CHECK_SDK_INTEGRITY))
        .then(() => {
            const fb = win.firebase;
            if (typeof fb?.appCheck !== 'function') throw new Error('App Check SDK missing');
            if (useDebugProvider(win) && !win.FIREBASE_APPCHECK_DEBUG_TOKEN) win.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
            const appCheck = fb.appCheck();
            appCheck.activate(new fb.appCheck.ReCaptchaV3Provider(siteKey), true);
            activated = appCheck;
            return appCheck;
        })
        .catch((/** @type {*} */ e) => {
            console.warn('App Check not started:', e?.message || e);
            retryWhenOnline(all);
            return null;
        })
        .finally(() => { started = null; });
    return started;
}

/** Tests only. */
export function _resetAppCheck() {
    started = null;
    activated = null;
    retryArmed = false;
}
