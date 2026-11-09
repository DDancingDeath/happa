/**
 * Ask item reports (#415, docs/calculations.md ASK-5, ASK-6), as the owner, in English and Hindi:
 * "how much Lah was bought till today" needs bills older than the loaded window, so Ask first
 * shows no figures and the estimate; after the confirm it reads them once and shows each kind
 * (Lahsun / Garlic never counted). The Excel file has a Summary sheet and one sheet per kind
 * ending in a totals row. Sales by party: changed by hand (grouping, a kind off), with an Excel
 * sheet per party. A manager sees kg only. Screenshots of each step and of the workbook go to
 * the test's output folder. With Insights › Seasons' stats built, the same question answers at once
 * from them (ASK-7) before any bill is read, and Excel is made with no CDN (offline-capable).
 */
const fs = require('fs');
const { test, expect, login, showTab } = require('./support/app');
const { commit, deleteAll, deleteDocs } = require('./support/emulator');
const { XLSX_URL } = require('./support/xlsx-url');

const DAY = 86400000;
const ITEMS = [
    { id: 'itm_ask_kusmi', name: 'Lah Kusmi', hindiName: 'कुसमी लाह', rates: [210] },
    { id: 'itm_ask_rangeeni', name: 'Rangeeni Lah', hindiName: 'रंगीनी लाह', rates: [180] },
    { id: 'itm_ask_garlic', name: 'Garlic', hindiName: 'लहसुन', rates: [90] }
];
const line = (itemId, name, qty, rate) => ({ itemId, name, qty, rate, total: qty * rate, weights: [qty] });
const purchase = (id, billNumber, daysAgo, lines, labour) => {
    const t = Date.now() - daysAgo * DAY;
    const value = lines.reduce((a, l) => a + l.total, 0);
    const total = value - labour;
    return {
        id, billNumber, timestamp: t, date: new Date(t).toISOString(), items: lines,
        billTotal: value, laborCharges: labour, grandTotal: total, amountPayable: total, totalPackets: lines.length,
        cashPayment: total, onlinePayment: 0, dueAmount: 0, payment: { cash: total, online: 0, due: 0, total },
        customerName: 'Ask Farmer', type: 'purchase', isPurchase: true, userName: 'Owner', clientVersion: 3, openDue: false
    };
};
const BILLS = [
    purchase('ask_p201', 'P-201', 2, [line('itm_ask_kusmi', 'Lah Kusmi', 120, 210), line('itm_ask_garlic', 'Garlic', 10, 90)], 60),
    purchase('ask_p202', 'P-202', 1, [line('itm_ask_rangeeni', 'Rangeeni Lah', 80, 180.5)], 0),
    purchase('ask_p101', 'P-101', 200, [line('itm_ask_kusmi', 'Lah Kusmi', 100, 200)], 40),
    purchase('ask_p102', 'P-102', 190, [line('itm_ask_rangeeni', 'Rangeeni Lah', 50, 175)], 0)
];

const sale = (id, billNumber, daysAgo, customerName, lines, total) => {
    const t = Date.now() - daysAgo * DAY;
    const value = lines.reduce((a, l) => a + l.total, 0);
    const due = 0;
    return {
        id, billNumber, timestamp: t, date: new Date(t).toISOString(), items: lines, customerName,
        billTotal: value, grandTotal: total ?? value, cashPayment: total ?? value, onlinePayment: 0, dueAmount: due,
        payment: { cash: total ?? value, online: 0, due, total: total ?? value }, userName: 'Owner', clientVersion: 3, openDue: false
    };
};
const RETAIL = [
    sale('ask_s1', 'R-901', 2, 'Ask Ramesh', [line('itm_ask_kusmi', 'Lah Kusmi', 10, 250), line('itm_ask_garlic', 'Garlic', 5, 100)], 2995),
    sale('ask_s2', 'R-902', 1, 'Ask Suresh', [line('itm_ask_rangeeni', 'Rangeeni Lah', 4, 200)])
];
const WHOLESALE = [sale('ask_w1', 'W-901', 1, 'Ask Traders', [line('itm_ask_kusmi', 'Lah Kusmi', 50, 240)])];

test.beforeEach(async () => {
    await commit([...ITEMS.map(i => ['dev_items', i.id, i]), ...BILLS.map(b => ['dev_purchases', b.id, b]),
        ...RETAIL.map(b => ['dev_retailSales', b.id, b]), ...WHOLESALE.map(b => ['dev_wholesaleSales', b.id, b])]);
});
test.afterEach(async () => {
    await deleteDocs('dev_items', ITEMS.map(i => i.id));
    await deleteDocs('dev_purchases', BILLS.map(b => b.id));
    await deleteDocs('dev_retailSales', RETAIL.map(b => b.id));
    await deleteDocs('dev_wholesaleSales', WHOLESALE.map(b => b.id));
});

