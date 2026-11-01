/**
 * Shared fixture: every page records page errors, console errors and any
 * request to production Firebase (none are allowed in emulator mode), and
 * exposes small helpers for logging in and driving the SPA.
 */
const base = require('@playwright/test');
const { USERS, PASSWORD } = require('./emulator');
const APP_VERSION = require('../../../package.json').version;

const test = base.test.extend({
    problems: async ({ page }, use) => {
        const problems = { pageErrors: [], consoleErrors: [], prodRequests: [], cspReports: [] };
        page.on('pageerror', e => problems.pageErrors.push(String(e.message || e)));
        page.on('console', m => {
            // The service worker is blocked in tests; its registration failure is expected.
            if (m.type() === 'error' && !/service ?worker|\[SW\]/i.test(m.text())) problems.consoleErrors.push(m.text());
            // The static server sends Hosting's report-only CSP (#89); Chrome logs each report (as info).
            if (/violates the following Content Security Policy directive/.test(m.text())) problems.cspReports.push(m.text());
        });
        page.on('request', r => {
            if (/googleapis\.com/.test(r.url()) && !/127\.0\.0\.1|localhost/.test(r.url())) problems.prodRequests.push(r.url());
        });
        page.on('dialog', d => d.accept());
        await use(problems);
        base.expect(problems.prodRequests, 'no request may reach production Firebase').toEqual([]);
        base.expect(problems.cspReports, 'the report-only CSP in firebase.json must not report anything (#89)').toEqual([]);
    }
});

const isReady = () => {
    const ac = document.getElementById('appContent');
    const ov = document.getElementById('loadingOverlay');
    const au = document.getElementById('authScreen');
    return !!ac && !ac.classList.contains('hidden') && !(ov && ov.classList.contains('active')) && au && au.style.display === 'none';
};

async function openApp(page) {
    // Keep the one-time "What's new" sheet and the update banner out of the way.
    await page.addInitScript((version) => {
        localStorage.setItem('aadhat.lastSeenVersion', version);
        localStorage.setItem('aadhat.updateLastCheck', String(Date.now()));
        localStorage.setItem('aadhat.updateDismissedVersion', '999.0.0');
    }, APP_VERSION);
    await page.goto('/?emulator=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#loginEmail', { state: 'visible' });
}

async function login(page, role = 'owner') {
    await openApp(page);
    await page.fill('#loginEmail', USERS[role].email);
    await page.fill('#loginPassword', PASSWORD);
    await page.click('#loginForm button[type=submit]');
    if (role !== 'pending') await page.waitForFunction(isReady, null, { timeout: 60000 });
}

async function showTab(page, tab) {
    await page.evaluate((t) => window.app.nav.showTab(t), tab);
    await page.waitForFunction((t) => {
        // A page loaded on first visit (#66) is still being put in
        if (document.documentElement.dataset.pageLoading) return false;
        // Route ids (rates, reports-trends, ...) have no page of their own: use the page they opened.
        // Some route ids name a hidden inner element (#rate-trends lives in Insights), so only a .tab counts.
        const own = document.getElementById(t);
        const el = own && own.classList.contains('tab') ? own : document.querySelector('.tab.active');
        return el && el.offsetParent !== null;
    }, tab);
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

/** Resolves when #toast shows text matching re. */
async function expectToast(page, re, timeout = 20000) {
    await base.expect(page.locator('#toast')).toHaveText(re, { timeout });
}

/** Accept the app's own confirm modal if it is open. */
async function confirmModalIfOpen(page) {
    const open = await page.evaluate(() => document.getElementById('modalOverlay')?.classList.contains('active'));
    if (open) await page.click('#modalConfirm');
}

module.exports = { test, expect: base.expect, login, openApp, showTab, settle, expectToast, confirmModalIfOpen };
