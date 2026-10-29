/**
 * Click-every-tab smoke (#127): the owner opens every page; any uncaught page
 * error or console error fails the test.
 */
const { test, expect, login, showTab } = require('./support/app');

const TABS = ['billing', 'day', 'history', 'due', 'stock', 'rates', 'items', 'expenses', 'wholesale-sales',
    'cash-management', 'money', 'insights', 'statements', 'insights-seasons', 'insights-trends', 'insights-traffic',
    'finance', 'reports', 'analytics', 'reports-trends', 'reports-traffic', 'rate-trends', 'rates-traffic',
    'settings', 'admin', 'diagnostics'];

test('every page opens without errors', async ({ page, problems }) => {
    await login(page, 'owner');
    const nav = await page.locator('.nav-menu').first().textContent();
    expect(nav).toContain('Rates');
    expect(nav).not.toContain('Rate trends');
    await expect(page.locator('#items .rates-subtabs')).toHaveCount(0);
    await expect(page.locator('#insights #rate-trends')).toHaveCount(1);
    await expect(page.locator('#finance, #reports, #analytics')).toHaveCount(0);
    for (const tab of TABS) {
        await test.step(tab, async () => {
            await showTab(page, tab);
            await page.waitForTimeout(400);
        });
    }
    await test.step('old Reports › Product traffic link opens Insights › Seasons, then Rates', async () => {
        await showTab(page, 'reports-traffic');
        await expect(page.locator('#insights')).toBeVisible();
        await expect(page.locator('#rtTrafficSection')).toBeVisible();
        await showTab(page, 'rates');
        await expect(page.locator('#items')).toBeVisible();
        await expect(page.locator('#rtTrafficSection')).toBeHidden();
    });
    expect(problems.pageErrors).toEqual([]);
    expect(problems.consoleErrors).toEqual([]);
});

// Read rules (#57): a member's pages read only what the rules allow them.
const MEMBER_TABS = ['billing', 'day', 'history', 'due', 'stock', 'rates', 'expenses', 'cash-management', 'settings'];

test('a member opens every page they may see without permission errors', async ({ page, problems }) => {
    await login(page, 'staff');
    for (const tab of MEMBER_TABS) {
        await test.step(tab, async () => {
            await showTab(page, tab);
            await page.waitForTimeout(400);
        });
    }
    expect(problems.pageErrors).toEqual([]);
    expect(problems.consoleErrors).toEqual([]);
});
