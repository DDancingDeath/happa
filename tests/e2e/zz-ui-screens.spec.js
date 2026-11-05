// Temporary (branch ui-revamp-screens only): before/after screenshots for the UI refresh PR.
const base = require('@playwright/test');
const path = require('path');
const { login, openApp, showTab, settle } = require('./support/app');
const { seed } = require('./support/seed');

const OUT = process.env.SHOTS_DIR || 'shots';
const SIZES = {
    phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    desktop: { viewport: { width: 1366, height: 768 } }
};
const SCREENS = [
    ['billing', 'billing'], ['today', 'day'], ['outstanding', 'due'], ['history', 'history'],
    ['stock', 'stock'], ['money', 'money'], ['insights', 'insights'], ['settings', 'settings-common']
];

base.test.beforeAll(async () => { await seed(); });

for (const size of Object.keys(SIZES)) {
    for (const theme of ['light', 'dark']) {
        base.test(`${size}-${theme}`, async ({ browser, baseURL }) => {
            base.test.setTimeout(300000);
            const ctx = await browser.newContext({ ...SIZES[size], baseURL, serviceWorkers: 'block' });
            if (theme === 'dark') await ctx.addInitScript(() => localStorage.setItem('darkMode', 'true'));
            const page = await ctx.newPage();
            page.on('dialog', d => d.accept());
            const shot = (name) => page.screenshot({ path: path.join(OUT, `${size}-${theme}-${name}.png`) });
            await openApp(page);
            await page.waitForTimeout(800);
            await shot('login');
            await login(page, 'owner');
            for (const [name, route] of SCREENS) {
                await showTab(page, route);
                await settle(page);
                await page.waitForTimeout(400);
                await shot(name);
            }
            if (size === 'phone') {
                await showTab(page, 'billing');
                await page.click('.hamburger');
                await page.waitForTimeout(600);
                await shot('menu');
                await page.evaluate(() => document.querySelector('.overlay.active')?.click());
                if (theme === 'light') {
                    await page.evaluate(() => window.app.i18n.setLang('hi'));
                    for (const [name, route] of [['billing', 'billing'], ['today', 'day'], ['money', 'money']]) {
                        await showTab(page, route);
                        await settle(page);
                        await page.waitForTimeout(400);
                        await shot(`hi-${name}`);
                    }
                }
            }
            await ctx.close();
        });
    }
}
