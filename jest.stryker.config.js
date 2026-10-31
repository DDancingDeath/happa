/**
 * Jest config for mutation testing (#216): the fast suites that exercise the
 * mutated modules (see stryker.config.json). The DOM-heavy page suites and the
 * property tests are left out so a full run stays under ~15 minutes on a laptop.
 */
const base = require('./jest.config.js');

module.exports = {
    ...base,
    verbose: false,
    testMatch: [
        '**/www/js/__tests__/{money,billing-calc,dates,bill-checks,release,calculateStock,calculateStock-equivalence,oracle,stock-adjust,stock-check,number-checks}.test.js',
        '**/tests/oracle/**/*.test.js'
    ]
};