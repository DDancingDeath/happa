import { NavigationManager } from '../ui/navigation.js';

describe('setActiveNavLink (#111)', () => {
    test('highlights only the link for the given tab (startup Billing)', () => {
        document.body.innerHTML = `
            <ul class="nav-menu">
                <li><a href="#" class="active" onclick="window.app.nav.showTab('day', event)">Day</a></li>
                <li><a href="#" onclick="window.app.nav.showTab('billing', event)">Billing</a></li>
            </ul>`;
        NavigationManager.setActiveNavLink('billing');
        const active = [...document.querySelectorAll('.nav-menu a.active')].map(a => a.textContent);
        expect(active).toEqual(['Billing']);
    });
});
describe('back button returns to the previous tab (F17)', () => {
    let AppState;
    beforeEach(async () => {
        ({ AppState } = await import('../utils/state.js'));
        AppState.userRole = 'owner';
        document.body.innerHTML = `
            <div class="side-nav" id="sideNav"><nav class="nav-menu">
                <a href="#" onclick="window.app.nav.showTab('billing', event)">Billing</a>
                <a href="#" onclick="window.app.nav.showTab('stock', event)">Stock</a>
                <a href="#" onclick="window.app.nav.showTab('history', event)">History</a>
            </nav></div>
            <div class="overlay" id="overlay"></div>
            <div class="tab" id="billing"></div><div class="tab" id="stock"></div><div class="tab" id="history"></div>`;
        NavigationManager.currentTab = null;
        history.replaceState(null, '');
    });

    const activeTab = () => document.querySelector('.tab.active')?.id;

    test('each tab change adds one history entry; the first one replaces', () => {
        const start = history.length;
        NavigationManager.showTab('billing');
        expect(history.state.happaTab).toBe('billing');
        expect(history.length).toBe(start);
        NavigationManager.showTabFromNav('stock');
        NavigationManager.showTabFromNav('stock');
        NavigationManager.showTabFromNav('history');
        expect(history.state.happaTab).toBe('history');
        expect(history.length).toBe(start + 2);
    });

    test('popstate shows the tab from the history entry without pushing a new one', () => {
        NavigationManager.showTab('billing');
        NavigationManager.showTabFromNav('stock');
        const len = history.length;
        NavigationManager.handlePopState({ state: { happaTab: 'billing' } });
        expect(activeTab()).toBe('billing');
        expect(NavigationManager.currentTab).toBe('billing');
        expect(history.length).toBe(len);
        expect(document.querySelector('.nav-menu a.active').textContent).toBe('Billing');
    });

    test('back with the menu open closes the menu and stays on the tab', () => {
        NavigationManager.showTab('billing');
        NavigationManager.showTabFromNav('stock');
        NavigationManager.openMenu();
        NavigationManager.handlePopState({ state: { happaTab: 'billing' } });
        expect(NavigationManager.isMenuOpen()).toBe(false);
        expect(activeTab()).toBe('stock');
        expect(history.state.happaTab).toBe('stock');
    });

    test('Android back button: goes back a tab, and exits only from the home tab', () => {
        const back = jest.spyOn(history, 'back').mockImplementation(() => {});
        const app = { exitApp: jest.fn() };
        NavigationManager.showTab('billing');
        NavigationManager.showTabFromNav('stock');
        NavigationManager.handleBackButton(app);
        expect(back).toHaveBeenCalledTimes(1);
        expect(app.exitApp).not.toHaveBeenCalled();

        NavigationManager.handlePopState({ state: { happaTab: 'billing' } });
        NavigationManager.handleBackButton(app);
        expect(app.exitApp).toHaveBeenCalledTimes(1);
        back.mockRestore();
    });

    test('Android back button with the menu open only closes the menu', () => {
        const app = { exitApp: jest.fn() };
        NavigationManager.showTab('billing');
        NavigationManager.openMenu();
        NavigationManager.handleBackButton(app);
        expect(NavigationManager.isMenuOpen()).toBe(false);
        expect(app.exitApp).not.toHaveBeenCalled();
    });

    test('registers the Capacitor App backButton listener in the APK', () => {
        const addListener = jest.fn();
        window.Capacitor = { isNativePlatform: () => true, Plugins: { App: { addListener } } };
        delete window.__happaBackNavBound;
        NavigationManager.initBackNavigation();
        expect(addListener).toHaveBeenCalledWith('backButton', expect.any(Function));
        delete window.Capacitor;
    });
});
