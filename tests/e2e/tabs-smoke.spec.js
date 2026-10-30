/**
 * Every-page smoke (#127): owner, manager and member open every page and
 * section they may see, in English and Hindi, on phone and desktop (the two
 * Playwright projects). Each screen must show no page or console error, no
 * NaN / undefined / null / [object Object] / Invalid Date / raw i18n key, and
 * no text that mixes English and Hindi, no Hindi on an English screen and no
 * English on a Hindi screen (beyond the allow-list in screenFindings). Each page
 * must stay inside its read budget (support/read-budget.js, read-baselines.json).
 * Pages a role may not open must redirect. Logged out: login, register, reset,
 * /download and the tenant link page /r/<token>.
 * Each test starts from a freshly seeded emulator (support/seed.js), so its read
 * counts do not depend on which specs ran before it in the shard.
 */
const { test, expect, login, openApp, showTab } = require('./support/app');
const { TENANT_TOKEN } = require('./support/emulator');
const { seed } = require('./support/seed');
const { RECORD, settledReads, overBudget, recordBaselines } = require('./support/read-budget');

const A = ['owner', 'manager', 'staff'];
const OM = ['owner', 'manager'];
const O = ['owner'];
const M = ['staff']; // "Member"
// showTabFromNav draws a page's default sub-tab in a setTimeout of this many ms.
const NAV_TIMER_MS = 100;
// Background reads after the app shows: AnomaliesManager.scheduleDailyScan() (8 s) and the legacy scan (>= 3 s).
const START_UP_WORK_MS = 8500;
// A step's reads count once the read meter has been still this long (at most STEP_READS_TIMEOUT_MS).
const STEP_READS_QUIET_MS = 500;
const STEP_READS_TIMEOUT_MS = 3000;

// The specs that add data (bill-flow, edit-bill, rentals) may run before this one in a shard: start every test from the seed.
test.beforeEach(async () => {
    await seed();
});

