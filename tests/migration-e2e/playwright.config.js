// @ts-check
/**
 * Playwright for the migration end-to-end test (run by tests/migration-e2e/run.js
 * after the migration into the emulators; not part of `npm run test:e2e`).
 * The emulators are already running (emulators:exec); this only serves www/,
 * with firebaseConfig.js rewritten to the run's demo project and emulator ports.
 */
const path = require('path');
const { defineConfig, devices } = require('@playwright/test');
const { target } = require('../e2e/support/emulator-target.js');

const PORT = Number(process.env.MIGRATION_E2E_PORT || 8097);
const DIR = process.env.MIGRATION_E2E_DIR || path.join(__dirname, '.out');
const CTX = (() => {
    try { return require(path.join(DIR, 'context.json')); } catch { return {}; }
})();
const REAL = CTX.real === true;
const port = (host, fallback) => Number(String(host || '').split(':').pop() || fallback);
const EMU = target({
    project: CTX.project || 'demo-happa-migration',
    authPort: port(process.env.FIREBASE_AUTH_EMULATOR_HOST, 9199),
    firestorePort: port(process.env.FIRESTORE_EMULATOR_HOST, 8281)
});

module.exports = defineConfig({
    testDir: __dirname,
    testMatch: /app\.spec\.js$/,
    timeout: 120000,
    expect: { timeout: 20000 },
    workers: 1,
    fullyParallel: false,
    retries: 0,
    // A real backup's screens and traces stay next to its output, outside the repo.
    outputDir: path.join(DIR, 'test-results'),
    reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: path.join(DIR, 'playwright-report') }]] : 'list',
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        serviceWorkers: 'block',
        timezoneId: 'Asia/Kolkata',
        locale: 'en-IN',
        trace: REAL ? 'off' : 'retain-on-failure',
        screenshot: REAL ? 'off' : 'only-on-failure'
    },
    projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } }],
    webServer: {
        command: `node tests/e2e/static-server.js ${PORT} --project ${EMU.project} --auth-port ${EMU.authPort} --firestore-port ${EMU.firestorePort}`,
        cwd: path.join(__dirname, '..', '..'),
        url: `http://127.0.0.1:${PORT}`,
        reuseExistingServer: false
    }
});
