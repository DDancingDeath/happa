/**
 * @fileoverview Redesign phase 5: Finance, Reports and Analytics are gone. Their ids
 * (and every old Trends / Product traffic id from Rates and Reports) open the new
 * pages, Trends and Product traffic live in Insights › Seasons for owner/manager,
 * and rate-trends code still loads only when one of them opens.
 */
const fs = require('fs');
const path = require('path');
import { NavigationManager, resolveRoute } from '../ui/navigation.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import en from '../i18n/en.js';

const WWW = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(WWW, rel), 'utf8');

// The real window.app from main.js, so a handler the pages call but main.js never registers fails here.
beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await import('../main.js');
});

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
            <a href="#" onclick="window.app.nav.showTab('money', event)">Money</a>
            <a href="#" onclick="window.app.nav.showTab('insights', event)">Insights</a>
            <a href="#" onclick="window.app.nav.showTab('statements', event)">Statements</a>
        </nav></div>
        <div class="overlay"></div>
        <div class="tab" id="billing"></div>
        <div class="tab" id="day"></div>
        <div class="tab" id="money"></div>
        <div class="tab" id="insights"></div>
        <div class="tab" id="statements"></div>`;
    ['money', 'insights', 'statements'].forEach(p => jest.spyOn(window.app[p], 'init').mockResolvedValue(undefined));
    jest.spyOn(window.app.rateTrends, 'open').mockResolvedValue(undefined);
    jest.spyOn(window.app.billing, 'switchMode').mockImplementation(() => {});
    jest.spyOn(window.app.day, 'init').mockImplementation(() => {});
    NavigationManager.currentTab = null;
    history.replaceState(null, '');
});
afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

const open = (id) => { NavigationManager.showTabFromNav(id); jest.runAllTimers(); };
const activeTab = () => document.querySelector('.tab.active')?.id;
const activeNav = () => document.querySelector('.nav-menu a.active')?.textContent;

describe('pages', () => {
    test('the side menu has Money, Insights and Statements, and no Finance, Reports or Analytics', () => {
        const nav = read('templates/navigation.html');
        ['money', 'insights', 'statements'].forEach(id => expect(nav).toContain(`showTab('${id}', event)" id="${id}NavLink">`));
        expect(nav).not.toMatch(/showTab\('(finance|reports|analytics)'/);
    });

    test('the old pages and their code are gone; the Trends block sits inside Insights', () => {
        ['js/modules/finance.js', 'js/modules/reports.js', 'js/modules/analytics.js',
            'templates/finance.html', 'templates/reports.html', 'templates/analytics.html']
            .forEach(f => expect(fs.existsSync(path.join(WWW, f))).toBe(false));
        const loader = read('js/utils/template-loader.js');
        expect(loader).not.toMatch(/'(finance|reports|analytics)'/);
        expect(loader).toMatch(/querySelector\('#insights'\)[^\n]*insertAdjacentHTML\('beforeend', templates\['rate-trends'\]\)/);
        expect(read('service-worker.js')).not.toMatch(/(modules|templates)\/(finance|reports|analytics)\./);
    });
});

