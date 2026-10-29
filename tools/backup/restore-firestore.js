#!/usr/bin/env node
/**
 * Restores a decrypted backup JSON (from export-firestore.js or the in-app
 * Clear Data backup) into Firestore. See tools/backup/README.md.
 *
 * Safe by default:
 *  - dry run unless --apply is given (prints what would be written);
 *  - writes into dev_<collection> unless --target prod is given, which also
 *    needs --confirm-project <project id>;
 *  - never deletes; documents are written by their original id (overwriting
 *    a document with the same id, leaving all others alone).
 *
 * Usage:
 *   node tools/backup/restore-firestore.js --in backup.json [--collections items,purchases]
 *        [--apply] [--target dev|prod] [--confirm-project happa-bfc07] [--emulator] [--check]
 *   --emulator  write to the Firestore emulator only (needs FIRESTORE_EMULATOR_HOST and a
 *               demo-* project id from GCLOUD_PROJECT / --project); no credentials used.
 *   --check     after writing, read every restored document back and compare it with
 *               the backup (emulator only, where reads are free).
 * Env:
 *   FIREBASE_SERVICE_ACCOUNT  service-account JSON with Firestore write access
 *     (or GOOGLE_APPLICATION_CREDENTIALS pointing at the key file)
 */
'use strict';

const fs = require('fs');
const { BACKUP_FORMAT, deserialize, serialize, targetCollection, targetDocPath } = require('./backup-lib');

function arg(name) {
    const i = process.argv.indexOf(name);
    return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name) => process.argv.includes(name);

/** JSON with sorted keys, so read-back data compares regardless of key order. */
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    return JSON.stringify(value);
}

async function main() {
    const input = arg('--in');
    if (!input) throw new Error('--in <backup.json> is required');
    const backup = JSON.parse(fs.readFileSync(input, 'utf8'));
    if (backup.format !== BACKUP_FORMAT) throw new Error(`Unknown backup format: ${backup.format}`);

    const target = arg('--target') === 'prod' ? 'prod' : 'dev';
    const only = (arg('--collections') || '').split(',').map(s => s.trim()).filter(Boolean);
    const names = Object.keys(backup.collections).filter(n => only.length === 0 || only.includes(n));
    const subs = Object.keys(backup.subcollections || {}).filter(k => only.length === 0 || only.includes(k.split('/')[0]));
    const apply = flag('--apply');
    const emulator = flag('--emulator');

    console.log(`Backup from ${backup.exportedAt} (${backup.mode || 'full'}, ${backup.env || 'prod'}), target: ${target}${emulator ? ' in the EMULATOR' : ''}${apply ? '' : ' (dry run)'}`);
    names.forEach(n => console.log(`  ${n} -> ${targetCollection(n, target)}: ${backup.collections[n].length} docs`));
    subs.forEach(k => console.log(`  ${k} (sub-collection) -> ${targetCollection(k.split('/')[0], target)}/*/${k.split('/')[1]}: ${backup.subcollections[k].length} docs`));
    if (!apply) {
        console.log('Dry run only. Add --apply to write.');
        return;
    }

    const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
    const { getFirestore, Timestamp, GeoPoint } = require('firebase-admin/firestore');
    let app;
    if (emulator) {
        const projectId = arg('--project') || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
        if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('--emulator needs FIRESTORE_EMULATOR_HOST (run it under firebase emulators:exec)');
        if (!projectId || !projectId.startsWith('demo-')) throw new Error('--emulator needs a demo-* project id, so it can never reach a real project');
        app = initializeApp({ projectId });
    } else {
        if (flag('--check')) throw new Error('--check reads every document back; use it with --emulator only');
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
        const serviceAccount = raw ? JSON.parse(raw) : null;
        app = initializeApp(serviceAccount
            ? { credential: cert(serviceAccount), projectId: serviceAccount.project_id }
            : { credential: applicationDefault() });
    }
    const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const keyProject = !emulator && keyFile && fs.existsSync(keyFile) ? JSON.parse(fs.readFileSync(keyFile, 'utf8')).project_id : undefined;
    const projectId = app.options.projectId || keyProject || process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) throw new Error('Could not tell which Firebase project the credentials are for');
    if (target === 'prod' && arg('--confirm-project') !== projectId) {
        throw new Error(`Restoring into PRODUCTION collection names needs --confirm-project ${projectId}`);
    }

    const db = getFirestore();
    const types = { Timestamp, GeoPoint, doc: (p) => db.doc(p) };
    const writeAll = async (entries) => {
        for (let i = 0; i < entries.length; i += 400) {
            const batch = db.batch();
            entries.slice(i, i + 400).forEach(([ref, data]) => batch.set(ref, deserialize(data, types)));
            await batch.commit();
        }
    };
    for (const name of names) {
        const col = db.collection(targetCollection(name, target));
        await writeAll(backup.collections[name].map(d => [col.doc(d.id), d.data]));
        console.log(`Restored ${backup.collections[name].length} docs into ${col.id}`);
    }
    for (const key of subs) {
        const docs = backup.subcollections[key];
        await writeAll(docs.map(d => [db.doc(targetDocPath(d.path, target)), d.data]));
        console.log(`Restored ${docs.length} docs into ${key} (sub-collection)`);
    }

    if (flag('--check')) {
        const problems = [];
        const same = async (ref, data, label) => {
            const snap = await ref.get();
            if (!snap.exists) problems.push(`${label}: missing after restore`);
            else if (canonical(serialize(snap.data())) !== canonical(data)) problems.push(`${label}: differs from the backup`);
        };
        for (const name of names) {
            const col = db.collection(targetCollection(name, target));
            const n = (await col.count().get()).data().count;
            if (n !== backup.collections[name].length) problems.push(`${col.id}: ${n} docs, backup has ${backup.collections[name].length}`);
            for (const d of backup.collections[name]) await same(col.doc(d.id), d.data, `${col.id}/${d.id}`);
        }
        for (const key of subs) {
            for (const d of backup.subcollections[key]) await same(db.doc(targetDocPath(d.path, target)), d.data, key);
        }
        if (problems.length) {
            problems.slice(0, 50).forEach(p => console.error(`::error::${p}`));
            throw new Error(`${problems.length} restored document(s) don't match the backup`);
        }
        console.log('Read-back check: every restored document matches the backup.');
    }
}

main().catch(err => {
    console.error(`Restore failed: ${err && err.message ? err.message : err}`);
    process.exit(1);
});
