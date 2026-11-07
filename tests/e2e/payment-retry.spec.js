/**
 * Due payments under a bad network and a race (D-1, D-2; #70). A payment whose commit reaches the
 * server but whose answer never comes back is recorded once, with its audit entry (D-3), and
 * typing it again cannot record it twice. Two people paying the same bill at once: the second is
 * told in plain words, with the due read again, never the rules' raw text.
 */
const { devices } = require('@playwright/test');
const { test, expect, login, showTab, expectToast, confirmModalIfOpen, clickAfterTyping } = require('./support/app');
const { listDocs, getDoc } = require('./support/emulator');

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

const paymentAudits = async (billNumber) => (await listDocs('dev_auditLogs'))
    .filter(a => a.action === 'UPDATE_PAYMENT' && a.details?.billNumber === billNumber);

/** Firestore RPCs and streams of the page (reads, writes, listeners). */
const FIRESTORE = /documents:(batchGet|runQuery|commit)|Firestore\/(Listen|Write)\/channel/;

test('D-1: a committed payment whose answer is lost is reported as recorded, with its audit entry', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'network scenario, once');
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message || e)));
    // A member's payment: the rules accept the bill change and its audit entry in one commit
    await login(page, 'staff');
    const sale = await creditSale(page, `E2E lost answer ${Date.now()}`);
    await openDueRow(page, sale.id);

    // The commit reaches the emulator (committed) but its answer never comes back (round 1, S4)
    await page.route(/documents:commit/, async (route) => {
        await route.fetch().catch(() => {});
        await route.abort('connectionreset');
    });
    await record(page, sale.id, 100);
    await expect(page.locator('#toast')).toHaveText(/Payment of ₹100 recorded/, { timeout: 60000 });
    await page.unroute(/documents:commit/);
    const doc = await getDoc('dev_retailSales', sale._id);
    expect(doc.payments).toHaveLength(1);
    expect(doc.payment).toMatchObject({ cash: 100, due: 260 });
    const audits = await paymentAudits(sale.billNumber);
    expect(audits).toHaveLength(1);
    expect(audits[0]._id).toBe(`pay_${doc.payments[0].id}`);
    expect(audits[0].details).toMatchObject({ paymentAmount: 100, cash: 100 });
    expect(errors).toEqual([]);
});

test('D-1: the network dies right after the commit lands: "could not confirm", and typing it again records nothing', async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'network scenario, once');
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message || e)));
    await login(page, 'manager');
    const sale = await creditSale(page, `E2E cut ${Date.now()}`);
    await openDueRow(page, sale.id);

    // The phone loses the network as it sends the payment; the commit still reaches the server (sent
    // from outside the page), so this phone hears nothing: no answer, no snapshot, no server check
    let cut = false;
    await page.route(FIRESTORE, async (route) => {
        if (cut) return route.abort('internetdisconnected');
        if (!/documents:commit/.test(route.request().url())) return route.continue();
        cut = true;
        await context.setOffline(true);
        await route.fetch().catch(() => {});
        return route.abort('internetdisconnected');
    });
    await record(page, sale.id, 100);
    await expect(page.locator('#toast')).toHaveText(/Could not confirm the payment of ₹100/, { timeout: 90000 });
    expect((await getDoc('dev_retailSales', sale._id)).payments).toHaveLength(1);

    // The network is back; the user enters the same ₹100 again (on the same row, or the redrawn one)
    await page.unroute(FIRESTORE);
    await context.setOffline(false);
    await record(page, sale.id, 100);
    await expect(page.locator('#toast')).toHaveText(/This payment of ₹100 was already recorded|Payment of ₹100 recorded/, { timeout: 60000 });
    const doc = await getDoc('dev_retailSales', sale._id);
    expect(doc.payments).toHaveLength(1);
    expect(doc.payment).toMatchObject({ cash: 100, due: 260 });
    expect(doc.dueAmount).toBe(260);
    expect(await paymentAudits(sale.billNumber)).toHaveLength(1);
    expect(errors).toEqual([]);
});

test('D-2: two people record a payment on one bill at once: the second is told in plain words, with the due read again', async ({ page, browser, baseURL, problems }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'two phones, once');
    await login(page, 'manager');
    const sale = await creditSale(page, `E2E race ${Date.now()}`);
    const ctx = await browser.newContext({ ...devices['Pixel 5'], baseURL, serviceWorkers: 'block' });
    const staff = await ctx.newPage();
    const staffErrors = [];
    staff.on('pageerror', e => staffErrors.push(String(e.message || e)));
    try {
        await login(staff, 'staff');
        await Promise.all([openDueRow(page, sale.id), openDueRow(staff, sale.id)]);

        // The staff phone read the bill (due ₹360) and sent its commit; it reaches the server only
        // after the manager's payment is there
        await staff.route(/documents:commit/, async (route) => {
            for (let i = 0; i < 100; i++) {
                const d = await getDoc('dev_retailSales', sale._id);
                if ((d.payments || []).length) break;
                await new Promise(r => setTimeout(r, 200));
            }
            await route.continue();
        });
        await record(staff, sale.id, 200);
        await page.waitForTimeout(500);
        await record(page, sale.id, 200);
        await expectToast(page, /Payment of ₹200 recorded/);

        const toast = staff.locator('#toast');
        await expect(toast).toHaveText(/another payment on this bill was recorded at the same moment\. Due now ₹160|exceeds outstanding amount \(₹160\)/, { timeout: 45000 });
        await expect(toast).not.toHaveText(/evaluation error|L\d+:\d+|permission|Error:/i);
        const doc = await getDoc('dev_retailSales', sale._id);
        expect(doc.payments).toHaveLength(1);
        expect(doc.payment.due).toBe(160);
        // The staff phone shows the due as it is now
        await expect.poll(() => staff.evaluate((id) => document.getElementById(`payment_${id}`)?.closest('.history-item')?.innerText || '', sale.id))
            .toContain('160');
        expect(staffErrors).toEqual([]);
        expect(problems.pageErrors).toEqual([]);
    } finally {
        await ctx.close();
    }
});
