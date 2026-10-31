#!/usr/bin/env node
/**
 * Ops failure alert. Opens (or updates) one `ops` issue in Happa's repo
 * when the scheduled Firestore backup fails or is skipped two nights running,
 * when the monthly restore drill fails, or when the deploy on a push to main
 * (Firestore rules, then Hosting: firebase-hosting-merge.yml) fails, and
 * closes it once a later run succeeds. Only ever posts to DDancingDeath/happa
 * (never the old app's repo).
 *
 * It never comments: a repeat failure rewrites the open issue's
 * "Last failure: <run> at <time>" line (PATCH of the body), and a recovery
 * closes the issue with one PATCH.
 *
 * Env:
 *   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SERVER_URL
 *   ALERT_KIND      backup | drill | deploy
 *   EVENT_NAME      github.event_name
 *   CURRENT_GOOD    "true" when this run produced a verified backup / passed the drill
 *   ALERT_DRY_RUN   "true" prints the plan only
 */
'use strict';

const HAPPA_REPO = 'DDancingDeath/happa';
const LABEL = 'ops';
const KINDS = {
    backup: {
        marker: '<!-- backup-alert:backup -->',
        title: '[Ops] Firestore backup failed or skipped two nights running',
        workflow: 'firestore-backup.yml'
    },
    drill: {
        marker: '<!-- backup-alert:drill -->',
        title: '[Ops] Monthly backup restore drill failed',
        workflow: 'backup-restore-drill.yml'
    },
    deploy: {
        marker: '<!-- deploy-alert:main -->',
        title: '[Ops] Deploy to main failed (Firestore rules or Hosting)',
        workflow: 'firebase-hosting-merge.yml'
    }
};

/**
 * @param {{kind: 'backup'|'drill'|'deploy', event: string, currentGood: boolean, previousGood: boolean|null}} o
 *   previousGood: the previous scheduled run's result (null = no earlier run)
 * @returns {'open'|'resolve'|'none'}
 */
function decideAlert({ kind, event, currentGood, previousGood }) {
    if (currentGood) return 'resolve';
    if (kind !== 'backup') return 'open';
    // Backups: only scheduled nights count, and only two bad ones in a row.
    if (event === 'schedule' && previousGood === false) return 'open';
    return 'none';
}

/**
 * A finished scheduled backup run was good when it succeeded and kept a backup artifact
 * (a successful run without one was skipped by the size guard).
 * @param {{conclusion: string}} run
 * @param {{name: string}[]} artifacts
 * @returns {boolean}
 */
function runWasGood(run, artifacts) {
    return run.conclusion === 'success' && artifacts.some(a => a.name.startsWith('firestore-backup-'));
}

