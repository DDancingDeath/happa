/**
 * Billing confirms, on a phone and a desktop (owner decisions OD-02 and the bag weight rule,
 * 8 Nov 2026; docs/calculations.md BF-RATECHECK, BF-BAGCHECK):
 * - a member types ₹260 for Wheat (today's sale rate ₹26): "Fix rate" adds nothing, a normal
 *   rate asks nothing, and a confirmed ₹260 is saved with who confirmed it, with no second
 *   "Save anyway?" for the same rate;
 * - a purchase bag of 485 kg: "Fix weight" keeps it in the box, 48.5 kg asks nothing, a
 *   confirmed 485 kg bag is saved with who confirmed it;
 * - the owner sees both confirms on Today's Day report.
 * Screenshots of each dialog (English and Hindi) go to the test's output folder.
 */
const { devices } = require('@playwright/test');
const { test, expect, login, showTab, expectToast, confirmModalIfOpen, clickAfterTyping } = require('./support/app');
const { listDocs, deleteAll } = require('./support/emulator');

const wheat = (page, select) => page.$eval(select, (el) => [...el.options].find(o => /Wheat|गेहूं/.test(o.textContent))?.value);
const shot = (page, testInfo, name) => page.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-${name}.png`) });
test.beforeEach(() => deleteAll('dev_autoSaves'));
test.afterEach(() => deleteAll('dev_autoSaves'));

/** Retail: Wheat 15 kg at `rate`, then Add to bill. */
async function retailLine(page, rate) {
    await page.selectOption('#saleItem', await wheat(page, '#saleItem'));
    await page.fill('#saleRate', String(rate));
    await page.fill('#saleWeight', '15');
    await page.click('#saleSection .add-to-bill-btn');
}

test('extreme rate and heavy bag: Fix first, confirmed cases saved with who, the owner sees them (OD-02)', async ({ page, browser, baseURL, problems }, testInfo) => {
    const customer = `Rate check ${testInfo.project.name} ${Date.now()}`;
    const supplier = `Bag check ${testInfo.project.name} ${Date.now()}`;
    await login(page, 'staff');
    await showTab(page, 'billing');
    await page.click('#saleModeBtn');

    // ---- ₹260 typed for ₹26: "Fix rate" is the default and adds nothing ----
    await retailLine(page, 260);
    const rate = page.locator('.rate-check-dialog');
    await expect(rate.locator('#rateCheckMessage')).toHaveText('Wheat 15 kg × ₹260.00 = ₹3,900. Today\'s rate ₹26.00 would give ₹390.');
    await expect(rate.locator('[data-choice="fix"]')).toBeFocused();
    await expect(rate.locator('[data-choice="confirm"]')).toHaveText('Yes, ₹260.00 is right');
    await shot(page, testInfo, 'rate-check-en');
    await page.keyboard.press('Enter'); // the focused default: Fix rate
    await expect(rate).toHaveCount(0);
    await expect(page.locator('#saleRate')).toBeFocused();
    await expect(page.locator('#saleTotal')).toHaveText('0');

    // ---- a normal rate asks nothing ----
    await page.fill('#saleRate', '26');
    await page.click('#saleSection .add-to-bill-btn');
    await expect(page.locator('#saleTotal')).toHaveText('390');
    await expect(rate).toHaveCount(0);

    // ---- "Yes, ₹260 is right": added, and saved with who confirmed it ----
    await retailLine(page, 260);
    await rate.locator('[data-choice="confirm"]').click();
    await expect(page.locator('#saleTotal')).toHaveText('4290');
    await page.fill('#saleCustomerName', customer);
    await page.fill('#saleCashPayment', '4290');
    await clickAfterTyping(page, '#saveSaleBtn');
    await page.waitForTimeout(300);
    // A stock warning may ask; the confirmed rate is never asked a second time
    const asked = await page.evaluate(() => (document.getElementById('modalOverlay')?.classList.contains('active') ? document.getElementById('modalMessage')?.textContent : ''));
    expect(asked).not.toMatch(/₹260/);
    await confirmModalIfOpen(page);
    await expectToast(page, /Sale completed successfully/);
    const sale = (await listDocs('dev_retailSales')).find(d => d.customerName === customer);
    expect(sale.total).toBe(4290);
    expect(sale.items[0]).not.toHaveProperty('rateCheck');
    expect(sale.items[1]).toMatchObject({ rate: 260, qty: 15, total: 3900, rateCheck: { rate: 260, todayRate: 26, byName: 'Staff One' } });
    expect((sale.flags || []).map(f => f.rule)).not.toContain('rate-high');

    // ---- purchase: a 485 kg bag asks; Fix weight keeps it; 48.5 asks nothing; 485 confirmed is saved ----
    await page.click('#purchaseModeBtn');
    await page.selectOption('#billItem', await wheat(page, '#billItem'));
    await page.fill('#billRate', '22');
    await page.fill('#newWeight', '485');
    await page.click('#purchaseSection .quick-add-btn-inline');
    const bag = page.locator('.bag-check-dialog');
    await expect(bag.locator('#bagCheckMessage')).toHaveText('Bag weight 485 kg — usually under 100 kg. Did you mean 48.5?');
    await expect(bag.locator('[data-choice="fix"]')).toBeFocused();
    await expect(bag.locator('[data-choice="confirm"]')).toHaveText('Yes, 485 kg');
    await shot(page, testInfo, 'bag-check-en');
    await bag.locator('[data-choice="fix"]').click();
    await expect(page.locator('#newWeight')).toHaveValue('485');
    await expect(page.locator('#newWeight')).toBeFocused();
    await page.fill('#newWeight', '48.5');
    await page.click('#purchaseSection .quick-add-btn-inline');
    await expect(bag).toHaveCount(0);
    await page.fill('#newWeight', '100');
    await page.click('#purchaseSection .quick-add-btn-inline');
    await expect(bag).toHaveCount(0); // exactly 100 kg is fine
    await page.fill('#newWeight', '485');
    await page.click('#purchaseSection .quick-add-btn-inline');
    await bag.locator('[data-choice="confirm"]').click();
    await page.click('#purchaseSection .add-to-bill-btn');
    await expect(bag).toHaveCount(0); // asked once
    await expect(page.locator('#billTotal')).toHaveText('13937');
    await page.fill('#customerName', supplier);
    await page.check('#cashCheckbox');
    await clickAfterTyping(page, '#saveBillBtn');
    await page.waitForTimeout(300);
    await confirmModalIfOpen(page);
    await expectToast(page, /Bill saved successfully/);
    const bill = (await listDocs('dev_purchases')).find(d => d.customerName === supplier);
    expect(bill.items[0]).toMatchObject({ weights: [48.5, 100, 485], qty: 633.5, total: 13937 });
    expect(bill.items[0].weightCheck).toEqual([expect.objectContaining({ kg: 485, byName: 'Staff One' })]);

    // ---- the owner sees both confirms on Today's Day report ----
    const ctx = await browser.newContext({ ...(testInfo.project.name === 'phone' ? devices['Pixel 5'] : {}), baseURL, serviceWorkers: 'block' });
    const owner = await ctx.newPage();
    try {
        await login(owner, 'owner');
        await showTab(owner, 'day');
        const card = owner.locator('#dayReportCard');
        await expect(card.locator('.anomaly-row', { hasText: 'Wheat: 15 kg × ₹260.00 = ₹3,900; today\'s rate ₹26.00 would give ₹390' }).first()).toContainText('Extreme rate confirmed', { timeout: 30000 });
        await expect(card.locator('.anomaly-row', { hasText: 'Wheat: bag of 485 kg (usually under 100 kg)' }).first()).toContainText('Staff One');
        // The card redraws when its stored records arrive: scroll in the page, not on a held element
        await owner.evaluate(() => [...document.querySelectorAll('#dayReportCard .anomaly-row')]
            .find(r => r.textContent.includes('Extreme rate confirmed'))?.scrollIntoView({ block: 'center' }));
        await shot(owner, testInfo, 'owner-day-report-en');
    } finally {
        await ctx.close();
    }
    expect(problems.pageErrors).toEqual([]);
});

test('Hindi: both confirms in one language, "kg" for the weight', async ({ page, problems }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'screens once, on a phone');
    await page.addInitScript(() => localStorage.setItem('aadhat.lang', 'hi'));
    await login(page, 'staff');
    await showTab(page, 'billing');
    await page.click('#saleModeBtn');
    await retailLine(page, 260);
    const rate = page.locator('.rate-check-dialog');
    await expect(rate.locator('#rateCheckMessage')).toHaveText(/^(Wheat|गेहूं) 15 kg × ₹260\.00 = ₹3,900। आज के रेट ₹26\.00 से ₹390 होता।$/);
    await expect(rate.locator('[data-choice="fix"]')).toHaveText('रेट ठीक करें');
    await shot(page, testInfo, 'rate-check-hi');
    await rate.locator('[data-choice="fix"]').click();

    await page.click('#purchaseModeBtn');
    await page.selectOption('#billItem', await wheat(page, '#billItem'));
    await page.fill('#billRate', '22');
    await page.fill('#newWeight', '485');
    await page.click('#purchaseSection .quick-add-btn-inline');
    const bag = page.locator('.bag-check-dialog');
    await expect(bag.locator('#bagCheckMessage')).toHaveText('बोरी का वज़न 485 kg — आमतौर पर 100 kg से कम होता है। क्या 48.5 लिखना था?');
    await expect(bag.locator('[data-choice="confirm"]')).toHaveText('हाँ, 485 kg');
    await shot(page, testInfo, 'bag-check-hi');
    await bag.locator('[data-choice="fix"]').click();
    expect(problems.pageErrors).toEqual([]);
});
