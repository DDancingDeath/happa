/**
 * App language catalogue guard (#143, #63): every key the app uses exists in both
 * catalogues with the same {placeholders}, and the owner's wording rule holds
 * (no "staff" / "स्टाफ" — say "everyone" / "members" / "सभी" / "सदस्य").
 */
const fs = require('fs');
const path = require('path');
import en from '../i18n/en.js';
import hi from '../i18n/hi.js';
import {
    t, formatMessage, loadLang, setLang, getLang, applyTranslations, resetLangForTests,
    LANG_STORAGE_KEY, LEGACY_WHATS_NEW_LANG_KEY, LANG_CHANGE_EVENT
} from '../i18n/index.js';

const WWW = path.join(__dirname, '..', '..');
const KEY_RE = /['"`]((?:msg|ui)\.[a-z0-9_]+\.[a-z0-9_]+)['"`]/g;
const ATTR_RE = /data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g;

const listFiles = (dir, ext) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return ['__tests__', 'i18n'].includes(e.name) ? [] : listFiles(full, ext);
    return e.name.endsWith(ext) ? [full] : [];
});

function usedKeys() {
    const used = new Map();
    const add = (key, file) => { if (!used.has(key)) used.set(key, path.relative(WWW, file)); };
    for (const f of listFiles(path.join(WWW, 'js'), '.js')) {
        for (const m of fs.readFileSync(f, 'utf8').matchAll(KEY_RE)) add(m[1], f);
    }
    for (const f of listFiles(path.join(WWW, 'templates'), '.html')) {
        for (const m of fs.readFileSync(f, 'utf8').matchAll(ATTR_RE)) add(m[1], f);
    }
    return used;
}

const placeholders = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort();

class MemoryStore {
    constructor(init = {}) { this.data = { ...init }; }
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null; }
    setItem(k, v) { this.data[k] = String(v); }
    removeItem(k) { delete this.data[k]; }
}

describe('i18n catalogues', () => {
    it('every key used in www/js and templates exists in both catalogues', () => {
        const missing = [...usedKeys()].filter(([k]) => !(k in en) || !(k in hi)).map(([k, f]) => `${k} (${f})`);
        expect(missing).toEqual([]);
    });

    it('en and hi have the same keys and the same {placeholders}', () => {
        expect(Object.keys(hi).sort()).toEqual(Object.keys(en).sort());
        const diff = Object.keys(en).filter(k => placeholders(en[k]).join() !== placeholders(hi[k]).join());
        expect(diff).toEqual([]);
    });

    it('has no empty values', () => {
        expect(Object.keys(en).filter(k => !en[k] || !hi[k])).toEqual([]);
    });

    it('never says "staff" (English) or "स्टाफ" (Hindi)', () => {
        expect(Object.entries(en).filter(([, v]) => /staff/i.test(v))).toEqual([]);
        expect(Object.entries(hi).filter(([, v]) => /स्टाफ|staff/i.test(v))).toEqual([]);
    });

    it('Hindi values are actually Hindi (not a copy of the English text)', () => {
        // The app name "happa" is the same in both languages.
        const SAME_IN_BOTH = new Set(['ui.app.name']);
        const copies = Object.keys(en).filter(k => !SAME_IN_BOTH.has(k) && en[k] === hi[k] && /[A-Za-z]{2,}/.test(en[k]));
        expect(copies).toEqual([]);
    });
});

describe('t()', () => {
    afterEach(() => { localStorage.clear(); resetLangForTests(); });

    it('defaults to English and fills {placeholders}', () => {
        expect(getLang()).toBe('en');
        expect(t('msg.cash.count_saved', { amount: 500 })).toBe('✓ Count of ₹500 saved');
    });

    it('uses the chosen language, an explicit language, and falls back to the key', () => {
        setLang('hi');
        expect(t('msg.cash.count_saved', { amount: 500 })).toBe('✓ ₹500 की गिनती सेव हुई');
        expect(t('msg.cash.count_saved', { amount: 500 }, 'en')).toBe('✓ Count of ₹500 saved');
        expect(t('no.such.key')).toBe('no.such.key');
    });

    it('leaves unknown placeholders alone', () => {
        expect(formatMessage('Hi {name} {other}', { name: 'Ram' })).toBe('Hi Ram {other}');
    });
});

describe('language preference', () => {
    afterEach(() => { localStorage.clear(); resetLangForTests(); document.body.innerHTML = ''; });

    it('migrates the old What\'s new language once and removes the old key', () => {
        const store = new MemoryStore({ [LEGACY_WHATS_NEW_LANG_KEY]: 'hi' });
        expect(loadLang(store)).toBe('hi');
        expect(store.getItem(LANG_STORAGE_KEY)).toBe('hi');
        expect(store.getItem(LEGACY_WHATS_NEW_LANG_KEY)).toBeNull();
    });

    it('keeps an existing app language over the old What\'s new value', () => {
        const store = new MemoryStore({ [LANG_STORAGE_KEY]: 'en', [LEGACY_WHATS_NEW_LANG_KEY]: 'hi' });
        expect(loadLang(store)).toBe('en');
    });

    it('is English when nothing (or something invalid) is saved', () => {
        expect(loadLang(new MemoryStore())).toBe('en');
        expect(loadLang(new MemoryStore({ [LANG_STORAGE_KEY]: 'fr' }))).toBe('en');
    });

    it('setLang re-applies templates without a reload and tells open screens', () => {
        document.body.innerHTML = `
            <span id="a" data-i18n="ui.nav.billing">Billing</span>
            <input id="b" data-i18n-placeholder="ui.billing.enter_weight" placeholder="Enter weight">
            <button data-lang-option="en"></button><button data-lang-option="hi"></button>
            <button id="navLangToggle"></button>`;
        const onChange = jest.fn();
        window.addEventListener(LANG_CHANGE_EVENT, onChange);
        setLang('hi');
        window.removeEventListener(LANG_CHANGE_EVENT, onChange);

        expect(document.getElementById('a').textContent).toBe(hi['ui.nav.billing']);
        expect(document.getElementById('b').placeholder).toBe(hi['ui.billing.enter_weight']);
        expect(document.querySelector('[data-lang-option="hi"]').getAttribute('aria-pressed')).toBe('true');
        expect(document.getElementById('navLangToggle').textContent).toBe('English');
        expect(document.documentElement.lang).toBe('hi');
        expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('hi');
        expect(onChange).toHaveBeenCalledTimes(1);

        applyTranslations(document);
        expect(document.getElementById('a').textContent).toBe(hi['ui.nav.billing']);
    });
});
