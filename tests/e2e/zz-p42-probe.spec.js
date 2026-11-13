/* Local only: the sidebar links each role sees on desktop. */
const { test, login } = require('./support/app');

for (const role of ['owner', 'manager', 'staff']) {
    test(`probe ${role}`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'desktop', 'desktop');
        await login(page, role);
        const out = await page.evaluate(() => {
            const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
            return [...document.querySelectorAll('#sideNav .nav-group')].map(g => ({
                id: g.getAttribute('aria-labelledby'),
                links: [...g.querySelectorAll('a')].filter(vis).map(a => /showTab\('([^']+)'/.exec(a.getAttribute('data-onclick'))?.[1] || a.dataset.rentNav)
            }));
        });
        console.log(`[probe] ${role} ${JSON.stringify(out)}`);
    });
}
