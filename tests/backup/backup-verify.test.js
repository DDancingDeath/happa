/**
 * @jest-environment node
 */
/**
 * Offline restore check (tools/backup/verify-lib.js) on a synthetic artifact
 * built the way the workflow builds it, and the backup alert decision.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { buildManifest } = require('../../tools/backup/backup-lib.js');
const { encryptOpenssl, decryptOpenssl, decryptBackup, verifyArtifact, checkBackup, DecryptionError } = require('../../tools/backup/verify-lib.js');
const { decideAlert, runWasGood } = require('../../tools/backup/alert.js');

const PASS = 'correct horse battery staple';
const WRONG = 'nope';
const ITER = 1000; // the real files use 200000; fewer here keeps the test fast
const work = path.join(__dirname, `.artifact-test-${process.pid}`);

const fixedSalt = (i) => { const s = Buffer.alloc(8); s.writeUInt32BE(i, 4); return s; };

/**
 * First fixed salt for which decrypting `plain` with the WRONG passphrase does
 * (paddingPasses) or does not pass the PKCS#7 padding check. A random salt
 * passes it about 1 time in 256, so the tests pick the case they mean.
 */
const saltCache = new Map();
function findSalt(plain, paddingPasses) {
    const key = `${crypto.createHash('sha256').update(plain).digest('hex')}:${paddingPasses}`;
    if (saltCache.has(key)) return saltCache.get(key);
    for (let i = 0; i < 4096; i++) {
        const salt = fixedSalt(i);
        const enc = encryptOpenssl(plain, PASS, { iter: ITER, salt });
        let passed = true;
        try { decryptOpenssl(enc, WRONG, { iter: ITER }); } catch { passed = false; }
        if (passed === paddingPasses) { saltCache.set(key, salt); return salt; }
    }
    throw new Error('no fixed salt found');
}

const gzBackup = (backup) => zlib.gzipSync(Buffer.from(JSON.stringify(backup)));

function sampleBackup() {
    const backup = {
        format: 'aadhat-backup-v1',
        mode: 'nightly',
        exportedAt: '2026-10-30T08:15:00.000Z',
        env: 'prod',
        project: 'demo-test',
        collections: {
            items: [{ id: 'a', data: { name: 'Chana', updatedAt: { __type: 'timestamp', iso: 'x', millis: 1, seconds: 0, nanoseconds: 1000000 } } }],
            rent_units: [{ id: 'u1', data: { label: 'Shop 1' } }, { id: 'u2', data: { label: 'Shop 2' } }]
        },
        subcollections: { 'users/preferences': [{ path: 'users/x/preferences/p', data: { lang: 'hi' } }] }
    };
    backup.manifest = buildManifest(backup);
    return backup;
}

/** Writes an artifact folder like the workflow: <name>.json.gz.enc, manifest.json, SHA256SUMS. */
function writeArtifact(dir, backup, { manifest = buildManifest(backup), iter = ITER, salt = fixedSalt(0) } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const enc = encryptOpenssl(gzBackup(backup), PASS, { iter, salt });
    const files = { 'firestore-backup-nightly-2026-10-30_1345.json.gz.enc': enc, 'manifest.json': Buffer.from(JSON.stringify(manifest)) };
    const sums = Object.entries(files).map(([name, buf]) => {
        fs.writeFileSync(path.join(dir, name), buf);
        return `${crypto.createHash('sha256').update(buf).digest('hex')}  ${name}`;
    });
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
    return dir;
}

let n = 0;
const fresh = () => path.join(work, String(n++));

afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

const verifyAt = (dir, passphrase = PASS) => verifyArtifact({ dir, passphrase, iter: ITER });

describe('openssl-compatible encryption', () => {
    test('round-trips and rejects a wrong passphrase', () => {
        const plain = Buffer.from('hello');
        const enc = encryptOpenssl(plain, PASS, { iter: ITER, salt: findSalt(plain, false) });
        expect(enc.subarray(0, 8).toString()).toBe('Salted__');
        expect(decryptOpenssl(enc, PASS, { iter: ITER }).toString()).toBe('hello');
        expect(() => decryptOpenssl(enc, WRONG, { iter: ITER })).toThrow(DecryptionError);
        expect(() => decryptOpenssl(enc, WRONG, { iter: ITER })).toThrow(/passphrase|damaged/);
    });

    test('a wrong passphrase that passes the padding check by chance is reported the same way', () => {
        const gz = gzBackup(sampleBackup());
        const passes = encryptOpenssl(gz, PASS, { iter: ITER, salt: findSalt(gz, true) });
        const fails = encryptOpenssl(gz, PASS, { iter: ITER, salt: findSalt(gz, false) });
        expect(() => decryptOpenssl(passes, WRONG, { iter: ITER })).not.toThrow();
        const errorOf = (enc) => { try { decryptBackup(enc, WRONG, { iter: ITER }); } catch (e) { return e; } return null; };
        const chance = errorOf(passes);
        const padding = errorOf(fails);
        expect(chance).toBeInstanceOf(DecryptionError);
        expect(padding).toBeInstanceOf(DecryptionError);
        expect(chance.message).toBe(padding.message);
        expect(chance.message).toMatch(/passphrase|damaged/);
        expect(decryptBackup(passes, PASS, { iter: ITER })).toEqual(sampleBackup());
    });

    test('decrypted bytes that are not gzipped JSON are reported as wrong passphrase or damaged', () => {
        const notGzip = encryptOpenssl(Buffer.from('{"format":"x"}'), PASS, { iter: ITER, salt: fixedSalt(1) });
        const notJson = encryptOpenssl(zlib.gzipSync(Buffer.from('{"format":')), PASS, { iter: ITER, salt: fixedSalt(1) });
        expect(() => decryptBackup(notGzip, PASS, { iter: ITER })).toThrow(DecryptionError);
        expect(() => decryptBackup(notJson, PASS, { iter: ITER })).toThrow(/passphrase|damaged/);
    });

    const openssl = spawnSync('openssl', ['version']).status === 0;
    (openssl ? test : test.skip)('matches `openssl enc -aes-256-cbc -pbkdf2 -iter 200000` both ways', () => {
        const dir = fresh();
        fs.mkdirSync(dir, { recursive: true });
        const plain = path.join(dir, 'p.txt');
        fs.writeFileSync(plain, 'happa backup');
        const env = { ...process.env, TEST_PASS: PASS };
        const r = spawnSync('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt', '-in', plain, '-out', path.join(dir, 'c.enc'), '-pass', 'env:TEST_PASS'], { env });
        expect(r.status).toBe(0);
        expect(decryptOpenssl(fs.readFileSync(path.join(dir, 'c.enc')), PASS).toString()).toBe('happa backup');
        fs.writeFileSync(path.join(dir, 'n.enc'), encryptOpenssl(Buffer.from('from node'), PASS));
        const d = spawnSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-in', path.join(dir, 'n.enc'), '-pass', 'env:TEST_PASS'], { env });
        expect(d.status).toBe(0);
        expect(d.stdout.toString()).toBe('from node');
    });
});

