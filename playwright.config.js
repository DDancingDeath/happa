// @ts-check
/**
 * Playwright E2E against the Firebase emulators (#127).
 *   npm run test:e2e     phone + desktop projects; starts the emulators and a static server
 *   npm run test:smoke   read-only smoke of the live site (playwright.prod.config.js)
 * Needs Java 21 for the Firestore emulator. The emulators run the demo project
 * E2E_PROJECT (default demo-happa-e2e) on E2E_AUTH_PORT (9099) and E2E_FIRESTORE_PORT
 * (8181): a gitignored .e2e.firebase.json (--config) gives them the ports and the
 * static server (E2E_PORT, default 8099) serves www/firebaseConfig.js rewritten to
 * that project and those ports (tests/e2e/support/emulator-target.js), so other
 * ports need no edit to a committed file.
 * CI (.github/workflows/e2e.yml) runs it in 3 shards (`--shard=N/3`, each with its
 * own emulators) and merges their blob reports. FIREBASE_TOOLS_VERSION pins the
 * firebase-tools version npx runs (CI sets it so its cache key matches).
 */
const { defineConfig, devices } = require('@playwright/test');

const { e2eTarget, writeEmulatorConfig } = require('./tests/e2e/support/emulator-target.js');

const EMU = e2eTarget();
const EMULATOR_CONFIG = writeEmulatorConfig('e2e', EMU);
const PORT = Number(process.env.E2E_PORT || 8099);
const BASE_URL = `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
    testDir: 'tests/e2e',
    testIgnore: /prod-smoke/,
    globalSetup: require.resolve('./tests/e2e/global-setup.js'),
    timeout: 120000,
    expect: { timeout: 15000 },
    // Specs share one emulator: one worker runs them one after another. fullyParallel
    // only lets --shard split a spec file by test (tests still run serially).
    workers: 1,
    fullyParallel: true,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['blob']] : 'list',
    use: {
        baseURL: BASE_URL,
        serviceWorkers: 'block',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    projects: [
        { name: 'phone', use: { ...devices['Pixel 5'] } },
        { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } }
    ],
    webServer: [
        {
            command: `npx --yes firebase-tools@${process.env.FIREBASE_TOOLS_VERSION || 'latest'} emulators:start --only auth,firestore --project ${EMU.project} --config ${EMULATOR_CONFIG}`,
            url: `http://127.0.0.1:${EMU.authPort}/`,
            reuseExistingServer: !process.env.CI,
            timeout: 180000,
            stdout: 'ignore'
        },
        {
            command: `node tests/e2e/static-server.js ${PORT} --project ${EMU.project} --auth-port ${EMU.authPort} --firestore-port ${EMU.firestorePort}`,
            url: BASE_URL,
            reuseExistingServer: !process.env.CI
        }
    ]
});
