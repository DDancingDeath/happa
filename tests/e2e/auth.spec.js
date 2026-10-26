/** Login gate in a real browser (#127, #96): pending users stay out; staff see a reduced menu. */
const { test, expect, login } = require('./support/app');

test('pending user is signed out with a message', async ({ page, problems }) => {
    await login(page, 'pending');
    await expect(page.locator('#loginMessage')).toHaveText(/pending approval/, { timeout: 30000 });
    await expect(page.locator('#authScreen')).toBeVisible();
    await expect(page.locator('#appContent')).toHaveClass(/hidden/);
    expect(problems.pageErrors).toEqual([]);
});

test('staff gets in without Money / Admin / Diagnostics', async ({ page, problems }) => {
    await login(page, 'staff');
    const hidden = await page.evaluate(() => {
        const out = {};
        document.querySelectorAll('.nav-menu a[onclick]').forEach(a => {
            const tab = a.getAttribute('onclick').match(/showTab\('([^']+)'/)?.[1];
            if (tab) out[tab] = a.style.display === 'none';
        });
        return out;
    });
    expect(hidden).toMatchObject({ money: true, insights: true, statements: true, admin: true, diagnostics: true, billing: false });
    expect(problems.pageErrors).toEqual([]);
});
