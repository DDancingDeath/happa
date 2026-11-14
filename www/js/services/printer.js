// -------------------- BLUETOOTH PRINTER MANAGER --------------------

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { getAndroidMajorVersion, Helpers } from '../utils/helpers.js';
import { t, loadAllCatalogues } from '../i18n/index.js';
import { PrinterLink } from './printer-link.js';
import { track } from './usage.js';
import { tip } from '../tip/index.js';
import { printProps } from '../tip/scenarios/print.js';
import { recordPrint } from '../utils/print-status.js';
import {
    currentPrinter, effectiveReceipt, hasOwnReceipt, logoSize, normalizeLogo, normalizePrinterSettings, normalizeSharedReceipt,
    paperDots, rasterThreshold, receiptLang
} from '../utils/printer-settings.js';
import { safeSetItem } from '../utils/storage-full.js';

/** Dots darker than this (average of R,G,B) print black */
const RASTER_THRESHOLD = 128;
/** Tallest single GS v 0 image: the old fixed slip canvas, known to print on the shops' printers. */
const MAX_RASTER_ROWS = 2600;

const jobKey = (kind, id) => (id ? `${kind}:${id}` : null);
const UNCERTAIN_KEY = 'printerMayHavePrinted';
const UNCERTAIN_TTL_MS = 24 * 60 * 60 * 1000;
const STOPPED_KEY = 'printerDisconnected';
const LOGO_KEY = 'receiptLogo';
const SHARED_RECEIPT_KEY = 'receiptShared';
/** A bill whose print failed can be tried again from its preview, this many tries in all (#77, Q16). */
export const BILL_PRINT_TRIES = 3;
const CONNECT_PERMISSION = 'android.permission.BLUETOOTH_CONNECT';
const PERMISSION_CHECK_MS = 3000;

/** settings/app.receipt as last read (undefined = not looked at yet: the offline copy is read on first use). */
let sharedReceipt;
const sharedReceiptNow = () => {
    if (sharedReceipt === undefined) {
        try {
            sharedReceipt = normalizeSharedReceipt(JSON.parse(localStorage.getItem(SHARED_RECEIPT_KEY)));
        } catch {
            sharedReceipt = null;
        }
    }
    return sharedReceipt;
};

const clockTime = (ms) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * Pack RGBA pixels into a 1-bit ESC/POS raster (MSB = leftmost dot, 1 = black).
 * A pixel prints black when (r + g + b) / 3 < threshold.
 * @param {Uint8ClampedArray|Uint8Array} pixels - RGBA data (ImageData.data), row-major
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {number} [threshold=128]
 * @returns {Uint8Array} ceil(width / 8) * height bytes
 */
export function packMonochromeRaster(pixels, width, height, threshold = RASTER_THRESHOLD) {
    const bytesPerLine = (width + 7) >> 3;
    const out = new Uint8Array(bytesPerLine * height);
    // (r + g + b) / 3 < threshold  <=>  r + g + b < 3 * threshold (exact for integers)
    const limit = threshold * 3;
    let p = 0;
    for (let y = 0; y < height; y++) {
        const rowStart = y * bytesPerLine;
        for (let x = 0; x < width; x++, p += 4) {
            if (pixels[p] + pixels[p + 1] + pixels[p + 2] < limit) {
                out[rowStart + (x >> 3)] |= 0x80 >> (x & 7);
            }
        }
    }
    return out;
}

/**
 * Wrap a packed raster in the ESC/POS commands used for printing:
 * ESC @, ESC a 1 (center), GS v 0 raster, ESC d 3 (feed), GS V A 3 (partial cut).
 * A raster taller than MAX_RASTER_ROWS goes as several GS v 0 blocks, one under the other.
 * Returns a standalone Uint8Array (byteOffset 0) because bluetoothSerial.write
 * sends `data.buffer`.
 * @param {Uint8Array} raster - Output of packMonochromeRaster
 * @param {number} bytesPerLine
 * @param {number} height - Height in dots
 * @returns {Uint8Array}
 */
export function buildRasterPrintCommand(raster, bytesPerLine, height) {
    const header = [0x1B, 0x40, 0x1B, 0x61, 0x01];
    const trailer = [
        0x1B, 0x64, 0x03,
        0x1D, 0x56, 0x41, 0x03
    ];
    const bands = Math.max(1, Math.ceil(height / MAX_RASTER_ROWS));
    const out = new Uint8Array(header.length + bands * 8 + raster.length + trailer.length);
    out.set(header, 0);
    let at = header.length;
    for (let top = 0, b = 0; b < bands; b++, top += MAX_RASTER_ROWS) {
        const rows = Math.min(MAX_RASTER_ROWS, height - top);
        out.set([0x1D, 0x76, 0x30, 0x00, bytesPerLine & 0xFF, (bytesPerLine >> 8) & 0xFF, rows & 0xFF, (rows >> 8) & 0xFF], at);
        at += 8;
        out.set(raster.subarray(top * bytesPerLine, (top + rows) * bytesPerLine), at);
        at += rows * bytesPerLine;
    }
    out.set(trailer, at);
    return out;
}

/**
 * Convert the top `height` rows of a canvas into a ready-to-send ESC/POS buffer,
 * scaled to `dots` per line when the paper is wider than the canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {number} [height=canvas.height]
 * @param {number} [dots=canvas.width]
 * @param {number} [threshold=128] print density (#107)
 * @returns {Uint8Array}
 */
