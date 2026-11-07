/**
 * Rentals money flows (#157): a payment over the due carries an advance (RENT-16) and
 * its receipt (RENT-12) is cancelled with a reason; the deposit ledger (RENT-14/15);
 * a property expense (RENT-17) in the yearly report and its CSV (RENT-19).
 */
const { test, expect, login } = require('./support/app');
const { button, dialog, row, dialogButton, closeDialog, toastHas, showPage, rentRow, setUpTenant, pay } = require('./support/rentals');

test('a payment over the due carries an advance; its receipt is cancelled with a reason', async ({ page, problems }) => {
    await login(page, 'owner');
    const { tenant } = await setUpTenant(page, { units: [['A', 5000]] });
    await expect(await rentRow(page, tenant)).toContainText('5,000');

    const no = await pay(page, tenant, 7000, { confirm: 'Advance for next month: ₹2,000' });
    await toastHas(page, '₹2,000 carried to next month as an advance');
    const box = dialog(page);
    await expect(box).toContainText('Advance for next month');
    await expect(box).toContainText('₹2,000');
    await closeDialog(page);
    await expect(await rentRow(page, tenant)).toContainText('Paid');

    await showPage(page, 'tenants');
    await button(row(page, tenant), 'Receipts').click();
    await expect(box).toContainText(`Receipts: ${tenant}`);
    await expect(box).toContainText(no);
    await button(box, 'View').click();
    await button(box, 'Cancel receipt').click();
    await expect(box).toContainText(`Cancel receipt ${no}?`);
    const save = page.locator('#rentDialog [data-onclick="rentals.dialogClose(true)"]');
    await expect(save, 'no cancel without a reason').toBeDisabled();
    await page.fill('#rentVoidReason', 'Wrong month');
    await save.click();
    await toastHas(page, `Receipt ${no} cancelled`);

    await button(row(page, tenant), 'Receipts').click();
    await expect(box).toContainText('CANCELLED');
    await closeDialog(page);
    expect(problems.pageErrors).toEqual([]);
    expect(problems.consoleErrors).toEqual([]);
});

test('the deposit ledger: received, refunded, and the deposits-held list', async ({ page, problems }) => {
    await login(page, 'owner');
    const { tenant } = await setUpTenant(page, { units: [['A', 4000]], deposit: 10000 });
    const box = dialog(page);

    await button(row(page, tenant), 'Deposit').click();
    await expect(box).toContainText(`Security deposit: ${tenant}`);
    await expect(box).toContainText(/Agreed deposit\s*₹10,000/);
    await expect(box).toContainText(/Deposit held\s*₹0/);
    await button(box, 'Deposit received').click();
    await expect(page.locator('#rentPayAmount'), 'filled with the agreed deposit').toHaveValue('10000');
    await dialogButton(page, true);
    await toastHas(page, 'Saved ₹10,000. Deposit held: ₹10,000');
    await expect(box).toContainText(/Deposit held\s*₹10,000/);

    await button(box, 'Refund deposit').click();
    await page.fill('#rentPayAmount', '3000');
    await dialogButton(page, true);
    await toastHas(page, 'Saved ₹3,000. Deposit held: ₹7,000');
    await expect(box).toContainText(/Deposit held\s*₹7,000/);
    await expect(box).toContainText('Refunded');
    await closeDialog(page);

    await button(page.locator('#rentalsBody'), 'Deposits held').click();
    await expect(box.getByRole('listitem').filter({ hasText: tenant })).toContainText('₹7,000');
    await closeDialog(page);
    expect(problems.pageErrors).toEqual([]);
    expect(problems.consoleErrors).toEqual([]);
});

test('a property expense shows in the month, the yearly report and its CSV', async ({ page, problems }) => {
    await login(page, 'owner');
    const { tenant, prop } = await setUpTenant(page, { units: [['A', 4000]] });
    const box = dialog(page);
    await pay(page, tenant, 4000);
    await closeDialog(page);

    await showPage(page, 'properties');
    await button(row(page, prop), 'Expenses').click();
    await expect(box).toContainText(`Expenses: ${prop}`);
    await expect(box).toContainText('No expenses recorded yet.');
    await button(box, 'Add expense').click();
    await page.selectOption('#rentExpCat', 'tax');
    await page.fill('#rentExpAmount', '1500');
    await dialogButton(page, true);
    await toastHas(page, 'Expense of ₹1,500 saved');
    await expect(box).toContainText('Property tax');
    await expect(box).toContainText(/Expenses this month.*₹1,500/s);
    await closeDialog(page);

    await button(page.locator('#rentalsBody'), 'Yearly report').click();
    const report = page.locator('#rentReport');
    await expect(report).toContainText('Yearly report');
    await expect(report.getByRole('heading', { name: prop })).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), button(report, 'Download CSV').click()]);
    const csv = await streamText(await download.createReadStream());
    // Property, Month, Rent, Collected, Due, Expenses, of which property tax, Net
    expect(csv).toContain(`${prop},Year total,4000,4000,0,1500,1500,2500`);

    await button(report, 'Show calendar year').click();
    await expect(report).toContainText(`Yearly report · ${new Date().getFullYear()}`);
    await expect(report.getByRole('heading', { name: prop })).toBeVisible();
    await closeDialog(page);
    expect(problems.pageErrors).toEqual([]);
    expect(problems.consoleErrors).toEqual([]);
});

function streamText(stream) {
    return new Promise((resolve, reject) => {
        let text = '';
        stream.on('data', (b) => { text += b; });
        stream.on('end', () => resolve(text));
        stream.on('error', reject);
    });
}
