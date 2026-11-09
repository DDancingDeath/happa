/**
 * Start-up weight (#59): the code a first screen doesn't need is imported on first use
 * (still precached, so it works offline), and only the app language's catalogue is
 * loaded at start; the other one is loaded on a switch.
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const { readStaticAssets } = require('../../../scripts/check-sw-assets.js');

const WWW = path.resolve(__dirname, '..', '..');
const rel = (p) => path.relative(WWW, p).split(path.sep).join('/');
const ON_DEMAND = ['js/i18n/en.js', 'js/i18n/hi.js', 'js/modules/admin.js', 'js/modules/diagnostics.js',
    'js/modules/anomalies.js', 'js/modules/health.js', 'js/services/receipt-drawing.js'];

/** Static import graph from the module scripts in index.html (dynamic import() not followed). */
function startupGraph() {
    const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
    const queue = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"?]+)/g)].map(m => path.join(WWW, m[1]));
    const seen = new Set();
    while (queue.length) {
        const file = queue.shift();
        if (seen.has(file)) continue;
        seen.add(file);
        walk.full(acorn.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' }), (node) => {
            const isStatic = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type);
            if (isStatic && node.source && node.source.value.startsWith('.')) {
                queue.push(path.resolve(path.dirname(file), node.source.value.split(/[?#]/)[0]));
            }
        });
    }
    return [...seen].map(rel);
}

describe('start-up imports (#59)', () => {
    test('admin, diagnostics, anomalies, App health, the receipt drawing and the catalogues are not imported at start', () => {
        const graph = startupGraph();
        expect(graph).toEqual(expect.arrayContaining(['js/main.js', 'js/i18n/index.js', 'js/i18n/lang-catalogues.js', 'js/services/printer.js']));
        expect(graph.filter(f => ON_DEMAND.includes(f))).toEqual([]);
    });

    test('they stay precached, so opening them works offline', () => {
        const precached = readStaticAssets();
        expect(ON_DEMAND.map(f => `/${f}`).filter(u => !precached.includes(u))).toEqual([]);
    });

    test('Workers / Salaries (#373) adds nothing to start-up: its code is imported when the page opens', () => {
        expect(startupGraph().filter(f => ['js/modules/workers.js', 'js/utils/worker-pay.js', 'js/firebase/repos/workers.js'].includes(f))).toEqual([]);
    });
});

describe('language catalogues load on demand (#59)', () => {
    let i18n;
    let imported;
    beforeEach(() => {
        jest.resetModules();
        localStorage.clear();
        imported = [];
        // The real lang-catalogues.js shape: nothing loaded up front
        jest.doMock('./__mocks__/lang-catalogues.js', () => ({
            PRELOADED: {},
            importCatalogue: (lang) => {
                imported.push(lang);
                return Promise.resolve({ default: lang === 'hi' ? { 'ui.x': 'हिंदी पाठ' } : { 'ui.x': 'English text' } });
            }
        }));
        i18n = require('../i18n/index.js');
    });
    afterEach(() => jest.dontMock('./__mocks__/lang-catalogues.js'));

    test('only the asked language is imported, once', async () => {
        localStorage.setItem(i18n.LANG_STORAGE_KEY, 'hi');
        expect(i18n.hasCatalogue('hi')).toBe(false);
        await Promise.all([i18n.loadCatalogue(i18n.getLang()), i18n.loadCatalogue('hi')]);
        expect(imported).toEqual(['hi']);
        expect(i18n.t('ui.x')).toBe('हिंदी पाठ');
        expect(i18n.hasCatalogue('en')).toBe(false);
    });

    test('switching to a language not loaded yet loads it first, then switches', async () => {
        await i18n.loadCatalogue('en');
        const changes = [];
        const onChange = (e) => changes.push(e.detail.lang);
        window.addEventListener(i18n.LANG_CHANGE_EVENT, onChange);
        document.body.innerHTML = '<span data-i18n="ui.x"></span>';
        const switching = i18n.setLang('hi');
        expect(i18n.getLang()).toBe('en');
        await expect(switching).resolves.toBe('hi');
        expect(imported).toEqual(['en', 'hi']);
        expect(document.querySelector('span').textContent).toBe('हिंदी पाठ');
        expect(changes).toEqual(['hi']);
        window.removeEventListener(i18n.LANG_CHANGE_EVENT, onChange);
    });

    test('a choice made while the other catalogue loads wins', async () => {
        await i18n.loadCatalogue('en');
        const toHindi = i18n.setLang('hi');
        expect(i18n.setLang('en')).toBe('en');
        await toHindi;
        expect(i18n.getLang()).toBe('en');
    });
});
