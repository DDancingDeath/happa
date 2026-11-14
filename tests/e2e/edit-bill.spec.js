/** Edit an existing purchase from History (#127; ported from the e2e-edit session suite), void it (#75, #121), then delete it (OD-14). */
const { test, expect, login, showTab, expectToast, confirmModalIfOpen } = require('./support/app');
const { getDoc, listDocs } = require('./support/emulator');
const { seed } = require('./support/seed');

// The test edits and then voids its bill: start from the seed so a retry finds it as it was.
test.beforeEach(async () => {
    await seed();
});

test('edit a purchase from History keeps its money fields and records why; then void it and delete it (OD-14)', async ({ page, problems }, testInfo) => {
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
    // #121: an edit asks why (a bill-check confirm may come first)
    const reason = page.locator('#reasonInput');
    for (let i = 0; i < 10 && !(await reason.isVisible()); i++) {
        await page.waitForTimeout(300);
        const other = await page.evaluate(() => document.getElementById('modalOverlay')?.classList.contains('active')
            && !document.getElementById('reasonInput'));
        if (other) await page.click('#modalConfirm');
    }
    await reason.fill('Name spelling');
    await page.click('#modalConfirm');
    await page.waitForTimeout(300);
    await confirmModalIfOpen(page);
    await expectToast(page, /updated successfully/i, 25000);

    const doc = await getDoc('dev_purchases', id);
    expect(doc.customerName).toBe(newName);
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0]).toMatchObject({ itemId: 'itm_wheat', qty: 50, total: 1100 });
    expect(doc.payment).toMatchObject({ cash: 600, due: 500 });
    expect(doc.dueAmount).toBe(500);
    // The before/after and the reason are kept next to the bill (#121)
    expect(doc.editCount).toBe(1);
    const edit = await getDoc(`dev_purchases/${id}/edits`, '1');
    expect(edit).toMatchObject({ n: 1, reason: 'Name spelling', fields: { customerName: { before: 'Before Edit', after: newName } } });

    // #75: void it from History with a reason; it leaves the list and comes back greyed behind the toggle
    await showTab(page, 'history');
    await page.fill('#historySearch', billNumber);
    await page.dispatchEvent('#historySearch', 'input');
    await expect(header).toBeVisible();
    await header.click();
    await expect(page.locator('.bill-edits__count')).toHaveText(/Edited 1×/);
    await page.click('#billVoidBtn');
    await expect(reason).toBeVisible();
    await reason.fill('Entered twice');
    await page.click('#modalConfirm');
    await expectToast(page, /Bill voided/i, 25000);
    expect(await getDoc('dev_purchases', id)).toMatchObject({ voided: true, voidReason: 'Entered twice', openDue: false, editCount: 1 });
    await expect(page.locator('#historyList [data-history-item]:not(.is-voided)')).toHaveCount(0);
    await page.click('#historyVoidedToggle');
    await expect(page.locator('#historyList [data-history-item].is-voided .voided-reason')).toHaveText('Entered twice');

    // OD-14: only now (voided) can the owner delete it for good, with its edit records
    await page.locator('#historyList [data-history-item].is-voided .bill-row__link').first().click();
    await page.click('#billDeleteBtn');
    await page.click('#modalConfirm');
    await expectToast(page, /deleted/i, 25000);
    expect(await getDoc('dev_purchases', id)).toBeNull();
    expect(await listDocs(`dev_purchases/${id}/edits`)).toEqual([]);
    // each step's audit entry landed with it (D-3)
    const audits = (await listDocs('dev_auditLogs')).filter(a => a.details?.billNumber === billNumber).map(a => a.action);
    expect(audits.sort()).toEqual(['DELETE_BILL', 'EDIT_BILL', 'VOID_BILL']);
    expect(problems.pageErrors).toEqual([]);
});
