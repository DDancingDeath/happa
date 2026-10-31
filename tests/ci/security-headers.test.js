/**
 * Security headers on every Hosting site (#89) and a report-only CSP on the app
 * site that allows every external origin the app's code loads from.
 */
const fs = require('fs');
const path = require('path');
const { XLSX_URL } = require('../../www/js/utils/lazy-scripts.js');
const { APP_IDENTITY } = require('../../www/js/config/app-identity.js');

const ROOT = path.resolve(__dirname, '..', '..');
const hosting = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8')).hosting;
const sites = Array.isArray(hosting) ? hosting : [hosting];
const appSite = sites.find((h) => h.public === 'www');

const REQUIRED = {
    'Strict-Transport-Security': /^max-age=\d{8,}; includeSubDomains; preload$/,
    'X-Content-Type-Options': /^nosniff$/,
    'X-Frame-Options': /^DENY$/,
    'Referrer-Policy': /^strict-origin-when-cross-origin$/,
    'Permissions-Policy': /(^|, )camera=\(\)(, |$)[\s\S]*microphone=\(\)[\s\S]*geolocation=\(\)/,
    'Content-Security-Policy': /(^|; )frame-ancestors 'none'(;|$)/
};

/** The headers a site sends on every path (its '**' entries). */
function everyPathHeaders(site) {
    const out = {};
    for (const entry of site.headers || []) {
        if (entry.source !== '**') continue;
        for (const { key, value } of entry.headers) out[key] = value;
    }
    return out;
}

function directives(policy) {
    const out = {};
    for (const part of policy.split(';').map((s) => s.trim()).filter(Boolean)) {
        const [name, ...sources] = part.split(/\s+/);
        out[name] = sources;
    }
    return out;
}

// Origins in the code that the app only links to or opens as a page (CSP does not
// cover navigation), never fetches or runs.
const NOT_LOADED = {
    'https://wa.me': 'WhatsApp share / reminder links (window.open)',
    'https://github.com': 'APK download link on /download and in the update banner',
    [new URL(APP_IDENTITY.siteUrl).origin]: "the app's own address in share text; 'self' on the live site"
};

function walk(dir, files = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            // Tests reference made-up sites; vendor/ is the byte-identical Firebase SDK.
            if (e.name !== '__tests__' && e.name !== 'vendor') walk(p, files);
        } else if (/\.(js|html|css|json|webmanifest)$/.test(e.name)) {
            files.push(p);
        }
    }
    return files;
}

function codeOrigins() {
    const found = new Map();
    for (const file of walk(path.join(ROOT, 'www'))) {
        for (const m of fs.readFileSync(file, 'utf8').matchAll(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi)) {
            const origin = m[0].toLowerCase();
            if (!found.has(origin)) found.set(origin, path.relative(ROOT, file));
        }
    }
    return found;
}

describe('security headers on every Hosting site (#89)', () => {
    test.each(sites.map((s) => [s.site, s]))('%s sends the required headers on every path', (_, site) => {
        const headers = everyPathHeaders(site);
        for (const [key, re] of Object.entries(REQUIRED)) {
            expect({ key, value: headers[key] }).toEqual({ key, value: expect.stringMatching(re) });
        }
    });

    test('every site sends the same values for the shared headers', () => {
        const shared = Object.keys(REQUIRED).filter((k) => k !== 'Content-Security-Policy');
        const pick = (site) => Object.fromEntries(shared.map((k) => [k, everyPathHeaders(site)[k]]));
        for (const site of sites) expect(pick(site)).toEqual(pick(appSite));
    });

    test('the security headers come first, so the tenant link page keeps its stricter Referrer-Policy', () => {
        expect(appSite.headers[0].source).toBe('**');
        for (const source of ['/r.html', '/r/**']) {
            const entry = appSite.headers.find((e) => e.source === source);
            expect(entry.headers).toContainEqual({ key: 'Referrer-Policy', value: 'no-referrer' });
        }
    });
});

describe('app site CSP (report-only until the inline handlers are gone, #89)', () => {
    const headers = everyPathHeaders(appSite);
    const csp = directives(headers['Content-Security-Policy-Report-Only'] || '');
    const allowed = new Set(Object.values(csp).flat().filter((s) => s.startsWith('https://')));

    test('is report-only, with a locked-down baseline', () => {
        expect(csp['default-src']).toEqual(["'self'"]);
        expect(csp['object-src']).toEqual(["'none'"]);
        expect(csp['base-uri']).toEqual(["'self'"]);
        // Report-only ignores frame-ancestors; it is enforced in Content-Security-Policy instead.
        expect(csp['frame-ancestors']).toBeUndefined();
        for (const sources of Object.values(csp)) {
            expect(sources).not.toContain("'unsafe-eval'");
            expect(sources).not.toContain('*');
            expect(sources).not.toContain('https:');
        }
    });

    test("script-src allows only our files, Auth's gapi loader, the pinned SheetJS CDN and (for now) inline handlers", () => {
        expect(csp['script-src']).toEqual(["'self'", "'unsafe-inline'", 'https://apis.google.com', new URL(XLSX_URL).origin]);
    });

    test("frame-src is only Firebase Auth's iframe on the project's authDomain", () => {
        // On phones the compat Auth SDK loads gapi and frames <authDomain>/__/auth/iframe at start-up.
        const config = fs.readFileSync(path.join(ROOT, 'www', 'firebaseConfig.js'), 'utf8');
        const authDomain = config.match(/"authDomain":\s*"([^"]+)"/)[1];
        expect(csp['frame-src']).toEqual([`https://${authDomain}`]);
    });

    test('connect-src allows the Firebase APIs the SDK calls and the release check', () => {
        expect(csp['connect-src']).toEqual(expect.arrayContaining([
            "'self'",
            'https://firestore.googleapis.com',
            'https://identitytoolkit.googleapis.com',
            'https://securetoken.googleapis.com',
            'https://apis.google.com',
            new URL(APP_IDENTITY.latestReleaseApi).origin
        ]));
    });

    test('every external origin in www/ is allowed by the CSP or is only linked to', () => {
        const unknown = [...codeOrigins()]
            .filter(([origin]) => !allowed.has(origin) && !(origin in NOT_LOADED))
            .map(([origin, file]) => `${origin} (${file})`);
        expect(unknown).toEqual([]);
    });

    test('the not-loaded list has no stale entries', () => {
        const origins = codeOrigins();
        expect(Object.keys(NOT_LOADED).filter((o) => !origins.has(o))).toEqual([]);
    });
});
