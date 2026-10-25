#!/usr/bin/env node
/**
 * Happa app identity: happa.config.json is the one place for the app name,
 * Android package and Firebase project. This script copies those values into
 * every file that needs them and checks that nothing is left unfilled.
 *
 *   node scripts/happa-config.js apply            # write happa.config.json values everywhere
 *   node scripts/happa-config.js check            # release gate: in sync, no placeholders, owner confirmed
 *   node scripts/happa-config.js check --sync-only
 *   node scripts/happa-config.js get <key>        # print one derived value (siteUrl, projectId, apkFile, ...)
 *   node scripts/happa-config.js guard [--require-ready] [--sa-env NAME] [--require-sa]
 *                                                 # CI: resolve the Firebase project, refuse the old one
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.join(__dirname, '..');
const CONFIG_FILE = 'happa.config.json';
const PLACEHOLDER_RE = /__HAPPA_[A-Z0-9_]+__/;
// The old app keeps these forever; Happa must never deploy to or ship as them.
const RETIRED_PROJECT_IDS = ['aadhat-management'];
const RETIRED_PACKAGES = ['com.hitesh.aadhat'];
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const QR_FILE = 'www/img/download-qr.svg';

function loadConfig(root = DEFAULT_ROOT) {
    return JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8'));
}

function derive(raw) {
    const fb = raw.firebase || {};
    const projectId = fb.projectId;
    const hostingSite = fb.hostingSite || projectId;
    const siteHost = `${hostingSite}.web.app`;
    const siteUrl = `https://${siteHost}`;
    const apkFile = `${raw.apkName}.apk`;
    const webConfig = {
        apiKey: fb.apiKey,
        authDomain: `${projectId}.firebaseapp.com`,
        projectId,
        storageBucket: `${projectId}.firebasestorage.app`,
        messagingSenderId: fb.messagingSenderId,
        appId: fb.appId
    };
    if (fb.measurementId) webConfig.measurementId = fb.measurementId;
    return {
        appName: raw.appName,
        appNameHi: raw.appNameHi,
        androidPackage: raw.androidPackage,
        apkName: raw.apkName,
        apkFile,
        githubRepo: raw.githubRepo,
        projectId,
        hostingSite,
        siteHost,
        siteUrl,
        downloadPageUrl: `${siteUrl}/download`,
        downloadPageHost: `${siteHost}/download`,
        apkDownloadUrl: `https://github.com/${raw.githubRepo}/releases/latest/download/${apkFile}`,
        latestReleaseApi: `https://api.github.com/repos/${raw.githubRepo}/releases/latest`,
        webConfig
    };
}

function findPlaceholders(value, at = '') {
    if (typeof value === 'string') return PLACEHOLDER_RE.test(value) ? [`${at} = ${value}`] : [];
    if (value && typeof value === 'object') {
        return Object.entries(value).flatMap(([k, v]) => findPlaceholders(v, at ? `${at}.${k}` : k));
    }
    return [];
}

/** Problems that block a release (empty when the config is complete). */
function configProblems(raw) {
    const errors = findPlaceholders(raw).map((p) => `placeholder not filled: ${p}`);
    const d = derive(raw);
    for (const key of ['appName', 'appNameHi', 'androidPackage', 'apkName', 'githubRepo']) {
        if (!raw[key] || typeof raw[key] !== 'string') errors.push(`${key} is empty`);
    }
    if (!PLACEHOLDER_RE.test(d.projectId || '')) {
        if (!PROJECT_ID_RE.test(d.projectId || '')) errors.push(`firebase.projectId "${d.projectId}" is not a valid project id`);
        if (!PROJECT_ID_RE.test(d.hostingSite || '')) errors.push(`firebase.hostingSite "${d.hostingSite}" is not a valid site id`);
    }
    if (RETIRED_PROJECT_IDS.includes(d.projectId) || RETIRED_PROJECT_IDS.includes(d.hostingSite)) {
        errors.push(`firebase project/site "${d.projectId}" belongs to the old app; Happa needs its own project`);
    }
    if (!PACKAGE_RE.test(d.androidPackage || '')) errors.push(`androidPackage "${d.androidPackage}" is not a valid Android package id`);
    if (RETIRED_PACKAGES.includes(d.androidPackage)) errors.push(`androidPackage "${d.androidPackage}" is the old app's id`);
    if (raw.ownerConfirmed !== true) {
        errors.push('ownerConfirmed is not true: the owner must confirm androidPackage and appNameHi (they cannot change after phones install v1.0.0)');
    }
    return errors;
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function replaceOrThrow(text, re, replacement, label) {
    if (!re.test(text)) throw new Error(`Could not find ${label}`);
    return text.replace(re, replacement);
}

function downloadValues(d) {
    return {
        appName: d.appName,
        appNameHi: d.appNameHi,
        apkFile: d.apkFile,
        apkDownloadUrl: d.apkDownloadUrl,
        siteUrl: d.siteUrl,
        siteHost: d.siteHost,
        downloadPageHost: d.downloadPageHost,
        downloadTitle: `${d.appName} — Download / डाउनलोड`,
        downloadDescription: `Download the ${d.appName} Android app and install steps in Hindi and English.`,
        qrAlt: `QR code for ${d.downloadPageHost}`
    };
}

function fillMarkedHtml(text, values) {
    const pick = (key) => {
        if (!(key in values)) throw new Error(`download.html: unknown data-happa key "${key}"`);
        return escapeHtml(values[key]);
    };
    return text
        .replace(/(<(\w+)\b[^>]*\bdata-happa="(\w+)"[^>]*>)[^<]*(<\/\2>)/g, (_, open, _tag, key, close) => open + pick(key) + close)
        .replace(/\b(href|alt|content)="[^"]*"(\s+data-happa-\1="(\w+)")/g, (_, attr, marker, key) => `${attr}="${pick(key)}"${marker}`);
}

function identityModule(d) {
    const identity = {
        appName: d.appName,
        appNameHi: d.appNameHi,
        androidPackage: d.androidPackage,
        projectId: d.projectId,
        siteUrl: d.siteUrl,
        downloadPageUrl: d.downloadPageUrl,
        apkFile: d.apkFile,
        apkDownloadUrl: d.apkDownloadUrl,
        latestReleaseApi: d.latestReleaseApi
    };
    return '// Generated from happa.config.json by `npm run apply:happa-config`. Do not edit by hand.\n' +
        `export const APP_IDENTITY = Object.freeze(${JSON.stringify(identity, null, 4)});\n`;
}

/** Every file that carries the app or project identity, and how to write it. */
const TARGETS = [
    { file: '.firebaserc', write: (_, d) => JSON.stringify({ projects: { default: d.projectId } }, null, 2) + '\n' },
    {
        file: 'firebase.json',
        write: (t, d) => replaceOrThrow(t, /("hosting"\s*:\s*\{\n)([ \t]*)(?:"site"\s*:\s*"[^"]*",\n[ \t]*)?/,
            `$1$2"site": ${JSON.stringify(d.hostingSite)},\n$2`, 'hosting block in firebase.json')
    },
    {
        file: 'capacitor.config.json',
        write: (t, d) => replaceOrThrow(
            replaceOrThrow(t, /"appId"\s*:\s*"[^"]*"/, `"appId": ${JSON.stringify(d.androidPackage)}`, 'appId'),
            /"appName"\s*:\s*"[^"]*"/, `"appName": ${JSON.stringify(d.appName)}`, 'appName')
    },
    {
        file: 'android/app/build.gradle',
        write: (t, d) => replaceOrThrow(
            replaceOrThrow(t, /^(\s*applicationId\s+)"[^"]*"/m, `$1"${d.androidPackage}"`, 'applicationId'),
            /^(\s*namespace\s+)"[^"]*"/m, `$1"${d.androidPackage}"`, 'namespace')
    },
    {
        file: 'android/app/src/main/res/values/strings.xml',
        write: (t, d) => t
            .replace(/(<string name="(?:app_name|title_activity_main)">)[^<]*(<\/string>)/g, `$1${escapeHtml(d.appName)}$2`)
            .replace(/(<string name="(?:package_name|custom_url_scheme)">)[^<]*(<\/string>)/g, `$1${d.androidPackage}$2`)
    },
    {
        file: 'www/manifest.webmanifest',
        write: (t, d) => replaceOrThrow(
            replaceOrThrow(t, /^( {4}"name"\s*:\s*)"[^"]*"/m, `$1${JSON.stringify(d.appName)}`, 'manifest name'),
            /^( {4}"short_name"\s*:\s*)"[^"]*"/m, `$1${JSON.stringify(d.appName)}`, 'manifest short_name')
    },
    {
        file: 'www/firebaseConfig.js',
        write: (t, d) => replaceOrThrow(t, /(\/\/ <happa-config>\n)[\s\S]*?(\/\/ <\/happa-config>)/,
            `$1const firebaseConfig = ${JSON.stringify(d.webConfig, null, 2)};\n$2`, 'happa-config block in firebaseConfig.js')
    },
    { file: 'www/js/config/app-identity.js', write: (_, d) => identityModule(d) },
    { file: 'www/index.html', write: (t, d) => replaceOrThrow(t, /<title>[^<]*<\/title>/, `<title>${escapeHtml(d.appName)}</title>`, '<title>') },
    { file: 'www/js/i18n/en.js', write: (t, d) => replaceOrThrow(t, /('ui\.app\.name':\s*)"[^"]*"/, `$1${JSON.stringify(d.appName)}`, 'ui.app.name') },
    { file: 'www/js/i18n/hi.js', write: (t, d) => replaceOrThrow(t, /('ui\.app\.name':\s*)"[^"]*"/, `$1${JSON.stringify(d.appNameHi)}`, 'ui.app.name') },
    { file: 'www/download.html', write: (t, d) => fillMarkedHtml(t, downloadValues(d)) }
];

function readText(file) {
    const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    return { text: raw.replace(/\r\n/g, '\n'), crlf: raw.includes('\r\n') };
}

/** Returns [{ file, current, wanted, crlf }] for every target. */
function plan(root = DEFAULT_ROOT, raw = loadConfig(root)) {
    const d = derive(raw);
    return TARGETS.map(({ file, write }) => {
        const { text, crlf } = readText(path.join(root, file));
        return { file, current: text, wanted: write(text, d), crlf };
    });
}

function outOfSync(root = DEFAULT_ROOT, raw) {
    const files = plan(root, raw).filter((p) => p.current !== p.wanted).map((p) => p.file);
    const activity = mainActivity(root, derive(raw || loadConfig(root)));
    if (activity && activity.from !== activity.to) files.push(activity.from);
    return files;
}

const JAVA_ROOT = 'android/app/src/main/java';

/** Where MainActivity.java is and where the namespace says it must be (null if there is none). */
function mainActivity(root, d) {
    const base = path.join(root, JAVA_ROOT);
    const found = [];
    const walk = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) walk(path.join(dir, e.name));
            else if (e.name === 'MainActivity.java') found.push(path.join(dir, e.name));
        }
    };
    walk(base);
    if (!found.length) return null;
    if (found.length > 1) throw new Error(`More than one MainActivity.java under ${JAVA_ROOT}`);
    const rel = (p) => path.relative(root, p).split(path.sep).join('/');
    const to = `${JAVA_ROOT}/${d.androidPackage.split('.').join('/')}/MainActivity.java`;
    const text = fs.readFileSync(found[0], 'utf8');
    const pkg = (/^package\s+([\w.]+);/m.exec(text) || [])[1];
    return { from: pkg === d.androidPackage ? rel(found[0]) : `${rel(found[0])} (package ${pkg})`, to, file: found[0], text };
}

function moveMainActivity(root, d) {
    const a = mainActivity(root, d);
    if (!a || a.from === a.to) return null;
    const target = path.join(root, a.to);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, a.text.replace(/^package\s+[\w.]+;/m, `package ${d.androidPackage};`));
    if (path.resolve(a.file) !== path.resolve(target)) {
        fs.rmSync(a.file);
        let dir = path.dirname(a.file);
        const stop = path.join(root, JAVA_ROOT);
        while (dir !== stop && fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
            dir = path.dirname(dir);
        }
    }
    return a.to;
}

