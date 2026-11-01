// -------------------- BLUETOOTH PRINTER MANAGER --------------------

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { DEFAULT_SETTINGS } from '../utils/constants.js';
import { getAndroidMajorVersion, Helpers } from '../utils/helpers.js';
import { billQrText, copyMark, receiptDateTime, receiptPayable } from '../utils/bill-share.js';
import { billLabour, billLineTotal, outstandingDue, readPayment } from '../utils/money.js';
import { parseAnyBillDate } from '../utils/dates.js';
import { t, tn } from '../i18n/index.js';
import { PrinterLink } from './printer-link.js';
import { track } from './usage.js';
import { tip } from '../tip/index.js';
import { printProps } from '../tip/scenarios/print.js';
import { recordPrint } from '../utils/print-status.js';
import {
    currentPrinter, effectiveReceipt, hasOwnReceipt, logoSize, normalizeLogo, normalizePrinterSettings, normalizeSharedReceipt,
    PAPER_DOTS, paperDots, rasterThreshold, receiptLang
} from '../utils/printer-settings.js';
import { encodeQr } from '../utils/qr-code.js';
import { safeSetItem } from '../utils/storage-full.js';

/** Dots darker than this (average of R,G,B) print black */
const RASTER_THRESHOLD = 128;
/** Receipts are laid out for 58 mm paper; wider paper scales them up. */
const LAYOUT_DOTS = PAPER_DOTS[58];

const jobKey = (kind, id) => (id ? `${kind}:${id}` : null);
const UNCERTAIN_KEY = 'printerMayHavePrinted';
const UNCERTAIN_TTL_MS = 24 * 60 * 60 * 1000;
const STOPPED_KEY = 'printerDisconnected';
const LOGO_KEY = 'receiptLogo';
const SHARED_RECEIPT_KEY = 'receiptShared';

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
 * Returns a standalone Uint8Array (byteOffset 0) because bluetoothSerial.write
 * sends `data.buffer`.
 * @param {Uint8Array} raster - Output of packMonochromeRaster
 * @param {number} bytesPerLine
 * @param {number} height - Height in dots
 * @returns {Uint8Array}
 */
