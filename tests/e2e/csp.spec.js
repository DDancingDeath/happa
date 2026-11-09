/**
 * The app site's CSP is enforced (#89). The static server sends the '**' headers from
 * firebase.json (tests/e2e/static-server.js), so these runs see the same policy as Hosting.
 *  - the policy really blocks: an injected inline <script> and an on*= attribute don't run;
 *  - no `securitypolicyviolation` event fires while the app loads, signs in and opens
 *    the main pages (the fixture also fails any spec on a CSP console message).
 */
const { test, expect, login, showTab } = require('./support/app');
const { TENANT_TOKEN } = require('./support/emulator');
const { seed } = require('./support/seed');

/** Records every violation in the page, from the first byte of each document. */
async function watchViolations(page) {
    await page.addInitScript(() => {
        window.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', (e) => {
            window.__cspViolations.push(`${e.effectiveDirective} blocked ${e.blockedURI || '(inline)'} in ${e.sourceFile || e.documentURI}:${e.lineNumber}`);
        });
    });
}
const violations = (page) => page.evaluate(() => window.__cspViolations);

const MAIN_PAGES = ['day', 'billing', 'wholesale-sales', 'expenses', 'rates', 'history', 'stock', 'due', 'money-profit',
    'insights-actions', 'statements', 'ask', 'anomalies', 'health', 'admin', 'diagnostics', 'settings-common'];

test('the enforcing CSP blocks inline scripts and inline handlers', async ({ page }) => {
    const res = await page.goto('/download', { waitUntil: 'load' });
    const headers = res.headers();
    expect(headers['content-security-policy-report-only']).toBeUndefined();
    const scriptSrc = headers['content-security-policy'].split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src '));
    // Origins, or a path under one (App Check's reCAPTCHA: https://www.google.com/recaptcha/)
    expect(scriptSrc).toMatch(/^script-src 'self'( 'sha256-[A-Za-z0-9+/]+=*')*( https:\/\/[a-z0-9.-]+(\/[a-z0-9._-]+)*\/?)+$/);

    const blocked = await page.evaluate(() => new Promise((resolve) => {
        const seen = [];
        document.addEventListener('securitypolicyviolation', (e) => {
            seen.push(e.effectiveDirective);
            if (seen.length === 2) resolve({ seen, ran: [window.__inlineRan, window.__attrRan] });
        });
        const s = document.createElement('script');
        s.textContent = 'window.__inlineRan = true';
        document.head.appendChild(s);
        const b = document.createElement('button');
        b.setAttribute('onclick', 'window.__attrRan = true');
        document.body.appendChild(b);
        b.click();
    }));
    expect(blocked.seen.sort()).toEqual(['script-src-attr', 'script-src-elem']);
    expect(blocked.ran).toEqual([undefined, undefined]);
});

test('no CSP violation on load, sign-in and the main pages', async ({ page, problems }) => {
    test.setTimeout(240000);
    await seed();
    await watchViolations(page);
    await login(page, 'owner');
    expect(await violations(page), 'app load and sign-in').toEqual([]);
    for (const route of MAIN_PAGES) {
        await showTab(page, route);
        expect(await violations(page), `after opening ${route}`).toEqual([]);
    }
    await page.evaluate(() => window.app.rentals.open('rent'));
    await expect(page.locator('#rentals')).toBeVisible();
    expect(await violations(page), 'after opening Rentals').toEqual([]);

    await page.goto('/download', { waitUntil: 'load' });
    await expect(page.locator('#latestVersion')).not.toHaveText('—');
    expect(await violations(page), '/download').toEqual([]);

    await page.goto(`/r/${TENANT_TOKEN}?d=1&emulator=1`, { waitUntil: 'load' });
    await expect(page.locator('#rh')).toContainText('Tenant E2E');
    expect(await violations(page), '/r/<token>').toEqual([]);

    // The owner's Windows printer test page (#133): its module script and imports run under the policy.
    await page.goto('/spike/serial.html', { waitUntil: 'load' });
    await expect(page.locator('#support')).not.toBeEmpty();
    expect(await violations(page), '/spike/serial.html').toEqual([]);

    expect(problems.pageErrors).toEqual([]);
    expect(problems.consoleErrors).toEqual([]);
});
