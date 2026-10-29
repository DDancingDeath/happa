// -------------------- NAVIGATION AND TAB MANAGEMENT --------------------

import { UIManager } from './ui-manager.js';
import { AppState } from '../utils/state.js';
import { canOpenTab, canOpenPage, canOpenSection, roleMayOpenTab, SECTION_TABS } from '../utils/role-access.js';
import { t } from '../i18n/index.js';
import { closeTopDialog } from '../utils/keyboard-shortcuts.js';

// Routes: every id that showTab() accepts besides plain page ids (the .tab element id).
//   tab     page element to show            section  sub-view handed to the page (see showTabFromNav)
//   needs   extra TAB_ROLES/TAB_PERMISSIONS id   id   canonical id kept in history (aliases / old ids)
//   nav     side-nav link to highlight (default: tab)
// To add a page's sub-routes, add one group below (one group per page)
// and open the section for that page in showTabFromNav.
const ROUTES = Object.freeze({
    // Rates page (the items list). Old id: items.
    rates: { tab: 'items', nav: 'rates' },
    items: { tab: 'items', nav: 'rates', id: 'rates' },

    // Old pages (redesign phase 5): Finance → Money, Reports → Statements, Analytics → Insights.
    finance: { tab: 'money', id: 'money' },
    reports: { tab: 'statements', id: 'statements' },
    analytics: { tab: 'insights', id: 'insights' },

    // Trends / Product traffic live in Insights › Seasons, owner/manager. Old ids from Rates and Reports.
    'reports-trends': { tab: 'insights', section: 'trends', needs: 'rate-trends', id: 'insights-trends' },
    'reports-traffic': { tab: 'insights', section: 'traffic', needs: 'rate-trends', id: 'insights-traffic' },
    'rate-trends': { tab: 'insights', section: 'trends', needs: 'rate-trends', id: 'insights-trends' },
    'rates-trends': { tab: 'insights', section: 'trends', needs: 'rate-trends', id: 'insights-trends' },
    'rates-traffic': { tab: 'insights', section: 'traffic', needs: 'rate-trends', id: 'insights-traffic' },

    // Wholesale › History (old History 'wholesale' links land here).
    'wholesale-history': { tab: 'wholesale-sales', section: 'history', nav: 'wholesale-sales' },

    // Settings sections (Common, Aadhat = internal 'shop', Rentals, Roles & access).
    // Old ids: settings-aadhat, admin-configure (Admin › Configure moved to Settings › Aadhat).
    'settings-common': { tab: 'settings', section: 'common' },
    'settings-shop': { tab: 'settings', section: 'shop' },
    'settings-aadhat': { tab: 'settings', section: 'shop', id: 'settings-shop' },
    'settings-rentals': { tab: 'settings', section: 'rentals' },
    'settings-roles': { tab: 'settings', section: 'roles' },
    'admin-configure': { tab: 'settings', section: 'shop', id: 'settings-shop' }
});

// Money / Insights / Statements (redesign): '<page>-<section>' opens a section, e.g. 'money-cash'.
const SECTION_PAGES = Object.freeze({
    money: ['profit', 'cash', 'spending', 'worth'],
    insights: ['actions', 'items', 'parties', 'seasons', 'trends', 'traffic'],
    statements: ['day', 'month', 'party', 'item', 'csv']
});

function sectionRoute(tabId) {
    const [page, ...rest] = String(tabId).split('-');
    const sections = SECTION_PAGES[page];
    if (!sections) return null;
    const section = rest.join('-');
    if (!section) return { id: page, tab: page, section: null, needs: null, nav: page };
    return sections.includes(section) ? { id: tabId, tab: page, section, needs: SECTION_TABS[`${page}:${section}`] || null, nav: page } : null;
}

