#!/usr/bin/env node
/**
 * Android versionCode for a release tag, used by .github/workflows/android-release.yml.
 *
 *   node scripts/android-version-code.js v1.0.0-rc11   # prints 10000011
 *
 * Code = major·10^7 + minor·10^5 + patch·10^3 + (rc number, or 999 for the final release),
 * so it rises with every tag: 1.0.0-rc1 < 1.0.0-rc11 < 1.0.0 < 1.0.1-rc1 < 1.1.0.
 * Every code is far above 1, the versionCode of APKs built before this scheme.
 */
const TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?$/;
const FINAL = 999;
// Google Play's versionCode limit.
const MAX_CODE = 2100000000;

function versionCodeForTag(tag) {
    const m = TAG_RE.exec(String(tag ?? '').trim());
    if (!m) throw new Error(`Tag "${tag}" must look like v<major>.<minor>.<patch> or v<major>.<minor>.<patch>-rc<n>`);
    const [major, minor, patch] = [m[1], m[2], m[3]].map(Number);
    const rc = m[4] === undefined ? FINAL : Number(m[4]);
    if (minor > 99 || patch > 99) throw new Error(`Tag "${tag}": minor and patch must be at most 99`);
    if (m[4] !== undefined && (rc < 1 || rc >= FINAL)) throw new Error(`Tag "${tag}": rc number must be 1 to ${FINAL - 1}`);
    const code = major * 1e7 + minor * 1e5 + patch * 1e3 + rc;
    if (code > MAX_CODE) throw new Error(`Tag "${tag}": versionCode ${code} is above ${MAX_CODE}`);
    return code;
}

module.exports = { versionCodeForTag };

if (require.main === module) {
    try {
        console.log(versionCodeForTag(process.argv[2]));
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}