function qrUrl(root = DEFAULT_ROOT) {
    const file = path.join(root, QR_FILE);
    if (!fs.existsSync(file)) return null;
    const m = /<!-- happa-qr: (\S+) -->/.exec(fs.readFileSync(file, 'utf8'));
    return m ? m[1] : null;
}

function writeQr(root, url) {
    const { execSync } = require('child_process');
    const out = path.join(root, QR_FILE);
    if (!/^https:\/\/[a-z0-9.-]+\/download$/.test(url)) throw new Error(`Refusing to encode unexpected URL ${url}`);
    execSync(`npx --yes qrcode@1.5.4 -t svg -o "${out}" "${url}"`, { stdio: 'inherit' });
    fs.appendFileSync(out, `\n<!-- happa-qr: ${url} -->\n`);
}

function apply(root = DEFAULT_ROOT, { qr = true } = {}) {
    const raw = loadConfig(root);
    const changed = [];
    for (const p of plan(root, raw)) {
        if (p.current === p.wanted) continue;
        const target = path.join(root, p.file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, p.crlf ? p.wanted.replace(/\n/g, '\r\n') : p.wanted);
        changed.push(p.file);
    }
    const d = derive(raw);
    const moved = moveMainActivity(root, d);
    if (moved) changed.push(moved);
    if (qr && !PLACEHOLDER_RE.test(d.downloadPageUrl) && qrUrl(root) !== d.downloadPageUrl) {
        writeQr(root, d.downloadPageUrl);
        changed.push(QR_FILE);
    }
    return changed;
}