// name, route (nav.showTab), page (.tab id that must show), act (JS run after the page opened), roles,
// expect (selector that must be visible: the step's own section or active sub-tab), hidden (selectors that must stay hidden),
// timers (act's own setTimeout delay to let fire), settle (ms the screen may take to stop loading; default 10 s)
const STEPS = [
    { name: 'Today', route: 'day', page: 'day', act: "window.app.day.showSubTab('today')", roles: A, expect: '#dayTodayContent' },
    { name: 'Today › Cash', route: 'day', page: 'day', act: "window.app.day.showSubTab('cash')", roles: A, expect: '#dayCashContent' },
    { name: 'Billing › Purchase', route: 'billing', page: 'billing', roles: A, expect: '#purchaseSection' },
    { name: 'Billing › Retail sale', route: 'billing', page: 'billing', act: "window.app.billing.switchMode('sale', { currentTarget: document.getElementById('saleModeBtn') })", roles: A, expect: '#saleSection' },
    { name: 'Wholesale › Sale', route: 'wholesale-sales', page: 'wholesale-sales', roles: OM, expect: '#salesEntrySection' },
    { name: 'Wholesale › History', route: 'wholesale-history', page: 'wholesale-sales', roles: OM, expect: '#salesHistorySection' },
    { name: 'Wholesale › Outstanding', route: 'wholesale-sales', page: 'wholesale-sales', act: "window.app.wholesaleSales.filterTab('outstanding')", roles: OM, expect: '#salesOutstandingSection' },
    { name: 'Expenses › Business', route: 'expenses', page: 'expenses', roles: A, expect: '#businessExpenseSection' },
    { name: 'Expenses › Personal', route: 'expenses', page: 'expenses', act: "window.app.expenses.filterExpenseTab('personal')", roles: A, expect: '#personalExpenseSection' },
    { name: 'Rates', route: 'rates', page: 'items', roles: A },
    { name: 'History › Purchase', route: 'history', page: 'history', act: "window.app.history.filterHistory('purchase')", roles: A, expect: '#history .filter-purchase.active' },
    { name: 'History › Sale', route: 'history', page: 'history', act: "window.app.history.filterHistory('sale')", roles: A, expect: '#history .filter-sale.active' },
    { name: 'Stocks › Current', route: 'stock', page: 'stock', roles: A, expect: '#currentStockSection' },
    { name: 'Stocks › Not selling', route: 'stock', page: 'stock', act: "window.app.stock.filterTab('dead')", roles: OM, expect: '#deadStockSection' },
    { name: 'Stocks › Adjustment', route: 'stock', page: 'stock', act: "window.app.stock.filterTab('adjustment')", roles: OM, expect: '#stockAdjustmentSection' },
    { name: 'Stocks › Opening stock', route: null, page: 'stock', act: 'window.app.settings.openOpeningStock()', roles: OM, timers: 150, expect: '#stockAdjustmentSection' },
    // Members may not open Not selling or Adjustment (stock.js filterStockTab): the Current screen stays.
    { name: 'Stocks › Not selling and Adjustment stay closed', route: 'stock', page: 'stock', act: "(window.app.stock.filterTab('dead'), window.app.stock.filterTab('adjustment'))", roles: M, expect: '#currentStockSection', hidden: ['#deadStockSection', '#stockAdjustmentSection', '#deadStockTabBtn'] },
    { name: 'Outstanding › Purchase', route: 'due', page: 'due', roles: A, expect: '#due .filter-purchase.active' },
    { name: 'Outstanding › Sale', route: 'due', page: 'due', act: "window.app.outstanding.filterDue('sale', { target: document.querySelector('#due .filter-sale') })", roles: A, expect: '#due .filter-sale.active' },
    { name: 'Money › Profit', route: 'money-profit', page: 'money', roles: OM, expect: '#moneyProfit' },
    { name: 'Money › Cash', route: 'money-cash', page: 'money', roles: OM, expect: '#moneyCash' },
    { name: 'Money › Spending', route: 'money-spending', page: 'money', roles: OM, expect: '#moneySpending' },
    { name: 'Money › Worth', route: 'money-worth', page: 'money', roles: OM, expect: '#moneyWorth' },
    { name: 'Insights › Actions', route: 'insights-actions', page: 'insights', roles: OM, expect: '#insights [data-insights-pane="actions"]' },
    { name: 'Insights › Items', route: 'insights-items', page: 'insights', roles: OM, expect: '#insights [data-insights-pane="items"]' },
    { name: 'Insights › Parties', route: 'insights-parties', page: 'insights', roles: OM, expect: '#insights [data-insights-pane="parties"]' },
    { name: 'Insights › Seasons', route: 'insights-seasons', page: 'insights', roles: OM, expect: '#insights [data-insights-pane="seasons"]' },
    { name: 'Insights › Seasons › Trends', route: 'insights-trends', page: 'insights', roles: OM, expect: '#insights #rtRatesSection' },
    { name: 'Insights › Seasons › Product traffic', route: 'insights-traffic', page: 'insights', roles: OM, expect: '#insights #rtTrafficSection' },
    { name: 'Statements', route: 'statements', page: 'statements', roles: OM, expect: '#statementsList' },
    { name: 'Statements › Day', route: 'statements-day', page: 'statements', roles: OM, expect: `#statementsControls [onchange*="set('day'"]` },
    { name: 'Statements › Month', route: 'statements-month', page: 'statements', roles: OM, expect: `#statementsControls [onchange*="set('month'"]` },
    { name: 'Statements › Party', route: 'statements-party', page: 'statements', roles: OM, expect: `#statementsControls [onchange*="set('partyKey'"]` },
    { name: 'Statements › Item', route: 'statements-item', page: 'statements', roles: OM, expect: `#statementsControls [onchange*="set('itemKey'"]` },
    { name: 'Statements › CSV', route: 'statements-csv', page: 'statements', roles: OM, expect: `#statementsControls [onchange*="set('csvFrom'"]` },
    { name: 'Anomalies › List', route: 'anomalies', page: 'anomalies', roles: OM, expect: '#anomalyListView' },
    { name: 'Anomalies › Patterns', route: 'anomalies', page: 'anomalies', act: "window.app.anomalies.showView('patterns')", roles: OM, expect: '#anomalyTabPatterns.active' },
    { name: 'App health', route: 'health', page: 'health', roles: OM },
    { name: 'Admin › Users', route: 'admin', page: 'admin', act: "window.app.admin.showTab('users')", roles: O, expect: '#adminActiveUsers' },
    { name: 'Admin › Data', route: 'admin', page: 'admin', act: "window.app.admin.showTab('data')", roles: O, expect: '#adminContainer .danger-zone' },
    { name: 'Diagnostics › Number checks', route: 'diagnostics', page: 'diagnostics', act: "window.app.diagnostics.showTab('numbers')", roles: OM, expect: '#diagnosticsContainer .diag-numchecks-intro' },
    { name: 'Diagnostics › Errors', route: 'diagnostics', page: 'diagnostics', act: "window.app.diagnostics.showTab('errors')", roles: O, expect: '#diagTypeFilter' },
    { name: 'Diagnostics › Audit', route: 'diagnostics', page: 'diagnostics', act: "window.app.diagnostics.showTab('audit')", roles: O, expect: '#auditFilterAction' },
    { name: 'Settings › Common', route: 'settings-common', page: 'settings', roles: A, expect: '#settingsCommon' },
    { name: 'Settings › Aadhat', route: 'settings-shop', page: 'settings', roles: OM, expect: '#settingsShop' },
    { name: 'Settings › Rentals', route: 'settings-rentals', page: 'settings', roles: OM, expect: '#settingsRentals' },
    { name: 'Settings › Roles & access', route: 'settings-roles', page: 'settings', roles: O, expect: '#roleAccessCard' },
    { name: 'Rentals › Rent (property-wise)', route: null, page: 'rentals', act: "window.app.rentals.open('rent').then(() => window.app.rentals.setView('properties'))", roles: A, expect: `#rentalsBody .rent-viewswitch .filter-btn.active[onclick*="'properties'"]` },
    { name: 'Rentals › Rent (unit-wise)', route: null, page: 'rentals', act: "window.app.rentals.setView('units')", roles: A, expect: '#rentUnitList' },
    { name: 'Rentals › Tenants', route: null, page: 'rentals', act: "window.app.rentals.page('tenants')", roles: A, expect: '#rentals [data-rent-page="tenants"].active' },
    { name: 'Rentals › Properties', route: null, page: 'rentals', act: "window.app.rentals.page('properties')", roles: A, expect: '#rentals [data-rent-page="properties"].active' },
    { name: 'Rentals › Access', route: null, page: 'settings', act: "window.app.rentals.page('access')", roles: O, timers: NAV_TIMER_MS, expect: '#roleAccessCard' },
    { name: 'Back to Aadhat', route: null, page: null, act: "window.app.business.set('shop')", roles: A, wait: 600 },
    { name: 'Notifications', route: null, page: null, act: 'window.app.notifications.open()', roles: A, overlay: '#notifPanel', close: 'window.app.notifications.close()' },
    { name: "What's new", route: null, page: null, act: 'window.app.updates.showWhatsNew()', roles: A, overlay: '#whatsNewSheet', close: "document.querySelector('#whatsNewSheet .app-sheet-close')?.click()" }
];

