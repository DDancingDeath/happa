/**
 * Rentals cost nothing at start-up (#149, #170; docs/rentals-design.md §4):
 * after the owner's app has started, no js/rentals file was requested and no
 * Firestore request named a rent_* collection. Opening Rentals then loads both
 * (so the probe really sees them) and only after the app-shown timing mark.
 */
const { test, expect, login, confirmModalIfOpen } = require('./support/app');

const RENT_RE = /(?<![a-z])rent_(properties|units|tenants|leases|charges)/;
const RENTALS_FILE = /\/js\/rentals\/|\/templates\/rentals\.html|\/css\/rentals\.css/;

test('start-up loads no rentals code and reads no rent_* data; opening Rentals does', async ({ page, problems }) => {
    const seen = { files: [], rentRequests: [] };
    page.on('request', (r) => {
        if (RENTALS_FILE.test(r.url())) seen.files.push(r.url());
        const body = r.postData() || '';
        if (RENT_RE.test(decodeURIComponent(r.url())) || RENT_RE.test(safeDecode(body))) seen.rentRequests.push(r.url());
    });
    // An old saved choice must not open Rentals: the app always starts on Shop.
    await page.addInitScript(() => localStorage.setItem('happa.business', 'rentals'));
    await login(page, 'owner');
    await page.waitForTimeout(3000);

    expect(seen.files, 'no rentals file at start-up').toEqual([]);
    expect(seen.rentRequests, 'no rent_* request at start-up').toEqual([]);
    await expect(page.locator('body')).not.toHaveClass(/biz-rentals/);
    const timings = await page.evaluate(() => performance.getEntriesByType('mark')
        .filter(m => m.name.startsWith('aadhat:')).map(m => ({ name: m.name, t: Math.round(m.startTime) })));
    console.log('startup timings', JSON.stringify(timings));
    expect(timings.map(m => m.name)).toContain('aadhat:app-shown');

    await page.evaluate(() => window.app.business.set('rentals'));
    await page.waitForFunction(() => document.getElementById('rentals')?.offsetParent !== null);
    await expect.poll(() => seen.files.length).toBeGreaterThan(0);
    await expect.poll(() => seen.rentRequests.length).toBeGreaterThan(0);
    const firstRentals = await page.evaluate(() => performance.getEntriesByType('resource')
        .find(e => /\/js\/rentals\//.test(e.name))?.startTime ?? -1);
    const shown = timings.find(m => m.name === 'aadhat:app-shown').t;
    expect(firstRentals).toBeGreaterThan(shown);

    await page.evaluate(() => window.app.business.set('shop'));
    await expect(page.locator('body')).not.toHaveClass(/biz-rentals/);
    expect(problems.pageErrors).toEqual([]);
});

test('owner adds a property, unit and tenant, moves them in, records a part payment and a meter reading, and moves them out', async ({ page, problems }) => {
    await login(page, 'owner');
    const stamp = String(Date.now()).slice(-6);
    await page.evaluate(() => window.app.rentals.open('properties'));
    await page.waitForSelector('#rentPropName');
    await page.fill('#rentPropName', `Gali ${stamp}`);
    await page.click('#rentalsBody .rent-form button');
    const card = page.locator('.rent-row', { hasText: `Gali ${stamp}` });
    await card.locator('button', { hasText: 'Add unit' }).click();
    await page.fill('#rentUnitLabel', `G${stamp}`);
    await page.fill('#rentUnitRent', '5000');
    await page.click('#rentDialog .rent-btn-primary');
    await expect(card).toContainText(`G${stamp}`);

    await page.evaluate(() => window.app.rentals.page('tenants'));
    await page.fill('#rentTenantName', `Ram ${stamp}`);
    await page.fill('#rentTenantPhone', '9876543210');
    await page.click('#rentalsBody .rent-form button');
    const row = page.locator('.rent-row', { hasText: `Ram ${stamp}` }).first();
    await row.locator('button', { hasText: 'Move in' }).click();
    await page.selectOption('#rentLeaseUnit', { label: `Gali ${stamp} · G${stamp}` });
    await page.click('#rentDialog .rent-btn-primary');
    await expect(row).toContainText(`G${stamp}`);

    await page.evaluate(() => window.app.rentals.page('rent'));
    const rent = page.locator('.rent-row', { hasText: `Ram ${stamp}` });
    await expect(rent).toContainText('5,000');
    await rent.locator('button', { hasText: 'Record payment' }).click();
    await page.fill('#rentPayAmount', '2000');
    await page.click('#rentDialog .rent-btn-primary');
    await expect(rent).toContainText('3,000');
    await expect(rent).toContainText('Part paid');

    await rent.locator('button', { hasText: 'Meter reading' }).click();
    await page.fill('#rentMeterPrev', '100');
    await page.fill('#rentMeterCurr', '150');
    await page.fill('#rentMeterRate', '8');
    await page.click('#rentDialog .rent-btn-primary');
    await expect(rent).toContainText('3,400');

    // Tenant rent-history link: read-only page for this tenant only, no login.
    await page.evaluate(() => window.app.rentals.page('tenants'));
    await row.locator('button', { hasText: 'Make tenant link' }).click();
    await page.locator('#rentDialog button', { hasText: 'Make tenant link' }).click();
    const url = await page.locator('#rentLinkUrl').inputValue({ timeout: 15000 });
    expect(url).toMatch(/\/r\/[A-Za-z0-9_-]{24}\?d=1&emulator=1$/);
    await page.click('#rentDialog .rent-btn-primary');
    const tenantCtx = await page.context().browser().newContext();
    const tenantPage = await tenantCtx.newPage();
    const tenantReads = [];
    tenantPage.on('request', r => { if (/documents\//.test(r.url())) tenantReads.push(r.url()); });
    await tenantPage.goto(url);
    await expect(tenantPage.locator('#rh')).toContainText(`Rent history: Ram ${stamp}`);
    await expect(tenantPage.locator('#rh')).toContainText('3,400');
    expect(tenantReads).toHaveLength(1);

    await row.locator('button', { hasText: 'Move out' }).click();
    await page.click('#rentDialog .rent-btn-primary');
    await expect(row).toContainText('Not living in a unit');
    await tenantPage.reload();
    await expect(tenantPage.locator('#rh')).toContainText('Moved out');

    // The moved-out tenant's link stays until turned off.
    const linked = page.locator('.rent-row', { hasText: `Ram ${stamp}` }).filter({ hasText: 'Moved out' });
    await linked.locator('button', { hasText: 'Tenant link' }).click();
    await page.locator('#rentDialog button', { hasText: 'Turn off link' }).click();
    await confirmModalIfOpen(page);
    await expect(page.locator('#toast')).toContainText('Link turned off', { timeout: 15000 });
    await tenantPage.reload();
    await expect(tenantPage.locator('#rh')).toContainText('not available');
    await tenantCtx.close();

    await page.evaluate(() => window.app.rentals.page('rent'));
    await expect(page.locator('.rent-row', { hasText: `Ram ${stamp}` })).toContainText('Moved out');
    expect(problems.pageErrors).toEqual([]);
    expect(problems.consoleErrors).toEqual([]);
});
function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (_) { return s; }
}
