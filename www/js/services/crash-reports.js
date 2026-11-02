/**
 * @fileoverview Crash reports for the Android app (#122): Firebase Crashlytics through the
 * @capacitor-firebase/crashlytics plugin. Off unless the user switches it on (kept per phone);
 * the APK's manifest keeps collection off until then. The app never sets a user id, keys or
 * logs, so a report holds the crash, the phone model, the Android and app version and an
 * install id. Crashes from before the switch was on are deleted, never sent.
 * docs/error-reporting.md.
 * @module services/crash-reports
 */

import { safeSetItem } from '../utils/storage-full.js';

export const CRASH_REPORTS_KEY = 'aadhat.crashReports';

/** The native plugin in the Android app, or null (website, older APK). */
export function crashPlugin(win = window) {
    const cap = win.Capacitor;
    if (!cap?.isNativePlatform?.() || !cap.isPluginAvailable?.('FirebaseCrashlytics')) return null;
    return cap.Plugins?.FirebaseCrashlytics || null;
}

export const CrashReports = {
    /** Last result of apply(): 'on' | 'off' | 'unavailable' | 'not-set-up'. */
    state: 'unavailable',

    isOn() {
        try { return localStorage.getItem(CRASH_REPORTS_KEY) === '1'; } catch { return false; }
    },

    /**
     * Tells Crashlytics the switch: on enables collection; off disables it and deletes any
     * report kept on the phone. Never throws.
     * @param {{fresh?: boolean}} [opts] fresh: just switched on, so earlier reports are deleted first
     * @returns {Promise<string>} the state
     */
    async apply({ fresh = false } = {}) {
        const plugin = crashPlugin();
        if (!plugin) {
            this.state = 'unavailable';
        } else {
            const on = this.isOn();
            try {
                if (!on || fresh) await plugin.deleteUnsentReports();
                await plugin.setEnabled({ enabled: on });
                this.state = on ? 'on' : 'off';
            } catch (e) {
                // No Firebase config in this APK (docs/error-reporting.md, set-up)
                console.warn('Crash reports not set up:', e?.message || e);
                this.state = 'not-set-up';
            }
        }
        this.render();
        return this.state;
    },

    async setOn(on) {
        safeSetItem(CRASH_REPORTS_KEY, on ? '1' : '0');
        return this.apply({ fresh: !!on });
    },

    /** The Settings card: shown only in the Android app; the note when it isn't set up. */
    render() {
        const card = document.getElementById('crashReportsCard');
        if (!card) return;
        const plugin = crashPlugin();
        card.hidden = !plugin;
        const box = document.getElementById('settingCrashReports');
        if (box) {
            box.checked = this.isOn() && this.state !== 'not-set-up';
            box.disabled = this.state === 'not-set-up';
            if (!box.dataset.bound) {
                box.dataset.bound = '1';
                box.addEventListener('change', () => { this.setOn(box.checked); });
            }
        }
        const note = document.getElementById('crashReportsNotSetUp');
        if (note) note.hidden = this.state !== 'not-set-up';
    }
};
