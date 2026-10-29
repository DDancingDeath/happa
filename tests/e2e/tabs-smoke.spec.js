/**
 * Every-page smoke (#127): owner, manager and member open every page and
 * section they may see, in English and Hindi, on phone and desktop (the two
 * Playwright projects). Each screen must show no page or console error, no
 * NaN / undefined / null / [object Object] / Invalid Date / raw i18n key, and
 * no text that mixes English and Hindi (no Hindi on an English screen). Pages a
 * role may not open must redirect. Logged out: login, register, reset,
 * /download and the tenant link page /r/<token>.
 */
const { test, expect, login, openApp, showTab } = require('./support/app');
const { TENANT_TOKEN } = require('./support/emulator');

const A = ['owner', 'manager', 'staff'];
const OM = ['owner', 'manager'];
const O = ['owner'];

// name, route (nav.showTab), page (.tab id that must show), act (JS run after the page opened), roles, expect (selector that must be visible)
const STEPS = [
    { name: 'Today', route: 'day', page: 'day', act: "window.app.day.showSubTab('today')", roles: A },
    { name: 'Today › Cash', route: 'day', page: 'day', act: "window.app.day.showSubTab('cash')", roles: A },
    { name: 'Billing › Purchase', route: 'billing', page: 'billing', roles: A },
    { name: 'Billing › Retail sale', route: 'billing', page: 'billing', act: "window.app.billing.switchMode('sale', { currentTarget: document.getElementById('saleModeBtn') })", roles: A, expect: '#saleSection' },
    { name: 'Wholesale › Sale', route: 'wholesale-sales', page: 'wholesale-sales', roles: OM },
    { name: 'Wholesale › History', route: 'wholesale-history', page: 'wholesale-sales', roles: OM },
    { name: 'Wholesale › Outstanding', route: 'wholesale-sales', page: 'wholesale-sales', act: "window.app.wholesaleSales.filterTab('outstanding')", roles: OM },
    { name: 'Expenses › Business', route: 'expenses', page: 'expenses', roles: A },
    { name: 'Expenses › Personal', route: 'expenses', page: 'expenses', act: "window.app.expenses.filterExpenseTab('personal')", roles: A },
    { name: 'Rates', route: 'rates', page: 'items', roles: A },
    { name: 'History › Purchase', route: 'history', page: 'history', act: "window.app.history.filterHistory('purchase')", roles: A },
    { name: 'History › Sale', route: 'history', page: 'history', act: "window.app.history.filterHistory('sale')", roles: A },
    { name: 'Stocks › Current', route: 'stock', page: 'stock', roles: A },
    { name: 'Stocks › Not selling', route: 'stock', page: 'stock', act: "window.app.stock.filterTab('dead')", roles: A },
    { name: 'Stocks › Adjustment', route: 'stock', page: 'stock', act: "window.app.stock.filterTab('adjustment')", roles: A },
    { name: 'Stocks › Opening stock', route: null, page: 'stock', act: 'window.app.settings.openOpeningStock()', roles: OM, wait: 600 },
    { name: 'Outstanding › Purchase', route: 'due', page: 'due', roles: A },
    { name: 'Outstanding › Sale', route: 'due', page: 'due', act: "window.app.outstanding.filterDue('sale', { target: document.querySelector('#due .filter-sale') })", roles: A },
    { name: 'Money › Profit', route: 'money-profit', page: 'money', roles: OM },
    { name: 'Money › Cash', route: 'money-cash', page: 'money', roles: OM },
    { name: 'Money › Spending', route: 'money-spending', page: 'money', roles: OM },
    { name: 'Money › Worth', route: 'money-worth', page: 'money', roles: OM },
    { name: 'Insights › Actions', route: 'insights-actions', page: 'insights', roles: OM },
    { name: 'Insights › Items', route: 'insights-items', page: 'insights', roles: OM },
    { name: 'Insights › Parties', route: 'insights-parties', page: 'insights', roles: OM },
    { name: 'Insights › Seasons', route: 'insights-seasons', page: 'insights', roles: OM },
    { name: 'Insights › Seasons › Trends', route: 'insights-trends', page: 'insights', roles: OM, expect: '#insights #rtRatesSection' },
    { name: 'Insights › Seasons › Product traffic', route: 'insights-traffic', page: 'insights', roles: OM, expect: '#insights #rtTrafficSection' },
    { name: 'Statements', route: 'statements', page: 'statements', roles: OM },
    { name: 'Statements › Day', route: 'statements-day', page: 'statements', roles: OM },
    { name: 'Statements › Month', route: 'statements-month', page: 'statements', roles: OM },
    { name: 'Statements › Party', route: 'statements-party', page: 'statements', roles: OM },
    { name: 'Statements › Item', route: 'statements-item', page: 'statements', roles: OM },
    { name: 'Statements › CSV', route: 'statements-csv', page: 'statements', roles: OM },
    { name: 'Anomalies › List', route: 'anomalies', page: 'anomalies', roles: OM },
    { name: 'Anomalies › Patterns', route: 'anomalies', page: 'anomalies', act: "window.app.anomalies.showView('patterns')", roles: OM },
    { name: 'App health', route: 'health', page: 'health', roles: OM },
    { name: 'Admin › Users', route: 'admin', page: 'admin', act: "window.app.admin.showTab('users')", roles: O },
    { name: 'Admin › Data', route: 'admin', page: 'admin', act: "window.app.admin.showTab('data')", roles: O },
    { name: 'Diagnostics › Number checks', route: 'diagnostics', page: 'diagnostics', act: "window.app.diagnostics.showTab('numbers')", roles: OM },
    { name: 'Diagnostics › Errors', route: 'diagnostics', page: 'diagnostics', act: "window.app.diagnostics.showTab('errors')", roles: O },
    { name: 'Diagnostics › Audit', route: 'diagnostics', page: 'diagnostics', act: "window.app.diagnostics.showTab('audit')", roles: O },
    { name: 'Settings › Common', route: 'settings-common', page: 'settings', roles: A },
    { name: 'Settings › Aadhat', route: 'settings-shop', page: 'settings', roles: OM, expect: '#settingsShop' },
    { name: 'Settings › Rentals', route: 'settings-rentals', page: 'settings', roles: OM, expect: '#settingsRentals' },
    { name: 'Settings › Roles & access', route: 'settings-roles', page: 'settings', roles: O, expect: '#roleAccessCard' },
    { name: 'Rentals › Rent (property-wise)', route: null, page: 'rentals', act: "window.app.rentals.open('rent').then(() => window.app.rentals.setView('properties'))", roles: A, wait: 800 },
    { name: 'Rentals › Rent (unit-wise)', route: null, page: 'rentals', act: "window.app.rentals.setView('units')", roles: A },
    { name: 'Rentals › Tenants', route: null, page: 'rentals', act: "window.app.rentals.page('tenants')", roles: A },
    { name: 'Rentals › Properties', route: null, page: 'rentals', act: "window.app.rentals.page('properties')", roles: A },
    { name: 'Rentals › Access', route: null, page: 'settings', act: "window.app.rentals.page('access')", roles: O, expect: '#roleAccessCard' },
    { name: 'Back to Aadhat', route: null, page: null, act: "window.app.business.set('shop')", roles: A, wait: 600 },
    { name: 'Notifications', route: null, page: null, act: 'window.app.notifications.open()', roles: A, overlay: '#notifPanel', close: 'window.app.notifications.close()' },
    { name: "What's new", route: null, page: null, act: 'window.app.updates.showWhatsNew()', roles: A, overlay: '#whatsNewSheet', close: "document.querySelector('#whatsNewSheet .app-sheet-close')?.click()" }
];

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
    // Test data and words that are the same in both languages.
    const DATA = /happa|\bE2E\b|\b(phone|desktop)\b|PEDIT-\w+|\b(Before|After) Edit\b|Gali \d+|Ram \d+|\bG\d+\b|Tenant E2E|E2E (Shop|Bhawan)|Manager One|Staff One|Pending Person|\bOwner\b|Rice|Wheat|Mustard|चावल|गेहूं|सरसों|[\w.+-]+@[\w.-]+|https?:\/\/\S+|\b[\w-]+\.(web\.app|local)\b|\bkg\b|\bKG\b|WhatsApp|\bUPI\b|\bPDF\b|\bCSV\b|Excel|\bOK\b|\bID\b|\bGST\b|Bluetooth|Android|\bAPK\b|Google|Chrome|Edge|Firebase|DEVELOPMENT/g;
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
            look(n.textContent, '');
        }
        root.querySelectorAll('input[placeholder],textarea[placeholder]').forEach(el => { if (vis(el)) look(el.placeholder, 'placeholder: '); });
        root.querySelectorAll('select').forEach(el => { if (vis(el)) [...el.options].slice(0, 20).forEach(o => look(o.text, 'option: ')); });
    }
    return out;
}

