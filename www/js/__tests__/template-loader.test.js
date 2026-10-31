/**
 * Template split (#66): the login screen, shell and dialogs go in first; the pages
 * follow in the same places and order as when everything was injected at once.
 */
import { TemplateLoader, SHELL_TEMPLATES, PAGE_TEMPLATES } from '../utils/template-loader.js';

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
