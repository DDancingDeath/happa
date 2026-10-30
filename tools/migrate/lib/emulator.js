/**
 * `--emulator`: point apply / wipe / auth:import at the local Firebase
 * emulators instead of a real project (tests/migration-e2e). firebase-admin
 * talks to the emulators when FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST
 * are set (`firebase emulators:exec` sets both), so the flag checks that they
 * are set and local, that no service-account key is given, and that the
 * project is a `demo-*` id (never happa-bfc07, aadhat-management or another
 * real project), so nothing can reach a real project even if a variable is lost.
 */

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/i;
/** Firebase's demo projects: the emulators serve them and they have no real backend. */
export const DEMO_PROJECT = /^demo-[a-z0-9-]+$/;

/**
 * @param {{emulator: boolean, project?: string, keyFile?: string, env?: Object, auth?: boolean}} o
 *   project: the target project id (with --emulator it must be demo-*)
 *   auth: the command also uses Firebase Auth (wipe, auth:import)
 * @returns {?{firestore: string, auth: ?string}} the emulator hosts, or null for a real project
 */
export function checkEmulatorTarget({ emulator, project, keyFile, env = process.env, auth = false }) {
    const fsHost = env.FIRESTORE_EMULATOR_HOST;
    const authHost = env.FIREBASE_AUTH_EMULATOR_HOST;
    if (!emulator) {
        if (fsHost || authHost) {
            throw new Error('FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST is set: add --emulator to use the emulators, or unset it to use the real project.');
        }
        return null;
    }
    if (keyFile) throw new Error('--emulator takes no service-account key (--key / GOOGLE_APPLICATION_CREDENTIALS)');
    if (!DEMO_PROJECT.test(String(project || ''))) {
        throw new Error(`--emulator needs a demo-* project id (--project demo-<name>), not "${project || ''}": a real project id is refused`);
    }
    const needed = [['FIRESTORE_EMULATOR_HOST', fsHost], ...(auth ? [['FIREBASE_AUTH_EMULATOR_HOST', authHost]] : [])];
    needed.forEach(([name, value]) => {
        if (!value) throw new Error(`--emulator needs ${name} (run inside "firebase emulators:exec", or set it to 127.0.0.1:<port>)`);
        if (!LOCAL_HOST.test(value)) throw new Error(`--emulator: ${name}=${value} is not a local emulator (127.0.0.1:<port> or localhost:<port>)`);
    });
    return { firestore: fsHost, auth: authHost || null };
}