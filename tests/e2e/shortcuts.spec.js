/**
 * Home-screen shortcuts (#151): a launch URL with `?shortcut=` opens that page
 * (and bill mode) after sign-in, once.
 */
const { test, expect } = require('./support/app');
const { USERS, PASSWORD } = require('./support/emulator');

async function launch(page, shortcut) {
    await page.goto(`/?emulator=1&source=pwa&shortcut=${shortcut}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#loginEmail', { state: 'visible' });
    await page.fill('#loginEmail', USERS.owner.email);
    await page.fill('#loginPassword', PASSWORD);
    await page.click('#loginForm button[type=submit]');
}

test('the History shortcut opens History; the URL loses the shortcut', async ({ page, problems }) => {
    await launch(page, 'history');
    await expect(page.locator('#history.tab.active')).toBeVisible({ timeout: 60000 });
    expect(new URL(page.url()).searchParams.get('shortcut')).toBeNull();
    expect(problems.pageErrors).toEqual([]);
});

test('the New sale shortcut opens Billing in sale mode', async ({ page, problems }) => {
    await launch(page, 'sale');
    await expect(page.locator('#billing.tab.active')).toBeVisible({ timeout: 60000 });
    await expect(page.locator('#saleSection')).toBeVisible();
    await expect(page.locator('#purchaseSection')).toBeHidden();
    expect(problems.pageErrors).toEqual([]);
});