describe('offline backup check', () => {
    test('a good artifact passes and reports its counts', () => {
        const r = verifyAt(writeArtifact(fresh(), sampleBackup()));
        expect(r.problems).toEqual([]);
        expect(r.counts.collections).toEqual({ items: 1, rent_units: 2 });
        expect(r.counts.subcollections).toEqual({ 'users/preferences': 1 });
        expect(r.counts.totalDocs).toBe(4);
    });

    test('a changed file fails the checksum', () => {
        const dir = writeArtifact(fresh(), sampleBackup());
        const enc = path.join(dir, 'firestore-backup-nightly-2026-10-30_1345.json.gz.enc');
        const buf = fs.readFileSync(enc);
        buf[buf.length - 1] ^= 1;
        fs.writeFileSync(enc, buf);
        expect(verifyAt(dir).problems).toEqual(['Checksum mismatch: firestore-backup-nightly-2026-10-30_1345.json.gz.enc']);
    });

    test('the wrong passphrase fails', () => {
        const backup = sampleBackup();
        const gz = gzBackup(backup);
        for (const paddingPasses of [false, true]) {
            const dir = writeArtifact(fresh(), backup, { salt: findSalt(gz, paddingPasses) });
            expect(() => verifyAt(dir, WRONG)).toThrow(DecryptionError);
            expect(() => verifyAt(dir, WRONG)).toThrow(/passphrase|damaged/);
        }
    });

    test('counts that differ from manifest.json fail', () => {
        const backup = sampleBackup();
        const manifest = { ...buildManifest(backup), collections: { items: 1, rent_units: 3, users: 4 } };
        const { problems } = verifyAt(writeArtifact(fresh(), backup, { manifest }));
        expect(problems).toEqual([
            'manifest.json: rent_units has 2 docs in the file, manifest says 3',
            'manifest.json: users has no docs in the file, manifest says 4'
        ]);
    });

    test('broken documents are reported', () => {
        const backup = sampleBackup();
        backup.collections.items.push({ id: 'a', data: {} }, { data: { x: 1 } }, { id: 'b', data: { t: { __type: 'timestamp', iso: 'x' } } });
        const problems = checkBackup(backup, buildManifest(backup));
        expect(problems).toEqual(expect.arrayContaining(['items: duplicate id a', 'items[2]: missing id', 'items[3]: bad timestamp']));
    });
});

describe('backup failure alert', () => {
    test('opens only when two scheduled nights in a row are bad; closes on success', () => {
        expect(decideAlert({ kind: 'backup', event: 'schedule', currentGood: false, previousGood: false })).toBe('open');
        expect(decideAlert({ kind: 'backup', event: 'schedule', currentGood: false, previousGood: true })).toBe('none');
        expect(decideAlert({ kind: 'backup', event: 'schedule', currentGood: false, previousGood: null })).toBe('none');
        expect(decideAlert({ kind: 'backup', event: 'workflow_dispatch', currentGood: false, previousGood: false })).toBe('none');
        expect(decideAlert({ kind: 'backup', event: 'workflow_dispatch', currentGood: true, previousGood: null })).toBe('resolve');
        expect(decideAlert({ kind: 'drill', event: 'schedule', currentGood: false, previousGood: null })).toBe('open');
    });

    test('a successful run without a backup artifact (size guard skip) counts as bad', () => {
        expect(runWasGood({ conclusion: 'success' }, [{ name: 'firestore-backup-nightly-2026-10-30_1345' }])).toBe(true);
        expect(runWasGood({ conclusion: 'success' }, [])).toBe(false);
        expect(runWasGood({ conclusion: 'failure' }, [{ name: 'firestore-backup-weekly-x' }])).toBe(false);
    });
});
