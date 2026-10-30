#!/usr/bin/env node
/**
 * Offline restore check for one downloaded backup artifact (no Firebase
 * access): verifies SHA256SUMS, decrypts, parses and compares the document
 * counts with manifest.json. Prints counts only, never data.
 *
 * Usage:
 *   node tools/backup/verify-backup.js --dir <artifact folder>
 *        [--passphrase-file <file> | --passphrase-env <NAME>]   (default env BACKUP_PASSPHRASE)
 *        [--out <decrypted backup.json>]                         (for a restore / drill)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { verifyArtifact } = require('./verify-lib');

function arg(name) {
    const i = process.argv.indexOf(name);
    return i !== -1 ? process.argv[i + 1] : undefined;
}

function readPassphrase() {
    const file = arg('--passphrase-file');
    // Like `openssl -pass file:`, use the first line.
    if (file) return fs.readFileSync(file, 'utf8').split('\n')[0];
    const value = process.env[arg('--passphrase-env') || 'BACKUP_PASSPHRASE'];
    if (!value) throw new Error('No passphrase: set BACKUP_PASSPHRASE or pass --passphrase-file');
    return value;
}

function summary(markdown) {
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    console.log(markdown);
}

function main() {
    const dir = arg('--dir');
    if (!dir) throw new Error('--dir <artifact folder> is required');
    const { backup, manifest, counts, problems, encFile } = verifyArtifact({ dir, passphrase: readPassphrase() });
    if (backup && arg('--out')) {
        const out = path.resolve(arg('--out'));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(backup));
    }
    if (counts) {
        const rows = Object.entries(counts.collections).map(([n, c]) => `| ${n} | ${c} | ${manifest && manifest.collections ? manifest.collections[n] : '-'} |`)
            .concat(Object.entries(counts.subcollections).map(([n, c]) => `| ${n} | ${c} | ${manifest && manifest.subcollections ? manifest.subcollections[n] : '-'} |`))
            .join('\n');
        summary(`### Backup check: ${encFile}\n${counts.mode} export of ${counts.exportedAt}, ${counts.totalDocs} documents\n\n| Collection | In file | Manifest |\n|---|---|---|\n${rows}`);
    }
    if (problems.length) {
        problems.forEach(p => console.error(`::error::${p}`));
        process.exit(1);
    }
    summary('Checksums, decryption, parsing and counts: OK');
}

try {
    main();
} catch (err) {
    const message = err && err.message ? err.message : String(err);
    const cause = err && err.cause && err.cause.message;
    console.error(`Backup check failed: ${message}`);
    if (cause && !message.includes(cause)) console.error(`  cause: ${cause}`);
    process.exit(1);
}
