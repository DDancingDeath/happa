/** Due-screen steps shared by the payment specs: a credit sale, its Due row, a payment typed and recorded. */
const { expect, showTab, expectToast, confirmModalIfOpen, clickAfterTyping } = require('./app');
const { listDocs } = require('./emulator');

async function creditSale(page, customer) {
    await showTab(page, 'billing');
    await page.click('#saleModeBtn');
    const rice = await page.evaluate(() => [...document.querySelectorAll('#saleItem option')].find(o => /Rice/.test(o.textContent))?.value);
    await page.selectOption('#saleItem', rice);
    await page.fill('#saleRate', '36');
    await page.fill('#saleWeight', '10');
    await page.click('#saleSection .quick-add-btn-inline');
    await page.click('#saleSection .add-to-bill-btn');
    await expect(page.locator('#saleTotal')).toHaveText('360');
    await page.fill('#saleCustomerName', customer);
    await page.check('#saleDueCheckbox');
    await clickAfterTyping(page, '#saveSaleBtn');
    await page.waitForTimeout(300);
    await confirmModalIfOpen(page);
    await expectToast(page, /Sale completed successfully/);
    return (await listDocs('dev_retailSales')).find(d => d.customerName === customer);
}

async function openDueRow(page, id) {
    await showTab(page, 'due');
    await page.click('#due .filter-sale');
    await page.waitForFunction((billId) => !!document.getElementById(`payment_${billId}`), id, { timeout: 30000 });
}

/** Types the amount and presses Record in one go (rows redraw whenever the bill lists change). */
async function record(page, id, amount) {
    await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
    await page.waitForFunction((billId) => !!document.getElementById(`payment_${billId}`), id, { timeout: 30000 });
    await page.evaluate(({ billId, value }) => {
        const el = document.getElementById(`payment_${billId}`);
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.parentElement.querySelector('button[data-record-payment]').click();
    }, { billId: id, value: amount });
}

module.exports = { creditSale, openDueRow, record };
