/**
 * @fileoverview Rates page: the Items page renamed "Rates", with the Rate trends
 * views (Trends, Product traffic) as owner/manager tabs. Old ids still work, the
 * back button covers the tabs, and opening Rates loads no rate-trends code or data.
 */
const fs = require('fs');
const path = require('path');
import { NavigationManager, resolveRoute } from '../ui/navigation.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import en from '../i18n/en.js';
import hi from '../i18n/hi.js';

const WWW = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(WWW, rel), 'utf8');
const SUBTABS = read('templates/rate-trends.html').match(/<div class="rt-tabs rates-subtabs"[\s\S]*?<\/div>/)[0];

let toast;
beforeEach(() => {
    jest.useFakeTimers();
    toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
    AppState.userRole = 'owner';
    AppState.settings = {};
    document.body.innerHTML = `
        <div class="side-nav"><nav class="nav-menu">
            <a href="#" onclick="window.app.nav.showTab('billing', event)">Billing</a>
            <a href="#" onclick="window.app.nav.showTab('rates', event)">Rates</a>
        </nav></div>
        <div class="overlay"></div>
        <div class="tab" id="billing"></div>
        <div class="tab" id="items">${SUBTABS}</div>
        <div class="tab" id="rate-trends">${SUBTABS}</div>`;
    window.app = { items: { renderTable: jest.fn() }, rateTrends: { open: jest.fn() } };
    NavigationManager.currentTab = null;
    history.replaceState(null, '');
});
afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete window.app;
});

const activeTab = () => document.querySelector('.tab.active')?.id;
const activeNav = () => document.querySelector('.nav-menu a.active')?.textContent;
const activeSub = () => [...document.querySelectorAll('.tab.active .rates-subtabs .active')].map(b => b.dataset.route);

