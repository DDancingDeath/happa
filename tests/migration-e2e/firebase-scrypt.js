/**
 * Firebase Auth's modified scrypt (the SCRYPT hash `firebase auth:export`
 * exports, https://github.com/firebase/scrypt): key = scrypt(password,
 * salt + saltSeparator, N = 2^memCost, r = rounds, p = 1, 64 bytes); hash =
 * AES-256-CTR(key[0..32], iv 0) of the project's signer key, base64.
 *
 * The Auth emulator stores imported hashes but checks passwords with its own
 * fake hash, so the migration test checks a migrated login's ORIGINAL password
 * against the imported hash with this, as production Auth does.
 */
const crypto = require('crypto');

/**
 * @param {string} password
 * @param {string} saltB64 the user's salt (base64)
 * @param {{key: Buffer, saltSeparator: Buffer, rounds: number, memoryCost: number}} params
 * @returns {string} base64 hash
 */
function firebaseScrypt(password, saltB64, { key, saltSeparator, rounds, memoryCost }) {
    const salt = Buffer.concat([Buffer.from(saltB64, 'base64'), saltSeparator]);
    const N = 2 ** memoryCost;
    const derived = crypto.scryptSync(Buffer.from(password, 'utf8'), salt, 64, { N, r: rounds, p: 1, maxmem: 256 * N * rounds + 1024 * 1024 });
    const cipher = crypto.createCipheriv('aes-256-ctr', derived.subarray(0, 32), Buffer.alloc(16, 0));
    return Buffer.concat([cipher.update(key), cipher.final()]).toString('base64');
}

const std = (b64) => String(b64).replace(/-/g, '+').replace(/_/g, '/');

/** Constant-time check of a password against a stored hash (base64, either alphabet). */
function verifyFirebaseScrypt(password, saltB64, hashB64, params) {
    const want = Buffer.from(std(hashB64), 'base64');
    const got = Buffer.from(firebaseScrypt(password, std(saltB64), params), 'base64');
    return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** The console's "Password hash parameters" text → params (the tool's own parser is tools/migrate/lib/auth-import.js). */
function readHashParams(text) {
    const raw = Object.fromEntries([...String(text).matchAll(/([A-Za-z0-9_]+)\s*:\s*"?([^\s,"}]+)"?/g)].map(m => [m[1], m[2]]));
    return {
        key: Buffer.from(std(raw.base64_signer_key), 'base64'),
        saltSeparator: Buffer.from(std(raw.base64_salt_separator || ''), 'base64'),
        rounds: Number(raw.rounds),
        memoryCost: Number(raw.mem_cost)
    };
}

module.exports = { firebaseScrypt, verifyFirebaseScrypt, readHashParams };
