/**
 * Tenant rent-history page /r/<token> (follow-up to #170): tiny, read-only,
 * one Firestore read, no app code or service worker, noindex, one language at a time.
 */
const fs = require('fs');
const path = require('path');

const WWW = path.join(__dirname, '..', '..');
const ROOT = path.join(WWW, '..');
const read = (p) => fs.readFileSync(path.join(WWW, p), 'utf8');
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx';

const enc = (v) => {
    if (v === null) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === 'string') return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
    return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
};
const SNAP = {
    lid: 'L1', v: 1, shop: 'Shop', tenant: 'Ram', place: 'Gali 2 · G1', rent: 5000, dueDay: 10, ended: true, endMonth: '2026-10',
    months: [
        { m: '2026-09', rent: 5000, elec: 400, units: 50, total: 5400, paid: 5400, due: 0, st: 'paid', pd: ['2026-09-08'] },
        // Stored status is stale on purpose: the page works it out from month, due day and due.
        { m: '2026-10', rent: 5000, elec: 0, units: 0, total: 5000, paid: 2000, due: 3000, dd: 10, st: 'paid', pd: ['2026-10-05'] }
    ],
    updatedAt: 1
};

describe('page budget and isolation', () => {
    test('page files are at most 30 KB together', () => {
        const bytes = ['r.html', 'r/rent-history.js', 'r/rent-history.css'].reduce((s, f) => s + fs.statSync(path.join(WWW, f)).size, 0);
        expect(bytes).toBeLessThanOrEqual(30 * 1024);
    });

    test('loads no app code, Firebase SDK or service worker; noindex and no referrer', () => {
        const html = read('r.html');
        const js = read('r/rent-history.js');
        expect(html).not.toMatch(/main\.js|firebaseConfig\.js|vendor\/firebase|serviceWorker|service-worker/);
        expect(js).not.toMatch(/serviceWorker|import\s|firebase\.firestore|from '\.\.\//);
        expect(html).toMatch(/<meta name="robots" content="noindex/);
        expect(html).toMatch(/<meta name="referrer" content="no-referrer">/);
    });

    test('hosting serves /r/** from r.html (before the app rewrite) with noindex headers', () => {
        const hosting = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8')).hosting[0];
        const idx = hosting.rewrites.findIndex(r => r.source === '/r/**' && r.destination === '/r.html');
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(hosting.rewrites.findIndex(r => r.source === '**'));
        // Plain globs: an extglob like "/@(r.html|r/**)" never matches on Hosting (live headers were missing).
        for (const source of ['/r.html', '/r/**']) {
            const h = hosting.headers.find(x => x.source === source);
            expect(h.headers).toEqual(expect.arrayContaining([
                expect.objectContaining({ key: 'X-Robots-Tag' }),
                expect.objectContaining({ key: 'Referrer-Policy', value: 'no-referrer' }),
                expect.objectContaining({ key: 'Cache-Control', value: 'no-cache' })
            ]));
        }
        expect(hosting.headers.some(x => /@\([^)]*\//.test(x.source))).toBe(false);
    });

    test('the app never loads the page code, and the page is not in the app precache', () => {
        const { readStaticAssets } = require('../../../scripts/check-sw-assets.js');
        expect(readStaticAssets().filter(u => /rent-history|^\/r\.html$|^\/r\//.test(u))).toEqual([]);
        expect(read('index.html')).not.toMatch(/rent-history/);
    });
});

describe('page behaviour (jsdom)', () => {
    function run({ status = 200, body = { fields: enc(SNAP).mapValue.fields }, lang = 'en-IN', url = `/r/${TOKEN}` } = {}) {
        document.documentElement.innerHTML = '<head><title></title></head><body><main id="rh"></main></body>';
        window.history.pushState({}, '', url);
        localStorage.clear();
        Object.defineProperty(window.navigator, 'language', { value: lang, configurable: true });
        const calls = [];
        window.fetch = jest.fn(async (u) => {
            calls.push(u);
            if (u === '/__/firebase/init.json') return { ok: true, status: 200, json: async () => ({ projectId: 'demo-p', apiKey: 'k1' }) };
            return { ok: status === 200, status, json: async () => body };
        });
        window.__rentHistoryNoAutoStart = true;
        // eslint-disable-next-line no-new-func
        new Function(read('r/rent-history.js'))();
        return { calls, done: window.RentHistory.start(window, { today: new Date(2026, 9, 8) }) };
    }

    test('reads exactly one document and shows only that tenant, newest month first', async () => {
        const { calls, done } = run();
        await done;
        const docCalls = calls.filter(u => /documents\//.test(u));
        expect(docCalls).toEqual([`https://firestore.googleapis.com/v1/projects/demo-p/databases/(default)/documents/rent_public/${TOKEN}?key=k1`]);
        const text = document.getElementById('rh').textContent;
        expect(text).toContain('Rent history: Ram');
        expect(text).toContain('Moved out. Last month: Oct 2026');
        expect(text.indexOf('Oct 2026')).toBeLessThan(text.indexOf('Sep 2026'));
        expect(text).toContain('Electricity (50 units)');
        expect(text).toContain('Part paid');
        expect(text).toMatch(/Total due\s*₹3,000/);
        expect(text.replace('हिंदी', '')).not.toMatch(/[\u0900-\u097F]/);
    });

    test('Hindi browser: Hindi page; the toggle switches to English only', async () => {
        const { done } = run({ lang: 'hi-IN' });
        await done;
        const root = document.getElementById('rh');
        expect(root.textContent).toContain('किराये का हिसाब: Ram');
        expect(root.textContent.replace(/Ram|Shop|Gali|G1|English/g, '')).not.toMatch(/[A-Za-z]{2,}/);
        root.querySelector('#rhLang').click();
        expect(root.textContent).toContain('Rent history: Ram');
        expect(localStorage.getItem('happa.rentLang')).toBe('en');
    });

    test('turned-off / unknown link and a bad token show "not available" (no read for a bad token)', async () => {
        let r = run({ status: 404, body: {} });
        await r.done;
        expect(document.getElementById('rh').textContent).toMatch(/not available/);
        r = run({ url: '/r/short' });
        await r.done;
        expect(r.calls).toEqual([]);
        expect(document.getElementById('rh').textContent).toMatch(/not available/);
    });

    test('status is worked out when the page opens: Paid / Part paid / Due, Late after the due day', () => {
        const { statusOf } = window.RentHistory;
        const x = { m: '2026-10', paid: 2000, due: 3000, st: 'paid' };
        expect(statusOf(x, 10, new Date(2026, 9, 10))).toBe('partial');
        expect(statusOf(x, 10, new Date(2026, 9, 11))).toBe('late');
        expect(statusOf({ ...x, dd: 5 }, 10, new Date(2026, 9, 6))).toBe('late');
        expect(statusOf({ ...x, paid: 0 }, 10, new Date(2026, 9, 1))).toBe('due');
        expect(statusOf({ ...x, due: 0, st: 'late' }, 10, new Date(2027, 0, 1))).toBe('paid');
    });

    test('receipt number next to each paid entry, from the same single read', async () => {
        const months = [{ ...SNAP.months[1], py: [{ d: '2026-10-05', a: 1500, r: 'R-2026-0007' }, { d: '2026-10-06', a: 500 }] }];
        const { calls, done } = run({ body: { fields: enc({ ...SNAP, months }).mapValue.fields } });
        await done;
        const text = document.getElementById('rh').textContent;
        expect(text).toContain('Paid on: 05/10/2026 · ₹1,500 · Receipt R-2026-0007');
        expect(text).toContain('Paid on: 06/10/2026 · ₹500');
        expect(calls.filter(u => /documents\//.test(u))).toHaveLength(1);
        const hi = run({ lang: 'hi-IN', body: { fields: enc({ ...SNAP, months }).mapValue.fields } });
        await hi.done;
        expect(document.getElementById('rh').textContent).toContain('रसीद R-2026-0007');
    });

    test('after a change of unit: the old unit\'s months are named, the current unit\'s first in the move month', async () => {
        const months = [
            { ...SNAP.months[0], pl: '1A, Gupta Bhawan', pt: 'flat' },
            { ...SNAP.months[1], rent: 2419, total: 2419, paid: 2000, due: 419, pl: '1A, Gupta Bhawan', pt: 'flat', py: [{ d: '2026-10-05', a: 2000, r: 'R-2026-0007' }] },
            { m: '2026-10', rent: 4645, elec: 0, units: 0, total: 4645, paid: 0, due: 4645, dd: 10, st: 'due', pd: [] }
        ];
        const snap = { ...SNAP, ended: false, endMonth: null, place: '7, Arora Market', ut: 'commercial', months };
        const { done } = run({ body: { fields: enc(snap).mapValue.fields } });
        await done;
        const heads = [...document.querySelectorAll('.rh-mhead span:first-child')].map(x => x.textContent);
        expect(heads).toEqual(['Oct 2026', 'Oct 2026 · Flat 1A, Gupta Bhawan', 'Sep 2026 · Flat 1A, Gupta Bhawan']);
        const text = document.getElementById('rh').textContent;
        expect(text).not.toContain('Moved out');
        expect(text).toContain('Shop 7, Arora Market');
        expect(text).toContain('Receipt R-2026-0007');
        expect(text).toMatch(/Total due\s*₹5,064/);
        const hi = run({ lang: 'hi-IN', body: { fields: enc(snap).mapValue.fields } });
        await hi.done;
        expect(document.getElementById('rh').textContent).toContain('फ़्लैट 1A, Gupta Bhawan');
    });

    test('unit type word in the page language, never doubled', () => {
        const { placeLine } = window.RentHistory;
        expect(placeLine({ ut: 'flat', place: '2B, Gupta Bhawan' }, 'en')).toBe('Flat 2B, Gupta Bhawan');
        expect(placeLine({ ut: 'flat', place: '2B, Gupta Bhawan' }, 'hi')).toBe('फ़्लैट 2B, Gupta Bhawan');
        expect(placeLine({ ut: 'commercial', place: 'Shop 3, Gupta Bhawan' }, 'en')).toBe('Shop 3, Gupta Bhawan');
        expect(placeLine({ place: 'Gali 2 · G1' }, 'en')).toBe('Gali 2 · G1');
    });

    test('dev data and the emulator', () => {
        const { RentHistory } = window;
        const url = RentHistory.docUrl({ projectId: 'p', apiKey: 'k' }, TOKEN, new URLSearchParams('d=1&emulator=1'));
        expect(url).toBe(`http://127.0.0.1:8181/v1/projects/p/databases/(default)/documents/dev_rent_public/${TOKEN}`);
    });
});