/** Route id -> { id (canonical), tab (page element id), section, needs (extra page permission), nav (side-nav link id) }. */
function resolveRoute(tabId) {
    const s = sectionRoute(tabId);
    if (s) return s;
    const old = String(tabId).match(/^(finance|reports|analytics)-/);
    const r = ROUTES[tabId] || (old && ROUTES[old[1]]);
    if (!r) return { id: tabId, tab: tabId, section: null, needs: null, nav: tabId };
    return { id: r.id || tabId, tab: r.tab, section: r.section || null, needs: r.needs || null, nav: r.nav || r.tab };
}

/** 'page' when the page itself is refused, 'section' when only the route's extra permission is, else null. */
function refusal(route) {
    const raw = AppState.settings?.roleAccess;
    if (!canOpenPage(route.tab, AppState.userRole, raw)) return 'page';
    if (route.section && !canOpenSection(route.tab, route.section, AppState.userRole, raw)) return 'section';
    if (route.needs && !canOpenTab(route.needs, AppState.userRole, raw)) return 'section';
    return null;
}

/** The role's built-in level allows the page and the route's extra permission. */
function roleMayOpenRoute(route) {
    return roleMayOpenTab(route.tab, AppState.userRole) && (!route.needs || roleMayOpenTab(route.needs, AppState.userRole));
}

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
    setActiveNavLink(routeId) {
        const tabId = resolveRoute(routeId).nav;
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
    showTabFromNav(tabId, event, opts = {}) {
        if (event) {
            event.preventDefault();
        }
        const route = resolveRoute(tabId);
        if (refusal(route)) {
            UIManager.showToast(this.refusedMessage(tabId));
            this.showTabFromNav(this.refusedTabFallback(tabId), null, opts);
            return;
        }
        
        this.setActiveNavLink(tabId);
        
        // Close menu
        this.setMenuOpen(false);
        
        // Show tab (use tabId directly, not tabId + 'Tab')
        this.showTab(tabId, undefined, opts);
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
        
        // Rates page: render the items table
        if (route.tab === 'items' && window.app?.items) {
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
        
        // Wholesale page: Sales (entry) tab, or History for 'wholesale-history'
        if (route.tab === 'wholesale-sales' && window.app?.wholesaleSales) {
            const view = route.section || 'sales';
            this.resetFilterButtons('wholesale-sales');
            setTimeout(() => window.app.wholesaleSales.filterTab(view, { target: document.querySelector(`#wholesale-sales .filter-btn[data-view="${view}"]`) || document.querySelector('#wholesale-sales .filter-btn') }), 100);
        }
        
        // Render stock when Stock tab is shown
        if (tabId === 'stock' && window.app?.stock) {
            this.resetFilterButtons('stock');
            setTimeout(() => window.app.stock.filterTab('current'), 100);
        }
        
        // Money (redesign §5.2): its code loads on first open
        if (route.tab === 'money' && window.app?.money) {
            setTimeout(() => window.app.money.init(route.section), 100);
        }

        // Insights (redesign §5.3): its code loads on first open
        if (route.tab === 'insights' && window.app?.insights) {
            setTimeout(() => window.app.insights.init(route.section), 100);
        }

        // Statements (redesign §5.4): its code loads on first open
        if (route.tab === 'statements' && window.app?.statements) {
            setTimeout(() => window.app.statements.init(route.section), 100);
        }

        // Initialize Anomalies page (owner/manager, #187)
        if (tabId === 'anomalies' && window.app?.anomalies) {
            setTimeout(() => window.app.anomalies.init(), 100);
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
        
        // Load settings when Settings tab is shown (a settings-* route opens that section)
        if (route.tab === 'settings' && window.app?.settings) {
            setTimeout(() => window.app.settings.load(route.section), 100);
        }
        if (route.tab === 'settings' && window.app?.install) {
            window.app.install.refresh();
        }
        if (route.tab === 'settings' && window.app?.notifications) {
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

    // Owner/manager-only pages fall back to Today (Trends and Product traffic to Insights); pages switched off in Roles & access to Billing
    refusedTabFallback(tabId) {
        const route = resolveRoute(tabId);
        if (refusal(route) === 'section') return route.tab;
        return roleMayOpenRoute(route) ? 'billing' : 'day';
    },

    refusedMessage(tabId) {
        const route = resolveRoute(tabId);
        if (refusal(route) === 'section') return t('msg.roles.tab_role_only');
        return t(roleMayOpenRoute(route) ? 'msg.roles.page_not_allowed' : 'msg.roles.page_role_only');
    },

    // Show tab
    showTab(tabId, evt, opts = {}) {
        const route = resolveRoute(tabId);
        // Refused for this role (#84, F23), also for direct navigation
        if (refusal(route)) {
            UIManager.showToast(this.refusedMessage(tabId));
            const fallback = this.refusedTabFallback(tabId);
            if (tabId !== fallback) this.showTab(fallback, undefined, opts);
            return false;
        }
        this.recordTab(route.id, opts);
        const tabs = document.querySelectorAll('.tab');
        tabs.forEach(tab => tab.classList.remove('active'));
        
        const selectedTab = document.getElementById(route.tab);
        if (selectedTab) {
            selectedTab.classList.add('active');
        }
        
        if (evt) {
            const buttons = document.querySelectorAll('.tab-button');
            buttons.forEach(btn => btn.classList.remove('active'));
            evt.currentTarget.classList.add('active');
        }
        
        // Lets data listeners refresh views that changed while this tab was hidden
        window.dispatchEvent(new CustomEvent('aadhat:tabshown', { detail: { tabId: route.tab } }));
    },

    currentTab: null,

    // A page's own tab buttons (e.g. Reports › Overview) record the route so Back returns to it
    noteRoute(routeId) {
        this.recordTab(resolveRoute(routeId).id);
    },

    // One history entry per tab change, so the phone's back button returns to the previous tab
    recordTab(tabId, opts = {}) {
        const prev = this.currentTab;
        this.currentTab = tabId;
        if (opts.fromHistory || typeof history === 'undefined' || !history.replaceState) return;
        const state = { ...(history.state || {}), happaTab: tabId };
        if (!history.state || !history.state.happaTab) history.replaceState(state, '');
        else if (prev !== tabId) history.pushState(state, '');
    },

    // Closes the menu, the notifications panel or the top dialog; true when something was open
    closeOverlay() {
        if (this.isMenuOpen()) { this.setMenuOpen(false); return true; }
        const notif = document.getElementById('notifPanel');
        if (notif && !notif.hidden && window.app?.notifications?.close) {
            window.app.notifications.close();
            return true;
        }
        return closeTopDialog();
    },

    handlePopState(e) {
        if (this.closeOverlay()) {
            if (this.currentTab) history.pushState({ ...(history.state || {}), happaTab: this.currentTab }, '');
            return;
        }
        const tab = e?.state?.happaTab || HOME_TAB;
        if (tab === this.currentTab) return;
        this.showTabFromNav(tab, null, { fromHistory: true });
    },

    // Android back button (APK): close what is open, else go back a tab, and leave the app only from home
    handleBackButton(appPlugin) {
        if (this.closeOverlay()) return;
        if (this.currentTab && this.currentTab !== HOME_TAB) {
            if (history.state?.happaTab && history.length > 1) history.back();
            else this.showTabFromNav(HOME_TAB, null);
            return;
        }
        appPlugin?.exitApp?.();
    },

    initBackNavigation() {
        if (typeof window === 'undefined' || window.__happaBackNavBound) return;
        window.__happaBackNavBound = true;
        window.addEventListener('popstate', (e) => this.handlePopState(e));
        const appPlugin = window.Capacitor?.isNativePlatform?.() ? window.Capacitor?.Plugins?.App : null;
        if (appPlugin?.addListener) {
            appPlugin.addListener('backButton', () => this.handleBackButton(appPlugin));
        }
    }
};

const HOME_TAB = 'billing';

// Export NavigationManager
export { NavigationManager, resolveRoute };
