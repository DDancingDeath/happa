/**
 * #194 quota guards: quota-error detection, the once-per-session banner,
 * the read counter (pure + SDK wrappers), preview-host detection in
 * firebaseConfig.js and the stock-checkpoint rebuild lease decision.
 */
import {
    isQuotaExhaustedError,
    createQuotaGuard,
    createReadCounter,
    readsForQueryGet,
    readsForQuerySnapshot,
    readsForDocSnapshot,
    quotaBannerText
} from '../utils/quota-guard.js';
import { installFirestoreMeter, getQuotaStatus, getIoCounts, sourceLabel } from '../firebase/firestore-meter.js';
import { decideStockRebuild, leaseOwnerUid, LEASE_MAX_WAIT_MS, memberWindowStart, MEMBER_APPROX_MAX_EXTRA_MS } from '../utils/rebuild-lease.js';

const fs = require('fs');
const path = require('path');

describe('isQuotaExhaustedError', () => {
    test.each([
        [{ code: 'resource-exhausted', message: 'Quota exceeded.' }],
        [{ code: 'RESOURCE_EXHAUSTED' }],
        [{ code: 8, message: '8 RESOURCE_EXHAUSTED: Quota exceeded' }],
        [{ status: 429 }],
        [new Error('FirebaseError: [code=resource-exhausted]: Quota exceeded.')],
        ['@firebase/firestore: Firestore (10.7.1): FirebaseError: [code=resource-exhausted]: Quota exceeded.']
    ])('detects %p', (err) => expect(isQuotaExhaustedError(err)).toBe(true));

    test.each([
        [null], [undefined], [42],
        [{ code: 'permission-denied', message: 'Missing or insufficient permissions.' }],
        [{ code: 'unavailable' }],
        [new DOMException('Setting the value exceeded the quota.', 'QuotaExceededError')],
        ['Telemetry sync failed']
    ])('ignores %p', (err) => expect(isQuotaExhaustedError(err)).toBe(false));
});

describe('quota banner', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        sessionStorage.clear();
    });

    const quiet = { warn: jest.fn() };

    test('shows one bilingual banner per session however many errors arrive', () => {
        const onQuota = jest.fn();
        const guard = createQuotaGuard({ log: quiet, onQuota });
        for (let i = 0; i < 5; i++) guard.noteQuotaExhausted('purchases listen');
        const banners = document.querySelectorAll('#quotaBanner');
        expect(banners).toHaveLength(1);
        expect(banners[0].textContent).toContain(quotaBannerText('en'));
        expect(banners[0].textContent).not.toMatch(/[\u0900-\u097F]/);
        expect(banners[0].textContent).toMatch(/12:30–13:30 IST/);
        expect(banners[0].textContent).not.toMatch(/staff|स्टाफ/i);
        expect(onQuota).toHaveBeenCalledTimes(1);
        expect(guard.status().quota).toMatchObject({ count: 5, lastSource: 'purchases listen' });
    });

    test('once dismissed it stays hidden for the rest of the session', () => {
        createQuotaGuard({ log: quiet }).noteQuotaExhausted('a');
        document.querySelector('#quotaBanner button').click();
        expect(document.getElementById('quotaBanner')).toBeNull();
        // A reload in the same tab gets a new guard.
        createQuotaGuard({ log: quiet }).noteQuotaExhausted('b');
        expect(document.getElementById('quotaBanner')).toBeNull();
    });
});

