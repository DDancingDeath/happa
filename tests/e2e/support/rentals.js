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

/** The tenant's own screen (Tenants › tap the tenant); its buttons are on `#rentalsBody`. */
async function openTenant(page, tenant) {
    await showPage(page, 'tenants');
    await page.locator('#rentalsBody .rent-tenant-row', { hasText: tenant }).first().click();
    await expect(page.locator('#rentDetailTitle')).toHaveText(tenant);
    return page.locator('#rentalsBody');
}

/** Properties › + Add property: saves property `name`. */
async function addProperty(page, name) {
    await showPage(page, 'properties');
    await button(page.locator('#rentalsBody'), '+ Add property').click();
    await page.fill('#rentPropName', name);
    await dialogButton(page, true);
    await expect(page.locator('#rentalsBody [data-property]', { hasText: name })).toBeVisible();
}

/** The property's own screen (Properties › tap the property): its units, + Add unit, Let out; `#rentalsBody`. */
async function openProperty(page, prop) {
    await showPage(page, 'properties');
    await page.locator('#rentalsBody [data-property]', { hasText: prop }).first().click();
    await expect(page.locator('#rentDetailTitle')).toHaveText(prop);
    return page.locator('#rentalsBody');
}

/** An action under the tenant screen's ⋯ menu (Edit, Agreement, Tenant link, Change unit, Remove). */
async function tenantMenu(page, name) {
    const menu = page.locator('#rentalsBody .rent-menu');
    if (!(await menu.evaluate(e => e.open))) await menu.locator('summary').click();
    await button(page.locator('#rentalsBody .rent-menu-list'), name).click();
}

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
    await addProperty(page, prop);
    const card = await openProperty(page, prop);
    for (const [label, rent] of units) {
        await button(card, '+ Add unit').click();
        await page.fill('#rentUnitLabel', unit(label));
        await page.selectOption('#rentUnitType', 'commercial');
        await page.fill('#rentUnitRent', String(rent));
        await dialogButton(page, true);
        await expect(card).toContainText(unit(label));
    }

    await showPage(page, 'tenants');
    await button(page.locator('#rentalsBody'), '+ Add tenant').click();
    await page.fill('#rentTenantName', tenant);
    await page.fill('#rentTenantPhone', '9876543210');
    await dialogButton(page, true);
    const tenantRow = await openTenant(page, tenant);
    await button(tenantRow, 'Let out a unit').click();
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
    const title = dialog(page).getByRole('heading', { name: /Rent receipt R-/ });
    await expect(title).toHaveText(/Rent receipt R-\d{4}-\d{4}/, { timeout: 15000 });
    return (await title.innerText()).match(/R-\d{4}-\d{4}/)[0];
}

module.exports = { firstOfMonth, button, dialog, row, dialogButton, closeDialog, confirmModal, toastHas, showPage, openTenant, tenantMenu, rentRow, setUpTenant, pay, addProperty, openProperty };
