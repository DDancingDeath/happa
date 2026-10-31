#!/usr/bin/env node
/**
 * Reads the Firestore ruleset that is live in a Firebase project and compares
 * it with the repo's firestore.rules. Read-only: it signs a token for the
 * service account (scope firebase.readonly) and makes two GETs to the
 * Firebase Rules API -- the `cloud.firestore` release, then the ruleset it
 * points at. It never creates, updates or deletes anything.
 *
 * Used by tools/ci/deploy-with-retry.js (a 409 "Release ... already exists"
 * counts as deployed only when the live ruleset equals the repo's) and by the
 * last step of .github/workflows/firestore-rules-deploy.yml:
 *
 *   node tools/ci/live-rules.js verify --project <id> --rules firestore.rules \
 *     [--credentials <service-account.json>]   # default $GOOGLE_APPLICATION_CREDENTIALS
 *
 * Exit 0 when the live ruleset equals the file, 1 when it differs or cannot be
 * read (after retries), 2 on bad usage.
 *
 * LIVE_RULES_RETRY_DELAYS (comma-separated seconds, default 5,15,30,60) sets
 * the waits between reads: transient API errors (5xx, 429, network) are
 * retried, and so is a mismatch (a release can take a moment to show).
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');

const RULES_API = 'https://firebaserules.googleapis.com/v1';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.readonly';
const RELEASE = 'cloud.firestore';
const REFUSED_PROJECTS = ['aadhat-management'];
const DEFAULT_DELAYS_S = [5, 15, 30, 60];

class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

/** True for errors worth another try: 5xx, 429, 409 and network failures (no status). */
function isTransient(err) {
    const s = err && err.status;
    return s === undefined || s === 429 || s === 409 || s >= 500;
}

const b64url = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** OAuth2 access token for a service-account key (JWT bearer grant). */
async function getAccessToken(sa, { fetchImpl = fetch, now = Date.now } = {}) {
    if (!sa || !sa.client_email || !sa.private_key) throw new Error('Service account JSON needs client_email and private_key');
    const iat = Math.floor(now() / 1000);
    const aud = sa.token_uri || TOKEN_URI;
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud, iat, exp: iat + 600 }));
    const signature = b64url(crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key));
    const res = await fetchImpl(aud, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: `${header}.${claims}.${signature}`
        }).toString()
    });
    if (!res.ok) throw new ApiError(`token: HTTP ${res.status} ${await res.text()}`, res.status);
    const body = await res.json();
    if (!body.access_token) throw new Error('token: no access_token in the response');
    return body.access_token;
}

