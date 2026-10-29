/**
 * Offline backup check (no Firebase): verify SHA256SUMS, decrypt the
 * `openssl enc -aes-256-cbc -pbkdf2 -iter 200000` file, gunzip, parse, check
 * every document and compare the counts with manifest.json. Used by
 * verify-backup.js (CI and by hand) and tested in tests/backup/.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { BACKUP_FORMAT, buildManifest, deserialize } = require('./backup-lib');

const PBKDF2_ITER = 200000;
const MAGIC = Buffer.from('Salted__', 'latin1');

function deriveKeyIv(passphrase, salt, iter) {
    const kiv = crypto.pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, iter, 48, 'sha256');
    return { key: kiv.subarray(0, 32), iv: kiv.subarray(32, 48) };
}

/**
 * Same output format as `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt`.
 * @param {Buffer} plain
 * @param {string} passphrase
 * @param {{iter?: number, salt?: Buffer}} [o]
 * @returns {Buffer}
 */
function encryptOpenssl(plain, passphrase, { iter = PBKDF2_ITER, salt = crypto.randomBytes(8) } = {}) {
    const { key, iv } = deriveKeyIv(passphrase, salt, iter);
    const c = crypto.createCipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([MAGIC, salt, c.update(plain), c.final()]);
}

/**
 * Reverses encryptOpenssl / `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000`.
 * @param {Buffer} enc
 * @param {string} passphrase
 * @param {{iter?: number}} [o]
 * @returns {Buffer}
 */
function decryptOpenssl(enc, passphrase, { iter = PBKDF2_ITER } = {}) {
    if (enc.length < 32 || !enc.subarray(0, 8).equals(MAGIC)) throw new Error('Not an openssl salted file');
    const { key, iv } = deriveKeyIv(passphrase, enc.subarray(8, 16), iter);
    const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
    try {
        return Buffer.concat([d.update(enc.subarray(16)), d.final()]);
    } catch {
        throw new Error('Decryption failed (wrong passphrase or damaged file)');
    }
}

/**
 * Parses `sha256sum` output.
 * @param {string} text
 * @returns {{hash: string, name: string}[]}
 */
function parseSums(text) {
    return text.split(/\r?\n/).filter(l => l.trim()).map(l => {
        const m = l.match(/^([0-9a-f]{64}) [ *](.+)$/i);
        if (!m) throw new Error(`Bad SHA256SUMS line: ${l}`);
        return { hash: m[1].toLowerCase(), name: m[2].trim() };
    });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Checks a parsed backup and returns its problems (empty = good).
 * @param {object} backup
 * @param {object|null} manifest manifest.json from the artifact
 * @returns {string[]}
 */
function checkBackup(backup, manifest) {
    const problems = [];
    if (!backup || backup.format !== BACKUP_FORMAT) return [`Unknown backup format: ${backup && backup.format}`];
    if (!backup.collections || typeof backup.collections !== 'object') return ['No "collections" object'];
    const stub = {
        Timestamp: class { constructor(s, n) { if (!Number.isFinite(s) || !Number.isFinite(n)) throw new Error('bad timestamp'); } static fromMillis(ms) { if (!Number.isFinite(ms)) throw new Error('bad timestamp'); return {}; } },
        GeoPoint: class { constructor(a, b) { if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('bad geopoint'); } },
        doc: (p) => { if (typeof p !== 'string' || !p) throw new Error('bad ref'); return {}; }
    };
    const checkDocs = (label, docs, key) => {
        if (!Array.isArray(docs)) { problems.push(`${label}: not a list`); return; }
        const seen = new Set();
        docs.forEach((d, i) => {
            const id = d && d[key];
            if (typeof id !== 'string' || !id) problems.push(`${label}[${i}]: missing ${key}`);
            else if (seen.has(id)) problems.push(`${label}: duplicate ${key} ${id}`);
            else seen.add(id);
            if (!d || !d.data || typeof d.data !== 'object' || Array.isArray(d.data)) problems.push(`${label}[${i}]: missing data`);
            else {
                try { deserialize(d.data, stub); } catch (e) { problems.push(`${label}[${i}]: ${e.message}`); }
            }
        });
    };
    Object.entries(backup.collections).forEach(([n, docs]) => checkDocs(n, docs, 'id'));
    Object.entries(backup.subcollections || {}).forEach(([n, docs]) => checkDocs(n, docs, 'path'));
    if (problems.length) return problems;

    const actual = buildManifest(backup);
    const compare = (label, expected) => {
        if (!expected) return;
        for (const kind of ['collections', 'subcollections']) {
            const want = expected[kind] || {};
            const got = actual[kind];
            new Set([...Object.keys(want), ...Object.keys(got)]).forEach(n => {
                if (want[n] !== got[n]) problems.push(`${label}: ${n} has ${got[n] === undefined ? 'no' : got[n]} docs in the file, manifest says ${want[n] === undefined ? 'none' : want[n]}`);
            });
        }
    };
    if (!manifest) problems.push('manifest.json is missing');
    compare('manifest.json', manifest);
    compare('embedded manifest', backup.manifest);
    return problems;
}

/**
 * Verifies a downloaded backup artifact folder.
 * @param {{dir: string, passphrase: string, iter?: number}} o
 * @returns {{backup: object, manifest: object, counts: object, problems: string[], encFile: string}}
 */
function verifyArtifact({ dir, passphrase, iter = PBKDF2_ITER }) {
    const problems = [];
    const sumsPath = path.join(dir, 'SHA256SUMS');
    if (!fs.existsSync(sumsPath)) throw new Error(`No SHA256SUMS in ${dir}`);
    const sums = parseSums(fs.readFileSync(sumsPath, 'utf8'));
    for (const { hash, name } of sums) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) problems.push(`SHA256SUMS lists ${name}, which is missing`);
        else if (sha256(fs.readFileSync(file)) !== hash) problems.push(`Checksum mismatch: ${name}`);
    }
    const encFiles = fs.readdirSync(dir).filter(f => f.endsWith('.json.gz.enc'));
    if (encFiles.length !== 1) throw new Error(`Expected one *.json.gz.enc file in ${dir}, found ${encFiles.length}`);
    const encFile = encFiles[0];
    for (const f of [encFile, 'manifest.json']) {
        if (fs.existsSync(path.join(dir, f)) && !sums.some(s => s.name === f)) problems.push(`${f} is not listed in SHA256SUMS`);
    }
    if (problems.length) return { backup: null, manifest: null, counts: null, problems, encFile };

    const plain = zlib.gunzipSync(decryptOpenssl(fs.readFileSync(path.join(dir, encFile)), passphrase, { iter }));
    const backup = JSON.parse(plain.toString('utf8'));
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
    problems.push(...checkBackup(backup, manifest));
    return { backup, manifest, counts: buildManifest(backup), problems, encFile };
}

module.exports = { PBKDF2_ITER, encryptOpenssl, decryptOpenssl, parseSums, checkBackup, verifyArtifact };