// What a route shows once showTabFromNav's own first render (setTimeout NAV_TIMER_MS) has run: the page's default sub-tab.
// A step's act runs only after this, so that first render cannot undo it.
const ROUTE_READY = {
    day: '#day .sub-tab.active',
    billing: '#purchaseSection',
    'wholesale-sales': '#salesEntrySection',
    history: '#history .history-type-filter .filter-btn.active',
    stock: '#currentStockSection',
    due: '#due .filter-purchase.active',
    anomalies: '#anomalies .sub-tab.active',
    admin: '#adminTabsContainer .filter-btn.active',
    diagnostics: '#diagnosticsTabsContainer .filter-btn.active'
};

// Pages each role may not open: showTab must land somewhere else.
const BLOCKED = {
    manager: [['admin', 'admin']],
    staff: [['wholesale-sales', 'wholesale-sales'], ['wholesale-history', 'wholesale-sales'], ['money', 'money'], ['money-cash', 'money'],
        ['insights', 'insights'], ['insights-seasons', 'insights'], ['insights-trends', 'insights'], ['rate-trends', 'insights'],
        ['statements', 'statements'], ['anomalies', 'anomalies'], ['health', 'health'], ['admin', 'admin'], ['diagnostics', 'diagnostics']]
};

// Old page ids (owner): where each one lands now.
const OLD_IDS = [['items', 'items'], ['finance', 'money'], ['reports', 'statements'], ['analytics', 'insights'], ['rate-trends', 'insights'],
    ['rates-trends', 'insights'], ['rates-traffic', 'insights'], ['reports-trends', 'insights'], ['reports-traffic', 'insights'],
    ['settings-aadhat', 'settings'], ['admin-configure', 'settings']];