/** Release gate. Returns a list of problems (empty = ready). */
function check(root = DEFAULT_ROOT, { syncOnly = false } = {}) {
    const raw = loadConfig(root);
    const errors = outOfSync(root, raw).map((f) => `${f} does not match ${CONFIG_FILE} (run npm run apply:happa-config)`);
    if (syncOnly) return errors;
    errors.push(...configProblems(raw));
    const d = derive(raw);
    if (qrUrl(root) !== d.downloadPageUrl) errors.push(`${QR_FILE} does not encode ${d.downloadPageUrl} (run npm run apply:happa-config)`);
    return errors;
}

function readFirebaserc(root) {
    try {
        return JSON.parse(fs.readFileSync(path.join(root, '.firebaserc'), 'utf8')).projects.default;
    } catch (_) {
        return null;
    }
}

/**
 * CI guard for every workflow that touches Firebase. Never lets the old
 * project through. Returns { ok, ready, projectId, site, messages }.
 */
function guard(root, { requireReady = false, requireSa = false, saJson = '' } = {}) {
    const d = derive(loadConfig(root));
    const messages = [];
    let ok = true;
    let ready = true;
    const fail = (m) => { ok = false; messages.push(`::error::${m}`); };
    const rc = readFirebaserc(root);
    if (rc !== d.projectId) fail(`.firebaserc default "${rc}" differs from ${CONFIG_FILE} projectId "${d.projectId}" (run npm run apply:happa-config).`);
    for (const id of [d.projectId, d.hostingSite, rc]) {
        if (RETIRED_PROJECT_IDS.includes(id)) fail(`Project/site resolves to "${id}", the old app's project. Happa must never deploy there.`);
    }
    if (PLACEHOLDER_RE.test(d.projectId || '') || !PROJECT_ID_RE.test(d.projectId || '')) {
        ready = false;
        if (requireReady) fail(`${CONFIG_FILE} has no real Firebase project yet ("${d.projectId}"). Fill it in first (docs/happa-go-live.md).`);
        else messages.push(`::notice::${CONFIG_FILE} has no real Firebase project yet ("${d.projectId}"); skipping.`);
    }
    if (saJson) {
        let saProject = null;
        try { saProject = JSON.parse(saJson).project_id; } catch (_) { fail('The service account secret is not valid JSON.'); }
        if (saProject && RETIRED_PROJECT_IDS.includes(saProject)) fail(`The service account belongs to "${saProject}", the old app's project.`);
        else if (saProject && ready && saProject !== d.projectId) fail(`The service account belongs to "${saProject}", not "${d.projectId}".`);
    } else {
        ready = false;
        if (requireSa) fail('The Happa service account secret is not set (FIREBASE_SERVICE_ACCOUNT_HAPPA).');
        else messages.push('::notice::The Happa service account secret is not set; skipping.');
    }
    return { ok, ready: ok && ready, projectId: d.projectId, site: d.hostingSite, messages };
}

