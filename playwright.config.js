// @ts-check
/**
 * Playwright E2E against the Firebase emulators (#127).
 *   npm run test:e2e     phone + desktop projects; starts the emulators and a static server
 *   npm run test:smoke   read-only smoke of the live site (playwright.prod.config.js)
 * Needs Java 21 for the Firestore emulator. Ports: auth 9099, firestore 8181
 * (fixed by www/firebaseConfig.js), static server E2E_PORT (default 8099).
 */
const { defineConfig, devices } = require('@playwright/test');

const { loadConfig, derive } = require('./scripts/happa-config.js');

const PROJECT_ID = derive(loadConfig()).projectId;
const PORT = Number(process.env.E2E_PORT || 8099);
const BASE_URL = `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
    testDir: 'tests/e2e',
    testIgnore: /prod-smoke/,
    globalSetup: require.resolve('./tests/e2e/global-setup.js'),
    timeout: 120000,
    expect: { timeout: 15000 },
    // Specs share one emulator: run serially.
    workers: 1,
    fullyParallel: false,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
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
            command: `npx --yes firebase-tools@latest emulators:start --only auth,firestore --project ${PROJECT_ID}`,
            url: 'http://127.0.0.1:9099/',
            reuseExistingServer: !process.env.CI,
            timeout: 180000,
            stdout: 'ignore'
        },
        {
            command: `node tests/e2e/static-server.js ${PORT}`,
            url: BASE_URL,
            reuseExistingServer: !process.env.CI
        }
    ]
});
