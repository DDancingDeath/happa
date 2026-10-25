/**
 * @fileoverview "What's new" sheet, Android soft-update banner and app sharing.
 * Everything here is best-effort: failures are logged and never block the app.
 * @module modules/app-updates
 */

import { APP_VERSION } from '../version.js';
import { UIManager } from '../ui/ui-manager.js';
import { openExternal } from '../utils/open-external.js';
import { getLang, setLang, t } from '../i18n/index.js';
import {
    APK_DOWNLOAD_URL, APP_NAME, DOWNLOAD_PAGE_URL, LATEST_RELEASE_API,
    buildShareMessage, findRelease, shouldCheckForUpdate, updateToOffer,
    whatsAppShareUrl, whatsNewToShow, whatsNewContent, WHATS_NEW_LABELS
} from '../utils/release-info.js';

const KEYS = {
    lastSeen: 'aadhat.lastSeenVersion',
    lastCheck: 'aadhat.updateLastCheck',
    latestTag: 'aadhat.updateLatestTag',
    dismissed: 'aadhat.updateDismissedVersion'
};

const store = {
    get(key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
    set(key, value) { try { localStorage.setItem(key, String(value)); } catch (_) { /* storage full/blocked */ } }
};

function isNative() {
    return Boolean(window.Capacitor?.isNativePlatform?.());
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

let changelogPromise = null;

export class AppUpdatesManager {
    static get appVersion() {
        return APP_VERSION;
    }

    /** Fetches changelog.json (bypassing the HTTP cache; the SW serves it network-first). */
    static loadChangelog() {
        if (!changelogPromise) {
            changelogPromise = fetch('changelog.json', { cache: 'no-cache' })
                .then((res) => (res.ok ? res.json() : null))
                .catch(() => null)
                .then((data) => {
                    if (!data) changelogPromise = null;
                    return data;
                });
        }
        return changelogPromise;
    }

    /** Called once the main UI is visible. Non-blocking. */
    static onAppReady() {
        setTimeout(() => {
            this.maybeShowWhatsNew().catch((e) => console.warn('[updates] whats-new failed:', e));
            this.checkForAndroidUpdate().catch((e) => console.warn('[updates] update check failed:', e));
        }, 800);
    }

    static async maybeShowWhatsNew() {
        const changelog = await this.loadChangelog();
        const release = whatsNewToShow(changelog, APP_VERSION, store.get(KEYS.lastSeen));
        if (release) this.renderWhatsNew(release);
    }

    /** Settings → "What's new": reopen the notes for the running version. */
    static async showWhatsNew() {
        const changelog = await this.loadChangelog();
        const release = findRelease(changelog, APP_VERSION) || changelog?.releases?.[0];
        if (!release) {
            UIManager.showToast(t('msg.updates.could_not_load_release_notes'));
            return;
        }
        this.renderWhatsNew(release);
    }

    static renderWhatsNew(release) {
        document.getElementById('whatsNewSheet')?.remove();
        const backdrop = el('div', 'app-sheet-backdrop');
        backdrop.id = 'whatsNewSheet';
        const sheet = el('div', 'app-sheet');
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        sheet.setAttribute('aria-labelledby', 'whatsNewTitle');

        // Changelog text is only ever set via textContent (never innerHTML), so it cannot inject markup.
        const toggle = el('div', 'app-sheet-lang-toggle');
        toggle.setAttribute('role', 'group');
        toggle.setAttribute('aria-label', 'Language / भाषा');
        const langButtons = {};
        for (const [lang, label] of [['en', 'English'], ['hi', 'हिंदी']]) {
            const btn = el('button', 'app-sheet-lang-btn', label);
            btn.type = 'button';
            btn.lang = lang;
            btn.addEventListener('click', () => {
                // One setting for the whole app (#143): this also switches every screen.
                setLang(lang);
                render(lang);
                btn.focus();
            });
            langButtons[lang] = btn;
            toggle.appendChild(btn);
        }
        sheet.appendChild(toggle);

        const title = el('h3', 'app-sheet-title');
        title.id = 'whatsNewTitle';
        const versionLine = el('div', 'app-sheet-version');
        const fallbackNote = el('p', 'app-sheet-fallback');
        fallbackNote.setAttribute('role', 'note');
        const list = el('ul', 'app-sheet-notes');
        const close = el('button', 'add-item-btn app-sheet-close');
        close.type = 'button';
        sheet.append(title, versionLine, fallbackNote, list, close);

        const render = (storedLang) => {
            const { lang, notesLang, notes, fellBack } = whatsNewContent(release, storedLang);
            const labels = WHATS_NEW_LABELS[lang];
            sheet.lang = lang;
            for (const [l, btn] of Object.entries(langButtons)) {
                btn.setAttribute('aria-pressed', String(l === lang));
            }
            title.textContent = labels.title;
            versionLine.textContent = labels.version(release.version);
            fallbackNote.textContent = fellBack ? labels.fallback : '';
            fallbackNote.hidden = !fellBack;
            list.lang = notesLang;
            list.replaceChildren(...notes.map((note) => el('li', '', note)));
            close.textContent = labels.close;
        };
        render(getLang());

        const dismiss = () => {
            store.set(KEYS.lastSeen, APP_VERSION);
            backdrop.remove();
        };
        close.addEventListener('click', dismiss);
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismiss(); });

        backdrop.appendChild(sheet);
        document.body.appendChild(backdrop);
        close.focus();
    }

    /** Android only: offer a newer APK published on GitHub Releases. */
    static async checkForAndroidUpdate(now = Date.now()) {
        if (!isNative()) return;
        let latestTag = store.get(KEYS.latestTag);
        if (shouldCheckForUpdate(store.get(KEYS.lastCheck), now)) {
            try {
                const res = await fetch(LATEST_RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
                if (res.ok) {
                    const data = await res.json();
                    if (typeof data?.tag_name === 'string') {
                        latestTag = data.tag_name;
                        store.set(KEYS.latestTag, latestTag);
                    }
                }
                store.set(KEYS.lastCheck, now);
            } catch (_) {
                // Offline / rate limited: try again next start.
            }
        }
        const version = updateToOffer(APP_VERSION, latestTag, store.get(KEYS.dismissed));
        if (version) this.renderUpdateBanner(version);
    }

    static renderUpdateBanner(version) {
        document.getElementById('appUpdateBanner')?.remove();
        const banner = el('div', 'app-update-banner');
        banner.id = 'appUpdateBanner';
        banner.setAttribute('role', 'status');

        const text = el('div', 'app-update-text');
        text.appendChild(el('strong', '', `नया वर्ज़न v${version} उपलब्ध है`));
        text.appendChild(el('span', '', `Update available: v${version}`));
        banner.appendChild(text);

        const actions = el('div', 'app-update-actions');
        const download = el('button', 'app-update-download', 'डाउनलोड / Download');
        download.type = 'button';
        download.addEventListener('click', () => this.openExternal(APK_DOWNLOAD_URL));
        const howTo = el('a', 'app-update-howto', 'कैसे इंस्टॉल करें? / How to install');
        howTo.href = DOWNLOAD_PAGE_URL;
        howTo.addEventListener('click', (e) => { e.preventDefault(); this.openExternal(DOWNLOAD_PAGE_URL); });
        const close = el('button', 'app-update-close', '✕');
        close.type = 'button';
        close.setAttribute('aria-label', 'Dismiss / बंद करें');
        close.addEventListener('click', () => {
            store.set(KEYS.dismissed, version);
            banner.remove();
        });
        actions.append(download, howTo, close);
        banner.appendChild(actions);
        document.body.appendChild(banner);
    }

    /** Opens a URL outside the app (system browser / WhatsApp on Android). */
    static openExternal(url) {
        openExternal(url);
    }

    static async getShareMessage() {
        const changelog = await this.loadChangelog();
        const release = findRelease(changelog, APP_VERSION) || changelog?.releases?.[0] || { version: APP_VERSION };
        return buildShareMessage(release, DOWNLOAD_PAGE_URL);
    }

    static async shareOnWhatsApp() {
        this.openExternal(whatsAppShareUrl(await this.getShareMessage()));
    }

    static canNativeShare() {
        return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
    }

    static async shareNative() {
        if (!this.canNativeShare()) {
            await this.shareOnWhatsApp();
            return;
        }
        try {
            await navigator.share({ title: APP_NAME, text: await this.getShareMessage() });
        } catch (e) {
            if (e?.name !== 'AbortError') UIManager.showToast(t('msg.updates.share_failed'));
        }
    }

    static openDownloadPage() {
        this.openExternal(DOWNLOAD_PAGE_URL);
    }

    /** Fills the version text and hides unsupported buttons in Settings. */
    static renderSettings() {
        const versionText = document.getElementById('appVersionText');
        if (versionText) versionText.textContent = APP_VERSION;
        const nativeShareBtn = document.getElementById('shareAppNativeBtn');
        if (nativeShareBtn) nativeShareBtn.style.display = this.canNativeShare() ? '' : 'none';
    }
}
