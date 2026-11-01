/**
 * @fileoverview The one way data leaves the app as a file or a shared text
 * (#103, #85, #83): owner only, a confirm before anything with customer or
 * supplier names, the shop / period / time / user stamp, and an audit row.
 * Statements, the audit log and the error report all export through `run`.
 * @module services/exporter
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { AuditService } from './audit.js';
import { t } from '../i18n/index.js';
import { APP_IDENTITY } from '../config/app-identity.js';
import { exportStamp, exportAuditDetails } from '../utils/export-stamp.js';

export const Exporter = {
    /** Only the owner exports (#103). */
    allowed() {
        return AppState.userRole === 'owner';
    },

    stamp(period, now = Date.now()) {
        return exportStamp({ shop: AppState.settings?.shopName || APP_IDENTITY.appName, period, at: now, user: AppState.userName || '' });
    },

    /**
     * Owner check, confirm when `names`, then `produce(stamp)`; a run that
     * produced something (not `false`) writes the EXPORT audit row.
     * @param {{kind: string, format: string, period?: {from?: ?string, to?: ?string, label?: string}, rows?: number,
     *   names?: boolean, produce: (stamp: Object) => (boolean|void|Promise<boolean|void>)}} job
     * @returns {Promise<boolean>} true when exported
     */
    async run({ kind, format, period = {}, rows = 0, names = false, produce }) {
        if (!this.allowed()) {
            UIManager.showToast(t('msg.export.owner_only'), 'error');
            return false;
        }
        if (names && !(await UIManager.showModal(t('msg.export.confirm_names'), t('msg.export.confirm_title'), true))) return false;
        const done = await produce(this.stamp(period));
        if (done === false) return false;
        AuditService.note(AuditService.ACTIONS.EXPORT, exportAuditDetails({ kind, format, period, rows }));
        return true;
    },

    /**
     * Saves a file on this device. `shareFirst`: the share sheet when the phone can
     * share files (so it can go to Drive / WhatsApp), else a download.
     * @param {Blob} blob
     * @param {string} filename
     * @param {{shareFirst?: boolean}} [opts]
     * @returns {Promise<boolean>} true when the share sheet or download was started (the browser
     *   can't confirm the file was kept); false when sharing was cancelled, or in the Android app
     *   when sharing isn't available (its WebView drops downloads)
     */
    async saveBlob(blob, filename, { shareFirst = true } = {}) {
        const native = !!window.Capacitor?.isNativePlatform?.();
        if ((shareFirst || native) && typeof File !== 'undefined' && navigator.canShare) {
            const file = new File([blob], filename, { type: blob.type });
            if (navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({ files: [file], title: filename });
                    return true;
                } catch (e) {
                    if (e?.name === 'AbortError') return false;
                    console.warn('Share failed, falling back to download:', e);
                }
            }
        }
        if (native) return false;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return true;
    },

    /**
     * A printable page (Print / Save as PDF) with the stamp under the title.
     * @param {{title: string, html: string, stampText: string, lang: string}} page
     * @returns {boolean} false when the browser blocked the window
     */
    printPage({ title, html, stampText, lang }) {
        const w = window.open('', '_blank');
        if (!w) {
            UIManager.showToast(t('msg.statements.popup_blocked'));
            return false;
        }
        const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        w.document.write(`<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><title>${esc(title)}</title>`
            + '<style>body{font-family:system-ui,sans-serif;margin:24px;color:#111}table{width:100%;border-collapse:collapse;font-size:13px}th,td{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}td.num,th.num{text-align:right}.ins-row{display:flex;justify-content:space-between;border-bottom:1px solid #eee;padding:6px 0}.ins-total{font-weight:700}.ins-hero{border:1px solid #ccc;padding:10px;border-radius:8px;margin:8px 0}.ins-hero-value{font-size:22px;font-weight:700}.export-stamp{color:#555;font-size:12px;margin:0 0 12px}button,.ins-hint{display:none}@page{size:A4;margin:14mm}</style>'
            + `</head><body><p class="export-stamp">${esc(stampText)}</p>${html}</body></html>`);
        w.document.close();
        w.onload = () => w.print();
        return true;
    }
};
