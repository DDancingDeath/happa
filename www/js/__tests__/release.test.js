/**
 * Release/version tooling: changelog validation, scripts/release.js, and the
 * pure decisions behind "What's new", the Android update banner and sharing.
 */
const fs = require('fs');
const path = require('path');
const { validateChangelog, checkRelease, applyRelease } = require('../../../scripts/release.js');
import {
    compareVersions, whatsNewToShow, shouldCheckForUpdate, updateToOffer,
    buildShareMessage, whatsAppShareUrl, DOWNLOAD_PAGE_URL, UPDATE_CHECK_INTERVAL_MS,
    normalizeWhatsNewLang, whatsNewContent
} from '../utils/release-info.js';

const ROOT = path.join(__dirname, '..', '..', '..');
const repoChangelog = JSON.parse(fs.readFileSync(path.join(ROOT, 'www', 'changelog.json'), 'utf8'));

const rel = (version, code, date = '2026-01-01') => ({
    version, date, androidVersionCode: code, notes: { en: [`en ${version}`], hi: [`hi ${version}`] }
});

describe('compareVersions', () => {
    test('compares numerically, accepts a leading v and a missing patch', () => {
        expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
        expect(compareVersions('v1.3', '1.3.0')).toBe(0);
        expect(compareVersions('1.2.9', 'v1.3.0')).toBe(-1);
    });

    test('returns null for anything that is not a plain release version', () => {
        expect(compareVersions('1.3.0-beta', '1.2.0')).toBeNull();
        expect(compareVersions('', '1.2.0')).toBeNull();
        expect(compareVersions('latest', '1.2.0')).toBeNull();
    });
});

describe('changelog.json', () => {
    test('the shipped changelog is valid and newest-first', () => {
        expect(validateChangelog(repoChangelog)).toEqual([]);
    });

    test('rejects releases that are out of order or reuse an Android versionCode', () => {
        expect(validateChangelog({ releases: [rel('1.2.0', 3), rel('1.3.0', 4)] }).join('\n'))
            .toMatch(/1\.2\.0 must be newer than 1\.3\.0/);
        expect(validateChangelog({ releases: [rel('1.3.0', 3), rel('1.2.0', 3)] }).join('\n'))
            .toMatch(/androidVersionCode 3 \(1\.3\.0\) must be greater than 3/);
    });

    test('requires both English and Hindi notes and a proper date', () => {
        const noHindi = { ...rel('1.3.0', 4), notes: { en: ['x'], hi: [] } };
        expect(validateChangelog({ releases: [noHindi] }).join('\n')).toMatch(/notes\.en and notes\.hi/);
        expect(validateChangelog({ releases: [rel('1.3.0', 4, '21/10/2026')] }).join('\n')).toMatch(/YYYY-MM-DD/);
        expect(validateChangelog({ releases: [] })).toHaveLength(1);
    });
});

