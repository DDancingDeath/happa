/**
 * @fileoverview The language choice lives in Settings (for every role) and as
 * "English | हिंदी" links on the login card; the side menu has no toggle.
 */
import fs from 'fs';
import path from 'path';
import { AuthManager } from '../auth/authentication.js';
import { SettingsManager } from '../modules/settings.js';
import { RolesAccessManager } from '../modules/roles-access.js';
import { AppState } from '../utils/state.js';
import { setLang, getLang, applyTranslations, resetLangForTests, LANG_STORAGE_KEY } from '../i18n/index.js';
import en from '../i18n/en.js';
import hi from '../i18n/hi.js';

const template = (name) => fs.readFileSync(path.join(__dirname, '../../templates', `${name}.html`), 'utf8');

beforeEach(() => {
    localStorage.clear();
    resetLangForTests();
    window.app = { i18n: { setLang: (lang) => setLang(lang), getLang: () => getLang() } };
});
afterEach(() => {
    localStorage.clear();
    resetLangForTests();
    document.body.innerHTML = '';
    delete window.app;
});

describe('side menu', () => {
    it('has no language toggle', () => {
        document.body.innerHTML = template('navigation');
        applyTranslations(document);
        const header = document.querySelector('#sideNav .nav-header');
        expect(header).not.toBeNull();
        expect(header.querySelector('[data-lang-option], #navLangToggle, .nav-lang-toggle')).toBeNull();
        expect(header.textContent).not.toMatch(/हिंदी|English/);
        expect(document.querySelector('[onclick*="i18n"]')).toBeNull();
    });
});

describe('Settings language row', () => {
    beforeEach(() => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        AppState.settings = { showHindi: false, laborRate: 6, heavyWeightThreshold: 30, autoLaborEnabled: true };
        AppState.printerSettings = { enabled: false };
        AppState.currentUser = { uid: 'u1', email: 'u@x' };
        AppState.userName = 'User';
        document.body.innerHTML = template('navigation') + template('settings');
    });

    const visible = (el) => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
            if (n.style.display === 'none' || n.hidden) return false;
        }
        return true;
    };

    it.each(['owner', 'manager', 'staff'])('is shown to %s, with the current choice selected', (role) => {
        AppState.userRole = role;
        AuthManager.applyRoleBasedRestrictions();
        SettingsManager.loadSettings();
        RolesAccessManager.render();
        applyTranslations(document);

        const settingsLink = document.querySelector('.nav-menu a[onclick*="showTab(\'settings\'"]');
        expect(visible(settingsLink)).toBe(true);
        const card = document.getElementById('languageSettingsCard');
        expect(visible(card)).toBe(true);
        expect(card.querySelector('h3').textContent).toBe('Language');
        expect(card.querySelector('[data-lang-option="en"]').textContent).toBe('English');
        expect(card.querySelector('[data-lang-option="hi"]').textContent).toBe('हिंदी');
        expect(card.querySelector('[data-lang-option="en"]').getAttribute('aria-pressed')).toBe('true');
        expect(card.querySelector('[data-lang-option="hi"]').getAttribute('aria-pressed')).toBe('false');
    });

    it('switching applies at once and the label is in one language only', () => {
        AppState.userRole = 'staff';
        applyTranslations(document);
        const card = document.getElementById('languageSettingsCard');
        card.querySelector('[data-lang-option="hi"]').click();

        expect(getLang()).toBe('hi');
        expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('hi');
        expect(card.querySelector('h3').textContent).toBe('भाषा');
        expect(card.querySelector('.lang-switch').getAttribute('aria-label')).toBe('भाषा');
        expect(card.querySelector('[data-lang-option="hi"]').getAttribute('aria-pressed')).toBe('true');
        expect(document.querySelector('[data-i18n="ui.nav.settings"]').textContent).toBe(hi['ui.nav.settings']);

        card.querySelector('[data-lang-option="en"]').click();
        expect(card.querySelector('h3').textContent).toBe('Language');
        expect(document.querySelector('[data-i18n="ui.nav.settings"]').textContent).toBe(en['ui.nav.settings']);
    });
});

describe('login card', () => {
    it('has English | हिंदी links at the bottom that switch the language', () => {
        document.body.innerHTML = template('auth');
        applyTranslations(document);
        const container = document.querySelector('#authScreen .auth-container');
        const links = document.getElementById('authLangLinks');
        expect(container.lastElementChild).toBe(links);
        expect(links.textContent.replace(/\s+/g, ' ').trim()).toBe('English | हिंदी');
        expect(links.querySelector('[data-lang-option="en"]').getAttribute('aria-pressed')).toBe('true');

        links.querySelector('[data-lang-option="hi"]').click();
        expect(getLang()).toBe('hi');
        expect(document.querySelector('[data-i18n="ui.app.tagline"]').textContent).toBe(hi['ui.app.tagline']);
        expect(links.querySelector('[data-lang-option="hi"]').getAttribute('aria-pressed')).toBe('true');
        expect(links.getAttribute('aria-label')).toBe('भाषा');

        links.querySelector('[data-lang-option="en"]').click();
        expect(getLang()).toBe('en');
        expect(document.querySelector('[data-i18n="ui.app.tagline"]').textContent).toBe(en['ui.app.tagline']);
    });
});
