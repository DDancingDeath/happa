/**
 * Change of unit (RENT-13) with a tenant link (RENT-8): the tenant moves to another
 * unit, the old unit's unpaid month stays due, and the same link shows the new unit
 * with the old months.
 */
const { test, expect, login } = require('./support/app');
const { button, dialog, row, dialogButton, closeDialog, confirmModal, showPage, rentRow, setUpTenant, pay, firstOfMonth } = require('./support/rentals');

test('change of unit keeps the old dues and the tenant link follows the tenant', async ({ page, problems }) => {
    await login(page, 'owner');
    const { tenant, unit } = await setUpTenant(page, { units: [['A', 5000], ['B', 6000]], start: firstOfMonth(1) });
    // Last month and this month at A.
    await expect(await rentRow(page, tenant)).toContainText('10,000');
    await pay(page, tenant, 5000);
    await closeDialog(page);

    await showPage(page, 'tenants');
    await button(row(page, tenant), 'Make tenant link').click();
    await button(dialog(page), 'Make tenant link').click();
    const url = await page.locator('#rentLinkUrl').inputValue({ timeout: 15000 });
    await closeDialog(page);

    await button(row(page, tenant), 'Edit').click();
    await page.selectOption('#rentEditUnit', { label: `Shop ${unit('B')}` });
    await dialogButton(page, true);
    await expect(dialog(page)).toContainText('Change unit');
    await expect(page.locator('#rentTRent')).toHaveValue('6000');
    await page.uncheck('#rentSplitOn');
    await dialogButton(page, true);
    await confirmModal(page, 'Both units are charged the full rent');
    await expect(row(page, tenant)).toContainText(unit('B'));

    // A's unpaid month (5,000) is still due and B charges 6,000.
    await showPage(page, 'rent');
    await page.evaluate(() => window.app.rentals.setView('units'));
    await expect(row(page, unit('B'))).toContainText('6,000');
    await expect(row(page, unit('A'))).toContainText('5,000');

    const tenantCtx = await page.context().browser().newContext();
    const tenantPage = await tenantCtx.newPage();
    await tenantPage.goto(url);
    const rh = tenantPage.locator('#rh');
    await expect(rh).toContainText(`Rent history: ${tenant}`);
    await expect(rh).toContainText(unit('B'));
    await expect(rh).toContainText(unit('A'));
    await expect(rh).toContainText('6,000');
    await tenantCtx.close();
    expect(problems.pageErrors).toEqual([]);
    // The new lease's first month is charged twice at once; the slower write is refused (403) and the month exists once.
    expect(problems.consoleErrors.filter(e => !/status of 403/.test(e))).toEqual([]);
});
