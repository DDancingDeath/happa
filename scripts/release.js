#!/usr/bin/env node
/**
 * Keeps the app version in sync across package.json, www/js/version.js,
 * android/app/build.gradle and www/changelog.json.
 *
 *   node scripts/release.js 1.4.0 --code 5   # bump everything (changelog entry must exist first)
 *   node scripts/release.js --check          # verify consistency (exit 1 on problems)
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.join(__dirname, '..');
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const files = (root) => ({
    pkg: path.join(root, 'package.json'),
    lock: path.join(root, 'package-lock.json'),
    versionJs: path.join(root, 'www', 'js', 'version.js'),
    gradle: path.join(root, 'android', 'app', 'build.gradle'),
    changelog: path.join(root, 'www', 'changelog.json'),
});

function compareSemver(a, b) {
    const pa = SEMVER_RE.exec(a);
    const pb = SEMVER_RE.exec(b);
    if (!pa || !pb) throw new Error(`Invalid semver: ${!pa ? a : b}`);
    for (let i = 1; i <= 3; i++) {
        const d = Number(pa[i]) - Number(pb[i]);
        if (d) return Math.sign(d);
    }
    return 0;
}

function isNoteList(list) {
    return Array.isArray(list) && list.length > 0 && list.every((n) => typeof n === 'string' && n.trim());
}

/** Returns a list of problems with the changelog (empty when valid). */
function validateChangelog(changelog) {
    const errors = [];
    const releases = changelog && changelog.releases;
    if (!Array.isArray(releases) || releases.length === 0) {
        return ['changelog.json: "releases" must be a non-empty array'];
    }
    releases.forEach((r, i) => {
        const at = `changelog.json releases[${i}]`;
        if (!r || typeof r !== 'object') { errors.push(`${at}: must be an object`); return; }
        if (!SEMVER_RE.test(r.version || '')) errors.push(`${at}: version "${r.version}" is not x.y.z`);
        if (!DATE_RE.test(r.date || '')) errors.push(`${at}: date "${r.date}" is not YYYY-MM-DD`);
        if (!Number.isInteger(r.androidVersionCode) || r.androidVersionCode < 1) {
            errors.push(`${at}: androidVersionCode must be a positive integer`);
        }
        if (!r.notes || !isNoteList(r.notes.en) || !isNoteList(r.notes.hi)) {
            errors.push(`${at}: notes.en and notes.hi must be non-empty lists of text`);
        }
    });
    if (errors.length) return errors;
    for (let i = 1; i < releases.length; i++) {
        const newer = releases[i - 1];
        const older = releases[i];
        if (compareSemver(newer.version, older.version) <= 0) {
            errors.push(`changelog.json: ${newer.version} must be newer than ${older.version} (newest first)`);
        }
        if (newer.androidVersionCode <= older.androidVersionCode) {
            errors.push(`changelog.json: androidVersionCode ${newer.androidVersionCode} (${newer.version}) must be greater than ${older.androidVersionCode} (${older.version})`);
        }
        if (newer.date < older.date) {
            errors.push(`changelog.json: ${newer.version} is dated before ${older.version}`);
        }
    }
    return errors;
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readState(root) {
    const f = files(root);
    const versionJs = fs.readFileSync(f.versionJs, 'utf8');
    const gradle = fs.readFileSync(f.gradle, 'utf8');
    return {
        packageVersion: readJson(f.pkg).version,
        appVersion: (versionJs.match(/APP_VERSION\s*=\s*'([^']*)'/) || [])[1],
        appCode: Number((versionJs.match(/ANDROID_VERSION_CODE\s*=\s*(\d+)/) || [])[1]),
        gradleCode: Number((gradle.match(/^\s*versionCode\s+(\d+)/m) || [])[1]),
        gradleName: (gradle.match(/^\s*versionName\s+"([^"]*)"/m) || [])[1],
        changelog: readJson(f.changelog),
    };
}

/** Returns a list of inconsistencies between the version files (empty when consistent). */
function checkRelease(root = DEFAULT_ROOT) {
    let state;
    try {
        state = readState(root);
    } catch (e) {
        return [`Could not read version files: ${e.message}`];
    }
    const errors = validateChangelog(state.changelog);
    if (errors.length) return errors;
    const { version, androidVersionCode: code } = state.changelog.releases[0];
    const expect = (label, actual, wanted) => {
        if (actual !== wanted) errors.push(`${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)} (top of changelog.json)`);
    };
    expect('package.json version', state.packageVersion, version);
    expect('www/js/version.js APP_VERSION', state.appVersion, version);
    expect('www/js/version.js ANDROID_VERSION_CODE', state.appCode, code);
    expect('android/app/build.gradle versionName', state.gradleName, version);
    expect('android/app/build.gradle versionCode', state.gradleCode, code);
    return errors;
}

function replaceOrThrow(text, re, replacement, label) {
    if (!re.test(text)) throw new Error(`Could not find ${label}`);
    return text.replace(re, replacement);
}

/** Writes version + code everywhere. Throws (without writing) if changelog.json isn't ready. */
function applyRelease(root, version, code) {
    if (!SEMVER_RE.test(version || '')) throw new Error(`Version "${version}" must be x.y.z (e.g. 1.4.0)`);
    if (!Number.isInteger(code) || code < 1) throw new Error('--code must be a positive integer');
    const f = files(root);
    const changelog = readJson(f.changelog);
    const problems = validateChangelog(changelog);
    if (problems.length) throw new Error(problems.join('\n'));
    const top = changelog.releases[0];
    if (top.version !== version || top.androidVersionCode !== code) {
        throw new Error(`Add a release entry for ${version} (androidVersionCode ${code}) at the top of www/changelog.json first; top entry is ${top.version} (code ${top.androidVersionCode}).`);
    }

    const pkg = readJson(f.pkg);
    pkg.version = version;
    let versionJs = fs.readFileSync(f.versionJs, 'utf8');
    versionJs = replaceOrThrow(versionJs, /APP_VERSION\s*=\s*'[^']*'/, `APP_VERSION = '${version}'`, 'APP_VERSION in version.js');
    versionJs = replaceOrThrow(versionJs, /ANDROID_VERSION_CODE\s*=\s*\d+/, `ANDROID_VERSION_CODE = ${code}`, 'ANDROID_VERSION_CODE in version.js');
    let gradle = fs.readFileSync(f.gradle, 'utf8');
    gradle = replaceOrThrow(gradle, /^(\s*versionCode\s+)\d+/m, `$1${code}`, 'versionCode in build.gradle');
    gradle = replaceOrThrow(gradle, /^(\s*versionName\s+)"[^"]*"/m, `$1"${version}"`, 'versionName in build.gradle');

    fs.writeFileSync(f.pkg, JSON.stringify(pkg, null, 2) + '\n');
    if (fs.existsSync(f.lock)) {
        const lock = readJson(f.lock);
        lock.version = version;
        if (lock.packages && lock.packages['']) lock.packages[''].version = version;
        fs.writeFileSync(f.lock, JSON.stringify(lock, null, 2) + '\n');
    }
    fs.writeFileSync(f.versionJs, versionJs);
    fs.writeFileSync(f.gradle, gradle);
    return checkRelease(root);
}

function main(argv) {
    if (argv.includes('--check')) {
        const errors = checkRelease();
        if (errors.length) {
            console.error('Release check FAILED:\n  ' + errors.join('\n  '));
            console.error('Fix: add the release to www/changelog.json, then run `npm run release -- <version> --code <n>`.');
            return 1;
        }
        const top = readJson(files(DEFAULT_ROOT).changelog).releases[0];
        console.log(`OK: version ${top.version} (Android versionCode ${top.androidVersionCode}) is consistent.`);
        return 0;
    }
    const version = argv.find((a) => !a.startsWith('--'));
    const codeIdx = argv.indexOf('--code');
    const code = codeIdx >= 0 ? Number(argv[codeIdx + 1]) : NaN;
    if (!version || codeIdx < 0) {
        console.error('Usage: node scripts/release.js <x.y.z> --code <androidVersionCode>\n       node scripts/release.js --check');
        return 1;
    }
    try {
        const errors = applyRelease(DEFAULT_ROOT, version, code);
        if (errors.length) {
            console.error('Updated files but the check still fails:\n  ' + errors.join('\n  '));
            return 1;
        }
        console.log(`Set version ${version} (Android versionCode ${code}) in package.json, www/js/version.js and android/app/build.gradle.`);
        console.log('Before the final tag, run docs/release-checklist.md on a release-candidate (-rc) build.');
        return 0;
    } catch (e) {
        console.error(e.message);
        return 1;
    }
}

module.exports = { compareSemver, validateChangelog, checkRelease, applyRelease };

if (require.main === module) {
    process.exit(main(process.argv.slice(2)));
}
