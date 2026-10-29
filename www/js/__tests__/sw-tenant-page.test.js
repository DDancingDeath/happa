/**
 * The app's service worker leaves the tenant page alone (third review of #24):
 * /r.html and /r/<token> go straight to the network, never to the app cache or
 * the app's index.html fallback.
 */
const fs = require('fs');
const path = require('path');

function loadSw() {
    const handlers = {};
    const self = { addEventListener: (type, fn) => { handlers[type] = fn; }, location: { origin: 'https://myhappa.web.app' }, skipWaiting: () => {}, clients: { claim: () => {} } };
    const caches = { match: jest.fn(async () => undefined), open: jest.fn(async () => ({ put: jest.fn(), add: jest.fn() })), keys: jest.fn(async () => []) };
    const fetchFn = jest.fn(async () => ({ ok: true, clone: () => ({}) }));
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'service-worker.js'), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function('self', 'caches', 'fetch', src)(self, caches, fetchFn);
    return { fetchHandler: handlers.fetch, caches, fetchFn };
}

const event = (url, mode = 'navigate') => ({
    request: { url, method: 'GET', mode, headers: { get: () => 'text/html' } },
    respondWith: jest.fn(),
    waitUntil: jest.fn()
});

test.each([
    'https://myhappa.web.app/r/AbCdEfGhIjKlMnOpQrStUvWx',
    'https://myhappa.web.app/r/AbCdEfGhIjKlMnOpQrStUvWx?d=1',
    'https://myhappa.web.app/r.html',
    'https://myhappa.web.app/r/rent-history.js'
])('%s is not handled by the app service worker', (url) => {
    const { fetchHandler, caches } = loadSw();
    const e = event(url, url.endsWith('.js') ? 'no-cors' : 'navigate');
    fetchHandler(e);
    expect(e.respondWith).not.toHaveBeenCalled();
    expect(caches.match).not.toHaveBeenCalled();
});

test('app pages are still handled (control)', () => {
    const { fetchHandler } = loadSw();
    const e = event('https://myhappa.web.app/');
    fetchHandler(e);
    expect(e.respondWith).toHaveBeenCalled();
    const r = event('https://myhappa.web.app/rentals-not-a-tenant-path', 'navigate');
    fetchHandler(r);
    expect(r.respondWith).toHaveBeenCalled();
});

// Rent receipt files are not precached (precache budget): the first use caches them, then they work offline.
test('the lazy receipt module is cached on first use and served offline after', async () => {
    const handlers = {};
    const store = new Map();
    const self = { addEventListener: (type, fn) => { handlers[type] = fn; }, location: { origin: 'https://myhappa.web.app' }, skipWaiting: () => {}, clients: { claim: () => {} } };
    const caches = {
        match: jest.fn(async (req) => store.get(req.url || req)),
        open: jest.fn(async () => ({ put: async (req, res) => { store.set(req.url, res); }, add: async (req) => { store.set(req.url, 'precached'); } })),
        keys: jest.fn(async () => [])
    };
    let online = true;
    const body = { ok: true, clone() { return this; } };
    const fetchFn = jest.fn(async () => { if (!online) throw new TypeError('offline'); return body; });
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'service-worker.js'), 'utf8');
    function Request(u) { this.url = u; }
    new Function('self', 'caches', 'fetch', 'Request', src)(self, caches, fetchFn, Request);
    const pending = [];
    await handlers.install({ waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    const url = 'https://myhappa.web.app/js/rentals/rent-receipt.js';
    expect(store.has(url)).toBe(false);
    expect(store.has('/js/rentals/rentals.js')).toBe(true);
    const get = async () => {
        let res;
        handlers.fetch({ request: { url, method: 'GET', mode: 'cors', headers: { get: () => '' } }, respondWith: (r) => { res = r; }, waitUntil: () => {} });
        const out = await res;
        await new Promise(r => setTimeout(r, 0));
        return out;
    };
    expect(await get()).toBe(body);
    expect(store.get(url)).toBe(body);
    online = false;
    expect(await get()).toBe(body);
});