/** In the page: findings for the visible screen (active page + open sheets), in `lang`. */
function screenFindings({ lang, roots }) {
    const vis = (el) => !!el && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const els = [];
    for (const sel of roots) document.querySelectorAll(sel).forEach(el => { if (vis(el) && !els.some(e => e.contains(el))) els.push(el); });
    // Test data, product names and code identifiers (App health policy keys) are the same in both languages.
    const DATA = /\b[\w-]+\.apk\b|\b[\w-]+\.(web\.app|local)\b(\/[\w./-]*)?|happa|Tenant E2E|E2E (Shop|Bhawan)|\bE2E\b|\b(phone|desktop)\b|PEDIT-\w+|\b(Before|After) Edit\b|Gali \d+|Ram \d+|\bG\d+\b|Manager One|Staff One|Pending Person|\bOwner\b|Rice|Wheat|Mustard|चावल|गेहूं|सरसों|[\w.+-]+@[\w.-]+|https?:\/\/\S+|\bkg\b|\bKG\b|WhatsApp|\bUPI\b|\bPDF\b|\bCSV\b|Excel|\bOK\b|\bID\b|\bGST\b|Bluetooth|Android|\bAPK\b|Google|GPay|Chrome|Edge|Safari|iPhone|iPad|Firebase|\bJSON\b|DEVELOPMENT|\b[a-z]+[A-Z]\w*\b|"[a-z]+(-[a-z]+)+"|"\w+":\s*(true|false)\b/g;
    const dev = /[\u0900-\u097F]/;
    const latin = /[A-Za-z]{3,}/;
    const out = { bad: [], mixed: [], wrongLang: [], english: [] };
    const seen = new Set();
    const look = (raw, where) => {
        const s = String(raw || '').replace(/\s+/g, ' ').trim();
        if (!s || seen.has(s)) return;
        seen.add(s);
        const bad = s.match(/\bNaN\b|\bundefined\b|\bnull\b|\[object Object\]|Invalid Date|\b(ui|msg)\.[a-z_]+\.[a-z0-9_.]+/);
        if (bad) out.bad.push(`${where}"${s.slice(0, 90)}"`);
        const rest = s.replace(DATA, ' ');
        const hasDev = dev.test(rest);
        const hasLat = latin.test(rest);
        if (hasDev && hasLat) out.mixed.push(`${where}"${s.slice(0, 90)}"`);
        else if (lang === 'en' && hasDev) out.wrongLang.push(`${where}"${s.slice(0, 90)}"`);
        else if (lang === 'hi' && hasLat) out.english.push(`${where}"${s.slice(0, 60)}"`);
    };
    for (const root of els) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
            const p = n.parentElement;
            if (!p || p.closest('script,style,noscript,[data-lang-option],.auth-lang-links,#navLangToggle,.dev-banner') || !vis(p)) continue;
            // Text marked as the other language on purpose (a language switch button) or as no language (lang="zxx": a device id).
            const marked = p.closest('[lang]:not(html)');
            if (marked && marked.lang && marked.lang !== lang) continue;
            look(n.textContent, '');
        }
        root.querySelectorAll('input[placeholder],textarea[placeholder]').forEach(el => { if (vis(el)) look(el.placeholder, 'placeholder: '); });
        root.querySelectorAll('select').forEach(el => { if (vis(el)) [...el.options].slice(0, 20).forEach(o => look(o.text, 'option: ')); });
    }
    return out;
}

/** Waits until the screen stops changing (no "Loading…", same text twice); returns false if it never did. */
async function settle(page, timeout = 10000) {
    const ok = await page.waitForFunction(() => {
        const tab = document.querySelector('.tab.active');
        const ov = document.getElementById('loadingOverlay');
        if (ov && ov.classList.contains('active')) return false;
        const txt = tab ? tab.innerText : '';
        const busy = /Loading|लोड हो रह/.test(txt) || (tab && [...tab.querySelectorAll('.loading-spinner, .spinner')].some(e => e.offsetParent));
        const s = window.__smokeSettle || (window.__smokeSettle = { len: -1, n: 0 });
        if (!busy && txt.length === s.len) s.n++; else s.n = 0;
        s.len = txt.length;
        return s.n >= 2;
    }, null, { polling: 250, timeout }).then(() => true, () => false);
    await page.evaluate(() => { window.__smokeSettle = null; });
    return ok;
}

