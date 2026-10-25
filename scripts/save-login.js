/**
 * One-time login helper. Opens a real Chromium window, you log in by hand,
 * and the script AUTO-DETECTS successful login (no Enter press needed),
 * then saves your auth state to scripts/auth-state.json so future
 * inspect-app.js runs are fully headless.
 *
 * Run with:
 *   node scripts/save-login.js
 *   LOGIN_TIMEOUT_MS=600000 node scripts/save-login.js   # custom timeout
 */
const { chromium } = require('playwright');
const path = require('path');

const { loadConfig, derive } = require('./happa-config.js');

const APP_URL = process.env.APP_URL || derive(loadConfig()).siteUrl;
const STATE_PATH = path.resolve(__dirname, 'auth-state.json');
const LOGIN_TIMEOUT_MS = parseInt(process.env.LOGIN_TIMEOUT_MS || '300000', 10); // 5 min default
const POLL_MS = 1000;

function fmt(ms) {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function isLoggedIn(page) {
    return page.evaluate(() => {
        // Strategy 1: Firebase v8/v9 stashes auth in localStorage under
        // "firebase:authUser:<apiKey>:<appName>".
        try {
            const keys = Object.keys(localStorage || {});
            if (keys.some((k) => /^firebase:authUser:/.test(k) && localStorage.getItem(k))) {
                return true;
            }
        } catch (_) {}

        // Strategy 2: AppState (set after initial load) shows we got past auth gating.
        try {
            if (window.AppState && Array.isArray(window.AppState.items) && window.AppState.items.length > 0) {
                return true;
            }
        } catch (_) {}

        // Strategy 3: firebase.auth().currentUser (v8 namespaced API).
        try {
            if (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) {
                return true;
            }
        } catch (_) {}

        return false;
    });
}

async function main() {
    console.log(`[save-login] opening ${APP_URL}`);
    console.log(`[save-login] login timeout: ${fmt(LOGIN_TIMEOUT_MS)}`);

    const browser = await chromium.launch({ headless: false });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

    console.log('');
    console.log('[save-login] ▶ A Chrome window is now open. Sign in there.');
    console.log('[save-login] ▶ This script will auto-detect login and save the session.');
    console.log('');

    const start = Date.now();
    let detected = false;
    let lastReport = 0;

    while (Date.now() - start < LOGIN_TIMEOUT_MS) {
        try {
            if (await isLoggedIn(page)) {
                detected = true;
                break;
            }
        } catch (_) {
            // page may be navigating; ignore and retry.
        }

        // Heartbeat every 15s so the user knows we're still alive.
        const elapsed = Date.now() - start;
        if (elapsed - lastReport >= 15000) {
            console.log(`[save-login] still waiting for login… (${fmt(elapsed)} elapsed)`);
            lastReport = elapsed;
        }

        await page.waitForTimeout(POLL_MS);
    }

    if (!detected) {
        console.error(`[save-login] timed out after ${fmt(LOGIN_TIMEOUT_MS)} — did not detect login.`);
        await browser.close();
        process.exit(2);
    }

    console.log('[save-login] login detected — letting data settle for 3s…');
    await page.waitForTimeout(3000);

    await ctx.storageState({ path: STATE_PATH });
    console.log(`[save-login] saved auth state to ${STATE_PATH}`);

    await browser.close();
}

main().catch((err) => {
    console.error('[save-login] failed:', err);
    process.exit(1);
});
