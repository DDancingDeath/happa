/**
 * #122: the owner's "Send a test error" (Diagnostics › Status). On the website it goes through the
 * error telemetry; in an APK without the Firebase config it says crash reports are not set up and
 * offers no test crash. Managers and members never get it.
 */
const { test, expect, login, showTab } = require('./support/app');
const { listDocs, USERS } = require('./support/emulator');

async function openStatus(page) {
    await showTab(page, 'diagnostics');
    await page.waitForSelector('#diagnosticsTabsContainer .filter-btn.active');
    await page.evaluate(() => window.app.diagnostics.showTab('status'));
    await page.waitForSelector('#diagnosticsContainer [data-status-row]');
}

const shot = async (page, testInfo, name) => {
    // The sign-in toast and the phone's bottom bar would cover the card
    await page.evaluate(() => document.querySelectorAll('#toast, .bottom-nav').forEach(el => { el.style.visibility = 'hidden'; }));
    await testInfo.attach(name, { body: await page.locator('.diag-errtest').screenshot(), contentType: 'image/png' });
    await page.evaluate(() => document.querySelectorAll('#toast, .bottom-nav').forEach(el => { el.style.visibility = ''; }));
};

test('the owner sends a test error from the website; it is stored and listed under Errors', async ({ page, problems }, testInfo) => {
    await login(page, 'owner');
    await openStatus(page);
    const card = page.locator('.diag-errtest');
    await expect(card).toHaveAttribute('data-crash-reach', 'web');
    await expect(card.locator('[data-errtest-note]')).toContainText('only in the Android app');
    await expect(card.locator('[data-errtest="crash"]')).toHaveCount(0);

    await card.locator('[data-errtest="error"]').click();
    await expect(card.locator('[data-errtest-result]')).toHaveText('Test error sent. Open the Errors tab to see it.', { timeout: 20000 });
    await shot(page, testInfo, `web-owner-en-${testInfo.project.name}`);
    const reports = (await listDocs('dev_telemetry')).filter(d => d.fingerprint === 'test-error');
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toMatchObject({ type: 'manual', userRole: 'owner' });
    expect(reports[0].message).toMatch(/^Test error sent by the owner from Diagnostics/);

    await page.evaluate(() => window.app.diagnostics.showTab('errors'));
    await expect(page.locator('#diagnosticsContainer .diagnostics-list')).toContainText('Test error sent by the owner');

    await page.evaluate(() => window.app.i18n.setLang('hi'));
    await page.evaluate(() => window.app.diagnostics.showTab('status'));
    await expect(page.locator('.diag-errtest [data-errtest="error"]')).toHaveText('टेस्ट गड़बड़ी भेजें');
    await shot(page, testInfo, `web-owner-hi-${testInfo.project.name}`);
    await page.evaluate(() => window.app.i18n.setLang('en'));
    expect(problems.pageErrors).toEqual([]);
});

test('Android app without the Firebase config: "not set up", no test crash, and the app keeps running', async ({ page, problems }, testInfo) => {
    await login(page, 'owner');
    const state = await page.evaluate(async () => {
        const calls = [];
        window.Capacitor = {
            isNativePlatform: () => true,
            isPluginAvailable: (n) => n === 'FirebaseCrashlytics',
            Plugins: {
                FirebaseCrashlytics: {
                    setEnabled: async () => { throw new Error('Default FirebaseApp is not initialized'); },
                    deleteUnsentReports: async () => { throw new Error('Default FirebaseApp is not initialized'); },
                    recordException: async () => { calls.push('recordException'); },
                    crash: async () => { calls.push('crash'); }
                }
            }
        };
        window.__crashCalls = calls;
        localStorage.setItem('aadhat.crashReports', '1');
        const { CrashReports } = await import('/js/services/crash-reports.js');
        return CrashReports.apply();
    });
    expect(state).toBe('not-set-up');
    await openStatus(page);
    const card = page.locator('.diag-errtest');
    await expect(card).toHaveAttribute('data-crash-reach', 'not-set-up');
    await expect(card.locator('[data-errtest-note]')).toHaveText(/Crash reports are not set up in this version of the app/);
    await expect(card.locator('[data-errtest="crash"]')).toHaveCount(0);
    await card.locator('[data-errtest="error"]').click();
    await expect(card.locator('[data-errtest-result]')).toHaveText('Test error sent. Open the Errors tab to see it.', { timeout: 20000 });
    await shot(page, testInfo, `apk-not-set-up-en-${testInfo.project.name}`);
    expect(await page.evaluate(() => window.app.diagnostics.sendTestCrash())).toBe(false);
    expect(await page.evaluate(() => window.__crashCalls)).toEqual([]);
    expect(problems.pageErrors).toEqual([]);
});

for (const role of ['manager', 'staff']) {
    test(`a ${role === 'staff' ? 'member' : role} never gets the test and cannot send one`, async ({ page }) => {
        await login(page, role);
        if (role === 'manager') {
            await showTab(page, 'diagnostics');
            await page.waitForSelector('#diagnosticsTabsContainer .filter-btn.active');
            await page.evaluate(() => window.app.diagnostics.showTab('status'));
            await expect(page.locator('#diagnosticsTabsContainer')).not.toContainText('Status');
        }
        await expect(page.locator('.diag-errtest')).toHaveCount(0);
        await page.evaluate(() => window.app.diagnostics.sendTestError());
        await page.waitForTimeout(500);
        const uid = await page.evaluate(() => window.firebase.auth().currentUser.uid);
        const mine = (await listDocs('dev_telemetry')).filter(d => d.fingerprint === 'test-error' && d.userId === uid);
        expect(mine, `${USERS[role].email} sent no test error`).toEqual([]);
    });
}
