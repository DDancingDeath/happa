/* Local only (not committed): desktop shell screenshots for the 4.2 PR. */
const fs = require('fs');
const path = require('path');
const { test, expect, login, showTab, settle } = require('./support/app');

const OUT = process.env.SHOTS_DIR || path.join(__dirname, '../../../p4-2-work/x');
const H = { 1024: 768, 1280: 800, 1366: 768 };

const SHOTS = [
    ['modern', 'light', 'en', 'billing', 1366, 'owner'],
    ['modern', 'light', 'en', 'billing', 1280, 'owner'],
    ['modern', 'light', 'en', 'billing', 1024, 'owner'],
    ['modern', 'light', 'en', 'day', 1366, 'owner'],
    ['modern', 'light', 'en', 'due', 1280, 'owner'],
    ['modern', 'dark', 'en', 'billing', 1366, 'owner'],
    ['modern', 'dark', 'en', 'day', 1280, 'owner'],
    ['modern', 'light', 'hi', 'billing', 1366, 'owner'],
    ['modern', 'light', 'hi', 'day', 1024, 'owner'],
    ['vintage', 'dark', 'hi', 'day', 1366, 'owner'],
    ['vintage', 'light', 'en', 'billing', 1280, 'owner'],
    ['midnight', 'system', 'en', 'billing', 1366, 'owner'],
    ['nordic', 'light', 'en', 'day', 1366, 'manager'],
    ['modern', 'light', 'en', 'billing', 1366, 'staff']
];

for (const [theme, appearance, lang, tab, w, role] of SHOTS) {
    const name = `desktop-${w}-${theme}-${appearance}-${lang}-${tab}${role === 'owner' ? '' : `-${role}`}`;
    test(`shot ${name}`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'desktop', 'desktop only');
        test.setTimeout(120000);
        await page.setViewportSize({ width: w, height: H[w] });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.addInitScript(([th, ap, kind, lg]) => {
            if (sessionStorage.getItem('e2e.themeSet')) return;
            sessionStorage.setItem('e2e.themeSet', '1');
            localStorage.setItem('happa.theme', th);
            localStorage.setItem('happa.appearance', ap);
            localStorage.setItem('happa.themeKind', kind);
            localStorage.setItem('aadhat.lang', lg);
        }, [theme, appearance, theme === 'midnight' ? 'dark' : 'both', lang]);
        await login(page, role);
        await showTab(page, tab);
        expect(await settle(page)).toBe(true);
        await page.waitForTimeout(1200);
        fs.mkdirSync(OUT, { recursive: true });
        await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    });
}
