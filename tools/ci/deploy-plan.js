#!/usr/bin/env node
/**
 * Decides whether a push to main must deploy the Firestore rules and indexes
 * before Hosting (.github/workflows/firebase-hosting-merge.yml, job "plan").
 *
 * The rules go first when any of RULES_FILES changed since the last CONFIRMED
 * deploy: the newest successful run of that workflow on main whose Hosting
 * job really ran its "Deploy to Firebase Hosting" step (a run whose jobs were
 * skipped as stale does not count) -- not just this push. So a rules change
 * whose deploy failed (and so held Hosting back), or whose queued run was
 * replaced by a newer push, is still deployed before the next Hosting deploy.
 *
 * Fail safe: with no confirmed base -- the GitHub API failed, no such run was
 * found, or its commit is not an ancestor of this one -- the rules are
 * deployed (deploying unchanged rules is harmless: firebase-tools skips the
 * upload). The push's `before` is never used as a base.
 *
 * Env (set by the workflow): GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_RUN_ID,
 * GITHUB_SHA, WORKFLOW_FILE. Writes
 * rules=true|false, base=<sha> and files=<changed rules files> to
 * $GITHUB_OUTPUT and a line to $GITHUB_STEP_SUMMARY.
 * Needs the full history (actions/checkout fetch-depth: 0).
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');

const RULES_FILES = [
    'firestore.rules',
    'firestore.indexes.json',
    'happa.config.json',
    // Which rules/indexes files are deployed, and how.
    'firebase.json',
    '.github/workflows/firestore-rules-deploy.yml',
    'tools/ci/deploy-with-retry.js',
    'tools/ci/live-rules.js'
];

const HOSTING_JOB = 'Hosting';
const HOSTING_STEP = 'Deploy to Firebase Hosting';

const isSha = s => /^[0-9a-f]{7,40}$/i.test(s || '') && !/^0+$/.test(s);

/** The changed paths that mean "deploy the rules first". */
function rulesFilesIn(changed) {
    return changed.filter(f => RULES_FILES.includes(f));
}

/**
 * @param {{ deployedSha: string|null,
 *   git: { isAncestor(sha: string): boolean, changedFiles(base: string): string[] } }} o
 *   deployedSha: commit of the last confirmed deploy (null = unknown)
 * @returns {{ rules: boolean, base: string, files: string[], reason: string }}
 */
function planDeploy({ deployedSha, git }) {
    if (!isSha(deployedSha)) {
        return { rules: true, base: '', files: [], reason: 'no confirmed earlier deploy, so the rules are deployed to be safe' };
    }
    if (!git.isAncestor(deployedSha)) {
        return { rules: true, base: '', files: [], reason: `the last deployed commit ${deployedSha.slice(0, 7)} is not an ancestor of this one, so the rules are deployed to be safe` };
    }
    const files = rulesFilesIn(git.changedFiles(deployedSha));
    return {
        rules: files.length > 0,
        base: deployedSha,
        files,
        reason: files.length
            ? `changed since the last deploy (${deployedSha.slice(0, 7)}): ${files.join(', ')}`
            : `no rules, indexes or config change since the last deploy (${deployedSha.slice(0, 7)})`
    };
}

/** True when the run's Hosting job really deployed (not skipped as stale or after a failed rules deploy). */
function hostingDeployed(jobs) {
    return jobs.some(j => j.name === HOSTING_JOB && j.conclusion === 'success'
        && (j.steps || []).some(st => st.name === HOSTING_STEP && st.conclusion === 'success'));
}

/**
 * Head SHA of the newest successful run of `workflow` on main (other than
 * this one) whose Hosting job deployed, or null. Throws on API errors.
 */
async function lastDeployedSha({ repo, workflow, token, runId, fetchImpl = fetch }) {
    const get = async url => {
        const res = await fetchImpl(`https://api.github.com${url}`, {
            headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
        });
        if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
        return res.json();
    };
    const { workflow_runs: runs = [] } = await get(`/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=main&status=success&per_page=10`);
    for (const run of runs.filter(r => String(r.id) !== String(runId))) {
        const { jobs = [] } = await get(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
        if (hostingDeployed(jobs)) return run.head_sha;
    }
    return null;
}

function realGit(head) {
    const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return {
        isAncestor(sha) {
            try { git(['merge-base', '--is-ancestor', sha, head]); return true; } catch { return false; }
        },
        changedFiles(base) {
            return git(['diff', '--name-only', base, head]).split('\n').map(s => s.trim()).filter(Boolean);
        }
    };
}

async function main() {
    const env = process.env;
    let deployedSha = null;
    try {
        deployedSha = await lastDeployedSha({ repo: env.GITHUB_REPOSITORY, workflow: env.WORKFLOW_FILE, token: env.GITHUB_TOKEN, runId: env.GITHUB_RUN_ID });
        console.log(`Last confirmed deploy by ${env.WORKFLOW_FILE} on main: ${deployedSha || 'none'}`);
    } catch (err) {
        console.log(`::warning::Could not look up the last deploy (${err.message}); deploying the rules first to be safe.`);
    }
    const plan = planDeploy({ deployedSha, git: realGit(env.GITHUB_SHA || 'HEAD') });
    const line = plan.rules
        ? `Rules first: ${plan.reason}. Hosting waits for the rules deploy to succeed.`
        : `Rules unchanged: ${plan.reason}. Hosting deploys without a rules deploy.`;
    console.log(line);
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `rules=${plan.rules}\nbase=${plan.base}\nfiles=${plan.files.join(',')}\n`);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

if (require.main === module) {
    main().catch(err => {
        console.error(err && err.stack ? err.stack : err);
        process.exit(1);
    });
}

module.exports = { RULES_FILES, HOSTING_JOB, HOSTING_STEP, rulesFilesIn, planDeploy, hostingDeployed, lastDeployedSha };
