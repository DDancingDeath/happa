// @ts-check
/** Read-only smoke of the live site (#127): no login, no writes. `npm run test:smoke` */
const { defineConfig, devices } = require('@playwright/test');
const { loadConfig, derive } = require('./scripts/happa-config.js');

module.exports = defineConfig({
    testDir: 'tests/e2e',
    testMatch: /prod-smoke\.spec\.js/,
    timeout: 90000,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: process.env.SMOKE_URL || derive(loadConfig()).siteUrl,
        serviceWorkers: 'block',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    projects: [
        { name: 'phone', use: { ...devices['Pixel 5'] } },
        { name: 'desktop', use: { ...devices['Desktop Chrome'] } }
    ]
});
