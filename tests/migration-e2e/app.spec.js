/**
 * Migration end-to-end, app part: the app (www/, against the emulators that
 * hold the migrated data, production collection names via ?env=production)
 * signed in as a migrated owner and a migrated member with their ORIGINAL
 * passwords.
 *
 * The Auth emulator keeps imported hashes but checks passwords with its own
 * fake hash, so signInWithPassword is answered here the way production Auth
 * answers it: the password is checked with Firebase's scrypt against the hash
 * and salt the import stored in the emulator, with the hash parameters given to
 * auth:import; only then is the session issued (emulator custom-token sign-in).
 */
const fs = require('fs');
const path = require('path');
const base = require('@playwright/test');
const { verifyFirebaseScrypt, readHashParams } = require('./firebase-scrypt.js');
const APP_VERSION = require('../../package.json').version;

const DIR = process.env.MIGRATION_E2E_DIR || path.join(__dirname, '.out');
const ctx = JSON.parse(fs.readFileSync(path.join(DIR, 'context.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8'));
const logins = JSON.parse(fs.readFileSync(path.join(DIR, 'logins.json'), 'utf8'));
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099'}`;
const FS = `http://${process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8181'}/v1/projects/${ctx.project}/databases/(default)/documents`;
const ADMIN = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const hashParams = ctx.real ? null : readHashParams(fs.readFileSync(ctx.files.hashParams, 'utf8'));

const { test, expect } = base;

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
async function lookup(email) {
    const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${ctx.project}/accounts:lookup`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ email: [email] }) });
    return ((await r.json()).users || [])[0] || null;
}

/** signInWithPassword checked against the imported SCRYPT hash (see the file comment). */
async function answerPasswordSignIn(route) {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const { email, password } = route.request().postDataJSON();
    const user = await lookup(email);
    const ok = user && !user.disabled && user.passwordHash && !String(user.passwordHash).startsWith('fakeHash:')
        && verifyFirebaseScrypt(password, user.salt, user.passwordHash, hashParams);
    if (!ok) {
        return route.fulfill({ status: 400, headers: CORS, contentType: 'application/json',
            body: JSON.stringify({ error: { code: 400, message: 'INVALID_LOGIN_CREDENTIALS', errors: [{ message: 'INVALID_LOGIN_CREDENTIALS', domain: 'global', reason: 'invalid' }] } }) });
    }
    const now = Math.floor(Date.now() / 1000);
    const token = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
        iss: 'migration-e2e@example.com', sub: 'migration-e2e@example.com', aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
        iat: now, exp: now + 3600, uid: user.localId
    })}.`;
    const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=any`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, returnSecureToken: true })
    });
    const j = await r.json();
    if (!j.idToken) throw new Error('emulator custom-token sign-in failed: ' + JSON.stringify(j));
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({
        kind: 'identitytoolkit#VerifyPasswordResponse', localId: user.localId, email: user.email, displayName: user.displayName || '',
        idToken: j.idToken, registered: true, refreshToken: j.refreshToken, expiresIn: j.expiresIn
    }) });
}

const isReady = () => {
    const ac = document.getElementById('appContent');
    const ov = document.getElementById('loadingOverlay');
    const au = document.getElementById('authScreen');
    return !!ac && !ac.classList.contains('hidden') && !(ov && ov.classList.contains('active')) && au && au.style.display === 'none';
};

async function openApp(page) {
    await page.addInitScript((version) => {
        localStorage.setItem('aadhat.lastSeenVersion', version);
        localStorage.setItem('aadhat.updateLastCheck', String(Date.now()));
        localStorage.setItem('aadhat.updateDismissedVersion', '999.0.0');
    }, APP_VERSION);
    if (!ctx.real) await page.route(/accounts:signInWithPassword/, answerPasswordSignIn);
    // Production collection names (no dev_ prefix): the migration wrote them.
    await page.goto('/?emulator=1&env=production', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#loginEmail', { state: 'visible' });
}

async function login(page, who, password = logins[who].password) {
    await openApp(page);
    await page.fill('#loginEmail', logins[who].email);
    await page.fill('#loginPassword', password);
    await page.click('#loginForm button[type=submit]');
}

async function showTab(page, tab) {
    await page.evaluate((t) => window.app.nav.showTab(t), tab);
    await page.waitForFunction((t) => {
        const own = document.getElementById(t);
        const el = own && own.classList.contains('tab') ? own : document.querySelector('.tab.active');
        return el && el.offsetParent !== null;
    }, tab);
    // showTabFromNav draws a page's default sub-tab in a 100 ms timer: let it fire before acting on the page.
    await page.waitForTimeout(250);
}

const problemsOf = (page) => {
    const p = { pageErrors: [], prodRequests: [] };
    page.on('pageerror', e => p.pageErrors.push(String(e.message || e)));
    page.on('request', r => { if (/googleapis\.com/.test(r.url()) && !/127\.0\.0\.1|localhost/.test(r.url())) p.prodRequests.push(r.url()); });
    page.on('dialog', d => d.accept());
    return p;
};


// ---------------------------------------------------------------- expectations in the browser's "today" (IST)
const IST = 19800000;
const istDayNum = (ms) => Math.floor((ms + IST) / 86400000);
const istKey = (ms) => new Date(ms + IST).toISOString().slice(0, 10).replace(/-/g, '');
const ageOf = (time) => (time === null || time === undefined ? null : Math.max(0, istDayNum(Date.now()) - istDayNum(time)));
const ageText = (d) => (d === null ? 'date unknown' : d === 0 ? 'today' : d === 1 ? '1 day' : `${d} days`);
const BUCKETS = [30, 60, 90, Infinity];
const bucketOf = (d) => (d === null ? 3 : BUCKETS.findIndex(max => d <= max));
const amount = (text) => Number(String(text).replace(/[^\d.-]/g, ''));
const r2 = (v) => Math.round(v * 100) / 100;
// Rows without a bill number show the record id (Outstanding: its first 8 characters).
const rowLabel = (b) => b.billNumber || (b.billType === 'retail' ? 'opening-' : `opening-wholesale-${b.id}`);
const multiset = (list) => list.slice().sort();
const retailBills = expected.dues.bills.filter(b => b.billType === 'retail');
const wholesaleBills = expected.dues.bills.filter(b => b.billType === 'wholesale');

test.describe.configure({ mode: 'serial' });

test('a wrong password is refused for a migrated login', async ({ page }) => {
    test.skip(ctx.real, 'real logins: the original passwords are not known');
    await login(page, 'owner', `${logins.owner.password}-wrong`);
    await expect(page.locator('#loginMessage')).toHaveText(/password|credential|invalid/i, { timeout: 30000 });
    await expect(page.locator('#appContent')).toHaveClass(/hidden/);
});

test('migrated owner: original password, carried dues, periods, rates, seasons, next bill number', async ({ page }) => {
    const problems = problemsOf(page);
    await test.step('sign in with the original password', async () => {
        await login(page, 'owner');
        await page.waitForFunction(isReady, null, { timeout: 60000 });
    });

    await test.step('Outstanding: the opening dues with the "Old app" chip and their original ages', async () => {
        await showTab(page, 'due');
        await page.evaluate(() => window.app.outstanding.filterDue('sale', { target: document.querySelector('#due .filter-sale') }));
        await expect(page.locator('#dueList .history-item')).toHaveCount(retailBills.length);
        const buckets = BUCKETS.map(() => ({ total: 0, count: 0 }));
        retailBills.forEach(b => { const k = bucketOf(ageOf(b.time)); buckets[k].total = r2(buckets[k].total + b.due); buckets[k].count++; });
        const panel = await page.evaluate(() => ({
            total: document.querySelector('#dueAging .aging-total')?.textContent,
            buckets: [...document.querySelectorAll('#dueAging .aging-bucket')].map(b => [b.querySelector('.aging-bucket-amount').textContent, b.querySelector('.aging-bucket-count').textContent]),
            rows: [...document.querySelectorAll('#dueList .history-item')].map(el => ({
                no: el.querySelector('.history-header span').textContent.trim().replace(/^#/, ''),
                chip: el.querySelector('.old-app-chip')?.textContent.trim() || '',
                age: el.querySelector('.aging-age')?.textContent.trim() || '',
                due: el.querySelector('.history-header > span:last-child')?.textContent || ''
            }))
        }));
        expect(amount(panel.total)).toBe(expected.dues.retail.total);
        expect(panel.buckets.map(([a, c]) => [amount(a), amount(c)])).toEqual(buckets.map(b => [b.total, b.count]));
        expect(panel.rows.every(r => r.chip === 'Old app'), 'every carried due has the "Old app" chip').toBe(true);
        expect(multiset(panel.rows.map(r => `${r.no}|${r.age}|${amount(r.due)}`)))
            .toEqual(multiset(retailBills.map(b => `${rowLabel(b)}|${ageText(ageOf(b.time))}|${b.due}`)));
    });

    await test.step('Wholesale › Outstanding: the carried wholesale dues', async () => {
        if (!wholesaleBills.length) return; // none in this backup
        await showTab(page, 'wholesale-sales');
        await page.evaluate(() => window.app.wholesaleSales.filterTab('outstanding'));
        const rows = page.locator('#salesOutstandingSection .history-item');
        await expect(rows).toHaveCount(wholesaleBills.length);
        const got = await rows.evaluateAll(els => els.map(el => [el.querySelector('.history-header span span').textContent.trim().replace(/^#/, ''), el.querySelector('.history-header > span:last-child').textContent]));
        expect(multiset(got.map(([no, due]) => `${no}|${amount(due)}`))).toEqual(multiset(wholesaleBills.map(b => `${rowLabel(b)}|${Math.round(b.due)}`)));
    });

    await test.step('History hides them by default', async () => {
        await showTab(page, 'history');
        await page.evaluate(() => window.app.history.filterHistory('sale'));
        const toggle = page.locator('#history .opening-toggle-chip');
        await expect(toggle).toHaveText(`Show dues carried from old app (${retailBills.length})`);
        await expect(page.locator('#historyList .old-app-chip')).toHaveCount(0);
        await toggle.click();
        await expect(page.locator('#historyList .old-app-chip')).toHaveCount(retailBills.length);
        await page.locator('#history .opening-toggle-chip').click();
        await expect(page.locator('#historyList .old-app-chip')).toHaveCount(0);
    });

    await test.step('Today shows no carried due as today\'s activity', async () => {
        await showTab(page, 'day');
        await page.evaluate(() => window.app.day.showSubTab('today'));
        const today = page.locator('#dayTodayContent');
        await expect(today).toContainText('No sales today');
        await expect(today).toContainText('No purchases today');
        const text = await today.innerText();
        expected.dues.bills.filter(b => b.billNumber).forEach(b => expect(text, 'no carried bill on Today').not.toContain(b.billNumber));
        expect(text).not.toContain('Old app');
    });

    await test.step('Money: periods leave them out; Worth counts them as receivable', async () => {
        await showTab(page, 'money-profit');
        await expect(page.locator('#moneySales')).toHaveText(/^₹\s?0$/);
        await expect(page.locator('#moneySalesSplit')).toContainText('0 bills');
        await expect(page.locator('#moneyProfitValue')).toHaveText(/^₹\s?0$/);
        await showTab(page, 'money-worth');
        const receivable = page.locator('#moneyWorthTerms [data-metric-ref="O4"]');
        await expect(receivable).not.toHaveText('—');
        expect(amount(await receivable.textContent())).toBe(Math.round(expected.dues.receivable));
    });

    await test.step('Insights: no bills in this month (carried dues dated this month are not sales)', async () => {
        await showTab(page, 'insights-parties');
        const pane = page.locator('#insights [data-insights-pane="parties"]');
        await expect(pane).toContainText('No bills in this period.');
    });

    await test.step('Statements: the month has no sales; the party ledger opens with the old app balance', async () => {
        await showTab(page, 'statements-month');
        const list = page.locator('#statements');
        await expect(list).toContainText('Month statement');
        await expect(list.locator('[data-metric-export="M1"]')).toHaveText(/^₹\s?0$/);
        const parties = {};
        expected.dues.bills.forEach(b => { if (b.partyKey) parties[b.partyKey] = r2((parties[b.partyKey] || 0) + b.due); });
        const [key, total] = Object.entries(parties).sort((a, b) => b[1] - a[1])[0];
        await showTab(page, 'statements-party');
        await page.evaluate((k) => window.app.statements.openParty(k, 'customer'), key);
        await expect(list).toContainText('Old app balance');
        expect(amount(await list.locator('.st-balance [data-metric-export="O4"]').textContent()), 'balance = the party\'s carried dues').toBe(Math.round(total));
        await expect(list.locator('.st-balance')).toContainText('Matches Outstanding');
    });

    await test.step('Rates shows the items', async () => {
        await showTab(page, 'rates');
        const text = await page.locator('#items').innerText();
        expected.items.forEach(i => expect(text).toContain(i.name));
    });

    await test.step('Insights › Seasons: the carried weekly patterns, no Rebuild', async () => {
        if (!expected.hasRateStats) return; // no items, no rate patterns
        await showTab(page, 'insights-trends');
        await expect(page.locator('#rtStatus')).toContainText('History carried from the old app');
        await expect(page.locator('#insights button', { hasText: 'Rebuild' })).toHaveCount(0);
        await expect(page.locator('#rtPeriod')).toHaveValue('week');
        await showTab(page, 'insights-traffic');
        const weekly = page.locator('#rtWeekly');
        const options = await page.locator('#rtTrafficItem option').evaluateAll(os => os.map(o => o.value).filter(Boolean));
        let weeksWithKg = 0;
        for (const v of options) {
            await page.selectOption('#rtTrafficItem', v);
            await expect(weekly.locator('table, .rt-empty, .rt-warn').first()).toBeVisible();
            weeksWithKg = await weekly.locator('tbody tr').filter({ has: page.locator('strong') }).count();
            if (weeksWithKg) break;
        }
        expect(weeksWithKg, 'weeks with kg in Week by week').toBeGreaterThan(0);
    });

    await test.step('a new bill continues the bill-number sequence', async () => {
        // A backup from an earlier day (a real one): bill as on the cutover day, right after the backup.
        if (istKey(Date.now()) !== expected.cutoffDay) await page.clock.setFixedTime(expected.cutoff + 1000);
        const day = expected.cutoffDay;
        const last = expected.counters[`S${day}`] || 0;
        const want = `S${day}-${String(last + 1).padStart(3, '0')}`;
        const customer = `E2E new bill ${Date.now()}`;
        await showTab(page, 'billing');
        await page.click('#saleModeBtn');
        const value = await page.evaluate(() => [...document.querySelectorAll('#saleItem option')].find(o => o.value)?.value);
        await page.selectOption('#saleItem', value);
        await page.fill('#saleRate', '40');
        await page.fill('#saleWeight', '2');
        await page.click('#saleSection .quick-add-btn-inline');
        await page.click('#saleSection .add-to-bill-btn');
        await page.fill('#saleCustomerName', customer);
        await page.check('#saleCashCheckbox');
        await page.click('#saveSaleBtn');
        await page.waitForTimeout(300);
        if (await page.evaluate(() => document.getElementById('modalOverlay')?.classList.contains('active'))) await page.click('#modalConfirm');
        await expect(page.locator('#toast')).toHaveText(/Sale completed successfully/, { timeout: 20000 });
        const r = await fetch(`${FS}:runQuery`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ structuredQuery: {
            from: [{ collectionId: 'retailSales' }], where: { fieldFilter: { field: { fieldPath: 'customerName' }, op: 'EQUAL', value: { stringValue: customer } } } } }) });
        const docs = (await r.json()).filter(x => x.document).map(x => x.document.fields);
        expect(docs).toHaveLength(1);
        expect(docs[0].billNumber.stringValue).toBe(want);
    });

    expect(problems.pageErrors).toEqual([]);
    expect(problems.prodRequests, 'no request may reach production Firebase').toEqual([]);
});

test('migrated member: original password, role gating holds', async ({ page }) => {
    test.skip(!logins.member, 'no member login in the backup');
    const problems = problemsOf(page);
    await login(page, 'member');
    await page.waitForFunction(isReady, null, { timeout: 60000 });
    const role = expected.users[logins.member.uid].role;
    const hidden = await page.evaluate(() => {
        const out = {};
        document.querySelectorAll('.nav-menu a[onclick]').forEach(a => {
            const tab = a.getAttribute('onclick').match(/showTab\('([^']+)'/)?.[1];
            if (tab) out[tab] = a.style.display === 'none';
        });
        return out;
    });
    if (role === 'staff') {
        expect(hidden).toMatchObject({ money: true, insights: true, statements: true, admin: true, diagnostics: true, billing: false, due: false });
        await page.evaluate(() => window.app.nav.showTab('money'));
        await page.waitForTimeout(500);
        expect(await page.evaluate(() => document.querySelector('.tab.active')?.id)).not.toBe('money');
    } else {
        expect(hidden).toMatchObject({ admin: true, billing: false, due: false });
    }
    await showTab(page, 'due');
    await page.evaluate(() => window.app.outstanding.filterDue('sale', { target: document.querySelector('#due .filter-sale') }));
    await expect(page.locator('#dueAging .aging-total')).toHaveText(new RegExp(`${Math.round(expected.dues.retail.total).toLocaleString('en-IN')}`));
    expect(problems.pageErrors).toEqual([]);
    expect(problems.prodRequests).toEqual([]);
});

test('a migrated login still pending approval stays out', async ({ page }) => {
    test.skip(ctx.real || !logins.pending, 'synthetic only');
    await login(page, 'pending');
    await expect(page.locator('#loginMessage')).toHaveText(/pending approval/, { timeout: 30000 });
    await expect(page.locator('#appContent')).toHaveClass(/hidden/);
});
