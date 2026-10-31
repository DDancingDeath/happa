/**
 * @fileoverview Guards first-load performance plumbing:
 *  - every service-worker precache entry exists (a single 404 used to abort
 *    the whole precache), and every app file is precached;
 *  - index.html links the same stylesheets, in the same order, as styles.css;
 *  - the on-demand script loader injects a library only once.
 */
const fs = require('fs');
const path = require('path');
const { check } = require('../../../scripts/check-sw-assets.js');
import { loadScriptOnce, ensureXLSX, XLSX_URL, XLSX_INTEGRITY } from '../utils/lazy-scripts.js';

const WWW = path.join(__dirname, '..', '..');

describe('service worker precache list', () => {
    test('all entries exist and all app files are listed', () => {
        const { missingOnDisk, notListed, duplicates } = check();
        expect(missingOnDisk).toEqual([]);
        expect(notListed).toEqual([]);
        expect(duplicates).toEqual([]);
    });
});

describe('self-hosted Firebase SDK (#28)', () => {
    const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
    const sdkTags = [...html.matchAll(/<script defer src="(vendor\/firebase\/[^"]+)" integrity="([^"]+)"><\/script>/g)];

    test('index.html loads app, auth, firestore compat from our origin, in order', () => {
        expect(html).not.toMatch(/gstatic\.com\/firebasejs/);
        expect(sdkTags.map((m) => m[1])).toEqual([
            'vendor/firebase/10.7.1/firebase-app-compat.js',
            'vendor/firebase/10.7.1/firebase-auth-compat.js',
            'vendor/firebase/10.7.1/firebase-firestore-compat.js',
        ]);
        expect(html.indexOf('firebase-firestore-compat.js')).toBeLessThan(html.indexOf('src="firebaseConfig.js"'));
    });

    test('SRI hashes match the files on disk and the SW precaches them', () => {
        const crypto = require('crypto');
        const { readStaticAssets } = require('../../../scripts/check-sw-assets.js');
        const precached = readStaticAssets();
        for (const [, src, integrity] of sdkTags) {
            const body = fs.readFileSync(path.join(WWW, src));
            expect(integrity).toBe('sha384-' + crypto.createHash('sha384').update(body).digest('base64'));
            expect(precached).toContain('/' + src);
        }
    });
});

describe('firebaseConfig.js SDK-missing recovery (#28)', () => {
    const src = fs.readFileSync(path.join(WWW, 'firebaseConfig.js'), 'utf8');

    beforeEach(() => {
        // jsdom logs "navigation not implemented" for location.reload().
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        sessionStorage.clear();
        delete window.caches;
        delete window.__aadhatSdkRecovery;
        document.body.innerHTML = '';
    });

    test('first failure purges cached SDK files and retries once', async () => {
        const del = jest.fn().mockResolvedValue(true);
        const reqs = [{ url: 'http://x/vendor/firebase/10.7.1/firebase-app-compat.js' }, { url: 'http://x/js/main.js' }];
        window.caches = {
            keys: jest.fn().mockResolvedValue(['aadhat-v24']),
            open: jest.fn().mockResolvedValue({ keys: jest.fn().mockResolvedValue(reqs), delete: del }),
        };
        expect(() => window.eval(src)).toThrow('Firebase SDK failed to load');
        await window.__aadhatSdkRecovery.catch(() => {});
        expect(del).toHaveBeenCalledTimes(1);
        expect(del).toHaveBeenCalledWith(reqs[0]);
        expect(sessionStorage.getItem('aadhatSdkRetry')).toBe('1');
        expect(document.getElementById('sdkLoadError')).toBeNull();
    });

    test('second failure shows a message instead of a blank page', () => {
        sessionStorage.setItem('aadhatSdkRetry', '1');
        window.caches = { keys: jest.fn() };
        expect(() => window.eval(src)).toThrow('Firebase SDK failed to load');
        expect(window.caches.keys).not.toHaveBeenCalled();
        expect(document.getElementById('sdkLoadError').textContent).toMatch(/internet/);
    });
});

describe('index.html stylesheets (#66)', () => {
    const { cssSources, buildCss, OUT_URL } = require('../../../scripts/build-css.js');

    test('index.html links one stylesheet, css/app.css', () => {
        const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
        const linked = [...html.matchAll(/<link rel="stylesheet" href="([^"?]+)/g)].map((m) => m[1]);
        expect(linked).toEqual([OUT_URL]);
    });

    test('css/app.css is up to date with the files in styles.css (npm run build:css)', () => {
        expect(cssSources().length).toBeGreaterThan(20);
        const built = fs.readFileSync(path.join(WWW, OUT_URL), 'utf8').replace(/\r\n/g, '\n');
        expect(built === buildCss()).toBe(true);
    });

    test('joins in list order and refuses @import inside a source', () => {
        const files = { 'css/a.css': '.a{}\r\n', 'css/b.css': '.b{}' };
        const out = buildCss(['css/a.css', 'css/b.css'], (rel) => files[rel]);
        expect(out.indexOf('.a{}')).toBeLessThan(out.indexOf('.b{}'));
        expect(out).not.toMatch(/\r/);
        expect(() => buildCss(['css/a.css'], () => "@import url('x.css');")).toThrow(/@import/);
    });
});

describe('loadScriptOnce', () => {
    afterEach(() => {
        document.head.innerHTML = '';
        delete window.FakeLib;
    });

    test('injects a script once and resolves with the global', async () => {
        const src = 'https://example.test/fake-lib.js';
        const p1 = loadScriptOnce(src, 'FakeLib');
        const p2 = loadScriptOnce(src, 'FakeLib');
        const scripts = document.head.querySelectorAll(`script[src="${src}"]`);
        expect(scripts).toHaveLength(1);

        window.FakeLib = { ok: true };
        scripts[0].onload();
        await expect(p1).resolves.toEqual({ ok: true });
        expect(p2).toBe(p1);
        await expect(loadScriptOnce(src, 'FakeLib')).resolves.toEqual({ ok: true });
    });

    test('allows retry after a load error', async () => {
        const src = 'https://example.test/flaky-lib.js';
        const p1 = loadScriptOnce(src, 'FakeLib');
        document.head.querySelector(`script[src="${src}"]`).onerror();
        await expect(p1).rejects.toThrow('Failed to load script');
        const p2 = loadScriptOnce(src, 'FakeLib');
        expect(p2).not.toBe(p1);
        expect(document.head.querySelectorAll(`script[src="${src}"]`)).toHaveLength(2);
        p2.catch(() => {});
    });

    test('ensureXLSX pins the CDN script with Subresource Integrity', () => {
        const p = ensureXLSX();
        const script = document.head.querySelector(`script[src="${XLSX_URL}"]`);
        expect(XLSX_URL).toMatch(/xlsx-\d+\.\d+\.\d+\//);
        expect(script.integrity).toBe(XLSX_INTEGRITY);
        expect(XLSX_INTEGRITY).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
        expect(script.crossOrigin).toBe('anonymous');
        script.onerror();
        p.catch(() => {});
    });
});
