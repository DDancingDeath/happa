/**
 * @jest-environment node
 */
// tools/ci/live-rules.js: reads the live Firestore ruleset (read-only) and
// compares it with the repo's firestore.rules. Fake fetch, real JWT signing.
const crypto = require('crypto');
const { compareRules, verifyLiveRules, getAccessToken, SCOPE } = require('../../tools/ci/live-rules');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = {
    client_email: 'ci@happa-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: 'https://oauth2.googleapis.com/token'
};
const RULES = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n  }\n}\n";
const RULES_API = 'https://firebaserules.googleapis.com/v1';

const reply = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
});

/**
 * Fake Google: the token endpoint checks the JWT; the Rules API serves the
 * `cloud.firestore` release and its ruleset. `live` is the ruleset's content,
 * or a list of per-call contents; `failures` are statuses for the first
 * release GETs.
 */
function fakeGoogle({ live = RULES, failures = [] } = {}) {
    const calls = [];
    let releaseGets = 0;
    const fetchImpl = async (url, init = {}) => {
        const method = init.method || 'GET';
        calls.push(`${method} ${url}`);
        if (url === SA.token_uri) {
            const assertion = new URLSearchParams(init.body).get('assertion');
            const [h, c, sig] = assertion.split('.');
            const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url'));
            const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
            if (!ok || claims.iss !== SA.client_email || claims.scope !== SCOPE) return reply(400, { error: 'invalid_grant' });
            return reply(200, { access_token: 'tok' });
        }
        if (init.headers.authorization !== 'Bearer tok') return reply(401, {});
        if (url === `${RULES_API}/projects/happa-test/releases/cloud.firestore`) {
            const n = releaseGets++;
            if (n < failures.length) return reply(failures[n], { error: { message: 'The service is currently unavailable.' } });
            return reply(200, { name: 'projects/happa-test/releases/cloud.firestore', rulesetName: `projects/happa-test/rulesets/rs-${n}`, updateTime: '2026-10-31T13:42:25Z' });
        }
        const m = url.match(/\/projects\/happa-test\/rulesets\/rs-(\d+)$/);
        if (m) {
            const content = Array.isArray(live) ? live[Math.min(Number(m[1]) - failures.length, live.length - 1)] : live;
            return reply(200, { source: { files: [{ name: 'firestore.rules', content }] } });
        }
        return reply(404, {});
    };
    return { fetchImpl, calls };
}

const verify = (fake, extra = {}) => verifyLiveRules({
    projectId: 'happa-test', localContent: RULES, sa: SA, delays: [0, 0, 0], wait: async () => {}, log: () => {}, fetchImpl: fake.fetchImpl, ...extra
});

test('equal when the live release points at a ruleset with the repo\'s source; only reads', async () => {
    const fake = fakeGoogle();
    await expect(verify(fake)).resolves.toMatchObject({ ok: true, rulesetName: 'projects/happa-test/rulesets/rs-0' });
    expect(fake.calls).toEqual([
        'POST https://oauth2.googleapis.com/token',
        `GET ${RULES_API}/projects/happa-test/releases/cloud.firestore`,
        `GET ${RULES_API}/projects/happa-test/rulesets/rs-0`
    ]);
});

test('different live rules are rechecked, then reported with the first differing line', async () => {
    const old = RULES.replace('{db}', '{database}');
    const fake = fakeGoogle({ live: old });
    const r = await verify(fake);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/first difference at line 3/);
    expect(fake.calls.filter(c => c.includes('/releases/')).length).toBe(4);
});

test('a release that shows the new ruleset on the second read passes', async () => {
    const fake = fakeGoogle({ live: ['old', RULES] });
    await expect(verify(fake)).resolves.toMatchObject({ ok: true });
});

test('retries 503s from the Rules API, but not a 403', async () => {
    await expect(verify(fakeGoogle({ failures: [503, 503] }))).resolves.toMatchObject({ ok: true });
    const denied = fakeGoogle({ failures: [403] });
    const r = await verify(denied);
    expect(r).toMatchObject({ ok: false });
    expect(r.reason).toMatch(/HTTP 403/);
    expect(denied.calls.filter(c => c.includes('/releases/')).length).toBe(1);
});

test('refuses aadhat-management without any request', async () => {
    const fake = fakeGoogle();
    await expect(verify(fake, { projectId: 'aadhat-management' })).resolves.toMatchObject({ ok: false });
    expect(fake.calls).toEqual([]);
});

test('compareRules ignores CRLF vs LF only, and wants exactly one file', () => {
    expect(compareRules(RULES.replace(/\n/g, '\r\n'), [{ content: RULES }]).equal).toBe(true);
    expect(compareRules(RULES, [{ content: `${RULES} ` }]).equal).toBe(false);
    expect(compareRules(RULES, []).equal).toBe(false);
});

test('a bad key is refused by the token endpoint', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    await expect(getAccessToken({ ...SA, private_key: other }, { fetchImpl: fakeGoogle().fetchImpl })).rejects.toThrow(/HTTP 400/);
});
