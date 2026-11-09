/**
 * Name suggestions while billing (#139 phase 1, plan P3.B2): typing a customer or supplier
 * lists the names already on the loaded bills with what they owe (Latin and Devanagari
 * spellings), ↓ + Enter or a tap fills the name, and a new name close to a known one shows
 * "Did you mean …?" with Use and "Yes, it's right" (warn only). No Firestore read.
 */
const { test, expect, login, showTab } = require('./support/app');
const { commit, deleteDocs } = require('./support/emulator');

const DAY = 86400000;
const bill = (id, customerName, total, due, type) => {
    const t = Date.now() - 2 * DAY;
    return {
        id, billNumber: id.toUpperCase(), timestamp: t, date: new Date(t).toISOString(), customerName, type,
        isPurchase: type === 'purchase', items: [{ itemId: 'itm_wheat', name: 'Wheat', qty: 10, rate: total / 10, total, weights: [10] }],
        total, billTotal: total, grandTotal: total, amountPayable: total, totalPackets: 1,
        cashPayment: total - due, onlinePayment: 0, dueAmount: due, payment: { cash: total - due, online: 0, due, total },
        userId: 'e2e', userName: 'Owner', clientVersion: 3, ...(due > 0 ? { openDue: true } : {})
    };
};
const RETAIL = [bill('ns_sita', 'Sita Devi', 500, 200, 'retail'), bill('ns_ramesh', 'रमेश कुमार', 300, 0, 'retail')];
const PURCHASE = [bill('ns_gupta', 'Gupta Traders', 1000, 700, 'purchase')];

const readCount = (page) => page.evaluate(() => window.FirebaseService?.getReadStats?.().reads ?? null);
/** Waits until start-up's own reads (listeners, idle work) have been still for `quietMs`. */
async function startupDone(page, quietMs = 5000, timeoutMs = 40000) {
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-updating'), null, { timeout: timeoutMs });
    const t0 = Date.now();
    let last = await readCount(page);
    let since = Date.now();
    while (Date.now() - since < quietMs && Date.now() - t0 < timeoutMs) {
        await page.waitForTimeout(250);
        const now = await readCount(page);
        if (now !== last) {
            last = now;
            since = Date.now();
        }
    }
}
/** Records the Firestore reads and listeners started from now on (their collection paths). */
const watchReads = (page) => page.evaluate(() => {
    const fs = window.firebase.firestore;
    const pathOf = (ref) => {
        if (typeof ref?.path === 'string') return ref.path;
        const p = ref?._delegate?._query?.path;
        return p ? (p.canonicalString?.() ?? String(p)) : '?';
    };
    window.__readsStarted = [];
    [fs.Query?.prototype, fs.CollectionReference?.prototype, fs.DocumentReference?.prototype].forEach(proto => {
        ['get', 'onSnapshot'].forEach(name => {
            if (!proto || !Object.prototype.hasOwnProperty.call(proto, name)) return;
            const original = proto[name];
            proto[name] = function (...args) {
                window.__readsStarted.push(pathOf(this));
                return original.apply(this, args);
            };
        });
    });
});
const readsStarted = (page) => page.evaluate(() => window.__readsStarted);
test.afterAll(async () => {
    await deleteDocs('dev_retailSales', RETAIL.map(b => b.id));
    await deleteDocs('dev_purchases', PURCHASE.map(b => b.id));
});

test('customer names are suggested from the loaded bills, filled by keyboard or tap, and close names warn', async ({ page, problems }, testInfo) => {
    await commit([...RETAIL.map(b => ['dev_retailSales', b.id, b]), ...PURCHASE.map(b => ['dev_purchases', b.id, b])]);
    await login(page, 'owner');
    await showTab(page, 'billing');
    await page.click('#saleModeBtn');
    await startupDone(page);
    await watchReads(page);

    const name = page.locator('#saleCustomerName');
    const list = page.locator('#partySuggest-retail');
    const options = list.locator('[role="option"]');

    // Typing lists the names with their dues
    await name.click();
    await name.pressSequentially('sit');
    await expect(list).toBeVisible();
    await expect(name).toHaveAttribute('aria-expanded', 'true');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText('Sita Devi');
    await expect(options.first()).toContainText('owes ₹200');

    // ↓ + Enter fills it; the "Already owes" line follows the name
    await name.press('ArrowDown');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await name.press('Enter');
    await expect(name).toHaveValue('Sita Devi');
    await expect(list).toBeHidden();
    await expect(page.locator('#partyDue-retail')).toContainText('₹200');

    // Latin typed finds a Devanagari name; a tap fills it; Esc closes without filling
    await name.fill('ramesh');
    await expect(options.first()).toContainText('रमेश कुमार');
    await expect(options.first()).toContainText('no dues');
    await name.press('Escape');
    await expect(list).toBeHidden();
    await expect(name).toHaveValue('ramesh');
    await name.fill('rame');
    if (testInfo.project.name === 'phone') await options.first().tap();
    else await options.first().click();
    await expect(name).toHaveValue('रमेश कुमार');

    // A near-duplicate warns after leaving the field; "Yes, it's right" keeps the typed name
    const hint = page.locator('#partyHint-retail');
    await name.fill('Seeta Devi');
    await name.blur();
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('Did you mean Sita Devi (owes ₹200)?');
    await hint.getByRole('button', { name: "Yes, it's right" }).click();
    await expect(hint).toBeHidden();
    await expect(name).toHaveValue('Seeta Devi');

    // … and Use takes the known name
    await name.fill('Sita Devi Ji');
    await name.blur();
    await hint.getByRole('button', { name: 'Use' }).click();
    await expect(name).toHaveValue('Sita Devi');
    await expect(hint).toBeHidden();

    // Purchase: suppliers from the purchases, "we owe"
    await page.click('#purchaseModeBtn');
    const supplier = page.locator('#customerName');
    await supplier.click();
    await supplier.pressSequentially('gup');
    await expect(page.locator('#partySuggest-purchase [role="option"]').first()).toContainText('Gupta Traders');
    await expect(page.locator('#partySuggest-purchase [role="option"]').first()).toContainText('we owe ₹700');

    // All of it from the bills already on the phone: no bill or party read (start-up's own idle work may read other docs)
    const started = await readsStarted(page);
    expect(started.filter(p => /purchases|retailSales|wholesaleSales|part(y|ies)/i.test(p))).toEqual([]);
    expect(problems.pageErrors).toEqual([]);
    expect(problems.consoleErrors).toEqual([]);
});
