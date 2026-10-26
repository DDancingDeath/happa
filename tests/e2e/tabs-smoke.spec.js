/**
 * Click-every-tab smoke (#127): the owner opens every page; any uncaught page
 * error or console error fails the test.
 */
const { test, expect, login, showTab } = require('./support/app');

const TABS = ['billing', 'day', 'history', 'due', 'stock', 'rates', 'items', 'expenses', 'wholesale-sales',
    'cash-management', 'finance', 'reports', 'reports-trends', 'reports-traffic', 'rate-trends', 'rates-traffic',
    'reports', 'analytics', 'settings', 'admin', 'diagnostics'];

test('every page opens without errors', async ({ page, problems }) => {
    await login(page, 'owner');
    const nav = await page.locator('.nav-menu').first().textContent();
    expect(nav).toContain('Rates');
    expect(nav).not.toContain('Rate trends');
    await expect(page.locator('#items .rates-subtabs')).toHaveCount(0);
    await expect(page.locator('#reports #rate-trends')).toHaveCount(1);
    for (const tab of TABS) {
        await test.step(tab, async () => {
            await showTab(page, tab);
            await page.waitForTimeout(400);
        });
    }
    await test.step('Reports › Product traffic, then Rates', async () => {
        await showTab(page, 'reports-traffic');
        await expect(page.locator('#rtTrafficSection')).toBeVisible();
        await expect(page.locator('#reportsOverviewTab')).toBeHidden();
        await showTab(page, 'rates');
        await expect(page.locator('#items')).toBeVisible();
        await expect(page.locator('#rate-trends')).toBeHidden();
    });
    expect(problems.pageErrors).toEqual([]);
    expect(problems.consoleErrors).toEqual([]);
});
