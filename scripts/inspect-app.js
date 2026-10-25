/**
 * Headless inspector. Loads the deployed app using the saved auth state,
 * captures the BUILD_ID banner from the console, then runs window.debugStock
 * for one or more item names and prints what calculateStock() returns plus
 * the running tail of the timeline.
 *
 * Run with:
 *   node scripts/inspect-app.js                 # defaults to Gehu
 *   node scripts/inspect-app.js Gehu "Gehu dagi"
 *   APP_URL=https://staging.example node scripts/inspect-app.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const { loadConfig, derive } = require('./happa-config.js');

const APP_URL = process.env.APP_URL || derive(loadConfig()).siteUrl;
const STATE_PATH = path.resolve(__dirname, 'auth-state.json');
const ITEMS = process.argv.slice(2).filter(Boolean);
if (!ITEMS.length) ITEMS.push('Gehu');

function colorize(s) {
    return s
        .replace(/\u001b\[[0-9;]*m/g, '')
        .replace(/%c/g, '')
        .trim();
}

async function main() {
    if (!fs.existsSync(STATE_PATH)) {
        console.error(`[inspect] no auth state at ${STATE_PATH}.`);
        console.error('[inspect] continuing anonymously — BUILD_ID will be reported but live data will not be available.');
        console.error('[inspect] for full data inspection run:   node scripts/save-login.js   first.');
    }

    const browser = await chromium.launch({ headless: true });
    const ctxOpts = fs.existsSync(STATE_PATH) ? { storageState: STATE_PATH } : {};
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();

    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    let buildIdSeen = null;
    const earlyLogs = [];
    page.on('console', (msg) => {
        const text = colorize(msg.text());
        if (earlyLogs.length < 80) earlyLogs.push(`[${msg.type()}] ${text}`);
        const m = text.match(/\[Aadhat\]\s*BUILD\s+([\w.-]+)/i);
        if (m && !buildIdSeen) buildIdSeen = m[1];
    });

    console.log(`[inspect] navigating to ${APP_URL}`);
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

    // Wait a bit for the SPA + Firebase data load.
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Try to read BUILD from the global if console capture missed it.
    const buildFromWindow = await page.evaluate(() => window.__AADHAT_BUILD__ || null);

    console.log('');
    console.log('=== Build info ===');
    console.log('BUILD from console log:', buildIdSeen || '(not seen)');
    console.log('BUILD from window.__AADHAT_BUILD__:', buildFromWindow || '(undefined)');
    if (!buildIdSeen && !buildFromWindow) {
        console.log('!!! No BUILD id — browser is loading STALE main.js (cached SW).');
    }

    if (pageErrors.length) {
        console.log('');
        console.log('=== Page errors ===');
        pageErrors.forEach((e) => console.log('  ', e));
    }

    // Wait until calculateStock / debugStock are available.
    const ready = await page.waitForFunction(
        () => typeof window.calculateStock === 'function' || typeof window.debugStock === 'function',
        { timeout: 20000 }
    ).then(() => true).catch(() => false);

    if (!ready) {
        console.log('');
        console.log('!!! window.calculateStock / debugStock never became available.');
        console.log('=== First ~80 console messages ===');
        earlyLogs.forEach((l) => console.log('  ', l));
        await browser.close();
        process.exit(3);
    }

    for (const name of ITEMS) {
        console.log('');
        console.log('================================================');
        console.log(`Inspecting item: "${name}"`);
        console.log('================================================');

        const summary = await page.evaluate(async (itemName) => {
            const out = { name: itemName, calculated: null, matchedKey: null, errors: [] };
            try {
                if (typeof window.calculateStock === 'function') {
                    const all = await window.calculateStock();
                    // calculateStock returns an array of { itemId, itemName, quantity, rate, ... }
                    if (Array.isArray(all)) {
                        out.calculated = all.filter((row) =>
                            (row.itemName || '').toLowerCase().includes(itemName.toLowerCase())
                        );
                    } else if (all && typeof all === 'object') {
                        // Some implementations return a map keyed by item id/name.
                        out.calculated = Object.entries(all)
                            .filter(([k, v]) => (k + ' ' + (v?.itemName || '')).toLowerCase().includes(itemName.toLowerCase()))
                            .map(([k, v]) => ({ key: k, ...v }));
                    } else {
                        out.calculated = all;
                    }
                }
            } catch (e) {
                out.errors.push(`calculateStock: ${String(e)}`);
            }
            try {
                const items = (window.AppState?.items || []).filter((i) =>
                    (i.name || '').toLowerCase().includes(itemName.toLowerCase())
                );
                out.matchedCatalogueItems = items.map((i) => ({
                    id: i.id,
                    name: i.name,
                    unit: i.unit,
                }));
            } catch (e) {
                out.errors.push(`AppState read: ${String(e)}`);
            }
            return out;
        }, name);

        console.log('calculateStock():', JSON.stringify(summary.calculated, null, 2));
        console.log('Catalogue rows matching name:', JSON.stringify(summary.matchedCatalogueItems, null, 2));
        if (summary.errors.length) console.log('Errors:', summary.errors);

        // Capture debugStock console output by hooking before invoking.
        const debugLogs = [];
        const onMsg = (msg) => debugLogs.push(`[${msg.type()}] ${colorize(msg.text())}`);
        page.on('console', onMsg);

        const ranDebug = await page.evaluate((itemName) => {
            if (typeof window.debugStock === 'function') {
                window.debugStock(itemName);
                return true;
            }
            return false;
        }, name);

        await page.waitForTimeout(1500);
        page.off('console', onMsg);

        if (!ranDebug) {
            console.log('(no window.debugStock available)');
        } else {
            console.log('--- debugStock output (last 60 lines) ---');
            debugLogs.slice(-60).forEach((l) => console.log('  ', l));
        }
    }

    await browser.close();
    console.log('');
    console.log('[inspect] done.');
}

main().catch((err) => {
    console.error('[inspect] failed:', err);
    process.exit(1);
});
