/**
 * Change of unit (RENT-13) with a tenant link (RENT-8): the tenant moves to another
 * unit, the old unit's unpaid month stays due, and the same link shows the new unit
 * with the old months.
 */
const { test, expect, login } = require('./support/app');
const { button, dialog, row, dialogButton, closeDialog, confirmModal, toastHas, showPage, openTenant, tenantMenu, rentRow, setUpTenant, pay, firstOfMonth } = require('./support/rentals');

test('change of unit keeps the old dues and the tenant link follows the tenant', async ({ page, problems }) => {
    // On the 1st the old lease ends with last month (moveMonthSplit), so this month is not split between the units.
    test.skip(new Date().getDate() === 1, 'a change on the 1st ends the old lease with last month');
    await login(page, 'owner');
    const { tenant, unit } = await setUpTenant(page, { units: [['A', 5000], ['B', 6000]], start: firstOfMonth(1) });
    // Last month and this month at A.
    await expect(await rentRow(page, tenant)).toContainText('10,000');
    await pay(page, tenant, 5000);
    await closeDialog(page);

    const screen = await openTenant(page, tenant);
    await tenantMenu(page, 'Make tenant link');
    await button(dialog(page), 'Make tenant link').click();
    const url = await page.locator('#rentLinkUrl').inputValue({ timeout: 15000 });
    await closeDialog(page);

    // Change unit is its own action (no longer a field in Edit).
    await tenantMenu(page, 'Change unit');
    await expect(dialog(page)).toContainText('Change unit');
    await page.selectOption('#rentLeaseUnit', { label: `Shop ${unit('B')}` });
    await expect(page.locator('#rentTRent')).toHaveValue('6000');
    await page.uncheck('#rentSplitOn');
    await dialogButton(page, true);
    await confirmModal(page, 'Both units are charged the full rent');
    await toastHas(page, "First month's rent in the new unit: ₹6,000");
    await expect(screen).toContainText(unit('B'));

    const tenantCtx = await page.context().browser().newContext();
    const tenantPage = await tenantCtx.newPage();
    await tenantPage.goto(url);
    const rh = tenantPage.locator('#rh');
    await expect(rh).toContainText(`Rent history: ${tenant}`);
    await expect(rh).toContainText(unit('B'));
    await expect(rh).toContainText(unit('A'));
    // A: last month paid, this month's 5,000 still due; B: this month's 6,000.
    // B's first month reaches the link in its own write just after the change: reload until it shows.
    await expect(async () => {
        await tenantPage.reload();
        await expect(rh).toContainText(/Total due\s*₹11,000/, { timeout: 3000 });
    }).toPass({ timeout: 30000 });
    await expect(rh).toContainText(/Paid \(shown months\)\s*₹5,000/);
    await tenantCtx.close();
    expect(problems.pageErrors).toEqual([]);
    // Exactly one path charges the new lease's first month: no refused second write.
    expect(problems.consoleErrors).toEqual([]);
});
