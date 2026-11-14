/**
 * The saved theme and appearance are applied at boot, before first paint, by the inline #themeBoot
 * script at the top of <body> in index.html (#102, redesign DIRECTION §4.4). It is the one inline
 * script: the CSP allows it by its sha256 (security-headers.test.js). js/ui/theme.js must reach the
 * same result from the same keys, so the page does not change once the app starts.
 */
const fs = require('fs');
const path = require('path');
import { resolveMode, storedChoice } from '../ui/theme.js';
import { themeById } from '../ui/themes.js';

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const bootScript = /<script id="themeBoot">([\s\S]*?)<\/script>/.exec(html);
const root = document.documentElement;

function setSystemDark(dark) {
    window.matchMedia = jest.fn((q) => ({ matches: q === '(prefers-color-scheme: dark)' && dark, media: q }));
}

function boot(keys = {}, { systemDark = false } = {}) {
    localStorage.clear();
    for (const [k, v] of Object.entries(keys)) localStorage.setItem(k, v);
    setSystemDark(systemDark);
    document.body.className = '';
    for (const a of ['data-theme', 'data-appearance', 'data-mode']) root.removeAttribute(a);
    new Function(bootScript[1])();
    return {
        theme: root.getAttribute('data-theme'),
        appearance: root.getAttribute('data-appearance'),
        mode: root.getAttribute('data-mode'),
        bodyClass: document.body.className,
    };
}

describe('theme boot script (#102)', () => {
    beforeEach(() => {
        document.head.innerHTML = '<meta name="theme-color" content="#667eea">';
    });

    afterEach(() => {
        document.body.className = '';
        localStorage.clear();
        delete window.matchMedia;
    });

    test('is the first thing in <body>, so it runs before the app paints', () => {
        expect(bootScript).not.toBeNull();
        const afterBody = html.slice(html.indexOf('<body>') + '<body>'.length);
        expect(afterBody.replace(/<!--[\s\S]*?-->/g, '').trim().startsWith('<script id="themeBoot">')).toBe(true);
    });

    test('is one line, so its CSP hash does not depend on the checkout line endings', () => {
        expect(bootScript[1]).not.toMatch(/[\r\n]/);
    });

    test('a new device follows the system appearance with the default theme', () => {
        expect(boot({}, { systemDark: false })).toEqual({ theme: 'modern', appearance: 'system', mode: 'light', bodyClass: '' });
        expect(boot({}, { systemDark: true })).toEqual({ theme: 'modern', appearance: 'system', mode: 'dark', bodyClass: '' });
    });

    test('an install from before the theme engine keeps Light until the user picks', () => {
        expect(boot({ 'aadhat.itemNamesFollowLang': '1' }, { systemDark: true })).toMatchObject({ appearance: 'light', mode: 'light', bodyClass: '' });
        expect(boot({ 'aadhat.itemNamesFollowLang': '1', 'happa.appearance': 'system' }, { systemDark: true })).toMatchObject({ mode: 'dark' });
    });

    test('the old darkMode setting keeps its look: true is Dark, false is Light, whatever the system says', () => {
        expect(boot({ darkMode: 'true' }, { systemDark: false })).toMatchObject({ appearance: 'dark', mode: 'dark', bodyClass: '' });
        expect(boot({ darkMode: 'false' }, { systemDark: true })).toMatchObject({ appearance: 'light', mode: 'light', bodyClass: '' });
    });

    test('a saved appearance wins over the old darkMode setting', () => {
        expect(boot({ darkMode: 'true', 'happa.appearance': 'light' })).toMatchObject({ appearance: 'light', mode: 'light' });
        expect(boot({ 'happa.appearance': 'system' }, { systemDark: true })).toMatchObject({ mode: 'dark', bodyClass: '' });
    });

    test('an always-dark theme stays dark under Light and System, and keeps the choice', () => {
        const keys = { 'happa.theme': 'midnight', 'happa.themeKind': 'dark', 'happa.appearance': 'light' };
        expect(boot(keys)).toEqual({ theme: 'midnight', appearance: 'light', mode: 'dark', bodyClass: '' });
    });

    test('a saved theme the app could not show (happa.themeFallback) follows the appearance, not its stale kind or bar colour', () => {
        const keys = { 'happa.theme': 'gone', 'happa.themeKind': 'dark', 'happa.appearance': 'light', 'happa.bar.light': '#07070d', 'happa.themeFallback': 'gone' };
        expect(boot(keys)).toEqual({ theme: 'gone', appearance: 'light', mode: 'light', bodyClass: '' });
        expect(document.querySelector('meta[name="theme-color"]').getAttribute('content')).toBe('#667eea');
        expect(boot({ ...keys, 'happa.appearance': 'system' }, { systemDark: true }).mode).toBe('dark');
        // The marker names another theme (the app knows this one again): the saved kind applies
        expect(boot({ ...keys, 'happa.theme': 'midnight' }).mode).toBe('dark');
    });

    test('sets the cached browser bar colour of the mode, only when it is a #rrggbb colour', () => {
        boot({ 'happa.appearance': 'dark', 'happa.bar.dark': '#0d0d10', 'happa.bar.light': '#f7f7f9' });
        expect(document.querySelector('meta[name="theme-color"]').getAttribute('content')).toBe('#0d0d10');
        document.head.innerHTML = '<meta name="theme-color" content="#667eea">';
        boot({ 'happa.appearance': 'light', 'happa.bar.light': 'red;x' });
        expect(document.querySelector('meta[name="theme-color"]').getAttribute('content')).toBe('#667eea');
    });

    test('blocked storage leaves the page light rather than failing', () => {
        const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
        try {
            expect(() => boot()).not.toThrow();
            expect(root.getAttribute('data-mode')).toBeNull();
        } finally {
            spy.mockRestore();
        }
    });

    test.each([
        [{}, false], [{}, true], [{ darkMode: 'true' }, false], [{ darkMode: 'false' }, true],
        [{ 'happa.appearance': 'dark' }, false], [{ 'happa.appearance': 'light' }, true],
        [{ 'happa.appearance': 'system', darkMode: 'true' }, false], [{ 'happa.appearance': 'system' }, true],
        [{ 'aadhat.itemNamesFollowLang': '0' }, true], [{ 'aadhat.itemNamesFollowLang': '1', darkMode: 'true' }, false],
    ])('ThemeManager reads %j (system dark: %s) the same way', (keys, systemDark) => {
        const booted = boot(keys, { systemDark });
        const choice = storedChoice(localStorage);
        expect(choice).toEqual({ theme: booted.theme, appearance: booted.appearance });
        expect(resolveMode(choice.appearance, themeById(choice.theme).kind, systemDark)).toBe(booted.mode);
    });
});
