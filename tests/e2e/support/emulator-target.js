/**
 * Where the E2E harnesses run the Firebase emulators: a demo-* project id (the
 * emulators serve demo projects without any real backend) and the auth and
 * firestore ports, chosen at test time so the committed files keep their
 * defaults (www/firebaseConfig.js and www/r/rent-history.js: auth 9099,
 * firestore 8181, the project in happa.config.json):
 *   - writeEmulatorConfig() writes a gitignored copy of firebase.json with the
 *     ports, for `firebase emulators:* --config <file>`;
 *   - servedText() rewrites the served www/firebaseConfig.js and
 *     www/r/rent-history.js to the project and ports (tests/e2e/static-server.js).
 *
 * tests/e2e (playwright.config.js):    E2E_PROJECT (demo-happa-e2e), E2E_AUTH_PORT (9099), E2E_FIRESTORE_PORT (8181)
 * tests/migration-e2e (run.js):        MIGRATION_E2E_PROJECT (demo-happa-migration),
 *                                      MIGRATION_E2E_AUTH_PORT (9199), MIGRATION_E2E_FIRESTORE_PORT (8281)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEMO_PROJECT = /^demo-[a-z0-9-]+$/;
/** www/ files (posix paths) servedText() rewrites. */
const REWRITTEN = ['firebaseConfig.js', 'r/rent-history.js'];

/** Checks and returns { project, authPort, firestorePort }. */
function target({ project, authPort, firestorePort }) {
    if (!DEMO_PROJECT.test(String(project || ''))) {
        throw new Error(`The emulator project must be a demo-* id (demo-<name>), not "${project || ''}"`);
    }
    for (const [name, port] of [['auth', authPort], ['firestore', firestorePort]]) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Bad ${name} emulator port: ${port}`);
    }
    if (authPort === firestorePort) throw new Error(`The auth and firestore emulators need different ports (${authPort})`);
    return { project, authPort, firestorePort };
}

const e2eTarget = (env = process.env) => target({
    project: env.E2E_PROJECT || 'demo-happa-e2e',
    authPort: Number(env.E2E_AUTH_PORT || 9099),
    firestorePort: Number(env.E2E_FIRESTORE_PORT || 8181)
});

const migrationTarget = (env = process.env) => target({
    project: env.MIGRATION_E2E_PROJECT || 'demo-happa-migration',
    authPort: Number(env.MIGRATION_E2E_AUTH_PORT || 9199),
    firestorePort: Number(env.MIGRATION_E2E_FIRESTORE_PORT || 8281)
});

/**
 * Writes firebase.json with the emulator ports to .<name>.firebase.json at the repo root
 * (gitignored; next to firebase.json because the CLI resolves firestore.rules from the
 * config's folder) and returns its path relative to the repo root.
 */
function writeEmulatorConfig(name, { authPort, firestorePort }) {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
    const emu = cfg.emulators || {};
    cfg.emulators = { ...emu, auth: { ...emu.auth, port: authPort }, firestore: { ...emu.firestore, port: firestorePort } };
    const rel = `.${name}.firebase.json`;
    fs.writeFileSync(path.join(ROOT, rel), JSON.stringify(cfg, null, 2) + '\n');
    return rel;
}

/** Replaces exactly one match of `re` in `text`; throws when the file no longer has it. */
function replaceOne(text, re, to, file) {
    const n = (text.match(new RegExp(re.source, 'g')) || []).length;
    if (n !== 1) throw new Error(`${file}: expected one ${re} to rewrite for the emulators, found ${n}`);
    return text.replace(re, to);
}

/**
 * The text to serve for www/<rel> (posix path) against the emulators of target `t`,
 * or null when the file is served as is.
 */
function servedText(rel, text, t) {
    if (rel === 'firebaseConfig.js') {
        let out = replaceOne(text, /("projectId"\s*:\s*")[^"]*(")/, `$1${t.project}$2`, rel);
        out = replaceOne(out, /useEmulator\('http:\/\/127\.0\.0\.1:\d+'/, `useEmulator('http://127.0.0.1:${t.authPort}'`, rel);
        out = replaceOne(out, /useEmulator\('127\.0\.0\.1', \d+\)/, `useEmulator('127.0.0.1', ${t.firestorePort})`, rel);
        return out.replace(/auth:\d+, firestore:\d+/, `auth:${t.authPort}, firestore:${t.firestorePort}`);
    }
    if (rel === 'r/rent-history.js') {
        return replaceOne(text, /'http:\/\/127\.0\.0\.1:\d+\/v1\/'/, `'http://127.0.0.1:${t.firestorePort}/v1/'`, rel);
    }
    return null;
}

module.exports = { DEMO_PROJECT, REWRITTEN, target, e2eTarget, migrationTarget, writeEmulatorConfig, servedText };
