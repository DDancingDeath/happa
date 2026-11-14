import { resolveShortcut, TAB_SHORTCUTS, findCloseControl } from '../utils/keyboard-shortcuts.js';

const key = (k, extra = {}) => ({ key: k, code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...extra });
const billing = { activeTab: 'billing', billingMode: 'purchase' };

describe('resolveShortcut', () => {
    test('Alt+digit switches to the matching side-nav tab, even while typing', () => {
        expect(resolveShortcut(key('1', { altKey: true, code: 'Digit1' }), { activeTab: 'history' })).toEqual({ type: 'tab', tabId: 'day' });
        expect(resolveShortcut(key('¡', { altKey: true, code: 'Digit6' }), { activeTab: 'billing', typing: true }))
            .toEqual({ type: 'tab', tabId: TAB_SHORTCUTS[5].tabId });
        expect(resolveShortcut(key('0', { altKey: true, code: 'Digit0' }), billing)).toBeNull();
    });

    test('Ctrl+S / Ctrl+P target the bill that is on screen', () => {
        expect(resolveShortcut(key('s', { ctrlKey: true }), billing)).toEqual({ type: 'click', selector: '#saveBillBtn' });
        expect(resolveShortcut(key('P', { metaKey: true }), { ...billing, billingMode: 'sale', typing: true }))
            .toEqual({ type: 'click', selector: '#printSaleBtn' });
        expect(resolveShortcut(key('s', { ctrlKey: true }), { activeTab: 'wholesale-sales', wholesaleEntryVisible: true }))
            .toEqual({ type: 'click', selector: '#saveWholesaleBtn' });
    });

    test('Ctrl+S / Ctrl+P fall through where there is no bill, behind a dialog, on key repeat or AltGr', () => {
        expect(resolveShortcut(key('p', { ctrlKey: true }), { activeTab: 'history' })).toBeNull();
        expect(resolveShortcut(key('s', { ctrlKey: true }), { activeTab: 'wholesale-sales', wholesaleEntryVisible: false })).toBeNull();
        expect(resolveShortcut(key('s', { ctrlKey: true }), { ...billing, modalOpen: true })).toBeNull();
        expect(resolveShortcut(key('s', { ctrlKey: true, repeat: true }), billing)).toBeNull();
        expect(resolveShortcut(key('s', { ctrlKey: true, altKey: true }), billing)).toBeNull();
    });

    test('plain keys are ignored while typing in a field', () => {
        expect(resolveShortcut(key('/'), { ...billing, typing: true })).toBeNull();
        expect(resolveShortcut(key('?'), { ...billing, typing: true })).toBeNull();
        expect(resolveShortcut(key('/'), { activeTab: 'history' })).toEqual({ type: 'focus-search' });
        expect(resolveShortcut(key('?', { shiftKey: true }), billing)).toEqual({ type: 'toggle-help' });
    });

    test('Escape closes help first, then an open dialog; nothing otherwise', () => {
        expect(resolveShortcut(key('Escape'), { ...billing, helpOpen: true, modalOpen: true })).toEqual({ type: 'close-help' });
        expect(resolveShortcut(key('Escape'), { ...billing, modalOpen: true, typing: true })).toEqual({ type: 'close-modal' });
        expect(resolveShortcut(key('Escape'), billing)).toBeNull();
    });

    test('nothing fires before login (no active tab)', () => {
        expect(resolveShortcut(key('1', { altKey: true, code: 'Digit1' }), { activeTab: null })).toBeNull();
    });
});

describe('Esc closes JS-built popups (#88)', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        delete window.__aadhatShortcutsInstalled;
    });

    test('findCloseControl finds Cancel buttons without a known class', () => {
        const root = document.createElement('div');
        root.innerHTML = '<button>Change Role</button><button>Cancel</button>';
        expect(findCloseControl(root).textContent).toBe('Cancel');
        root.innerHTML = '<button id="confirmDelete">Delete</button><button id="cancelDelete">x</button>';
        expect(findCloseControl(root).id).toBe('cancelDelete');
        root.innerHTML = '<button class="modal-close">✕</button><button>Cancel</button>';
        expect(findCloseControl(root).className).toBe('modal-close');
        root.innerHTML = '<button>Save</button>';
        expect(findCloseControl(root)).toBeNull();
    });

    test('Escape on desktop clicks Cancel in a full-screen popup appended to <body>', () => {
        jest.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}]);
        jest.spyOn(Element.prototype, 'getBoundingClientRect')
            .mockReturnValue({ width: window.innerWidth, height: window.innerHeight, top: 0, left: 0 });
        window.matchMedia = () => ({ matches: true });
        jest.isolateModules(() => { require('../utils/keyboard-shortcuts.js'); });

        document.body.innerHTML = '<div id="appContent"><div class="tab active" id="users"></div></div>';
        const popup = document.createElement('div');
        popup.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%;';
        popup.innerHTML = '<div><button>Cancel</button><button>Change Role</button></div>';
        const cancel = jest.fn(() => popup.remove());
        popup.querySelector('button').onclick = cancel;
        document.body.appendChild(popup);

        const evt = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        document.body.dispatchEvent(evt);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(evt.defaultPrevented).toBe(true);
        expect(popup.isConnected).toBe(false);
    });
});
describe('Esc closes dialogs in Hindi', () => {
    const fs = require('fs');
    const path = require('path');
    const { setLang, t } = require('../i18n/index.js');
    afterEach(() => {
        setLang('en');
        document.body.innerHTML = '';
        delete window.__aadhatShortcutsInstalled;
        jest.restoreAllMocks();
    });

    test('a Hindi Cancel ("रहने दें") is found by its text', () => {
        const root = document.createElement('div');
        root.innerHTML = '<button>बदलें</button><button>रहने दें</button>';
        expect(findCloseControl(root).textContent).toBe('रहने दें');
    });

    test('Escape closes the Item dialog in Hindi through its Cancel', () => {
        setLang('hi');
        jest.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}]);
        window.matchMedia = () => ({ matches: true });
        jest.isolateModules(() => { require('../utils/keyboard-shortcuts.js'); });
        const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'modals.html'), 'utf8');
        document.body.innerHTML = `<div id="appContent"><div class="tab active" id="items"></div></div>${html}`;
        const overlay = document.getElementById('itemEditOverlay');
        overlay.style.display = 'flex';
        const cancel = overlay.querySelector('[data-onclick="items.closeItemModal()"]');
        cancel.textContent = t('ui.modals.cancel');
        expect(cancel.textContent).toBe('रहने दें');
        expect(findCloseControl(overlay)).toBe(cancel);
        const closed = jest.fn();
        cancel.addEventListener('click', closed);
        const evt = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        document.body.dispatchEvent(evt);
        expect(closed).toHaveBeenCalledTimes(1);
    });

    test('Escape closes the Rentals form sheet through its Cancel', () => {
        jest.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}]);
        window.matchMedia = () => ({ matches: true });
        jest.isolateModules(() => { require('../utils/keyboard-shortcuts.js'); });
        const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'rentals.html'), 'utf8');
        document.body.innerHTML = `<div id="appContent">${html}</div>`;
        document.getElementById('rentals').classList.add('active');
        document.getElementById('rentDialog').hidden = false;
        const cancel = document.getElementById('rentDialogCancel');
        expect(findCloseControl(document.getElementById('rentDialog'))).toBe(cancel);
        const closed = jest.fn();
        cancel.addEventListener('click', closed);
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(closed).toHaveBeenCalledTimes(1);
    });
});
