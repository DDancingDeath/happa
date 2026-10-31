/**
 * @jest-environment node
 */
// tools/ci/deploy-plan.js: does a push to main deploy the Firestore rules
// before Hosting? Fake git and GitHub API.
const { planDeploy, lastSuccessfulSha } = require('../../tools/ci/deploy-plan');

const LAST = 'a'.repeat(40);
const BEFORE = 'b'.repeat(40);
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
])('%s changed since the last successful deploy -> rules first', file => {
    const git = fakeGit([LAST, BEFORE], { [LAST]: ['www/js/main.js', file] });
    expect(planDeploy({ lastSuccessSha: LAST, before: BEFORE, git })).toMatchObject({ rules: true, base: LAST, files: [file] });
});

test('app-only changes -> Hosting without a rules deploy', () => {
    const git = fakeGit([LAST], { [LAST]: ['www/js/main.js', 'rules-tests/test.js', 'AGENTS.md', 'www/firestore.rules.txt'] });
    expect(planDeploy({ lastSuccessSha: LAST, before: BEFORE, git })).toMatchObject({ rules: false, base: LAST, files: [] });
});

test('a rules change from an earlier push whose deploy failed is still deployed by a later app-only push', () => {
    // The previous push (BEFORE) changed the rules, its rules deploy failed, so the last success is older.
    const git = fakeGit([LAST, BEFORE], { [LAST]: ['firestore.rules', 'www/js/main.js'], [BEFORE]: ['www/js/main.js'] });
    const plan = planDeploy({ lastSuccessSha: LAST, before: BEFORE, git });
    expect(plan).toMatchObject({ rules: true, base: LAST });
    expect(git.diffs).toEqual([LAST]);
});

test('falls back to the push\'s previous head when the last success is unknown or not in the history', () => {
    const git = fakeGit([BEFORE], { [BEFORE]: ['firestore.indexes.json'] });
    expect(planDeploy({ lastSuccessSha: null, before: BEFORE, git })).toMatchObject({ rules: true, base: BEFORE });
    expect(planDeploy({ lastSuccessSha: LAST, before: BEFORE, git })).toMatchObject({ rules: true, base: BEFORE });
});

test('no usable base (first push, rewritten history) -> deploy the rules to be safe', () => {
    const git = fakeGit([], {});
    expect(planDeploy({ lastSuccessSha: LAST, before: BEFORE, git })).toMatchObject({ rules: true, base: '' });
    expect(planDeploy({ lastSuccessSha: null, before: ZERO, git })).toMatchObject({ rules: true, base: '' });
    expect(git.diffs).toEqual([]);
});

test('lastSuccessfulSha skips the current run and asks only for successful runs on main', async () => {
    const urls = [];
    const fetchImpl = async url => {
        urls.push(url);
        return { ok: true, json: async () => ({ workflow_runs: [{ id: 7, head_sha: 'current' }, { id: 6, head_sha: LAST }] }) };
    };
    await expect(lastSuccessfulSha({ repo: 'DDancingDeath/happa', workflow: 'firebase-hosting-merge.yml', token: 't', runId: '7', fetchImpl })).resolves.toBe(LAST);
    expect(urls[0]).toMatch(/\/actions\/workflows\/firebase-hosting-merge\.yml\/runs\?branch=main&status=success/);
    const none = async () => ({ ok: true, json: async () => ({ workflow_runs: [] }) });
    await expect(lastSuccessfulSha({ repo: 'r', workflow: 'w', token: 't', runId: '1', fetchImpl: none })).resolves.toBeNull();
    const down = async () => ({ ok: false, status: 502 });
    await expect(lastSuccessfulSha({ repo: 'r', workflow: 'w', token: 't', runId: '1', fetchImpl: down })).rejects.toThrow(/502/);
});
