/**
 * @jest-environment node
 */
/**
 * tools/migrate convert (#15): Firestore REST documents (e.g. from a browser's
 * offline cache) -> the export-firestore.js backup format that `plan` reads;
 * and wipe's guards. Fake data only.
 */
import { convertRestDocs, fromRestValue, toTimestamp } from '../../../tools/migrate/lib/convert.js';
import { buildPlan } from '../../../tools/migrate/lib/plan.js';
import { isRentAudit, isTestLogin, isWipedProfile, wipeMode, wipeProject } from '../../../tools/migrate/lib/wipe.js';
import backupLib from '../../../tools/backup/backup-lib.js';

const ROOT = 'projects/old-proj/databases/(default)/documents';
const doc = (path, fields, updateTime = '2026-10-25T10:00:00.123456Z') => ({ name: `${ROOT}/${path}`, fields, createTime: updateTime, updateTime });
const s = (v) => ({ stringValue: v });
const i = (v) => ({ integerValue: String(v) });
const map = (fields) => ({ mapValue: { fields } });

const SOURCE = Object.fromEntries([
    doc('retailSales/b1', {
        billNumber: s('S20261020-001'), type: s('retail'), date: s('2026-10-20T05:00:00.000Z'), timestamp: i(1792472400000),
        customerName: s('Test Party 01'), total: i(500), cashPayment: i(200), onlinePayment: i(0), dueAmount: i(300),
        payment: map({ cash: i(200), online: i(0), due: i(300), total: i(200) }),
        items: { arrayValue: { values: [map({ itemId: s('it1'), name: s('Wheat'), qty: { doubleValue: 12.5 }, rate: i(40), total: i(500) })] } },
        cleared: { booleanValue: false }, note: { nullValue: null }, payments: { arrayValue: {} }
    }),
    doc('items/it1', { name: s('Wheat'), hindiName: s('गेहूं'), rates: { arrayValue: { values: [i(38)] } } }, '2026-10-25T12:00:00.5Z'),
    doc('users/u1', { name: s('Test Owner'), role: s('owner'), createdAt: { timestampValue: '2025-01-01T03:30:00.123456789Z' } }),
    doc('telemetry/t1', { n: i(1) }),
    doc('dev_retailSales/x', { n: i(1) }),
    doc('users/u1/preferences/p', { n: i(1) })
].map(d => [d.name, d]));

