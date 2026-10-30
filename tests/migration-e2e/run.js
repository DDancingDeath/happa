#!/usr/bin/env node
/**
 * Migration end-to-end test: old-app backup → tools/migrate (plan, wipe,
 * apply, auth:import) into the Firebase EMULATORS → data checks → the app in a
 * browser (Playwright). Never touches a real project: the migration tool runs
 * with --emulator, which refuses unless FIRESTORE_EMULATOR_HOST and
 * FIREBASE_AUTH_EMULATOR_HOST point at 127.0.0.1.
 *
 *   npm run test:migration-e2e         synthetic, anonymised backup made at test time (CI)
 *
 * On a real backup (local only; output stays outside the repo, nothing is committed):
 *   $env:MIGRATION_E2E_BACKUP='Q:\aadhat-data\backup-final\firestore-backup.json'
 *   $env:MIGRATION_E2E_AUTH='Q:\aadhat-data\backup-final\users.json'
 *   $env:MIGRATION_E2E_HASH_PARAMS='<hash-params.txt>'
 *   $env:MIGRATION_E2E_OUT='Q:\aadhat-data\e2e-out'
 *   $env:MIGRATION_E2E_EXPECT='10,6,607364'      # optional: carried bills, parties, total
 *   npm run test:migration-e2e
 * The real logins' passwords are not known, so after the hash bytes are checked
 * the run gives one owner and one member an emulator-only password to sign in.
 *
 * Without the emulators running, it starts them (firebase emulators:exec) and runs itself inside.
 */
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

process.env.TZ = 'Asia/Kolkata';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const { loadConfig, derive } = require('../../scripts/happa-config.js');
const PROJECT = process.env.MIGRATION_E2E_PROJECT || derive(loadConfig()).projectId;
const REAL = !!process.env.MIGRATION_E2E_BACKUP;
const t0 = Date.now();
const timings = [];

function step(name) {
    const start = Date.now();
    console.log(`\n=== ${name}`);
    return () => timings.push([name, Date.now() - start]);
}

