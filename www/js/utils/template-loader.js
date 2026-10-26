// Template Loader Utility
// Loads HTML templates from separate .html files

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

    static async loadAllTemplates() {
        const templates = [
            'auth',
            'navigation',
            'modals',
            'items',
            'billing',
            'history',
            'due',
            'stock',
            'wholesale-sales',
            'expenses',
            'reports',
            'settings',
            'finance',
            'analytics',
            'anomalies',
            'rate-trends',
            'health',
            'day',
            'cash-management',
            'users',
            'chat',
            'diagnostics',
            'admin'
        ];

        const results = {};
        
        // Load all templates in parallel
        await Promise.all(
            templates.map(async (name) => {
                results[name] = await this.loadTemplate(name);
            })
        );

        return results;
    }

    static injectTemplates(templates) {
        // Inject auth screen first
        document.body.insertAdjacentHTML('afterbegin', templates.auth);
        
        // Create app content wrapper
        const appContent = document.createElement('div');
        appContent.id = 'appContent';
        appContent.className = 'hidden';
        document.body.appendChild(appContent);
        
        // Inject each template individually using insertAdjacentHTML to ensure proper DOM parsing
        appContent.insertAdjacentHTML('beforeend', templates.navigation);
        appContent.insertAdjacentHTML('beforeend', templates.day);
        appContent.insertAdjacentHTML('beforeend', templates.billing);
        appContent.insertAdjacentHTML('beforeend', templates.items);
        appContent.insertAdjacentHTML('beforeend', templates.history);
        appContent.insertAdjacentHTML('beforeend', templates.due);
        appContent.insertAdjacentHTML('beforeend', templates.stock);
        appContent.insertAdjacentHTML('beforeend', templates['wholesale-sales']);
        appContent.insertAdjacentHTML('beforeend', templates.expenses);
        
        appContent.insertAdjacentHTML('beforeend', templates.reports);
        appContent.insertAdjacentHTML('beforeend', templates.settings);
        appContent.insertAdjacentHTML('beforeend', templates.finance);
        appContent.insertAdjacentHTML('beforeend', templates.analytics);
        appContent.insertAdjacentHTML('beforeend', templates.anomalies);
        // Reports › Trends / Product traffic (#65) live inside the Reports page
        (appContent.querySelector('#reports') || appContent).insertAdjacentHTML('beforeend', templates['rate-trends']);
        appContent.insertAdjacentHTML('beforeend', templates.health);
        appContent.insertAdjacentHTML('beforeend', templates['cash-management']);
        appContent.insertAdjacentHTML('beforeend', templates.users);
        appContent.insertAdjacentHTML('beforeend', templates.chat);
        appContent.insertAdjacentHTML('beforeend', templates.diagnostics);
        appContent.insertAdjacentHTML('beforeend', templates.admin);
        
        // Inject modals at the end
        document.body.insertAdjacentHTML('beforeend', templates.modals);
    }
}