describe('old routes redirect', () => {
    test.each([
        ['finance', 'money', 'money', null],
        ['finance-withdrawals', 'money', 'money', null],
        ['reports', 'statements', 'statements', null],
        ['reports-overview', 'statements', 'statements', null],
        ['analytics', 'insights', 'insights', null],
        ['reports-trends', 'insights-trends', 'insights', 'trends'],
        ['reports-traffic', 'insights-traffic', 'insights', 'traffic'],
        ['rate-trends', 'insights-trends', 'insights', 'trends'],
        ['rates-trends', 'insights-trends', 'insights', 'trends'],
        ['rates-traffic', 'insights-traffic', 'insights', 'traffic'],
        ['insights-seasons', 'insights-seasons', 'insights', 'seasons'],
        ['rates', 'rates', 'items', null],
        ['wholesale-history', 'wholesale-history', 'wholesale-sales', 'history']
    ])('%s -> %s', (id, canonical, tab, section) => {
        expect(resolveRoute(id)).toMatchObject({ id: canonical, tab, section });
    });

    test.each([['finance', 'money', 'Money'], ['reports', 'statements', 'Statements'], ['analytics', 'insights', 'Insights']])(
        '%s opens %s and keeps the new id in history', (id, page, label) => {
            open(id);
            expect(activeTab()).toBe(page);
            expect(activeNav()).toBe(label);
            expect(history.state.happaTab).toBe(page);
            expect(window.app[page].init).toHaveBeenCalled();
        });

    test.each([['reports-trends', 'trends'], ['rate-trends', 'trends'], ['rates-trends', 'trends'], ['reports-traffic', 'traffic'], ['rates-traffic', 'traffic']])(
        'old id %s opens Insights › Seasons (%s)', (id, section) => {
            open(id);
            expect(activeTab()).toBe('insights');
            expect(activeNav()).toBe('Insights');
            expect(history.state.happaTab).toBe(`insights-${section}`);
            expect(window.app.insights.init).toHaveBeenCalledWith(section);
        });

    test('back and forward between Insights sections', () => {
        open('billing');
        const start = history.length;
        open('insights');
        open('reports-trends');
        expect(history.length).toBe(start + 2);
        NavigationManager.handlePopState({ state: { happaTab: 'insights' } });
        jest.runAllTimers();
        expect(window.app.insights.init).toHaveBeenLastCalledWith(null);
        NavigationManager.handlePopState({ state: { happaTab: 'insights-trends' } });
        jest.runAllTimers();
        expect(window.app.insights.init).toHaveBeenLastCalledWith('trends');
    });
});

describe('roles', () => {
    test.each(['reports-trends', 'reports-traffic', 'rate-trends'])('a member with Insights on opening %s gets Insights without Seasons', (id) => {
        AppState.userRole = 'staff';
        AppState.settings = { roleAccess: { staff: { analytics: true } } };
        open(id);
        expect(activeTab()).toBe('insights');
        expect(toast).toHaveBeenCalledWith(en['msg.roles.tab_role_only']);
        expect(window.app.insights.init).not.toHaveBeenCalledWith('trends');
        expect(window.app.insights.init).not.toHaveBeenCalledWith('traffic');
    });

    test('a member without Insights opening an old Trends link goes to Today', () => {
        AppState.userRole = 'staff';
        open('rate-trends');
        expect(activeTab()).toBe('day');
        expect(toast).toHaveBeenCalledWith(en['msg.roles.page_role_only']);
    });

    test('a member opening the old Finance link without Money is refused', () => {
        AppState.userRole = 'staff';
        open('finance');
        expect(activeTab()).toBe('billing');
        expect(toast).toHaveBeenCalledWith(en['msg.roles.page_not_allowed']);
    });

    test('a manager opens Product traffic', () => {
        AppState.userRole = 'manager';
        open('reports-traffic');
        expect(window.app.insights.init).toHaveBeenCalledWith('traffic');
    });
});

describe('rate-trends code loads only when Trends / Product traffic open', () => {
    test('rate-trends.js (the only rateStats reader) is outside the static import graph of main.js', () => {
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
        expect(seen.has(path.join(WWW, 'js', 'modules', 'rate-trends.js'))).toBe(false);
        expect(read('js/main.js')).toContain(`import('./modules/rate-trends.js')`);
        const readers = fs.readdirSync(path.join(WWW, 'js', 'modules'))
            .filter(f => /loadRateStats|loadServerRateStats/.test(read(`js/modules/${f}`)));
        expect(readers).toEqual(['rate-trends.js']);
    });
});

describe('every window.app method that navigation calls is registered by main.js', () => {
    const CALL = /window\.app(?:\?\.|\.)([A-Za-z_]\w*)(?:\?\.|\.)([A-Za-z_]\w*)\s*(?:\?\.)?\(/g;
    const calls = (rel) => [...new Set([...read(rel).matchAll(CALL)].map(m => `${m[1]}.${m[2]}`))];

    test.each(['js/ui/navigation.js', 'js/modules/insights.js', 'templates/insights.html', 'templates/money.html', 'templates/statements.html', 'templates/rate-trends.html'])('%s', (rel) => {
        const used = calls(rel);
        expect(used.length).toBeGreaterThan(0);
        const missing = used.filter(k => { const [ns, fn] = k.split('.'); return typeof window.app[ns]?.[fn] !== 'function'; });
        expect(missing).toEqual([]);
    });

    test('the scan catches a missing method', () => {
        expect([...'window.app?.reports?.nope(1)'.matchAll(CALL)].map(m => m[2])).toEqual(['nope']);
    });
});