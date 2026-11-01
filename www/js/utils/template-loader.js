// Template Loader Utility
// Loads HTML templates from separate .html files

/** Needed before sign-in: the login screen, the app shell (side menu, loading overlay, toast) and dialogs. */
export const SHELL_TEMPLATES = ['auth', 'navigation', 'modals'];

/** Page templates, in the order they are placed inside #appContent. */
export const PAGE_TEMPLATES = [
    'day',
    'billing',
    'items',
    'history',
    'due',
    'stock',
    'wholesale-sales',
    'expenses',
    'settings',
    'anomalies',
    'money',
    'insights',
    'rate-trends',
    'statements',
    'health',
    'cash-management',
    'ask',
    'diagnostics',
    'admin'
];

/**
 * Pages put in at start (#66): Billing (the first screen), Today and the Cash page
 * (Today › Cash shows its body). Every other page is fetched and put in the first
 * time it is opened (ensurePage); the service worker precaches them all, so that
 * also works offline.
 */
export const EAGER_PAGES = ['day', 'billing', 'cash-management'];

/** Pages put in on first visit; Trends (rate-trends) comes with Insights. */
const LAZY_PAGES = new Set(PAGE_TEMPLATES.filter(n => n !== 'rate-trends' && !EAGER_PAGES.includes(n)));
const pageLoads = new Map();

export class TemplateLoader {
    static async loadTemplate(templateName) {
        try {
            const response = await fetch(`templates/${templateName}.html`);
            if (!response.ok) {
                throw new Error(`Failed to load template: ${templateName}`);
            }
            return await response.text();
        } catch (error) {
            console.error(`Error loading template ${templateName}:`, error);
            return '';
        }
    }

    /** Fetches the named templates in parallel: { name: html }. */
    static async loadTemplates(names) {
        const results = {};
        await Promise.all(names.map(async (name) => {
            results[name] = await this.loadTemplate(name);
        }));
        return results;
    }

    static async loadAllTemplates() {
        return this.loadTemplates([...SHELL_TEMPLATES, ...PAGE_TEMPLATES]);
    }

    /** Login screen, #appContent with the side menu, and the dialogs. */
    static injectShell(templates) {
        document.body.insertAdjacentHTML('afterbegin', templates.auth || '');

        const appContent = document.createElement('div');
        appContent.id = 'appContent';
        appContent.className = 'hidden';
        document.body.appendChild(appContent);
        appContent.insertAdjacentHTML('beforeend', templates.navigation || '');

        document.body.insertAdjacentHTML('beforeend', templates.modals || '');
    }

    /** The given pages, after the side menu inside #appContent, in PAGE_TEMPLATES order (#66). */
    static injectPages(templates) {
        const appContent = document.getElementById('appContent');
        if (!appContent) return;
        PAGE_TEMPLATES.forEach(name => {
            if (name === 'rate-trends' || !(name in templates)) return;
            appContent.insertAdjacentHTML('beforeend', templates[name] || '');
            // Trends / Product traffic (#65): Insights › Seasons mounts this view
            if (name === 'insights' && templates['rate-trends']) appContent.querySelector('#insights')?.insertAdjacentHTML('beforeend', templates['rate-trends']);
        });
    }

    static injectTemplates(templates) {
        this.injectShell(templates);
        this.injectPages(templates);
    }

    /** True when `tab` is a page loaded on first visit that is not in the document yet. */
    static pageMissing(tab) {
        return LAZY_PAGES.has(tab) && typeof document !== 'undefined' && !document.getElementById(tab);
    }

    /**
     * Puts a page loaded on first visit into the document (once; concurrent calls
     * share one fetch). While it loads, <html data-page-loading> names it. After it
     * is in, onPageAdded(name, element) runs (translations, the page's first render).
     * @param {string} tab
     * @returns {Promise<boolean>} whether the page is in the document now
     */
    static ensurePage(tab) {
        if (!this.pageMissing(tab)) return Promise.resolve(true);
        if (pageLoads.has(tab)) return pageLoads.get(tab);
        const root = document.documentElement;
        root.dataset.pageLoading = tab;
        const run = this.loadTemplates(tab === 'insights' ? ['insights', 'rate-trends'] : [tab])
            .then(templates => {
                // Insights without its Trends view would never fetch Trends again: both or neither
                if (Object.values(templates).some(html => !html)) return false;
                this.injectPages(templates);
                const el = document.getElementById(tab);
                if (el) this.onPageAdded(tab, el);
                return !!el;
            })
            .catch(e => {
                console.error(`Page ${tab} not added:`, e);
                return !!document.getElementById(tab);
            })
            .finally(() => {
                pageLoads.delete(tab);
                if (root.dataset.pageLoading === tab) delete root.dataset.pageLoading;
            });
        pageLoads.set(tab, run);
        return run;
    }

    /** Set by main.js: runs once for each page put in on first visit. */
    static onPageAdded() {}
}