async function gh(method, url, body, { allowExisting = false } = {}) {
    if (/\/comments\b/.test(url)) throw new Error('alert.js never comments on issues');
    const res = await fetch(`https://api.github.com${url}`, {
        method,
        headers: {
            authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok && !(allowExisting && res.status === 422)) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
    return res.ok && res.status !== 204 ? res.json() : null;
}

async function previousScheduledRun(gh, repo, workflow, currentId) {
    const { workflow_runs: runs } = await gh('GET', `/repos/${repo}/actions/workflows/${workflow}/runs?event=schedule&status=completed&per_page=10`);
    const prev = runs.find(r => String(r.id) !== String(currentId));
    if (!prev) return null;
    const { artifacts } = await gh('GET', `/repos/${repo}/actions/runs/${prev.id}/artifacts?per_page=20`);
    return { run: prev, good: runWasGood(prev, artifacts) };
}

const LAST_FAILURE_RE = /^Last failure: .*$/m;

/** The issue body with its "Last failure: ..." line set to `line` (added at the end if missing). */
function withLastFailure(body, line) {
    const text = body || '';
    return LAST_FAILURE_RE.test(text) ? text.replace(LAST_FAILURE_RE, line) : `${text.trimEnd()}\n\n${line}`;
}

function guidance(kind) {
    return kind === 'deploy'
        ? 'If the Firestore rules deploy failed, Hosting was NOT deployed: the live app still runs the previous build. '
            + 'Open the run, read the failing step (a Firebase Rules API outage, a rules compile error or a missing IAM role) '
            + 'and use "Re-run failed jobs" on the LATEST failed run of "Deploy to Firebase on merge" (a re-run of an older run '
            + 'is skipped, so it cannot roll the site or the rules back); Hosting deploys once the rules are live. Manual fallback: '
            + '`firebase deploy --only firestore:rules,firestore:indexes`, then re-run the latest run. See AGENTS.md, "CI".'
        : 'Open the run, read the failing step, fix it and re-run the workflow (Actions → Run workflow). '
            + 'Common causes: an expired or removed service-account secret, a missing IAM role, the free read quota, '
            + 'or the size guard (`BACKUP_WEEKLY_ABOVE` / `BACKUP_HARD_MAX`). Steps: `tools/backup/README.md`.';
}

/**
 * Opens, updates or closes the alert issue. `request(method, url, body, opts)`
 * calls the GitHub REST API (injectable for tests); `now` gives the time.
 */
async function runAlert({ env = process.env, request = gh, now = () => new Date() } = {}) {
    const repo = env.GITHUB_REPOSITORY;
    if (repo !== HAPPA_REPO) {
        console.log(`Not ${HAPPA_REPO} (${repo}); alerts are off.`);
        return;
    }
    const kind = KINDS[env.ALERT_KIND] ? env.ALERT_KIND : 'backup';
    const cfg = KINDS[kind];
    const event = env.EVENT_NAME;
    const currentGood = env.CURRENT_GOOD === 'true';
    const runUrl = `${env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;
    const at = now().toISOString().replace(/\.\d+Z$/, 'Z');

    const prev = !currentGood && kind === 'backup' && event === 'schedule'
        ? await previousScheduledRun(request, repo, cfg.workflow, env.GITHUB_RUN_ID)
        : null;
    const action = decideAlert({ kind, event, currentGood, previousGood: prev ? prev.good : null });
    console.log(`${kind}: this run ${currentGood ? 'good' : 'bad'}${prev ? `, previous scheduled run ${prev.good ? 'good' : 'bad'}` : ''} -> ${action}`);
    if (action === 'none') return;

    const open = (await request('GET', `/repos/${repo}/issues?state=open&labels=${LABEL}&per_page=100`))
        .find(i => !i.pull_request && (i.body || '').includes(cfg.marker));
    const dry = env.ALERT_DRY_RUN === 'true';

    if (action === 'resolve') {
        if (!open) return;
        console.log(`Closing #${open.number}`);
        if (dry) return;
        await request('PATCH', `/repos/${repo}/issues/${open.number}`, {
            state: 'closed',
            state_reason: 'completed',
            body: `${(open.body || '').trimEnd()}\n\nRecovered: ${runUrl} succeeded at ${at}.`
        });
        return;
    }

    const lastFailure = `Last failure: ${runUrl} at ${at}` + (prev ? ` (previous night: ${prev.run.html_url})` : '');
    if (open) {
        console.log(`Updating #${open.number}: ${lastFailure}`);
        if (!dry) await request('PATCH', `/repos/${repo}/issues/${open.number}`, { body: withLastFailure(open.body, lastFailure) });
        return;
    }
    const note = {
        backup: 'The scheduled backup failed or was skipped two nights running.',
        drill: 'The monthly restore drill failed.',
        deploy: 'The deploy of main failed.'
    }[kind];
    const body = `${cfg.marker}\n${note}\n\n${guidance(kind)}\n\nThis issue closes itself when a later run succeeds.\n\n${lastFailure}`;
    console.log('Opening a new issue');
    if (dry) return;
    await request('POST', `/repos/${repo}/labels`, { name: LABEL, color: 'd93f0b', description: 'Operations: backups, deploys, monitoring' }, { allowExisting: true });
    await request('POST', `/repos/${repo}/issues`, { title: cfg.title, body, labels: [LABEL] });
}

if (require.main === module) {
    runAlert().catch(err => {
        console.error(`Alert failed: ${err && err.message ? err.message : err}`);
        process.exit(1);
    });
}

module.exports = { HAPPA_REPO, decideAlert, runWasGood, runAlert, withLastFailure };