const readBook = async (browser, file) => {
    // The workbook as Excel would show it: its sheets as tables, read back with SheetJS.
    const view = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await view.setContent('<!doctype html><meta charset="utf-8"><style>body{font:13px system-ui;margin:16px}h2{font-size:15px;margin:18px 0 6px}table{border-collapse:collapse}td{border:1px solid #bbb;padding:3px 8px}</style><body></body>');
    await view.addScriptTag({ url: XLSX_URL });
    const book = await view.evaluate((b64) => {
        const wb = window.XLSX.read(Uint8Array.from(atob(b64), ch => ch.charCodeAt(0)), { type: 'array' });
        document.body.innerHTML = wb.SheetNames.map(n => `<h2>${n}</h2>${window.XLSX.utils.sheet_to_html(wb.Sheets[n], { header: '', footer: '' })}`).join('');
        return { names: wb.SheetNames, rows: wb.SheetNames.map(n => window.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' })) };
    }, fs.readFileSync(file).toString('base64'));
    return { view, book };
};

const CASES = [
    { lang: 'en', question: 'What all kinds of Lah were bought till today, as an Excel sheet', older: 'not on this phone', kusmi: 'Lah Kusmi: 220 kg · average ₹205.45/kg · ₹45,200 (2 bills)',
        rangeeni: 'Rangeeni Lah: 130 kg · average ₹178.38/kg · ₹23,190 (2 bills)', all: 'All kinds: 350 kg · average ₹195.40/kg · ₹68,390 (4 bills)',
        notCounted: 'Garlic', sheets: ['Summary', 'Lah Kusmi', 'Rangeeni Lah'], total: 'Total' },
    { lang: 'hi', question: 'लाह कितना खरीदा अब तक', older: 'इस फ़ोन पर नहीं हैं', kusmi: 'कुसमी लाह: 220 kg · औसत ₹205.45/kg · ₹45,200 (2 बिल)',
        rangeeni: 'रंगीनी लाह: 130 kg · औसत ₹178.38/kg · ₹23,190 (2 बिल)', all: 'सभी किस्में: 350 kg · औसत ₹195.40/kg · ₹68,390 (4 बिल)',
        notCounted: 'लहसुन', sheets: ['सार', 'कुसमी लाह', 'रंगीनी लाह'], total: 'कुल' }
];

for (const c of CASES) {
    test(`owner (${c.lang}): Lah till today — confirm the older bills, figures per kind, Excel with one sheet per kind`, async ({ page, browser, problems }, testInfo) => {
        const still = (p) => p.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
        const shot = async (name, target = page) => {
            const p = 'page' in target ? target.page() : target;
            // The "Login successful" toast would cover the answer.
            await p.evaluate(() => document.getElementById('toast')?.classList.remove('show'));
            await still(p);
            await target.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-${c.lang}-${name}.png`) });
        };
        if (c.lang === 'hi') await page.addInitScript(() => localStorage.setItem('aadhat.lang', 'hi'));
        await login(page, 'owner');
        await showTab(page, 'ask');
        await page.fill('#askInput', c.question);
        await page.press('#askInput', 'Enter');
        const answer = page.locator('.ask-answer').first();
        await expect(answer).toContainText(c.older);
        await expect(answer).not.toContainText('₹');
        await shot('1-needs-older', answer);

        await answer.locator('.ask-load').click();
        await expect(page.locator('#modalOverlay')).toHaveClass(/active/);
        await expect(page.locator('#modalOverlay')).toContainText('50,000');
        await shot('2-confirm');
        await page.click('#modalConfirm');

        await expect(answer).toContainText(c.kusmi);
        await expect(answer).toContainText(c.rangeeni);
        await expect(answer).toContainText(c.all);
        await expect(answer).toContainText(c.notCounted);
        await expect(answer.locator('.ask-line').filter({ hasText: c.kusmi })).not.toContainText(c.notCounted);
        await expect(page.locator('#modalOverlay')).not.toHaveClass(/active/);
        await shot('3-report', answer);

        const [download] = await Promise.all([page.waitForEvent('download'), answer.locator('.ask-xlsx').click()]);
        expect(download.suggestedFilename()).toMatch(/_item-report_.*\.xlsx$/);
        const file = testInfo.outputPath(`${testInfo.project.name}-${c.lang}-${download.suggestedFilename()}`);
        await download.saveAs(file);

        const { view, book } = await readBook(browser, file);
        expect(book.names).toEqual(c.sheets);
        const kusmi = book.rows[1];
        expect(kusmi.slice(2, -1).map(r => [r[0], r[2], r[3], r[4]])).toEqual([['P-101', 100, 200, 20000], ['P-201', 120, 210, 25200]]);
        expect(kusmi.at(-1).slice(0, 5)).toEqual([c.total, '', 220, 205.45, 45200]);
        expect(book.rows[0].at(-1).slice(1, 5)).toEqual([4, 350, 195.4, 68390]);
        await view.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-${c.lang}-4-workbook.png`), fullPage: true });
        await view.close();
        expect(problems.pageErrors).toEqual([]);
    });
}

