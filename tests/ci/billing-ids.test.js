/**
 * @jest-environment node
 */
/**
 * Billing's E2E hooks (redesign phase 3): the Billing screen is being rebuilt, and the E2E specs drive
 * it by id. Every id they use in www/templates/billing.html must stay there, once. A new E2E id on
 * Billing goes into the list below.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BILLING = fs.readFileSync(path.join(ROOT, 'www', 'templates', 'billing.html'), 'utf8');

const BILLING_E2E_IDS = [
    'amountPayable', 'autoSaveBanner', 'billComments', 'billDate', 'billItem', 'billRate', 'billTable',
    'billTotal', 'billing', 'cashCheckbox', 'cashPayment', 'customerName', 'newWeight', 'printBillBtn',
    'printSaleBtn', 'purchaseModeBtn', 'purchaseSection', 'saleCashCheckbox', 'saleCashPayment',
    'saleCustomerName', 'saleDate', 'saleDueAmount', 'saleDueCheckbox', 'saleItem', 'saleModeBtn', 'saleRate',
    'saleSection', 'saleTotal', 'saleWeight', 'saveBillBtn', 'saveSaleBtn',
    'voiceMicPurchase', 'voiceMicSale',
];

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else if (p.endsWith('.js')) out.push(p);
    }
    return out;
}

/** Ids the E2E code names: '#id' inside a string, or getElementById('id'). */
function e2eIds() {
    const ids = new Set();
    for (const f of [...walk(path.join(ROOT, 'tests', 'e2e')), ...walk(path.join(ROOT, 'tests', 'migration-e2e'))]) {
        const src = fs.readFileSync(f, 'utf8');
        for (const m of src.matchAll(/['"`][^'"`\n]*?#([A-Za-z][\w-]*)/g)) ids.add(m[1]);
        for (const m of src.matchAll(/getElementById\(\s*['"]([\w-]+)['"]\)/g)) ids.add(m[1]);
    }
    return ids;
}

const count = (id) => BILLING.split(`id="${id}"`).length - 1;

test.each(BILLING_E2E_IDS)('billing.html keeps #%s, once', (id) => {
    expect(count(id)).toBe(1);
});

test('the list has every id the E2E specs use on Billing', () => {
    const missing = [...e2eIds()].filter((id) => count(id) > 0 && !BILLING_E2E_IDS.includes(id));
    expect(missing).toEqual([]);
});

test('every <div> is closed, and Sale is not nested in Purchase', () => {
    const depthAt = (marker) => {
        const head = BILLING.slice(0, BILLING.indexOf(marker));
        return (head.match(/<div\b/g) || []).length - (head.match(/<\/div>/g) || []).length;
    };
    expect(depthAt('<!-- SALE SECTION -->')).toBe(depthAt('<!-- PURCHASE SECTION -->'));
    expect(depthAt('<!-- END SALE SECTION -->')).toBe(depthAt('<!-- PURCHASE SECTION -->'));
    expect((BILLING.match(/<div\b/g) || []).length).toBe((BILLING.match(/<\/div>/g) || []).length);
});

test('the E2E code still uses every listed id', () => {
    const used = e2eIds();
    expect(BILLING_E2E_IDS.filter((id) => !used.has(id))).toEqual([]);
});
