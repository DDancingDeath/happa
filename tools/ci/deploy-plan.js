#!/usr/bin/env node
/**
 * Decides whether a push to main must deploy the Firestore rules and indexes
 * before Hosting (.github/workflows/firebase-hosting-merge.yml, job "plan").
 *
 * The rules go first when any of RULES_FILES changed since the commit of the
 * last successful run of that workflow on main -- not just in this push --
 * so a rules change whose deploy failed (and so held Hosting back), or whose
 * queued run was replaced by a newer push, is still deployed before the next
 * Hosting deploy. If that run cannot be found, the push's `before` commit is
 * the base; if neither is in this checkout's history, the rules are deployed
 * (deploying unchanged rules is harmless: firebase-tools skips the upload).
 *
 * Env (set by the workflow): GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_RUN_ID,
 * GITHUB_SHA, WORKFLOW_FILE, BEFORE (github.event.before). Writes
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

const isSha = s => /^[0-9a-f]{7,40}$/i.test(s || '') && !/^0+$/.test(s);

/** The changed paths that mean "deploy the rules first". */
function rulesFilesIn(changed) {
    return changed.filter(f => RULES_FILES.includes(f));
}

/**
 * @param {{ lastSuccessSha: string|null, before: string|null,
 *   git: { isAncestor(sha: string): boolean, changedFiles(base: string): string[] } }} o
 * @returns {{ rules: boolean, base: string, files: string[], reason: string }}
 */
function planDeploy({ lastSuccessSha, before, git }) {
    const candidates = [
        { sha: lastSuccessSha, what: 'the last successful deploy' },
        { sha: before, what: "this push's previous head" }
    ].filter(c => isSha(c.sha));
    const base = candidates.find(c => git.isAncestor(c.sha));
    if (!base) {
        return { rules: true, base: '', files: [], reason: 'no earlier deployed commit in the history, so the rules are deployed to be safe' };
    }
    const files = rulesFilesIn(git.changedFiles(base.sha));
    return {
        rules: files.length > 0,
        base: base.sha,
        files,
        reason: files.length
            ? `changed since ${base.what} (${base.sha.slice(0, 7)}): ${files.join(', ')}`
            : `no rules, indexes or config change since ${base.what} (${base.sha.slice(0, 7)})`
    };
}

/** Head SHA of the newest successful run of `workflow` on main other than this one, or null. */
async function lastSuccessfulSha({ repo, workflow, token, runId, fetchImpl = fetch }) {
    const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=main&status=success&per_page=10`;
    const res = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
    });
    if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
    const { workflow_runs: runs = [] } = await res.json();
    const run = runs.find(r => String(r.id) !== String(runId));
    return run ? run.head_sha : null;
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
    let lastSuccessSha = null;
    try {
        lastSuccessSha = await lastSuccessfulSha({ repo: env.GITHUB_REPOSITORY, workflow: env.WORKFLOW_FILE, token: env.GITHUB_TOKEN, runId: env.GITHUB_RUN_ID });
        console.log(`Last successful ${env.WORKFLOW_FILE} run on main: ${lastSuccessSha || 'none'}`);
    } catch (err) {
        console.log(`::warning::Could not look up the last successful deploy (${err.message}); using the push's previous head.`);
    }
    const plan = planDeploy({ lastSuccessSha, before: env.BEFORE, git: realGit(env.GITHUB_SHA || 'HEAD') });
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

module.exports = { RULES_FILES, rulesFilesIn, planDeploy, lastSuccessfulSha };
