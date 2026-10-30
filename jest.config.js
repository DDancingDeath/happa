/**
 * Jest Configuration for Aadhat Management App
 * @type {import('jest').Config}
 */
// Business runs in IST; pin test timezone so date tests are deterministic on any machine/CI.
process.env.TZ = 'Asia/Kolkata';

module.exports = {
    // Use jsdom environment for DOM testing
    testEnvironment: 'jsdom',
    
    // Test file patterns
    testMatch: [
        '**/www/js/__tests__/**/*.test.js',
        '**/www/js/**/*.spec.js',
        // Business-correctness tests (#216): spec oracle + accounting property checks
        '**/tests/oracle/**/*.test.js',
        '**/tests/property/**/*.test.js',
        // Firestore backup tooling (tools/backup)
        '**/tests/backup/**/*.test.js',
        // CI helper scripts (tools/ci)
        '**/tests/ci/**/*.test.js'
    ],
    
    // Stryker's sandbox copies of the repo (#216)
    testPathIgnorePatterns: ['/node_modules/', '<rootDir>/\\.stryker-tmp/'],
    modulePathIgnorePatterns: ['<rootDir>/\\.stryker-tmp/'],

    // Module file extensions
    moduleFileExtensions: ['js', 'json'],
    
    // Transform ES modules with Babel
    transform: {
        '^.+\\.js$': 'babel-jest'
    },
    
    // Module name mapper for path aliases
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/www/js/$1',
        // tools/audit modules import the app as @app/ (the audit can point it at another checkout)
        '^@app/(.*)$': '<rootDir>/www/js/$1'
    },
    
    // Coverage configuration - only collect from testable utility files
    collectCoverageFrom: [
        'www/js/utils/helpers.js',
        'www/js/utils/validator.js',
        'www/js/utils/state.js',
        'www/js/utils/money.js',
        // Exclude files that require Firebase, DOM, or Capacitor
        '!www/js/__tests__/**',
        '!www/js/main.js',
        '!www/js/auth/**',
        '!www/js/firebase/**',
        '!www/js/modules/**',
        '!www/js/services/**',
        '!www/js/ui/**',
        '!www/js/utils/constants.js',
        '!www/js/utils/template-loader.js'
    ],
    
    // Coverage thresholds - only for files we can unit test
    coverageThreshold: {
        'www/js/utils/helpers.js': {
            branches: 35,
            functions: 70,
            lines: 60,
            statements: 60
        },
        'www/js/utils/validator.js': {
            branches: 90,
            functions: 85,
            lines: 95,
            statements: 95
        },
        'www/js/utils/money.js': {
            branches: 90,
            functions: 100,
            lines: 95,
            statements: 95
        },
        'www/js/utils/state.js': {
            branches: 100,
            functions: 100,
            lines: 100,
            statements: 100
        }
    },
    
    // Setup files
    setupFilesAfterEnv: [],
    
    // Verbose output
    verbose: true,
    
    // Clear mocks between tests
    clearMocks: true,
    
    // Restore mocks between tests
    restoreMocks: true
};