const activeTab = (page) => page.evaluate(() => document.querySelector('.tab.active')?.id || null);

/**
 * Runs the expression `js` in the page (awaiting a returned promise), then lets the timers it set with a delay of up to
 * `timers` ms fire: the browser runs a timer only after every earlier one with an equal or shorter delay.
 */
async function run(page, js, timers = 0) {
    await page.evaluate(`(async () => { await (${js}); if (${timers}) await new Promise(r => setTimeout(r, ${timers})); })()`);
}

function record(all, step, f) {
    for (const k of Object.keys(all)) (f[k] || []).forEach(x => all[k].push(`${step}: ${x}`));
}

/** Read-budget bucket of a step: its page, else its name ("Notifications" -> "notifications"). */
const bucketOf = (s) => s.page || s.name.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

for (const role of A) {
    for (const lang of ['en', 'hi']) {
        test(`${role} (${lang}) opens every page and section without errors`, async ({ page, problems }) => {
            test.setTimeout(360000);
            await login(page, role);
            await page.evaluate((l) => window.app.i18n.setLang(l), lang);
            await page.waitForTimeout(300);
            // Start-up reads: login until the read meter is still. Background start-up work reads too (legacy
            // timestamp scan ~3-4 s, daily anomaly scan 8 s after the app shows): count it as start-up, not
            // as whichever page happens to be open when it runs.
            await page.waitForFunction((ms) => {
                const shown = performance.getEntriesByName('aadhat:app-shown')[0];
                return !!shown && performance.now() - shown.startTime > ms;
            }, START_UP_WORK_MS, { polling: 250, timeout: 60000 });
            let mark = await settledReads(page, { quiet: 1500 });
            expect(mark, 'the app exposes its read meter').not.toBeNull();
            const reads = { startup: mark };
            const all = { bad: [], mixed: [], wrongLang: [], english: [], stuck: [] };
            const side = await page.evaluate(screenFindings, { lang, roots: ['.side-nav'] });
            record(all, 'Side menu', side);

            for (const s of STEPS.filter(x => x.roles.includes(role))) {
                await test.step(s.name, async () => {
                    if (s.route) {
                        await run(page, `window.app.nav.showTab(${JSON.stringify(s.route)})`, NAV_TIMER_MS);
                        const ready = ROUTE_READY[s.route];
                        if (ready) await expect(page.locator(ready).first(), `${s.route} opens on its default sub-tab`).toBeVisible();
                        await expect(page.locator('#loadingOverlay.active')).toHaveCount(0);
                    }
                    if (s.act) await run(page, s.act, s.timers);
                    if (s.wait) await page.waitForTimeout(s.wait);
                    if (s.page) {
                        await expect.poll(() => activeTab(page), { message: `${s.name} shows #${s.page}` }).toBe(s.page);
                    }
                    if (s.expect) await expect(page.locator(s.expect).first(), `${s.name} shows ${s.expect}`).toBeVisible();
                    for (const sel of s.hidden || []) await expect(page.locator(sel), `${s.name} keeps ${sel} hidden`).toBeHidden();
                    if (s.overlay) await expect(page.locator(s.overlay)).toBeVisible();
                    if (!(await settle(page, s.settle))) all.stuck.push(s.name);
                    const roots = s.overlay ? [s.overlay] : ['.tab.active', '#modalOverlay.active', '.app-sheet-backdrop'];
                    record(all, s.name, await page.evaluate(screenFindings, { lang, roots }));
                    if (s.close) {
                        await page.evaluate(s.close);
                        await page.waitForTimeout(250);
                    }
                    // Reads since the previous step belong to this step's page (first open: each test is a fresh session).
                    // Wait for the page's reads to stop first, so a slow page's late reads do not land on the next page.
                    const now = await settledReads(page, { quiet: STEP_READS_QUIET_MS, timeout: STEP_READS_TIMEOUT_MS, poll: 100 });
                    const b = bucketOf(s);
                    reads[b] = (reads[b] || 0) + (now - mark);
                    mark = now;
                });
            }

            if (lang === 'en') {
                for (const [route, tab] of BLOCKED[role] || []) {
                    await test.step(`blocked: ${route}`, async () => {
                        await page.evaluate((r) => window.app.nav.showTab(r), route);
                        await page.waitForTimeout(400);
                        const now = await activeTab(page);
                        expect(now, `${role} may not open ${route}`).not.toBe(tab);
                        expect(['billing', 'day']).toContain(now);
                    });
                }
                if (role === 'owner') {
                    for (const [route, tab] of OLD_IDS) {
                        await test.step(`old id: ${route}`, async () => {
                            await showTab(page, route);
                            expect(await activeTab(page)).toBe(tab);
                        });
                    }
                    await test.step('Rates has no Trends; Insights › Seasons hosts it', async () => {
                        const nav = await page.locator('.nav-menu').first().textContent();
                        expect(nav).toContain('Rates');
                        expect(nav).not.toContain('Rate trends');
                        await expect(page.locator('#items .rates-subtabs')).toHaveCount(0);
                        await expect(page.locator('#insights #rate-trends')).toHaveCount(1);
                        await expect(page.locator('#finance, #reports, #analytics')).toHaveCount(0);
                        await showTab(page, 'reports-traffic');
                        await expect(page.locator('#rtTrafficSection')).toBeVisible();
                        await showTab(page, 'rates');
                        await expect(page.locator('#items')).toBeVisible();
                        await expect(page.locator('#rtTrafficSection')).toBeHidden();
                    });
                }
            }

            if (all.english.length) console.log(`[${role} ${lang}] English text on the Hindi screen (${all.english.length}):\n  ${all.english.join('\n  ')}`);
            test.info().annotations.push({ type: 'reads', description: JSON.stringify({ role, lang, reads }) });
            recordBaselines(role, reads);
            expect.soft(all.english, 'English text on the Hindi screen').toEqual([]);
            expect.soft(overBudget(role, reads), `pages over their read budget${RECORD ? ' (record mode: hard cap only)' : ''}`).toEqual([]);
            expect(all.bad, 'NaN / undefined / null / [object Object] / raw keys').toEqual([]);
            expect(all.mixed, 'text mixing English and Hindi').toEqual([]);
            expect(all.wrongLang, 'Hindi text on the English screen').toEqual([]);
            expect(all.stuck, 'pages still loading after 10 s').toEqual([]);
            expect(problems.pageErrors).toEqual([]);
            expect(problems.consoleErrors).toEqual([]);
        });
    }
}

