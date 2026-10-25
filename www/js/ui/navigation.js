// -------------------- NAVIGATION AND TAB MANAGEMENT --------------------

import { UIManager } from './ui-manager.js';
import { AppState } from '../utils/state.js';
import { canOpenTab } from '../utils/role-access.js';
import { t } from '../i18n/index.js';

const NavigationManager = {
    // Reset filter buttons to default state for a given tab
    resetFilterButtons(tabId) {
        const tabElement = document.getElementById(tabId);
        if (!tabElement) return;
        
        const buttons = tabElement.querySelectorAll('.filter-btn');
        buttons.forEach((btn, index) => {
            if (index === 0) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    },
    
    isMenuOpen() {
        const sideNav = document.querySelector('.side-nav');
        return !!sideNav && sideNav.classList.contains('active');
    },

    setMenuOpen(open) {
        const sideNav = document.querySelector('.side-nav');
        const overlay = document.querySelector('.overlay');
        if (sideNav) sideNav.classList.toggle('active', open);
        if (overlay) overlay.classList.toggle('active', open);
    },

    openMenu() {
        this.setMenuOpen(true);
        UIManager.hapticFeedback('light');
    },

    closeMenu() {
        if (!this.isMenuOpen()) return;
        this.setMenuOpen(false);
        UIManager.hapticFeedback('light');
    },

    // Toggle side navigation menu
    toggleMenu() {
        if (this.isMenuOpen()) this.closeMenu(); else this.openMenu();
    },

    // Close the drawer on overlay tap, Esc, or a left swipe on the drawer.
    // Safe to call more than once; listeners are only attached once.
    initMenuDismiss() {
        const overlay = document.querySelector('.overlay');
        if (overlay && !overlay.dataset.dismissBound) {
            overlay.dataset.dismissBound = '1';
            overlay.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.closeMenu();
            });
        }

        if (!document.__aadhatNavEscBound) {
            document.__aadhatNavEscBound = true;
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.isMenuOpen()) {
                    e.preventDefault();
                    this.closeMenu();
                }
            });
        }

        const sideNav = document.querySelector('.side-nav');
        if (sideNav && !sideNav.dataset.swipeBound) {
            sideNav.dataset.swipeBound = '1';
            let startX = null;
            let startY = null;
            sideNav.addEventListener('touchstart', (e) => {
                const t = e.touches && e.touches[0];
                startX = t ? t.clientX : null;
                startY = t ? t.clientY : null;
            }, { passive: true });
            sideNav.addEventListener('touchend', (e) => {
                const t = e.changedTouches && e.changedTouches[0];
                if (!t || startX === null) return;
                const dx = t.clientX - startX;
                const dy = t.clientY - startY;
                startX = null;
                if (dx < -60 && Math.abs(dx) > Math.abs(dy) * 1.5) this.closeMenu();
            }, { passive: true });
        }
    },

    // Highlight the side-nav link for tabId (also used on startup, which bypasses showTabFromNav)
    setActiveNavLink(tabId) {
        const links = document.querySelectorAll('.nav-menu a');
        links.forEach(link => {
            link.classList.remove('active');
            // Check if this link's onclick contains the tabId
            const onclick = link.getAttribute('onclick');
            if (onclick && onclick.includes(`'${tabId}'`)) {
                link.classList.add('active');
            }
        });
    },

    // Show tab from navigation
    showTabFromNav(tabId, event) {
        if (event) {
            event.preventDefault();
        }
        if (!canOpenTab(tabId, AppState.userRole, AppState.settings?.roleAccess)) {
            this.setMenuOpen(false);
            this.showTab(tabId);
            this.setActiveNavLink('billing');
            return;
        }
        
        this.setActiveNavLink(tabId);
        
        // Close menu
        this.setMenuOpen(false);
        
        // Show tab (use tabId directly, not tabId + 'Tab')
        this.showTab(tabId);
        UIManager.hapticFeedback('light');
        
        // Load users when Users tab is shown
        if (tabId === 'users' && window.app?.users) {
            setTimeout(() => window.app.users.load(), 100);
        }
        
        // Reset billing mode when Billing tab is shown
        if (tabId === 'billing' && window.app?.billing) {
            this.resetFilterButtons('billing');
            setTimeout(() => window.app.billing.switchMode('purchase', { currentTarget: document.getElementById('purchaseModeBtn') }), 100);
        }
        
        // Render items table when Items tab is shown
        if (tabId === 'items' && window.app?.items) {
            setTimeout(() => window.app.items.renderTable(), 100);
        }
        
        // Render history when History tab is shown (keeps the session's filter, #160)
        if (tabId === 'history' && window.app?.history) {
            setTimeout(() => window.app.history.refresh(), 100);
        }
        
        // Render outstanding when Due tab is shown
        if (tabId === 'due' && window.app?.outstanding) {
            this.resetFilterButtons('due');
            setTimeout(() => window.app.outstanding.filterDue('purchase', { target: document.querySelector('#due .filter-btn') }), 100);
        }
        
        // Render wholesale sales history when Wholesale Sales tab is shown
        if (tabId === 'wholesale-sales' && window.app?.wholesaleSales) {
            this.resetFilterButtons('wholesale-sales');
            setTimeout(() => window.app.wholesaleSales.filterTab('sales', { target: document.querySelector('#wholesale-sales .filter-btn') }), 100);
        }
        
        // Render stock when Stock tab is shown
        if (tabId === 'stock' && window.app?.stock) {
            this.resetFilterButtons('stock');
            setTimeout(() => window.app.stock.filterTab('current'), 100);
        }
        
        // Render reports when Reports tab is shown
        if (tabId === 'reports' && window.app?.reports) {
            this.resetFilterButtons('reports');
            setTimeout(() => window.app.reports.renderReportsIfStale(), 100);
        }
        
        // Initialize finance when Finance tab is shown
        if (tabId === 'finance' && window.app?.finance) {
            this.resetFilterButtons('finance');
            setTimeout(() => window.app.finance.init(), 100);
        }
        
        // Initialize analytics when Analytics tab is shown
        if (tabId === 'analytics' && window.app?.analytics) {
            this.resetFilterButtons('analytics');
            setTimeout(() => window.app.analytics.init(), 100);
        }
        
        // Initialize Anomalies page (owner/manager, #187)
        if (tabId === 'anomalies' && window.app?.anomalies) {
            setTimeout(() => window.app.anomalies.init(), 100);
        }
        
        // Initialize Rate trends page (owner/manager, #65)
        if (tabId === 'rate-trends' && window.app?.rateTrends) {
            setTimeout(() => window.app.rateTrends.init(), 100);
        }

        // Initialize App health page (owner/manager, #217)
        if (tabId === 'health' && window.app?.health) {
            setTimeout(() => window.app.health.init(), 100);
        }
        
        // Initialize Day page when Day tab is shown
        if (tabId === 'day' && window.app?.day) {
            this.resetFilterButtons('day');
            setTimeout(() => window.app.day.init(), 100);
        }
        
        // Initialize cash management when Cash Management tab is shown
        if (tabId === 'cash-management' && window.app?.cashManagement) {
            this.resetFilterButtons('cash-management');
            setTimeout(() => window.app.cashManagement.init(), 100);
        }
        
        // Load settings when Settings tab is shown
        if (tabId === 'settings' && window.app?.settings) {
            setTimeout(() => window.app.settings.load(), 100);
        }
        if (tabId === 'settings' && window.app?.install) {
            window.app.install.refresh();
        }
        if (tabId === 'settings' && window.app?.notifications) {
            window.app.notifications.refreshSettings();
        }
        
        // Initialize diagnostics when Diagnostics tab is shown (owner only)
        if (tabId === 'diagnostics' && window.app?.diagnostics) {
            setTimeout(() => window.app.diagnostics.init(), 100);
        }
        
        // Initialize admin when Admin tab is shown (owner only)
        if (tabId === 'admin' && window.app?.admin) {
            setTimeout(() => window.app.admin.init(), 100);
        }
    },

    // Show tab
    showTab(tabId, evt) {
        // Pages switched off for this role in Roles & access (#84), also for direct navigation
        if (!canOpenTab(tabId, AppState.userRole, AppState.settings?.roleAccess)) {
            UIManager.showToast(t('msg.roles.page_not_allowed'));
            if (tabId !== 'billing') this.showTab('billing');
            return false;
        }
        const tabs = document.querySelectorAll('.tab');
        tabs.forEach(tab => tab.classList.remove('active'));
        
        const selectedTab = document.getElementById(tabId);
        if (selectedTab) {
            selectedTab.classList.add('active');
        }
        
        if (evt) {
            const buttons = document.querySelectorAll('.tab-button');
            buttons.forEach(btn => btn.classList.remove('active'));
            evt.currentTarget.classList.add('active');
        }
        
        // Lets data listeners refresh views that changed while this tab was hidden
        window.dispatchEvent(new CustomEvent('aadhat:tabshown', { detail: { tabId } }));
    }
};

// Export NavigationManager
export { NavigationManager };
