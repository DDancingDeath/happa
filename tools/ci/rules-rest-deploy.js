#!/usr/bin/env node
/**
 * Fallback rules deploy through the Firebase Rules REST API, for when
 * `firebase deploy --only firestore:rules` keeps failing with HTTP 503 from
 * firebaserules.googleapis.com (its `projects/<p>:test` compile check times
 * out on large rules). It publishes ONLY the given rules file, byte for byte:
 *
 *   0. If the live `cloud.firestore` release already points at a ruleset whose
 *      source equals the file, nothing is written.
 *   1. Reuse the newest ruleset whose source equals the file, or create one
 *      (POST rulesets; the server compiles it, so a 400 means bad rules).
 *      A create can answer 503 yet still be applied, so after a 503 the recent
 *      rulesets are listed again before creating another.
 *   2. GET that ruleset back; abort (release untouched) unless its source is
 *      byte-identical to the file.
 *   3. PATCH the release to it. A PATCH can also answer 503 yet be applied, so
 *      the release is re-read before patching again.
 * Every wait is bounded by one overall deadline (default 12 minutes). The
 * workflow then runs `tools/ci/live-rules.js verify` as for the normal path.
 *
 * Usage (from .github/workflows/firestore-rules-deploy.yml):
 *   node tools/ci/rules-rest-deploy.js --project <id> --rules firestore.rules \
 *     --commit <sha> [--credentials <sa.json>]   # default $GOOGLE_APPLICATION_CREDENTIALS
 * --commit: the file must equal `git show <sha>:<rules>`, so only the commit
 * being deployed can be published. Exit 0 when released, 1 on failure, 2 on bad usage.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const { getAccessToken } = require('./live-rules');

const RULES_API = 'https://firebaserules.googleapis.com/v1';
const WRITE_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const RELEASE = 'cloud.firestore';
const RULES_FILE_NAME = 'firestore.rules';
const REFUSED_PROJECTS = ['aadhat-management'];
const DEFAULT_DELAYS_S = [5, 10, 20, 30, 45, 60, 90, 120];
const DEFAULT_BUDGET_S = 12 * 60;
// Rulesets created this long before our POST still count as "ours" (clock skew).
const CREATE_SKEW_MS = 2 * 60 * 1000;
const MAX_WRITES = 4;
const RECHECKS_AFTER_WRITE = 3;
const LIST_PAGE_SIZE = 20;
const TOKEN_MAX_AGE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 90 * 1000;

class FallbackError extends Error {}

const isTransientStatus = s => s === 0 || s === 408 || s === 409 || s === 429 || s >= 500;

/** The UTF-8 text of `source`; throws unless it round-trips byte for byte. */
function utf8Exact(source) {
    const text = source.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(source)) throw new FallbackError('the rules file is not valid UTF-8, so it cannot be uploaded byte for byte');
    return text;
}

/** True when the ruleset has exactly one file and its content is byte-identical to `source`. */
function sameSource(ruleset, source) {
    const files = (ruleset && ruleset.source && ruleset.source.files) || [];
    return files.length === 1 && typeof files[0].content === 'string' && Buffer.from(files[0].content, 'utf8').equals(source);
}

/**
 * Publishes `source` (a Buffer) as the project's Firestore rules. Resolves
 * { rulesetName, created, released }; rejects with FallbackError when it
 * cannot do so safely. fetchImpl, wait (seconds), now (ms) and log are injectable.
 */
