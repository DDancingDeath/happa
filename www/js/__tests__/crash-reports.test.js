/**
 * @fileoverview Crash reports for the Android app (#122): off by default, per phone; the switch
 * drives the Crashlytics plugin and earlier reports are deleted, never sent.
 */
import { CrashReports, CRASH_REPORTS_KEY } from '../services/crash-reports.js';

const CARD = `
  <div id="crashReportsCard" hidden>
    <input type="checkbox" id="settingCrashReports">
    <p id="crashReportsNotSetUp" hidden></p>
  </div>`;

function nativeWith(plugin) {
    window.Capacitor = {
        isNativePlatform: () => true,
        isPluginAvailable: (name) => name === 'FirebaseCrashlytics' && !!plugin,
        Plugins: { FirebaseCrashlytics: plugin }
    };
}

const fakePlugin = () => {
    const calls = [];
    return {
        calls,
        deleteUnsentReports: jest.fn(async () => { calls.push('delete'); }),
        setEnabled: jest.fn(async ({ enabled }) => { calls.push(`enabled:${enabled}`); })
    };
};

beforeEach(() => {
    document.body.innerHTML = CARD;
    localStorage.clear();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    delete window.Capacitor;
    jest.restoreAllMocks();
});

test('website: nothing to switch, the card stays hidden', async () => {
    expect(await CrashReports.apply()).toBe('unavailable');
    expect(document.getElementById('crashReportsCard').hidden).toBe(true);
});

test('Android app, never switched on: collection off and kept reports deleted', async () => {
    const plugin = fakePlugin();
    nativeWith(plugin);
    expect(await CrashReports.apply()).toBe('off');
    expect(plugin.calls).toEqual(['enabled:false', 'delete']);
    expect(document.getElementById('crashReportsCard').hidden).toBe(false);
    expect(document.getElementById('settingCrashReports').checked).toBe(false);
});

test('switched on: reports from before are deleted first, then collection is on; it stays on at the next start', async () => {
    const plugin = fakePlugin();
    nativeWith(plugin);
    await CrashReports.apply();
    plugin.calls.length = 0;
    const box = document.getElementById('settingCrashReports');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 0));
    expect(localStorage.getItem(CRASH_REPORTS_KEY)).toBe('1');
    expect(plugin.calls).toEqual(['delete', 'enabled:true']);
    expect(CrashReports.state).toBe('on');
    plugin.calls.length = 0;
    expect(await CrashReports.apply()).toBe('on');
    expect(plugin.calls).toEqual(['enabled:true']);
});

test('a fast on → off ends with collection off, even when the first delete is slow', async () => {
    const plugin = fakePlugin();
    let releaseDelete;
    plugin.deleteUnsentReports.mockImplementationOnce(() => new Promise(r => {
        releaseDelete = () => { plugin.calls.push('delete'); r(); };
    }));
    nativeWith(plugin);
    const on = CrashReports.setOn(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(plugin.deleteUnsentReports).toHaveBeenCalledTimes(1);
    const off = CrashReports.setOn(false);
    releaseDelete();
    await Promise.all([on, off]);
    expect(plugin.calls).not.toContain('enabled:true');
    expect(plugin.calls[plugin.calls.length - 2]).toBe('enabled:false');
    expect(plugin.calls[plugin.calls.length - 1]).toBe('delete');
    expect(CrashReports.state).toBe('off');
});

test('an APK without the Firebase config: "not set up", the switch is disabled', async () => {
    const plugin = fakePlugin();
    plugin.setEnabled.mockRejectedValue(new Error('Default FirebaseApp is not initialized'));
    nativeWith(plugin);
    localStorage.setItem(CRASH_REPORTS_KEY, '1');
    expect(await CrashReports.apply()).toBe('not-set-up');
    const box = document.getElementById('settingCrashReports');
    expect([box.checked, box.disabled]).toEqual([false, true]);
    expect(document.getElementById('crashReportsNotSetUp').hidden).toBe(false);
});