describe('side navigation', () => {
    const nav = read('templates/navigation.html');

    test('shows "Rates" (रेट) and no separate Rate trends entry', () => {
        expect(nav).toContain(`showTab('rates', event)`);
        expect(nav).toContain('data-i18n="ui.nav.rates"');
        expect(nav).not.toMatch(/showTab\('(items|rate-trends)'/);
        expect(nav).not.toMatch(/Rate trends|ui\.nav\.rate_trends|ui\.nav\.items/);
        expect([en['ui.nav.rates'], hi['ui.nav.rates']]).toEqual(['Rates', 'रेट']);
        expect([en['ui.rates.tab_trends'], hi['ui.rates.tab_trends']]).toEqual(['📈 Trends', '📈 रुझान']);
    });
});

describe('routes', () => {
    test.each([
        ['rates', 'rates', 'items', null],
        ['items', 'rates', 'items', null],
        ['rates-trends', 'rates-trends', 'rate-trends', 'rates'],
        ['rate-trends', 'rates-trends', 'rate-trends', 'rates'],
        ['rates-traffic', 'rates-traffic', 'rate-trends', 'traffic'],
        ['billing', 'billing', 'billing', null]
    ])('%s -> %s', (id, canonical, tab, section) => {
        expect(resolveRoute(id)).toMatchObject({ id: canonical, tab, section });
    });

    test('old "items" id opens Rates › Rates and highlights the Rates link', () => {
        NavigationManager.showTabFromNav('items');
        jest.runAllTimers();
        expect(activeTab()).toBe('items');
        expect(activeNav()).toBe('Rates');
        expect(activeSub()).toEqual(['rates']);
        expect(history.state.happaTab).toBe('rates');
        expect(window.app.items.renderTable).toHaveBeenCalled();
    });

    test('old "rate-trends" id opens Rates › Trends', () => {
        NavigationManager.showTabFromNav('rate-trends');
        jest.runAllTimers();
        expect(activeTab()).toBe('rate-trends');
        expect(activeNav()).toBe('Rates');
        expect(activeSub()).toEqual(['rates-trends']);
        expect(window.app.rateTrends.open).toHaveBeenCalledWith('rates');
    });

    test('Product traffic opens the traffic section', () => {
        NavigationManager.showTabFromNav('rates-traffic');
        jest.runAllTimers();
        expect(activeTab()).toBe('rate-trends');
        expect(activeSub()).toEqual(['rates-traffic']);
        expect(window.app.rateTrends.open).toHaveBeenCalledWith('traffic');
    });
});

describe('roles', () => {
    test.each(['rates-trends', 'rate-trends', 'rates-traffic'])('a member opening %s is sent to Rates › Rates', (id) => {
        AppState.userRole = 'staff';
        NavigationManager.showTab(id);
        expect(activeTab()).toBe('items');
        expect(toast).toHaveBeenCalledWith(en['msg.roles.tab_role_only']);
        NavigationManager.showTabFromNav(id);
        jest.runAllTimers();
        expect(activeTab()).toBe('items');
        expect(window.app.rateTrends.open).not.toHaveBeenCalled();
    });

    test('a member still opens Rates › Rates', () => {
        AppState.userRole = 'staff';
        NavigationManager.showTabFromNav('rates');
        expect(activeTab()).toBe('items');
        expect(toast).not.toHaveBeenCalled();
    });

    test('a manager opens Trends', () => {
        AppState.userRole = 'manager';
        NavigationManager.showTabFromNav('rates-trends');
        expect(activeTab()).toBe('rate-trends');
    });
});

describe('back button covers the Rates tabs', () => {
    test('each tab change adds a history entry and back returns to the previous tab', () => {
        NavigationManager.showTab('billing');
        const start = history.length;
        NavigationManager.showTabFromNav('rates');
        NavigationManager.showTabFromNav('rates-trends');
        NavigationManager.showTabFromNav('rates-traffic');
        expect(history.length).toBe(start + 3);
        expect(history.state.happaTab).toBe('rates-traffic');

        window.app.rateTrends.open.mockClear();
        NavigationManager.handlePopState({ state: { happaTab: 'rates-trends' } });
        jest.runAllTimers();
        expect(activeSub()).toEqual(['rates-trends']);
        expect(window.app.rateTrends.open).toHaveBeenCalledWith('rates');

        NavigationManager.handlePopState({ state: { happaTab: 'rates' } });
        expect(activeTab()).toBe('items');
        expect(NavigationManager.currentTab).toBe('rates');
    });
});

describe('opening Rates loads no rate-trends code or data', () => {
    test('the Rates tab never calls into rate trends', () => {
        NavigationManager.showTabFromNav('rates');
        jest.runAllTimers();
        expect(window.app.rateTrends.open).not.toHaveBeenCalled();
    });

    test('rate-trends.js (the only rateStats reader) is not in the static import graph of main.js', () => {
        const seen = new Set();
        const visit = (file) => {
            if (seen.has(file)) return;
            seen.add(file);
            const src = fs.readFileSync(file, 'utf8');
            for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+['"](\.[^'"]+)['"]/gm)) {
                visit(path.resolve(path.dirname(file), m[1]));
            }
            for (const m of src.matchAll(/^\s*import\s+['"](\.[^'"]+)['"]/gm)) visit(path.resolve(path.dirname(file), m[1]));
        };
        visit(path.join(WWW, 'js', 'main.js'));
        expect(seen.has(path.join(WWW, 'js', 'ui', 'navigation.js'))).toBe(true);
        expect(seen.has(path.join(WWW, 'js', 'modules', 'rate-trends.js'))).toBe(false);
        expect(read('js/main.js')).toContain(`import('./modules/rate-trends.js')`);
        const readers = fs.readdirSync(path.join(WWW, 'js', 'modules'))
            .filter(f => /loadRateStats|loadServerRateStats/.test(read(`js/modules/${f}`)));
        expect(readers).toEqual(['rate-trends.js']);
    });
});
