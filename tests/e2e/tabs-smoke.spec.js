/**
 * Click-every-tab smoke (#127): the owner opens every page; any uncaught page
 * error or console error fails the test.
 */
const { test, expect, login, showTab } = require('./support/app');

const TABS = ['billing', 'day', 'history', 'due', 'stock', 'rates', 'rates-trends', 'rates-traffic',
    'items', 'rate-trends', 'expenses', 'wholesale-sales',
    'cash-management', 'finance', 'reports', 'analytics', 'settings', 'admin', 'diagnostics'];

test('every page opens without errors', async ({ page, problems }) => {
    await login(page, 'owner');
    const nav = await page.locator('.nav-menu').first().textContent();
    expect(nav).toContain('Rates');
    expect(nav).not.toContain('Rate trends');
    for (const tab of TABS) {
        await test.step(tab, async () => {
            await showTab(page, tab);
            await page.waitForTimeout(400);
        });
    }
    expect(problems.pageErrors).toEqual([]);
    expect(problems.consoleErrors).toEqual([]);
});
