#!/usr/bin/env node
/**
 * Moves the shop's data to a new Firebase project. See tools/migrate/README.md.
 *
 *   node tools/migrate/migrate.js plan  --in backup.json [--out-dir tools/migrate/out]
 *        [--mode fresh|full] [--bill-numbers continue|restart] [--carry-payables] [--include-hidden-wholesale-dues]
 *        [--no-settings] [--no-rate-stats] [--copy items,users,rateHistory,itemFrequency]
 *   node tools/migrate/migrate.js apply --bundle tools/migrate/out/bundle.json --project <newProjectId>
 *        [--key service-account.json | --emulator] [--yes] [--budget 12000] [--cursor <file>] [--restart] [--dev]
 *
 *   node tools/migrate/migrate.js convert --in rest-docs.json --out backup.json [--exclude a,b] [--exported-at ISO]
 *   node tools/migrate/migrate.js wipe --project <newProjectId> (--key service-account.json | --emulator) [--yes] [--test-domain @happa.local]
 *   node tools/migrate/migrate.js auth:import --users users.json --hash-params hash-params.txt --project <newProjectId>
 *        (--key service-account.json | --emulator) [--yes]
 *
 * `plan` and `convert` are offline. `apply`, `wipe` and `auth:import` are dry runs unless --yes is given.
 * `--emulator` uses the local Firebase emulators (FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST)
 * and needs a demo-* --project (a real project id is refused).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkEmulatorTarget } from './lib/emulator.js';

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
    console.log(`Bundle: ${bundlePath} (${summary.writes.total} writes). It holds shop data: keep it in a private folder outside the repo (e.g. Q:\\aadhat-data) and delete it after cutover.`);
    console.log(`Report: ${reportPath}`);
}

async function apply() {
    const { applyBundle, checkTarget, resumeCursor, DEFAULT_BUDGET } = await import('./lib/apply.js');
    const bundlePath = arg('--bundle');
    if (!bundlePath) throw new Error('--bundle <bundle.json> is required');
    const project = arg('--project');
    const dryRun = !flag('--yes') || flag('--dry-run');
    const budget = arg('--budget') !== undefined ? Number(arg('--budget')) : DEFAULT_BUDGET;
    if (!Number.isInteger(budget) || budget < 1 || budget > 20000) throw new Error('--budget must be 1..20000 (Spark: 20,000 writes/day; the default keeps 8,000 for the shop)');
    const dev = flag('--dev');

    const keyFile = arg('--key') || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const emulator = checkEmulatorTarget({ emulator: flag('--emulator'), project, keyFile });
    let key = null;
    if (keyFile) key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    checkTarget({ project, keyProject: key?.project_id });
    if (!dryRun && !key && !emulator) throw new Error('A service-account key for the new project is needed: --key <file> (never commit it)');

    const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
    const cursorPath = arg('--cursor') || `${bundlePath}.${project}${dev ? '.dev' : ''}${emulator ? '.emulator' : ''}.cursor.json`;
    const saved = fs.existsSync(cursorPath) ? JSON.parse(fs.readFileSync(cursorPath, 'utf8')) : null;
    const cursor = resumeCursor(saved, bundle, project, { restart: flag('--restart') });

    let db = null;
    let types = null;
    if (!dryRun) {
        const { getFirestore, Timestamp, GeoPoint } = await import('firebase-admin/firestore');
        await initAdmin({ key, project });
        db = getFirestore();
        types = { Timestamp, GeoPoint };
    }
    console.log(`Target project: ${project}${dev ? ' (dev_ collections)' : ''}${targetNote(emulator)}${dryRun ? ' — DRY RUN' : ''}`);
    const result = await applyBundle({
        bundle, cursor, dryRun, db, types, budget, dev,
        saveCursor: (c) => fs.writeFileSync(cursorPath, JSON.stringify(c, null, 2)),
        log: (line) => console.log(line)
    });
    if (!dryRun) console.log(`Writes this run: ${result.writes}. Cursor: ${cursorPath}`);
}

async function convert() {
    const { convertRestDocs } = await import('./lib/convert.js');
    const input = arg('--in');
    const out = arg('--out');
    if (!input || !out) throw new Error('--in <REST documents .json> and --out <backup.json> are required');
    const { backup, summary } = convertRestDocs(JSON.parse(fs.readFileSync(input, 'utf8')), {
        exclude: (arg('--exclude') || '').split(','),
        exportedAt: arg('--exported-at')
    });
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(backup));
    console.log(`Project ${summary.project}, exportedAt ${summary.exportedAt}`);
    Object.entries(summary.collections).forEach(([c, n]) => console.log(`  ${c}: ${n}`));
    console.log(`Left out: ${JSON.stringify(summary.skipped)}`);
    console.log(`Backup: ${out}. It holds shop data: keep it outside the repo.`);
}

async function wipe() {
    const { wipeProject } = await import('./lib/wipe.js');
    const project = arg('--project');
    const keyFile = arg('--key') || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const emulator = checkEmulatorTarget({ emulator: flag('--emulator'), project, keyFile, auth: true });
    if (!keyFile && !emulator) throw new Error('--key <service-account.json> for the project is required');
    const key = keyFile ? JSON.parse(fs.readFileSync(keyFile, 'utf8')) : null;
    const { checkTarget } = await import('./lib/apply.js');
    checkTarget({ project, keyProject: key?.project_id });
    const { getFirestore } = await import('firebase-admin/firestore');
    const { getAuth } = await import('firebase-admin/auth');
    await initAdmin({ key, project });
    const dryRun = !flag('--yes');
    console.log(`Target project: ${project}${targetNote(emulator)}${dryRun ? ' — DRY RUN' : ' — DELETING EVERYTHING IN FIRESTORE + TEST LOGINS'}`);
    await wipeProject({
        project, keyProject: key?.project_id, emulator: !!emulator, db: getFirestore(), auth: getAuth(), dryRun,
        testDomain: arg('--test-domain'), log: (line) => console.log(line)
    });
}

async function authImport() {
    const { parseHashParams, toImportRecords, importLogins } = await import('./lib/auth-import.js');
    const project = arg('--project');
    const usersFile = arg('--users');
    const paramsFile = arg('--hash-params');
    if (!usersFile || !paramsFile) throw new Error('--users <auth export .json> and --hash-params <file> are required');
    const keyFile = arg('--key') || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const emulator = checkEmulatorTarget({ emulator: flag('--emulator'), project, keyFile, auth: true });
    const key = keyFile ? JSON.parse(fs.readFileSync(keyFile, 'utf8')) : null;
    const { checkTarget } = await import('./lib/apply.js');
    checkTarget({ project, keyProject: key?.project_id });
    const hash = parseHashParams(fs.readFileSync(paramsFile, 'utf8'));
    const { records, summary } = toImportRecords(JSON.parse(fs.readFileSync(usersFile, 'utf8')));
    const dryRun = !flag('--yes');
    console.log(`Target project: ${project}${targetNote(emulator)}${dryRun ? ' — DRY RUN' : ''}`);
    console.log(`Logins: ${summary.users} (${summary.withPassword} with a password, ${summary.disabled} disabled, ${summary.otherProviders} other sign-in methods); SCRYPT rounds ${hash.rounds}, mem_cost ${hash.memoryCost}`);
    if (dryRun) {
        console.log('Dry run: nothing was imported. Add --yes to import.');
        return;
    }
    if (!key && !emulator) throw new Error('A service-account key for the new project is needed: --key <file> (never commit it)');
    const { getAuth } = await import('firebase-admin/auth');
    await initAdmin({ key, project });
    const { imported, failed } = await importLogins({ auth: getAuth(), records, hash, log: (line) => console.log(line) });
    failed.forEach(f => console.error(`  login #${f.index + 1} failed: ${f.message}`));
    console.log(`Imported ${imported} logins, ${failed.length} failed. Sign in with one account to check the hash parameters.`);
    if (failed.length) process.exitCode = 1;
}

/**
 * firebase-admin for the target: the key's credentials, or, for the emulators,
 * none (the emulators need no token). METADATA_SERVER_DETECTION=none stops the
 * Google auth library from probing for a cloud metadata server.
 */
async function initAdmin({ key, project }) {
    const { initializeApp, cert } = await import('firebase-admin/app');
    if (key) {
        initializeApp({ credential: cert(key), projectId: project });
        return;
    }
    if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('internal: no key and no emulator');
    process.env.METADATA_SERVER_DETECTION = 'none';
    process.env.GOOGLE_CLOUD_PROJECT = project;
    initializeApp({ projectId: project });
}

const targetNote = (emulator) => (emulator ? ` (EMULATOR firestore ${emulator.firestore}${emulator.auth ? `, auth ${emulator.auth}` : ''})` : '');

const commands = { plan, apply, convert, wipe, 'auth:import': authImport };
if (!commands[command]) {
    console.error('Usage: node tools/migrate/migrate.js plan|apply|convert|wipe|auth:import ... (see tools/migrate/README.md)');
    process.exit(2);
}
commands[command]().catch(err => {
    console.error(`${command} failed: ${err && err.message ? err.message : err}`);
    process.exit(1);
});
