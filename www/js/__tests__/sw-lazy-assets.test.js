/**
 * Lazy Rentals files (LAZY_ASSETS: unit picker, tenant link actions, receipts):
 * check:sw covers them, and the service worker's install caches them (best effort)
 * with the precache, so they work offline right after a deploy; rentals.js tells a
 * file that didn't load apart from an error inside it.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, readLazyAssets, readStaticAssets } = require('../../../scripts/check-sw-assets.js');

const SW = path.join(__dirname, '..', '..', 'service-worker.js');

test('check:sw lists every lazy Rentals file in LAZY_ASSETS, on disk and not precached', () => {
    const lazy = readLazyAssets();
    expect(lazy).toEqual(expect.arrayContaining(['/js/rentals/rent-unit.js', '/js/rentals/rent-link.js',
        '/js/rentals/rent-receipt.js', '/js/rentals/rent-receipt-store.js', '/css/rent-receipt.css']));
    const { missingOnDisk, notListed, duplicates } = check();
    expect({ missingOnDisk, notListed, duplicates }).toEqual({ missingOnDisk: [], notListed: [], duplicates: [] });
    expect(readStaticAssets().filter(u => lazy.includes(u))).toEqual([]);
});

test('install caches the lazy files into the new cache too; one failing never blocks the update', async () => {
    const handlers = {};
    const added = [];
    const opened = [];
    const cache = {
        add: jest.fn(async (req) => {
            added.push(req.url);
            if (req.url === '/js/rentals/rent-unit.js') throw new Error('offline');
        })
    };
    const self = { addEventListener: (name, fn) => { handlers[name] = fn; }, skipWaiting: jest.fn(), clients: { claim: jest.fn() } };
    vm.runInNewContext(fs.readFileSync(SW, 'utf8'), {
        self, URL, Request: class { constructor(url, opts) { this.url = url; this.opts = opts; } },
        caches: { open: async (name) => { opened.push(name); return cache; }, keys: async () => [] },
        console: { log() {}, warn() {}, error() {} }
    });
    let done;
    handlers.install({ waitUntil: (p) => { done = p; } });
    await done;
    expect(added).toEqual(expect.arrayContaining([...readStaticAssets(), ...readLazyAssets()]));
    expect(new Set(opened).size).toBe(1);
    expect(self.skipWaiting).toHaveBeenCalled();
});

describe('rentals.js lazy files', () => {
    const load = (factory) => {
        jest.resetModules();
        jest.doMock('../rentals/rent-unit.js', factory);
        jest.doMock('../ui/ui-manager.js', () => ({ UIManager: { showToast: jest.fn(), showModal: jest.fn() } }));
        jest.doMock('../ui/business-switcher.js', () => ({ rentalsRole: () => 'member' }));
        const { RentalsModule } = require('../rentals/rentals.js');
        return { api: RentalsModule.api, toast: require('../ui/ui-manager.js').UIManager.showToast };
    };
    beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
    afterEach(() => jest.restoreAllMocks());

    test('an error inside the handler is not reported as a file that could not load', async () => {
        const { api, toast } = load(() => ({ toUnit: () => { throw new Error('boom'); } }));
        await api.addTenantToUnit('U1');
        expect(toast).toHaveBeenCalledWith('Not saved. Check the internet and try again.', 'error');
        expect(toast).not.toHaveBeenCalledWith(expect.stringMatching(/could not be loaded/), 'error');
    });

    test('a file that did not load says so', async () => {
        const { api, toast } = load(() => { throw new Error('network'); });
        await api.addTenantToUnit('U1');
        expect(toast).toHaveBeenCalledWith(expect.stringMatching(/could not be loaded/), 'error');
    });
});

test('a cached asset is served without a network request (#59)', async () => {
    const handlers = {};
    const cached = { ok: true, body: 'cached' };
    const fetchMock = jest.fn(async () => ({ ok: true, body: 'network', clone() { return this; } }));
    const self = { addEventListener: (name, fn) => { handlers[name] = fn; }, location: { origin: 'https://app.test' }, skipWaiting: jest.fn(), clients: { claim: jest.fn() } };
    vm.runInNewContext(fs.readFileSync(SW, 'utf8'), {
        self, URL, fetch: fetchMock, Response: class { constructor(b, o) { Object.assign(this, o); } },
        caches: { match: async (req) => (req.url.endsWith('/js/main.js') ? cached : undefined), open: async () => ({ put: jest.fn() }) },
        console: { log() {}, warn() {}, error() {} }
    });
    const serve = async (url) => {
        let response;
        const waits = [];
        handlers.fetch({ request: { url, method: 'GET', mode: 'cors', headers: { get: () => '' } }, respondWith: (p) => { response = p; }, waitUntil: (p) => waits.push(p) });
        await Promise.all(waits);
        return response;
    };
    expect(await serve('https://app.test/js/main.js')).toBe(cached);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await serve('https://app.test/js/other.js')).body).toBe('network');
    expect(fetchMock).toHaveBeenCalledTimes(1);
});