describe('convert', () => {
    test('typed values become what export-firestore.js stores', () => {
        expect(fromRestValue(i('42'))).toBe(42);
        expect(fromRestValue({ doubleValue: 1.5 })).toBe(1.5);
        expect(fromRestValue({ nullValue: null })).toBeNull();
        expect(fromRestValue({ arrayValue: {} })).toEqual([]);
        expect(fromRestValue({ mapValue: {} })).toEqual({});
        expect(fromRestValue({ referenceValue: `${ROOT}/items/it1` })).toEqual({ __type: 'ref', path: 'items/it1' });
        expect(fromRestValue({ geoPointValue: { latitude: 1, longitude: 2 } })).toEqual({ __type: 'geopoint', latitude: 1, longitude: 2 });
        expect(() => fromRestValue({ integerValue: '9007199254740993' })).toThrow(/safe range/);
        expect(() => fromRestValue({ weirdValue: 1 })).toThrow(/Unknown/);
    });

    test('timestamps keep seconds + nanoseconds, like serialize()', () => {
        const ts = toTimestamp('2025-01-01T03:30:00.123456789Z');
        expect(ts).toEqual({ __type: 'timestamp', iso: '2025-01-01T03:30:00.123Z', millis: 1735702200123, seconds: 1735702200, nanoseconds: 123456789 });
        const fake = { seconds: 1735702200, nanoseconds: 123456789, toMillis: () => 1735702200123 };
        expect(ts).toEqual(backupLib.serialize(fake));
        expect(toTimestamp('2025-01-01T09:00:00+05:30').millis).toBe(Date.parse('2025-01-01T03:30:00Z'));
    });

    test('backup: root collections only, dev_ and excluded left out, sorted, newest updateTime as exportedAt', () => {
        const { backup, summary } = convertRestDocs(SOURCE, { exclude: ['telemetry'] });
        expect(backup.format).toBe(backupLib.BACKUP_FORMAT);
        expect(backup.project).toBe('old-proj');
        expect(backup.exportedAt).toBe('2026-10-25T12:00:00.500Z');
        expect(Object.keys(backup.collections)).toEqual(['items', 'retailSales', 'users']);
        expect(summary.skipped).toEqual({ excluded: { telemetry: 1 }, dev: { dev_retailSales: 1 }, subcollection: 1 });
        const bill = backup.collections.retailSales[0];
        expect(bill.id).toBe('b1');
        expect(bill.data.items[0]).toEqual({ itemId: 'it1', name: 'Wheat', qty: 12.5, rate: 40, total: 500 });
        expect(bill.data.payment).toEqual({ cash: 200, online: 0, due: 300, total: 200 });
        expect(bill.data.note).toBeNull();
        expect(convertRestDocs(SOURCE, { exportedAt: '2026-10-25T14:00:00Z' }).backup.exportedAt).toBe('2026-10-25T14:00:00.000Z');
    });

    test('plan reads the converted backup', () => {
        const { backup } = convertRestDocs(SOURCE);
        const { summary } = buildPlan(backup, {}, { now: Date.UTC(2026, 9, 25, 15) });
        expect(summary.dues.retail).toMatchObject({ bills: 1, total: 300, records: 1, matches: true });
        expect(summary.copied).toMatchObject({ items: 1, users: 1 });
    });

    test('rejects mixed projects, bad names and key/name mismatches', () => {
        const other = doc('items/z', {});
        other.name = other.name.replace('old-proj', 'another');
        expect(() => convertRestDocs([...Object.values(SOURCE), other])).toThrow(/more than one project/);
        expect(() => convertRestDocs([{ name: 'items/x', fields: {} }])).toThrow(/Not a Firestore document name/);
        expect(() => convertRestDocs({ [`${ROOT}/items/a`]: { name: `${ROOT}/items/b`, fields: {} } })).toThrow(/differ/);
    });
});

