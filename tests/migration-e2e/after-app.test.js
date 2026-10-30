/**
 * Migration end-to-end, after the app ran (run.js step 9): the owner opened
 * Insights › Seasons and saved a new bill in the cutover week, so the app's
 * roll-forward ran. The carried rate history must be unchanged: every bucket
 * the migration wrote (all of them start before the backup) is left as carried
 * (clampWindowToMigration), and rateStats/_meta still marks a carried history.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { checkEmulatorTarget } from '../../tools/migrate/lib/emulator.js';

process.env.TZ = 'Asia/Kolkata';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const adminRequire = createRequire(path.join(HERE, '..', '..', 'tools', 'migrate', 'package.json'));
const { initializeApp, deleteApp } = adminRequire('firebase-admin/app');
const { getFirestore } = adminRequire('firebase-admin/firestore');

const DIR = process.env.MIGRATION_E2E_DIR;
const ctx = JSON.parse(fs.readFileSync(path.join(DIR, 'context.json'), 'utf8'));
// Abort before firebase-admin starts unless it can only reach local emulators and a demo-* project.
checkEmulatorTarget({ emulator: true, auth: true, project: ctx.project, keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const bundle = JSON.parse(fs.readFileSync(path.join(ctx.planDir, 'bundle.json'), 'utf8'));
process.env.METADATA_SERVER_DETECTION = 'none';
const app = initializeApp({ projectId: ctx.project }, 'migration-e2e-after');
after(() => deleteApp(app));

const plain = (v) => JSON.parse(JSON.stringify(v));

test('the carried rate history is unchanged after the app ran', async () => {
    const db = getFirestore(app);
    const written = bundle.writes.filter(w => w.coll === 'rateStats');
    let buckets = 0;
    for (const w of written) {
        const got = (await db.collection('rateStats').doc(w.id).get()).data();
        assert.ok(got, `rateStats/${w.id} still there`);
        if (w.id === '_meta') {
            assert.deepEqual({ by: got.by, backfillAt: got.backfillAt, backfillDone: got.backfillDone }, { by: w.data.by, backfillAt: w.data.backfillAt, backfillDone: true }, '_meta');
            continue;
        }
        for (const group of ['weeks', 'months']) {
            Object.entries(w.data[group] || {}).forEach(([k, bucket]) => {
                buckets++;
                assert.deepEqual(plain(got[group]?.[k]), plain(bucket), `rateStats/${w.id} ${k} as carried`);
            });
        }
    }
    console.log(`  ${buckets} carried weekly and monthly buckets unchanged`);
});
