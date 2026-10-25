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
import { isTestLogin, wipeProject } from '../../../tools/migrate/lib/wipe.js';
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
    const fakeDb = (colls) => {
        const deleted = [];
        return {
            deleted,
            listCollections: async () => Object.keys(colls).map(id => ({ id })),
            collection: (id) => ({ id, count: () => ({ get: async () => ({ data: () => ({ count: colls[id] }) }) }) }),
            recursiveDelete: async (ref) => { deleted.push(ref.id); }
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

    test('only test-domain logins are test logins', () => {
        expect(isTestLogin({ email: 'Owner.Test@happa.local' })).toBe(true);
        expect(isTestLogin({ email: 'someone@gmail.com' })).toBe(false);
        expect(isTestLogin({ email: 'x@happa.local.evil.com' })).toBe(false);
        expect(isTestLogin({ email: 'a@b.c' }, '')).toBe(false);
    });

    test('dry run deletes nothing; refuses the old project', async () => {
        const db = fakeDb({ items: 3, users: 2 });
        const auth = fakeAuth(['a.test@happa.local', 'real@gmail.com']);
        const r = await wipeProject({ project: 'new-proj', keyProject: 'new-proj', db, auth });
        expect(r).toMatchObject({ docs: 5, testUsers: 1, deleted: false });
        expect(db.deleted).toEqual([]);
        expect(auth.removed).toEqual([]);
        await expect(wipeProject({ project: 'aadhat-management', keyProject: 'aadhat-management', db, auth, dryRun: false })).rejects.toThrow(/OLD project/);
        await expect(wipeProject({ project: 'new-proj', keyProject: 'other', db, auth, dryRun: false })).rejects.toThrow(/not new-proj/);
        expect(db.deleted).toEqual([]);
    });

    test('--yes deletes every collection and only the test logins', async () => {
        const db = fakeDb({ items: 3, users: 2 });
        const auth = fakeAuth(['a.test@happa.local', 'real@gmail.com']);
        await wipeProject({ project: 'new-proj', keyProject: 'new-proj', db, auth, dryRun: false });
        expect(db.deleted).toEqual(['items', 'users']);
        expect(auth.removed).toEqual(['u0']);
    });
});
