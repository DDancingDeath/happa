#!/usr/bin/env node
/**
 * Exports Happa's production Firestore collections (root collections not
 * starting with dev_, plus the sub-collections in SUBCOLLECTIONS) to one JSON
 * file and writes manifest.json (document counts only) next to it. Used by
 * .github/workflows/firestore-backup.yml; see tools/backup/README.md.
 *
 * Two modes (backup-lib.js backupMode):
 *   nightly  every collection except NIGHTLY_EXCLUDE (auditLogs, telemetry,
 *            tipHealth, tipFailures), to save reads;
 *   weekly   everything (scheduled on Sundays IST).
 *
 * Env:
 *   FIREBASE_SERVICE_ACCOUNT  service-account JSON (needs Firestore read)
 *   BACKUP_TRIGGER            github.event_name ("schedule" enables the weekly rules)
 *   BACKUP_MODE               nightly | weekly | auto (default auto: weekly on Sundays when scheduled)
 *   BACKUP_FORCE              "true" skips the size guard
 *   BACKUP_WEEKLY_ABOVE       docs above which scheduled runs go weekly (default 15000)
 *   BACKUP_HARD_MAX           docs above which nothing runs unless forced (default 40000)
 *   BACKUP_EXCLUDE            comma-separated extra collection ids to skip (only
 *                             OPTIONAL_COLLECTIONS; business data can't be dropped)
 * Args:
 *   --out <file>              output JSON path (required); manifest.json goes in the same folder
 * Outputs (GITHUB_OUTPUT): skipped, mode, documents, reads
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
    BACKUP_FORMAT, SUBCOLLECTIONS, serialize, planCollections, backupMode, istDayOfWeek, buildManifest, decideRun
} = require('./backup-lib');

const PAGE_SIZE = 500;

function arg(name) {
    const i = process.argv.indexOf(name);
    return i !== -1 ? process.argv[i + 1] : undefined;
}

function setOutput(key, value) {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function summary(markdown) {
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    console.log(markdown);
}

async function main() {
    const out = arg('--out');
    if (!out) throw new Error('--out <file> is required');
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
    const serviceAccount = JSON.parse(raw);

    const { initializeApp, cert } = require('firebase-admin/app');
    const { getFirestore, FieldPath } = require('firebase-admin/firestore');
    initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id });
    const db = getFirestore();

    // Billed reads: 1 per document returned, at least 1 per query; an aggregate
    // count costs 1 per 1,000 documents (at least 1).
    let reads = 0;
    const countDocs = async (name) => {
        const n = (await db.collection(name).count().get()).data().count;
        reads += Math.max(1, Math.ceil(n / 1000));
        return n;
    };

    const scheduled = process.env.BACKUP_TRIGGER === 'schedule';
    const dayOfWeek = istDayOfWeek();
    const mode = backupMode({ requested: process.env.BACKUP_MODE, scheduled, dayOfWeek });
    setOutput('mode', mode);

    const all = (await db.listCollections()).map(c => c.id);
    reads += 1;
    const plan = planCollections(all, { mode, exclude: (process.env.BACKUP_EXCLUDE || '').split(',') });
    if (plan.refused.length) {
        summary(`> **Warning:** BACKUP_EXCLUDE can't skip business data; still backing up: ${plan.refused.join(', ')}`);
    }
    if (plan.undeclared.length) {
        summary(`> **Warning:** not listed in backup-lib.js BACKUP_COLLECTIONS (exported anyway; add them there and to firestore.rules): ${plan.undeclared.join(', ')}`);
    }

    const counts = {};
    for (const name of plan.names) counts[name] = await countDocs(name);
    const excludedCounts = {};
    for (const name of plan.excluded) excludedCounts[name] = await countDocs(name);
    const totalDocs = Object.values(counts).reduce((a, b) => a + b, 0);

    const decision = decideRun({
        totalDocs,
        scheduled,
        dayOfWeek,
        weeklyAbove: Number(process.env.BACKUP_WEEKLY_ABOVE) || 15000,
        hardMax: Number(process.env.BACKUP_HARD_MAX) || 40000,
        force: process.env.BACKUP_FORCE === 'true'
    });
    if (!decision.run) {
        summary(`### Firestore backup skipped (${mode})\n${decision.reason}\n\nReads used: ≈${reads}`);
        setOutput('skipped', 'true');
        setOutput('reads', String(reads));
        if (decision.fail) process.exitCode = 1;
        return;
    }

    const backup = {
        format: BACKUP_FORMAT,
        mode,
        exportedAt: new Date().toISOString(),
        env: 'prod',
        project: serviceAccount.project_id,
        collections: {},
        subcollections: {}
    };
    for (const name of plan.names) {
        const docs = [];
        let last = null;
        for (;;) {
            let q = db.collection(name).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
            if (last) q = q.startAfter(last);
            const snap = await q.get();
            reads += Math.max(1, snap.size);
            snap.docs.forEach(d => docs.push({ id: d.id, data: serialize(d.data()) }));
            if (snap.size < PAGE_SIZE) break;
            last = snap.docs[snap.docs.length - 1];
        }
        backup.collections[name] = docs;
    }
    // Sub-collections (e.g. users/{uid}/preferences): one collection-group
    // query each, keeping only documents under the production parent.
    for (const key of SUBCOLLECTIONS) {
        const [parent, sub] = key.split('/');
        const snap = await db.collectionGroup(sub).get();
        reads += Math.max(1, snap.size);
        backup.subcollections[key] = snap.docs
            .filter(d => d.ref.path.split('/')[0] === parent && d.ref.path.split('/').length === 4)
            .map(d => ({ path: d.ref.path, data: serialize(d.data()) }));
    }

    const manifest = { ...buildManifest(backup), countedBefore: counts, excludedCounts, reads };
    backup.manifest = buildManifest(backup);

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(backup));
    fs.writeFileSync(path.join(path.dirname(out), 'manifest.json'), JSON.stringify(manifest, null, 2));
    setOutput('skipped', 'false');
    setOutput('documents', String(manifest.totalDocs));
    setOutput('reads', String(reads));

    const rows = Object.entries(manifest.collections).map(([n, c]) => `| ${n} | ${c} |`)
        .concat(Object.entries(manifest.subcollections).map(([n, c]) => `| ${n} (sub-collection) | ${c} |`))
        .concat(Object.entries(excludedCounts).map(([n, c]) => `| ${n} | skipped in the ${mode} export (${c} in Firestore) |`))
        .join('\n');
    summary(`### Firestore backup (${mode})\n${manifest.totalDocs} documents, ≈${reads} reads of the 50,000/day free quota\n\n| Collection | Docs |\n|---|---|\n${rows}`);
}

main().catch(err => {
    // Never print the service account; only the error message.
    console.error(`Backup failed: ${err && err.message ? err.message : err}`);
    process.exit(1);
});
