/**
 * @fileoverview Voice billing switch and mic buttons (#81). Off by default and kept
 * per device; the mic buttons show only when it is on and this device has a speech
 * engine. The speech code loads with import() on the first tap.
 * @module ui/voice-mic
 */

import { safeSetItem } from '../utils/storage-full.js';

export const VOICE_KEY = 'aadhat.voiceBilling';
/** A short tone after each listen (#131); off unless switched on, per device. */
export const BEEP_KEY = 'aadhat.voiceBeep';

/**
 * The speech engine this device can use: the Android app's own recogniser (native
 * plugin), the browser's Web Speech API (the Android WebView has none), or null.
 * A Permissions-Policy that blocks the microphone counts as none.
 * @param {Window} [win]
 * @returns {'native'|'web'|null}
 */
export function voiceEngine(win = window) {
    const cap = win.Capacitor;
    if (cap?.isNativePlatform?.()) return cap.isPluginAvailable?.('SpeechRecognition') ? 'native' : null;
    if (!(win.SpeechRecognition || win.webkitSpeechRecognition)) return null;
    const policy = win.document?.permissionsPolicy || win.document?.featurePolicy;
    if (typeof policy?.allowsFeature === 'function' && !policy.allowsFeature('microphone')) return null;
    return 'web';
}

export const VoiceMic = {
    isOn() {
        try { return localStorage.getItem(VOICE_KEY) === '1'; } catch { return false; }
    },

    setOn(on) {
        safeSetItem(VOICE_KEY, on ? '1' : '0');
        this.apply();
    },

    beepOn() {
        try { return localStorage.getItem(BEEP_KEY) === '1'; } catch { return false; }
    },

    setBeep(on) {
        safeSetItem(BEEP_KEY, on ? '1' : '0');
        this.apply();
    },

    /** Settings checkbox, its "not available" note and the Billing mic buttons. */
    apply() {
        const engine = voiceEngine();
        const show = !!engine && this.isOn();
        const box = document.getElementById('settingVoiceBilling');
        if (box) {
            box.checked = show;
            box.disabled = !engine;
        }
        const note = document.getElementById('voiceBillingUnavailable');
        if (note) note.hidden = !!engine;
        document.querySelectorAll('[data-voice-mic], .voice-strip').forEach(b => { b.hidden = !show; });
        const beep = document.getElementById('settingVoiceBeep');
        if (beep) {
            beep.checked = this.beepOn();
            beep.disabled = !show;
        }
    },

    /**
     * @param {'purchase'|'sale'} mode
     * @returns {Promise<boolean>} true when a line was filled
     */
    start(mode) {
        const engine = voiceEngine();
        if (!engine || !this.isOn()) return Promise.resolve(false);
        return import('../modules/voice-billing.js').then(m => m.VoiceBilling.listenOnce(mode, engine));
    },

    /** The check dialog's "Read aloud" switch (the dialog is open, so the module is loaded). */
    setReadback(on) {
        return import('../modules/voice-billing.js').then(m => m.VoiceBilling.setReadback(on));
    },

    /** The Undo button under the mic (#131): shown only after a voice change, so the module is loaded. */
    undo(mode) {
        return import('../modules/voice-billing.js').then(m => m.VoiceBilling.undoLast(mode));
    },

    /** The check dialog's Correct button and boxes (#131). */
    editLine(i) {
        return import('../modules/voice-billing.js').then(m => m.VoiceBilling.editLine(i));
    },

    lineChanged(i) {
        return import('../modules/voice-billing.js').then(m => m.VoiceBilling.lineChanged(i));
    }
};
