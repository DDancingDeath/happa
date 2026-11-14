/**
 * Workers / Salaries (#373, WP-*): the owner adds a worker, records a mid-month advance (part-paid),
 * then more than the rest (paid, advance carried); Today shows the salaries due (WP-11); the page reads the workers once per open and
 * works in Hindi; managers and members cannot open it.
 */
const { test, expect, login, showTab, clickAfterTyping } = require('./support/app');
const { listDocs } = require('./support/emulator');

const row = (page, name) => page.locator('#workersBody .row[data-worker]', { hasText: name });

test('the owner records an advance and the rest; the month goes part-paid, then paid with an advance carried', async ({ page, problems }, testInfo) => {
    await login(page, 'owner');
    await showTab(page, 'workers');
    await expect(page.locator('#workersBody .wp-metrics')).toBeVisible();
    const name = `E2E Worker ${testInfo.project.name} ${Date.now()}`;

    await page.click('#workersBody [data-onclick="workers.showForm(\'add\')"]');
    await page.fill('#wpName', name);
    await page.fill('#wpPay', '9000');
    await clickAfterTyping(page, '#wpSave');
    await expect(page.locator('#toast')).toHaveText(`${name} added`, { timeout: 30000 });
    await expect(row(page, name)).toContainText('₹9,000 a month');

    await page.click('#wpDetail [data-onclick="workers.showForm(\'pay\')"]');
    await page.fill('#wpAmount', '3000');
    await page.selectOption('#wpKind', 'advance');
    await clickAfterTyping(page, '#wpSave');
    await expect(page.locator('#toast')).toHaveText(`₹3,000 recorded for ${name}`, { timeout: 30000 });
    await expect(row(page, name).locator('[data-wp-state]')).toHaveText('Part-paid, ₹3,000 of ₹9,000');
    await expect(row(page, name)).toContainText('₹6,000 still to pay');

    // WP-11: Today shows the salaries still to pay (the page's "Still to pay"), and its button opens the page
    const toPay = (await page.locator('#workersBody [data-wp="WP-9"]').textContent()).trim();
    await showTab(page, 'day');
    const salaries = page.locator('#todayReminders [data-reminder="salaries"]');
    await expect(salaries).toContainText(`Salaries due ${toPay}`);
    await expect(salaries).toContainText(/\d+ workers? still to be paid/);
    await salaries.locator('button').click();
    await expect(page.locator('#workers.tab.active')).toBeVisible();
    await expect(row(page, name).locator('[data-wp-state]')).toHaveText('Part-paid, ₹3,000 of ₹9,000');

    await page.click('#wpDetail [data-onclick="workers.showForm(\'pay\')"]');
    await page.fill('#wpAmount', '8000');
    await page.selectOption('#wpMode', 'online');
    await clickAfterTyping(page, '#wpSave');
    await expect(row(page, name).locator('[data-wp-state]')).toHaveText('Paid', { timeout: 30000 });
    await expect(row(page, name)).toContainText('Advance ₹2,000 carried to next month');

    const doc = (await listDocs('dev_workers')).find(w => w.name === name);
    expect(doc).toMatchObject({ active: true, pays: [{ amount: 9000 }] });
    expect(doc.entries.map(e => [e.amount, e.kind, e.mode])).toEqual([[3000, 'advance', 'cash'], [8000, 'pay', 'online']]);

    // Opening the page again reads the workers once more, from the server, and shows the same
    const before = await page.evaluate(() => window.FirebaseService.getReadStats().reads);
    await showTab(page, 'day');
    await showTab(page, 'workers');
    await expect.poll(() => page.evaluate(() => window.FirebaseService.getReadStats().reads), { timeout: 15000 }).toBeGreaterThan(before);
    await expect(row(page, name).locator('[data-wp-state]')).toHaveText('Paid');

    await page.evaluate(() => window.app.i18n.setLang('hi'));
    await expect(page.locator('#workers h2')).toHaveText('कर्मचारी');
    await expect(row(page, name).locator('[data-wp-state]')).toHaveText('चुकाया');
    await expect(row(page, name)).toContainText('एडवांस ₹2,000 अगले महीने में गया');
    await page.evaluate(() => window.app.i18n.setLang('en'));
    expect(problems.pageErrors).toEqual([]);
    expect(problems.consoleErrors).toEqual([]);
});

for (const [role, label] of [['manager', 'manager'], ['staff', 'member']]) {
    test(`a ${label} has no Workers / Salaries link and cannot open the page`, async ({ page, problems }) => {
        await login(page, role);
        await expect(page.locator('#workersNavLink')).toBeHidden();
        await page.evaluate(() => window.app.nav.showTab('workers'));
        await expect(page.locator('#workers.tab.active')).toHaveCount(0);
        expect(problems.pageErrors).toEqual([]);
    });
}