async function publishRules({
    projectId, source, sa,
    fetchImpl = fetch, wait = s => new Promise(r => setTimeout(r, s * 1000)), now = Date.now, log = console.log,
    delays = DEFAULT_DELAYS_S, budgetS = DEFAULT_BUDGET_S
}) {
    if (REFUSED_PROJECTS.includes(projectId)) throw new FallbackError(`refusing to deploy to ${projectId}`);
    if (!Buffer.isBuffer(source) || source.length === 0) throw new FallbackError('the rules file is empty');
    if (!sa || !sa.client_email || !sa.private_key) throw new FallbackError('the service account JSON needs client_email and private_key');
    const content = utf8Exact(source);
    const project = `projects/${projectId}`;
    const releaseName = `${project}/releases/${RELEASE}`;
    const deadline = now() + budgetS * 1000;

    let token = null;
    let tokenAt = 0;
    async function api(method, path, body) {
        if (!token || now() - tokenAt > TOKEN_MAX_AGE_MS) {
            try {
                token = await getAccessToken(sa, { fetchImpl, now, scope: WRITE_SCOPE });
                tokenAt = now();
            } catch (err) {
                token = null;
                return { status: err.status || 0, ok: false, json: null, text: `token: ${err.message}` };
            }
        }
        const init = { method, headers: { authorization: `Bearer ${token}` } };
        if (body !== undefined) {
            init.headers['content-type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        try {
            const res = await fetchImpl(`${RULES_API}/${path}`, init);
            const text = await res.text();
            let json = null;
            try { json = text ? JSON.parse(text) : {}; } catch { json = null; }
            return { status: res.status, ok: res.ok, json, text };
        } catch (err) {
            return { status: 0, ok: false, json: null, text: err.message };
        }
    }
    const describe = r => `HTTP ${r.status || 'network error'} ${String(r.text).replace(/\s+/g, ' ').slice(0, 200)}`;

    function backoff() {
        let i = 0;
        return async label => {
            const d = delays[Math.min(i++, delays.length - 1)];
            if (now() + d * 1000 > deadline) throw new FallbackError(`out of time (${budgetS}s) while ${label}`);
            log(`${label}; waiting ${d}s.`);
            await wait(d);
        };
    }

    /** GET with retries on transient errors; non-transient errors are fatal. */
    async function getJson(path, label) {
        const pause = backoff();
        for (;;) {
            const r = await api('GET', path);
            if (r.ok && r.json) return r.json;
            if (!isTransientStatus(r.status)) throw new FallbackError(`${label}: ${describe(r)}`);
            await pause(`${label}: ${describe(r)}`);
        }
    }

    /** Newest ruleset (optionally created at or after `sinceMs`) whose source equals the file, or null. */
    async function findIdentical(sinceMs) {
        const list = await getJson(`${project}/rulesets?pageSize=${LIST_PAGE_SIZE}`, 'listing rulesets');
        const candidates = (list.rulesets || [])
            .filter(rs => rs && rs.name && rs.name.startsWith(`${project}/rulesets/`))
            .filter(rs => sinceMs === null || Date.parse(rs.createTime) >= sinceMs)
            .sort((a, b) => Date.parse(b.createTime) - Date.parse(a.createTime));
        for (const rs of candidates) {
            const full = await getJson(rs.name, `reading ${rs.name}`);
            if (sameSource(full, source)) return rs.name;
        }
        return null;
    }

    // 0. Already live?
    const before = await getJson(releaseName, 'reading the release');
    if (before.rulesetName) {
        const live = await getJson(before.rulesetName, `reading ${before.rulesetName}`);
        if (sameSource(live, source)) {
            log(`The live release already points at ${before.rulesetName}, which equals the file; nothing to do.`);
            return { rulesetName: before.rulesetName, created: false, released: false };
        }
    }
    log(`Live release: ${before.rulesetName || '(none)'}; publishing ${source.length} bytes.`);

    // 1. Reuse or create.
    let rulesetName = await findIdentical(null);
    let created = false;
    if (rulesetName) {
        log(`Reusing ${rulesetName}: its source equals the file.`);
    } else {
        const pause = backoff();
        for (let attempt = 1; !rulesetName; attempt++) {
            if (attempt > MAX_WRITES) throw new FallbackError(`no ruleset after ${MAX_WRITES} create attempts`);
            const startedMs = now();
            const r = await api('POST', `${project}/rulesets`, { source: { files: [{ name: RULES_FILE_NAME, content }] } });
            if (r.ok && r.json && r.json.name) {
                rulesetName = r.json.name;
                created = true;
                log(`Created ${rulesetName}.`);
                break;
            }
            if (!isTransientStatus(r.status)) throw new FallbackError(`creating the ruleset: ${describe(r)}`);
            log(`Creating the ruleset answered ${describe(r)}; checking whether it was applied anyway.`);
            for (let k = 0; k < RECHECKS_AFTER_WRITE && !rulesetName; k++) {
                await pause('waiting for a ruleset created by that request');
                rulesetName = await findIdentical(startedMs - CREATE_SKEW_MS);
            }
            if (rulesetName) {
                created = true;
                log(`The create was applied despite the error: ${rulesetName}.`);
            }
        }
    }

    // 2. Read it back: never release anything but the file's exact bytes.
    const ruleset = await getJson(rulesetName, `reading ${rulesetName}`);
    if (!sameSource(ruleset, source)) {
        throw new FallbackError(`${rulesetName} does not hold the file's exact source; the release was not changed`);
    }
    log(`Verified: ${rulesetName} is byte-identical to the file.`);

    // 3. Point the release at it.
    const pause = backoff();
    for (let attempt = 1; attempt <= MAX_WRITES; attempt++) {
        const r = await api('PATCH', releaseName, { release: { name: releaseName, rulesetName } });
        if (!r.ok && !isTransientStatus(r.status)) throw new FallbackError(`updating the release: ${describe(r)}`);
        if (!r.ok) log(`Updating the release answered ${describe(r)}; checking whether it was applied anyway.`);
        for (let k = 0; k < RECHECKS_AFTER_WRITE; k++) {
            const rel = await getJson(releaseName, 'reading the release');
            if (rel.rulesetName === rulesetName) {
                log(`The release ${releaseName} now points at ${rulesetName}${r.ok ? '' : ' (applied despite the error)'}.`);
                return { rulesetName, created, released: true };
            }
            if (r.ok && k === 0) log(`The release still shows ${rel.rulesetName}; rechecking.`);
            await pause(`the release does not show ${rulesetName} yet`);
        }
    }
    throw new FallbackError(`the release does not point at ${rulesetName} after ${MAX_WRITES} attempts`);
}

function parseArgs(argv) {
    const opts = { project: '', rules: '', commit: '', credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || '' };
    for (let i = 0; i < argv.length; i += 2) {
        const key = { '--project': 'project', '--rules': 'rules', '--commit': 'commit', '--credentials': 'credentials' }[argv[i]];
        if (!key || argv[i + 1] === undefined) throw new Error(`Bad option: ${argv[i]}`);
        opts[key] = argv[i + 1];
    }
    if (!opts.project || !opts.rules || !opts.commit || !opts.credentials) {
        throw new Error('Usage: node tools/ci/rules-rest-deploy.js --project <id> --rules <file> --commit <sha> [--credentials <sa.json>]');
    }
    if (!/^[0-9a-f]{40}$/i.test(opts.commit)) throw new Error(`--commit must be a full commit SHA: ${opts.commit}`);
    return opts;
}

/** The file's bytes, after checking they equal the file as committed in `commit`. */
function committedSource(rulesPath, commit, show = (sha, p) => execFileSync('git', ['show', `${sha}:${p}`], { maxBuffer: 64 * 1024 * 1024 })) {
    const onDisk = fs.readFileSync(rulesPath);
    const committed = show(commit, rulesPath.replace(/\\/g, '/').replace(/^\.\//, ''));
    if (!onDisk.equals(committed)) throw new FallbackError(`${rulesPath} differs from ${rulesPath} in commit ${commit}`);
    return onDisk;
}

if (require.main === module) {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(err.message);
        process.exit(2);
    }
    (async () => {
        const source = committedSource(opts.rules, opts.commit);
        const sa = JSON.parse(fs.readFileSync(opts.credentials, 'utf8'));
        const r = await publishRules({ projectId: opts.project, source, sa });
        console.log(`::notice title=Firestore rules published via the REST fallback::${r.rulesetName}${r.created ? ' (new ruleset)' : ''}${r.released ? '' : ' was already live'}.`);
    })().catch(err => {
        console.log(`::error title=Rules REST fallback failed::${err.message}. Hosting is not deployed; re-run the failed jobs later.`);
        process.exit(1);
    });
}

module.exports = { publishRules, sameSource, committedSource, parseArgs, FallbackError, WRITE_SCOPE, DEFAULT_BUDGET_S };
