/**
 * Home-screen shortcuts of the installed web app (#151): which page each
 * `?shortcut=` key opens, and the launch URL without it.
 */
import { SHORTCUTS, shortcutFromSearch, withoutShortcut } from '../utils/launch-shortcut.js';

describe('shortcutFromSearch', () => {
    test('known keys open their page and bill mode', () => {
        expect(shortcutFromSearch('?source=pwa&shortcut=sale')).toEqual({ tab: 'billing', mode: 'sale' });
        expect(shortcutFromSearch('?shortcut=purchase')).toEqual({ tab: 'billing', mode: 'purchase' });
        expect(shortcutFromSearch('?shortcut=history')).toEqual({ tab: 'history' });
    });

    test('no key, an unknown key or an inherited name opens nothing', () => {
        expect(shortcutFromSearch('')).toBeNull();
        expect(shortcutFromSearch('?source=pwa')).toBeNull();
        expect(shortcutFromSearch('?shortcut=admin')).toBeNull();
        expect(shortcutFromSearch('?shortcut=toString')).toBeNull();
    });

    test('the result is a copy', () => {
        shortcutFromSearch('?shortcut=sale').tab = 'admin';
        expect(SHORTCUTS.sale.tab).toBe('billing');
    });
});

describe('withoutShortcut', () => {
    test('drops only the shortcut', () => {
        expect(withoutShortcut('/', '?source=pwa&shortcut=sale', '#x')).toBe('/?source=pwa#x');
        expect(withoutShortcut('/', '?shortcut=history')).toBe('/');
    });
});
