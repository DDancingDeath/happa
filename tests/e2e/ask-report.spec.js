/**
 * Ask item reports (#415, docs/calculations.md ASK-5), as the owner, in English and Hindi:
 * "how much Lah was bought till today" needs bills older than the loaded window, so Ask first
 * shows no figures and the estimate; after the confirm it reads them once and shows each kind
 * (Lahsun / Garlic never counted). The Excel file has a Summary sheet and one sheet per kind
 * ending in a totals row. Screenshots of each step and of the workbook go to the test's
 * output folder.
 */
const fs = require('fs');
const { test, expect, login, showTab } = require('./support/app');
const { commit, deleteDocs } = require('./support/emulator');
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

test.beforeEach(async () => {
    await commit([...ITEMS.map(i => ['dev_items', i.id, i]), ...BILLS.map(b => ['dev_purchases', b.id, b])]);
});
test.afterEach(async () => {
    await deleteDocs('dev_items', ITEMS.map(i => i.id));
    await deleteDocs('dev_purchases', BILLS.map(b => b.id));
});

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

        await answer.locator('button').click();
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

        const [download] = await Promise.all([page.waitForEvent('download'), answer.locator('button').first().click()]);
        expect(download.suggestedFilename()).toMatch(/_item-report_.*\.xlsx$/);
        const file = testInfo.outputPath(`${testInfo.project.name}-${c.lang}-${download.suggestedFilename()}`);
        await download.saveAs(file);

        // The workbook as Excel would show it: its sheets as tables, read back with SheetJS.
        const view = await browser.newPage({ viewport: { width: 1000, height: 700 } });
        await view.setContent('<!doctype html><meta charset="utf-8"><style>body{font:13px system-ui;margin:16px}h2{font-size:15px;margin:18px 0 6px}table{border-collapse:collapse}td{border:1px solid #bbb;padding:3px 8px}</style><body></body>');
        await view.addScriptTag({ url: XLSX_URL });
        const book = await view.evaluate((b64) => {
            const wb = window.XLSX.read(Uint8Array.from(atob(b64), ch => ch.charCodeAt(0)), { type: 'array' });
            document.body.innerHTML = wb.SheetNames.map(n => `<h2>${n}</h2>${window.XLSX.utils.sheet_to_html(wb.Sheets[n], { header: '', footer: '' })}`).join('');
            return { names: wb.SheetNames, rows: wb.SheetNames.map(n => window.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' })) };
        }, fs.readFileSync(file).toString('base64'));
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

test('a manager asking the same gets no figures and no read of older bills', async ({ page }) => {
    await login(page, 'manager');
    await showTab(page, 'ask');
    await page.fill('#askInput', 'lah kitna kharida ab tak');
    await page.press('#askInput', 'Enter');
    await expect(page.locator('.ask-answer').first()).toContainText('Only the owner');
    await expect(page.locator('.ask-answer button')).toHaveCount(0);
});