describe('wipe', () => {
    /** Firestore admin subset wipe uses; `seed` is {coll: n docs | {id: data}}. */
    const fakeDb = (seed) => {
        const store = new Map(Object.entries(seed).map(([c, v]) => [c, new Map(typeof v === 'number'
            ? Array.from({ length: v }, (_, i) => [`d${i}`, {}]) : Object.entries(v))]));
        const deleted = [];
        const docRef = (coll, id) => ({ coll, id, path: `${coll}/${id}` });
        const drop = (ref) => { store.get(ref.coll)?.delete(ref.id); deleted.push(ref.path); };
        const query = (c, filters = [], fields = null) => {
            const rows = () => [...(store.get(c) || new Map())].filter(([, d]) => filters.every(({ f, op, v }) =>
                typeof d[f] === 'string' && (op === '>=' ? d[f] >= v : d[f] < v)));
            return {
                id: c,
                where: (f, op, v) => query(c, [...filters, { f, op, v }], fields),
                select: (...fs) => query(c, filters, fs),
                count: () => ({ get: async () => ({ data: () => ({ count: rows().length }) }) }),
                get: async () => {
                    const docs = rows().map(([id, d]) => ({ id, ref: docRef(c, id), data: () => (fields ? Object.fromEntries(fields.filter(k => k in d).map(k => [k, d[k]])) : d) }));
                    return { docs, size: docs.length };
                },
                doc: (id) => docRef(c, id)
            };
        };
        return {
            store,
            deleted,
            listCollections: async () => [...store.keys()].map(id => ({ id })),
            collection: (c) => query(c),
            recursiveDelete: async (ref) => {
                if (ref.coll) return drop(ref);
                store.delete(ref.id);
                deleted.push(ref.id);
            },
            batch: () => {
                const ops = [];
                return {
                    delete: (ref) => ops.push(() => drop(ref)),
                    update: (ref, fields) => ops.push(() => Object.assign(store.get(ref.coll).get(ref.id), fields)),
                    commit: async () => ops.forEach(op => op())
                };
            }
        };
    };
    const fakeAuth = (emails) => {
        const removed = [];
        return {
            removed,
            listUsers: async () => ({ users: emails.map((email, n) => ({ uid: `u${n}`, email })) }),
            deleteUsers: async (uids) => { removed.push(...uids); return { successCount: uids.length, failureCount: 0 }; }
        };
    };
    /** Happa after a rehearsal: Aadhat test data, real Rentals data, test and real profiles. */
    const rehearsal = () => ({
        items: 3,
        dev_items: 1,
        rent_units: 2,
        rent_public: 1,
        dev_rent_units: 1,
        auditLogs: { a1: { action: 'ADD_ITEM' }, a2: { action: 'RENT_PAYMENT' }, a3: {}, a4: { action: 'rent_x' }, a5: { action: 'RENT_RECEIPT_ISSUE' } },
        dev_auditLogs: { d1: { action: 'RENT_MOVE_IN' }, d2: { action: 'LOGIN' } },
        users: {
            u0: { email: 'a.test@happa.local', role: 'staff' },
            u2: { email: 'staging-readonly@aadhat.local', role: 'staff' },
            owner: { email: 'owner@gmail.com', role: 'owner' },
            removed: { email: 'removed@gmail.com', role: 'manager', status: 'approved' },
            helper: { email: 'helper@gmail.com', role: 'none', rentRole: 'member' },
            both: { email: 'both@gmail.com', role: 'staff', rentRole: 'manager' },
            gone: { email: 'gone@gmail.com', rentRole: null }
        }
    });

    test('only test-domain logins are test logins', () => {
        expect(isTestLogin({ email: 'Owner.Test@happa.local' })).toBe(true);
        expect(isTestLogin({ email: 'someone@gmail.com' })).toBe(false);
        expect(isTestLogin({ email: 'x@happa.local.evil.com' })).toBe(false);
        expect(isTestLogin({ email: 'a@b.c' }, '')).toBe(false);
    });

    test('Rentals collections are kept, audit logs and profiles filtered, the rest deleted (prod and dev_ alike)', () => {
        ['rent_units', 'rent_public', 'rent_charges', 'dev_rent_units', 'rent_anything_new'].forEach(c => expect(wipeMode(c)).toBe('keep'));
        expect(wipeMode('auditLogs')).toBe('audit');
        expect(wipeMode('dev_auditLogs')).toBe('audit');
        expect(wipeMode('users')).toBe('users');
        expect(wipeMode('dev_users')).toBe('users');
        ['items', 'dev_items', 'settings', 'rentals', 'rent', 'my_rent_x', 'Rent_units', 'dev_dev_rent_x'].forEach(c => expect(wipeMode(c)).toBe('delete'));
        expect(isRentAudit({ action: 'RENT_PAYMENT' })).toBe(true);
        [{ action: 'ADD_ITEM' }, { action: 'rent_payment' }, { action: 'XRENT_' }, {}, null].forEach(d => expect(isRentAudit(d)).toBe(false));
        [{ role: 'owner' }, { role: 'manager', status: 'approved' }, { rentRole: null }, { rentRole: '' }, {}].forEach(u => expect(isWipedProfile(u)).toBe(true));
        [{ rentRole: 'member' }, { role: 'none', rentRole: 'manager' }, { role: 'staff', rentRole: 'member' }].forEach(u => expect(isWipedProfile(u)).toBe(false));
    });

    test('dry run counts what is deleted and kept per collection, deletes nothing; refuses the old project', async () => {
        const db = fakeDb(rehearsal());
        const auth = fakeAuth(['a.test@happa.local', 'real@gmail.com', 'staging-readonly@aadhat.local']);
        const lines = [];
        const r = await wipeProject({ project: 'new-proj', keyProject: 'new-proj', db, auth, log: (l) => lines.push(l) });
        expect(r).toMatchObject({ docs: 13, kept: 9, testUsers: 1, serviceUsers: 1, deleted: false });
        expect(Object.fromEntries(r.plan.map(p => [p.coll, [p.delete, p.keep]]))).toEqual({
            auditLogs: [3, 2], dev_auditLogs: [1, 1], dev_items: [1, 0], dev_rent_units: [0, 1], items: [3, 0],
            rent_public: [0, 1], rent_units: [0, 2], users: [5, 2]
        });
        const out = lines.join('\n');
        expect(out).toMatch(/rent_units: KEEP 2 docs/);
        expect(out).toMatch(/auditLogs: delete 3 docs, KEEP 2 \(RENT_\* entries\)/);
        expect(out).toMatch(/users: delete 5 docs, KEEP 2 \(profiles with a rentRole\)/);
        expect(out).toMatch(/Aadhat role cleared on kept profiles .*: both \(staff\)$/m);
        expect(out).toMatch(/owner profiles deleted or cleared .*: owner$/m);
        expect(out).toMatch(/delete 13 docs .*keep 9 docs/);
        expect(out).toMatch(/add --bundle/);
        const checked = [];
        const withBundle = await wipeProject({ project: 'new-proj', keyProject: 'new-proj', db, auth, log: (l) => checked.push(l),
            oldProfiles: new Map([['both', { status: 'approved', role: 'staff' }], ['owner', { status: 'active' }]]) });
        expect(withBundle.plan.find(p => p.coll === 'users').unconfirmed).toBe(1);
        expect(checked.join('\n')).toMatch(/KEEP RENTALS ACCESS although .*: helper \(not in it\)$/m);
        const pendingOld = [];
        await wipeProject({ project: 'new-proj', keyProject: 'new-proj', db, auth, log: (l) => pendingOld.push(l),
            oldProfiles: new Map([['both', { status: 'pending' }], ['helper', { status: 'approved' }]]) });
        expect(pendingOld.join('\n')).toMatch(/LOSE RENTALS ACCESS at apply .*: both \(pending\)$/m);
        expect(pendingOld.join('\n')).not.toMatch(/KEEP RENTALS ACCESS/);
        // approved in Happa after the old app's pending profile was made: apply keeps Rentals access
        const later = fakeDb({ users: { both: { role: 'staff', rentRole: 'manager', status: 'active', approvedAt: 5 } } });
        const laterLines = [];
        await wipeProject({ project: 'new-proj', keyProject: 'new-proj', db: later, auth, log: (l) => laterLines.push(l),
            oldProfiles: new Map([['both', { status: 'pending', createdAt: { __type: 'timestamp', millis: 1 } }]]) });
        expect(laterLines.join('\n')).toMatch(/KEEP RENTALS ACCESS although .*: both \(pending\)$/m);
        expect(db.deleted).toEqual([]);
        expect(auth.removed).toEqual([]);
        await expect(wipeProject({ project: 'aadhat-management', keyProject: 'aadhat-management', db, auth, dryRun: false })).rejects.toThrow(/OLD project/);
        await expect(wipeProject({ project: 'aadhat-management', emulator: true, db, auth, dryRun: false })).rejects.toThrow(/OLD project/);
        await expect(wipeProject({ project: 'new-proj', keyProject: 'other', db, auth, dryRun: false })).rejects.toThrow(/not new-proj/);
        expect(db.deleted).toEqual([]);
    });

    test('--yes keeps Rentals data, RENT_* audit entries and profiles with a rentRole; deletes the rest, the test logins and denylisted service accounts', async () => {
        const db = fakeDb(rehearsal());
        const auth = fakeAuth(['a.test@happa.local', 'real@gmail.com', 'staging-readonly@aadhat.local']);
        const r = await wipeProject({ project: 'new-proj', keyProject: 'new-proj', db, auth, dryRun: false });
        expect(r.deleted).toBe(true);
        const left = Object.fromEntries([...db.store].map(([c, m]) => [c, [...m.keys()].sort()]));
        expect(left).toEqual({
            rent_units: ['d0', 'd1'], rent_public: ['d0'], dev_rent_units: ['d0'],
            auditLogs: ['a2', 'a5'], dev_auditLogs: ['d1'],
            users: ['both', 'helper']
        });
        expect(db.store.get('users').get('helper')).toEqual({ email: 'helper@gmail.com', role: 'none', rentRole: 'member' });
        expect(db.store.get('users').get('both')).toEqual({ email: 'both@gmail.com', role: 'none', rentRole: 'manager' });
        expect(db.deleted.filter(p => /rent_/.test(p))).toEqual([]);
        expect(auth.removed).toEqual(['u0', 'u2']);
    });
});
