/**
 * @jest-environment node
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, derive, configProblems, hostingProblems, plan, check, guard } = require('../../../scripts/happa-config.js');

const ROOT = path.join(__dirname, '..', '..', '..');

const filled = () => {
    const raw = JSON.parse(JSON.stringify(loadConfig(ROOT)));
    Object.assign(raw.firebase, {
        projectId: 'happa-shop',
        hostingSite: '',
        redirectHostingSites: [],
        apiKey: 'AIzaTestKey',
        messagingSenderId: '123',
        appId: '1:123:web:abc'
    });
    raw.ownerConfirmed = true;
    return raw;
};

describe('happa.config.json', () => {
    test('every identity file matches happa.config.json', () => {
        expect(check(ROOT, { syncOnly: true })).toEqual([]);
    });

    test('release gate lists unfilled placeholders and the owner confirmation', () => {
        const raw = loadConfig(ROOT);
        raw.firebase.projectId = '__HAPPA_PROJECT_ID__';
        raw.ownerConfirmed = false;
        const problems = configProblems(raw).join('\n');
        expect(problems).toMatch(/firebase\.projectId = __HAPPA_PROJECT_ID__/);
        expect(problems).toMatch(/ownerConfirmed/);
        expect(configProblems(filled())).toEqual([]);
    });

    test('the derived Firebase config uses the .firebasestorage.app bucket and no Analytics SDK is loaded', () => {
        const d = derive(loadConfig(ROOT));
        expect(d.webConfig.storageBucket).toBe(`${d.projectId}.firebasestorage.app`);
        const index = fs.readFileSync(path.join(ROOT, 'www', 'index.html'), 'utf8');
        expect(index).not.toMatch(/firebase-analytics|googletagmanager|gtag\(/i);
        expect(fs.existsSync(path.join(ROOT, 'www', 'vendor', 'firebase', '10.7.1', 'firebase-analytics-compat.js'))).toBe(false);
    });

    test('the old app project and package are refused', () => {
        const oldProject = filled();
        oldProject.firebase.projectId = 'aadhat-management';
        expect(configProblems(oldProject).join('\n')).toMatch(/old app/);
        const oldPackage = filled();
        oldPackage.androidPackage = 'com.hitesh.aadhat';
        expect(configProblems(oldPackage).join('\n')).toMatch(/old app/);
    });

    test('filled values reach every identity file', () => {
        const files = Object.fromEntries(plan(ROOT, filled()).map((p) => [p.file, p.wanted]));
        for (const [file, text] of Object.entries(files)) {
            expect({ file, placeholder: /__HAPPA_[A-Z_]+__/.test(text) }).toEqual({ file, placeholder: false });
            expect({ file, old: /aadhat-management|applicationId "com\.hitesh|"appId": "com\.hitesh|>com\.hitesh\.aadhat</.test(text) }).toEqual({ file, old: false });
        }
        expect(JSON.parse(files['.firebaserc']).projects.default).toBe('happa-shop');
        expect(JSON.parse(files['firebase.json']).hosting.site).toBe('happa-shop');
        expect(files['www/firebaseConfig.js']).toContain('"authDomain": "happa-shop.firebaseapp.com"');
        expect(files['www/download.html']).toContain('href="https://happa-shop.web.app"');
        expect(files['www/download.html']).toContain('releases/latest/download/happa.apk');
        expect(files['android/app/build.gradle']).toMatch(/applicationId "com\.happa"/);
        expect(files['android/app/build.gradle']).toMatch(/namespace "com\.happa"/);
    });

    test('only the app site serves www/; redirect sites only 301 every path to it', () => {
        const raw = filled();
        raw.firebase.hostingSite = 'happa-app';
        raw.firebase.redirectHostingSites = ['happa-shop'];
        const d = derive(raw);
        const files = Object.fromEntries(plan(ROOT, raw).map((p) => [p.file, p.wanted]));
        const json = JSON.parse(files['firebase.json']);
        expect(json.hosting.map((h) => [h.site, h.public])).toEqual([['happa-app', 'www'], ['happa-shop', 'hosting-redirect']]);
        expect(json.hosting[0].redirects).toBeUndefined();
        expect(json.hosting[1]).toEqual({ site: 'happa-shop', public: 'hosting-redirect',
            redirects: [
                { source: '/', destination: 'https://happa-app.web.app/', type: 301 },
                { source: '/:path*', destination: 'https://happa-app.web.app/:path', type: 301 }
            ],
            headers: [{ source: '**', headers: expect.arrayContaining([{ key: 'X-Frame-Options', value: 'DENY' }]) }] });
        expect(hostingProblems(json, d)).toEqual([]);
        expect(files['www/download.html']).toContain('href="https://happa-app.web.app"');
        expect(configProblems(raw)).toEqual([]);

        const appOnRedirectSite = JSON.parse(files['firebase.json']);
        appOnRedirectSite.hosting[1] = { ...appOnRedirectSite.hosting[0], site: 'happa-shop' };
        expect(hostingProblems(appOnRedirectSite, d).join('\n')).toMatch(/happa-shop must only 301/);
        const redirectedApp = JSON.parse(files['firebase.json']);
        redirectedApp.hosting[0].redirects = redirectedApp.hosting[1].redirects;
        expect(hostingProblems(redirectedApp, d).join('\n')).toMatch(/happa-app must serve the app/);
        expect(hostingProblems({ hosting: json.hosting[0] }, d).join('\n')).toMatch(/must be \[happa-app, happa-shop\]/);

        raw.firebase.redirectHostingSites = ['aadhat-management'];
        expect(configProblems(raw).join('\n')).toMatch(/old app/);
    });
});

describe('CI guard', () => {
    let dir;
    const write = (projectId, rc = projectId) => {
        const raw = filled();
        raw.firebase.projectId = projectId;
        fs.writeFileSync(path.join(dir, 'happa.config.json'), JSON.stringify(raw));
        fs.writeFileSync(path.join(dir, '.firebaserc'), JSON.stringify({ projects: { default: rc } }));
        const hosting = plan(ROOT, raw).find((p) => p.file === 'firebase.json').wanted;
        fs.writeFileSync(path.join(dir, 'firebase.json'), hosting);
    };
    const sa = (projectId) => JSON.stringify({ project_id: projectId });

    beforeEach(() => { dir = fs.mkdtempSync(path.join(ROOT, '.happa-test-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('passes for the Happa project with a matching service account', () => {
        write('happa-shop');
        expect(guard(dir, { requireReady: true, requireSa: true, saJson: sa('happa-shop') })).toMatchObject({ ok: true, ready: true, projectId: 'happa-shop' });
    });

    test('never lets aadhat-management through', () => {
        write('aadhat-management');
        expect(guard(dir, { saJson: sa('aadhat-management') }).ok).toBe(false);
        write('happa-shop', 'aadhat-management');
        expect(guard(dir, { saJson: sa('happa-shop') }).ok).toBe(false);
        write('happa-shop');
        expect(guard(dir, { saJson: sa('aadhat-management') }).ok).toBe(false);
    });

    test('fails when firebase.json gives the app to a redirect site', () => {
        write('happa-shop');
        const json = JSON.parse(fs.readFileSync(path.join(dir, 'firebase.json'), 'utf8'));
        json.hosting = [json.hosting, { ...json.hosting, site: 'happa-old' }];
        const raw = JSON.parse(fs.readFileSync(path.join(dir, 'happa.config.json'), 'utf8'));
        raw.firebase.redirectHostingSites = ['happa-old'];
        fs.writeFileSync(path.join(dir, 'happa.config.json'), JSON.stringify(raw));
        fs.writeFileSync(path.join(dir, 'firebase.json'), JSON.stringify(json));
        expect(guard(dir, { saJson: sa('happa-shop') }).ok).toBe(false);
    });

    test('placeholder project: previews skip, deploys fail', () => {
        write('__HAPPA_PROJECT_ID__');
        expect(guard(dir, { saJson: sa('happa-shop') })).toMatchObject({ ok: true, ready: false });
        expect(guard(dir, { requireReady: true, saJson: sa('happa-shop') }).ok).toBe(false);
    });

    test('missing service account: previews skip, deploys fail', () => {
        write('happa-shop');
        expect(guard(dir, {})).toMatchObject({ ok: true, ready: false });
        expect(guard(dir, { requireSa: true }).ok).toBe(false);
    });

    test('derived URLs come from the project id unless a hosting site is set', () => {
        const raw = filled();
        expect(derive(raw).downloadPageUrl).toBe('https://happa-shop.web.app/download');
        raw.firebase.hostingSite = 'happa-app';
        expect(derive(raw).siteUrl).toBe('https://happa-app.web.app');
    });
});
