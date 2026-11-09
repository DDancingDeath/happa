#!/usr/bin/env node
/**
 * Loads sample items and bills into the DEV Firebase project (bahi-happa-dev, #72).
 * Refuses any project whose id does not end in -dev. Dry run unless --apply.
 *
 *   npm ci --prefix tools/backup     # firebase-admin
 *   node tools/dev/load-sample-data.js [--apply] [--prefix dev_]
 * Env: FIREBASE_SERVICE_ACCOUNT (service-account JSON of the dev project)
 *      or GOOGLE_APPLICATION_CREDENTIALS (key file).
 * --prefix dev_ writes the dev_* collections a preview channel or localhost reads.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { assertDevProject, sampleDocs } = require('./sample-data');

function serviceAccount() {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    throw new Error('Set FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS to the dev project key.');
}

async function main(argv) {
    const i = argv.indexOf('--prefix');
    const prefix = i >= 0 ? argv[i + 1] : '';
    if (!['', 'dev_'].includes(prefix)) throw new Error('--prefix must be dev_');
    const sa = serviceAccount();
    const projectId = assertDevProject(sa.project_id);
    const docs = sampleDocs(Date.now(), prefix);
    console.log(`Sample data for ${projectId}:`);
    docs.forEach(([c, id]) => console.log(`  ${c}/${id}`));
    if (!argv.includes('--apply')) {
        console.log('Dry run only. Add --apply to write.');
        return;
    }
    const req = createRequire(path.join(__dirname, '..', 'backup', 'package.json'));
    const { initializeApp, cert } = req('firebase-admin/app');
    const { getFirestore } = req('firebase-admin/firestore');
    const db = getFirestore(initializeApp({ credential: cert(sa), projectId }));
    const batch = db.batch();
    docs.forEach(([c, id, data]) => batch.set(db.collection(c).doc(id), data));
    await batch.commit();
    console.log(`Wrote ${docs.length} documents to ${projectId}.`);
}

if (require.main === module) {
    main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