describe('read counter', () => {
    test('aggregates by source, ranks the top 5 and warns once past the threshold', () => {
        const onHeavy = jest.fn();
        const c = createReadCounter({ threshold: 100, onHeavy });
        ['a', 'b', 'c', 'd', 'e', 'f'].forEach((s, i) => c.add(s, (i + 1) * 5));
        c.add('a', 0);
        c.add('a', -3);
        expect(c.total).toBe(105);
        expect(onHeavy).toHaveBeenCalledTimes(1);
        expect(onHeavy.mock.calls[0][0]).toBe(105);
        c.add('a', 50);
        expect(onHeavy).toHaveBeenCalledTimes(1);
        expect(c.top(5)).toEqual([
            { source: 'a', reads: 55 }, { source: 'f', reads: 30 }, { source: 'e', reads: 25 },
            { source: 'd', reads: 20 }, { source: 'c', reads: 15 }
        ]);
    });

    test('counts billed reads: server results only, initial load in full, then changes', () => {
        const snap = (size, fromCache, changes = []) => ({ size, metadata: { fromCache }, docChanges: () => changes });
        expect(readsForQueryGet(snap(0, false))).toBe(1);
        expect(readsForQueryGet(snap(40, false))).toBe(40);
        expect(readsForQueryGet(snap(40, true))).toBe(0);

        const st = { synced: false };
        expect(readsForQuerySnapshot(snap(300, true), st)).toBe(0);
        expect(readsForQuerySnapshot(snap(300, false), st)).toBe(300);
        const own = { type: 'added', doc: { metadata: { hasPendingWrites: true } } };
        const remote = { type: 'modified', doc: { metadata: { hasPendingWrites: false } } };
        expect(readsForQuerySnapshot(snap(301, false, [own, remote, { type: 'removed', doc: {} }]), st)).toBe(1);

        const ds = { synced: false };
        expect(readsForDocSnapshot({ metadata: { fromCache: true } }, ds)).toBe(0);
        expect(readsForDocSnapshot({ metadata: { fromCache: false } }, ds)).toBe(1);
        expect(readsForDocSnapshot({ metadata: { fromCache: false, hasPendingWrites: true } }, ds)).toBe(0);
    });

    test('the SDK wrappers count gets and listener snapshots and keep the SDK results', async () => {
        const result = (size) => ({ size, metadata: { fromCache: false }, docChanges: () => [] });
        class Query {
            constructor(p) { this._delegate = { _query: { path: { canonicalString: () => p } } }; }
            get() { return Promise.resolve(result(7)); }
            onSnapshot(opts, next, error) {
                this.fire = (s) => next(s);
                this.fail = (e) => error(e);
                return 'unsub';
            }
        }
        class CollectionReference extends Query {
            constructor(p) { super(p); this.path = p; }
            add() { return Promise.reject(Object.assign(new Error('Quota exceeded.'), { code: 'resource-exhausted' })); }
        }
        class DocumentReference {
            constructor(p) { this.path = p; }
            get() { return Promise.resolve({ exists: true, metadata: { fromCache: false } }); }
            set() { return Promise.resolve(); }
        }
        const sdk = { Query, CollectionReference, DocumentReference };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(installFirestoreMeter(sdk)).toBe(true);
        const before = getQuotaStatus().reads;
        const io0 = getIoCounts();

        const snap = await new Query('dev_purchases').get();
        expect(snap.size).toBe(7);
        await new DocumentReference('stockCheckpoints/current').get();
        const q = new Query('items');
        const seen = [];
        const errors = [];
        expect(q.onSnapshot({ includeMetadataChanges: true }, s => seen.push(s), e => errors.push(e))).toBe('unsub');
        q.fire(result(12));
        q.fire({ size: 12, metadata: { fromCache: false }, docChanges: () => [{ type: 'modified', doc: { metadata: {} } }] });
        expect(seen).toHaveLength(2);

        const st = getQuotaStatus();
        expect(st.reads - before).toBe(7 + 1 + 12 + 1);
        expect(st.top).toEqual(expect.arrayContaining([
            { source: 'items listen', reads: 13 },
            { source: 'dev_purchases get', reads: 7 },
            { source: 'stockCheckpoints (doc) get', reads: 1 }
        ]));

        // Quota errors on writes and listeners reach the banner; the caller still sees the error.
        await expect(new CollectionReference('purchases').add({})).rejects.toMatchObject({ code: 'resource-exhausted' });
        q.fail({ code: 'resource-exhausted', message: 'Quota exceeded.' });
        expect(errors).toHaveLength(1);
        expect(getQuotaStatus().quota.count).toBeGreaterThanOrEqual(2);

        // Diagnostics › Status counters (#119): writes sent, failed writes, failed reads.
        await new DocumentReference('settings/app').set({});
        const io = getIoCounts();
        expect(io.writes - io0.writes).toBe(2);
        expect(io.writeErrors - io0.writeErrors).toBe(1);
        expect(io.readErrors - io0.readErrors).toBe(1);
        expect(document.getElementById('quotaBanner')).not.toBeNull();
        warn.mockRestore();
        document.body.innerHTML = '';
    });

    test('labels documents by their collection', () => {
        expect(sourceLabel({ path: 'users/abc' }, 'get')).toBe('users (doc) get');
        expect(sourceLabel({ path: 'dev_items' }, 'listen')).toBe('dev_items listen');
        expect(sourceLabel({}, 'get')).toBe('query get');
    });
});

