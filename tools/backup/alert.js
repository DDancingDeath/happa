#!/usr/bin/env node
/**
 * Backup failure alert. Opens (or comments on) one `ops` issue in Happa's repo
 * when the scheduled Firestore backup fails or is skipped two nights running,
 * or when the monthly restore drill fails, and closes it once a later run
 * succeeds. Only ever posts to DDancingDeath/happa (never the old app's repo).
 *
 * Env:
 *   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SERVER_URL
 *   ALERT_KIND      backup | drill
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
    }
};

/**
 * @param {{kind: 'backup'|'drill', event: string, currentGood: boolean, previousGood: boolean|null}} o
 *   previousGood: the previous scheduled run's result (null = no earlier run)
 * @returns {'open'|'resolve'|'none'}
 */
function decideAlert({ kind, event, currentGood, previousGood }) {
    if (currentGood) return 'resolve';
    if (kind === 'drill') return 'open';
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

async function previousScheduledRun(repo, workflow, currentId) {
    const { workflow_runs: runs } = await gh('GET', `/repos/${repo}/actions/workflows/${workflow}/runs?event=schedule&status=completed&per_page=10`);
    const prev = runs.find(r => String(r.id) !== String(currentId));
    if (!prev) return null;
    const { artifacts } = await gh('GET', `/repos/${repo}/actions/runs/${prev.id}/artifacts?per_page=20`);
    return { run: prev, good: runWasGood(prev, artifacts) };
}

async function main() {
    const repo = process.env.GITHUB_REPOSITORY;
    if (repo !== HAPPA_REPO) {
        console.log(`Not ${HAPPA_REPO} (${repo}); alerts are off.`);
        return;
    }
    const kind = KINDS[process.env.ALERT_KIND] ? process.env.ALERT_KIND : 'backup';
    const cfg = KINDS[kind];
    const event = process.env.EVENT_NAME;
    const currentGood = process.env.CURRENT_GOOD === 'true';
    const runUrl = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;

    const prev = !currentGood && kind === 'backup' && event === 'schedule'
        ? await previousScheduledRun(repo, cfg.workflow, process.env.GITHUB_RUN_ID)
        : null;
    const action = decideAlert({ kind, event, currentGood, previousGood: prev ? prev.good : null });
    console.log(`${kind}: this run ${currentGood ? 'good' : 'bad'}${prev ? `, previous scheduled run ${prev.good ? 'good' : 'bad'}` : ''} -> ${action}`);
    if (action === 'none') return;

    const open = (await gh('GET', `/repos/${repo}/issues?state=open&labels=${LABEL}&per_page=100`))
        .find(i => !i.pull_request && (i.body || '').includes(cfg.marker));
    const dry = process.env.ALERT_DRY_RUN === 'true';

    if (action === 'resolve') {
        if (!open) return;
        console.log(`Closing #${open.number}`);
        if (dry) return;
        await gh('POST', `/repos/${repo}/issues/${open.number}/comments`, { body: `Recovered: ${runUrl} succeeded.` });
        await gh('PATCH', `/repos/${repo}/issues/${open.number}`, { state: 'closed', state_reason: 'completed' });
        return;
    }

    const note = kind === 'backup'
        ? `The scheduled backup failed or was skipped again: ${runUrl}` + (prev ? ` (previous night: ${prev.run.html_url})` : '')
        : `The restore drill failed: ${runUrl}`;
    if (open) {
        console.log(`Commenting on #${open.number}`);
        if (!dry) await gh('POST', `/repos/${repo}/issues/${open.number}/comments`, { body: note });
        return;
    }
    const body = `${cfg.marker}\n${note}\n\n`
        + 'Open the run, read the failing step, fix it and re-run the workflow (Actions → Run workflow). '
        + 'Common causes: an expired or removed service-account secret, a missing IAM role, the free read quota, '
        + 'or the size guard (`BACKUP_WEEKLY_ABOVE` / `BACKUP_HARD_MAX`). Steps: `tools/backup/README.md`.\n\n'
        + 'This issue closes itself when a later run succeeds.';
    console.log('Opening a new issue');
    if (dry) return;
    await gh('POST', `/repos/${repo}/labels`, { name: LABEL, color: 'd93f0b', description: 'Operations: backups, deploys, monitoring' }, { allowExisting: true });
    await gh('POST', `/repos/${repo}/issues`, { title: cfg.title, body, labels: [LABEL] });
}

if (require.main === module) {
    main().catch(err => {
        console.error(`Alert failed: ${err && err.message ? err.message : err}`);
        process.exit(1);
    });
}

module.exports = { HAPPA_REPO, decideAlert, runWasGood };
