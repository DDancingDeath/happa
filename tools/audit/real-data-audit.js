#!/usr/bin/env node
/**
 * Offline real-data number audit (#216).
 *
 *   npm run audit:numbers -- <backup.json> [--bundle <migration bundle.json>]
 *       [--out <report.md>] [--json <details.json>] [--app <checkout>] [--compare <other details.json>] [--days 60] [--months 24] [--now <ISO>]
 *       [--phone-dates 2026-10-01,2026-03-31T09:00] [--no-phone]
 *
 * Loads a backup file (tools/backup format) and, for each day of the last 60
 * days, each month of the last 24 months and all time, computes every number in
 * docs/calculations.md twice: with the independent oracle (tests/oracle) and with
 * the app's own code (the functions the screens use, in jsdom). Differences over
 * ₹1 / 0.01 kg, the accounting checks AC1–AC8, cross-page consistency and the
 * Diagnostics number checks go into a Markdown report. The phone path
 * (tools/audit/phone.js: windowed history, month snapshots, stock checkpoint,
 * rate history and cash sessions through the app's loaders) is audited for
 * several "today"s (--phone-dates to choose them, --no-phone to skip it).
 *
 * The report is written next to the backup by default (NUMBER-AUDIT.md), never
 * into the repo. It has counts, spec IDs, periods and amounts, no party names.
 * Reads only the file you pass: no Firestore, no network. Never run in CI.
 * --app audits another checkout's www/ (e.g. a git worktree of a fix branch)
 * with this checkout's oracle; --compare adds a before/after table against the
 * details JSON of an earlier run (e.g. main vs a fix branch). Exit code 1 when
 * anything disagrees.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');

function parseArgs(argv) {
    const o = { days: 60, months: 24 };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const val = () => {
            if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
            return argv[++i];
        };
        if (a === '--bundle') o.bundle = val();
        else if (a === '--out') o.out = val();
        else if (a === '--json') o.json = val();
        else if (a === '--app') o.app = val();
        else if (a === '--compare') o.compare = val();
        else if (a === '--days') o.days = Number(val());
        else if (a === '--months') o.months = Number(val());
        else if (a === '--now') o.now = val();
        else if (a === '--phone-dates') o.phoneDates = val();
        else if (a === '--no-phone') o.noPhone = true;
        else if (a === '-h' || a === '--help') o.help = true;
        else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
        else rest.push(a);
    }
    o.backup = rest[0];
    return o;
}

function gitRef(dir) {
    try {
        const sha = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
        const branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
        return `${branch}@${sha}`;
    } catch {
        return 'unknown';
    }
}

/** The report must stay out of the repo (it is real shop data). */
function insideRepo(file) {
    const rel = path.relative(ROOT, path.resolve(file));
    return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function main() {
    let o;
    try {
        o = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(e.message);
        process.exit(2);
    }
    if (o.help || !o.backup) {
        console.log('Usage: npm run audit:numbers -- <backup.json> [--bundle <bundle.json>] [--out <report.md>] [--json <details.json>] [--app <checkout>] [--compare <other details.json>] [--days N] [--months N] [--now ISO] [--phone-dates D1,D2] [--no-phone]');
        process.exit(o.help ? 0 : 2);
    }
    const backup = path.resolve(o.backup);
    if (!fs.existsSync(backup)) {
        console.error(`No such file: ${backup}`);
        process.exit(2);
    }
    const out = path.resolve(o.out || path.join(path.dirname(backup), 'NUMBER-AUDIT.md'));
    const json = o.json ? path.resolve(o.json) : path.join(path.dirname(out), 'number-audit.json');
    for (const f of [out, json]) {
        if (insideRepo(f)) {
            console.error(`Refusing to write ${f}: audit output is real shop data and must stay outside the repo.`);
            process.exit(2);
        }
    }
    const appRoot = path.resolve(o.app || ROOT);
    const env = {
        ...process.env,
        TZ: 'Asia/Kolkata',
        AUDIT_BACKUP: backup,
        AUDIT_OUT: out,
        AUDIT_JSON: json,
        AUDIT_APP_ROOT: appRoot,
        AUDIT_APP_REF: gitRef(appRoot),
        AUDIT_DAYS: String(o.days),
        AUDIT_MONTHS: String(o.months)
    };
    if (o.bundle) env.AUDIT_BUNDLE = path.resolve(o.bundle);
    if (o.now) env.AUDIT_NOW = o.now;
    if (o.compare) env.AUDIT_COMPARE = path.resolve(o.compare);
    if (o.phoneDates) env.AUDIT_PHONE_DATES = o.phoneDates;
    if (o.noPhone) env.AUDIT_PHONE = '0';

    const jest = require.resolve('jest/bin/jest', { paths: [ROOT] });
    const r = spawnSync(process.execPath, [jest, '--config', path.join(__dirname, 'jest.audit.config.js'), '--runInBand', '--silent', '--forceExit'], {
        cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit']
    });
    if (r.status !== 0 || !fs.existsSync(json)) {
        console.error('The audit run failed (see above).');
        process.exit(r.status || 1);
    }
    const res = JSON.parse(fs.readFileSync(json, 'utf8'));
    const by = {};
    res.mismatches.forEach(m => {
        const k = `${m.scope.padEnd(8)} ${m.spec} (${m.page})`;
        by[k] = (by[k] || 0) + 1;
    });
    const total = Object.values(res.checked).reduce((a, b) => a + b, 0);
    const unexplained = res.mismatches.filter(m => m.cause === 'new' || /\bnew\b/.test(String(m.cause))).length;
    console.log(`\nApp code ${res.appRef}: ${total} comparisons, ${res.mismatches.length} mismatches (${unexplained} not explained), `
        + `${(res.unknowns || []).length} shown as unknown / approximate, ${(res.ms / 1000).toFixed(1)} s.`);
    Object.entries(by).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(5)}  ${k}`));
    console.log(`Report: ${out}`);
    process.exit(res.mismatches.length ? 1 : 0);
}

main();
