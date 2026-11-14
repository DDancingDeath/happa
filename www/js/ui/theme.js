/**
 * @fileoverview ThemeManager: Appearance (Light / Dark / System) and the visual theme, saved on
 * this device (localStorage, no Firestore). The inline #themeBoot in index.html applies the saved
 * choice before first paint with the same keys and rules; this module keeps it live afterwards.
 * <html> carries data-theme, data-appearance (the choice) and data-mode (light | dark, what the CSS
 * keys on).
 */
import { APPEARANCES, DEFAULT_APPEARANCE, DEFAULT_THEME, themeById } from './themes.js';
import { safeSetItem } from '../utils/storage-full.js';

export const THEME_KEYS = {
    theme: 'happa.theme',
    appearance: 'happa.appearance',
    kind: 'happa.themeKind',
    barLight: 'happa.bar.light',
    barDark: 'happa.bar.dark',
    // The saved theme this version could not show (the boot script then ignores its kind and bar colour)
    fallback: 'happa.themeFallback',
    legacyDark: 'darkMode',
    // Written on every start since #143, so an install from before the theme engine has it
    existingInstall: 'aadhat.itemNamesFollowLang',
};

const BAR_COLOUR = /^#[0-9a-f]{6}$/i;

/** The mode the CSS uses: dark themes are always dark; System follows the device. */
export function resolveMode(appearance, kind, systemDark) {
    if (kind === 'dark' || appearance === 'dark') return 'dark';
    return appearance === 'system' && systemDark ? 'dark' : 'light';
}

/**
 * The saved choice. Before one is saved: the old `darkMode` setting maps to Dark / Light, an install
 * from before the theme engine keeps Light, and a new device gets the default (System).
 */
export function storedChoice(store) {
    const get = (k) => { try { return store.getItem(k); } catch { return null; } };
    const theme = themeById(get(THEME_KEYS.theme))?.id || DEFAULT_THEME;
    const saved = get(THEME_KEYS.appearance);
    const legacy = get(THEME_KEYS.legacyDark);
    let appearance;
    if (saved !== null) appearance = APPEARANCES.includes(saved) ? saved : 'light';
    else if (legacy === 'true') appearance = 'dark';
    else appearance = legacy === 'false' || get(THEME_KEYS.existingInstall) !== null ? 'light' : DEFAULT_APPEARANCE;
    return { theme, appearance };
}

const systemQuery = () => (typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null);

function storage() {
    try { return window.localStorage; } catch { return null; }
}

/** The choice as the boot script saw it: read when this module loads, before main.js writes its first keys. */
export const CHOICE_AT_LOAD = (() => { const store = storage(); return store ? storedChoice(store) : null; })();

export const ThemeManager = {
    /** @type {{theme: string, appearance: string}} */
    current: { theme: DEFAULT_THEME, appearance: DEFAULT_APPEARANCE },
    /** A theme shown but not saved (Settings › Appearance gallery), or null. */
    previewing: null,
    _watching: false,

    /** @param {{theme: string, appearance: string}|null} [choice] defaults to the saved choice now */
    init(choice) {
        const store = storage();
        this.current = choice || (store ? storedChoice(store) : { ...this.current });
        // The first start keeps its choice, so a key the app writes later can't change it
        if (store && store.getItem(THEME_KEYS.appearance) === null) safeSetItem(THEME_KEYS.appearance, this.current.appearance, store);
        const state = this.render(this.current);
        // A saved theme this version can't show (e.g. after a rollback) stays saved with its kind and bar colours,
        // so a version that knows it shows it again; the boot script then ignores that kind and bar colour
        const saved = store ? store.getItem(THEME_KEYS.theme) : null;
        const unknown = saved !== null && !themeById(saved);
        if (store && unknown) safeSetItem(THEME_KEYS.fallback, saved, store);
        else if (store && store.getItem(THEME_KEYS.fallback) !== null) {
            try { store.removeItem(THEME_KEYS.fallback); } catch { /* storage unavailable */ }
        }
        const barKey = state.mode === 'dark' ? THEME_KEYS.barDark : THEME_KEYS.barLight;
        if (store && !unknown && BAR_COLOUR.test(state.bar) && store.getItem(barKey) !== state.bar) safeSetItem(barKey, state.bar, store);
        const query = systemQuery();
        if (query && !this._watching) {
            this._watching = true;
            const follow = () => { if (this.current.appearance === 'system') this.render({ ...this.current, theme: this.previewing || this.current.theme }); };
            if (query.addEventListener) query.addEventListener('change', follow);
            else if (query.addListener) query.addListener(follow);
            // A preview never outlives Settings › Common (the gallery's section)
            window.addEventListener('aadhat:tabshown', (e) => {
                const { tabId, section } = e.detail || {};
                if (tabId !== 'settings' || (section && section !== 'common')) this.cancelPreview();
            });
        }
        return this.current;
    },

    /** Sets the attributes and the browser bar colour; stores nothing. */
    render({ theme, appearance }) {
        const th = themeById(theme) || themeById(DEFAULT_THEME);
        const choice = APPEARANCES.includes(appearance) ? appearance : DEFAULT_APPEARANCE;
        const mode = resolveMode(choice, th.kind, !!systemQuery()?.matches);
        const root = document.documentElement;
        root.setAttribute('data-theme', th.id);
        root.setAttribute('data-appearance', choice);
        root.setAttribute('data-mode', mode);
        const bar = getComputedStyle(root).getPropertyValue('--bg').trim();
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta && BAR_COLOUR.test(bar)) meta.setAttribute('content', bar);
        const state = { theme: th.id, appearance: choice, mode, kind: th.kind, bar, previewing: this.previewing };
        window.dispatchEvent(new CustomEvent('aadhat:themechange', { detail: state }));
        return state;
    },

    /** Shows a theme across the app without saving it; choosing the saved theme ends the preview. */
    preview(theme) {
        if (!themeById(theme)) return null;
        if (theme === this.current.theme) return this.cancelPreview();
        this.previewing = theme;
        return this.render({ ...this.current, theme });
    },

    /** Back to the saved choice; null when nothing was being previewed. */
    cancelPreview() {
        if (this.previewing === null) return null;
        this.previewing = null;
        return this.render(this.current);
    },

    /** Applies and saves a choice (Settings › Appearance). */
    apply(choice) {
        this.previewing = null;
        const next = { ...this.current, ...choice };
        const state = this.render(next);
        const changedTheme = state.theme !== this.current.theme;
        this.current = { theme: state.theme, appearance: state.appearance };
        const store = storage();
        if (store) {
            safeSetItem(THEME_KEYS.theme, state.theme, store);
            safeSetItem(THEME_KEYS.appearance, state.appearance, store);
            safeSetItem(THEME_KEYS.kind, state.kind, store);
            // A new theme, or the first save over a theme this version couldn't show: drop the old bar colours
            if (changedTheme || store.getItem(THEME_KEYS.fallback) !== null) {
                try { store.removeItem(THEME_KEYS.barLight); store.removeItem(THEME_KEYS.barDark); } catch { /* storage unavailable */ }
            }
            if (BAR_COLOUR.test(state.bar)) safeSetItem(state.mode === 'dark' ? THEME_KEYS.barDark : THEME_KEYS.barLight, state.bar, store);
            try { store.removeItem(THEME_KEYS.legacyDark); store.removeItem(THEME_KEYS.fallback); } catch { /* storage unavailable */ }
        }
        return state;
    },
};
