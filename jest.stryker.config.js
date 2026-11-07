/**
 * Jest config for mutation testing (#216, #160): the fast suites that exercise the
 * mutated modules (see stryker.config.json). The DOM-heavy page suites and the
 * property tests are left out so each file's run stays bounded. The weekly job
 * mutates one file per matrix job and sets STRYKER_MUTATE to it, so a job runs
 * only that file's suites (`TESTS_FOR`); without it (a local run) every listed
 * suite runs.
 */
const base = require('./jest.config.js');

// A brace list with one name is not a list to the glob matcher
const anyOf = (names) => (names.length === 1 ? names[0] : `{${names.join(',')}}`);
const www = (names) => `**/www/js/__tests__/${anyOf(names)}.test.js`;
const ORACLE = '**/tests/oracle/**/*.test.js';
const CORE = www(['money', 'billing-calc', 'dates', 'bill-checks', 'release', 'calculateStock', 'calculateStock-equivalence',
    'oracle', 'stock-adjust', 'stock-check', 'number-checks', 'stock-replay']);
// Finance / Insights maths (#160): only the suites that check these figures directly, so each
// mutant runs a few files and a job stays under an hour (every oracle suite: ~8 s per mutant).
const oracle = (names) => `**/tests/oracle/${anyOf(names)}.test.js`;
const FINANCE_CALC = [oracle(['business-metrics', 'cross-page', 'screens']), www(['rounding', 'opening-records', 'finance-calc'])];
const BUSINESS_METRICS = [oracle(['business-metrics', 'period-compare', 'fy-periods', 'questionnaire', 'screens', 'cross-page']),
    www(['fy-periods', 'period-compare', 'questionnaire-defaults', 'business-metrics-units'])];

// Today and the cash drawer (#160): the suites that call calc/today.js / calc/cash.js directly.
const TODAY = [oracle(['screens']), www(['today-characterisation', 'rounding', 'bill-date'])];
const CASH = [oracle(['screens']), www(['cash-characterisation', 'rounding', 'bill-date', 'complete-all-due'])];

// Rentals money maths (#157): the pure and fake-Firestore suites, not the DOM screens.
const RENT_MATH = [oracle(['rent', 'rent-receipt']),
    www(['rent-math', 'rent-movein', 'rent-advance', 'rent-expense', 'rent-views', 'rent-public'])];
const RENT_LEDGER = [oracle(['rent', 'rent-receipt']), www(['rent-math', 'rent-advance', 'rent-deposit', 'rent-expense'])];
const RENT_REPORT = [oracle(['rent-report']), www(['rent-report'])];

/** Suites per mutated file; a file not listed gets CORE + the oracle. */
const TESTS_FOR = {
    'www/js/utils/finance-calc.js': FINANCE_CALC,
    'www/js/utils/business-metrics.js': BUSINESS_METRICS,
    'www/js/utils/calc/today.js': TODAY,
    'www/js/utils/calc/cash.js': CASH,
    'www/js/rentals/rent-math.js': RENT_MATH,
    'www/js/rentals/rent-math-ledger.js': RENT_LEDGER,
    'www/js/rentals/rent-math-report.js': RENT_REPORT
};

// A matrix entry may be a line range of a file ("file.js:1-480"): the file's suites
const mutated = String(process.env.STRYKER_MUTATE || '').replace(/\\/g, '/').replace(/:[\d-]+$/, '');
const testMatch = mutated
    ? (TESTS_FOR[mutated] || [CORE, ORACLE])
    : [...new Set([CORE, ORACLE, ...FINANCE_CALC, ...BUSINESS_METRICS, ...TODAY, ...CASH,
        ...RENT_MATH, ...RENT_LEDGER, ...RENT_REPORT])];

module.exports = {
    ...base,
    verbose: false,
    testMatch
};
