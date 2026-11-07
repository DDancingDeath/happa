/**
 * Rentals E2E helpers (tests/e2e/rentals-*.spec.js). The selectors live here, so a
 * screen redesign changes this file only: ids, data-* attributes and button names
 * from the English i18n strings, plus `.rent-row` for a tenant's or property's row.
 */
const { expect, expectToast } = require('./app');

/** 'YYYY-MM-DD' of the 1st of the month `back` months before now (local time). */
function firstOfMonth(back = 0) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - back);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

const button = (scope, name) => scope.getByRole('button', { name });
const dialog = (page) => page.locator('#rentDialog');
const row = (page, text) => page.locator('#rentalsBody .rent-row', { hasText: text }).first();

/** Save (true) or Cancel / Close (false) on the open rentals dialog. */
async function dialogButton(page, ok) {
    await page.locator(`#rentDialog [data-onclick="rentals.dialogClose(${ok})"]`).click();
}

async function closeDialog(page) {
    await dialogButton(page, false);
    await expect(dialog(page)).toBeHidden();
}

/** Accepts the app's confirm modal; `text`: what it must say first. */
async function confirmModal(page, text) {
    await expect(page.locator('#modalOverlay')).toHaveClass(/active/);
    if (text) await expect(page.locator('#modalOverlay')).toContainText(text);
    await page.click('#modalConfirm');
}

/** Resolves when the toast contains `text`. */
const toastHas = (page, text) => expectToast(page, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

const showPage = (page, name) => page.evaluate((p) => window.app.rentals.page(p), name);

/** The tenant's row on the Rent page (unit-wise view). */
async function rentRow(page, tenant) {
    await showPage(page, 'rent');
    await page.evaluate(() => window.app.rentals.setView('units'));
    return row(page, tenant);
}

/**
 * Adds property `Prop <stamp>` with commercial units [label, rent] (shown as label + stamp)
 * and tenant `Ten <stamp>` moved into the first unit from `start` (default today).
 * @param {import('@playwright/test').Page} page
 * @param {{units?: Array<[string, number]>, deposit?: number, start?: string}} [opts]
 */
async function setUpTenant(page, { units = [['A', 5000]], deposit = 0, start = '' } = {}) {
    const stamp = String(Date.now()).slice(-6);
    const prop = `Prop ${stamp}`;
    const tenant = `Ten ${stamp}`;
    const unit = (label) => `${label}${stamp}`;
    await page.evaluate(() => window.app.rentals.open('properties'));
    await page.fill('#rentPropName', prop);
    await page.locator('#rentalsBody').getByRole('button', { name: 'Add', exact: true }).click();
    const card = row(page, prop);
    for (const [label, rent] of units) {
        await button(card, 'Add unit').click();
        await page.fill('#rentUnitLabel', unit(label));
        await page.selectOption('#rentUnitType', 'commercial');
        await page.fill('#rentUnitRent', String(rent));
        await dialogButton(page, true);
        await expect(card).toContainText(unit(label));
    }

    await showPage(page, 'tenants');
    await page.fill('#rentTenantName', tenant);
    await page.fill('#rentTenantPhone', '9876543210');
    await page.locator('#rentalsBody').getByRole('button', { name: 'Add', exact: true }).click();
    const tenantRow = row(page, tenant);
    await button(tenantRow, 'Move in').click();
    await page.selectOption('#rentLeaseUnit', { label: `Shop ${unit(units[0][0])}` });
    if (start) await page.fill('#rentTDate', start);
    if (deposit) await page.fill('#rentTDeposit', String(deposit));
    await page.selectOption('#rentTElec', 'included');
    await dialogButton(page, true);
    await expect(tenantRow).toContainText(unit(units[0][0]));
    return { stamp, prop, tenant, unit, row: tenantRow, card };
}

/** Records a payment of `amount` on the tenant's oldest open month (Rent page); returns the receipt number. */
async function pay(page, tenant, amount, { confirm = '' } = {}) {
    const r = await rentRow(page, tenant);
    await button(r, 'Record payment').click();
    await page.fill('#rentPayAmount', String(amount));
    await dialogButton(page, true);
    if (confirm) await confirmModal(page, confirm);
    const title = page.locator('#rentDialogBody h3');
    await expect(title).toHaveText(/Rent receipt R-\d{4}-\d{4}/, { timeout: 15000 });
    return (await title.innerText()).match(/R-\d{4}-\d{4}/)[0];
}

module.exports = { firstOfMonth, button, dialog, row, dialogButton, closeDialog, confirmModal, toastHas, showPage, rentRow, setUpTenant, pay };
