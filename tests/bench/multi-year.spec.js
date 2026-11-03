/**
 * Multi-year data-load benchmark (#59), on the phone project with a 4× slower CPU
 * (like startup-perf.spec.js). With the 3-year shop of global-setup.js:
 *   - firstSignInMs: the first sign-in (cold: nothing cached, the legacy scan and the stock
 *     checkpoint are built), navigation start → app shown; firstSignInReads: its reads until the
 *     checkpoint is stored (the reopens wait for it: one cut short by a reload is read again on
 *     every start, #159);
 *   - then BENCH_RUNS (3) reopens; medians of appShownMs (navigation start → first screen),
 *     todayOpenMs (opening Today until its figures are drawn) and firstTodayMs (the two added),
 *     and the reads the app's read meter counted until it was still (startupReads; startupTop:
 *     the meter's top sources in that run);
 *   - historyLoadMs / historyReads: the whole history window (ensureHistoryFrom(null), what
 *     "All time" and the stock rebuild ask for) after the last reopen.
 * Writes test-results/bench-result.json for tools/bench/record.js. No budget is checked here.
 */
const fs = require('fs');
const path = require('path');
const { test, expect, login, showTab } = require('../e2e/support/app');
const { settledReads } = require('../e2e/support/read-budget');

const RUNS = Number(process.env.BENCH_RUNS || 3);
const OUT = path.join(__dirname, '..', '..', 'test-results', 'bench-result.json');
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const appShown = (page) => page.evaluate(() => {
    const m = performance.getEntriesByName('aadhat:app-shown')[0];
    return m ? Math.round(m.startTime) : null;
});

async function openToday(page) {
    const t0 = Date.now();
    await showTab(page, 'day');
    await page.waitForFunction(() => {
        const el = document.getElementById('dayTodayContent');
        if (!el || el.offsetParent === null) return false;
        const text = el.innerText || '';
        return text.length > 40 && !/Loading|लोड हो रह/.test(text);
    }, null, { timeout: 120000 });
    return Date.now() - t0;
}

test('3-year shop: first Today and the whole history window', async ({ page, problems }) => {
    test.setTimeout(900000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    await login(page, 'owner');
    const firstSignInMs = await appShown(page);
    await expect.poll(() => page.evaluate(() => !!window.FirebaseService.getStockCheckpointInfo()),
        { message: 'the first sign-in stores the stock checkpoint', timeout: 300000, intervals: [1000] }).toBe(true);
    const firstSignInReads = await settledReads(page, { quiet: 3000, timeout: 120000 });

    const runs = [];
    for (let i = 0; i < RUNS; i++) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => performance.getEntriesByName('aadhat:app-shown').length > 0, null, { timeout: 300000 });
        const shown = await appShown(page);
        const todayOpen = await openToday(page);
        const reads = await settledReads(page, { quiet: 2000, timeout: 60000 });
        const top = await page.evaluate(() => window.FirebaseService.getReadStats().top);
        runs.push({ appShownMs: shown, todayOpenMs: todayOpen, firstTodayMs: shown + todayOpen, startupReads: reads, startupTop: top });
    }

    const history = await page.evaluate(async () => {
        const s = window.FirebaseService;
        const r0 = s.getReadStats().reads;
        const t0 = performance.now();
        await s.ensureHistoryFrom(null);
        const a = window.AppState;
        return {
            historyLoadMs: Math.round(performance.now() - t0),
            historyReads: s.getReadStats().reads - r0,
            bills: (a.purchaseHistory || []).length + (a.retailSalesHistory || []).length + (a.salesHistory || []).length
        };
    });

    const pick = (k) => median(runs.map(r => r[k]));
    const startupReads = pick('startupReads');
    const result = {
        at: new Date().toISOString(),
        dataset: JSON.parse(process.env.BENCH_DATASET || '{}'),
        cpu: 4,
        runs: RUNS,
        firstSignInMs,
        firstSignInReads,
        appShownMs: pick('appShownMs'),
        todayOpenMs: pick('todayOpenMs'),
        firstTodayMs: pick('firstTodayMs'),
        startupReads,
        startupTop: runs.find(r => r.startupReads === startupReads)?.startupTop || [],
        ...history,
        samples: runs
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`[bench] ${JSON.stringify({ ...result, samples: undefined })}`);

    const c = result.dataset.counts || {};
    expect(history.bills, 'every seeded bill is loaded').toBeGreaterThanOrEqual((c.purchases || 0) + (c.retailSales || 0) + (c.wholesaleSales || 0));
    expect(problems.pageErrors).toEqual([]);
});
