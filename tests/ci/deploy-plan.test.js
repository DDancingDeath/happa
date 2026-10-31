/**
 * @jest-environment node
 */
// tools/ci/deploy-plan.js: does a push to main deploy the Firestore rules
// before Hosting? Fake git and GitHub API. Fail safe: no confirmed base ->
// rules first.
const { planDeploy, lastDeployedSha, HOSTING_JOB, HOSTING_STEP } = require('../../tools/ci/deploy-plan');

const DEPLOYED = 'a'.repeat(40);
const ZERO = '0'.repeat(40);

/** Fake git: `history` = SHAs that are ancestors of HEAD; `changes` = files changed since each base. */
function fakeGit(history, changes) {
    const diffs = [];
    return {
        diffs,
        isAncestor: sha => history.includes(sha),
        changedFiles: base => { diffs.push(base); return changes[base] || []; }
    };
}

test.each([
    ['firestore.rules'], ['firestore.indexes.json'], ['happa.config.json'], ['firebase.json'],
    ['.github/workflows/firestore-rules-deploy.yml'], ['tools/ci/deploy-with-retry.js'], ['tools/ci/live-rules.js']
])('%s changed since the last deploy -> rules first', file => {
    const git = fakeGit([DEPLOYED], { [DEPLOYED]: ['www/js/main.js', file] });
    expect(planDeploy({ deployedSha: DEPLOYED, git })).toMatchObject({ rules: true, base: DEPLOYED, files: [file] });
});

test('app-only changes since a confirmed deploy -> Hosting without a rules deploy', () => {
    const git = fakeGit([DEPLOYED], { [DEPLOYED]: ['www/js/main.js', 'rules-tests/test.js', 'AGENTS.md', 'www/firestore.rules.txt'] });
    expect(planDeploy({ deployedSha: DEPLOYED, git })).toMatchObject({ rules: false, base: DEPLOYED, files: [] });
});

test('no confirmed base (API error / no deployed run / zero sha) -> rules first, without diffing', () => {
    const git = fakeGit([DEPLOYED], { [DEPLOYED]: ['www/js/main.js'] });
    for (const deployedSha of [null, undefined, '', ZERO]) {
        expect(planDeploy({ deployedSha, git })).toMatchObject({ rules: true, base: '' });
    }
    expect(git.diffs).toEqual([]);
});

test('the last deployed commit is not an ancestor of HEAD (rewritten history) -> rules first', () => {
    const git = fakeGit([], { [DEPLOYED]: ['www/js/main.js'] });
    expect(planDeploy({ deployedSha: DEPLOYED, git })).toMatchObject({ rules: true, base: '' });
    expect(git.diffs).toEqual([]);
});

describe('lastDeployedSha', () => {
    const deployedJobs = [{ name: HOSTING_JOB, conclusion: 'success', steps: [{ name: HOSTING_STEP, conclusion: 'success' }] }];
    const staleJobs = [{ name: HOSTING_JOB, conclusion: 'success', steps: [{ name: HOSTING_STEP, conclusion: 'skipped' }] }];
    const skippedHosting = [{ name: HOSTING_JOB, conclusion: 'skipped', steps: [] }];

    function fakeApi(runs, jobsByRun, { status = 200 } = {}) {
        const urls = [];
        const fetchImpl = async url => {
            urls.push(url);
            if (status !== 200) return { ok: false, status };
            const m = url.match(/\/actions\/runs\/(\d+)\/jobs/);
            return { ok: true, json: async () => (m ? { jobs: jobsByRun[m[1]] || [] } : { workflow_runs: runs }) };
        };
        return { urls, fetchImpl };
    }
    const ask = api => lastDeployedSha({ repo: 'DDancingDeath/happa', workflow: 'firebase-hosting-merge.yml', token: 't', runId: '7', fetchImpl: api.fetchImpl });

    test('skips this run and runs whose Hosting step did not deploy (stale or skipped)', async () => {
        const api = fakeApi(
            [{ id: 7, head_sha: 'current' }, { id: 6, head_sha: 'stale' }, { id: 5, head_sha: 'skipped' }, { id: 4, head_sha: DEPLOYED }],
            { 7: deployedJobs, 6: staleJobs, 5: skippedHosting, 4: deployedJobs }
        );
        await expect(ask(api)).resolves.toBe(DEPLOYED);
        expect(api.urls[0]).toMatch(/\/actions\/workflows\/firebase-hosting-merge\.yml\/runs\?branch=main&status=success/);
        expect(api.urls.some(u => u.includes('/runs/7/jobs'))).toBe(false);
    });

    test('null when no successful run deployed', async () => {
        await expect(ask(fakeApi([], {}))).resolves.toBeNull();
        await expect(ask(fakeApi([{ id: 6, head_sha: 'stale' }], { 6: staleJobs }))).resolves.toBeNull();
    });

    test('throws on an API error (main() then deploys the rules first)', async () => {
        await expect(ask(fakeApi([], {}, { status: 502 }))).rejects.toThrow(/502/);
    });
});
