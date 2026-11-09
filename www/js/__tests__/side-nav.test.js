/**
 * @jest-environment jsdom
 */
import { NavigationManager, trapFocus } from '../ui/navigation.js';

function render() {
    document.body.innerHTML = `
        <div class="side-nav" id="sideNav">
            <div class="nav-header"><h2>Aadhat</h2><button class="close-btn" type="button">x</button></div>
            <nav class="nav-menu"><a href="#" id="link">Today</a></nav>
        </div>
        <div class="overlay" id="overlay"></div>
        <button id="underlying">Save</button>
        <button class="bottom-nav-item" data-tab="more" aria-expanded="false">More</button>`;
    NavigationManager.initMenuDismiss();
}

const isOpen = () => document.getElementById('sideNav').classList.contains('active');
const overlayActive = () => document.getElementById('overlay').classList.contains('active');

describe('side nav dismiss (#177)', () => {
    beforeEach(render);

    test('tapping the overlay closes the open menu', () => {
        NavigationManager.toggleMenu();
        expect(isOpen()).toBe(true);
        expect(overlayActive()).toBe(true);

        document.getElementById('overlay').click();
        expect(isOpen()).toBe(false);
        expect(overlayActive()).toBe(false);
    });

    test('still closes if initMenuDismiss is called twice (no double toggle)', () => {
        NavigationManager.initMenuDismiss();
        NavigationManager.openMenu();
        document.getElementById('overlay').click();
        expect(isOpen()).toBe(false);
    });

    test('overlay tap does not reach handlers on the page underneath', () => {
        const bodyClick = jest.fn();
        document.body.addEventListener('click', bodyClick);
        NavigationManager.openMenu();
        document.getElementById('overlay').click();
        expect(bodyClick).not.toHaveBeenCalled();
    });

    test('clicking inside the drawer keeps it open', () => {
        NavigationManager.openMenu();
        document.querySelector('.nav-header').click();
        expect(isOpen()).toBe(true);
    });

    test('Esc closes the open menu', () => {
        NavigationManager.openMenu();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(isOpen()).toBe(false);
    });

    test('choosing a menu item closes the menu', () => {
        NavigationManager.openMenu();
        NavigationManager.showTabFromNav('day');
        expect(isOpen()).toBe(false);
        expect(overlayActive()).toBe(false);
    });
});

describe('side menu as a bottom sheet (redesign 4.1)', () => {
    beforeEach(() => {
        render();
        jest.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}]);
    });
    afterEach(() => jest.restoreAllMocks());

    test('opening makes it a modal dialog and moves focus in; Esc closes it and gives focus back', () => {
        const more = document.querySelector('[data-tab="more"]');
        more.focus();
        NavigationManager.toggleMenu();
        const nav = document.getElementById('sideNav');
        expect(nav.getAttribute('role')).toBe('dialog');
        expect(nav.getAttribute('aria-modal')).toBe('true');
        expect(nav.getAttribute('aria-label')).toBe('Menu');
        expect(more.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(nav.querySelector('.close-btn'));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(nav.hasAttribute('role')).toBe(false);
        expect(more.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(more);
    });

    test('Tab and Shift+Tab wrap inside the open sheet', () => {
        NavigationManager.openMenu();
        const close = document.querySelector('#sideNav .close-btn');
        const link = document.getElementById('link');
        link.focus();
        const tab = (shiftKey) => {
            const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
            document.dispatchEvent(e);
            return e.defaultPrevented;
        };
        expect(tab(false)).toBe(true);
        expect(document.activeElement).toBe(close);
        expect(tab(true)).toBe(true);
        expect(document.activeElement).toBe(link);
    });

    test('when the opener is hidden while the sheet is open (business switch), focus goes to the opener showing now, else the title', () => {
        document.body.insertAdjacentHTML('beforeend', '<header class="app-bar"><button class="hamburger">Menu</button><h1 id="appBarTitle" tabindex="-1">Rentals</h1></header>');
        const more = document.querySelector('[data-tab="more"]');
        const menu = document.querySelector('.app-bar .hamburger');
        const shownEls = new Set([document.querySelector('#sideNav .close-btn'), more]);
        Element.prototype.getClientRects.mockImplementation(function () { return shownEls.has(this) ? [{}] : []; });
        more.focus();
        NavigationManager.openMenu();
        shownEls.delete(more);
        shownEls.add(menu);
        NavigationManager.setMenuOpen(false);
        expect(document.activeElement).toBe(menu);

        shownEls.delete(menu);
        shownEls.add(more);
        more.focus();
        NavigationManager.openMenu();
        shownEls.delete(more);
        NavigationManager.setMenuOpen(false);
        expect(document.activeElement).toBe(document.getElementById('appBarTitle'));
    });

    test('trapFocus leaves Tab alone between the first and last control', () => {
        document.getElementById('sideNav').insertAdjacentHTML('beforeend', '<button id="last">x</button>');
        document.getElementById('link').focus();
        const e = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
        trapFocus(e, document.getElementById('sideNav'));
        expect(e.defaultPrevented).toBe(false);
    });
});
