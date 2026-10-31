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
    'users',
    'chat',
    'diagnostics',
    'admin'
];

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

    /** Pages, after the side menu inside #appContent (same order as before the split, #66). */
    static injectPages(templates) {
        const appContent = document.getElementById('appContent');
        if (!appContent) return;
        PAGE_TEMPLATES.forEach(name => {
            if (name === 'rate-trends') return;
            appContent.insertAdjacentHTML('beforeend', templates[name] || '');
            // Trends / Product traffic (#65): Insights › Seasons mounts this view
            if (name === 'insights') (appContent.querySelector('#insights') || appContent).insertAdjacentHTML('beforeend', templates['rate-trends']);
        });
    }

    static injectTemplates(templates) {
        this.injectShell(templates);
        this.injectPages(templates);
    }
}
