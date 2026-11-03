/**
 * @jest-environment node
 */
// tools/ci/rules-rest-deploy.js: the Rules REST API fallback. A fake Rules API
// (fake fetch) that, like the real one in Nov 2026, can answer 503 to a create
// or a release update and still apply it.
const crypto = require('crypto');
const { publishRules, committedSource, parseArgs, FallbackError, WRITE_SCOPE } = require('../../tools/ci/rules-rest-deploy');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = { client_email: 'ci@happa-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const API = 'https://firebaserules.googleapis.com/v1';
const P = 'projects/happa-test';
const RELEASE = `${P}/releases/cloud.firestore`;
const RULES = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n    match /items/{id} { allow read: if request.auth != null; }\n  }\n}\n";
const OLD = RULES.replace('request.auth != null', 'false');
const T0 = Date.parse('2026-11-03T01:00:00Z');

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body });
const unavailable = () => reply(503, { error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE' } });

/**
 * rulesets: [{ id, content, createTime }] (newest last); live: id of the released ruleset.
 * createFails / patchFails: one entry per call, 'applied-503' (503 but applied), '503', '400', or 'ok'.
 * corrupt: the server stores created content altered (to test the read-back check).
 */
function fakeRulesApi({ rulesets = [], live = 'old', createFails = [], patchFails = [], corrupt = null, clock }) {
    const store = new Map(rulesets.map(r => [`${P}/rulesets/${r.id}`, r]));
    const state = { live: `${P}/rulesets/${live}`, writes: [], calls: [] };
    let creates = 0;
    let patches = 0;
    let seq = 0;
    const fetchImpl = async (url, init = {}) => {
        const method = init.method || 'GET';
        if (url === 'https://oauth2.googleapis.com/token') {
            const claims = JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion').split('.')[1], 'base64url').toString());
            expect(claims.scope).toBe(WRITE_SCOPE);
            return reply(200, { access_token: 'tok' });
        }
        expect(init.headers.authorization).toBe('Bearer tok');
        const path = url.slice(API.length + 1);
        state.calls.push(`${method} ${path}`);
        if (method === 'GET' && path === RELEASE) return reply(200, { name: RELEASE, rulesetName: state.live, updateTime: '2026-11-02T22:19:11Z' });
        if (method === 'GET' && path.startsWith(`${P}/rulesets?`)) {
            const list = [...store.entries()].reverse().map(([name, r]) => ({ name, createTime: r.createTime, metadata: { services: ['cloud.firestore'] } }));
            return reply(200, { rulesets: list });
        }
        if (method === 'GET' && store.has(path)) {
            return reply(200, { name: path, source: { files: [{ name: 'firestore.rules', content: store.get(path).content }] } });
        }
        if (method === 'POST' && path === `${P}/rulesets`) {
            const mode = createFails[creates++] || 'ok';
            state.writes.push('create');
            if (mode === '400') return reply(400, { error: { message: 'Compilation error' } });
            if (mode === '503') return unavailable();
            const content = JSON.parse(init.body).source.files[0].content;
            const name = `${P}/rulesets/new-${++seq}`;
            store.set(name, { content: corrupt ? corrupt(content) : content, createTime: new Date(clock.now()).toISOString().replace('Z', '123Z') });
            return mode === 'applied-503' ? unavailable() : reply(200, { name, createTime: store.get(name).createTime });
        }
        if (method === 'PATCH' && path === RELEASE) {
            const mode = patchFails[patches++] || 'ok';
            const body = JSON.parse(init.body);
            state.writes.push(`release -> ${body.release.rulesetName}`);
            if (mode === '503') return unavailable();
            if (mode === '400') return reply(400, { error: { message: 'bad' } });
            state.live = body.release.rulesetName;
            return mode === 'applied-503' ? unavailable() : reply(200, { name: RELEASE, rulesetName: state.live });
        }
        return reply(404, { error: { message: `no ${method} ${path}` } });
    };
    return { fetchImpl, state, store };
}

function clock() {
    let t = T0;
    return { now: () => t, wait: async s => { t += s * 1000; }, advance: ms => { t += ms; } };
}

async function publish(api, c, extra = {}) {
    const lines = [];
    const result = await publishRules({
        projectId: 'happa-test', source: Buffer.from(RULES), sa: SA,
        fetchImpl: api.fetchImpl, now: c.now, wait: c.wait, log: l => lines.push(l), ...extra
    });
    return { result, out: lines.join('\n') };
}

const base = () => [
    { id: 'old', content: OLD, createTime: '2026-11-01T10:00:00.000001Z' },
    { id: 'older', content: OLD + '\n', createTime: '2026-10-31T10:00:00Z' }
];

test('happy path: creates the ruleset, reads it back, releases it', async () => {
    const c = clock();
    const api = fakeRulesApi({ rulesets: base(), clock: c });
    const { result } = await publish(api, c);
    expect(result).toEqual({ rulesetName: `${P}/rulesets/new-1`, created: true, released: true });
    expect(api.state.writes).toEqual(['create', `release -> ${P}/rulesets/new-1`]);
    expect(api.state.live).toBe(`${P}/rulesets/new-1`);
});

test('a create that answers 503 but was applied is found by re-listing, not created twice', async () => {
    const c = clock();
    const api = fakeRulesApi({ rulesets: base(), createFails: ['applied-503'], clock: c });
    const { result, out } = await publish(api, c);
    expect(result).toEqual({ rulesetName: `${P}/rulesets/new-1`, created: true, released: true });
    expect(api.state.writes).toEqual(['create', `release -> ${P}/rulesets/new-1`]);
    expect(out).toMatch(/applied despite the error: projects\/happa-test\/rulesets\/new-1/);
});

test('a create that answers 503 and was not applied is retried', async () => {
    const c = clock();
    const api = fakeRulesApi({ rulesets: base(), createFails: ['503', 'ok'], clock: c });
    const { result } = await publish(api, c);
    expect(result.rulesetName).toBe(`${P}/rulesets/new-1`);
    expect(api.state.writes).toEqual(['create', 'create', `release -> ${P}/rulesets/new-1`]);
});

test('a release update that answers 503 but was applied is confirmed by re-reading, not patched twice', async () => {
    const c = clock();
    const api = fakeRulesApi({ rulesets: base(), patchFails: ['applied-503'], clock: c });
    const { result, out } = await publish(api, c);
    expect(result).toEqual({ rulesetName: `${P}/rulesets/new-1`, created: true, released: true });
    expect(api.state.writes).toEqual(['create', `release -> ${P}/rulesets/new-1`]);
    expect(out).toMatch(/now points at projects\/happa-test\/rulesets\/new-1 \(applied despite the error\)/);
});

test('a release update that answers 503 and was not applied is retried', async () => {
    const c = clock();
    const api = fakeRulesApi({ rulesets: base(), patchFails: ['503', 'ok'], clock: c });
    await publish(api, c);
    expect(api.state.writes).toEqual(['create', `release -> ${P}/rulesets/new-1`, `release -> ${P}/rulesets/new-1`]);
    expect(api.state.live).toBe(`${P}/rulesets/new-1`);
});

test('a ruleset whose source is not byte-identical aborts before the release is touched', async () => {
    const c = clock();
    const api = fakeRulesApi({ rulesets: base(), corrupt: s => s.replace(/\n/g, '\r\n'), clock: c });
    await expect(publish(api, c)).rejects.toThrow(/new-1 does not hold the file's exact source; the release was not changed/);
    expect(api.state.writes).toEqual(['create']);
    expect(api.state.live).toBe(`${P}/rulesets/old`);
});

test('reuses an existing identical ruleset without creating one', async () => {
    const c = clock();
    const rulesets = [...base(), { id: 'same', content: RULES, createTime: '2026-11-02T22:19:11.387311Z' }];
    const api = fakeRulesApi({ rulesets, clock: c });
    const { result, out } = await publish(api, c);
    expect(result).toEqual({ rulesetName: `${P}/rulesets/same`, created: false, released: true });
    expect(api.state.writes).toEqual([`release -> ${P}/rulesets/same`]);
    expect(out).toMatch(/Reusing projects\/happa-test\/rulesets\/same/);
});

test('rules already live: nothing is written', async () => {
    const c = clock();
    const api = fakeRulesApi({ rulesets: [...base(), { id: 'same', content: RULES, createTime: '2026-11-02T22:00:00Z' }], live: 'same', clock: c });
    const { result } = await publish(api, c);
    expect(result).toEqual({ rulesetName: `${P}/rulesets/same`, created: false, released: false });
    expect(api.state.writes).toEqual([]);
});

test('a 400 from the create (rules do not compile) fails at once', async () => {
    const c = clock();
    const api = fakeRulesApi({ rulesets: base(), createFails: ['400'], clock: c });
    await expect(publish(api, c)).rejects.toThrow(/creating the ruleset: HTTP 400/);
    expect(api.state.writes).toEqual(['create']);
});

test('a Rules API that never recovers fails within the time budget, release untouched', async () => {
    const c = clock();
    const api = fakeRulesApi({ rulesets: base(), createFails: Array(20).fill('503'), clock: c });
    await expect(publish(api, c, { budgetS: 300 })).rejects.toThrow(FallbackError);
    expect(c.now() - T0).toBeLessThanOrEqual(300 * 1000);
    expect(api.state.live).toBe(`${P}/rulesets/old`);
    expect(api.state.writes.every(w => w === 'create')).toBe(true);
});

test('refuses aadhat-management without calling the API', async () => {
    const c = clock();
    const api = fakeRulesApi({ rulesets: base(), clock: c });
    await expect(publish(api, c, { projectId: 'aadhat-management' })).rejects.toThrow(/refusing/);
    expect(api.state.calls).toEqual([]);
});

test('committedSource: the file must equal the commit being deployed', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(__dirname, '.work-'));
    try {
        const file = path.join(dir, 'firestore.rules');
        fs.writeFileSync(file, RULES);
        expect(committedSource(file, 'c'.repeat(40), () => Buffer.from(RULES)).equals(Buffer.from(RULES))).toBe(true);
        expect(() => committedSource(file, 'c'.repeat(40), () => Buffer.from(OLD))).toThrow(/differs from/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('parseArgs requires a full commit SHA', () => {
    const args = ['--project', 'p', '--rules', 'firestore.rules', '--credentials', 'sa.json'];
    expect(() => parseArgs(args)).toThrow(/Usage/);
    expect(() => parseArgs([...args, '--commit', 'abc'])).toThrow(/full commit SHA/);
    expect(parseArgs([...args, '--commit', 'a'.repeat(40)])).toMatchObject({ project: 'p', commit: 'a'.repeat(40) });
});