/** Waits until the screen stops changing (no "Loading…", same text twice); returns false if it never did. */
async function settle(page) {
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
    }, null, { polling: 250, timeout: 10000 }).then(() => true, () => false);
    await page.evaluate(() => { window.__smokeSettle = null; });
    return ok;
}

const activeTab = (page) => page.evaluate(() => document.querySelector('.tab.active')?.id || null);

function record(all, step, f) {
    for (const k of Object.keys(all)) (f[k] || []).forEach(x => all[k].push(`${step}: ${x}`));
}

for (const role of A) {
    for (const lang of ['en', 'hi']) {
        test(`${role} (${lang}) opens every page and section without errors`, async ({ page, problems }) => {
            test.setTimeout(360000);
            await login(page, role);
            await page.evaluate((l) => window.app.i18n.setLang(l), lang);
            await page.waitForTimeout(300);
            const all = { bad: [], mixed: [], wrongLang: [], english: [], stuck: [] };
            const side = await page.evaluate(screenFindings, { lang, roots: ['.side-nav'] });
            record(all, 'Side menu', side);

            for (const s of STEPS.filter(x => x.roles.includes(role))) {
                await test.step(s.name, async () => {
                    if (s.route) {
                        await showTab(page, s.route);
                        await page.waitForTimeout(250); // the page's own first render (setTimeout 100 in showTabFromNav)
                    }
                    if (s.act) await page.evaluate(s.act);
                    await page.waitForTimeout(s.wait || 250);
                    if (s.page) {
                        await expect.poll(() => activeTab(page), { message: `${s.name} shows #${s.page}` }).toBe(s.page);
                    }
                    if (s.expect) await expect(page.locator(s.expect).first()).toBeVisible();
                    if (s.overlay) await expect(page.locator(s.overlay)).toBeVisible();
                    if (!(await settle(page))) all.stuck.push(s.name);
                    const roots = s.overlay ? [s.overlay] : ['.tab.active', '#modalOverlay.active', '.app-sheet-backdrop'];
                    record(all, s.name, await page.evaluate(screenFindings, { lang, roots }));
                    if (s.close) {
                        await page.evaluate(s.close);
                        await page.waitForTimeout(250);
                    }
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
            if (all.stuck.length) console.log(`[${role} ${lang}] still loading after 10 s: ${all.stuck.join(', ')}`);
            expect(all.bad, 'NaN / undefined / null / [object Object] / raw keys').toEqual([]);
            expect(all.mixed, 'text mixing English and Hindi').toEqual([]);
            expect(all.wrongLang, 'Hindi text on the English screen').toEqual([]);
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
        expect(all.bad).toEqual([]);
        expect(all.mixed).toEqual([]);
        expect(all.wrongLang).toEqual([]);
        expect(problems.pageErrors).toEqual([]);
        expect(problems.consoleErrors).toEqual([]);
    });
}
