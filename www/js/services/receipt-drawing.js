/**
 * @fileoverview Receipt drawing (#59): bills, expenses and party statements drawn on a
 * 58 mm canvas and turned into printer bytes. PrinterService imports it on the first print
 * or preview (loadReceiptDrawing in printer.js) and adds these methods to
 * BluetoothPrinterManager, so start-up doesn't parse it.
 * @module services/receipt-drawing
 */

import { AppState } from '../utils/state.js';
import { DEFAULT_SETTINGS } from '../utils/constants.js';
import { billQrText, copyMark, receiptDateTime, receiptPayable } from '../utils/bill-share.js';
import { billLabour, billLineTotal, outstandingDue, readPayment, formatKg, formatRupees } from '../utils/money.js';
import { parseAnyBillDate } from '../utils/dates.js';
import { t, tn } from '../i18n/index.js';
import { PAPER_DOTS } from '../utils/printer-settings.js';
import { encodeQr } from '../utils/qr-code.js';
import { canvasToEscPos } from './printer.js';

/** Receipts are laid out for 58 mm paper; wider paper scales them up. */
const LAYOUT_DOTS = PAPER_DOTS[58];
/** First render height (layout rows); a longer bill is drawn again on a canvas that fits it. */
const SLIP_ROWS = 2600;
/** Browsers refuse canvases taller than this. */
const MAX_CANVAS_ROWS = 32767;

/** "by happa" (docs/brand/by-happa-black.svg) as 1-bit rows, 87 × 24 dots, MSB = left dot (#109). */
const MAKER_MARK = {
    width: 87,
    rows: [
        'e000000e00000000000000', 'e000000e00000000000000', 'e000000e00000000000000', 'e000000e00000000000000',
        'e000000e00000000000000', 'e000000e00000000000000', 'e004180e00006600600006', 'ff0e380ff01fe7f87f81fe',
        'ff86380ff83fe7fc7fc3fe', 'fbc7380f3c7be7de79e7be', 'e1c7700e0c70e70e70e70e', 'e0e7700e0ee0e70660ee0e',
        'e0e3f00e0ee0e70660ee0e', 'e1c3e00e0e70e70e70e70e', 'ffc3e00e0e7fe7fe7fe7fe', 'ff81c00e0e3fe7fc7fc3fe',
        'ff01c00e0e1fe7f87f81fe', '0001c00000000700600000', '0003800000000700600000', '0003800000000700600000',
        '0003800000000700600000', '0007000000000700600000', '0007000000000700600000', '0007000000000700600000'
    ]
};

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

/** The drawing methods of BluetoothPrinterManager (`this` is the manager). */
class ReceiptDrawing {
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
                
                y = utils.drawLeft(`${displayName} (${this._tn('ui.print.packets_kg', item.weights.length, { kg: formatKg(item.qty) })})`, y, { size: 18, weight: 'bold' });
                
                const weightsText = item.weights.map(w => formatKg(w)).join('  ');
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