describe('preview channels use test data (firebaseConfig.js)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'firebaseConfig.js'), 'utf8');
    const block = /\/\/ --- env-detect[^\n]*\n([\s\S]*?)\/\/ --- end env-detect ---/.exec(src);
    const { isPreviewHost, getEnvironment } = new Function(`${block[1]}; return { isPreviewHost, getEnvironment };`)();
    const store = (v = null) => ({ getItem: () => v });
    const at = (url) => { const u = new URL(url); return { hostname: u.hostname, search: u.search, protocol: u.protocol }; };

    test('detects Firebase Hosting preview hosts only', () => {
        expect(isPreviewHost('aadhat-management--v13-preview-abc123.web.app')).toBe(true);
        expect(isPreviewHost('aadhat-management--pr42-x1y2.firebaseapp.com')).toBe(true);
        expect(isPreviewHost('aadhat-management.web.app')).toBe(false);
        expect(isPreviewHost('aadhat-management.firebaseapp.com')).toBe(false);
        expect(isPreviewHost('localhost')).toBe(false);
        expect(isPreviewHost('evil--x.example.com')).toBe(false);
    });

    test('preview defaults to development (dev_ data) unless ?prod=1', () => {
        expect(getEnvironment(at('https://aadhat-management--v13-abc.web.app/'), store(), false)).toBe('development');
        expect(getEnvironment(at('https://aadhat-management--v13-abc.web.app/?prod=1'), store(), false)).toBe('production');
        expect(getEnvironment(at('https://aadhat-management--v13-abc.web.app/?prod=1'), store('development'), false)).toBe('production');
        expect(getEnvironment(at('https://aadhat-management--v13-abc.web.app/?env=staging'), store(), false)).toBe('staging');
    });

    test('live site, app and localhost keep their old environment', () => {
        expect(getEnvironment(at('https://aadhat-management.web.app/'), store(), false)).toBe('production');
        expect(getEnvironment(at('https://aadhat-management.web.app/?prod=1'), store(), false)).toBe('production');
        expect(getEnvironment(at('http://localhost:8080/'), store(), false)).toBe('development');
        expect(getEnvironment(at('http://localhost/'), store(), true)).toBe('production');
        expect(getEnvironment(at('https://aadhat-management.web.app/'), store('development'), false)).toBe('development');
    });

    test('shows a PREVIEW — test data badge on preview channels', () => {
        expect(src).toContain("'PREVIEW — test data'");
        expect(src).toMatch(/APP_ENV !== 'production' \|\| IS_PREVIEW_HOST/);
    });
});

