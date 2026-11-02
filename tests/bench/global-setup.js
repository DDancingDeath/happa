/**
 * Benchmark setup (#59): the E2E seed (users, item catalogue, a few known bills),
 * then the synthetic multi-year shop (dataset.js), committed in chunks.
 * BENCH_YEARS (3) and BENCH_ACTIVITY (2, about 3,000 bills a year) size it.
 */
const { waitForEmulators, commit } = require('../e2e/support/emulator');
const { seed } = require('../e2e/support/seed');
const { benchDataset } = require('./dataset');

const CHUNK = 400;

module.exports = async () => {
    await waitForEmulators();
    await seed();
    const years = Number(process.env.BENCH_YEARS || 3);
    const activity = Number(process.env.BENCH_ACTIVITY || 2);
    const { writes, counts } = benchDataset({ years, activity });
    const t0 = Date.now();
    for (let i = 0; i < writes.length; i += CHUNK) await commit(writes.slice(i, i + CHUNK));
    process.env.BENCH_DATASET = JSON.stringify({ years, activity, docs: writes.length, counts });
    console.log(`[bench] seeded ${writes.length} documents (${years} years, activity ${activity}) in ${Date.now() - t0} ms: ${JSON.stringify(counts)}`);
};
