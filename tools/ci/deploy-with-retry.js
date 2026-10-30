#!/usr/bin/env node
/**
 * Runs the Firestore rules/indexes deploy and retries it when Google's APIs
 * have a transient outage (e.g. HTTP 503 "The service is currently
 * unavailable" from firebaserules.googleapis.com, 500, 429, ECONNRESET,
 * deadline exceeded). Rules compile errors and permission errors fail at once
 * with a hint; anything unrecognised also fails without a retry.
 *
 * Usage (from .github/workflows/firestore-rules-deploy.yml):
 *   node tools/ci/deploy-with-retry.js --log <file> --project <id> \
 *     [--sa-email <email>] -- <deploy command...>
 *
 * DEPLOY_RETRY_DELAYS (comma-separated seconds) overrides the waits between
 * attempts (default 30,60,120 = 4 attempts); tests set it to 0,0,0.
 */
const { spawn } = require('child_process');
const fs = require('fs');

const DEFAULT_DELAYS_S = [30, 60, 120];
const REFUSED_PROJECTS = ['aadhat-management'];

const PERMISSION_RE = /permission|\b403\b|forbidden|denied/i;
// Not "compilation errors..." alone: firebase-tools prints "checking
// firestore.rules for compilation errors..." on every deploy.
const COMPILE_RE = /compilation errors in |\[E\]\s*\d+:\d+/i;
const TRANSIENT_RE = /\b(500|502|503|504|429)\b|unavailable|ECONNRESET|ETIMEDOUT|socket hang up|deadline/i;

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** 'permission' | 'compile' | 'transient' | 'unknown' for a failed deploy's output. */
function classify(log) {
    const text = stripAnsi(log);
    if (PERMISSION_RE.test(text)) return 'permission';
    if (COMPILE_RE.test(text)) return 'compile';
    if (TRANSIENT_RE.test(text)) return 'transient';
    return 'unknown';
}

function parseDelays(value) {
    if (value === undefined || value === '') return DEFAULT_DELAYS_S;
    const delays = String(value).split(',').map(s => Number(s.trim()));
    if (delays.some(d => !Number.isFinite(d) || d < 0)) {
        throw new Error(`Bad DEPLOY_RETRY_DELAYS: ${value}`);
    }
    return delays;
}

function parseArgs(argv) {
    const sep = argv.indexOf('--');
    if (sep === -1 || sep === argv.length - 1) {
        throw new Error('Missing deploy command after "--"');
    }
    const opts = { log: null, project: '', saEmail: '', command: argv.slice(sep + 1) };
    const flags = argv.slice(0, sep);
    for (let i = 0; i < flags.length; i++) {
        const value = flags[i + 1];
        if (flags[i] === '--log') { opts.log = value; i++; }
        else if (flags[i] === '--project') { opts.project = value; i++; }
        else if (flags[i] === '--sa-email') { opts.saEmail = value; i++; }
        else throw new Error(`Unknown option: ${flags[i]}`);
    }
    if (!opts.log) throw new Error('--log is required');
    return opts;
}

/** Runs the command once, echoing its output; resolves { code, output }. */
function runOnce(command) {
    return new Promise(resolve => {
        const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const onData = stream => chunk => {
            output += chunk;
            stream.write(chunk);
        };
        child.stdout.on('data', onData(process.stdout));
        child.stderr.on('data', onData(process.stderr));
        child.on('error', err => resolve({ code: 127, output: output + `\n${err.message}\n` }));
        child.on('close', code => resolve({ code: code === null ? 1 : code, output }));
    });
}

const sleep = s => new Promise(r => setTimeout(r, s * 1000));

function permissionHint(saEmail, project, log) {
    console.log(`::error title=Service account is missing roles::The deploy was refused for ${saEmail || 'the service account'}. In Google Cloud console -> IAM & Admin -> IAM (project ${project}), edit that github-action service account and add the roles 'Firebase Rules Admin' (roles/firebaserules.admin) and 'Cloud Datastore Index Admin' (roles/datastore.indexAdmin); if the log mentions serviceusage, also add 'Service Usage Consumer' (roles/serviceusage.serviceUsageConsumer). Then re-run this workflow. Until then deploy by hand: firebase deploy --only firestore:rules,firestore:indexes`);
    console.log('Permission-related lines from the log:');
    stripAnsi(log).split(/\r?\n/).filter(l => PERMISSION_RE.test(l)).slice(0, 20).forEach(l => console.log(l));
}

/**
 * Deploys with retries; resolves the exit code (0 on success).
 * `run` and `wait` are injectable for tests.
 */
async function deployWithRetry(opts, { run = runOnce, wait = sleep, delays = DEFAULT_DELAYS_S } = {}) {
    if (REFUSED_PROJECTS.includes(opts.project)) {
        console.log(`::error::Refusing to deploy to ${opts.project}.`);
        return 1;
    }
    if (opts.command.includes('--force')) {
        console.log('::error::Refusing to deploy with --force (it would delete indexes that exist only in the console).');
        return 1;
    }
    const maxAttempts = delays.length + 1;
    let fullLog = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`Deploy attempt ${attempt}/${maxAttempts}`);
        const { code, output } = await run(opts.command);
        fullLog += `--- attempt ${attempt}/${maxAttempts} ---\n${output}\n`;
        fs.writeFileSync(opts.log, fullLog);
        if (code === 0) return 0;

        const kind = classify(output);
        if (kind === 'permission') {
            permissionHint(opts.saEmail, opts.project, output);
            return 1;
        }
        if (kind === 'compile') {
            console.log('::error title=Firestore rules did not compile::Fix firestore.rules (see the compile errors above); not retrying.');
            return 1;
        }
        if (kind !== 'transient') {
            console.log('::error::Firestore rules/indexes deploy failed; see the log above.');
            return 1;
        }
        if (attempt === maxAttempts) {
            console.log(`::error title=Firebase API unavailable::Deploy still failing with a transient error after ${maxAttempts} attempts; re-run this workflow later.`);
            return 1;
        }
        const delay = delays[attempt - 1];
        console.log(`::warning::Transient Firebase API error on attempt ${attempt}/${maxAttempts}; retrying in ${delay}s.`);
        await wait(delay);
    }
    return 1;
}

if (require.main === module) {
    let opts;
    let delays;
    try {
        opts = parseArgs(process.argv.slice(2));
        delays = parseDelays(process.env.DEPLOY_RETRY_DELAYS);
    } catch (err) {
        console.error(err.message);
        process.exit(2);
    }
    deployWithRetry(opts, { delays }).then(code => process.exit(code));
}

module.exports = { classify, parseArgs, parseDelays, deployWithRetry, DEFAULT_DELAYS_S };
