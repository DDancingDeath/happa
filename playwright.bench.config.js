// @ts-check
/**
 * Multi-year data-load benchmark (#59): `npm run bench` seeds the Firebase emulators
 * with a synthetic 3-year shop (tests/bench/dataset.js) and measures, with a 4×
 * slower CPU on the phone project, the first Today render and the full history
 * window load (tests/bench/multi-year.spec.js). Nightly in .github/workflows/bench.yml,
 * which keeps a trend file and warns (never fails) above the budgets in
 * tools/bench/budgets.json. Its own demo project and ports, so it never shares
 * the E2E suite's emulators: BENCH_PROJECT (demo-happa-bench), BENCH_AUTH_PORT
 * (9299), BENCH_FIRESTORE_PORT (8381), BENCH_PORT (8199).
 */
process.env.E2E_PROJECT = process.env.BENCH_PROJECT || 'demo-happa-bench';
process.env.E2E_AUTH_PORT = process.env.BENCH_AUTH_PORT || '9299';
process.env.E2E_FIRESTORE_PORT = process.env.BENCH_FIRESTORE_PORT || '8381';

const { defineConfig, devices } = require('@playwright/test');
const { e2eTarget, writeEmulatorConfig } = require('./tests/e2e/support/emulator-target.js');

const EMU = e2eTarget();
const EMULATOR_CONFIG = writeEmulatorConfig('bench', EMU);
const PORT = Number(process.env.BENCH_PORT || 8199);
const BASE_URL = `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
    testDir: 'tests/bench',
    globalSetup: require.resolve('./tests/bench/global-setup.js'),
    timeout: 900000,
    expect: { timeout: 60000 },
    workers: 1,
    retries: 0,
    reporter: 'list',
    use: { baseURL: BASE_URL, serviceWorkers: 'block' },
    projects: [{ name: 'phone', use: { ...devices['Pixel 5'] } }],
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
