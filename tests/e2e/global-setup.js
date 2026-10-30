/**
 * Playwright globalSetup: wait for the emulators, then wipe and seed them
 * (support/seed.js).
 */
const { waitForEmulators } = require('./support/emulator');
const { seed } = require('./support/seed');

module.exports = async () => {
    await waitForEmulators();
    await seed();
};