async function getJson(url, token, fetchImpl) {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new ApiError(`GET ${url}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
    return res.json();
}

/** The live Firestore release and its ruleset's files: { rulesetName, updateTime, files: [{name, content}] }. */
async function fetchLiveRules(projectId, token, { fetchImpl = fetch } = {}) {
    const release = await getJson(`${RULES_API}/projects/${encodeURIComponent(projectId)}/releases/${RELEASE}`, token, fetchImpl);
    if (!release.rulesetName) throw new Error(`Release ${release.name || RELEASE} has no rulesetName`);
    const ruleset = await getJson(`${RULES_API}/${release.rulesetName}`, token, fetchImpl);
    const files = (ruleset.source && ruleset.source.files) || [];
    return { rulesetName: release.rulesetName, updateTime: release.updateTime || '', files };
}

const normalise = s => String(s).replace(/\r\n/g, '\n');

/** { equal, reason } for the repo's rules text against the live ruleset's files. */
function compareRules(localContent, files) {
    if (files.length !== 1) return { equal: false, reason: `the live ruleset has ${files.length} files (expected 1)` };
    const live = normalise(files[0].content);
    const local = normalise(localContent);
    if (live === local) return { equal: true, reason: 'identical' };
    const a = local.split('\n');
    const b = live.split('\n');
    let line = 0;
    while (line < a.length && line < b.length && a[line] === b[line]) line++;
    return { equal: false, reason: `first difference at line ${line + 1} (repo ${a.length} lines, live ${b.length} lines)` };
}

const sleep = s => new Promise(r => setTimeout(r, s * 1000));

/**
 * Reads the live ruleset and compares it with `localContent`, retrying
 * transient errors and mismatches with `delays`. Resolves
 * { ok: true|false, reason, rulesetName? }; never throws.
 */
async function verifyLiveRules({ projectId, localContent, sa, delays = DEFAULT_DELAYS_S, fetchImpl = fetch, wait = sleep, log = console.log }) {
    if (REFUSED_PROJECTS.includes(projectId)) return { ok: false, reason: `refusing to read ${projectId}` };
    let last = { ok: false, reason: 'not checked' };
    for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
        try {
            const token = await getAccessToken(sa, { fetchImpl });
            const live = await fetchLiveRules(projectId, token, { fetchImpl });
            const cmp = compareRules(localContent, live.files);
            last = { ok: cmp.equal, reason: cmp.reason, rulesetName: live.rulesetName };
            log(`Live ruleset ${live.rulesetName} (released ${live.updateTime || '?'}): ${cmp.equal ? 'equals' : 'differs from'} the repo's firestore.rules${cmp.equal ? '' : ` -- ${cmp.reason}`}`);
            if (cmp.equal) return last;
        } catch (err) {
            last = { ok: false, reason: err.message };
            log(`Could not read the live ruleset: ${err.message}`);
            if (!isTransient(err)) return last;
        }
        if (attempt <= delays.length) {
            log(`Checking the live ruleset again in ${delays[attempt - 1]}s (${attempt}/${delays.length + 1}).`);
            await wait(delays[attempt - 1]);
        }
    }
    return last;
}

function parseDelays(value) {
    if (value === undefined || value === '') return DEFAULT_DELAYS_S;
    const delays = String(value).split(',').map(s => Number(s.trim()));
    if (delays.some(d => !Number.isFinite(d) || d < 0)) throw new Error(`Bad retry delays: ${value}`);
    return delays;
}

function parseArgs(argv) {
    const [cmd, ...rest] = argv;
    if (cmd !== 'verify') throw new Error('Usage: node tools/ci/live-rules.js verify --project <id> --rules <file> [--credentials <sa.json>]');
    const opts = { project: '', rules: '', credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || '' };
    for (let i = 0; i < rest.length; i += 2) {
        const key = { '--project': 'project', '--rules': 'rules', '--credentials': 'credentials' }[rest[i]];
        if (!key || rest[i + 1] === undefined) throw new Error(`Bad option: ${rest[i]}`);
        opts[key] = rest[i + 1];
    }
    if (!opts.project || !opts.rules || !opts.credentials) throw new Error('--project, --rules and --credentials (or GOOGLE_APPLICATION_CREDENTIALS) are required');
    return opts;
}

if (require.main === module) {
    let opts;
    let delays;
    try {
        opts = parseArgs(process.argv.slice(2));
        delays = parseDelays(process.env.LIVE_RULES_RETRY_DELAYS);
    } catch (err) {
        console.error(err.message);
        process.exit(2);
    }
    const sa = JSON.parse(fs.readFileSync(opts.credentials, 'utf8'));
    verifyLiveRules({ projectId: opts.project, localContent: fs.readFileSync(opts.rules, 'utf8'), sa, delays }).then(r => {
        if (r.ok) {
            console.log(`::notice title=Firestore rules verified::The live ruleset (${r.rulesetName}) equals ${opts.rules}.`);
            process.exit(0);
        }
        console.log(`::error title=Live Firestore rules do not match the repo::${r.reason}. The app must not be deployed on these rules; re-run the workflow, or deploy by hand: firebase deploy --only firestore:rules`);
        process.exit(1);
    });
}

module.exports = { getAccessToken, fetchLiveRules, compareRules, verifyLiveRules, isTransient, parseArgs, parseDelays, ApiError, SCOPE, RELEASE, DEFAULT_DELAYS_S };