describe('stock checkpoint rebuild lease (decideStockRebuild)', () => {
    const now = 1_000_000;
    test('a device already rebuilding joins its own rebuild', () => {
        expect(decideStockRebuild({ canManage: true, leaseUntil: now + 5000, now, inFlight: true })).toBe('join');
    });
    test('while another user holds the lease everyone waits (no full-history read)', () => {
        expect(decideStockRebuild({ canManage: true, leaseUntil: now + 1, leaseBy: 'other:1:x', uid: 'me', now })).toBe('wait');
        expect(decideStockRebuild({ canManage: false, leaseUntil: now + 60000, now })).toBe('wait');
    });
    test('an owner/manager takes the lease when none is active', () => {
        expect(decideStockRebuild({ canManage: true, leaseUntil: 0, now })).toBe('rebuild');
        expect(decideStockRebuild({ canManage: true, leaseUntil: now, now })).toBe('rebuild');
    });
    test('members, and owners after a failed attempt, replay full history', () => {
        expect(decideStockRebuild({ canManage: false, now })).toBe('full-read');
        expect(decideStockRebuild({ canManage: true, now, attempted: true })).toBe('full-read');
    });
    test("a lease left by the same user (reload mid-rebuild, new token) never blocks them", () => {
        expect(leaseOwnerUid('me:123:abc')).toBe('me');
        expect(decideStockRebuild({ canManage: true, leaseUntil: now + 600000, leaseBy: 'me:123:abc', uid: 'me', now })).toBe('rebuild');
        expect(decideStockRebuild({ canManage: false, leaseUntil: now + 600000, leaseBy: 'me:123:abc', uid: 'me', now })).toBe('full-read');
    });
    test('a dead lease by another user stops blocking after the wait cap', () => {
        const lease = { canManage: true, leaseUntil: now + 9 * 60000, leaseBy: 'other:1:x', uid: 'me', now };
        expect(decideStockRebuild({ ...lease, waitedMs: LEASE_MAX_WAIT_MS - 1 })).toBe('wait');
        expect(decideStockRebuild({ ...lease, waitedMs: LEASE_MAX_WAIT_MS })).toBe('full-read');
        expect(decideStockRebuild({ ...lease, canManage: false, waitedMs: LEASE_MAX_WAIT_MS })).toBe('full-read');
    });
    test('a far-future lease (holder clock ahead) is still capped by local waiting time', () => {
        const skewed = { canManage: false, leaseUntil: now + 365 * 86400000, leaseBy: 'other:1:x', uid: 'me', now };
        expect(decideStockRebuild({ ...skewed, waitedMs: 0 })).toBe('wait');
        expect(decideStockRebuild({ ...skewed, waitedMs: LEASE_MAX_WAIT_MS + 1 })).toBe('full-read');
        expect(LEASE_MAX_WAIT_MS).toBeLessThanOrEqual(60000);
    });
    test('#129 members with a stale checkpoint covering the window use it as approximate stock, never a full read', () => {
        expect(decideStockRebuild({ canManage: false, now, approxAvailable: true })).toBe('approximate');
        // ...also while an owner/manager device is rebuilding (no waiting, no blocked wholesale lines)
        expect(decideStockRebuild({ canManage: false, leaseUntil: now + 60000, leaseBy: 'other:1:x', uid: 'me', now, approxAvailable: true })).toBe('approximate');
        expect(decideStockRebuild({ canManage: false, now, waitedMs: LEASE_MAX_WAIT_MS + 1, approxAvailable: true })).toBe('approximate');
    });
    test('#129 owners/managers still rebuild (exact) even when a stale checkpoint exists', () => {
        expect(decideStockRebuild({ canManage: true, now, approxAvailable: true })).toBe('rebuild');
        expect(decideStockRebuild({ canManage: true, leaseUntil: now + 1, leaseBy: 'other:1:x', uid: 'me', now, approxAvailable: true })).toBe('wait');
    });
});

describe('member window start for a stale checkpoint (#129)', () => {
    const W = 10 * 86400000 * 100;
    test('widens the window to the stale checkpoint within the bound', () => {
        expect(memberWindowStart(W, W - 20 * 86400000)).toBe(W - 20 * 86400000);
        expect(memberWindowStart(W, W - MEMBER_APPROX_MAX_EXTRA_MS)).toBe(W - MEMBER_APPROX_MAX_EXTRA_MS);
    });
    test('keeps the normal window when there is no checkpoint, it is newer, or far too old', () => {
        expect(memberWindowStart(W, null)).toBe(W);
        expect(memberWindowStart(W, W + 5)).toBe(W);
        expect(memberWindowStart(W, W - MEMBER_APPROX_MAX_EXTRA_MS - 1)).toBe(W);
        expect(memberWindowStart(W, NaN)).toBe(W);
    });
});

describe('background read guard (#159)', () => {
    const make = () => createQuotaGuard({ log: { warn: jest.fn() }, cap: 100, threshold: 50, doc: null });

    test('allowed until the session cap, then off for the session', () => {
        const guard = make();
        guard.reads.add('purchases listen', 99);
        expect(guard.backgroundAllowed()).toBe(true);
        guard.reads.add('purchases listen', 1);
        expect(guard.backgroundAllowed()).toBe(false);
        expect(guard.backgroundAllowed()).toBe(false);
        expect(guard.status()).toMatchObject({ overCap: true, backgroundPaused: false });
    });

    test('the owner\'s kill switch and a quota error stop it', () => {
        const guard = make();
        guard.setBackgroundPaused(true);
        expect(guard.backgroundAllowed()).toBe(false);
        guard.setBackgroundPaused('yes');
        expect(guard.backgroundAllowed()).toBe(true);
        guard.noteQuotaExhausted('items get');
        expect(guard.backgroundAllowed()).toBe(false);
    });
});
