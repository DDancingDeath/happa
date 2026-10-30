/**
 * `--emulator`: point apply / wipe / auth:import at the local Firebase
 * emulators instead of a real project (tests/migration-e2e). firebase-admin
 * talks to the emulators when FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST
 * are set (`firebase emulators:exec` sets both), so the flag only checks that
 * they are set and local, and that no service-account key is given.
 */

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/i;

/**
 * @param {{emulator: boolean, keyFile?: string, env?: Object, auth?: boolean}} o
 *   auth: the command also uses Firebase Auth (wipe, auth:import)
 * @returns {?{firestore: string, auth: ?string}} the emulator hosts, or null for a real project
 */
export function checkEmulatorTarget({ emulator, keyFile, env = process.env, auth = false }) {
    const fsHost = env.FIRESTORE_EMULATOR_HOST;
    const authHost = env.FIREBASE_AUTH_EMULATOR_HOST;
    if (!emulator) {
        if (fsHost || authHost) {
            throw new Error('FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST is set: add --emulator to use the emulators, or unset it to use the real project.');
        }
        return null;
    }
    if (keyFile) throw new Error('--emulator takes no service-account key (--key / GOOGLE_APPLICATION_CREDENTIALS)');
    const needed = [['FIRESTORE_EMULATOR_HOST', fsHost], ...(auth ? [['FIREBASE_AUTH_EMULATOR_HOST', authHost]] : [])];
    needed.forEach(([name, value]) => {
        if (!value) throw new Error(`--emulator needs ${name} (run inside "firebase emulators:exec", or set it to 127.0.0.1:<port>)`);
        if (!LOCAL_HOST.test(value)) throw new Error(`--emulator: ${name}=${value} is not a local emulator (127.0.0.1:<port> or localhost:<port>)`);
    });
    return { firestore: fsHost, auth: authHost || null };
}
