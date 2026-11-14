/**
 * @fileoverview "Install app" (PWA) support for the Settings screen.
 * index.html stashes the early `beforeinstallprompt` event on
 * window.__installPromptEvent; this module picks it up and drives the UI.
 * @module services/install-prompt
 */

/**
 * Decide what the Settings install card should show.
 * @returns {'button'|'hint'|'hidden'}
 */
export function getInstallUiState({ isNative, isStandalone, installed, hasPrompt }) {
    if (isNative || isStandalone || installed) return 'hidden';
    return hasPrompt ? 'button' : 'hint';
}

export const InstallManager = {
    deferredPrompt: null,
    installed: false,
    win: null,

    init(win = window) {
        this.win = win;
        if (win.__installPromptEvent) this.deferredPrompt = win.__installPromptEvent;
        win.addEventListener('beforeinstallprompt', (e) => {
            this.deferredPrompt = e;
            this.refresh();
        });
        win.addEventListener('appinstalled', () => {
            this.installed = true;
            this.deferredPrompt = null;
            win.__installPromptEvent = null;
            this.refresh();
        });
        this.refresh();
    },

    isNative() {
        const cap = this.win && this.win.Capacitor;
        return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
    },

    isStandalone() {
        const w = this.win;
        if (!w) return false;
        const mq = (q) => typeof w.matchMedia === 'function' && w.matchMedia(q).matches;
        return mq('(display-mode: standalone)') || mq('(display-mode: window-controls-overlay)')
            || w.navigator?.standalone === true;
    },

    state() {
        return getInstallUiState({
            isNative: this.isNative(),
            isStandalone: this.isStandalone(),
            installed: this.installed,
            hasPrompt: !!this.deferredPrompt,
        });
    },

    refresh() {
        const doc = this.win && this.win.document;
        const card = doc && doc.getElementById('installAppCard');
        if (!card) return;
        const state = this.state();
        const show = (el, on) => { if (el) { el.hidden = !on; el.style.display = on ? '' : 'none'; } };
        show(card, state !== 'hidden');
        show(doc.getElementById('installAppBtn'), state === 'button');
        show(doc.getElementById('installAppHint'), state === 'hint');
    },

    async prompt() {
        const evt = this.deferredPrompt;
        if (!evt) { this.refresh(); return; }
        // A prompt event can only be used once.
        this.deferredPrompt = null;
        if (this.win) this.win.__installPromptEvent = null;
        try {
            await evt.prompt();
            const choice = await evt.userChoice;
            if (choice && choice.outcome === 'accepted') this.installed = true;
        } catch (err) {
            console.warn('[Install] prompt failed:', err);
        }
        this.refresh();
    },
};
