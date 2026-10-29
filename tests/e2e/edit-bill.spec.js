/** Edit an existing purchase from History (#127; ported from the e2e-edit session suite). */
const { test, expect, login, showTab, expectToast, confirmModalIfOpen } = require('./support/app');
const { getDoc } = require('./support/emulator');

test('edit a purchase from History keeps its money fields', async ({ page, problems }, testInfo) => {
    const id = `edit_${testInfo.project.name}`;
    const billNumber = `PEDIT-${testInfo.project.name.toUpperCase()}`;
    const newName = `After Edit ${testInfo.project.name}`;
    await login(page, 'owner');

    await showTab(page, 'history');
    await page.click('#history .filter-purchase');
    await page.fill('#historySearch', billNumber);
    await page.dispatchEvent('#historySearch', 'input');
    const header = page.locator('#historyList .bill-row__link').first();
    await expect(header).toBeVisible();
    await header.click();
    await page.click('#billEditBtn');
    await expect(page.locator('#customerName')).toHaveValue('Before Edit');

    await page.fill('#customerName', newName);
    await page.click('#saveBillBtn');
    await page.waitForTimeout(300);
    await confirmModalIfOpen(page);
    await expectToast(page, /updated successfully/i, 25000);

    const doc = await getDoc('dev_purchases', id);
    expect(doc.customerName).toBe(newName);
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0]).toMatchObject({ itemId: 'itm_wheat', qty: 50, total: 1100 });
    expect(doc.payment).toMatchObject({ cash: 600, due: 500 });
    expect(doc.dueAmount).toBe(500);
    expect(problems.pageErrors).toEqual([]);
});
