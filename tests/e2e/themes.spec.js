/**
 * Themes (redesign 2.6, DIRECTION §4): text contrast (axe `color-contrast`, WCAG AA) on Billing,
 * Today and Outstanding in every theme × mode, and the Settings › Appearance gallery: a tap previews
 * a theme app-wide without saving it, Cancel or leaving Settings restores the saved one, Apply saves it
 * (it survives a reload, applied before first paint). Phone project only: the CSS is the same on desktop.
 */
const AxeBuilder = require('@axe-core/playwright').default;
const { test, expect, login, showTab, settle } = require('./support/app');
const { seed } = require('./support/seed');

const COMBOS = [
    ['modern', 'light'], ['modern', 'dark'], ['nordic', 'light'], ['nordic', 'dark'],
    ['nature', 'light'], ['nature', 'dark'], ['dark', 'light'], ['midnight', 'system'],
];
const DARK_KIND = new Set(['dark', 'midnight']);
const PAGES = [['Billing', 'billing'], ['Today', 'day'], ['Outstanding', 'due']];

test.skip(({ isMobile }) => !isMobile, 'phone project only');
test.beforeEach(async () => { await seed(); });

async function useTheme(page, theme, appearance) {
    // Once per test: a reload keeps what the app saved since
    await page.addInitScript(([th, ap, kind]) => {
        if (sessionStorage.getItem('e2e.themeSet')) return;
        sessionStorage.setItem('e2e.themeSet', '1');
        localStorage.setItem('happa.theme', th);
        localStorage.setItem('happa.appearance', ap);
        localStorage.setItem('happa.themeKind', kind);
    }, [theme, appearance, DARK_KIND.has(theme) ? 'dark' : 'both']);
}

for (const [theme, appearance] of COMBOS) {
    test(`text contrast is WCAG AA in ${theme} (${appearance})`, async ({ page, problems }) => {
        test.setTimeout(180000);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await useTheme(page, theme, appearance);
        await login(page, 'owner');
        const mode = await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.mode]);
        expect(mode).toEqual([theme, DARK_KIND.has(theme) || appearance === 'dark' ? 'dark' : 'light']);
        const found = [];
        for (const [name, route] of PAGES) {
            await showTab(page, route);
            expect(await settle(page), `${name} finished loading`).toBe(true);
            const result = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
            for (const v of result.violations) {
                for (const n of v.nodes) found.push(`${name}: ${n.target.join(' ')} — ${(n.any[0]?.message || v.help).replace(/\s+/g, ' ')}`);
            }
        }
        if (found.length) console.log(`[themes] ${theme} ${appearance} ${found.length} element(s):\n${found.join('\n')}`);
        expect(found).toEqual([]);
        expect(problems.pageErrors).toEqual([]);
    });
}

test('the gallery previews without saving; Cancel, leaving Settings and Apply behave', async ({ page, problems }) => {
    test.setTimeout(180000);
    await useTheme(page, 'modern', 'light');
    await login(page, 'owner');
    const html = () => page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.mode]);
    const bar = page.locator('#themePreviewBar');

    await showTab(page, 'settings-common');
    await expect(page.locator('#themeGallery .theme-card')).toHaveCount(5);
    await expect(page.locator('[data-theme-choice="modern"]')).toHaveAttribute('aria-pressed', 'true');

    await page.click('[data-theme-choice="nordic"]');
    expect(await html()).toEqual(['nordic', 'light']);
    await expect(bar).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('happa.theme'))).toBe('modern');
    await page.click('#themePreviewBar .theme-preview-cancel');
    expect(await html()).toEqual(['modern', 'light']);
    await expect(bar).toBeHidden();
    await expect(page.locator('[data-theme-choice="nordic"]')).toBeFocused();

    await page.click('[data-theme-choice="midnight"]');
    expect(await html()).toEqual(['midnight', 'dark']);
    await expect(page.locator('#themeDarkHint')).toBeVisible();
    await showTab(page, 'billing');
    expect(await html()).toEqual(['modern', 'light']);
    await expect(bar).toBeHidden();

    await showTab(page, 'settings-common');
    await page.click('[data-theme-choice="nature"]');
    await page.click('#themePreviewBar .theme-preview-apply');
    expect(await html()).toEqual(['nature', 'light']);
    await expect(bar).toBeHidden();
    await expect(page.locator('[data-theme-choice="nature"]')).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem('happa.theme'))).toBe('nature');
    await expect(page.locator('[data-theme-choice="nature"]')).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'nature');
    expect(problems.pageErrors).toEqual([]);
});
