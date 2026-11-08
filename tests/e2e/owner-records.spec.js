/**
 * OD-13 / OD-14: the owner's own money changes keep their record, as the rules now require. A due
 * goes down by a recorded payment or an explicit "Write off as bad debt" (a write-off entry, M5),
 * each with its audit entry written in the same commit (D-3).
 */
const { test, expect, login, expectToast } = require('./support/app');
const { listDocs, getDoc } = require('./support/emulator');
const { creditSale, openDueRow, record } = require('./support/due');

test('the owner records a payment, then writes the rest off as bad debt; both are on the bill with their audit entries', async ({ page, problems }, testInfo) => {
    await login(page, 'owner');
    const sale = await creditSale(page, `E2E owner write-off ${testInfo.project.name} ${Date.now()}`);
    await openDueRow(page, sale.id);
    await record(page, sale.id, 100);
    await expect(page.locator('#toast')).toHaveText(/Payment of ₹100 recorded/, { timeout: 30000 });

    const button = page.locator(`#dueList [data-write-off][data-onclick*="${sale.id}"]`);
    await expect(button).toHaveText('Write off as bad debt');
    await button.click();
    await expect(page.locator('#modalTitle')).toHaveText(/Write off ₹260 as bad debt/);
    await expect(page.locator('#modalMessage')).toContainText('Money counts it as a bad debt');
    await page.fill('#writeOffReason', 'Customer left town');
    await page.click('#modalConfirm');
    await expectToast(page, /Due written off/, 30000);

    const doc = await getDoc('dev_retailSales', sale._id);
    expect(doc.payment).toMatchObject({ cash: 100, due: 0, writtenOff: 260 });
    expect(doc).toMatchObject({ cleared: true, openDue: false });
    expect(doc.payments.map(p => [p.kind || 'payment', p.amount])).toEqual([['payment', 100], ['writeOff', 260]]);
    expect(doc.payments[1].reason).toBe('Customer left town');
    const audits = (await listDocs('dev_auditLogs'))
        .filter(a => a.details?.billNumber === sale.billNumber && ['UPDATE_PAYMENT', 'CLEAR_DUE'].includes(a.action));
    expect(audits.map(a => [a._id, a.action]).sort()).toEqual([
        [`pay_${doc.payments[0].id}`, 'UPDATE_PAYMENT'], [`wo_${doc.payments[1].id}`, 'CLEAR_DUE']
    ].sort());
    expect(audits.find(a => a.action === 'CLEAR_DUE').details).toMatchObject({ method: 'writeOff', amount: 260, reason: 'Customer left town' });
    expect(problems.pageErrors).toEqual([]);
});