export function canvasToEscPos(canvas, height = canvas.height, dots = canvas.width, threshold = RASTER_THRESHOLD) {
    if (dots && dots !== canvas.width) {
        const scaled = document.createElement('canvas');
        scaled.width = dots;
        scaled.height = Math.ceil(height * (dots / canvas.width));
        const ctx = scaled.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, scaled.width, scaled.height);
        ctx.drawImage(canvas, 0, 0, canvas.width, height, 0, 0, scaled.width, scaled.height);
        return canvasToEscPos(scaled, scaled.height, dots, threshold);
    }
    const width = canvas.width;
    const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
    const raster = packMonochromeRaster(data, width, height, threshold || RASTER_THRESHOLD);
    return buildRasterPrintCommand(raster, (width + 7) >> 3, height);
}

class BluetoothPrinterManager {
    /** @param {Object} [linkOptions] PrinterLink options (transport, timeouts, retry, sleep, now) */
    constructor(linkOptions) {
        this.link = new PrinterLink(linkOptions);
    }

    get device() { return this.link.deviceId; }
    set device(value) { this.link.deviceId = value; }
    get printerName() { return this.link.deviceName; }
    set printerName(value) { this.link.deviceName = value; }

    /**
     * Send raw bytes as one job (serialized, timed out, reconnects to `target`).
     * @private
     */
    async _send(bytes, label, job = {}) {
        try {
            return await this.link.send(bytes, job.target, job);
        } catch (error) {
            console.error(`[${label}] Print ${error?.outcome || 'failed'}:`, error);
            throw error;
        }
    }

    sendCanvas(canvas, job) {
        return this._send(canvasToEscPos(canvas, canvas.height, job?.dots, job?.receipt?.threshold), 'WRITE CANVAS', job);
    }

    async scan() {
        if (!window.bluetoothSerial) {
            const errorMsg = 'Bluetooth Serial plugin not available';
            console.error('[SCAN]', errorMsg);
            throw new Error(errorMsg);
        }
        
        // Request Bluetooth runtime permissions. BLUETOOTH_SCAN/CONNECT only exist on
        // Android 12+ (API 31); requesting them on Android 11 always reports "denied".
        if (window.cordova && window.cordova.plugins && window.cordova.plugins.permissions) {
            const permissions = window.cordova.plugins.permissions;
            const permissionsToRequest = [];
            if (getAndroidMajorVersion() >= 12) {
                permissionsToRequest.push(
                    permissions.BLUETOOTH_SCAN || 'android.permission.BLUETOOTH_SCAN',
                    permissions.BLUETOOTH_CONNECT || 'android.permission.BLUETOOTH_CONNECT'
                );
            }
            permissionsToRequest.push(
                permissions.ACCESS_FINE_LOCATION || 'android.permission.ACCESS_FINE_LOCATION'
            );
            
            try {
                // Check each permission individually
                for (const permission of permissionsToRequest) {
                    await new Promise((resolve, reject) => {
                        permissions.checkPermission(permission, (status) => {
                            if (status.hasPermission) {
                                resolve();
                            } else {
                                permissions.requestPermission(
                                    permission,
                                    (result) => {
                                        if (result.hasPermission) {
                                            resolve();
                                        } else {
                                            reject(new Error('Permission denied: ' + permission));
                                        }
                                    },
                                    () => reject(new Error('Failed to request permission: ' + permission))
                                );
                            }
                        }, () => {
                            // Permission check failed, try to request anyway
                            permissions.requestPermission(
                                permission,
                                (result) => {
                                    if (result.hasPermission) {
                                        resolve();
                                    } else {
                                        reject(new Error('Permission denied: ' + permission));
                                    }
                                },
                                () => reject(new Error('Failed to request permission: ' + permission))
                            );
                        });
                    });
                }
            } catch (permError) {
                console.error('[SCAN] Permission error:', permError);
                throw new Error('Bluetooth permissions required. Please grant all permissions when prompted, or enable them manually in app settings.');
            }
        }
        
        await this.link.enableBluetooth();
        UIManager.showLoading();
        try {
            const devices = await this.link.list();
            return devices || [];
        } catch (error) {
            console.error('[SCAN] Error:', error);
            throw error;
        } finally {
            UIManager.hideLoading();
        }
    }

    async connect(deviceId, deviceName = null) {
        if (!this.link.transport.available()) {
            throw new Error('Bluetooth Serial plugin not available');
        }
        UIManager.showLoading();
        try {
            return await this.link.connectNow(deviceId, deviceName);
        } catch (error) {
            console.error('[CONNECT] Error:', error);
            throw error;
        } finally {
            UIManager.hideLoading();
        }
    }

    async disconnect() {
        await this.link.disconnect();
    }
}

let drawingLoading = null;
/**
 * Receipt drawing (services/receipt-drawing.js, #59): imported on the first print or preview
 * (main.js also starts it when the phone is idle after the first screen), with both language
 * catalogues for a receipt in the other language.
 * @returns {Promise<void>}
 */
export function loadReceiptDrawing() {
    if (!drawingLoading) {
        drawingLoading = Promise.all([import('./receipt-drawing.js'), loadAllCatalogues()])
            .then(([m]) => m.addReceiptDrawing(BluetoothPrinterManager))
            .catch(e => { drawingLoading = null; throw e; });
    }
    return drawingLoading;
}