for (const lang of ['en', 'hi']) {
    test(`logged out (${lang}): login, register, reset, /download and the tenant link page`, async ({ page, problems }) => {
        await page.addInitScript((l) => { localStorage.setItem('aadhat.lang', l); localStorage.setItem('happa.rentLang', l); }, lang);
        const all = { bad: [], mixed: [], wrongLang: [], english: [] };
        await openApp(page);
        record(all, 'Login', await page.evaluate(screenFindings, { lang, roots: ['#authScreen'] }));
        await page.evaluate(() => window.app.auth.showTab('register'));
        await expect(page.locator('#registerForm')).toBeVisible();
        record(all, 'Register', await page.evaluate(screenFindings, { lang, roots: ['#authScreen'] }));
        await page.evaluate(() => window.app.auth.showTab('login'));
        await page.click('#resetToggle');
        await expect(page.locator('#resetForm')).toBeVisible();
        record(all, 'Reset', await page.evaluate(screenFindings, { lang, roots: ['#authScreen'] }));

        const res = await page.goto('/download', { waitUntil: 'load' });
        expect(res.ok()).toBe(true);
        await expect(page.locator('#downloadBtn')).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('lang', lang);
        record(all, '/download', await page.evaluate(screenFindings, { lang, roots: ['body'] }));

        await page.goto(`/r/${TENANT_TOKEN}?d=1&emulator=1`, { waitUntil: 'load' });
        await expect(page.locator('#rh')).toContainText('Tenant E2E');
        await expect(page.locator('#rh')).toContainText('3,000');
        record(all, '/r/<token>', await page.evaluate(screenFindings, { lang, roots: ['body'] }));

        if (all.english.length) console.log(`[logged out ${lang}] English text on the Hindi screen (${all.english.length}):\n  ${all.english.join('\n  ')}`);
        expect.soft(all.english, 'English text on the Hindi screen').toEqual([]);
        expect(all.bad).toEqual([]);
        expect(all.mixed).toEqual([]);
        expect(all.wrongLang).toEqual([]);
        expect(problems.pageErrors).toEqual([]);
        expect(problems.consoleErrors).toEqual([]);
    });
}