describe('scripts/release.js', () => {
    let dir;

    function writeFixture({ pkgVersion = '1.3.0', appVersion = '1.3.0', appCode = 4, gradleCode = 4, gradleName = '1.3.0', releases } = {}) {
        fs.mkdirSync(path.join(dir, 'www', 'js'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'android', 'app'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: pkgVersion }, null, 2));
        fs.writeFileSync(path.join(dir, 'www', 'js', 'version.js'),
            `export const APP_VERSION = '${appVersion}';\nexport const ANDROID_VERSION_CODE = ${appCode};\n`);
        fs.writeFileSync(path.join(dir, 'android', 'app', 'build.gradle'),
            `android {\n    defaultConfig {\n        versionCode ${gradleCode}\n        versionName "${gradleName}"\n    }\n}\n`);
        fs.writeFileSync(path.join(dir, 'www', 'changelog.json'),
            JSON.stringify({ releases: releases || [rel('1.3.0', 4), rel('1.2.0', 3)] }, null, 2));
    }

    const read = (...p) => fs.readFileSync(path.join(dir, ...p), 'utf8');

    beforeEach(() => {
        // Scratch dir inside the repo (not the system temp dir); removed after each test.
        dir = fs.mkdtempSync(path.join(ROOT, '.release-test-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('the repository itself is consistent', () => {
        expect(checkRelease(ROOT)).toEqual([]);
    });

    test('--check passes when every file matches the top changelog entry', () => {
        writeFixture();
        expect(checkRelease(dir)).toEqual([]);
    });

    test('--check names each file that drifted', () => {
        writeFixture({ gradleCode: 3, pkgVersion: '1.0.0' });
        const errors = checkRelease(dir).join('\n');
        expect(errors).toMatch(/build\.gradle versionCode is 3, expected 4/);
        expect(errors).toMatch(/package\.json version is "1\.0\.0", expected "1\.3\.0"/);
        expect(errors).not.toMatch(/version\.js/);
    });

    test('bumping refuses (and writes nothing) until the changelog has the new release on top', () => {
        writeFixture();
        const before = read('android', 'app', 'build.gradle');
        expect(() => applyRelease(dir, '1.4.0', 5)).toThrow(/Add a release entry for 1\.4\.0/);
        expect(read('android', 'app', 'build.gradle')).toBe(before);
    });

    test('bumping refuses a versionCode that does not increase', () => {
        writeFixture({ releases: [rel('1.4.0', 4), rel('1.3.0', 4)] });
        expect(() => applyRelease(dir, '1.4.0', 4)).toThrow(/must be greater than 4/);
    });

    test('bumping updates package.json, version.js and build.gradle together', () => {
        writeFixture({ releases: [rel('1.4.0', 5), rel('1.3.0', 4)] });
        expect(applyRelease(dir, '1.4.0', 5)).toEqual([]);
        expect(JSON.parse(read('package.json')).version).toBe('1.4.0');
        expect(read('www', 'js', 'version.js')).toMatch(/APP_VERSION = '1\.4\.0';[\s\S]*ANDROID_VERSION_CODE = 5;/);
        expect(read('android', 'app', 'build.gradle')).toMatch(/versionCode 5\n\s+versionName "1\.4\.0"/);
        expect(checkRelease(dir)).toEqual([]);
    });
});

describe("What's new", () => {
    const changelog = { releases: [rel('1.3.0', 4), rel('1.2.0', 3)] };

    test('shows the running version once, until it has been seen', () => {
        expect(whatsNewToShow(changelog, '1.3.0', null)?.version).toBe('1.3.0');
        expect(whatsNewToShow(changelog, '1.3.0', '1.2.0')?.version).toBe('1.3.0');
        expect(whatsNewToShow(changelog, '1.3.0', '1.3.0')).toBeNull();
    });

    test('skips when the changelog is missing or has no entry for this version', () => {
        expect(whatsNewToShow(null, '1.3.0', null)).toBeNull();
        expect(whatsNewToShow(changelog, '1.4.0', '1.3.0')).toBeNull();
    });
});

describe("What's new language", () => {
    const release = { version: '1.3.0', notes: { en: ['Faster sync'], hi: ['तेज़ सिंक'] } };

    test('defaults to English when nothing is stored', () => {
        expect(whatsNewContent(release, null)).toEqual({ lang: 'en', notesLang: 'en', notes: ['Faster sync'], fellBack: false });
    });

    test('uses the remembered Hindi choice', () => {
        expect(whatsNewContent(release, 'hi')).toEqual({ lang: 'hi', notesLang: 'hi', notes: ['तेज़ सिंक'], fellBack: false });
    });

    test('treats an invalid stored value as English', () => {
        for (const bad of ['HI', 'fr', '', 'undefined', 42]) {
            expect(normalizeWhatsNewLang(bad)).toBe('en');
            expect(whatsNewContent(release, bad).lang).toBe('en');
        }
    });

    test('falls back to the other language when the chosen one has no notes', () => {
        expect(whatsNewContent({ version: '1.3.0', notes: { en: [], hi: ['केवल हिंदी'] } }, 'en'))
            .toEqual({ lang: 'en', notesLang: 'hi', notes: ['केवल हिंदी'], fellBack: true });
        expect(whatsNewContent({ version: '1.3.0', notes: { en: ['Only English'] } }, 'hi'))
            .toEqual({ lang: 'hi', notesLang: 'en', notes: ['Only English'], fellBack: true });
        expect(whatsNewContent({ version: '1.3.0' }, 'hi')).toEqual({ lang: 'hi', notesLang: 'hi', notes: [], fellBack: false });
    });
});

describe('Android update banner', () => {
    const now = Date.UTC(2026, 9, 21, 6, 0, 0);
    const hour = 60 * 60 * 1000;

    test('asks GitHub at most once per 12 hours', () => {
        expect(UPDATE_CHECK_INTERVAL_MS).toBe(12 * hour);
        expect(shouldCheckForUpdate(null, now)).toBe(true);
        expect(shouldCheckForUpdate(String(now - 11 * hour), now)).toBe(false);
        expect(shouldCheckForUpdate(now - 12 * hour, now)).toBe(true);
        expect(shouldCheckForUpdate(now + hour, now)).toBe(true);
    });

    test('offers only a strictly newer release that was not dismissed', () => {
        expect(updateToOffer('1.3.0', 'v1.4.0', null)).toBe('1.4.0');
        expect(updateToOffer('1.9.0', 'v1.10', null)).toBe('1.10.0');
        expect(updateToOffer('1.3.0', 'v1.3.0', null)).toBeNull();
        expect(updateToOffer('1.3.0', 'v1.2.0', null)).toBeNull();
        expect(updateToOffer('1.3.0', 'v1.4.0', '1.4.0')).toBeNull();
        expect(updateToOffer('1.3.0', 'v1.5.0', '1.4.0')).toBe('1.5.0');
    });

    test('ignores missing or odd tags', () => {
        expect(updateToOffer('1.3.0', null, null)).toBeNull();
        expect(updateToOffer('1.3.0', 'v2.0.0-rc1', null)).toBeNull();
        expect(updateToOffer('1.3.0', 'nightly', null)).toBeNull();
    });
});

describe('share message', () => {
    test('uses one language for labels and notes, with the download link, encoded for wa.me', () => {
        const release = { version: '1.3.0', notes: { en: ['Fast & safe'], hi: ['तेज़'] } };
        const msg = buildShareMessage(release);
        expect(msg).toContain('v1.3.0');
        expect(msg).toContain('• Fast & safe');
        expect(msg).not.toMatch(/[\u0900-\u097F]/);
        const hiMsg = buildShareMessage(release, DOWNLOAD_PAGE_URL, 'hi');
        expect(hiMsg).toContain('• तेज़');
        expect(hiMsg).not.toContain('Fast');
        expect(hiMsg).not.toContain('Download');
        expect(buildShareMessage({ version: '1.3.0', notes: { hi: ['तेज़'] } })).toContain('• तेज़');
        expect(msg.trim().endsWith(DOWNLOAD_PAGE_URL)).toBe(true);
        const url = whatsAppShareUrl(msg);
        expect(url.startsWith('https://wa.me/?text=')).toBe(true);
        expect(decodeURIComponent(url.slice('https://wa.me/?text='.length))).toBe(msg);
        expect(url).not.toContain('&');
    });
});
