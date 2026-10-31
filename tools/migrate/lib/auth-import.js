/**
 * `auth:import`: moves the logins (Firebase Auth export, `firebase auth:export
 * --format=json`) into the new project with the same uids and the old
 * project's SCRYPT password hashes, as `firebase auth:import --hash-algo=SCRYPT`
 * does, but through firebase-admin so it also runs against the Auth emulator
 * (`--emulator`) and reads the hash parameters from the file the console shows
 * (Authentication › Users › ⋮ › Password hash parameters).
 *
 * Pure helpers here; migrate.js does the I/O. Never logs hashes, keys or emails.
 */

import { filterAuthExport } from './service-accounts.js';

const B64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

/** Standard base64 → Buffer; also accepts the web-safe alphabet. */
export function b64(value, what) {
    const s = String(value ?? '').trim();
    if (!s || !B64.test(s)) throw new Error(`${what} is not base64`);
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Hash parameters from the console's text block
 * (`hash_config { algorithm: SCRYPT, base64_signer_key: …, base64_salt_separator: …, rounds: 8, mem_cost: 14 }`)
 * or the same keys as JSON.
 * @param {string} text
 * @returns {{algorithm: 'SCRYPT', key: Buffer, saltSeparator: Buffer, rounds: number, memoryCost: number}}
 */
export function parseHashParams(text) {
    const src = String(text ?? '');
    let raw = {};
    try {
        const j = JSON.parse(src);
        raw = j.hash_config || j;
    } catch {
        for (const m of src.matchAll(/([A-Za-z0-9_]+)\s*:\s*"?([^\s,"}]+)"?/g)) raw[m[1]] = m[2];
    }
    const pick = (...names) => names.map(n => raw[n]).find(v => v !== undefined && v !== '');
    const algorithm = String(pick('algorithm', 'hashAlgo') || '').toUpperCase();
    if (algorithm !== 'SCRYPT') throw new Error(`hash parameters: algorithm must be SCRYPT (got ${algorithm || 'none'})`);
    const key = b64(pick('base64_signer_key', 'signerKey', 'hashKey'), 'base64_signer_key');
    const saltSeparator = b64(pick('base64_salt_separator', 'saltSeparator') ?? '', 'base64_salt_separator');
    const rounds = Number(pick('rounds'));
    const memoryCost = Number(pick('mem_cost', 'memCost', 'memoryCost'));
    if (!key.length) throw new Error('hash parameters: base64_signer_key is empty');
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 8) throw new Error('hash parameters: rounds must be 1..8');
    if (!Number.isInteger(memoryCost) || memoryCost < 1 || memoryCost > 14) throw new Error('hash parameters: mem_cost must be 1..14');
    return { algorithm, key, saltSeparator, rounds, memoryCost };
}

const time = (ms) => {
    const n = Number(ms);
    return Number.isFinite(n) && n > 0 ? new Date(n).toUTCString() : undefined;
};

/**
 * Auth export (`{users: [...]}`) → firebase-admin UserImportRecords.
 * The password provider is implied by the hash; other providers are kept.
 * Logins on the service-account denylist (service-accounts.js) are left out.
 * @param {{users: Array<Object>}} exported
 * @returns {{records: Array<Object>, summary: {users: number, withPassword: number, disabled: number, otherProviders: number, skippedServiceAccounts: number}}}
 */
export function toImportRecords(exported) {
    const { exported: kept, skipped } = filterAuthExport(exported);
    const users = kept.users;
    const seen = new Set();
    let withPassword = 0;
    let otherProviders = 0;
    const records = users.map((u, i) => {
        const uid = String(u.localId || '').trim();
        if (!uid) throw new Error(`user #${i + 1} has no localId`);
        if (seen.has(uid)) throw new Error(`user #${i + 1}: duplicate localId`);
        seen.add(uid);
        const r = { uid };
        if (u.email) r.email = String(u.email);
        if (u.emailVerified !== undefined) r.emailVerified = u.emailVerified === true || u.emailVerified === 'true';
        if (u.displayName) r.displayName = String(u.displayName);
        if (u.phoneNumber) r.phoneNumber = String(u.phoneNumber);
        if (u.photoUrl) r.photoURL = String(u.photoUrl);
        if (u.disabled !== undefined) r.disabled = u.disabled === true || u.disabled === 'true';
        const metadata = { creationTime: time(u.createdAt), lastSignInTime: time(u.lastSignedInAt || u.lastLoginAt) };
        if (metadata.creationTime || metadata.lastSignInTime) r.metadata = Object.fromEntries(Object.entries(metadata).filter(([, v]) => v));
        if (u.customAttributes) r.customClaims = typeof u.customAttributes === 'string' ? JSON.parse(u.customAttributes) : u.customAttributes;
        if (u.passwordHash) {
            r.passwordHash = b64(u.passwordHash, `user #${i + 1} passwordHash`);
            r.passwordSalt = b64(u.salt ?? '', `user #${i + 1} salt`);
            withPassword++;
        }
        const providers = (u.providerUserInfo || []).filter(p => p && p.providerId && p.providerId !== 'password');
        if (providers.length) {
            otherProviders += providers.length;
            r.providerData = providers.map(p => ({
                uid: String(p.rawId || p.federatedId || ''), providerId: p.providerId,
                ...(p.email ? { email: p.email } : {}), ...(p.displayName ? { displayName: p.displayName } : {}),
                ...(p.photoUrl ? { photoURL: p.photoUrl } : {})
            }));
        }
        return r;
    });
    return { records, summary: { users: records.length, withPassword, disabled: records.filter(r => r.disabled).length, otherProviders, skippedServiceAccounts: skipped } };
}

/**
 * Imports in chunks of 1000 (the Auth limit) with the SCRYPT parameters.
 * @param {{auth: Object, records: Array<Object>, hash: Object, log?: (line: string) => void}} args
 * @returns {Promise<{imported: number, failed: Array<{index: number, message: string}>}>}
 */
export async function importLogins({ auth, records, hash, log = () => {} }) {
    const failed = [];
    let imported = 0;
    for (let i = 0; i < records.length; i += 1000) {
        const chunk = records.slice(i, i + 1000);
        const r = await auth.importUsers(chunk, {
            hash: { algorithm: 'SCRYPT', key: hash.key, saltSeparator: hash.saltSeparator, rounds: hash.rounds, memoryCost: hash.memoryCost }
        });
        imported += r.successCount;
        (r.errors || []).forEach(e => failed.push({ index: i + e.index, message: e.error?.message || String(e.error) }));
        log(`Imported ${imported}/${records.length} logins`);
    }
    return { imported, failed };
}
