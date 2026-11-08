/**
 * ThemeManager (js/ui/theme.js): Appearance Light / Dark / System, saved on this device only.
 */
import { ThemeManager, THEME_KEYS } from '../ui/theme.js';

let listeners;
let systemDark;

function mockSystem(dark) {
    systemDark = dark;
    listeners = [];
    window.matchMedia = jest.fn(() => ({
        get matches() { return systemDark; },
        addEventListener: (_, fn) => listeners.push(fn),
    }));
}

const attrs = () => ['data-theme', 'data-appearance', 'data-mode'].map((a) => document.documentElement.getAttribute(a));

beforeEach(() => {
    localStorage.clear();
    document.head.innerHTML = '<meta name="theme-color" content="#667eea">';
    document.body.className = '';
    ThemeManager._watching = false;
    mockSystem(false);
});

afterEach(() => {
    delete window.matchMedia;
});

test('a new device starts on System with the default theme, and keeps it once the app writes its keys', () => {
    expect(ThemeManager.init()).toEqual({ theme: 'modern', appearance: 'system' });
    expect(attrs()).toEqual(['modern', 'system', 'light']);
    expect(localStorage.getItem(THEME_KEYS.appearance)).toBe('system');
    localStorage.setItem(THEME_KEYS.existingInstall, '1');
    expect(ThemeManager.init().appearance).toBe('system');
});

test('an install from before the theme engine keeps Light, even with a dark device', () => {
    mockSystem(true);
    localStorage.setItem(THEME_KEYS.existingInstall, '1');
    expect(ThemeManager.init()).toEqual({ theme: 'modern', appearance: 'light' });
    expect(attrs()[2]).toBe('light');
    expect(localStorage.getItem(THEME_KEYS.appearance)).toBe('light');
});

test('init uses the choice read when the module loaded (before main.js wrote its keys)', () => {
    localStorage.setItem(THEME_KEYS.existingInstall, '1');
    expect(ThemeManager.init({ theme: 'modern', appearance: 'system' }).appearance).toBe('system');
    expect(localStorage.getItem(THEME_KEYS.appearance)).toBe('system');
});

test('System follows the device live, with body.dark-mode', () => {
    ThemeManager.init();
    systemDark = true;
    listeners.forEach((fn) => fn());
    expect(attrs()[2]).toBe('dark');
    expect(document.body.classList.contains('dark-mode')).toBe(true);
});

test('a fixed choice ignores the device', () => {
    localStorage.setItem(THEME_KEYS.appearance, 'light');
    ThemeManager.init();
    systemDark = true;
    listeners.forEach((fn) => fn());
    expect(attrs()[2]).toBe('light');
});

test('apply saves the new keys, drops the old darkMode and fires aadhat:themechange', () => {
    localStorage.setItem('darkMode', 'true');
    ThemeManager.init();
    expect(attrs()).toEqual(['modern', 'dark', 'dark']);
    const seen = [];
    window.addEventListener('aadhat:themechange', (e) => seen.push(e.detail.mode), { once: true });
    ThemeManager.apply({ appearance: 'light' });
    expect(attrs()).toEqual(['modern', 'light', 'light']);
    expect(document.body.classList.contains('dark-mode')).toBe(false);
    expect(seen).toEqual(['light']);
    expect(localStorage.getItem(THEME_KEYS.appearance)).toBe('light');
    expect(localStorage.getItem(THEME_KEYS.theme)).toBe('modern');
    expect(localStorage.getItem(THEME_KEYS.kind)).toBe('both');
    expect(localStorage.getItem('darkMode')).toBeNull();
});

test('an unknown saved theme falls back to the default', () => {
    localStorage.setItem(THEME_KEYS.theme, 'no-such-theme');
    expect(ThemeManager.init().theme).toBe('modern');
    expect(attrs()[0]).toBe('modern');
});

test('the browser bar takes the page colour and caches it for the boot script', () => {
    document.documentElement.style.setProperty('--bg', '#0d0d10');
    try {
        ThemeManager.apply({ appearance: 'dark' });
        expect(document.querySelector('meta[name="theme-color"]').getAttribute('content')).toBe('#0d0d10');
        expect(localStorage.getItem(THEME_KEYS.barDark)).toBe('#0d0d10');
    } finally {
        document.documentElement.style.removeProperty('--bg');
    }
});
