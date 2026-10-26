/**
 * @fileoverview Trends and Product traffic live on the Reports page (owner/manager), not on Rates.
 * Old ids still open them, the back button covers them, and neither Rates nor the Reports bills
 * views load rate-trends code or read rateStats until one of those two tabs is opened.
 */
const fs = require('fs');
const path = require('path');
import { NavigationManager, resolveRoute } from '../ui/navigation.js';
import { ReportsManager } from '../modules/reports.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import en from '../i18n/en.js';
import hi from '../i18n/hi.js';

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
    jest.spyOn(ReportsManager, 'renderReports').mockImplementation(() => {});
    jest.spyOn(ReportsManager, 'renderReportsIfStale').mockImplementation(() => {});
    AppState.userRole = 'owner';
    AppState.settings = {};
    ReportsManager.currentTab = 'overview';
    ReportsManager.rtView = null;
    document.body.innerHTML = `
        <div class="side-nav"><nav class="nav-menu">
            <a href="#" onclick="window.app.nav.showTab('billing', event)">Billing</a>
            <a href="#" onclick="window.app.nav.showTab('rates', event)">Rates</a>
            <a href="#" onclick="window.app.nav.showTab('reports', event)">Reports</a>
        </nav></div>
        <div class="overlay"></div>
        <div class="tab" id="billing"></div>
        <div class="tab" id="day"></div>
        ${read('templates/items.html')}
        ${read('templates/reports.html')}`;
    document.getElementById('reports').insertAdjacentHTML('beforeend', read('templates/rate-trends.html'));
    jest.spyOn(window.app.items, 'renderTable').mockImplementation(() => {});
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
const activeReportsBtn = () => [...document.querySelectorAll('#reports .reports-tab-btn.active')].map(b => b.dataset.view);
const shown = (id) => document.getElementById(id).style.display !== 'none';