    /** The small "by happa" maker line, last on the slip (#109). */
    _drawMakerFooter(ctx, config, y) {
        const left = Math.round((config.width - MAKER_MARK.width) / 2);
        const top = y - 4;
        ctx.fillStyle = '#000000';
        MAKER_MARK.rows.forEach((hex, r) => {
            let start = -1;
            for (let c = 0; c <= MAKER_MARK.width; c++) {
                const on = c < MAKER_MARK.width && (parseInt(hex[c >> 2], 16) >> (3 - (c & 3))) & 1;
                if (on && start < 0) start = c;
                if (!on && start >= 0) {
                    ctx.fillRect(left + start, top + r, c - start, 1);
                    start = -1;
                }
            }
        });
        return top + MAKER_MARK.rows.length + 4;
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
        // drawCenter steps by the line just drawn; the taller title needs the difference too
        if (name || details) y += config.fonts.title.size - (details ? config.fonts.small.size : config.fonts.header.size);
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
            y = utils.drawLeft(`${this._t(billData.isPurchase ? 'ui.bill.supplier' : 'ui.bill.customer')}: ${billData.customerName}`, y, { size: 18, weight: 'normal' });
            y += 8;
        }
        return y;
    }

    _drawItemsTable(ctx, billData, config, utils, y) {
        // Table header
        ctx.font = `bold ${config.fonts.header.size}px Arial`;
        ctx.fillStyle = '#000000';
        ctx.textAlign = 'left';
        const headFont = `bold ${config.fonts.header.size}px Arial`;
        const bodyFont = `${config.fonts.body.size}px Arial`;
        const widthIn = (font, text) => { ctx.font = font; return ctx.measureText(text).width; };
        const head = ['ui.print.th_item', 'ui.print.th_rate', 'ui.print.th_qty', 'ui.print.th_total'].map((k) => this._t(k));
        const rows = billData.items.map((item) => {
            const itemObj = AppState.items.find(i => i.id === item.itemId || i.name === item.name);
            return [this._itemName(itemObj, item), String(item.rate), formatKg(item.qty), String(Math.round(item.total))];
        });
        // Rate, Qty and Total are as wide as their widest cell, right-aligned from the paper edge; the name gets the rest
        const gap = 10;
        const right = [];
        let edge = config.width - 2;
        for (let c = 3; c >= 1; c--) {
            right[c] = edge;
            edge -= Math.max(widthIn(headFont, head[c]), ...rows.map((r) => widthIn(bodyFont, r[c]))) + gap;
        }
        const nameRoom = edge - config.columns.item;
        const cell = (font, text, c) => {
            ctx.font = font;
            if (c > 0) {
                ctx.fillText(text, right[c] - ctx.measureText(text).width, y);
                return;
            }
            let shown = text;
            if (ctx.measureText(shown).width > nameRoom) {
                const chars = typeof Intl.Segmenter === 'function'
                    ? [...new Intl.Segmenter().segment(text)].map((s) => s.segment) : Array.from(text);
                while (chars.length > 1 && ctx.measureText(chars.join('')).width > nameRoom) chars.pop();
                shown = chars.join('');
            }
            ctx.fillText(shown, config.columns.item, y);
        };

        head.forEach((text, c) => cell(headFont, text, c));
        y += config.spacing.line;
        rows.forEach((r) => {
            r.forEach((text, c) => cell(bodyFont, text, c));
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
        const amountPayable = receiptPayable(billData);
        const labour = billData.isPurchase ? billLabour(billData) : 0;
        
        // printed only when it differs from the payable as printed, or labour comes between them (BILL-LINES)
        const showSubtotal = labour > 0 || formatRupees(subtotal) !== formatRupees(amountPayable);
        if (showSubtotal) {
            ctx.fillText(`${this._t('ui.bill.subtotal')}:`, config.padding.left, y);
            const totalText = formatRupees(subtotal);
            const totalWidth = ctx.measureText(totalText).width;
            ctx.fillText(totalText, config.width - totalWidth - config.padding.left, y);
            y += config.spacing.line;
        }
        
        // Labor charges (only for purchases)
        if (labour > 0) {
            if (billData.laborCalc) {
                // Show calculation in middle and amount on right
                ctx.fillText(`${this._t('ui.bill.labour')}:`, config.padding.left, y);
                const calcWidth = ctx.measureText(billData.laborCalc).width;
                const calcX = (config.width - calcWidth) / 2;
                ctx.fillText(billData.laborCalc, calcX, y);
                const laborText = formatRupees(billLabour(billData), { exact: true });
                const laborWidth = ctx.measureText(laborText).width;
                ctx.fillText(laborText, config.width - laborWidth - config.padding.left, y);
            } else {
                // No calculation, just show amount
                ctx.fillText(`${this._t('ui.bill.labour')}:`, config.padding.left, y);
                const laborText = formatRupees(billLabour(billData), { exact: true });
                const laborWidth = ctx.measureText(laborText).width;
                ctx.fillText(laborText, config.width - laborWidth - config.padding.left, y);
            }
            y += config.spacing.line;
        }
        
        // Add spacing before grand total
        if (showSubtotal) y += 8;
        
        // Grand total - Total bill amount
        ctx.font = `bold ${config.fonts.total.size}px Arial`;
        const grandTotalLabel = `${this._t('ui.bill.total')}:`;
        ctx.fillText(grandTotalLabel, config.padding.left, y);
        const payableText = formatRupees(amountPayable);
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
        const receivedText = formatRupees(totalReceived);
        const receivedWidth = ctx.measureText(receivedText).width;
        ctx.fillText(receivedText, config.width - receivedWidth - config.padding.left, y);
        y += config.spacing.line;
        
        // Due amount (बकाया)
        const dueAmount = outstandingDue(billData);
        if (dueAmount > 0) {
            y += 4; // Small gap
            ctx.font = `bold ${config.fonts.body.size}px Arial`;
            ctx.fillText(`${this._t('ui.bill.due')}:`, config.padding.left, y);
            const dueText = formatRupees(dueAmount);
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

        const scale = dots / LAYOUT_DOTS;
        const maxRows = Math.floor(MAX_CANVAS_ROWS / scale);
        this._receipt = receipt || {};
        let rows = SLIP_ROWS;
        let tempCanvas;
        let y;
        try {
            for (;;) {
                tempCanvas = document.createElement('canvas');
                const tempCtx = tempCanvas.getContext('2d');
                tempCanvas.width = dots;
                tempCanvas.height = Math.ceil(rows * scale);
                tempCtx.fillStyle = '#ffffff';
                tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
                tempCtx.fillStyle = '#000000';
                if (scale !== 1) tempCtx.scale(scale, scale);
                y = this._drawBill(tempCtx, billData, config);
                // a long bill is drawn again on a canvas that fits it, so nothing below the items is lost
                if (y <= rows || rows >= maxRows) break;
                rows = Math.min(Math.ceil(y), maxRows);
            }
        } finally {
            this._receipt = null;
        }
        
        // rows past the canvas read back as transparent black and would print as a black band
        return { canvas: tempCanvas, height: Math.min(Math.ceil(y * scale), tempCanvas.height) };
    }

    _drawBill(ctx, billData, config) {
        const utils = this._createDrawingUtils(ctx, config);
        let y = 20;
        y = this._drawWeightsBreakdown(ctx, billData, utils, y);
        y += config.spacing.section;
        y = this._drawReceiptHeader(ctx, billData, config, utils, y);
        y = this._drawCustomerInfo(billData, utils, y);
        y = this._drawItemsTable(ctx, billData, config, utils, y);
        y = this._drawTotalsSection(ctx, billData, config, utils, y);
        y = this._drawReceiptFooter(ctx, billData, config, utils, y);
        return this._drawMakerFooter(ctx, config, y);
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
        ctx.fillText(formatRupees(expense.amount, { exact: true }), 120, y);
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
        const rupees = (n) => formatRupees(n);

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

/**
 * Adds the drawing methods to a printer manager class.
 * @param {Function} Manager
 */
export function addReceiptDrawing(Manager) {
    for (const name of Object.getOwnPropertyNames(ReceiptDrawing.prototype)) {
        if (name !== 'constructor') Object.defineProperty(Manager.prototype, name, /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(ReceiptDrawing.prototype, name)));
    }
}
