/**
 * @jest-environment node
 */
// tools/ci/deploy-with-retry.js: retries the Firestore rules deploy on
// transient Google API errors, fails fast on compile/permission errors.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { classify, deployWithRetry } = require('../../tools/ci/deploy-with-retry');

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

describe('409 "Release ... already exists"', () => {
    /** Runs deployWithRetry in-process against the fake firebase with a fake live-ruleset check. */
    async function deploy409(outcomes, liveChecks) {
        const env = {
            ...process.env,
            FAKE_OUTCOMES: outcomes.join(','),
            FAKE_STATE: path.join(dir, 'state'),
            FAKE_ARGS_LOG: path.join(dir, 'args.log')
        };
        const run = async command => {
            const res = spawnSync(command[0], command.slice(1), { encoding: 'utf8', env });
            return { code: res.status, output: res.stdout + res.stderr };
        };
        const lines = [];
        jest.spyOn(console, 'log').mockImplementation(l => lines.push(l));
        let checks = 0;
        const verifyLive = liveChecks && (async () => liveChecks[checks++]);
        const code = await deployWithRetry({
            log: path.join(dir, 'deploy.log'),
            project: 'happa-test',
            command: [process.execPath, FAKE, 'deploy', '--only', 'firestore:rules,firestore:indexes']
        }, { run, delays: [0, 0, 0], wait: async () => {}, verifyLive });
        const calls = fs.readFileSync(path.join(dir, 'args.log'), 'utf8').trim().split('\n').length;
        return { code, calls, checks, out: lines.join('\n') };
    }

    test('counts as deployed when the live ruleset equals the repo\'s', async () => {
        const r = await deploy409(['409', 'ok'], [{ ok: true, reason: 'identical' }]);
        expect(r).toMatchObject({ code: 0, calls: 1, checks: 1 });
        expect(r.out).toMatch(/::notice title=409 Release already exists::.*equals the repo's firestore.rules/);
    });

    test('is retried when the live ruleset differs, then succeeds', async () => {
        const r = await deploy409(['409', 'ok'], [{ ok: false, reason: 'first difference at line 4' }]);
        expect(r).toMatchObject({ code: 0, calls: 2, checks: 1 });
        expect(r.out).toMatch(/::warning::409 Release already exists, and the live ruleset is not the repo's \(first difference at line 4\)/);
        expect(r.out).toMatch(/::warning::409 on the release on attempt 1\/4; retrying/);
    });

    test('fails after the last attempt if the live ruleset never matches', async () => {
        const differs = { ok: false, reason: 'differs' };
        const r = await deploy409(['409'], [differs, differs, differs, differs]);
        expect(r).toMatchObject({ code: 1, calls: 4, checks: 4 });
        expect(r.out).toMatch(/::error title=Firebase API unavailable::.*after 4 attempts \(last: release-exists\)/);
    });

    test('without --rules (no live check) it is retried like a 503', () => {
        const r = deploy(['409', 'ok']);
        expect(r.code).toBe(0);
        expect(r.calls).toBe(2);
        expect(r.out).toMatch(/no --rules given/);
    });

    test('the real 409 message is release-exists; other 409s are transient', () => {
        const log = 'i  cloud.firestore: checking firestore.rules for compilation errors...\n' +
            'Error: Request to https://firebaserules.googleapis.com/v1/projects/happa-bfc07/releases had HTTP Error: 409, Release projects/happa-bfc07/releases/cloud.firestore already exists.';
        expect(classify(log)).toBe('release-exists');
        expect(classify('Error: HTTP Error: 409, Index already exists.')).toBe('transient');
        expect(classify('Error: HTTP Error: 502, Bad Gateway')).toBe('transient');
    });
});