describe('pages', () => {
    test('Rates has only the item list (no Trends / Product traffic tab bar)', () => {
        const items = read('templates/items.html');
        expect(items).not.toMatch(/rates-subtabs|rates-trends|rates-traffic|rateTrends/);
        expect(items).toContain('window.app.items.exportExcel()');
        expect(items).toContain('window.app.items.openAddModal()');
        const nav = read('templates/navigation.html');
        expect(nav).toContain(`showTab('rates', event)`);
        expect(nav).not.toMatch(/showTab\('(items|rate-trends)'|Rate trends/);
    });

    test('Reports tab bar has Trends and Product traffic, hidden until roles allow them', () => {
        const btns = [...document.querySelectorAll('#reports .reports-rt-btn')];
        expect(btns.map(b => b.dataset.view)).toEqual(['trends', 'traffic']);
        expect(btns.every(b => b.style.display === 'none')).toBe(true);
        expect(document.querySelector('#reports #rate-trends')).not.toBeNull();
        expect([en['ui.reports.tab_trends'], hi['ui.reports.tab_trends']]).toEqual(['Trends', 'रुझान']);
        expect([en['ui.reports.tab_traffic'], hi['ui.reports.tab_traffic']]).toEqual(['Product traffic', 'माल की आवाजाही']);
    });

    test('template loader puts the Trends block inside the Reports page', () => {
        expect(read('js/utils/template-loader.js'))
            .toMatch(/querySelector\('#reports'\)[^\n]*insertAdjacentHTML\('beforeend', templates\['rate-trends'\]\)/);
    });
});

describe('routes and deep links', () => {
    test.each([
        ['rates', 'rates', 'items', null],
        ['items', 'rates', 'items', null],
        ['reports', 'reports', 'reports', null],
        ['reports-trends', 'reports-trends', 'reports', 'trends'],
        ['reports-traffic', 'reports-traffic', 'reports', 'traffic'],
        ['rate-trends', 'reports-trends', 'reports', 'trends'],
        ['rates-trends', 'reports-trends', 'reports', 'trends'],
        ['rates-traffic', 'reports-traffic', 'reports', 'traffic'],
        ['wholesale-history', 'wholesale-history', 'wholesale-sales', 'history']
    ])('%s -> %s', (id, canonical, tab, section) => {
        expect(resolveRoute(id)).toMatchObject({ id: canonical, tab, section });
    });

    test('items opens the Rates page', () => {
        open('items');
        expect(activeTab()).toBe('items');
        expect(activeNav()).toBe('Rates');
        expect(history.state.happaTab).toBe('rates');
        expect(window.app.items.renderTable).toHaveBeenCalled();
    });

    test.each([['rate-trends', 'trends', 'rates'], ['rates-trends', 'trends', 'rates'], ['rates-traffic', 'traffic', 'traffic']])(
        'old id %s opens Reports › %s', (id, view, section) => {
            open(id);
            expect(activeTab()).toBe('reports');
            expect(activeNav()).toBe('Reports');
            expect(activeReportsBtn()).toEqual([view]);
            expect(shown('rate-trends')).toBe(true);
            expect(shown('reportsOverviewTab')).toBe(false);
            expect(document.querySelector('#reports .reports-date-filter').style.display).toBe('none');
            expect(window.app.rateTrends.open).toHaveBeenCalledWith(section);
        });

    test('back from Trends to Overview and forward again', () => {
        open('billing');
        const start = history.length;
        open('reports');
        open('reports-trends');
        open('reports-traffic');
        expect(history.length).toBe(start + 3);

        NavigationManager.handlePopState({ state: { happaTab: 'reports-trends' } });
        jest.runAllTimers();
        expect(activeReportsBtn()).toEqual(['trends']);

        NavigationManager.handlePopState({ state: { happaTab: 'reports' } });
        jest.runAllTimers();
        expect(activeReportsBtn()).toEqual(['overview']);
        expect(shown('rate-trends')).toBe(false);
        expect(shown('reportsOverviewTab')).toBe(true);
        expect(NavigationManager.currentTab).toBe('reports');
    });

    test('main.js registers what the Reports page and navigation call', () => {
        expect(typeof window.app.reports.showView).toBe('function');
        expect(typeof window.app.nav.noteRoute).toBe('function');
        const note = jest.spyOn(NavigationManager, 'noteRoute');
        window.app.nav.noteRoute('reports');
        expect(note).toHaveBeenCalledWith('reports');
    });

    test('a Reports bills button after Trends records a history entry', () => {
        open('reports-trends');
        const len = history.length;
        document.querySelector('#reports .reports-tab-btn[data-view="sales"]').click();
        expect(history.state.happaTab).toBe('reports');
        expect(history.length).toBe(len + 1);
        expect(activeReportsBtn()).toEqual(['sales']);
        expect(shown('rate-trends')).toBe(false);
        expect(ReportsManager.rtView).toBeNull();
    });
});

describe('roles', () => {
    test.each(['reports-trends', 'reports-traffic', 'rate-trends'])('a member with Reports on opening %s gets Reports', (id) => {
        AppState.userRole = 'staff';
        AppState.settings = { roleAccess: { staff: { reports: true } } };
        open(id);
        expect(activeTab()).toBe('reports');
        expect(toast).toHaveBeenCalledWith(en['msg.roles.tab_role_only']);
        expect(shown('rate-trends')).toBe(false);
        expect(window.app.rateTrends.open).not.toHaveBeenCalled();
    });

    test('a member without Reports opening an old Trends link goes to Today', () => {
        AppState.userRole = 'staff';
        open('rate-trends');
        expect(activeTab()).toBe('day');
        expect(toast).toHaveBeenCalledWith(en['msg.roles.page_role_only']);
        expect(window.app.rateTrends.open).not.toHaveBeenCalled();
    });

    test('a manager opens Product traffic', () => {
        AppState.userRole = 'manager';
        open('reports-traffic');
        expect(window.app.rateTrends.open).toHaveBeenCalledWith('traffic');
    });
});

describe('no rate-trends code or rateStats reads until Trends / Product traffic open', () => {
    test('opening Rates and the Reports bills views never calls rate trends', () => {
        open('rates');
        open('reports');
        document.querySelector('#reports .reports-tab-btn[data-view="compare"]').click();
        expect(window.app.rateTrends.open).not.toHaveBeenCalled();
    });

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
        expect(seen.has(path.join(WWW, 'js', 'modules', 'reports.js'))).toBe(true);
        expect(seen.has(path.join(WWW, 'js', 'modules', 'rate-trends.js'))).toBe(false);
        expect(read('js/main.js')).toContain(`import('./modules/rate-trends.js')`);
        const readers = fs.readdirSync(path.join(WWW, 'js', 'modules'))
            .filter(f => /loadRateStats|loadServerRateStats/.test(read(`js/modules/${f}`)));
        expect(readers).toEqual(['rate-trends.js']);
    });
});

describe('every window.app method that navigation and Reports call is registered by main.js', () => {
    const CALL = /window\.app(?:\?\.|\.)([A-Za-z_]\w*)(?:\?\.|\.)([A-Za-z_]\w*)\s*(?:\?\.)?\(/g;
    const calls = (rel) => [...new Set([...read(rel).matchAll(CALL)].map(m => `${m[1]}.${m[2]}`))];

    test.each(['js/ui/navigation.js', 'js/modules/reports.js'])('%s', (rel) => {
        const used = calls(rel);
        expect(used.length).toBeGreaterThan(0);
        const missing = used.filter(k => { const [ns, fn] = k.split('.'); return typeof window.app[ns]?.[fn] !== 'function'; });
        expect(missing).toEqual([]);
    });

    test('the scan catches a missing method', () => {
        expect([...'window.app?.reports?.nope(1)'.matchAll(CALL)].map(m => m[2])).toEqual(['nope']);
    });
});
