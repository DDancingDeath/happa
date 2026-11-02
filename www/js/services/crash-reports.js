/**
 * @fileoverview Crash reports for the Android app (#122): Firebase Crashlytics through the
 * @capacitor-firebase/crashlytics plugin. Off unless the user switches it on (kept per phone);
 * the APK's manifest keeps collection off until then. The app sets no user id, keys or logs;
 * a report holds the crash and its message, the phone model, Android and app version, device
 * state and an install id. Crashes from before the switch was on are deleted, never sent.
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
    /** apply() runs one at a time, so a quick on → off can't end with collection on. */
    queue: Promise.resolve(),

    isOn() {
        try { return localStorage.getItem(CRASH_REPORTS_KEY) === '1'; } catch { return false; }
    },

    /**
     * Tells Crashlytics the switch: on enables collection; off disables it and deletes any
     * report kept on the phone. Never throws. Calls run in order, each after the one before.
     * @param {{fresh?: boolean}} [opts] fresh: just switched on, so earlier reports are deleted first
     * @returns {Promise<string>} the state
     */
    apply(opts) {
        const run = this.queue.then(() => this.applyNow(opts));
        this.queue = run.catch(() => {});
        return run;
    },

    async applyNow({ fresh = false } = {}) {
        const plugin = crashPlugin();
        if (!plugin) {
            this.state = 'unavailable';
        } else {
            try {
                // Off: stop collecting, then delete what waits; on: delete what waits from before, then collect
                if (fresh && this.isOn()) await plugin.deleteUnsentReports();
                // Read again: the switch may have been turned off while the delete ran
                const on = this.isOn();
                await plugin.setEnabled({ enabled: on });
                if (!on) await plugin.deleteUnsentReports();
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
