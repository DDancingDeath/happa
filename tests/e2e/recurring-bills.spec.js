/**
 * Recurring bills (#437, RB-*): the owner adds Electricity every 2 months, enters a bill, pays part of
 * it, sees it on Today (RB-11), then pays the rest; the entries are append-only in Firestore; the page
 * works in Hindi; managers and members cannot open it.
 */
const { test, expect, login, showTab, clickAfterTyping } = require('./support/app');
const { listDocs } = require('./support/emulator');

const row = (page, name) => page.locator('#recurringBody .row[data-rbill]', { hasText: name });
const state = (page, name) => row(page, name).locator('[data-rb-state]');

test('the owner adds bimonthly electricity, enters a bill, part-pays, then pays the rest', async ({ page, problems }, testInfo) => {
    // Due on the 1st: from the 2nd of the month an unpaid bill is overdue
    const dayOne = new Date().getDate() === 1;
    await login(page, 'owner');
    await showTab(page, 'recurring');
    await expect(page.locator('#recurringBody .rb-metrics')).toBeVisible();
    const name = `E2E Electricity ${testInfo.project.name} ${Date.now()}`;

    await page.click('#recurringBody [data-onclick="recurring.showForm(\'add\')"]');
    await page.fill('#rbName', name);
    await page.selectOption('#rbCadence', '2');
    await page.fill('#rbDueDay', '1');
    await clickAfterTyping(page, '#rbSave');
    await expect(page.locator('#toast')).toHaveText(`${name} added`, { timeout: 30000 });
    await expect(row(page, name)).toContainText('Every 2 months');
    await expect(state(page, name)).toHaveText('Amount not entered yet');

    await page.click('#rbDetail [data-onclick="recurring.showForm(\'bill\')"]');
    await page.fill('#rbAmount', '1240');
    await clickAfterTyping(page, '#rbSave');
    await expect(state(page, name)).toHaveText(dayOne ? '₹1,240 due' : 'Overdue, ₹1,240', { timeout: 30000 });

    await page.click('#rbDetail [data-onclick="recurring.showForm(\'pay\')"]');
    await expect(page.locator('#rbAmount')).toHaveValue('1240');
    await page.fill('#rbAmount', '500');
    await clickAfterTyping(page, '#rbSave');
    await expect(page.locator('#toast')).toHaveText(`₹500 paid for ${name}`, { timeout: 30000 });
    await expect(state(page, name)).toHaveText(dayOne ? 'Part-paid, ₹500 of ₹1,240' : 'Overdue, ₹740');
    await expect(row(page, name)).toContainText('₹740 still to pay');

    // RB-11: Today shows the bills due, and its button opens the page
    await showTab(page, 'day');
    const bills = page.locator('#todayReminders [data-reminder="bills"]');
    await expect(bills).toContainText(/Bills due: \d+, ₹[\d,]+/);
    await bills.locator('button').click();
    await expect(page.locator('#recurring.tab.active')).toBeVisible();
    await expect(state(page, name)).toBeVisible({ timeout: 15000 });

    await page.click('#rbDetail [data-onclick="recurring.showForm(\'pay\')"]');
    await expect(page.locator('#rbAmount')).toHaveValue('740');
    await page.selectOption('#rbMode', 'online');
    await clickAfterTyping(page, '#rbSave');
    await expect(state(page, name)).toHaveText('Paid', { timeout: 30000 });
    await expect(row(page, name)).toContainText('Nothing to pay');

    const doc = (await listDocs('dev_recurringBills')).find(b => b.name === name);
    expect(doc).toMatchObject({ cadence: 2, dueDay: 1, expected: 0, active: true });
    expect(doc.entries.map(e => [e.kind, e.amount, e.mode || ''])).toEqual([['bill', 1240, ''], ['pay', 500, 'cash'], ['pay', 740, 'online']]);

    await page.evaluate(() => window.app.i18n.setLang('hi'));
    await expect(page.locator('#recurring h2')).toHaveText('नियमित बिल');
    await expect(state(page, name)).toHaveText('चुकाया');
    await expect(row(page, name)).toContainText('हर 2 महीने');
    await page.evaluate(() => window.app.i18n.setLang('en'));
    expect(problems.pageErrors).toEqual([]);
    expect(problems.consoleErrors).toEqual([]);
});

for (const [role, label] of [['manager', 'manager'], ['staff', 'member']]) {
    test(`a ${label} has no Recurring bills link and cannot open the page`, async ({ page, problems }) => {
        await login(page, role);
        await expect(page.locator('#recurringNavLink')).toBeHidden();
        await page.evaluate(() => window.app.nav.showTab('recurring'));
        await expect(page.locator('#recurring.tab.active')).toHaveCount(0);
        expect(problems.pageErrors).toEqual([]);
    });
}
