/**
 * @jest-environment node
 */
/**
 * tools/migrate --emulator and auth:import (migration end-to-end test):
 * --emulator only runs against local emulators and never with a key; a real
 * run refuses while emulator variables are set; auth:import reads the console's
 * hash parameters and keeps uids, hashes and salts byte for byte.
 */
import { checkEmulatorTarget } from '../../../tools/migrate/lib/emulator.js';
import { importLogins, parseHashParams, toImportRecords } from '../../../tools/migrate/lib/auth-import.js';
import { filterAuthExport } from '../../../tools/migrate/lib/service-accounts.js';
import { wipeProject } from '../../../tools/migrate/lib/wipe.js';

const LOCAL = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8181', FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' };
const DEMO = 'demo-happa-test';

describe('--emulator', () => {
    test('needs local emulator hosts, and Auth ones when the command uses Auth', () => {
        expect(checkEmulatorTarget({ emulator: true, project: DEMO, env: LOCAL, auth: true })).toEqual({ firestore: '127.0.0.1:8181', auth: 'localhost:9099' });
        expect(() => checkEmulatorTarget({ emulator: true, project: DEMO, env: {} })).toThrow(/FIRESTORE_EMULATOR_HOST/);
        expect(() => checkEmulatorTarget({ emulator: true, project: DEMO, env: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8181' }, auth: true })).toThrow(/FIREBASE_AUTH_EMULATOR_HOST/);
        expect(() => checkEmulatorTarget({ emulator: true, project: DEMO, env: { FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' } })).toThrow(/not a local emulator/);
        expect(() => checkEmulatorTarget({ emulator: true, project: DEMO, env: { FIRESTORE_EMULATOR_HOST: '10.0.0.5:8181' } })).toThrow(/not a local emulator/);
    });

    test('only a demo-* project: real project ids are refused even on local emulators', () => {
        ['happa-bfc07', 'aadhat-management', 'happa-x', 'demo', 'demo-', 'Demo-happa', 'my-demo-happa', undefined, ''].forEach(project =>
            expect(() => checkEmulatorTarget({ emulator: true, project, env: LOCAL, auth: true })).toThrow(/demo-*/));
        expect(checkEmulatorTarget({ emulator: true, project: 'demo-happa-migration', env: LOCAL })).toEqual({ firestore: '127.0.0.1:8181', auth: 'localhost:9099' });
    });

    test('never with a service-account key', () => {
        expect(() => checkEmulatorTarget({ emulator: true, project: DEMO, env: LOCAL, keyFile: 'key.json' })).toThrow(/no service-account key/);
    });

    test('a real run refuses while emulator variables are set', () => {
        expect(checkEmulatorTarget({ emulator: false, env: {} })).toBeNull();
        expect(() => checkEmulatorTarget({ emulator: false, env: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8181' } })).toThrow(/add --emulator/);
    });

    test('wipe on the emulators needs no key but still refuses the old project', async () => {
        const db = { listCollections: async () => [], collection: () => ({}) };
        const auth = { listUsers: async () => ({ users: [] }) };
        await expect(wipeProject({ project: 'happa-x', db, auth })).rejects.toThrow(/--key/);
        await expect(wipeProject({ project: 'happa-x', emulator: true, db, auth })).resolves.toMatchObject({ docs: 0 });
        await expect(wipeProject({ project: 'aadhat-management', emulator: true, db, auth })).rejects.toThrow(/OLD project/);
    });
});

describe('auth:import', () => {
    const KEY = Buffer.alloc(64, 7).toString('base64');
    const CONSOLE_TEXT = `hash_config {\n  algorithm: SCRYPT,\n  base64_signer_key: ${KEY},\n  base64_salt_separator: Bw==,\n  rounds: 8,\n  mem_cost: 14,\n}`;

    test('reads the console\'s "Password hash parameters" text and the same keys as JSON', () => {
        const p = parseHashParams(CONSOLE_TEXT);
        expect(p).toMatchObject({ algorithm: 'SCRYPT', rounds: 8, memoryCost: 14 });
        expect(p.key.equals(Buffer.alloc(64, 7))).toBe(true);
        expect(p.saltSeparator.equals(Buffer.from([7]))).toBe(true);
        expect(parseHashParams(JSON.stringify({ hash_config: { algorithm: 'SCRYPT', base64_signer_key: KEY, base64_salt_separator: 'Bw==', rounds: 8, mem_cost: 14 } })).rounds).toBe(8);
    });

    test('refuses incomplete or other parameters', () => {
        expect(() => parseHashParams(CONSOLE_TEXT.replace('SCRYPT', 'BCRYPT'))).toThrow(/SCRYPT/);
        expect(() => parseHashParams(CONSOLE_TEXT.replace('rounds: 8', 'rounds: 9'))).toThrow(/rounds/);
        expect(() => parseHashParams(CONSOLE_TEXT.replace('mem_cost: 14', 'mem_cost: 0'))).toThrow(/mem_cost/);
        expect(() => parseHashParams(CONSOLE_TEXT.replace(KEY, '%%%'))).toThrow(/base64_signer_key/);
    });

    test('keeps uids, emails and hash/salt bytes; the password provider is implied', () => {
        const { records, summary } = toImportRecords({ users: [
            { localId: 'u1', email: 'a@x.test', emailVerified: true, passwordHash: 'q83v-_8=', salt: 'AAEC', createdAt: '1700000000000', lastSignedInAt: '1700000500000',
                providerUserInfo: [{ providerId: 'password', rawId: 'a@x.test' }] },
            { localId: 'u2', email: 'b@x.test', disabled: true, providerUserInfo: [{ providerId: 'google.com', rawId: 'g-1', email: 'b@x.test' }] }
        ] });
        expect(summary).toEqual({ users: 2, withPassword: 1, disabled: 1, otherProviders: 1, skippedServiceAccounts: 0 });
        expect(records[0]).toMatchObject({ uid: 'u1', email: 'a@x.test', emailVerified: true, metadata: { creationTime: new Date(1700000000000).toUTCString() } });
        expect(records[0].passwordHash.equals(Buffer.from([0xab, 0xcd, 0xef, 0xfb, 0xff]))).toBe(true);
        expect(records[0].passwordSalt.equals(Buffer.from([0, 1, 2]))).toBe(true);
        expect(records[0].providerData).toBeUndefined();
        expect(records[1]).toMatchObject({ uid: 'u2', disabled: true, providerData: [{ uid: 'g-1', providerId: 'google.com', email: 'b@x.test' }] });
        expect(() => toImportRecords({ users: [{ localId: 'u1' }, { localId: 'u1' }] })).toThrow(/duplicate/);
        expect(() => toImportRecords([])).toThrow(/Auth export/);
    });

    test('service accounts on the denylist (#101) are never imported; auth:filter writes the same list', async () => {
        const exported = { users: [
            { localId: 'u1', email: 'a@x.test', passwordHash: 'AA==', salt: 'AA==' },
            { localId: 'svc-ro', email: 'staging-readonly@aadhat.local', passwordHash: 'AA==', salt: 'AA==' },
            { localId: 'svc-owner', email: 'Staging-Owner@Aadhat.Local', passwordHash: 'AA==', salt: 'AA==' },
            { localId: 'u2', email: 'staging-readonly@aadhat.local.example', displayName: 'staging-readonly' }
        ] };
        const { records, summary } = toImportRecords(exported);
        expect(records.map(r => r.uid)).toEqual(['u1', 'u2']);
        expect(summary).toMatchObject({ users: 2, skippedServiceAccounts: 2 });
        const calls = [];
        const auth = { importUsers: async (users) => { calls.push(users); return { successCount: users.length, errors: [] }; } };
        await importLogins({ auth, records, hash: parseHashParams(CONSOLE_TEXT) });
        expect(calls.flat().map(u => u.uid)).toEqual(['u1', 'u2']);
        const filtered = filterAuthExport(exported);
        expect(filtered.skipped).toBe(2);
        expect(filtered.exported.users.map(u => u.localId)).toEqual(['u1', 'u2']);
        expect(exported.users).toHaveLength(4);
        expect(() => filterAuthExport({})).toThrow(/Auth export/);
    });

    test('imports with the SCRYPT parameters and reports failures', async () => {
        const calls = [];
        const auth = { importUsers: async (users, opts) => { calls.push({ users, opts }); return { successCount: users.length - 1, errors: [{ index: 0, error: { message: 'bad' } }] }; } };
        const hash = parseHashParams(CONSOLE_TEXT);
        const { records } = toImportRecords({ users: [{ localId: 'u1', passwordHash: 'AA==', salt: 'AA==' }, { localId: 'u2' }] });
        const r = await importLogins({ auth, records, hash });
        expect(r).toEqual({ imported: 1, failed: [{ index: 0, message: 'bad' }] });
        expect(calls[0].opts.hash).toMatchObject({ algorithm: 'SCRYPT', rounds: 8, memoryCost: 14 });
        expect(calls[0].opts.hash.key.equals(hash.key)).toBe(true);
        expect(calls[0].opts.hash.saltSeparator).toEqual(Buffer.from([7]));
    });
});
