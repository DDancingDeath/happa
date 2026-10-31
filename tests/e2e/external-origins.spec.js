/**
 * The two external origins the app loads from outside Firebase (#89), run under the
 * report-only CSP the static server copies from firebase.json; the fixture fails on any
 * CSP report. Excel export loads SheetJS from cdn.sheetjs.com for real (pinned + SRI);
 * the update check's api.github.com call is answered by a route (the CSP check happens
 * in the browser before the request is routed).
 */
const { test, expect, login, showTab } = require('./support/app');

test('Excel export loads SheetJS from its CDN and downloads the items workbook', async ({ page, problems }) => {
    await login(page, 'owner');
    await showTab(page, 'items');
    const sheetjs = page.waitForResponse((r) => r.url().startsWith('https://cdn.sheetjs.com/'));
    const download = page.waitForEvent('download');
    await page.click('button[onclick="window.app.items.exportExcel()"]');
    expect((await sheetjs).status()).toBe(200);
    expect((await download).suggestedFilename()).toMatch(/^items_\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(await page.evaluate(() => typeof window.XLSX?.writeFile)).toBe('function');
    expect(problems.pageErrors).toEqual([]);
    expect(problems.consoleErrors).toEqual([]);
});

test('the Android update check calls the GitHub releases API and offers the newer APK', async ({ page, problems }) => {
    const calls = [];
    await page.route('https://api.github.com/**', (route) => {
        calls.push(route.request().url());
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ tag_name: 'v99.0.0' })
        });
    });
    await login(page, 'owner');
    // The check runs only inside the APK: pretend to be native for this one call.
    await page.evaluate(async () => {
        localStorage.removeItem('aadhat.updateLastCheck');
        localStorage.removeItem('aadhat.updateDismissedVersion');
        const { AppUpdatesManager } = await import('/js/modules/app-updates.js');
        const saved = window.Capacitor;
        window.Capacitor = { isNativePlatform: () => true };
        try {
            await AppUpdatesManager.checkForAndroidUpdate();
        } finally {
            window.Capacitor = saved;
        }
    });
    expect(calls).toEqual(['https://api.github.com/repos/DDancingDeath/happa/releases/latest']);
    await expect(page.locator('#appUpdateBanner')).toContainText('99.0.0');
    expect(problems.pageErrors).toEqual([]);
    expect(problems.consoleErrors).toEqual([]);
});
