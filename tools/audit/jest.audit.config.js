/**
 * Jest config for the real-data number audit (tools/audit/real-data-audit.js).
 * Same transform/environment as the main config, but only the audit runner,
 * and app modules resolved from AUDIT_APP_ROOT (`@app/…`) so another branch's
 * www/ can be audited with this checkout's oracle.
 */
const path = require('path');
const base = require('../../jest.config.js');

const root = path.resolve(__dirname, '../..');
const appRoot = path.resolve(process.env.AUDIT_APP_ROOT || root);

module.exports = {
    rootDir: root,
    testEnvironment: base.testEnvironment,
    transform: base.transform,
    moduleFileExtensions: base.moduleFileExtensions,
    testMatch: ['<rootDir>/tools/audit/audit.run.js'],
    testPathIgnorePatterns: ['/node_modules/'],
    moduleNameMapper: {
        '^@app/(.*)$': path.join(appRoot, 'www', 'js', '$1').replace(/\\/g, '/')
    },
    verbose: false
};
