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
export const TEST_EXCEPTION_MESSAGE = 'Test error sent by the owner from Diagnostics, not a real error';
export const TEST_CRASH_MESSAGE = 'Test crash sent by the owner from Diagnostics';

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

    /**
     * Whether an owner's test can reach Crashlytics from here (#122):
     * 'web' (no plugin), 'not-set-up' (no Firebase config in this APK), 'off' or 'on'.
     * @returns {'web'|'not-set-up'|'off'|'on'}
     */
    testReach() {
        if (!crashPlugin()) return 'web';
        if (this.state === 'not-set-up') return 'not-set-up';
        return this.state === 'on' && this.isOn() ? 'on' : 'off';
    },

    /**
     * A non-fatal test report; sent by Crashlytics on the next app start. Never throws.
     * @param {string} [message]
     * @returns {Promise<boolean>} recorded
     */
    async sendTestException(message = TEST_EXCEPTION_MESSAGE) {
        if (this.testReach() !== 'on') return false;
        try {
            await crashPlugin().recordException({ message });
            return true;
        } catch (e) {
            console.warn('Test crash report not recorded:', e?.message || e);
            return false;
        }
    },

    /**
     * Closes the app with a test crash. The plugin's crash() throws even without a Firebase
     * config, so it is called only while reports are on (and therefore set up).
     * @param {string} [message]
     * @returns {Promise<boolean>} false when not called
     */
    async sendTestCrash(message = TEST_CRASH_MESSAGE) {
        if (this.testReach() !== 'on') return false;
        await crashPlugin().crash({ message });
        return true;
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
