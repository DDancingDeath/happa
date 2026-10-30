/**
 * @jest-environment node
 */
// tools/ci/deploy-with-retry.js: retries the Firestore rules deploy on
// transient Google API errors, fails fast on compile/permission errors.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { classify } = require('../../tools/ci/deploy-with-retry');

const SCRIPT = path.join(__dirname, '../../tools/ci/deploy-with-retry.js');
const FAKE = path.join(__dirname, 'fake-firebase.js');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(__dirname, '.work-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function deploy(outcomes, { project = 'happa-test', extraArgs = [] } = {}) {
    const log = path.join(dir, 'deploy.log');
    const argsLog = path.join(dir, 'args.log');
    const res = spawnSync(process.execPath, [
        SCRIPT, '--log', log, '--project', project, '--sa-email', 'ci@happa-test.iam.gserviceaccount.com',
        '--', process.execPath, FAKE, 'deploy', '--only', 'firestore:rules,firestore:indexes', ...extraArgs
    ], {
        encoding: 'utf8',
        env: {
            ...process.env,
            DEPLOY_RETRY_DELAYS: '0,0,0',
            FAKE_OUTCOMES: outcomes.join(','),
            FAKE_STATE: path.join(dir, 'state'),
            FAKE_ARGS_LOG: argsLog
        }
    });
    const calls = fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    return { code: res.status, out: res.stdout + res.stderr, calls, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

test('succeeds first time without retrying', () => {
    const r = deploy(['ok']);
    expect(r.code).toBe(0);
    expect(r.calls).toBe(1);
});

test.each([['503'], ['500'], ['429'], ['reset']])('retries a transient %s and then succeeds', kind => {
    const r = deploy([kind, kind, 'ok']);
    expect(r.code).toBe(0);
    expect(r.calls).toBe(3);
    expect(r.out).toMatch(/::warning::Transient Firebase API error on attempt 2\/4/);
    expect(r.log).toMatch(/attempt 3\/4/);
});

test('gives up after 4 attempts of transient errors', () => {
    const r = deploy(['503']);
    expect(r.code).toBe(1);
    expect(r.calls).toBe(4);
    expect(r.out).toMatch(/::error title=Firebase API unavailable::.*after 4 attempts/);
});

test('fails fast on a rules compile error', () => {
    const r = deploy(['compile', 'ok']);
    expect(r.code).toBe(1);
    expect(r.calls).toBe(1);
    expect(r.out).toMatch(/::error title=Firestore rules did not compile::/);
});

test('fails fast on a permission error with the IAM hint', () => {
    const r = deploy(['permission', 'ok']);
    expect(r.code).toBe(1);
    expect(r.calls).toBe(1);
    expect(r.out).toMatch(/::error title=Service account is missing roles::.*ci@happa-test\.iam\.gserviceaccount\.com.*roles\/firebaserules\.admin/);
});

test('fails fast on an unrecognised error', () => {
    const r = deploy(['weird', 'ok']);
    expect(r.code).toBe(1);
    expect(r.calls).toBe(1);
    expect(r.out).toMatch(/::error::Firestore rules\/indexes deploy failed/);
});

test('refuses aadhat-management and --force without running the deploy', () => {
    expect(deploy(['ok'], { project: 'aadhat-management' })).toMatchObject({ code: 1, calls: 0 });
    expect(deploy(['ok'], { extraArgs: ['--force'] })).toMatchObject({ code: 1, calls: 0 });
});

test('the "checking ... for compilation errors" progress line is not a compile error', () => {
    const log = "i  cloud.firestore: checking firestore.rules for compilation errors...\n\n" +
        'Error: Request to https://firebaserules.googleapis.com/v1/projects/happa-bfc07:test had HTTP Error: 503, The service is currently unavailable.';
    expect(classify(log)).toBe('transient');
    expect(classify('Error: 4 DEADLINE_EXCEEDED: Deadline exceeded')).toBe('transient');
});
