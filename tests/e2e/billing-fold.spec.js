/**
 * Billing fits the screen (#104): on a laptop (1366×768, 1280×720) the bill total and
 * Save / Print are on screen without scrolling the page; on a small phone (360×640),
 * scrolled to the bottom, they show whole, not under the bottom bar. Both bill modes,
 * with a line on the bill so the totals column has its real height. The page scrolls
 * inside the open tab (`.tab.active`), not the window.
 */
const { test, expect, login, showTab } = require('./support/app');

const SIZES = [
    { name: 'laptop 1366×768', width: 1366, height: 768, fold: true },
    { name: 'laptop 1280×720', width: 1280, height: 720, fold: true },
    { name: 'phone 360×640', width: 360, height: 640, fold: false }
];

const MODES = {
    purchase: { btn: '#purchaseModeBtn', item: '#billItem', rate: '#billRate', weight: '#newWeight', section: '#purchaseSection', totals: ['#billTotal', '#amountPayable'], actions: ['#saveBillBtn', '#printBillBtn'] },
    sale: { btn: '#saleModeBtn', item: '#saleItem', rate: '#saleRate', weight: '#saleWeight', section: '#saleSection', totals: ['#saleTotal'], actions: ['#saveSaleBtn', '#printSaleBtn'] }
};

/** Where an element is on screen, and whether it is the topmost thing at its centre. */
const place = (page, sel) => page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    const tab = document.querySelector('.tab.active');
    return {
        top: Math.round(r.top), bottom: Math.round(r.bottom), right: Math.round(r.right),
        vw: window.innerWidth, vh: window.innerHeight,
        scrolled: Math.round((tab ? tab.scrollTop : 0) + window.scrollY),
        onTop: !!hit && (hit === el || el.contains(hit))
    };
});

const scrollTab = (page, to) => page.evaluate((where) => {
    const tab = document.querySelector('.tab.active');
    window.scrollTo(0, 0);
    if (tab) tab.scrollTop = where === 'end' ? tab.scrollHeight : 0;
}, to);

/** Taps a control after bringing it to the middle of the screen (clear of the phone's bottom bar). */
async function tap(page, sel) {
    await page.$eval(sel, el => el.scrollIntoView({ block: 'center' }));
    await page.click(sel);
}

async function addLine(page, mode) {
    const m = MODES[mode];
    await tap(page, m.btn);
    await expect(page.locator(m.section)).toBeVisible();
    const value = await page.$eval(m.item, (sel) => [...sel.options].find(o => o.value && /Rice|Wheat/.test(o.textContent))?.value);
    expect(value, 'a seeded item is in the list').toBeTruthy();
    await page.selectOption(m.item, value);
    await page.fill(m.rate, '30');
    await page.fill(m.weight, '10');
    await tap(page, `${m.section} .quick-add-btn-inline`);
    await tap(page, `${m.section} .add-to-bill-btn`);
    await expect(page.locator(m.totals[0])).not.toHaveText('0');
}

for (const size of SIZES) {
    test(`billing totals and Save on screen: ${size.name}`, async ({ page, problems }, testInfo) => {
        // The viewport is set here, so one browser set-up is enough per size.
        test.skip(testInfo.project.name !== (size.fold ? 'desktop' : 'phone'), 'runs once, in the matching project');
        await page.setViewportSize({ width: size.width, height: size.height });
        await login(page, 'owner');
        await showTab(page, 'billing');
        for (const mode of Object.keys(MODES)) {
            await addLine(page, mode);
            await scrollTab(page, size.fold ? 'top' : 'end');
            const m = MODES[mode];
            for (const sel of size.fold ? [...m.totals, ...m.actions] : m.actions) {
                const p = await place(page, sel);
                const where = `${mode} ${sel} at ${size.name}: ${JSON.stringify(p)}`;
                if (size.fold) expect(p.scrolled, `page not scrolled (${where})`).toBe(0);
                expect(p.top, `top on screen (${where})`).toBeGreaterThanOrEqual(0);
                expect(p.bottom, `bottom on screen (${where})`).toBeLessThanOrEqual(p.vh);
                expect(p.right, `not cut off on the right (${where})`).toBeLessThanOrEqual(p.vw);
                expect(p.onTop, `nothing covers it (${where})`).toBe(true);
            }
            await testInfo.attach(`billing-${mode}-${size.width}x${size.height}.png`, {
                body: await page.screenshot(), contentType: 'image/png'
            });
        }
        expect(problems.pageErrors).toEqual([]);
    });
}
