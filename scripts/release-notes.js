#!/usr/bin/env node
/**
 * Prints GitHub Release notes (markdown) for one version from www/changelog.json.
 *
 *   node scripts/release-notes.js <version> [--changelog <path>]
 *
 * <version> may carry a leading "v" (tag form). Exits 1 if the version has no
 * changelog entry or the entry has no English notes.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { loadConfig, derive } = require('./happa-config.js');

const DEFAULT_CHANGELOG = path.join(__dirname, '..', 'www', 'changelog.json');
const IDENTITY = derive(loadConfig());
const DOWNLOAD_URL = IDENTITY.downloadPageUrl;
const INSTALL_STEPS =
    `On your Android 11+ phone open the download page, tap Download, open \`${IDENTITY.apkFile}\`, ` +
    'allow "Install unknown apps" if asked, then tap Update/Install (your data is stored online and is kept).';

function normalizeVersion(v) {
    return String(v || '').trim().replace(/^v/i, '');
}

function findRelease(changelog, version) {
    const want = normalizeVersion(version);
    const releases = (changelog && Array.isArray(changelog.releases)) ? changelog.releases : [];
    return releases.find(r => r && normalizeVersion(r.version) === want) || null;
}

function bullets(list) {
    return (Array.isArray(list) ? list : [])
        .map(s => String(s).trim())
        .filter(Boolean)
        .map(s => `- ${s}`);
}

function buildReleaseNotes(changelog, version) {
    const release = findRelease(changelog, version);
    if (!release) {
        throw new Error(`No changelog entry for version ${normalizeVersion(version)}`);
    }
    const notes = release.notes || {};
    const en = bullets(notes.en);
    if (en.length === 0) {
        throw new Error(`Changelog entry ${release.version} has no English notes`);
    }
    const hi = bullets(notes.hi);

    const lines = [];
    lines.push(`## What's new in v${normalizeVersion(release.version)}${release.date ? ` (${release.date})` : ''}`);
    lines.push('', '**English**', ...en);
    if (hi.length) lines.push('', '**हिन्दी**', ...hi);
    lines.push(
        '',
        `**Download:** ${DOWNLOAD_URL}`,
        '',
        `**Install:** ${INSTALL_STEPS}`,
        ''
    );
    return lines.join('\n');
}

function main(argv) {
    const args = argv.slice(2);
    let changelogPath = DEFAULT_CHANGELOG;
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--changelog') changelogPath = args[++i];
        else positional.push(args[i]);
    }
    if (positional.length !== 1 || !changelogPath) {
        process.stderr.write('Usage: node scripts/release-notes.js <version> [--changelog <path>]\n');
        return 1;
    }
    try {
        const changelog = JSON.parse(fs.readFileSync(changelogPath, 'utf8'));
        process.stdout.write(buildReleaseNotes(changelog, positional[0]));
        return 0;
    } catch (err) {
        process.stderr.write(`release-notes: ${err.message}\n`);
        return 1;
    }
}

module.exports = { buildReleaseNotes, findRelease, normalizeVersion };

if (require.main === module) {
    process.exitCode = main(process.argv);
}
