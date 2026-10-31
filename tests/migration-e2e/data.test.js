/**
 * Migration end-to-end, data part: what tools/migrate wrote into the
 * EMULATORS against the OLD backup. Run by run.js (node --test) after
 * plan → wipe → apply → auth:import; MIGRATION_E2E_DIR holds context.json.
 * Assertion messages show ids and amounts only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { oldOutstanding, summarize, billTime, partyKey, ageDays } from './old-outstanding.js';
import { billsOf, expectedCounters } from './expected.js';
import { billsToYearDocs, MIGRATION_META_BY } from '../../www/js/utils/rate-trends.js';
import { MIGRATION_DAILY_WRITES, OLD_PROJECT_ID } from '../../tools/migrate/lib/plan.js';
import { parseHashParams } from '../../tools/migrate/lib/auth-import.js';
import { checkEmulatorTarget } from '../../tools/migrate/lib/emulator.js';
import { isServiceAccountEmail } from '../../tools/migrate/lib/service-accounts.js';
import { SERVICE_LOGIN } from './make-old-backup.js';

process.env.TZ = 'Asia/Kolkata';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const adminRequire = createRequire(path.join(HERE, '..', '..', 'tools', 'migrate', 'package.json'));
const { initializeApp, deleteApp } = adminRequire('firebase-admin/app');
const { getFirestore } = adminRequire('firebase-admin/firestore');
const { getAuth } = adminRequire('firebase-admin/auth');
const { verifyFirebaseScrypt } = require('./firebase-scrypt.js');

const DIR = process.env.MIGRATION_E2E_DIR;
const ctx = JSON.parse(fs.readFileSync(path.join(DIR, 'context.json'), 'utf8'));
// Abort before firebase-admin starts unless it can only reach local emulators and a demo-* project.
checkEmulatorTarget({ emulator: true, auth: true, project: ctx.project, keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS });
const backup = JSON.parse(fs.readFileSync(ctx.files.backup, 'utf8'));
const bundle = JSON.parse(fs.readFileSync(path.join(ctx.planDir, 'bundle.json'), 'utf8'));
const cutoff = Date.parse(backup.exportedAt);
const SYNTHETIC = !ctx.real;

/** Firestore values (admin SDK) and tagged backup values → one comparable shape. */
function norm(v) {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(norm);
    if (typeof v !== 'object') return v;
    if (v.__type === 'timestamp') return { __ts: typeof v.millis === 'number' ? v.millis : v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6) };
    if (v.__type === 'ref') return { __ref: v.path };
    if (v.__type === 'geopoint') return { __geo: [v.latitude, v.longitude] };
    if (v.__type === 'bytes') return { __bytes: v.base64 };
    if (typeof v.toMillis === 'function' && 'nanoseconds' in v) return { __ts: v.toMillis() };
    if (typeof v.path === 'string' && v.firestore) return { __ref: v.path };
    if (typeof v.latitude === 'number' && typeof v.longitude === 'number') return { __geo: [v.latitude, v.longitude] };
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { __bytes: Buffer.from(v).toString('base64') };
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, norm(v[k])]));
}
/** Tagged backup values → Timestamp-like objects, as the app's utils read them. */
function revive(v) {
    if (Array.isArray(v)) return v.map(revive);
    if (!v || typeof v !== 'object') return v;
    if (v.__type === 'timestamp') {
        const ms = typeof v.millis === 'number' ? v.millis : v.seconds * 1000;
        return { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6, toMillis: () => ms, toDate: () => new Date(ms) };
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
}
const backupDocs = (coll) => backup.collections[coll] || [];

let app;
let db;
let auth;
const data = {}; // coll -> Map(id -> data)

before(async () => {
    process.env.METADATA_SERVER_DETECTION = 'none';
    app = initializeApp({ projectId: ctx.project }, 'migration-e2e-data');
    db = getFirestore(app);
    auth = getAuth(app);
    for (const c of await db.listCollections()) {
        const snap = await c.get();
        data[c.id] = new Map(snap.docs.map(d => [d.id, d.data()]));
    }
});
after(async () => { if (app) await deleteApp(app); });

const CARRIED = ['settings', 'counters', 'users', 'items', 'rateHistory', 'itemFrequency', 'rateStats'];

test('nothing from dev_ is carried, only what the README carries, and the wipe removed the rehearsal', async () => {
    const colls = Object.keys(data).sort();
    assert.deepEqual(colls.filter(c => c.startsWith('dev_')), [], 'no dev_ collection in the new project');
    const counters = expectedCounters(backup, cutoff);
    const expected = new Set(CARRIED.filter(c => (c === 'counters' ? Object.keys(counters).length : backupDocs(c === 'rateStats' ? 'items' : c).length)));
    const dues = oldOutstanding({ retailSales: billsOf(backup, 'retailSales'), wholesaleSales: billsOf(backup, 'wholesaleSales') }, cutoff);
    if (dues.retail.count) expected.add('retailSales');
    if (dues.wholesale.count) expected.add('wholesaleSales');
    assert.deepEqual(colls, [...expected].sort(), 'collections in the new project');
    assert.equal(data.retailSales?.has('rehearsal-bill') ?? false, false, 'rehearsal bill wiped');
    assert.equal((await db.collectionGroup('preferences').get()).size, 0, 'users/*/preferences is not carried');
    // Every carried bill is an opening record (no old bill is copied as is in fresh mode)
    ['retailSales', 'wholesaleSales', 'purchases'].forEach(c => (data[c] ? [...data[c].values()] : []).forEach(d => assert.equal(d.openingBalance?.migrated, true, `${c}: only opening records`)));
});

test('the write count is within budget and every write landed', () => {
    const docs = Object.values(data).reduce((n, m) => n + m.size, 0);
    assert.ok(bundle.writes.length <= MIGRATION_DAILY_WRITES, `${bundle.writes.length} writes ≤ ${MIGRATION_DAILY_WRITES} (one run)`);
    assert.equal(ctx.writes, bundle.writes.length, 'apply wrote the whole bundle in one run');
    assert.equal(new Set(bundle.writes.map(w => `${w.coll}/${w.id}`)).size, bundle.writes.length, 'no write repeats a document');
    assert.equal(docs, bundle.writes.length, 'documents in the new project = writes');
    console.log(`  writes: ${bundle.writes.length} (budget ${MIGRATION_DAILY_WRITES}), documents: ${docs}`);
});

test('opening dues equal the OLD Outstanding pages (totals, parties, age groups, bills)', () => {
    const old = oldOutstanding({ retailSales: billsOf(backup, 'retailSales'), wholesaleSales: billsOf(backup, 'wholesaleSales') }, cutoff);
    const openings = (coll) => [...(data[coll]?.entries() || [])].filter(([, d]) => d.openingBalance?.migrated).map(([id, d]) => ({ id, ...d }));
    const pages = { retail: openings('retailSales'), wholesale: openings('wholesaleSales') };
    assert.deepEqual(openings('purchases'), [], 'payables are checked, not carried (default)');
    for (const [page, docs] of Object.entries(pages)) {
        const got = summarize(docs.map(d => ({ due: d.payment.due, name: d.customerName, time: billTime(d) })), cutoff);
        assert.deepEqual({ total: got.total, count: got.count }, { total: old[page].total, count: old[page].count }, `${page}: total and bills`);
        assert.deepEqual(got.parties, old[page].parties, `${page}: per-party totals`);
        assert.deepEqual(got.buckets, old[page].buckets, `${page}: age groups`);
        console.log(`  ${page}: ${got.count} bills, ${Object.keys(got.parties).length} parties, ₹${got.total}; age groups ${Object.entries(got.buckets).map(([k, b]) => `${k}: ₹${b.total} (${b.count})`).join(', ')}`);
    }
    const byId = new Map(old.bills.map(b => [`${b.billType}/${b.id}`, b]));
    [...pages.retail, ...pages.wholesale].forEach(d => {
        const o = d.openingBalance;
        const src = byId.get(`${o.billType}/${o.sourceBillId}`);
        assert.ok(src, `${d.id}: its old bill is due on the old page`);
        assert.equal(d.id, `opening-${o.billType}-${o.sourceBillId}`);
        assert.equal(d.billNumber, src.billNumber, `${d.id}: old bill number`);
        assert.deepEqual(d.date, src.date ?? d.date, `${d.id}: old date as stored`);
        assert.equal(partyKey(d.customerName), src.partyKey, `${d.id}: party`);
        assert.equal(ageDays(billTime(d), cutoff), src.days, `${d.id}: original age`);
        assert.equal(d.dueAmount, src.due);
        assert.equal(o.amount, src.due);
        assert.deepEqual({ total: d.total, items: d.items, openDue: d.openDue, cleared: d.cleared, cash: d.payment.cash, online: d.payment.online, paid: d.payment.total },
            { total: 0, items: [], openDue: true, cleared: false, cash: 0, online: 0, paid: 0 }, `${d.id}: a balance only, no sale`);
        assert.equal(o.fromProject, OLD_PROJECT_ID);
        assert.equal(o.asOf, cutoff);
        assert.ok(Number.isFinite(o.billTotal) && o.billTotal >= 0, `${d.id}: bill total is a number ≥ 0`);
        assert.ok(Number.isFinite(o.paidBefore) && o.paidBefore >= 0, `${d.id}: paid before is a number ≥ 0`);
        if (o.paidBefore > 0) assert.ok(Math.abs(o.billTotal - o.paidBefore - o.amount) < 0.01, `${d.id}: bill total = paid before + carried`);
        else assert.ok(o.billTotal <= o.amount + 0.01, `${d.id}: nothing paid before, so the carried due covers the bill total`);
        if (o.billType === 'wholesale') assert.equal(d.source, 'sales-tab', `${d.id}: on Wholesale › Outstanding`);
    });
    if (SYNTHETIC) {
        const carried = new Set([...pages.retail, ...pages.wholesale].map(d => d.openingBalance.sourceBillId));
        ['edge-ddmm-dueonly', 'edge-ddmm-split', 'edge-case-upper', 'edge-hindi', 'edge-nukta-a', 'edge-nukta-b', 'edge-dup-a', 'edge-dup-b',
            'edge-writeoff-partial', 'edge-no-name', 'edge-today-due', 'edge-legacy-number', 'edge-w-due-zero', 'edge-w-due']
            .forEach(id => assert.ok(carried.has(id), `${id} is carried`));
        ['edge-overpaid-neg', 'edge-overpaid-zero', 'edge-cleared-with-due', 'edge-writeoff-settled', 'edge-w-hidden', 'edge-today-paid', 'edge-p-payable']
            .forEach(id => assert.ok(!carried.has(id), `${id} is not carried`));
        const amount = (id) => [...pages.retail, ...pages.wholesale].find(d => d.openingBalance.sourceBillId === id).payment.due;
        assert.equal(amount('edge-writeoff-partial'), 250);
        assert.equal(amount('edge-w-due-zero'), 5000, 'Wholesale rule: payment.due 0, nothing received');
        const retailParties = summarize(pages.retail.map(d => ({ due: d.payment.due, name: d.customerName, time: billTime(d) })), cutoff).parties;
        assert.equal(retailParties['bhola nath'], 2500, 'case variants are one party');
        assert.equal(retailParties[partyKey('\u0958ासिम')], 350, 'Unicode forms are one party');
        const dup = pages.retail.filter(d => ['edge-dup-a', 'edge-dup-b'].includes(d.openingBalance.sourceBillId));
        assert.equal(new Set(dup.map(d => d.billNumber)).size, 1, 'duplicate bill numbers both kept');
    }
    if (ctx.expect) {
        const [bills, parties, total] = ctx.expect.split(',').map(Number);
        const all = [...pages.retail, ...pages.wholesale];
        const partySet = new Set(all.map(d => `${d.openingBalance.billType}:${partyKey(d.customerName)}`));
        assert.deepEqual({ bills: all.length, parties: partySet.size, total: Math.round(all.reduce((a, d) => a + d.payment.due, 0)) }, { bills, parties, total }, 'MIGRATION_E2E_EXPECT');
    }
});

test('items, users (with roles), rate history and item order are carried as is', () => {
    const skipped = new Set(backupDocs('users').filter(d => isServiceAccountEmail(d.data?.email)).map(d => d.id));
    const carriedDocs = (coll) => backupDocs(coll).filter(d => !(['users', 'itemFrequency'].includes(coll) && skipped.has(d.id)));
    for (const coll of ['items', 'users', 'rateHistory', 'itemFrequency']) {
        const docs = carriedDocs(coll);
        assert.equal(data[coll]?.size || 0, docs.length, `${coll}: count`);
        docs.forEach(({ id, data: d }) => assert.deepEqual(norm(data[coll].get(id)), norm(d), `${coll}/${id} as is`));
    }
    const roles = (m) => Object.fromEntries([...m].map(([id, u]) => [id, `${u.role}/${u.status || ''}/${u.rentRole || ''}`]));
    assert.deepEqual(roles(data.users), roles(new Map(carriedDocs('users').map(d => [d.id, d.data]))), 'roles and status');
});

test('service accounts (#101) are not carried: no users doc, no per-user doc, no login', async () => {
    const skipped = backupDocs('users').filter(d => isServiceAccountEmail(d.data?.email)).map(d => d.id);
    if (SYNTHETIC) assert.deepEqual(skipped, [SERVICE_LOGIN.uid], 'the synthetic backup has the staging-readonly account');
    skipped.forEach(uid => {
        assert.equal(data.users.has(uid), false, `users/${uid} not carried`);
        assert.equal(data.itemFrequency?.has(uid) ?? false, false, `itemFrequency/${uid} not carried`);
    });
    assert.deepEqual([...data.users.values()].filter(u => isServiceAccountEmail(u.email)).length, 0, 'no carried profile has a denylisted email');
    assert.equal(bundle.summary.serviceAccounts.skipped, skipped.length, 'plan: skipped service accounts');
    const list = (await auth.listUsers(1000)).users;
    assert.deepEqual(list.filter(u => isServiceAccountEmail(u.email)).map(u => u.uid), [], 'no denylisted login in Auth (wipe removed the rehearsal one, auth:import skipped the old one)');
    skipped.forEach(uid => assert.equal(list.some(u => u.uid === uid), false, `login ${uid} not imported`));
    console.log(`  service accounts: ${skipped.length} skipped`);
});

test('settings are carried (minus the old project\'s own fields)', () => {
    const docs = backupDocs('settings');
    assert.equal(data.settings?.size || 0, docs.length);
    docs.forEach(({ id, data: d }) => {
        const want = Object.fromEntries(Object.entries(d).filter(([k, v]) => !(id === 'app' && ['minClientVersion', 'enforceClientVersion'].includes(k))
            && !(typeof v === 'string' && v.includes(OLD_PROJECT_ID))));
        assert.deepEqual(norm(data.settings.get(id)), norm(want), `settings/${id}`);
    });
});

test('bill counters continue from the cutoff day', () => {
    const want = expectedCounters(backup, cutoff);
    const got = Object.fromEntries([...(data.counters || new Map())].map(([id, c]) => [id, c.next]));
    assert.deepEqual(got, want, 'counters (last number issued per prefix and day)');
    [...(data.counters || new Map()).values()].forEach(c => assert.equal(c.initialized, true));
    console.log(`  counters: ${Object.entries(got).map(([k, v]) => `${k.slice(0, 1)}… next after ${v}`).join(', ')}`);
});

test('rateStats (weekly + monthly) equal the app\'s own billsToYearDocs on the old bills', () => {
    const records = (coll) => backupDocs(coll).map(d => ({ id: d.id, ...revive(d.data) }));
    const want = billsToYearDocs({ purchase: records('purchases'), retail: records('retailSales'), wholesale: records('wholesaleSales') }, records('items'));
    const got = Object.fromEntries([...(data.rateStats || new Map())].filter(([id]) => id !== '_meta'));
    const strip = (d) => { const { updatedAt, ...rest } = d; return norm(rest); };
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), 'one doc per item and year');
    Object.keys(want).forEach(id => assert.deepEqual(strip(got[id]), strip(want[id]), `rateStats/${id}`));
    const weeks = Object.values(want).reduce((n, d) => n + Object.keys(d.weeks).length, 0);
    const months = Object.values(want).reduce((n, d) => n + Object.keys(d.months).length, 0);
    const meta = data.rateStats.get('_meta');
    assert.deepEqual({ by: meta.by, backfillDone: meta.backfillDone, backfillAt: meta.backfillAt, reads: meta.reads, months: meta.months },
        { by: MIGRATION_META_BY, backfillDone: true, backfillAt: cutoff, reads: 0, months }, 'rateStats/_meta: carried history');
    console.log(`  rateStats: ${Object.keys(want).length} item-year docs, ${weeks} weekly and ${months} monthly buckets`);
});