export function buildRasterPrintCommand(raster, bytesPerLine, height) {
    const header = [
        0x1B, 0x40,
        0x1B, 0x61, 0x01,
        0x1D, 0x76, 0x30, 0x00,
        bytesPerLine & 0xFF, (bytesPerLine >> 8) & 0xFF,
        height & 0xFF, (height >> 8) & 0xFF
    ];
    const trailer = [
        0x1B, 0x64, 0x03,
        0x1D, 0x56, 0x41, 0x03
    ];
    const out = new Uint8Array(header.length + raster.length + trailer.length);
    out.set(header, 0);
    out.set(raster, header.length);
    out.set(trailer, header.length + raster.length);
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
function canvasToEscPos(canvas, height = canvas.height, dots = canvas.width, threshold = RASTER_THRESHOLD) {
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

/** Logo bits (packMonochromeRaster layout, base64) as a black-on-white canvas. */
function logoCanvas(logo) {
    const bin = atob(logo.bits);
    const bytesPerLine = (logo.width + 7) >> 3;
    const canvas = document.createElement('canvas');
    canvas.width = logo.width;
    canvas.height = logo.height;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(logo.width, logo.height);
    for (let y = 0; y < logo.height; y++) {
        for (let x = 0; x < logo.width; x++) {
            const black = (bin.charCodeAt(y * bytesPerLine + (x >> 3)) & (0x80 >> (x & 7))) !== 0;
            const p = (y * logo.width + x) * 4;
            img.data[p] = img.data[p + 1] = img.data[p + 2] = black ? 0 : 255;
            img.data[p + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
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

    _createDrawingUtils(ctx, config) {
        return {
            drawCenter: (text, y, font, bold = false) => {
                ctx.font = `${bold ? 'bold ' : ''}${font.size}px Arial`;
                ctx.fillStyle = '#000000';
                const textWidth = ctx.measureText(text).width;
                ctx.fillText(text, (config.width - textWidth) / 2, y);
                return y + font.size + config.spacing.tiny;
            },
            
            drawLeft: (text, y, font) => {
                ctx.font = `${font.weight} ${font.size}px Arial`;
                ctx.fillStyle = '#000000';
                ctx.fillText(text, 2, y);
                return y + font.size + config.spacing.tiny;
            },
            
            drawLine: (y, thickness = 2, sidePadding = 10) => {
                ctx.fillStyle = '#000000';
                ctx.fillRect(sidePadding, y, config.width - sidePadding * 2, thickness);
                return y;
            },
            
            drawRow: (texts, y, font, alignments = ['left']) => {
                ctx.font = `${font.weight} ${font.size}px Arial`;
                ctx.fillStyle = '#000000';
                texts.forEach((text, i) => {
                    ctx.textAlign = alignments[i] || 'left';
                    ctx.fillText(text, Object.values(config.columns)[i], y);
                });
                ctx.textAlign = 'left';
                return y + config.spacing.line;
            }
        };
    }

    _drawWeightsBreakdown(ctx, billData, utils, y) {
        ctx.font = `${DEFAULT_SETTINGS.fontSize || 18}px Arial`;
        
        billData.items.forEach(item => {
            if (item.weights && item.weights.length > 1) {
                const itemObj = AppState.items.find(i => i.id === item.itemId || i.name === item.name);
                const displayName = this._itemName(itemObj, item);
                
                y = utils.drawLeft(`${displayName} (${this._tn('ui.print.packets_kg', item.weights.length, { kg: item.qty.toFixed(1) })})`, y, { size: 18, weight: 'bold' });
                
                const weightsText = item.weights.map(w => parseFloat(w).toFixed(1)).join('  ');
                const maxWidth = 380;
                ctx.font = '17px Arial';
                const words = weightsText.split(' ');
                let line = '';
                
                for (let i = 0; i < words.length; i++) {
                    const testLine = line + (line ? ' ' : '') + words[i];
                    const metrics = ctx.measureText(testLine);
                    
                    if (metrics.width > maxWidth && line) {
                        y = utils.drawLeft(line, y, { size: 16, weight: 'normal' });
                        line = words[i];
                    } else {
                        line = testLine;
                    }
                }
                if (line) {
                    y = utils.drawLeft(line, y, { size: 16, weight: 'normal' });
                }
                y += 10;
            }
        });
        
        return y;
    }

    /** Receipt text in the receipt language (#107; undefined = the app language). */
    _t(key, params) {
        return t(key, params, this._receipt?.lang);
    }

    _tn(key, count, params) {
        return tn(key, count, params, this._receipt?.lang);
    }

    get _lang() {
        return this._receipt?.lang;
    }

    /** Item name on the slip: the Hindi name when there is one, except on an English receipt. */
    _itemName(itemObj, item) {
        if (this._receipt?.lang !== 'en' && itemObj?.hindiName) return itemObj.hindiName;
        return item.name;
    }

    /** Footer line and bill QR (#107), below the totals. */
    _drawReceiptFooter(ctx, billData, config, utils, y) {
        const { footer, qr } = this._receipt || {};
        if (footer) {
            y += config.spacing.section;
            ctx.font = `${config.fonts.subtext.size}px Arial`;
            const lines = [];
            let line = '';
            for (const word of footer.split(' ')) {
                const next = line ? `${line} ${word}` : word;
                if (line && ctx.measureText(next).width > config.width - 8) {
                    lines.push(line);
                    line = word;
                } else {
                    line = next;
                }
            }
            if (line) lines.push(line);
            lines.forEach((l) => { y = utils.drawCenter(l, y, config.fonts.subtext); });
        }
        const text = qr ? billQrText(billData) : '';
        const code = text ? encodeQr(text) : null;
        if (code) {
            const quiet = 4;
            const modulePx = Math.min(5, Math.floor(config.width * 0.6 / (code.size + quiet * 2)));
            const side = (code.size + quiet * 2) * modulePx;
            const left = Math.round((config.width - side) / 2);
            const top = y + config.spacing.small - 16;
            ctx.fillStyle = '#000000';
            for (let r = 0; r < code.size; r++) {
                for (let c = 0; c < code.size; c++) {
                    if (code.modules[r][c]) ctx.fillRect(left + (c + quiet) * modulePx, top + (r + quiet) * modulePx, modulePx, modulePx);
                }
            }
            y = top + side + 16;
        }
        return y;
    }

    _drawReceiptHeader(ctx, billData, config, utils, y) {
        const logo = this._receipt?.logo;
        if (logo) {
            ctx.drawImage(logoCanvas(logo), Math.round((config.width - logo.width) / 2), y - 16, logo.width, logo.height);
            y += logo.height + 4;
        }
        // Settings › Aadhat: business name and one line of details, when set
        const name = String(AppState.settings?.shopName || '').trim();
        const details = String(AppState.settings?.businessDetails || '').trim();
        if (name) y = utils.drawCenter(name, y, config.fonts.header, true);
        if (details) y = utils.drawCenter(details, y, config.fonts.small);
        y = utils.drawCenter(this._t('ui.print.receipt'), y, config.fonts.title, true);
        if (billData.isCopy) {
            y = utils.drawCenter(copyMark(this._lang), y, config.fonts.header, true);
        }
        
        // Bill number on left, the bill's own date/time on right (same line)
        const dateTime = receiptDateTime(billData);
        
        if (billData.billNumber) {
            // Draw bill number on left
            ctx.font = '17px Arial';
            ctx.fillText(`${this._t('ui.bill.bill_no')}: ${billData.billNumber}`, config.padding.side, y);
            
            // Draw date/time on right
            const dateWidth = ctx.measureText(dateTime).width;
            ctx.fillText(dateTime, config.width - dateWidth - config.padding.side, y);
            
            y += config.spacing.line;
        } else {
            // If no bill number, center the date/time
            y = utils.drawCenter(dateTime, y, config.fonts.subtext);
        }
        y += config.spacing.section;
        
        return y;
    }

    _drawCustomerInfo(billData, utils, y) {
        if (billData.customerName) {
            y = utils.drawLeft(`${this._t('ui.bill.customer')}: ${billData.customerName}`, y, { size: 18, weight: 'normal' });
            y += 8;
        }
        return y;
    }

    _drawItemsTable(ctx, billData, config, utils, y) {
        // Table header
        ctx.font = `bold ${config.fonts.header.size}px Arial`;
        ctx.fillStyle = '#000000';
        ctx.textAlign = 'left';
        ctx.fillText(this._t('ui.print.th_item'), config.columns.item, y);
        ctx.fillText(this._t('ui.print.th_rate'), config.columns.rate, y);
        ctx.fillText(this._t('ui.print.th_qty'), config.columns.quantity, y);
        ctx.fillText(this._t('ui.print.th_total'), config.columns.total, y);
        y += config.spacing.line;
        
        // Items
        ctx.font = `${config.fonts.body.size}px Arial`;
        billData.items.forEach(item => {
            const itemObj = AppState.items.find(i => i.id === item.itemId || i.name === item.name);
            const displayName = this._itemName(itemObj, item);
            
            ctx.textAlign = 'left';
            ctx.fillText(displayName.substring(0, 11), config.columns.item, y);
            ctx.fillText(item.rate.toString(), config.columns.rate, y);
            ctx.fillText((item.qty || 0).toFixed(1), config.columns.quantity, y);
            ctx.fillText(Math.round(item.total).toString(), config.columns.total, y);
            y += config.spacing.line;
        });
        
        // Add spacing before totals
        y += 12;
        
        return y;
    }

    _drawTotalsSection(ctx, billData, config, utils, y) {
        ctx.font = `${config.fonts.body.size}px Arial`;
        ctx.fillStyle = '#000000';
        ctx.textAlign = 'left';
        
        // BILL-LINES: the lines before labour (purchases), the sale total (sales)
        const subtotal = billLineTotal(billData, !!billData.isPurchase);
        
        // Subtotal
        ctx.fillText(`${this._t('ui.bill.total')}:`, config.padding.left, y);
        const totalText = '₹' + Math.round(subtotal);
        const totalWidth = ctx.measureText(totalText).width;
        ctx.fillText(totalText, config.width - totalWidth - config.padding.left, y);
        y += config.spacing.line;
        
        // Labor charges (only for purchases)
        if (billData.isPurchase && billLabour(billData) > 0) {
            if (billData.laborCalc) {
                // Show calculation in middle and amount on right
                ctx.fillText(`${this._t('ui.bill.labour')}:`, config.padding.left, y);
                const calcWidth = ctx.measureText(billData.laborCalc).width;
                const calcX = (config.width - calcWidth) / 2;
                ctx.fillText(billData.laborCalc, calcX, y);
                const laborText = `₹${billLabour(billData)}`;
                const laborWidth = ctx.measureText(laborText).width;
                ctx.fillText(laborText, config.width - laborWidth - config.padding.left, y);
            } else {
                // No calculation, just show amount
                ctx.fillText(`${this._t('ui.bill.labour')}:`, config.padding.left, y);
                const laborText = `₹${billLabour(billData)}`;
                const laborWidth = ctx.measureText(laborText).width;
                ctx.fillText(laborText, config.width - laborWidth - config.padding.left, y);
            }
            y += config.spacing.line;
        }
        
        // Add spacing before grand total
        y += 8;
        
        // Grand total - Total bill amount
        ctx.font = `bold ${config.fonts.total.size}px Arial`;
        const grandTotalLabel = `${this._t('ui.bill.total')}:`;
        ctx.fillText(grandTotalLabel, config.padding.left, y);
        const amountPayable = receiptPayable(billData);
        const payableText = '₹' + Math.round(amountPayable);
        const payableWidth = ctx.measureText(payableText).width;
        ctx.fillText(payableText, config.width - payableWidth - config.padding.left, y);
        y += config.spacing.line;
        
        // BILL-PAY: nested payment.* wins over the old top-level fields, even when 0
        const totalReceived = readPayment(billData).paid;
        
        // Total Received (कुल प्राप्त / कुल भुगतान)
        y += 4;
        ctx.font = `${config.fonts.body.size}px Arial`;
        const receivedLabel = `${this._t(billData.isPurchase ? 'ui.print.total_paid' : 'ui.print.total_received')}:`;
        ctx.fillText(receivedLabel, config.padding.left, y);
        const receivedText = '₹' + Math.round(totalReceived);
        const receivedWidth = ctx.measureText(receivedText).width;
        ctx.fillText(receivedText, config.width - receivedWidth - config.padding.left, y);
        y += config.spacing.line;
        
        // Due amount (बकाया)
        const dueAmount = outstandingDue(billData);
        if (dueAmount > 0) {
            y += 4; // Small gap
            ctx.font = `bold ${config.fonts.body.size}px Arial`;
            ctx.fillText(`${this._t('ui.bill.due')}:`, config.padding.left, y);
            const dueText = '₹' + Math.round(dueAmount);
            const dueWidth = ctx.measureText(dueText).width;
            ctx.fillText(dueText, config.width - dueWidth - config.padding.left, y);
            y += config.spacing.line;
        }
        
        // Comments - Only print if printComments flag is true and comments exist
        if (billData.printComments && billData.comments && billData.comments.trim()) {
            y += 8; // Gap before comments
            ctx.font = `${config.fonts.body.size}px Arial`;
            
            // Print "Note: <comment>" on the same line, with word wrap if needed
            const noteLabel = `${this._t('ui.bill.note')}: `;
            const labelWidth = ctx.measureText(noteLabel).width;
            const maxWidth = config.width - config.padding.left - 10;
            const commentText = billData.comments.trim();
            
            // Check if it fits on one line
            const fullText = noteLabel + commentText;
            if (ctx.measureText(fullText).width <= maxWidth) {
                // Fits on one line
                ctx.fillText(fullText, config.padding.left, y);
                y += config.spacing.line;
            } else {
                // Need word wrap - print label first, then wrap remaining text
                ctx.fillText(noteLabel, config.padding.left, y);
                const remainingWidth = maxWidth - labelWidth;
                const words = commentText.split(' ');
                let line = '';
                let firstLine = true;
                
                for (const word of words) {
                    const testLine = line + (line ? ' ' : '') + word;
                    const currentMaxWidth = firstLine ? remainingWidth : maxWidth;
                    const testWidth = ctx.measureText(testLine).width;
                    
                    if (testWidth > currentMaxWidth && line) {
                        if (firstLine) {
                            ctx.fillText(line, config.padding.left + labelWidth, y);
                            firstLine = false;
                        } else {
                            ctx.fillText(line, config.padding.left, y);
                        }
                        y += config.spacing.line - 4;
                        line = word;
                    } else {
                        line = testLine;
                    }
                }
                if (line) {
                    if (firstLine) {
                        ctx.fillText(line, config.padding.left + labelWidth, y);
                    } else {
                        ctx.fillText(line, config.padding.left, y);
                    }
                    y += config.spacing.line;
                }
            }
        }
        
        return y;
    }

    /**
     * The receipt as shown in the preview / saved as an image (58 mm layout).
     * @param {Object} billData
     * @param {Object} [receipt] footer, qr, lang, logo (#107)
     */
    async generateBillCanvas(billData, receipt) {
        const { canvas, height } = this._renderBillCanvas(billData, LAYOUT_DOTS, receipt);
        
        // Crop to the used height (needed for the on-screen preview / PNG)
        const finalCanvas = document.createElement('canvas');
        finalCanvas.width = canvas.width;
        finalCanvas.height = height;
        const finalCtx = finalCanvas.getContext('2d');
        
        // Copy only the used portion from temp canvas
        finalCtx.drawImage(canvas, 0, 0, canvas.width, height, 0, 0, canvas.width, height);
        
        return finalCanvas;
    }

    /**
     * Draw the receipt onto an oversized canvas `dots` wide; the 58 mm layout
     * is drawn scaled, so text stays sharp on 80 mm paper.
     * @param {Object} billData
     * @param {number} [dots=384]
     * @param {{footer?: string, qr?: boolean, lang?: string, logo?: Object}} [receipt] what the slip shows (#107)
     * @returns {{canvas: HTMLCanvasElement, height: number}} canvas and used height
     * @private
     */
    _renderBillCanvas(billData, dots = LAYOUT_DOTS, receipt = {}) {
        const config = {
            width: LAYOUT_DOTS,
            padding: { left: 0, right: 0, side: 0 },
            fonts: {
                title: { size: 26, weight: 'bold' },
                header: { size: 20, weight: 'bold' },
                body: { size: 19, weight: 'normal' },
                subtext: { size: 18, weight: 'normal' },
                small: { size: 16, weight: 'normal' },
                total: { size: 21, weight: 'bold' }
            },
            columns: { item: 2, rate: 100, quantity: 190, total: 320 },
            spacing: { line: 24, section: 12, small: 8, tiny: 6 },
            lines: { thin: 1.5, normal: 2, bold: 3 }
        };

        // Create temporary canvas
        const scale = dots / LAYOUT_DOTS;
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        tempCanvas.width = dots;
        tempCanvas.height = Math.ceil(2600 * scale);
        
        // Initialize with white background
        tempCtx.fillStyle = '#ffffff';
        tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
        tempCtx.fillStyle = '#000000';
        if (scale !== 1) tempCtx.scale(scale, scale);
        
        // Drawing utilities
        const utils = this._createDrawingUtils(tempCtx, config);
        this._receipt = receipt || {};
        let y = 20;

        // Draw receipt sections
        try {
            y = this._drawWeightsBreakdown(tempCtx, billData, utils, y);
            y += config.spacing.section;

            y = this._drawReceiptHeader(tempCtx, billData, config, utils, y);
            y = this._drawCustomerInfo(billData, utils, y);
            y = this._drawItemsTable(tempCtx, billData, config, utils, y);
            y = this._drawTotalsSection(tempCtx, billData, config, utils, y);
            y = this._drawReceiptFooter(tempCtx, billData, config, utils, y);
        } finally {
            this._receipt = null;
        }
        
        return { canvas: tempCanvas, height: Math.ceil(y * scale) };
    }

    /** ESC/POS raster bytes for a bill (the used rows of the render canvas), `dots` wide. */
    billBytes(billData, dots = LAYOUT_DOTS, receipt = {}) {
        const { canvas, height } = this._renderBillCanvas(billData, dots, receipt);
        return canvasToEscPos(canvas, height, canvas.width, receipt?.threshold);
    }

    async write(billData, job) {
        return this._send(this.billBytes(billData, job?.dots, job?.receipt), 'WRITE', job);
    }
    
    async generateExpenseCanvas(expense) {
        const config = {
            width: 384,
            padding: { left: 0, right: 0, top: 0, bottom: 0 },
            fonts: {
                header: { size: 24, weight: 'bold' },
                body: { size: 18, weight: 'normal' },
                total: { size: 22, weight: 'bold' }
            },
            spacing: {
                line: 28,
                section: 16
            }
        };
        
        const canvas = document.createElement('canvas');
        canvas.width = config.width;
        
        // Calculate height needed
        let estimatedHeight = 300; // Base height for expense
        canvas.height = estimatedHeight;
        
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000000';
        
        let y = 30;
        
        // Receipt Header
        ctx.font = `bold ${config.fonts.header.size}px Arial`;
        ctx.textAlign = 'center';
        ctx.fillText(t('ui.print.receipt'), config.width / 2, y);
        y += config.fonts.header.size + 10;
        
        // Date and Time
        ctx.font = `${config.fonts.body.size}px Arial`;
        let dateTime;
        // A DD/MM/YYYY or YYYY-MM-DD date is local time (#80); today when it can't be read
        const expenseDate = parseAnyBillDate(expense.timestamp || expense.date) || new Date();
        
        dateTime = expenseDate.toLocaleString('en-IN', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
        
        ctx.fillText(dateTime, config.width / 2, y);
        y += config.spacing.line + 10;
        
        // Content in Hindi
        ctx.textAlign = 'left';
        ctx.font = `${config.fonts.body.size}px Arial`;
        
        // Type
        ctx.fillText(`${t('ui.print.type')}:`, 10, y);
        ctx.fillText(expense.type, 120, y);
        y += config.spacing.line;
        
        // Amount
        ctx.font = `bold ${config.fonts.total.size}px Arial`;
        ctx.fillText(`${t('ui.print.amount')}:`, 10, y);
        ctx.fillText(`₹${expense.amount}`, 120, y);
        y += config.spacing.line + 5;
        
        ctx.font = `${config.fonts.body.size}px Arial`;
        
        // Person (if available)
        if (expense.personName) {
            ctx.fillText(`${t('ui.print.name')}:`, 10, y);
            ctx.fillText(expense.personName, 120, y);
            y += config.spacing.line;
        }
        
        y += 20;
        
        // Adjust canvas height to actual content
        const finalCanvas = document.createElement('canvas');
        finalCanvas.width = config.width;
        finalCanvas.height = y;
        
        const finalCtx = finalCanvas.getContext('2d');
        finalCtx.fillStyle = '#FFFFFF';
        finalCtx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
        finalCtx.drawImage(canvas, 0, 0);
        
        return finalCanvas;
    }
    
    async writeExpense(expense, job) {
        const finalCanvas = await this.generateExpenseCanvas(expense);
        return this._send(canvasToEscPos(finalCanvas, finalCanvas.height, job?.dots, job?.receipt?.threshold), 'WRITE EXPENSE', job);
    }

    /**
     * Draw a read-only party statement (#77) on a 58 mm receipt canvas.
     * @param {Object} statement From buildStatement() in utils/due-reminder.js
     * @returns {HTMLCanvasElement} cropped to the used height
     */
    generateStatementCanvas(statement) {
        const width = 384;
        const side = 4;
        const rows = statement.rows || [];
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = 340 + rows.length * 26;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, canvas.height);
        ctx.fillStyle = '#000000';

        const center = (text, y, size, bold = false) => {
            ctx.font = `${bold ? 'bold ' : ''}${size}px Arial`;
            ctx.textAlign = 'center';
            ctx.fillText(text, width / 2, y);
            ctx.textAlign = 'left';
            return y + size + 8;
        };
        const leftRight = (left, right, y, size, bold = false) => {
            ctx.font = `${bold ? 'bold ' : ''}${size}px Arial`;
            ctx.textAlign = 'left';
            ctx.fillText(left, side, y);
            ctx.textAlign = 'right';
            ctx.fillText(right, width - side, y);
            ctx.textAlign = 'left';
            return y + size + 8;
        };
        const rule = (y) => {
            ctx.fillRect(side, y, width - side * 2, 2);
            return y + 10;
        };
        const rupees = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');

        let y = 30;
        if (statement.shopName) y = center(statement.shopName, y, 24, true);
        y = center(statement.title, y, 22, true);
        y = center(statement.partyName, y, 20, true);
        if (statement.asOf) y = center(`${t('ui.print.as_on')}: ${statement.asOf}`, y, 17);
        y = rule(y + 2);
        y = leftRight(`${t('ui.bill.bill_no')} · ${t('ui.bill.date')}`, t('ui.bill.due'), y + 8, 16, true);
        rows.forEach(r => {
            const left = [r.billNumber ? `#${r.billNumber}` : '', r.date].filter(Boolean).join('  ');
            y = leftRight(left.slice(0, 30), rupees(r.due), y, 17);
        });
        y = rule(y);
        y = leftRight(statement.totalLabel, rupees(statement.total), y + 12, 20, true);
        if (statement.footer) y = center(statement.footer, y + 6, 15);
        y += 6;

        const out = document.createElement('canvas');
        out.width = width;
        out.height = Math.min(y, canvas.height);
        const outCtx = out.getContext('2d');
        outCtx.fillStyle = '#ffffff';
        outCtx.fillRect(0, 0, width, out.height);
        outCtx.drawImage(canvas, 0, 0);
        return out;
    }

    async writeStatement(statement, job) {
        const canvas = this.generateStatementCanvas(statement);
        return this._send(canvasToEscPos(canvas, canvas.height, job?.dots, job?.receipt?.threshold), 'WRITE STATEMENT', job);
    }
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
            bluetooth_off: 'msg.printer.bluetooth_off'
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

        let text;
        let color = '#999';
        if (!available) {
            text = t('ui.settings.printer_android_only');
        } else if (btOff) {
            text = t('ui.settings.printer_bluetooth_off');
        } else if (connected) {
            text = checkedAt
                ? t('ui.settings.printer_connected_checked', { deviceName: name, time: clockTime(checkedAt) })
                : t('ui.settings.printer_connected_to', { deviceName: name });
            color = '#4CAF50';
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
            statusText.innerHTML = `<span style="color: ${color};">${connected ? '●' : '○'} ${Helpers.escapeHtml(text)}</span>`
                + (detail ? `<br><small class="printer-status-detail">${Helpers.escapeHtml(detail)}</small>` : '');
            statusText.dataset.state = !available ? 'unavailable' : btOff ? 'bluetooth_off' : connected ? 'connected' : 'disconnected';
        }
        if (disconnectBtn) disconnectBtn.style.display = connected ? 'block' : 'none';
        if (testPrintBtn) testPrintBtn.style.display = available && !btOff && (connected || saved.deviceId) ? 'block' : 'none';
        if (scanBtn) scanBtn.style.display = available ? '' : 'none';
    },

    /** Renders the status now, then again once the plugin has checked Bluetooth and the link. */
    async refreshStatus() {
        this.updateStatus();
        if (!this.isAvailable()) return;
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

    async printBill(billData) {
        if (this.canPrint() && this.settings().previewFirst) {
            return this.showBillPreview(billData, { onPrint: () => this._printBillNow(billData) });
        }
        return this._printBillNow(billData);
    },

    /** @private Bluetooth when it can print, else the image preview. */
    async _printBillNow(billData) {
        if (this.canPrint()) {
            const key = jobKey('bill', billData.billNumber || billData.id);
            const { outcome, error } = await this.runJob(key, (job) => this.manager.write(billData, job));
            if (outcome !== 'cancelled') recordPrint(billData, outcome, outcome === 'failed' ? { errorKind: error?.kind, error: error?.message } : {});
            if (outcome === 'printed') {
                track('print.bill');
                UIManager.showToast(t('msg.printer.printed_successfully'));
                return true;
            }
            if (outcome !== 'failed') return false;
            console.error('Bluetooth print failed:', error);
            UIManager.showToast(t('msg.printer.print_failed', { message: this.errorText(error) }));
        }
        return await this.showBillPreview(billData);
    },

    /**
     * @param {Object} billData
     * @param {{onPrint?: () => Promise<boolean>}} [options] adds a Print button (preview before print)
     */
    async showBillPreview(billData, options = {}) {
        try {
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
            const { outcome, error } = await this.runJob(key, (job) => this.manager.writeStatement(statement, job));
            if (outcome === 'printed') {
                UIManager.showToast(t('msg.printer.printed_successfully'));
                return true;
            }
            if (outcome !== 'failed') return false;
            console.error('Bluetooth statement print failed:', error);
            UIManager.showToast(t('msg.printer.print_failed', { message: this.errorText(error) }));
        }
        try {
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
                background: #22c55e;
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
                background: #007bff;
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
            const { outcome, error } = await this.runJob(jobKey('expense', expense.id), (job) => this.manager.writeExpense(expense, job));
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
                background: #22c55e;
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
                background: #007bff;
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

    async printWholesaleSale(saleData) {
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
        return await this.printBill(billData);
    }
};

PrinterService.manager.link.onChange = () => PrinterService.updateStatus();
PrinterService.manager.link.stopped = localStorage.getItem(STOPPED_KEY) === '1';

const printerManager = PrinterService.manager;

// Export PrinterService and manager
export { PrinterService, BluetoothPrinterManager, printerManager };
