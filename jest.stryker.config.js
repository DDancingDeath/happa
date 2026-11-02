/**
 * Jest config for mutation testing (#216, #160): the fast suites that exercise the
 * mutated modules (see stryker.config.json). The DOM-heavy page suites and the
 * property tests are left out so each file's run stays bounded. The weekly job
 * mutates one file per matrix job and sets STRYKER_MUTATE to it, so a job runs
 * only that file's suites (`TESTS_FOR`); without it (a local run) every listed
 * suite runs.
 */
const base = require('./jest.config.js');

const www = (names) => `**/www/js/__tests__/{${names.join(',')}}.test.js`;
const ORACLE = '**/tests/oracle/**/*.test.js';
const CORE = www(['money', 'billing-calc', 'dates', 'bill-checks', 'release', 'calculateStock', 'calculateStock-equivalence',
    'oracle', 'stock-adjust', 'stock-check', 'number-checks', 'stock-replay']);
// Finance / Insights maths (#160): the oracle and the pure money-figure suites, no page DOM.
const FINANCE = www(['oracle', 'rounding', 'opening-records', 'fy-periods', 'period-compare', 'questionnaire-defaults',
    'metric-registry', 'number-checks']);

/** Suites per mutated file; a file not listed gets CORE + the oracle. */
const TESTS_FOR = {
    'www/js/utils/finance-calc.js': [FINANCE, ORACLE],
    'www/js/utils/business-metrics.js': [FINANCE, ORACLE]
};

const mutated = String(process.env.STRYKER_MUTATE || '').replace(/\\/g, '/');
const testMatch = mutated
    ? (TESTS_FOR[mutated] || [CORE, ORACLE])
    : [...new Set([CORE, FINANCE, ORACLE])];

module.exports = {
    ...base,
    verbose: false,
    testMatch
};