test('logins: same uids, emails and password hashes; the original passwords match', async () => {
    const exported = JSON.parse(fs.readFileSync(ctx.files.auth, 'utf8')).users.filter(u => !isServiceAccountEmail(u.email));
    const params = parseHashParams(fs.readFileSync(ctx.files.hashParams, 'utf8'));
    const list = (await auth.listUsers(1000)).users;
    const byUid = new Map(list.map(u => [u.uid, u]));
    const b64 = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('base64');
    exported.forEach((u, i) => {
        const got = byUid.get(u.localId);
        assert.ok(got, `login #${i + 1} imported with its uid`);
        assert.equal(got.email, u.email, `login #${i + 1}: email`);
        assert.equal(b64(got.passwordHash), b64(u.passwordHash), `login #${i + 1}: hash bytes`);
        assert.equal(b64(got.passwordSalt), b64(u.salt), `login #${i + 1}: salt bytes`);
        assert.equal(!!got.disabled, u.disabled === true, `login #${i + 1}: disabled`);
    });
    assert.ok(!list.some(u => u.email && u.email.endsWith('@happa.local')), 'wipe removed the test logins');
    assert.ok(byUid.has('kept-login'), 'wipe kept other logins');
    assert.deepEqual([...data.users.keys()].filter(uid => !byUid.has(uid)), [], 'every profile has its login');
    if (SYNTHETIC) {
        const logins = JSON.parse(fs.readFileSync(ctx.files.logins, 'utf8'));
        Object.values(logins).forEach(l => {
            const u = exported.find(x => x.localId === l.uid);
            const got = byUid.get(l.uid);
            assert.ok(verifyFirebaseScrypt(l.password, got.passwordSalt, got.passwordHash, params), `${l.role} ${l.uid}: original password matches the imported hash`);
            assert.ok(!verifyFirebaseScrypt(`${l.password}x`, got.passwordSalt, got.passwordHash, params), `${l.role}: a wrong password does not`);
            assert.ok(u);
        });
    }
    console.log(`  logins: ${exported.length} imported, ${exported.filter(u => u.passwordHash).length} with a password hash`);
});
