/**
 * The first screen from the phone's cache (#59, docs/startup-cached-first.md): a phone that has
 * opened the app before shows it from Firestore's cache answers without waiting for the server,
 * marks the figures "Updating…" until every listener heard from the server, and never lets a stale
 * figure corrupt money. The server's answers are held back by holding the listen channel's
 * requests sent after the profile read (the profile itself is read from the server, as before).
 */
const { devices } = require('@playwright/test');
const { test, expect, isReady, login, showTab } = require('./support/app');
const { creditSale, openDueRow, record } = require('./support/due');
const { getDoc } = require('./support/emulator');

const APP_VERSION = require('../../package.json').version;
const LISTEN = /Firestore\/Listen\/channel/;
const FIRESTORE = /documents:(batchGet|runQuery|commit)|Firestore\/(Listen|Write)\/channel/;

/** The phone's own settings (keeps the "What's new" sheet away), as openApp sets them. */
const quietStart = (page) => page.addInitScript((version) => {
    localStorage.setItem('aadhat.lastSeenVersion', version);
    localStorage.setItem('aadhat.updateLastCheck', String(Date.now()));
    localStorage.setItem('aadhat.updateDismissedVersion', '999.0.0');
}, APP_VERSION);

/**
 * Closes the app and opens it again with the server's listen answers held back until release().
 * @returns {Promise<{release: function(): Promise<void>}>}
 */
async function reopenWithServerHeld(page) {
    await page.goto('/manifest.webmanifest');
    let open;
    const gate = new Promise(resolve => { open = resolve; });
    let holding = true;
    await page.route(LISTEN, async (route) => {
        if (holding) {
            const profiled = await page.evaluate(() => performance.getEntriesByName('aadhat:profile').length > 0).catch(() => false);
            if (profiled) await gate;
        }
        await route.continue().catch(() => {});
    });
    await page.goto('/?emulator=1', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(isReady, null, { timeout: 60000 });
    return {
        release: async () => {
            holding = false;
            open();
            await page.unroute(LISTEN).catch(() => {});
        }
    };
}

const pillText = (page) => page.locator('#syncStatus');
const dueRow = (page, customer) => page.locator('#due').getByText(customer, { exact: false });

test('a bill saved on another phone: the reopened app shows its cached figures as "Updating…", then the bill', async ({ page, browser, baseURL, problems }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'two phones, once');
    test.setTimeout(240000);
    await login(page, 'owner');
    await showTab(page, 'due');

    // The owner's phone is closed; the staff phone saves a credit sale meanwhile
    await page.goto('/manifest.webmanifest');
    const customer = `E2E other phone ${Date.now()}`;
    const ctx = await browser.newContext({ ...devices['Pixel 5'], baseURL, serviceWorkers: 'block' });
    try {
        const staff = await ctx.newPage();
        await login(staff, 'staff');
        await creditSale(staff, customer);
    } finally {
        await ctx.close();
    }

    const server = await reopenWithServerHeld(page);
    try {
        const startup = await page.evaluate(() => window.FirebaseService.getStartupListenerInfo());
        expect(Object.values(startup).filter(l => l.readyBy).every(l => l.readyBy === 'cache')).toBe(true);
        expect(await page.evaluate(() => window.FirebaseService.dataFreshness())).toBe('cache');
        await expect(pillText(page)).toHaveText('Updating…');
        await showTab(page, 'due');
        await page.click('#due .filter-sale');
        await expect(page.locator('#due .updating-note')).toBeVisible();
        await expect(dueRow(page, customer)).toHaveCount(0);
    } finally {
        await server.release();
    }

    await expect(dueRow(page, customer).first()).toBeVisible({ timeout: 60000 });
    await expect(page.locator('#due .updating-note')).toBeHidden();
    await expect(pillText(page)).not.toHaveText(/Updating|Not updated/);
    expect(problems.pageErrors).toEqual([]);
});

test('two phones: a due paid on the other phone can\'t be paid again from the stale cached due', async ({ page, browser, baseURL, problems }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'two phones, once');
    test.setTimeout(240000);
    await login(page, 'owner');
    const sale = await creditSale(page, `E2E stale due ${Date.now()}`);
    await openDueRow(page, sale.id);

    // The owner's phone is closed; the manager takes ₹200 of the ₹360 due on theirs
    await page.goto('/manifest.webmanifest');
    const ctx = await browser.newContext({ ...devices['Pixel 5'], baseURL, serviceWorkers: 'block' });
    try {
        const manager = await ctx.newPage();
        await login(manager, 'manager');
        await openDueRow(manager, sale.id);
        await record(manager, sale.id, 200);
        await expect(manager.locator('#toast')).toHaveText(/Payment of ₹200 recorded/, { timeout: 30000 });
    } finally {
        await ctx.close();
    }

    const server = await reopenWithServerHeld(page);
    try {
        await openDueRow(page, sale.id);
        await expect(page.locator('#due .updating-note')).toBeVisible();
        // The cached due is still ₹360: paying it all is refused against the server's copy (₹160 left)
        await record(page, sale.id, 360);
        await expect(page.locator('#toast')).toHaveText(
            /another payment on this bill was recorded at the same moment\. Due now ₹160|exceeds outstanding amount \(₹160\)/,
            { timeout: 60000 });
    } finally {
        await server.release();
    }
    const doc = await getDoc('dev_retailSales', sale._id);
    expect(doc.payments).toHaveLength(1);
    expect(doc.payment).toMatchObject({ cash: 200, due: 160 });
    await expect(page.locator('#due .updating-note')).toBeHidden({ timeout: 60000 });
    expect(problems.pageErrors).toEqual([]);
});

test('an offline reopen shows the cached figures as "Offline", without "Updating…"', async ({ page, context, problems }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'network scenario, once');
    test.setTimeout(180000);
    await login(page, 'owner');
    await showTab(page, 'day');
    const customer = `E2E offline ${Date.now()}`;
    await creditSale(page, customer);
    await page.close();

    const offline = await context.newPage();
    await quietStart(offline);
    await offline.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false }));
    await offline.route(FIRESTORE, (route) => route.abort('internetdisconnected'));
    await offline.goto('/?emulator=1', { waitUntil: 'domcontentloaded' });
    await offline.waitForFunction(isReady, null, { timeout: 60000 });
    await expect(offline.locator('#syncStatus')).toHaveText(/^Offline/);
    await showTab(offline, 'due');
    await offline.click('#due .filter-sale');
    await expect(dueRow(offline, customer).first()).toBeVisible();
    await expect(offline.locator('#due .updating-note')).toBeHidden();
    expect(problems.pageErrors).toEqual([]);
});