// Insights › Seasons' stats of the two older bills, as the history from bills stores them (IST months).
const istMonth = (t) => new Date(t + 330 * 60000).toISOString().slice(0, 7);
const EMPTY = { kg: 0, amount: 0, min: null, max: null, avg: 0, bills: 0 };
const STATS = [
    ...[BILLS[2], BILLS[3]].map((b) => {
        const l = b.items[0];
        const m = istMonth(b.timestamp);
        const purchase = { kg: l.qty, amount: l.qty * l.rate, min: l.rate, max: l.rate, avg: l.rate, bills: 1 };
        return { id: `${l.itemId}_${m.slice(0, 4)}`, itemId: l.itemId, year: m.slice(0, 4), weeks: {}, months: { [`m${m}`]: { purchase, retail: EMPTY, wholesale: EMPTY, bills: 1 } } };
    }),
    { id: '_meta', backfillDone: true, backfillAt: Date.now() - 100 * DAY, bills: 2 }
];

test('owner: Lah till today answers at once from the item stats (ASK-7); the bills after the confirm; Excel without the CDN', async ({ page, browser, problems }, testInfo) => {
    await commit(STATS.map(d => ['dev_rateStats', d.id, d]));
    try {
        const cdn = [];
        const writer = [];
        await page.route('https://cdn.sheetjs.com/**', (route) => { cdn.push(route.request().url()); return route.abort(); });
        page.on('request', (r) => { if (r.url().includes('/vendor/sheetjs/')) writer.push(r.url()); });
        await login(page, 'owner');
        await showTab(page, 'ask');
        await page.fill('#askInput', 'What all kinds of Lah were bought till today, as an Excel sheet');
        await page.press('#askInput', 'Enter');
        const answer = page.locator('.ask-answer').first();
        await expect(answer).toContainText('Quick figure from Insights › Seasons');
        await expect(answer).toContainText('Lah Kusmi: 220 kg · average ₹205.45/kg · ₹45,200 (2 bills)');
        await expect(answer).toContainText('Rangeeni Lah: 130 kg · average ₹178.38/kg · ₹23,190 (2 bills)');
        await expect(answer).toContainText('All kinds: 350 kg · average ₹195.40/kg · ₹68,390');
        await expect(answer.locator('.ask-load')).toHaveCount(1);
        await expect(answer.locator('.ask-xlsx')).toHaveCount(0);
        await page.evaluate(() => document.getElementById('toast')?.classList.remove('show'));
        await answer.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-quick-figure.png`) });

        await answer.locator('.ask-load').click();
        await page.click('#modalConfirm');
        await expect(answer).not.toContainText('Quick figure');
        await expect(answer).toContainText('All kinds: 350 kg · average ₹195.40/kg · ₹68,390 (4 bills)');

        const [download] = await Promise.all([page.waitForEvent('download'), answer.locator('.ask-xlsx').click()]);
        const file = testInfo.outputPath(`${testInfo.project.name}-offline-${download.suggestedFilename()}`);
        await download.saveAs(file);
        const { view, book } = await readBook(browser, file);
        expect(book.names).toEqual(['Summary', 'Lah Kusmi', 'Rangeeni Lah']);
        expect(book.rows[0].at(-1).slice(1, 5)).toEqual([4, 350, 195.4, 68390]);
        await view.close();
        expect(cdn).toEqual([]);
        expect(writer).toEqual([expect.stringMatching(/\/vendor\/sheetjs\/0\.20\.1\/xlsx\.mini\.min\.js$/)]);
        expect(problems.pageErrors).toEqual([]);
    } finally {
        await deleteAll('dev_rateStats');
    }
});
const SALES = [
    { lang: 'en', question: 'lah kisko becha pichle mahine se ab tak', traders: 'Ask Traders: 50 kg · average ₹240.00/kg · ₹12,000 (1 bill)',
        ramesh: 'Ask Ramesh: 10 kg · average ₹250.00/kg · ₹2,500 (1 bill)', all: 'All parties: 64 kg · average ₹239.06/kg · ₹15,300 (3 bills)',
        withoutRangeeni: 'All parties: 60 kg', sheets: ['Summary', 'Ask Traders', 'Ask Ramesh', 'Ask Suresh'],
        head: ['Bill no.', 'Date', 'Bill type', 'Item', 'Weight (kg)', 'Rate (₹/kg)', 'Amount (₹)'], wholesale: 'Wholesale' },
    { lang: 'hi', question: 'लाह किसको बेची पिछले महीने से अब तक', traders: 'Ask Traders: 50 kg · औसत ₹240.00/kg · ₹12,000 (1 बिल)',
        ramesh: 'Ask Ramesh: 10 kg · औसत ₹250.00/kg · ₹2,500 (1 बिल)', all: 'सभी पार्टियाँ: 64 kg · औसत ₹239.06/kg · ₹15,300 (3 बिल)',
        withoutRangeeni: 'सभी पार्टियाँ: 60 kg', sheets: ['सार', 'Ask Traders', 'Ask Ramesh', 'Ask Suresh'],
        head: ['बिल नं.', 'तारीख', 'बिल का प्रकार', 'माल', 'वज़न (kg)', 'भाव (₹/kg)', 'रकम (₹)'], wholesale: 'थोक' }
];

for (const c of SALES) {
    test(`owner (${c.lang}): Lah sold by party — change it by hand, Excel with one sheet per party`, async ({ page, browser, problems }, testInfo) => {
        const shot = async (name, target = page) => {
            const p = 'page' in target ? target.page() : target;
            await p.evaluate(() => document.getElementById('toast')?.classList.remove('show'));
            await p.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
            await target.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-${c.lang}-sales-${name}.png`) });
        };
        if (c.lang === 'hi') await page.addInitScript(() => localStorage.setItem('aadhat.lang', 'hi'));
        await login(page, 'owner');
        await showTab(page, 'ask');
        await page.fill('#askInput', c.question);
        await page.press('#askInput', 'Enter');
        const answer = page.locator('.ask-answer').first();
        await expect(answer).toContainText(c.traders);
        await expect(answer).toContainText(c.ramesh);
        await expect(answer).toContainText(c.all);
        await expect(answer.locator('.ask-load')).toHaveCount(0);
        await shot('1-by-party', answer);

        const [download] = await Promise.all([
            page.waitForEvent('download'),
            (async () => {
                await answer.locator('.ask-xlsx').click();
                // party names in the file: the owner confirms first
                await expect(page.locator('#modalOverlay')).toHaveClass(/active/);
                await page.click('#modalConfirm');
            })()
        ]);
        const file = testInfo.outputPath(`${testInfo.project.name}-${c.lang}-sales-${download.suggestedFilename()}`);
        await download.saveAs(file);
        const { view, book } = await readBook(browser, file);
        expect(book.names).toEqual(c.sheets);
        expect(book.rows[1][1]).toEqual(c.head);
        expect(book.rows[1][2].slice(2)).toEqual([c.wholesale, 'Lah Kusmi', 50, 240, 12000].map((v, i) => (i === 1 && c.lang === 'hi' ? 'कुसमी लाह' : v)));
        await view.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-${c.lang}-sales-3-workbook.png`), fullPage: true });
        await view.close();

        await answer.locator('.ask-kind', { hasText: c.lang === 'hi' ? 'रंगीनी लाह' : 'Rangeeni Lah' }).click();
        await expect(answer).toContainText(c.withoutRangeeni);
        await answer.locator('select[data-ask-ctl$="-groupBy"]').selectOption('month');
        await expect(answer).toContainText('60 kg');
        await expect(answer).not.toContainText('Ask Traders');
        await shot('2-changed', answer);
        expect(problems.pageErrors).toEqual([]);
    });
}

test('a manager: kg only, no Excel, and no read of older bills', async ({ page }) => {
    await login(page, 'manager');
    await showTab(page, 'ask');
    await page.fill('#askInput', 'lah kitna kharida ab tak');
    await page.press('#askInput', 'Enter');
    const answer = page.locator('.ask-answer').first();
    await expect(answer).toContainText('Only the owner can load older bills');
    await expect(answer.locator('.ask-load, .ask-xlsx')).toHaveCount(0);
    await page.fill('#askInput', 'pichle mahine se lah kitna kharida ab tak');
    await page.press('#askInput', 'Enter');
    await expect(answer).toContainText('Lah Kusmi: 120 kg (1 bill)');
    await expect(answer).toContainText('Rangeeni Lah: 80 kg (1 bill)');
    await expect(answer).not.toContainText('₹');
    await expect(answer.locator('.ask-xlsx, .ask-csv, .ask-load')).toHaveCount(0);
});
