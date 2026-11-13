/* Local only: axe contrast on the desktop shell (sidebar + page header) in every theme × mode, en + hi. */
const AxeBuilder = require('@axe-core/playwright').default;
const { test, expect, login, showTab } = require('./support/app');

const COMBOS = [['modern', 'light'], ['modern', 'dark'], ['nordic', 'light'], ['nordic', 'dark'], ['nature', 'light'], ['nature', 'dark'],
    ['dark', 'dark'], ['midnight', 'dark'], ['vintage', 'light'], ['vintage', 'dark'], ['classic', 'light'], ['classic', 'dark'], ['premium', 'light'], ['premium', 'dark']];

for (const [theme, mode] of COMBOS) {
    test(`shell contrast ${theme} ${mode}`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'desktop', 'desktop');
        await page.addInitScript(([th, ap, kind]) => {
            if (sessionStorage.getItem('e2e.themeSet')) return;
            sessionStorage.setItem('e2e.themeSet', '1');
            localStorage.setItem('happa.theme', th);
            localStorage.setItem('happa.appearance', ap);
            localStorage.setItem('happa.themeKind', kind);
        }, [theme, mode, ['dark', 'midnight'].includes(theme) ? 'dark' : 'both']);
        await login(page, 'owner');
        await showTab(page, 'billing');
        for (const lang of ['en', 'hi']) {
            await page.evaluate((l) => window.app.i18n.setLang(l), lang);
            await page.hover('#sideNav a[data-onclick*="\'history\'"]');
            const r = await new AxeBuilder({ page }).include('#sideNav').include('#appBar').withRules(['color-contrast']).analyze();
            expect(r.violations.flatMap(v => v.nodes.map(n => n.target.join(' ') + ' ' + n.failureSummary)), `${theme} ${mode} ${lang}`).toEqual([]);
        }
    });
}