function main(argv) {
    const [cmd, ...rest] = argv;
    const has = (f) => rest.includes(f);
    if (cmd === 'apply') {
        const changed = apply(DEFAULT_ROOT, { qr: !has('--no-qr') });
        console.log(changed.length ? `Updated:\n  ${changed.join('\n  ')}` : 'Everything already matches happa.config.json.');
        const left = configProblems(loadConfig());
        if (left.length) console.log(`Still to do before release:\n  ${left.join('\n  ')}`);
        return 0;
    }
    if (cmd === 'check') {
        const errors = check(DEFAULT_ROOT, { syncOnly: has('--sync-only') });
        if (errors.length) {
            console.error(`Happa config check FAILED:\n  ${errors.join('\n  ')}\nSee docs/happa-go-live.md.`);
            return 1;
        }
        console.log(has('--sync-only') ? 'OK: all files match happa.config.json.' : 'OK: Happa config is complete and every file matches it.');
        return 0;
    }
    if (cmd === 'get') {
        const value = derive(loadConfig())[rest[0]];
        if (value === undefined) { console.error(`Unknown key "${rest[0]}"`); return 1; }
        process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
        return 0;
    }
    if (cmd === 'guard') {
        const saIdx = rest.indexOf('--sa-env');
        const saJson = saIdx >= 0 ? (process.env[rest[saIdx + 1]] || '') : '';
        const r = guard(DEFAULT_ROOT, { requireReady: has('--require-ready'), requireSa: has('--require-sa'), saJson: saIdx >= 0 ? saJson : '' });
        r.messages.forEach((m) => console.log(m));
        if (process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `project_id=${r.projectId}\nsite=${r.site}\nready=${r.ready}\n`);
        }
        console.log(`project=${r.projectId} site=${r.site} ready=${r.ready}`);
        return r.ok ? 0 : 1;
    }
    console.error('Usage: node scripts/happa-config.js apply|check [--sync-only]|get <key>|guard [--require-ready] [--require-sa] [--sa-env NAME]');
    return 1;
}

module.exports = { loadConfig, derive, configProblems, plan, outOfSync, apply, check, guard, TARGETS, RETIRED_PROJECT_IDS, PLACEHOLDER_RE };

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}