const PrinterService = {
    manager: new BluetoothPrinterManager(),

    async scanDevices() {
        try {
            const devices = await this.manager.scan();
            return devices;
        } catch (error) {
            console.error('Printer scan error:', error);
            UIManager.showToast(t('msg.printer.failed_scan_devices', { message: this.errorText(error) }));
            throw error;
        }
    },

    async connect(deviceId, deviceName) {
        try {
            await this.manager.connect(deviceId, deviceName);
            localStorage.removeItem(STOPPED_KEY);
            this.updateStatus();
            return true;
        } catch (error) {
            console.error('Printer connect error:', error);
            UIManager.showToast(t('msg.printer.failed_connect', { message: this.errorText(error) }));
            throw error;
        }
    },

    async disconnect() {
        try {
            localStorage.setItem(STOPPED_KEY, '1');
            await this.manager.disconnect();
            this.updateStatus();
            UIManager.showToast(t('msg.common.printer_disconnected'));
        } catch (error) {
            console.error('Disconnect error:', error);
            UIManager.showToast(t('msg.common.failed_disconnect', { message: error.message }));
        }
    },

    /** Readable text for a print/link error (timeouts and drops are translated). */
    errorText(error) {
        const keys = {
            timeout_connect: 'msg.printer.err_timeout_connect',
            timeout_write: 'msg.printer.err_timeout_write',
            timeout_check: 'msg.printer.err_timeout_check',
            timeout_list: 'msg.printer.err_timeout_check',
            dropped: 'msg.printer.err_dropped',
            no_printer: 'msg.settings.printer_not_connected',
            stopped: 'msg.settings.printer_not_connected',
            unavailable: 'msg.printer.android_app_only',
            bluetooth_off: 'msg.printer.bluetooth_off',
            permission: 'msg.printer.err_permission'
        };
        const key = keys[error?.kind];
        return key ? t(key) : String(error?.message || error || '');
    },

    /** This phone's printer settings (saved printers, the one in use, preview). */
    settings() {
        return normalizePrinterSettings(AppState.printerSettings);
    },

    /** The printer to reconnect to: the one in use in Settings. */
    target() {
        const { deviceId, deviceName } = this.settings();
        return { deviceId, deviceName };
    },

    /** What the printed bill shows (#107): the shop's shared receipt, or this phone's own until one is shared. */
    receipt() {
        return effectiveReceipt(this.settings(), sharedReceiptNow(), this.localLogo());
    },

    /** Footer, QR, language, darkness and logo for a print job. */
    receiptOptions() {
        const r = this.receipt();
        return { footer: r.footer, qr: r.qr, lang: receiptLang(r), threshold: rasterThreshold(r), logo: r.logo };
    },

    /** The receipt saved for every phone (settings/app.receipt), or null when none is yet. */
    sharedReceipt() {
        return sharedReceiptNow();
    },

    /** Takes the shared receipt from settings/app and keeps a copy on this phone for offline starts. */
    setSharedReceipt(raw) {
        sharedReceipt = normalizeSharedReceipt(raw);
        if (sharedReceipt) safeSetItem(SHARED_RECEIPT_KEY, JSON.stringify(sharedReceipt));
        else localStorage.removeItem(SHARED_RECEIPT_KEY);
        return sharedReceipt;
    },

    /** This phone's own receipt choices and logo (from before they were shared), or null when it has none. */
    ownReceipt() {
        const logo = this.localLogo();
        return hasOwnReceipt(this.settings(), logo) ? effectiveReceipt(this.settings(), null, logo) : null;
    },

    /** The logo the bill prints with, or null. */
    logo() {
        return this.receipt().logo;
    },

    /** The logo this phone saved for itself before receipts were shared. */
    localLogo() {
        try {
            return normalizeLogo(JSON.parse(localStorage.getItem(LOGO_KEY)));
        } catch {
            return null;
        }
    },

    /**
     * Turns a picture into a receipt logo: fitted into 384 × 120 dots and made black and white.
     * @param {HTMLImageElement|HTMLCanvasElement} image
     * @returns {{width: number, height: number, bits: string}|null}
     */
    makeLogo(image) {
        const { width, height } = logoSize(image.naturalWidth || image.width, image.naturalHeight || image.height);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
        const raster = packMonochromeRaster(ctx.getImageData(0, 0, width, height).data, width, height);
        let bin = '';
        raster.forEach((b) => { bin += String.fromCharCode(b); });
        return normalizeLogo({ width, height, bits: btoa(bin) });
    },

    /** The sample bill used by Test Print and the receipt preview in Settings. */
    sampleBill() {
        const lang = receiptLang(this.receipt());
        return {
            type: 'TEST',
            billNumber: 'TEST-1',
            date: new Date().toISOString(),
            customerName: t('ui.print.test_customer', undefined, lang),
            items: [
                { name: t('ui.print.test_item', undefined, lang), qty: 10, rate: 100, total: 1000, weights: [10] }
            ],
            billTotal: 1000,
            laborCharges: 6,
            totalPackets: 1,
            amountPayable: 1006,
            isPurchase: true,
            isAutoLabor: true
        };
    },

    /** Dots per line of the printer in use (58 mm unless set to 80 mm). */
    paperDots() {
        return paperDots(currentPrinter(this.settings())?.widthMm);
    },

    /**
     * Bluetooth is used when the link is up now or a saved printer is enabled,
     * unless the user pressed Disconnect (then bills go to the preview).
     */
    canPrint() {
        if (!this.isAvailable() || this.manager.link.stopped) return false;
        const saved = this.settings();
        return this.isConnected() || !!(saved.enabled && saved.deviceId);
    },

    /** Receipts that may have printed: { key: time }, kept 24 h across restarts. */
    uncertainJobs() {
        let map = {};
        try {
            map = JSON.parse(localStorage.getItem(UNCERTAIN_KEY)) || {};
        } catch {
            map = {};
        }
        const cutoff = Date.now() - UNCERTAIN_TTL_MS;
        return Object.fromEntries(Object.entries(map).filter(([, at]) => Number(at) > cutoff));
    },

    setUncertain(key, uncertain) {
        if (!key) return;
        const map = this.uncertainJobs();
        if (uncertain) map[key] = Date.now();
        else delete map[key];
        localStorage.setItem(UNCERTAIN_KEY, JSON.stringify(map));
    },

    /**
     * One print job. The may-have-printed check runs inside the job queue, so
     * a reprint queued behind an unanswered original still asks first.
     * @param {string|null} key Same key = same receipt
     * @param {(job: Object) => Promise} send
     * @param {'quick'|'full'} [mode='quick']
     * @returns {Promise<{outcome: 'printed'|'failed'|'uncertain'|'cancelled', error?: Error}>}
     */
    async runJob(key, send, mode = 'quick') {
        // TIP Print (#161): every print job, judged by how it ended.
        const run = tip.start('Print', { flags: { mode } });
        let res = { outcome: 'failed', error: { kind: 'exception' } };
        try {
            res = await this._runJobNow(key, send, mode);
            return res;
        } finally {
            this._completePrintRun(run, res, mode);
        }
    },

    /** @private A failed connect may just be Bluetooth off: ask (without holding up the caller) before reporting. */
    _completePrintRun(run, res, mode) {
        const kind = res.error?.kind;
        if (res.outcome !== 'failed' || (kind !== 'connect' && kind !== 'timeout_connect')) {
            run.complete(printProps(res.outcome, res.error, mode));
            return;
        }
        Promise.resolve()
            .then(() => this.manager.link.bluetoothOn())
            .then(on => (on ? res.error : { kind: 'bluetooth_off' }), () => res.error)
            .then(error => run.complete(printProps(res.outcome, error, mode)));
    },

    /** @private See runJob. */
    async _runJobNow(key, send, mode) {
        let release = UIManager.holdLoading();
        const confirmReprint = async () => {
            if (!key || !this.uncertainJobs()[key]) return true;
            release();
            const again = await UIManager.showModal(t('msg.printer.confirm_print_again'), t('ui.print.may_have_printed_title'), true);
            release = UIManager.holdLoading();
            return again;
        };
        try {
            const result = await send({
                target: this.target(),
                dots: this.paperDots(),
                receipt: this.receiptOptions(),
                mode,
                confirmReprint,
                onUncertain: () => this.setUncertain(key, true),
                onPrinted: () => this.setUncertain(key, false)
            });
            if (result?.outcome === 'cancelled') return { outcome: 'cancelled' };
            this.setUncertain(key, false);
            return { outcome: 'printed' };
        } catch (error) {
            if (error?.outcome === 'uncertain') {
                this.setUncertain(key, true);
                release();
                this.updateStatus();
                await UIManager.showModal(t('msg.printer.may_have_printed'), t('ui.print.may_have_printed_title'));
                return { outcome: 'uncertain', error };
            }
            return { outcome: 'failed', error };
        } finally {
            release();
            this.updateStatus();
        }
    },

    /** Last answer about the Bluetooth permission: 'granted' | 'denied' | 'unknown'. */
    permissionState: 'unknown',
    permissionBannerClosed: false,

    /** The Android permissions plugin, when the app runs on Android 12+ (else null). */
    _permissions() {
        const perms = typeof window !== 'undefined' ? window.cordova?.plugins?.permissions : null;
        if (!perms || typeof perms.checkPermission !== 'function' || !this.isAvailable()) return null;
        return getAndroidMajorVersion() >= 12 ? perms : null;
    },

    /**
     * Does Android let the app use the printer link (BLUETOOTH_CONNECT, Android 12+)? Never asks
     * the user; shows or hides the "Bluetooth permission needed" banner (#77).
     * @returns {Promise<'granted'|'denied'|'unknown'>} 'unknown' on the web, older Android or no plugin
     */
    async bluetoothPermission() {
        const perms = this._permissions();
        if (!perms) {
            if (this.permissionState !== 'unknown') this.setPermissionState('unknown');
            return 'unknown';
        }
        const name = perms.BLUETOOTH_CONNECT || CONNECT_PERMISSION;
        let timer;
        const state = await Promise.race([
            new Promise((resolve) => {
                try {
                    perms.checkPermission(name, (st) => resolve(st?.hasPermission ? 'granted' : 'denied'), () => resolve('unknown'));
                } catch {
                    resolve('unknown');
                }
            }),
            new Promise((resolve) => { timer = setTimeout(() => resolve('unknown'), PERMISSION_CHECK_MS); })
        ]);
        clearTimeout(timer);
        this.setPermissionState(state);
        return state;
    },

    /** Asks Android for the permission (system dialog). @returns {Promise<boolean>} granted */
    async requestBluetoothPermission() {
        const perms = this._permissions();
        if (!perms || typeof perms.requestPermission !== 'function') return false;
        const name = perms.BLUETOOTH_CONNECT || CONNECT_PERMISSION;
        const granted = await new Promise((resolve) => {
            try {
                perms.requestPermission(name, (r) => resolve(!!r?.hasPermission), () => resolve(false));
            } catch {
                resolve(false);
            }
        });
        this.setPermissionState(granted ? 'granted' : 'denied');
        if (!granted) UIManager.showToast(t('msg.printer.permission_in_settings'), 'warning');
        return granted;
    },

    /** @param {'granted'|'denied'|'unknown'} state */
    setPermissionState(state) {
        this.permissionState = state;
        if (state === 'granted') this.permissionBannerClosed = false;
        this.renderPermissionBanner();
        this.updateStatus();
    },

    /**
     * "Bluetooth permission needed" banner: shown while the permission is refused and a
     * printer is in use on this phone; Allow asks Android, × hides it until the app restarts.
     */
    renderPermissionBanner() {
        if (typeof document === 'undefined' || !document.body) return;
        let banner = document.getElementById('printerPermissionBanner');
        const saved = this.settings();
        const show = this.permissionState === 'denied' && !this.permissionBannerClosed && !!(saved.enabled && saved.deviceId);
        if (!show) {
            banner?.remove();
            return;
        }
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'printerPermissionBanner';
            banner.className = 'notice warn solid float printer-perm-notice';
            banner.setAttribute('role', 'alert');
            document.body.appendChild(banner);
        }
        banner.textContent = '';
        const text = document.createElement('span');
        text.className = 'grow';
        text.textContent = t('ui.printer.permission_banner');
        const allow = document.createElement('button');
        allow.type = 'button';
        allow.className = 'btn btn-sm btn-primary printer-perm-notice__allow';
        allow.textContent = t('ui.printer.permission_allow');
        allow.addEventListener('click', () => { this.requestBluetoothPermission().catch(e => console.warn('Permission request failed:', e)); });
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn btn-sm btn-ghost btn-icon printer-perm-notice__close';
        close.setAttribute('aria-label', t('ui.common.close'));
        close.textContent = '×';
        close.addEventListener('click', () => {
            this.permissionBannerClosed = true;
            this.renderPermissionBanner();
        });
        banner.append(text, allow, close);
    },

    /**
     * Printer link in one word for Settings and Diagnostics › Status (#119):
     * unavailable / bluetooth_off / connected / saved (a printer is saved but not
     * connected) / none, plus the last problem kind on this phone.
     */
    linkState() {
        const available = this.isAvailable();
        const connected = this.isConnected();
        const saved = this.settings();
        const { lastError, lastJob, bluetoothOff } = this.manager.link.status;
        const state = !available ? 'unavailable'
            : (!connected && bluetoothOff) ? 'bluetooth_off'
                : connected ? 'connected'
                    : saved.deviceId ? 'saved' : 'none';
        return { state, lastErrorKind: available ? (lastError?.kind || null) : null, mayHavePrinted: available && lastJob?.outcome === 'uncertain' };
    },

    /**
     * Settings → Bluetooth Printer status line and buttons, from the real
     * connection state (AadhatManagementApp#133), when it was last checked and
     * the last problem (#77).
     */
    updateStatus() {
        const statusText = document.getElementById('printerStatusText');
        const disconnectBtn = document.getElementById('disconnectBtn');
        const testPrintBtn = document.getElementById('testPrintBtn');
        const scanBtn = document.getElementById('scanPrintersBtn');
        const saved = this.settings();
        const available = this.isAvailable();
        const connected = this.isConnected();
        const name = this.manager.printerName || saved.deviceName || '';
        const { checkedAt, lastError, lastJob, bluetoothOff } = this.manager.link.status;
        const btOff = available && !connected && bluetoothOff;

        const noPermission = available && this.permissionState === 'denied';
        let text;
        let tone = 'tone-muted';
        if (!available) {
            text = t('ui.settings.printer_android_only');
        } else if (noPermission) {
            text = t('ui.settings.printer_permission_needed');
            tone = 'tone-warn';
        } else if (btOff) {
            text = t('ui.settings.printer_bluetooth_off');
        } else if (connected) {
            text = checkedAt
                ? t('ui.settings.printer_connected_checked', { deviceName: name, time: clockTime(checkedAt) })
                : t('ui.settings.printer_connected_to', { deviceName: name });
            tone = 'tone-pos';
        } else if (saved.deviceId && name) {
            text = t('ui.settings.printer_saved_not_connected', { deviceName: name });
        } else {
            text = t('ui.settings.printer_not_connected');
        }
        let detail = '';
        if (available && lastJob?.outcome === 'uncertain') {
            detail = t('ui.settings.printer_last_may_have_printed', { time: clockTime(lastJob.at) });
        } else if (available && lastError) {
            detail = t('ui.settings.printer_last_error', { message: this.errorText(lastError), time: clockTime(lastError.at) });
        }
        if (statusText) {
            statusText.innerHTML = `<span class="${tone}">${connected ? '●' : '○'} ${Helpers.escapeHtml(text)}</span>`
                + (detail ? `<br><small class="printer-status-detail">${Helpers.escapeHtml(detail)}</small>` : '');
            statusText.dataset.state = !available ? 'unavailable' : noPermission ? 'permission' : btOff ? 'bluetooth_off' : connected ? 'connected' : 'disconnected';
        }
        const show = (el, on) => { if (el) { el.hidden = !on; el.style.display = on ? '' : 'none'; } };
        show(disconnectBtn, connected);
        show(testPrintBtn, available && !btOff && (connected || saved.deviceId));
        show(scanBtn, available);
    },

    /** Renders the status now, then again once the plugin has checked Bluetooth and the link. */
    async refreshStatus() {
        this.updateStatus();
        if (!this.isAvailable()) return;
        await this.bluetoothPermission();
        await this.manager.link.bluetoothOn();
        if (this.isConnected()) await this.checkConnection();
        this.updateStatus();
    },

    async testPrint() {
        if (!this.isAvailable()) {
            await UIManager.showModal(t('msg.printer.android_app_only'));
            return false;
        }
        if (this.testing) return false;
        this.testing = true;
        try {
            await loadReceiptDrawing();
            const testBill = this.sampleBill();
            const { outcome, error } = await this.runJob('test', (job) => this.manager.write(testBill, job), 'full');
            if (outcome === 'printed') {
                UIManager.showToast(t('msg.printer.test_print_successful'));
                return true;
            }
            if (outcome === 'failed') {
                console.error('Test print error:', error);
                if (error?.kind === 'no_printer' || error?.kind === 'stopped') {
                    await UIManager.showModal(t('msg.settings.printer_not_connected'));
                } else {
                    UIManager.showToast(t('msg.common.test_print_failed', { message: this.errorText(error) }), 'error');
                }
            }
            return false;
        } finally {
            this.testing = false;
        }
    },

    /** Bluetooth printing needs the Android app (cordova bluetoothSerial plugin). */
    isAvailable() {
        return this.manager.link.transport.available();
    },

    /** Connected in this app session (the link is not kept across restarts). */
    isConnected() {
        return this.isAvailable() && !!this.manager.device;
    },

    /**
     * Asks the plugin whether the link is still up; clears the device when it
     * dropped (printer switched off / out of range).
     * @returns {Promise<boolean>}
     */
    async checkConnection() {
        if (!this.isConnected()) return false;
        return this.manager.link.check();
    },

    /**
     * @param {Object} billData
     * @param {{outcome?: ('printed'|'preview'|'failed'|'uncertain'|'cancelled'), error?: string}} [report]
     *   filled with what really happened, so the caller's toast says it (a preview is not a print)
     * @returns {Promise<boolean>}
     */
    async printBill(billData, report = {}) {
        if (this.canPrint() && this.settings().previewFirst) {
            return this.showBillPreview(billData, { onPrint: () => this._printBillNow(billData, 1, report) });
        }
        return this._printBillNow(billData, 1, report);
    },

    /**
     * @private Bluetooth when it can print, else the image preview. A failed try opens the
     * preview with Print, so the bill can be tried again once the printer is back (the
     * printer link itself makes one quick reconnect per try), up to BILL_PRINT_TRIES (#77).
     * @param {Object} billData
     * @param {number} [tries] this try's number
     * @param {Object} [report] see printBill
     */
    async _printBillNow(billData, tries = 1, report = {}) {
        if (this.canPrint()) {
            let outcome;
            let error;
            if (await this.bluetoothPermission() === 'denied') {
                outcome = 'failed';
                error = { kind: 'permission', message: 'Bluetooth permission needed' };
            } else {
                const key = jobKey('bill', billData.billNumber || billData.id);
                ({ outcome, error } = await this.runJob(key, (job) => loadReceiptDrawing().then(() => this.manager.write(billData, job))));
                if (error?.kind === 'permission' && this._permissions()) this.setPermissionState('denied');
            }
            if (outcome !== 'cancelled') recordPrint(billData, outcome, outcome === 'failed' ? { errorKind: error?.kind, error: error?.message } : {});
            report.outcome = outcome;
            if (outcome === 'printed') {
                track('print.bill');
                UIManager.showToast(t('msg.printer.printed_successfully'));
                return true;
            }
            if (outcome !== 'failed') return false;
            console.error('Bluetooth print failed:', error);
            report.error = this.errorText(error);
            const last = tries >= BILL_PRINT_TRIES;
            UIManager.showToast(last
                ? t('msg.printer.print_failed_last', { message: this.errorText(error), tries })
                : t('msg.printer.print_failed', { message: this.errorText(error) }));
            if (!last) return await this.showBillPreview(billData, { onPrint: () => this._retryBillPrint(billData, tries + 1, report) });
            await this.showBillPreview(billData);
            return false;
        }
        // No printer: the receipt is only shown as a picture
        const shown = await this.showBillPreview(billData);
        if (shown === true) report.outcome = 'preview';
        return shown;
    },

    /** @private Print from the preview after a failed try: asks Android first when the permission was refused. */
    async _retryBillPrint(billData, tries, report = {}) {
        // Still refused: keep the "allow it in Android settings" message and this try; the picture stays
        if (this.permissionState === 'denied' && !(await this.requestBluetoothPermission())) {
            return this.showBillPreview(billData, { onPrint: () => this._retryBillPrint(billData, tries, report) });
        }
        return this._printBillNow(billData, tries, report);
    },

    /**
     * @param {Object} billData
     * @param {{onPrint?: () => Promise<boolean>}} [options] adds a Print button (preview before print)
     */
    async showBillPreview(billData, options = {}) {
        try {
            await loadReceiptDrawing();
            // Generate canvas using the same method as Bluetooth printing
            const canvas = await this.manager.generateBillCanvas(billData, this.receiptOptions());
            const billType = billData.isPurchase ? 'purchase' : 'sale';
            const filename = `${billType}_bill_${billData.billNumber || billData.id || Date.now()}${billData.isCopy ? '_copy' : ''}.png`;
            return this.showImagePreview(canvas, filename, t('ui.bill.bill_no'), options);
        } catch (error) {
            console.error('Preview generation failed:', error);
            UIManager.showToast(t('msg.printer.failed_generate_bill_preview'));
            return false;
        }
    },

    /**
     * Read-only party statement (#77): print on the Bluetooth printer when
     * connected, otherwise show it as an image to save/share.
     * @param {Object} statement From buildStatement() in utils/due-reminder.js
     * @returns {Promise<boolean>}
     */
    async printStatement(statement) {
        if (this.canPrint()) {
            const key = jobKey('statement', statement.filename);
            const { outcome, error } = await this.runJob(key, (job) => loadReceiptDrawing().then(() => this.manager.writeStatement(statement, job)));
            if (outcome === 'printed') {
                UIManager.showToast(t('msg.printer.printed_successfully'));
                return true;
            }
            if (outcome !== 'failed') return false;
            console.error('Bluetooth statement print failed:', error);
            UIManager.showToast(t('msg.printer.print_failed', { message: this.errorText(error) }));
        }
        try {
            await loadReceiptDrawing();
            const canvas = this.manager.generateStatementCanvas(statement);
            return this.showImagePreview(canvas, statement.filename || 'statement.png', t('ui.print.statement'));
        } catch (error) {
            console.error('Statement preview failed:', error);
            UIManager.showToast(t('msg.printer.failed_generate_statement'));
            return false;
        }
    },

    /**
     * Any receipt already drawn on a 384 px canvas (e.g. a rent receipt): the
     * Bluetooth printer when connected, otherwise the image preview.
     * @returns {Promise<boolean>}
     */
    async printCanvas(canvas, filename, title) {
        if (this.canPrint()) {
            const { outcome, error } = await this.runJob(jobKey('canvas', filename), (job) => this.manager.sendCanvas(canvas, job));
            if (outcome === 'printed') {
                UIManager.showToast(t('msg.printer.printed_successfully'));
                return true;
            }
            if (outcome !== 'failed') return false;
            console.error('Bluetooth print failed:', error);
            UIManager.showToast(t('msg.printer.print_failed', { message: this.errorText(error) }));
        }
        return this.showImagePreview(canvas, filename, title);
    },

    /**
     * Full-screen image preview with Download (share sheet on phones) / Close,
     * and Print first when `onPrint` is given (preview before print, #130).
     * @param {HTMLCanvasElement} canvas
     * @param {string} filename
     * @param {string} [shareTitle='Bill']
     * @param {{onPrint?: () => Promise<boolean>}} [options]
     * @returns {boolean|Promise<boolean>} with onPrint: resolves with the print result, false on Close
     */
    showImagePreview(canvas, filename, shareTitle = t('ui.bill.bill_no'), { onPrint } = {}) {
        try {
            // Convert canvas to data URL
            const dataUrl = canvas.toDataURL('image/png');
            
            // Show in a modal or preview element
            const modal = document.createElement('div');
            modal.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.9);
                z-index: 10000;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                padding: 20px;
            `;
            
            const img = document.createElement('img');
            img.src = dataUrl;
            img.style.cssText = `
                max-width: 90%;
                max-height: 80vh;
                background: white;
                padding: 20px;
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            `;
            
            const buttonContainer = document.createElement('div');
            buttonContainer.style.cssText = `
                display: flex;
                gap: 10px;
                margin-top: 20px;
                justify-content: center;
            `;
            
            const downloadBtn = document.createElement('button');
            downloadBtn.textContent = t('ui.print.download');
            downloadBtn.style.cssText = `
                padding: 12px 24px;
                background: #15803d;
                color: white;
                border: none;
                border-radius: 8px;
                font-size: 16px;
                cursor: pointer;
                min-width: 140px;
            `;
            downloadBtn.onclick = async () => {
                // Create a new canvas with padding
                const padding = 20;
                const paddedCanvas = document.createElement('canvas');
                paddedCanvas.width = canvas.width + (padding * 2);
                paddedCanvas.height = canvas.height + (padding * 2);
                
                const paddedCtx = paddedCanvas.getContext('2d');
                paddedCtx.fillStyle = '#FFFFFF';
                paddedCtx.fillRect(0, 0, paddedCanvas.width, paddedCanvas.height);
                paddedCtx.drawImage(canvas, padding, padding);
                
                // Convert canvas to blob for better mobile support
                paddedCanvas.toBlob(async (blob) => {
                    if (!blob) {
                        UIManager.showToast(t('msg.printer.failed_generate_image'), 'error');
                        return;
                    }
                    
                    // Try Web Share API for mobile (allows saving to gallery)
                    if (navigator.share && navigator.canShare && navigator.canShare({ files: [new File([blob], filename, { type: 'image/png' })] })) {
                        try {
                            const file = new File([blob], filename, { type: 'image/png' });
                            await navigator.share({
                                files: [file],
                                title: shareTitle
                            });
                            return;
                        } catch (e) {
                            // User cancelled or share failed, fall through to download
                            if (e.name !== 'AbortError') {
                                console.warn('Share failed, trying download:', e);
                            }
                        }
                    }
                    
                    // Fallback: Create blob URL and download
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = filename;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    URL.revokeObjectURL(url);
                }, 'image/png');
            };
            
            const closeBtn = document.createElement('button');
            closeBtn.textContent = t('ui.common.close');
            closeBtn.style.cssText = `
                padding: 12px 24px;
                background: #0058b8;
                color: white;
                border: none;
                border-radius: 8px;
                font-size: 16px;
                cursor: pointer;
                min-width: 140px;
            `;
            closeBtn.onclick = () => document.body.removeChild(modal);
            
            buttonContainer.appendChild(downloadBtn);
            buttonContainer.appendChild(closeBtn);
            
            modal.appendChild(img);
            modal.appendChild(buttonContainer);

            let result = true;
            if (typeof onPrint === 'function') {
                const printBtn = document.createElement('button');
                printBtn.textContent = t('ui.print.print');
                printBtn.className = 'print-preview-print-btn';
                printBtn.style.cssText = closeBtn.style.cssText;
                printBtn.style.background = '#111827';
                buttonContainer.style.flexWrap = 'wrap';
                buttonContainer.insertBefore(printBtn, downloadBtn);
                result = new Promise((resolve) => {
                    const close = () => { if (modal.parentNode) modal.parentNode.removeChild(modal); };
                    closeBtn.onclick = () => { close(); resolve(false); };
                    printBtn.onclick = async () => {
                        close();
                        try {
                            resolve(await onPrint());
                        } catch (error) {
                            console.error('Print from preview failed:', error);
                            resolve(false);
                        }
                    };
                });
            }
            document.body.appendChild(modal);
            
            return result;
        } catch (error) {
            console.error('Preview failed:', error);
            UIManager.showToast(t('msg.printer.failed_generate_preview'));
            return false;
        }
    },

    async printExpense(expense) {
        if (this.canPrint()) {
            const { outcome, error } = await this.runJob(jobKey('expense', expense.id), (job) => loadReceiptDrawing().then(() => this.manager.writeExpense(expense, job)));
            if (outcome === 'printed') {
                UIManager.showToast(t('msg.printer.expense_printed_successfully'));
                return true;
            }
            if (outcome !== 'failed') return false;
            console.error('Bluetooth expense print failed:', error);
            UIManager.showToast(t('msg.printer.print_failed', { message: this.errorText(error) }));
        }
        return await this.showExpensePreview(expense);
    },
    
    async showExpensePreview(expense) {
        try {
            await loadReceiptDrawing();
            // Generate canvas for expense
            const canvas = await this.manager.generateExpenseCanvas(expense);
            
            // Convert canvas to data URL
            const dataUrl = canvas.toDataURL('image/png');
            
            // Show in a modal
            const modal = document.createElement('div');
            modal.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.9);
                z-index: 10000;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                padding: 20px;
            `;
            
            const img = document.createElement('img');
            img.src = dataUrl;
            img.style.cssText = `
                max-width: 90%;
                max-height: 80vh;
                background: white;
                padding: 20px;
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            `;
            
            const buttonContainer = document.createElement('div');
            buttonContainer.style.cssText = `
                display: flex;
                gap: 10px;
                margin-top: 20px;
                justify-content: center;
            `;
            
            const downloadBtn = document.createElement('button');
            downloadBtn.textContent = t('ui.print.download');
            downloadBtn.style.cssText = `
                padding: 12px 24px;
                background: #15803d;
                color: white;
                border: none;
                border-radius: 8px;
                font-size: 16px;
                cursor: pointer;
                min-width: 140px;
            `;
            downloadBtn.onclick = async () => {
                // Create a new canvas with padding
                const padding = 20;
                const paddedCanvas = document.createElement('canvas');
                paddedCanvas.width = canvas.width + (padding * 2);
                paddedCanvas.height = canvas.height + (padding * 2);
                
                const paddedCtx = paddedCanvas.getContext('2d');
                paddedCtx.fillStyle = '#FFFFFF';
                paddedCtx.fillRect(0, 0, paddedCanvas.width, paddedCanvas.height);
                paddedCtx.drawImage(canvas, padding, padding);
                
                const filename = `expense_${expense.id || Date.now()}.png`;
                
                // Convert canvas to blob for better mobile support
                paddedCanvas.toBlob(async (blob) => {
                    if (!blob) {
                        UIManager.showToast(t('msg.printer.failed_generate_image'), 'error');
                        return;
                    }
                    
                    // Try Web Share API for mobile (allows saving to gallery)
                    if (navigator.share && navigator.canShare && navigator.canShare({ files: [new File([blob], filename, { type: 'image/png' })] })) {
                        try {
                            const file = new File([blob], filename, { type: 'image/png' });
                            await navigator.share({
                                files: [file],
                                title: t('ui.today.expense')
                            });
                            return;
                        } catch (e) {
                            // User cancelled or share failed, fall through to download
                            if (e.name !== 'AbortError') {
                                console.warn('Share failed, trying download:', e);
                            }
                        }
                    }
                    
                    // Fallback: Create blob URL and download
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = filename;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    URL.revokeObjectURL(url);
                }, 'image/png');
            };
            
            const closeBtn = document.createElement('button');
            closeBtn.textContent = t('ui.common.close');
            closeBtn.style.cssText = `
                padding: 12px 24px;
                background: #0058b8;
                color: white;
                border: none;
                border-radius: 8px;
                font-size: 16px;
                cursor: pointer;
                min-width: 140px;
            `;
            closeBtn.onclick = () => document.body.removeChild(modal);
            
            buttonContainer.appendChild(downloadBtn);
            buttonContainer.appendChild(closeBtn);
            
            modal.appendChild(img);
            modal.appendChild(buttonContainer);
            
            document.body.appendChild(modal);
            
            // Close on background click
            modal.onclick = (e) => {
                if (e.target === modal) {
                    document.body.removeChild(modal);
                }
            };
            
            return true;
        } catch (error) {
            console.error('Failed to show expense preview:', error);
            UIManager.showToast(t('msg.printer.failed_generate_preview_2', { message: error.message }));
            return false;
        }
    },

    /**
     * The toast after Save & Print (S-12): the save's own words and, separately, what
     * happened to the print. A receipt only shown as a picture (no printer) or a failed
     * print is never called "printed"; "may have printed" / cancelled leave the last toast.
     * @param {{printed: boolean, report: {outcome?: string, error?: string}, savedText: string, printedText: string}} status
     */
    showSavePrintStatus({ printed, report, savedText, printedText }) {
        if (report?.outcome === 'preview') {
            UIManager.showToast(t('msg.printer.saved_not_printed_preview', { saved: savedText }), 'warning', 6000);
        } else if (report?.outcome === 'failed' && printed !== true) {
            UIManager.showToast(t('msg.printer.saved_not_printed', { saved: savedText, reason: report.error || '' }), 'warning', 6000);
        } else if (printed === true) {
            UIManager.showToast(printedText);
        }
    },

    async printWholesaleSale(saleData, report = {}) {
        // The walk-in name below is in the receipt language; a failed load is reported by printBill
        await loadReceiptDrawing().catch(() => {});
        // Convert sale data to bill format for printing
        const billData = {
            id: saleData.id || Date.now(),
            billNumber: saleData.billNumber,
            customerName: saleData.customerName || t('ui.print.walk_in_customer', undefined, receiptLang(this.receipt())),
            items: saleData.items.map(item => ({
                name: item.name,
                rate: item.rate,
                qty: item.qty || item.quantity,
                total: item.total
            })),
            total: saleData.total,
            saleTotal: saleData.total,
            grandTotal: saleData.total,
            amountPayable: saleData.total,
            totals: {
                billTotal: saleData.total,
                labor: 0,
                payable: saleData.total
            },
            payment: saleData.payment || {
                online: 0,
                cash: 0,
                due: saleData.total
            },
            payments: {
                online: 0,
                cash: 0,
                due: saleData.total
            },
            comments: saleData.comments || '',
            date: saleData.date || new Date().toLocaleString('en-IN'),
            mode: 'sale',
            isPurchase: false
        };

        // Use the standard printBill method
        return await this.printBill(billData, report);
    }
};

PrinterService.manager.link.onChange = () => PrinterService.updateStatus();
PrinterService.manager.link.stopped = localStorage.getItem(STOPPED_KEY) === '1';

const printerManager = PrinterService.manager;

// Export PrinterService and manager
export { PrinterService, BluetoothPrinterManager, printerManager };
