#!/usr/bin/env node
/**
 * Daily Test in Production bug filing (#217), run by
 * .github/workflows/tip-autobugs.yml. Reads tipHealth (last 9 days) and the
 * latest tipFailures with a service account, then opens / updates / reopens /
 * closes GitHub issues labelled `tip-auto` (see autobugs-lib.js).
 *
 * Env:
 *   FIREBASE_SERVICE_ACCOUNT  service-account JSON (needs Firestore read: "Cloud Datastore Viewer", #168)
 *   GITHUB_TOKEN, GITHUB_REPOSITORY
 *   TIP_DRY_RUN=true          print the plan, change nothing on GitHub
 *   TIP_HEALTH_URL            link shown in issues (default: the live app)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { LABEL, DEFAULTS, addDays, planIssues, isPermissionDenied } = require('./autobugs-lib');
const { loadConfig, derive } = require('../../scripts/happa-config.js');

const BACKUP_DIR = path.join(__dirname, '..', 'backup');
const HEALTH_LIMIT = 3000;
const FAILURE_LIMIT = 300;

function summary(markdown) {
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    console.log(markdown);
}

/** Today in IST (the shop's day) as YYYYMMDD. */
function todayIst() {
    const d = new Date(Date.now() + 5.5 * 3600 * 1000);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function gh(method, url, body) {
    const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${url}`, {
        method,
        headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok && !(method === 'POST' && url === '/labels' && res.status === 422)) {
        throw new Error(`GitHub ${method} ${url}: ${res.status} ${await res.text()}`);
    }
    return res.status === 204 ? null : res.json();
}

async function readFirestore(today) {
    const req = (m) => require(require.resolve(m, { paths: [BACKUP_DIR] }));
    const { initializeApp, cert } = req('firebase-admin/app');
    const { getFirestore } = req('firebase-admin/firestore');
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id });
    const db = getFirestore();
    const since = addDays(today, -(DEFAULTS.recentDays + DEFAULTS.baselineDays));
    const healthSnap = await db.collection('tipHealth').where('day', '>=', since).limit(HEALTH_LIMIT).get();
    const failSnap = await db.collection('tipFailures').orderBy('at', 'desc').limit(FAILURE_LIMIT).get();
    return {
        docs: healthSnap.docs.map(d => d.data()),
        samples: failSnap.docs.map(d => d.data()),
        reads: healthSnap.size + failSnap.size
    };
}

async function main() {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
        summary('### TIP auto bugs skipped\nNo service account secret (FIREBASE_BACKUP_SERVICE_ACCOUNT_HAPPA or FIREBASE_SERVICE_ACCOUNT_HAPPA).');
        return;
    }
    const today = todayIst();
    let data;
    try {
        data = await readFirestore(today);
    } catch (error) {
        if (isPermissionDenied(error)) {
            console.log('::warning::TIP auto bugs: the service account cannot read Firestore (PERMISSION_DENIED). Grant it "Cloud Datastore Viewer" (see #168); nothing was filed.');
            summary('### TIP auto bugs skipped\nPERMISSION_DENIED reading `tipHealth` / `tipFailures`: the service account needs the **Cloud Datastore Viewer** role (#168).');
            return;
        }
        throw error;
    }

    const dryRun = process.env.TIP_DRY_RUN === 'true';
    const issues = dryRun && !process.env.GITHUB_TOKEN ? [] : await gh('GET', `/issues?labels=${LABEL}&state=all&per_page=100`);
    const actions = planIssues({
        docs: data.docs,
        samples: data.samples,
        issues: (issues || []).filter(i => !i.pull_request),
        today,
        healthUrl: process.env.TIP_HEALTH_URL || `${derive(loadConfig()).siteUrl} (menu → App health)`
    });

    summary(`### TIP auto bugs (${today})\nRead ${data.reads} docs (${data.docs.length} health, ${data.samples.length} samples). Plan: ${actions.length} action(s)${dryRun ? ' — dry run' : ''}.`);
    actions.forEach(a => summary(`- ${a.action} ${a.number ? `#${a.number}` : ''} ${a.title || ''} \`${a.hash}\``));
    if (dryRun) return;

    if (actions.some(a => a.action === 'create')) {
        await gh('POST', '/labels', { name: LABEL, color: 'b60205', description: 'Filed automatically by Test in Production (#217)' });
    }
    for (const a of actions) {
        if (a.action === 'create') {
            await gh('POST', '/issues', { title: a.title, body: a.body, labels: [LABEL] });
        } else if (a.action === 'update') {
            await gh('PATCH', `/issues/${a.number}`, { title: a.title, body: a.body });
        } else if (a.action === 'reopen') {
            await gh('PATCH', `/issues/${a.number}`, { state: 'open', title: a.title, body: a.body });
            await gh('POST', `/issues/${a.number}/comments`, { body: a.comment });
        } else if (a.action === 'close') {
            await gh('POST', `/issues/${a.number}/comments`, { body: a.comment });
            await gh('PATCH', `/issues/${a.number}`, { state: 'closed', state_reason: 'completed' });
        }
    }
}

main().catch((error) => {
    console.error(`::error::TIP auto bugs failed: ${error && error.message}`);
    process.exit(1);
});