function run(cmd, args, { capture = false, env = {} } = {}) {
    const opts = { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' };
    // npx is a .cmd on Windows: run it through the shell as one command line.
    const r = process.platform === 'win32' && cmd === 'npx'
        ? spawnSync([cmd, ...args.map(a => (/\s/.test(a) ? `"${a}"` : a))].join(' '), { ...opts, shell: true })
        : spawnSync(cmd, args, opts);
    if (capture) {
        const out = (r.stdout || '') + (r.stderr || '');
        process.stdout.write(out.split('\n').filter(l => !/MODULE_TYPELESS|Reparsing as ES module|eliminate this warning|--trace-warnings/.test(l)).join('\n'));
        if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
        return out;
    }
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
    return '';
}
const migrate = (...args) => run(process.execPath, ['tools/migrate/migrate.js', ...args], { capture: true });

// ---------------------------------------------------------------- emulators (REST)
const FS_HOST = () => process.env.FIRESTORE_EMULATOR_HOST;
const AUTH_HOST = () => process.env.FIREBASE_AUTH_EMULATOR_HOST;
const DOCS = () => `http://${FS_HOST()}/v1/projects/${PROJECT}/databases/(default)/documents`;
const ADMIN = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

async function http(url, init = {}) {
    let r;
    try {
        r = await fetch(url, init);
    } catch (e) {
        // A kept-alive socket the emulator closed meanwhile: retry once on a new one.
        if (e?.cause?.code !== 'ECONNRESET') throw e;
        r = await fetch(url, init);
    }
    if (!r.ok) throw new Error(`${init.method || 'GET'} ${url}: ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json().catch(() => null);
}
async function resetEmulators() {
    await http(`http://${FS_HOST()}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    await http(`http://${AUTH_HOST()}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
}
async function signUp(email, password, localId) {
    return http(`http://${AUTH_HOST()}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, {
        method: 'POST', headers: ADMIN, body: JSON.stringify({ email, password, localId })
    });
}
async function setDoc(coll, id, fields) {
    const enc = (v) => (typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'boolean' ? { booleanValue: v } : { stringValue: String(v) });
    await http(`${DOCS()}/${coll}/${id}`, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, enc(v)])) }) });
}
/** Emulator-only password for a migrated login (real backups: the real passwords are not known). */
async function setEmulatorPassword(localId, password) {
    await http(`http://${AUTH_HOST()}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
        method: 'POST', headers: ADMIN, body: JSON.stringify({ localId, password })
    });
}

/** Whether `p` is the repo root or inside it (Windows paths compared without case). */
function insideRepo(p) {
    const norm = (x) => (process.platform === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x));
    const rel = path.relative(norm(ROOT), norm(p));
    return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------- main
async function main() {
    // Synthetic runs always use (and clear) tests/migration-e2e/.out; MIGRATION_E2E_OUT is for real backups only.
    const outDir = REAL ? path.resolve(process.env.MIGRATION_E2E_OUT || '') : path.join(HERE, '.out');
    if (REAL && (!process.env.MIGRATION_E2E_OUT || insideRepo(outDir))) {
        throw new Error('MIGRATION_E2E_OUT must name a folder outside the repo: a real backup\'s output must stay outside it');
    }
    if (!REAL) fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    console.log(`Project (emulator): ${PROJECT}; firestore ${FS_HOST()}, auth ${AUTH_HOST()}; ${REAL ? 'REAL backup (local only)' : 'synthetic backup'}; output ${REAL ? '(outside the repo)' : outDir}`);

    let done = step('1. Old backup');
    let files;
    if (REAL) {
        files = { backup: process.env.MIGRATION_E2E_BACKUP, auth: process.env.MIGRATION_E2E_AUTH, hashParams: process.env.MIGRATION_E2E_HASH_PARAMS, logins: null };
        Object.entries(files).forEach(([k, f]) => { if (k !== 'logins' && (!f || !fs.existsSync(f))) throw new Error(`MIGRATION_E2E_${k.toUpperCase()} is missing`); });
    } else {
        const { writeOldBackup } = await import('./make-old-backup.js');
        files = writeOldBackup(outDir, { now: Date.now() });
        console.log(`Synthetic old-app backup: ${files.backup}`);
    }
    done();

    done = step('2. Emulators: clean start + rehearsal leftovers for wipe');
    await resetEmulators();
    await setDoc('retailSales', 'rehearsal-bill', { billNumber: 'S-REHEARSAL-1', dueAmount: 123, customerName: 'Rehearsal' });
    await setDoc('dev_items', 'rehearsal-item', { name: 'Rehearsal item' });
    await setDoc('rateStats', '_meta', { by: 'rehearsal', bills: 1 });
    await signUp('rehearsal@happa.local', 'Rehearsal#1', 'rehearsal-login');
    await signUp('keep@other.test', 'Keep#12345', 'kept-login');
    done();

    done = step('3. migrate.js plan');
    const planDir = path.join(outDir, 'plan');
    migrate('plan', '--in', files.backup, '--out-dir', planDir);
    done();

    done = step('4. migrate.js wipe (dry run, then --yes)');
    migrate('wipe', '--project', PROJECT, '--emulator');
    migrate('wipe', '--project', PROJECT, '--emulator', '--yes');
    done();

    done = step('5. migrate.js apply (dry run, then --yes)');
    const bundle = path.join(planDir, 'bundle.json');
    migrate('apply', '--bundle', bundle, '--project', PROJECT, '--emulator', '--restart');
    const applied = migrate('apply', '--bundle', bundle, '--project', PROJECT, '--emulator', '--yes', '--restart');
    const writes = Number((/Writes this run: (\d+)/.exec(applied) || [])[1]);
    done();

    done = step('6. migrate.js auth:import (dry run, then --yes)');
    migrate('auth:import', '--users', files.auth, '--hash-params', files.hashParams, '--project', PROJECT, '--emulator');
    migrate('auth:import', '--users', files.auth, '--hash-params', files.hashParams, '--project', PROJECT, '--emulator', '--yes');
    done();

    const ctx = { project: PROJECT, real: REAL, files, planDir, outDir, writes, applyAt: Date.now(), expect: process.env.MIGRATION_E2E_EXPECT || '' };
    fs.writeFileSync(path.join(outDir, 'context.json'), JSON.stringify(ctx, null, 1));
    const { buildExpected } = await import('./expected.js');
    fs.writeFileSync(path.join(outDir, 'expected.json'), JSON.stringify(buildExpected(JSON.parse(fs.readFileSync(files.backup, 'utf8')))));

    done = step('7. Data checks (node --test)');
    run(process.execPath, ['--test', '--test-reporter=spec', path.join('tests', 'migration-e2e', 'data.test.js')], { env: { MIGRATION_E2E_DIR: outDir } });
    done();

    if (REAL) {
        // Hash bytes are checked above; the real passwords are unknown, so pick an owner and a member and give
        // them an emulator-only password (this replaces their hash in the EMULATOR only).
        const expected = JSON.parse(fs.readFileSync(path.join(outDir, 'expected.json'), 'utf8'));
        const logins = {};
        for (const [key, uid] of Object.entries(expected.loginPick)) {
            if (!uid) continue;
            const password = `E2E-${key}-${Math.random().toString(36).slice(2, 10)}`;
            await setEmulatorPassword(uid, password);
            logins[key] = { uid, email: expected.users[uid].email, password, role: expected.users[uid].role, verifyHash: false };
        }
        fs.writeFileSync(path.join(outDir, 'logins.json'), JSON.stringify(logins));
    }

    done = step('8. The app (Playwright)');
    run('npx', ['playwright', 'test', '-c', path.join('tests', 'migration-e2e', 'playwright.config.js')], { env: { MIGRATION_E2E_DIR: outDir } });
    done();

    done = step('9. After the app: carried history kept (node --test)');
    run(process.execPath, ['--test', '--test-reporter=spec', path.join('tests', 'migration-e2e', 'after-app.test.js')], { env: { MIGRATION_E2E_DIR: outDir } });
    done();

    console.log('\n=== Timings');
    timings.forEach(([n, ms]) => console.log(`  ${n}: ${(ms / 1000).toFixed(1)} s`));
    console.log(`  total: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

if (!FS_HOST() || !AUTH_HOST()) {
    // Start the emulators and run this file inside them.
    const self = path.relative(ROOT, fileURLToPath(import.meta.url)).split(path.sep).join('/');
    const child = spawn(`npx --yes firebase-tools@latest emulators:exec --only auth,firestore --project ${PROJECT} "node ${self}"`,
        { cwd: ROOT, stdio: 'inherit', shell: true });
    child.on('exit', (code) => process.exit(code ?? 1));
} else {
    main().catch((err) => {
        console.error(`\nMigration E2E FAILED: ${err && err.message ? err.message : err}${err?.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : ''}`);
        process.exit(1);
    });
}
