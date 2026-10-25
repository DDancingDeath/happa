#!/usr/bin/env node
/**
 * Moves the shop's data to a new Firebase project. See tools/migrate/README.md.
 *
 *   node tools/migrate/migrate.js plan  --in backup.json [--out-dir tools/migrate/out]
 *        [--mode fresh|full] [--bill-numbers continue|restart] [--carry-payables] [--include-hidden-wholesale-dues]
 *        [--no-settings] [--no-rate-stats] [--copy items,users,rateHistory,itemFrequency]
 *   node tools/migrate/migrate.js apply --bundle tools/migrate/out/bundle.json --project <newProjectId>
 *        [--key service-account.json] [--yes] [--budget 18000] [--cursor <file>] [--restart] [--dev]
 *
 * `plan` is offline. `apply` is a dry run unless --yes is given.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The shop runs in IST: legacy DD/MM bill dates are read as IST local time, like on the phones.
process.env.TZ = 'Asia/Kolkata';

// Importing the app's www/js modules (ES modules without "type": "module") prints a harmless notice.
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w?.code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.warn(w?.message || w); });

const argv = process.argv.slice(2);
const command = argv[0];
const arg = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
};
const flag = (name) => argv.includes(name);

async function plan() {
    const { buildPlan } = await import('./lib/plan.js');
    const { formatReport } = await import('./lib/report.js');
    const input = arg('--in');
    if (!input) throw new Error('--in <decrypted backup.json> is required');
    const outDir = arg('--out-dir') || fileURLToPath(new URL('./out', import.meta.url));
    const backup = JSON.parse(fs.readFileSync(input, 'utf8'));
    const options = {
        mode: arg('--mode'),
        billNumbers: arg('--bill-numbers'),
        carryPayables: flag('--carry-payables') ? true : undefined,
        includeHiddenWholesaleDues: flag('--include-hidden-wholesale-dues') ? true : undefined,
        settings: flag('--no-settings') ? false : undefined,
        rateStats: flag('--no-rate-stats') ? false : undefined,
        copy: arg('--copy') !== undefined ? arg('--copy').split(',') : undefined
    };
    const { bundle, summary } = buildPlan(backup, options);
    fs.mkdirSync(outDir, { recursive: true });
    const bundlePath = path.join(outDir, 'bundle.json');
    const reportPath = path.join(outDir, 'report.md');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle));
    const report = formatReport(summary);
    fs.writeFileSync(reportPath, report);
    console.log(report);
    console.log(`Bundle: ${bundlePath} (${summary.writes.total} writes). It holds shop data: keep it private and delete it after cutover.`);
    console.log(`Report: ${reportPath}`);
}

async function apply() {
    const { applyBundle, checkTarget, resumeCursor, DEFAULT_BUDGET } = await import('./lib/apply.js');
    const bundlePath = arg('--bundle');
    if (!bundlePath) throw new Error('--bundle <bundle.json> is required');
    const project = arg('--project');
    const dryRun = !flag('--yes') || flag('--dry-run');
    const budget = arg('--budget') !== undefined ? Number(arg('--budget')) : DEFAULT_BUDGET;
    if (!Number.isInteger(budget) || budget < 1 || budget > 20000) throw new Error('--budget must be 1..20000 (Spark: 20,000 writes/day)');
    const dev = flag('--dev');

    const keyFile = arg('--key') || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    let key = null;
    if (keyFile) key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    checkTarget({ project, keyProject: key?.project_id });
    if (!dryRun && !key) throw new Error('A service-account key for the new project is needed: --key <file> (never commit it)');

    const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
    const cursorPath = arg('--cursor') || `${bundlePath}.${project}${dev ? '.dev' : ''}.cursor.json`;
    const saved = fs.existsSync(cursorPath) ? JSON.parse(fs.readFileSync(cursorPath, 'utf8')) : null;
    const cursor = resumeCursor(saved, bundle, project, { restart: flag('--restart') });

    let db = null;
    let types = null;
    if (!dryRun) {
        const { initializeApp, cert } = await import('firebase-admin/app');
        const { getFirestore, Timestamp, GeoPoint } = await import('firebase-admin/firestore');
        initializeApp({ credential: cert(key), projectId: project });
        db = getFirestore();
        types = { Timestamp, GeoPoint };
    }
    console.log(`Target project: ${project}${dev ? ' (dev_ collections)' : ''}${dryRun ? ' — DRY RUN' : ''}`);
    const result = await applyBundle({
        bundle, cursor, dryRun, db, types, budget, dev,
        saveCursor: (c) => fs.writeFileSync(cursorPath, JSON.stringify(c, null, 2)),
        log: (line) => console.log(line)
    });
    if (!dryRun) console.log(`Writes this run: ${result.writes}. Cursor: ${cursorPath}`);
}

const commands = { plan, apply };
if (!commands[command]) {
    console.error('Usage: node tools/migrate/migrate.js plan|apply ... (see tools/migrate/README.md)');
    process.exit(2);
}
commands[command]().catch(err => {
    console.error(`${command} failed: ${err && err.message ? err.message : err}`);
    process.exit(1);
});
