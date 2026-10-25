/**
 * Light ESLint setup (#16). Goal: catch real errors (duplicate keys,
 * unreachable code, redeclarations, undefined names) without restyling a
 * vanilla-JS codebase. Formatting/style rules are deliberately off.
 */
const js = require('@eslint/js');
const globals = require('globals');

const realErrors = {
    ...js.configs.recommended.rules,
    'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    'no-empty': ['error', { allowEmptyCatch: true }],
    // Pre-existing patterns that are noisy but harmless; keep visible as warnings.
    'no-useless-escape': 'warn',
    'no-prototype-builtins': 'warn',
    'no-case-declarations': 'warn',
    'no-inner-declarations': 'off',
    // authentication.js deliberately swaps in the recovery error before reporting.
    'no-ex-assign': 'warn'
};

module.exports = [
    {
        ignores: [
            'node_modules/**',
            'android/**',
            'public/**',
            'coverage/**',
            'rules-tests/node_modules/**',
            'test-results/**',
            'playwright-report/**',
            '.stryker-tmp/**',
            'reports/**',
            'www/lib/**',
            '**/*.min.js'
        ]
    },
    {
        // App modules loaded via <script type="module"> (main.js and everything it imports).
        files: ['www/js/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                firebase: 'readonly',
                // window.db / window.auth are set by firebaseConfig.js
                db: 'readonly',
                auth: 'readonly',
                XLSX: 'readonly',
                Capacitor: 'readonly',
                cordova: 'readonly',
                bluetoothSerial: 'readonly'
            }
        },
        rules: realErrors
    },
    {
        // Classic scripts: firebaseConfig.js is a plain <script defer>, service-worker.js runs as a worker.
        files: ['www/firebaseConfig.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: { ...globals.browser, firebase: 'readonly' }
        },
        rules: realErrors
    },
    {
        files: ['www/service-worker.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: { ...globals.serviceworker }
        },
        rules: realErrors
    },
    {
        files: ['www/js/__tests__/**/*.js', 'tests/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.browser, ...globals.node, ...globals.jest }
        },
        rules: { ...realErrors, 'no-unused-vars': 'off' }
    },
    {
        files: ['scripts/**/*.js', 'tools/**/*.js', 'rules-tests/**/*.js', '*.config.js', 'babel.config.js', 'jest.config.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            // Playwright helpers pass callbacks to page.evaluate(), which run in the browser.
            globals: { ...globals.node, ...globals.browser }
        },
        rules: { ...realErrors, 'no-control-regex': 'off' }
    },
    {
        // tools/migrate is an ES module package (it imports the app's www/js utils).
        files: ['tools/migrate/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node }
        },
        rules: realErrors
    }
];
