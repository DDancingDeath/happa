/**
 * Pure helpers for "What's new", the Android update banner and app sharing.
 * Kept free of DOM/network so they can be unit tested.
 */

import { APP_IDENTITY } from '../config/app-identity.js';

export const APP_NAME = APP_IDENTITY.appName;
export const DOWNLOAD_PAGE_URL = APP_IDENTITY.downloadPageUrl;
export const APK_DOWNLOAD_URL = APP_IDENTITY.apkDownloadUrl;
export const LATEST_RELEASE_API = APP_IDENTITY.latestReleaseApi;
export const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

const SEMVER_RE = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/;

/** Parses "1.3.0", "v1.3" etc. into [major, minor, patch]; null when not a plain release version. */
export function parseVersion(text) {
    const m = SEMVER_RE.exec(String(text ?? '').trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

/** -1 / 0 / 1 like a sort comparator; null if either side is not a valid version. */
export function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa || !pb) return null;
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
    }
    return 0;
}

export function findRelease(changelog, version) {
    const releases = Array.isArray(changelog?.releases) ? changelog.releases : [];
    return releases.find((r) => r && compareVersions(r.version, version) === 0) || null;
}

/** The release to show in "What's new" on startup, or null to skip. */
export function whatsNewToShow(changelog, appVersion, lastSeenVersion) {
    if (lastSeenVersion && compareVersions(lastSeenVersion, appVersion) === 0) return null;
    const release = findRelease(changelog, appVersion);
    return release && hasNotes(release) ? release : null;
}

export function hasNotes(release) {
    const n = release?.notes;
    return Boolean(n && ((Array.isArray(n.en) && n.en.length) || (Array.isArray(n.hi) && n.hi.length)));
}

export const WHATS_NEW_LANGS = ['en', 'hi'];
export const DEFAULT_WHATS_NEW_LANG = 'en';

/** Sheet labels per language; `fallback` explains that the notes are in the other language. */
export const WHATS_NEW_LABELS = {
    en: {
        title: "What's new",
        version: (v) => `Version ${v}`,
        close: 'OK',
        fallback: 'Notes are not available in English for this version — showing Hindi.'
    },
    hi: {
        title: 'क्या नया है',
        version: (v) => `वर्ज़न ${v}`,
        close: 'ठीक है',
        fallback: 'इस वर्ज़न के नोट्स हिंदी में उपलब्ध नहीं हैं — अंग्रेज़ी में दिखाए जा रहे हैं।'
    }
};

/** The stored "What's new" language, or English when missing/invalid. */
export function normalizeWhatsNewLang(value) {
    return WHATS_NEW_LANGS.includes(value) ? value : DEFAULT_WHATS_NEW_LANG;
}

/**
 * What the "What's new" sheet shows for a release and the (stored) language choice.
 * `lang` is the chosen UI language; `notesLang` is the language the notes are actually in
 * (the other one, with `fellBack: true`, when the chosen language has no notes).
 */
export function whatsNewContent(release, storedLang) {
    const lang = normalizeWhatsNewLang(storedLang);
    const notesFor = (l) => (Array.isArray(release?.notes?.[l]) ? release.notes[l].map(String) : []);
    let notesLang = lang;
    let notes = notesFor(lang);
    let fellBack = false;
    if (!notes.length) {
        const other = lang === 'en' ? 'hi' : 'en';
        const otherNotes = notesFor(other);
        if (otherNotes.length) {
            notesLang = other;
            notes = otherNotes;
            fellBack = true;
        }
    }
    return { lang, notesLang, notes, fellBack };
}

/** Whether to ask GitHub again (at most once per interval; also re-checks if the clock went backwards). */
export function shouldCheckForUpdate(lastCheckMs, nowMs, intervalMs = UPDATE_CHECK_INTERVAL_MS) {
    const last = Number(lastCheckMs);
    if (!Number.isFinite(last) || last <= 0 || last > nowMs) return true;
    return nowMs - last >= intervalMs;
}

/** Version string (without "v") to offer in the update banner, or null. */
export function updateToOffer(appVersion, latestTag, dismissedVersion) {
    const latest = parseVersion(latestTag);
    if (!latest || compareVersions(latestTag, appVersion) !== 1) return null;
    const version = latest.join('.');
    if (dismissedVersion && compareVersions(dismissedVersion, version) === 0) return null;
    return version;
}

/** WhatsApp-ready text (Hindi + English) for sharing the app. */
export function buildShareMessage(release, url = DOWNLOAD_PAGE_URL) {
    const lines = [`${APP_NAME} app` + (release?.version ? ` v${release.version}` : '')];
    const hi = Array.isArray(release?.notes?.hi) ? release.notes.hi : [];
    const en = Array.isArray(release?.notes?.en) ? release.notes.en : [];
    if (hi.length) lines.push('', 'नया क्या है:', ...hi.map((n) => `• ${n}`));
    if (en.length) lines.push('', "What's new:", ...en.map((n) => `• ${n}`));
    lines.push('', 'ऐप डाउनलोड करें / Download the app:', url);
    return lines.join('\n');
}

export function whatsAppShareUrl(message) {
    return 'https://wa.me/?text=' + encodeURIComponent(message);
}
