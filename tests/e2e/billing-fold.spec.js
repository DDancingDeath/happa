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
    purchase: { btn: '#purchaseModeBtn', item: '#billItem', rate: '#billRate', weight: '#newWeight', section: '#purchaseSection', totals: ['#billTotal', '#amountPayable'], actions: ['#saveBillBtn', '#printBillBtn'], last: '#billDate' },
    sale: { btn: '#saleModeBtn', item: '#saleItem', rate: '#saleRate', weight: '#saleWeight', section: '#saleSection', totals: ['#saleTotal'], actions: ['#saveSaleBtn', '#printSaleBtn'], last: '#saleDate' }
};

/** Where an element is on screen, and whether it is the topmost thing at its centre. */
const place = (page, sel) => page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    const tab = document.querySelector('.tab.active');
    const nav = document.querySelector('.bottom-nav');
    const navBox = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect() : null;
    const navTop = navBox && navBox.height > 0 ? navBox.top : window.innerHeight;
    return {
        top: Math.round(r.top), bottom: Math.round(r.bottom), right: Math.round(r.right),
        vw: window.innerWidth, vh: Math.round(Math.min(window.innerHeight, navTop)),
        scrolled: Math.round((tab ? tab.scrollTop : 0) + window.scrollY),
        onTop: !!hit && (hit === el || el.contains(hit))
    };
});

/** Scrolls the open tab to its top or end at once (the tab scrolls smoothly otherwise) and waits until it is still. */
async function scrollTab(page, to) {
    await page.evaluate((where) => {
        const tab = document.querySelector('.tab.active');
        window.scrollTo({ top: 0, behavior: 'instant' });
        if (tab) tab.scrollTo({ top: where === 'end' ? tab.scrollHeight : 0, behavior: 'instant' });
    }, to);
    await page.waitForFunction((where) => {
        const tab = document.querySelector('.tab.active');
        if (!tab) return true;
        const end = tab.scrollHeight - tab.clientHeight;
        return where === 'end' ? tab.scrollTop >= end - 1 : tab.scrollTop === 0;
    }, to);
}

/** Taps a control after bringing it to the middle of the screen (clear of the phone's bottom bar). */
async function tap(page, sel) {
    await page.$eval(sel, el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.click(sel);
}

/** Whether scrolling the tab, at some point, shows the element whole and on top. */
async function reachable(page, sel) {
    return page.evaluate(async (s) => {
        const tab = document.querySelector('.tab.active');
        const el = document.querySelector(s);
        for (let y = 0; y <= tab.scrollHeight; y += 20) {
            tab.scrollTo({ top: y, behavior: 'instant' });
            await new Promise(requestAnimationFrame);
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (r.top >= 0 && r.bottom <= window.innerHeight && hit && (hit === el || el.contains(hit))) return true;
        }
        return false;
    }, sel);
}

async function addLine(page, mode, rate = 30) {
    const m = MODES[mode];
    await tap(page, m.btn);
    await expect(page.locator(m.section)).toBeVisible();
    const value = await page.$eval(m.item, (sel) => [...sel.options].find(o => o.value && /Rice|Wheat/.test(o.textContent))?.value);
    expect(value, 'a seeded item is in the list').toBeTruthy();
    await page.selectOption(m.item, value);
    await page.fill(m.rate, String(rate));
    await page.fill(m.weight, '10');
    await tap(page, `${m.section} .quick-add-btn-inline`);
    await tap(page, `${m.section} .add-to-bill-btn`);
    await expect(page.locator(m.totals[0])).not.toHaveText('0');
    // Nothing paid yet: the bill checks add their banner above the bill and a line under the
    // split (after a short debounce). Measure with them, the case #104 is about.
    await expect(page.locator(`${m.section} > .bill-check-banner`)).toBeVisible();
    await expect(page.locator(`${m.section} .bill-col-summary .bill-check-msg`).first()).toBeVisible();
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
            if (size.fold) {
                // The fields between the totals and Save/Print (notes, date) can be reached by scrolling.
                expect(await reachable(page, m.last), `${m.last} reachable by scrolling`).toBe(true);
                await scrollTab(page, 'top');
            }
            await testInfo.attach(`billing-${mode}-${size.width}x${size.height}.png`, {
                body: await page.screenshot(), contentType: 'image/png'
            });
        }
        expect(problems.pageErrors).toEqual([]);
    });
}

test('a long bill on a laptop: the totals and Save stay on screen all the way down', async ({ page, problems }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'laptop only');
    await page.setViewportSize({ width: 1280, height: 720 });
    await login(page, 'owner');
    await showTab(page, 'billing');
    const m = MODES.purchase;
    for (let i = 0; i < 24; i++) await addLine(page, 'purchase', 30 + i);
    await expect(page.locator('#billTable tbody tr')).toHaveCount(24);
    const end = await page.evaluate(() => { const tab = document.querySelector('.tab.active'); return tab.scrollHeight - tab.clientHeight; });
    // Tabbing into the fields between the stuck totals and Save/Print shows them in the gap
    await page.evaluate((y) => document.querySelector('.tab.active').scrollTo({ top: y, behavior: 'instant' }), Math.round(end / 2));
    for (const sel of ['#billComments', '#billDate']) {
        await page.focus(sel);
        await page.waitForTimeout(100);
        const p = await place(page, sel);
        expect(p.top >= 0 && p.bottom <= p.vh && p.onTop, `${sel} visible when focused (${JSON.stringify(p)})`).toBe(true);
    }
    for (const at of [0.25, 0.5, 0.75, 1]) {
        await page.evaluate((y) => document.querySelector('.tab.active').scrollTo({ top: y, behavior: 'instant' }), Math.round(end * at));
        for (const sel of ['#billTotal', '#amountPayable', ...m.actions]) {
            const p = await place(page, sel);
            expect(p.top >= 0 && p.bottom <= p.vh && p.onTop, `${sel} on screen at ${at * 100}% (${JSON.stringify(p)})`).toBe(true);
        }
    }
    expect(problems.pageErrors).toEqual([]);
});
