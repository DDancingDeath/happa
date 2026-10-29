/**
 * Phone- and desktop-size money flow (#127): make a credit retail bill →
 * see it in History → record part of the due on Outstanding → open and close
 * the cash drawer. Firestore documents are checked through the emulator.
 */
const { test, expect, login, showTab, expectToast, confirmModalIfOpen } = require('./support/app');
const { listDocs, getDoc, deleteAll } = require('./support/emulator');

test('bill → History → due payment → cash close', async ({ page, problems }, testInfo) => {
    await deleteAll('dev_cashManagement');
    const customer = `E2E ${testInfo.project.name} ${Date.now()}`;
    await login(page, 'owner');

    // ---- 1. retail sale on credit ----
    await showTab(page, 'billing');
    await page.click('#saleModeBtn');
    const riceValue = await page.evaluate(() => [...document.querySelectorAll('#saleItem option')].find(o => /Rice/.test(o.textContent))?.value);
    expect(riceValue, 'Rice is in the sale item list').toBeTruthy();
    await page.selectOption('#saleItem', riceValue);
    await page.fill('#saleRate', '36');
    await page.fill('#saleWeight', '10');
    await page.click('#saleSection .quick-add-btn-inline');
    await page.click('#saleSection .add-to-bill-btn');
    await expect(page.locator('#saleTotal')).toHaveText('360');
    await page.fill('#saleCustomerName', customer);
    await page.check('#saleDueCheckbox');
    await expect(page.locator('#saleDueAmount')).toHaveValue('360');
    await page.click('#saveSaleBtn');
    await page.waitForTimeout(300);
    await confirmModalIfOpen(page); // "Stock shortfall": nothing was purchased in this dataset
    await expectToast(page, /Sale completed successfully/);

    const sale = (await listDocs('dev_retailSales')).find(d => d.customerName === customer);
    expect(sale).toMatchObject({ total: 360, dueAmount: 360, payment: { cash: 0, online: 0, due: 360, total: 360 } });

    // ---- 2. it shows in History ----
    await showTab(page, 'history');
    await page.click('#history .filter-sale');
    await expect(page.locator('#historyList')).toContainText(customer);

    // ---- 3. record part of the due on Outstanding ----
    await showTab(page, 'due');
    await page.click('#due .filter-sale');
    const input = page.locator(`[id="payment_${sale.id}"]`);
    await expect(input).toBeVisible();
    await input.fill('160');
    await page.click(`[id="payment_${sale.id}"] ~ button[data-record-payment]`);
    await expectToast(page, /Payment of ₹160 recorded/);
    const paid = await getDoc('dev_retailSales', sale._id);
    expect(paid.payment).toMatchObject({ cash: 160, due: 200 });
    expect(paid.dueAmount).toBe(200);
    expect(paid.payments).toHaveLength(1);

    // ---- 4. open and close the cash drawer ----
    await showTab(page, 'cash-management');
    await page.fill('#cashSignInAmount', '1000');
    await page.click('button[onclick="window.app.cashManagement.signIn()"]');
    await expectToast(page, /Cash opened for today/);
    await expect(page.locator('#cashSignOutAmount')).toBeVisible();
    const expected = Number((await page.locator('#expectedCashAmount').textContent()).replace(/[^\d.-]/g, ''));
    expect(expected).toBeGreaterThanOrEqual(1000);
    await page.fill('#cashSignOutAmount', String(expected));
    await page.click('button[onclick="window.app.cashManagement.signOut()"]');
    await expectToast(page, /Cash closed/);
    const sessions = await listDocs('dev_cashManagement');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ openingBalance: 1000, signedOut: true, closingBalance: expected, expectedBalance: expected, difference: 0 });

    expect(problems.pageErrors).toEqual([]);
});
