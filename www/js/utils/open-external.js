// @ts-check
/**
 * @fileoverview Open a link outside the app (WhatsApp, browser, APK download).
 * In the Capacitor APK '_system' hands it to Android; on the web it opens a
 * new tab and only navigates this tab when the popup was really blocked.
 * @module utils/open-external
 */

/**
 * @param {string} url
 * @param {Window & {Capacitor?: any}} [win=window]
 * @returns {'system'|'tab'|'same-tab'} how the link was opened
 */
export function openExternal(url, win = window) {
    if (win.Capacitor?.isNativePlatform?.()) {
        win.open(url, '_system');
        return 'system';
    }
    // Not 'noopener' as a feature: then window.open always returns null and
    // the fallback below would also navigate the app away.
    const tab = win.open(url, '_blank');
    if (tab) {
        try { tab.opener = null; } catch (_) { /* cross-origin: nothing to clear */ }
        return 'tab';
    }
    win.location.href = url;
    return 'same-tab';
}
