/**
 * Template split (#66): the login screen, shell and dialogs go in first; the pages
 * follow in the same places and order as when everything was injected at once.
 */
import { TemplateLoader, SHELL_TEMPLATES, PAGE_TEMPLATES, EAGER_PAGES } from '../utils/template-loader.js';
import { NavigationManager } from '../ui/navigation.js';
import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';

const fake = (name) => (name === 'insights' ? '<div class="tab" id="insights"></div>' : `<div class="tpl" data-t="${name}"></div>`);
const all = Object.fromEntries([...SHELL_TEMPLATES, ...PAGE_TEMPLATES].map(n => [n, fake(n)]));

afterEach(() => { document.body.innerHTML = ''; });

test('shell first, then the pages inside #appContent after the side menu', () => {
    TemplateLoader.injectShell(all);
    const appContent = document.getElementById('appContent');
    expect(appContent.className).toBe('hidden');
    expect([...appContent.children].map(el => el.dataset.t)).toEqual(['navigation']);
    expect(document.body.firstElementChild.dataset.t).toBe('auth');
    expect(document.body.lastElementChild.dataset.t).toBe('modals');

    TemplateLoader.injectPages(all);
    const order = [...appContent.children].map(el => el.dataset.t || el.id);
    expect(order).toEqual(['navigation', ...PAGE_TEMPLATES.filter(n => n !== 'rate-trends')]);
    expect(document.querySelector('#insights [data-t="rate-trends"]')).not.toBeNull();
    expect(document.body.lastElementChild.dataset.t).toBe('modals');
});

test('loadTemplates fetches only the names asked for', async () => {
    global.fetch = jest.fn(async (url) => ({ ok: true, text: async () => url }));
    const got = await TemplateLoader.loadTemplates(SHELL_TEMPLATES);
    expect(Object.keys(got).sort()).toEqual([...SHELL_TEMPLATES].sort());
    expect(global.fetch).toHaveBeenCalledTimes(SHELL_TEMPLATES.length);
    delete global.fetch;
});

describe('pages on first visit (#66)', () => {
    let fetched;
    beforeEach(() => {
        fetched = [];
        global.fetch = jest.fn(async (url) => {
            const name = /templates\/([\w-]+)\.html/.exec(url)[1];
            fetched.push(name);
            return { ok: true, text: async () => `<div class="tab" id="${name}"><span data-i18n="ui.x">x</span></div>` };
        });
        TemplateLoader.injectShell(all);
        TemplateLoader.injectPages(Object.fromEntries(EAGER_PAGES.map(n => [n, `<div class="tab" id="${n}"></div>`])));
    });
    afterEach(() => { delete global.fetch; TemplateLoader.onPageAdded = () => {}; jest.restoreAllMocks(); });

    test('only Billing, Today and Cash go in at start; the rest are missing until opened', () => {
        expect(EAGER_PAGES).toEqual(['day', 'billing', 'cash-management']);
        expect(TemplateLoader.pageMissing('billing')).toBe(false);
        expect(TemplateLoader.pageMissing('history')).toBe(true);
        expect(TemplateLoader.pageMissing('rate-trends')).toBe(false);
        expect(TemplateLoader.pageMissing('rentals')).toBe(false);
    });

    test('ensurePage fetches a page once, marks it loading, then reports it added', async () => {
        const added = [];
        TemplateLoader.onPageAdded = (name, el) => added.push([name, el.id]);
        const a = TemplateLoader.ensurePage('history');
        const b = TemplateLoader.ensurePage('history');
        expect(document.documentElement.dataset.pageLoading).toBe('history');
        await Promise.all([a, b]);
        expect(fetched).toEqual(['history']);
        expect(added).toEqual([['history', 'history']]);
        expect(document.documentElement.dataset.pageLoading).toBeUndefined();
        await TemplateLoader.ensurePage('history');
        expect(fetched).toEqual(['history']);
    });

    test('Insights brings Trends along, inside it', async () => {
        await TemplateLoader.ensurePage('insights');
        expect(fetched.sort()).toEqual(['insights', 'rate-trends']);
        expect(document.querySelector('#insights #rate-trends')).not.toBeNull();
    });

    test('a page that could not be fetched is tried again on the next visit', async () => {
        global.fetch.mockImplementationOnce(async () => ({ ok: false }));
        jest.spyOn(console, 'error').mockImplementation(() => {});
        await TemplateLoader.ensurePage('stock');
        expect(TemplateLoader.pageMissing('stock')).toBe(true);
        await TemplateLoader.ensurePage('stock');
        expect(TemplateLoader.pageMissing('stock')).toBe(false);
    });

    test('showTab puts a missing page in first, then makes it the active tab', async () => {
        AppState.userRole = 'owner';
        AppState.currentUser = { uid: 'u1' };
        const shown = NavigationManager.showTab('history');
        expect(document.querySelector('.tab.active')).toBeNull();
        await shown;
        expect(document.getElementById('history').classList.contains('active')).toBe(true);
    });

    test('a page that loads late does not override a newer navigation', async () => {
        AppState.userRole = 'owner';
        AppState.currentUser = { uid: 'u1' };
        const late = NavigationManager.showTab('stock');
        NavigationManager.showTab('billing');
        await late;
        expect(document.getElementById('billing').classList.contains('active')).toBe(true);
        expect(document.getElementById('stock').classList.contains('active')).toBe(false);
    });

    test('a page that could not be fetched keeps the current page and says so', async () => {
        AppState.userRole = 'owner';
        AppState.currentUser = { uid: 'u1' };
        NavigationManager.showTab('billing');
        global.fetch.mockImplementation(async () => ({ ok: false }));
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        expect(await NavigationManager.showTab('due')).toBe(false);
        expect(document.getElementById('billing').classList.contains('active')).toBe(true);
        expect(toast).toHaveBeenCalledWith(expect.stringContaining('could not be opened'), 'error');
    });
});
