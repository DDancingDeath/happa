/**
 * Start-up timing with a 4× slower CPU (#66, #59): a signed-in owner reopens the
 * app five times; the median of each startup mark (utils/startup-timings.js) and
 * the page templates fetched before the first screen are printed as
 * "[startup-perf]" lines in the CI log. Reports only (CI machines vary); the
 * template count is the one hard check.
 */
const { test, expect, login } = require('./support/app');
const { EAGER_PAGES, SHELL_TEMPLATES } = require('./support/templates');

const RUNS = 5;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

test('cold start of a signed-in phone with a 4× slower CPU', async ({ page, problems }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'measured once, on the phone project');
    test.setTimeout(300000);
    await login(page, 'owner');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
        const templates = [];
        const onRequest = (r) => { const m = /\/templates\/([\w-]+)\.html/.exec(r.url()); if (m) templates.push(m[1]); };
        page.on('request', onRequest);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => (window.performance.getEntriesByName('aadhat:app-shown').length > 0), null, { timeout: 120000 });
        page.off('request', onRequest);
        const marks = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('mark')
            .filter(m => m.name.startsWith('aadhat:')).map(m => [m.name.slice(7), Math.round(m.startTime)])));
        runs.push({ marks, templates: [...new Set(templates)] });
    }
    const names = ['shell', 'templates', 'auth', 'profile', 'listeners', 'app-shown'];
    const summary = Object.fromEntries(names.map(n => [n, median(runs.map(r => r.marks[n]).filter(v => v !== undefined))]));
    const fetched = runs[runs.length - 1].templates;
    console.log(`[startup-perf] cpu=4x runs=${RUNS} median ms: ${names.map(n => `${n}=${summary[n]}`).join(' ')}`);
    console.log(`[startup-perf] templates fetched before the first screen (${fetched.length}): ${fetched.sort().join(', ')}`);
    testInfo.annotations.push({ type: 'startup-perf', description: JSON.stringify({ summary, fetched }) });
    if (EAGER_PAGES) expect(fetched.sort()).toEqual([...SHELL_TEMPLATES, ...EAGER_PAGES].sort());
    expect(problems.pageErrors).toEqual([]);
});
