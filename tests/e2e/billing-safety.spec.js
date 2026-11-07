/**
 * Billing safety (staff review S-1, S-10, S-12; dev review D-5), on a phone and a desktop:
 * a line typed but not added to the bill is never dropped on Save (BF-PENDING); a mode
 * tapped right after Billing opens is kept; the bill-form WhatsApp share says it is an
 * unsaved draft and saves nothing; Print without a printer says "Not printed".
 * Screenshots of each screen go to the test's output folder.
 */
const { test, expect, login, showTab, expectToast, confirmModalIfOpen, clickAfterTyping } = require('./support/app');
const { listDocs, deleteAll } = require('./support/emulator');

const optionValue = (page, select, name) => page.$eval(select, (el, n) => [...el.options].find(o => o.textContent.includes(n))?.value, name);
// A form left unsaved here (or by an earlier spec) is offered back at the next sign-in: start and end clean
test.beforeEach(() => deleteAll('dev_autoSaves'));
test.afterEach(() => deleteAll('dev_autoSaves'));

const shot = (page, testInfo, name) => page.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-${name}.png`) });

/** Retail sale: Wheat 2 kg @ ₹26 added, Rice 4 kg @ ₹36 typed in the boxes but not added. */
async function retailWithTypedLine(page, customer) {
    await showTab(page, 'billing');
    await page.click('#saleModeBtn');
    await page.selectOption('#saleItem', await optionValue(page, '#saleItem', 'Wheat'));
    await page.fill('#saleRate', '26');
    await page.fill('#saleWeight', '2');
    await page.click('#saleSection .add-to-bill-btn');
    await expect(page.locator('#saleTotal')).toHaveText('52');
    await page.selectOption('#saleItem', await optionValue(page, '#saleItem', 'Rice'));
    await page.fill('#saleRate', '36');
    await page.fill('#saleWeight', '4');
    await page.fill('#saleCustomerName', customer);
    // Paid in cash for both lines (52 + 144)
    await page.fill('#saleCashPayment', '196');
}

test('Save with a typed retail line asks; "Add this line and save" bills it (S-1)', async ({ page, problems }, testInfo) => {
    const customer = `Safety add ${testInfo.project.name} ${Date.now()}`;
    await login(page, 'owner');
    await retailWithTypedLine(page, customer);
    await clickAfterTyping(page, '#saveSaleBtn');
    const dialog = page.locator('.pending-line-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#pendingLineMessage')).toHaveText('Rice 4 kg × ₹36.00 = ₹144 is typed but not on the bill.');
    await expect(dialog.locator('[data-choice="add"]')).toHaveText('Add this line and save');
    await expect(dialog.locator('[data-choice="discard"]')).toHaveText('Discard line and save');
    await shot(page, testInfo, 'S1-after-prompt');
    await dialog.locator('[data-choice="add"]').click();
    await page.waitForTimeout(300);
    await confirmModalIfOpen(page); // stock shortfall: no Rice was bought in this dataset
    await expectToast(page, /Sale completed successfully/);
    const sale = (await listDocs('dev_retailSales')).find(d => d.customerName === customer);
    expect(sale.items.map(i => [i.name, i.qty])).toEqual([['Wheat', 2], ['Rice', 4]]);
    expect(sale).toMatchObject({ total: 196, payment: { cash: 196, due: 0 } });
    await expect(page.locator('#saleWeight')).toHaveValue('');
    expect(problems.pageErrors).toEqual([]);
});

test('"Discard line and save" saves the added lines only; Cancel saves nothing (S-1)', async ({ page, problems }, testInfo) => {
    const customer = `Safety discard ${testInfo.project.name} ${Date.now()}`;
    await login(page, 'owner');
    await showTab(page, 'billing');
    await page.click('#purchaseModeBtn');
    await page.selectOption('#billItem', await optionValue(page, '#billItem', 'Rice'));
    await page.fill('#billRate', '30');
    await page.fill('#newWeight', '10');
    await page.click('#purchaseSection .add-to-bill-btn');
    await expect(page.locator('#billTotal')).toHaveText('300');
    await page.fill('#newWeight', '5'); // the item and rate stay after Add: a weight typed is a new line
    await page.fill('#customerName', customer);
    await page.fill('#cashPayment', '300');

    await clickAfterTyping(page, '#saveBillBtn');
    const dialog = page.locator('.pending-line-dialog');
    await expect(dialog.locator('#pendingLineMessage')).toHaveText('Rice 5 kg × ₹30.00 = ₹150 is typed but not on the bill.');
    await dialog.locator('[data-choice="cancel"]').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#newWeight')).toHaveValue('5');
    expect((await listDocs('dev_purchases')).find(d => d.customerName === customer)).toBeUndefined();

    await clickAfterTyping(page, '#saveBillBtn');
    await dialog.locator('[data-choice="discard"]').click();
    await page.waitForTimeout(300);
    await confirmModalIfOpen(page);
    await expectToast(page, /Bill saved successfully/);
    const bill = (await listDocs('dev_purchases')).find(d => d.customerName === customer);
    expect(bill.items.map(i => [i.name, i.qty])).toEqual([['Rice', 10]]);
    expect(bill.billTotal).toBe(300);
    expect(problems.pageErrors).toEqual([]);
});

test('a half-typed line is named and focused; the bill waits (S-1)', async ({ page, problems }, testInfo) => {
    await login(page, 'owner');
    await showTab(page, 'billing');
    await page.click('#saleModeBtn');
    const before = (await listDocs('dev_retailSales')).length;
    await page.selectOption('#saleItem', await optionValue(page, '#saleItem', 'Wheat'));
    await page.fill('#saleRate', '');
    await page.fill('#saleWeight', '2');
    await page.fill('#saleCashPayment', '52');
    await clickAfterTyping(page, '#saveSaleBtn');
    await expectToast(page, 'Wheat is not on the bill yet: type its rate and tap Add to Bill, or clear it.');
    await expect(page.locator('#saleRate')).toBeFocused();
    await expect(page.locator('.pending-line-dialog')).toHaveCount(0);
    await shot(page, testInfo, 'S1-half-typed');
    expect((await listDocs('dev_retailSales')).length).toBe(before);
    expect(problems.pageErrors).toEqual([]);
});

test('Retail sale tapped right after Billing opens stays chosen (D-5)', async ({ page, problems }, testInfo) => {
    await login(page, 'owner');
    await showTab(page, 'day');
    // The menu opens Billing and the user taps "Retail sale" at once (the old 100 ms timer flipped it back)
    await page.evaluate(() => {
        window.app.nav.showTab('billing');
        document.getElementById('saleModeBtn').click();
    });
    await page.waitForTimeout(600);
    await expect(page.locator('#saleSection')).toBeVisible();
    await expect(page.locator('#purchaseSection')).toBeHidden();
    await expect(page.locator('#saleModeBtn')).toHaveClass(/active/);
    await shot(page, testInfo, 'D5-mode-kept');
    // Opening Billing again still starts on Purchase (unchanged)
    await page.evaluate(() => window.app.nav.showTab('billing'));
    await expect(page.locator('#purchaseSection')).toBeVisible();
    expect(problems.pageErrors).toEqual([]);
});

test('WhatsApp on the bill form shares a draft marked "not saved" and saves nothing (S-10)', async ({ page, problems }, testInfo) => {
    const customer = `Safety share ${testInfo.project.name} ${Date.now()}`;
    await login(page, 'owner');
    await showTab(page, 'billing');
    await page.click('#saleModeBtn');
    await page.selectOption('#saleItem', await optionValue(page, '#saleItem', 'Wheat'));
    await page.fill('#saleRate', '26');
    await page.fill('#saleWeight', '2');
    await page.click('#saleSection .add-to-bill-btn');
    await page.fill('#saleCustomerName', customer);
    const share = page.locator('[data-onclick="billing.shareSaleWhatsApp()"]');
    await expect(share).toHaveText('Share draft (not saved)');
    await share.scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'S10-share-draft-button');
    await page.evaluate(() => { window.__opened = []; window.open = (url) => { window.__opened.push(url); return null; }; });
    await clickAfterTyping(page, '[data-onclick="billing.shareSaleWhatsApp()"]');
    const [url] = await page.evaluate(() => window.__opened);
    expect(decodeURIComponent(url)).toContain('*Sale Bill* (DRAFT, not saved)');
    expect((await listDocs('dev_retailSales')).find(d => d.customerName === customer)).toBeUndefined();
    expect(problems.pageErrors).toEqual([]);
});

test('Print with no printer: "saved" and "Not printed", never "saved and printed" (S-12)', async ({ page, problems }, testInfo) => {
    const customer = `Safety print ${testInfo.project.name} ${Date.now()}`;
    await login(page, 'owner');
    await showTab(page, 'billing');
    await page.click('#saleModeBtn');
    await page.selectOption('#saleItem', await optionValue(page, '#saleItem', 'Wheat'));
    await page.fill('#saleRate', '26');
    await page.fill('#saleWeight', '2');
    await page.click('#saleSection .add-to-bill-btn');
    await page.fill('#saleCustomerName', customer);
    await page.fill('#saleCashPayment', '52');
    await clickAfterTyping(page, '#printSaleBtn');
    await page.waitForTimeout(300);
    await confirmModalIfOpen(page);
    await expectToast(page, 'Sale completed successfully! · Not printed: no printer connected.');
    await shot(page, testInfo, 'S12-not-printed');
    await page.waitForTimeout(500);
    await expect(page.locator('#toast')).not.toHaveText(/saved and printed/);
    expect((await listDocs('dev_retailSales')).find(d => d.customerName === customer)).toMatchObject({ total: 52 });
    expect(problems.pageErrors).toEqual([]);
});
