// -------------------- BLUETOOTH PRINTER MANAGER --------------------

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { DEFAULT_SETTINGS } from '../utils/constants.js';
import { getAndroidMajorVersion } from '../utils/helpers.js';
import { copyMark, receiptDateTime } from '../utils/bill-share.js';
import { t } from '../i18n/index.js';

/** Dots darker than this (average of R,G,B) print black */
const RASTER_THRESHOLD = 128;

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
 * Convert the top `height` rows of a canvas into a ready-to-send ESC/POS buffer.
 * @param {HTMLCanvasElement} canvas
 * @param {number} [height=canvas.height]
 * @returns {Uint8Array}
 */
function canvasToEscPos(canvas, height = canvas.height) {
    const width = canvas.width;
    const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
    const raster = packMonochromeRaster(data, width, height);
    return buildRasterPrintCommand(raster, (width + 7) >> 3, height);
}

class BluetoothPrinterManager {
    constructor() {
        this.device = null;
        this.printerName = null;
        this._printQueue = Promise.resolve();
    }

    /**
     * Serialize print jobs so two bills never interleave on the Bluetooth link.
     * @private
     */
    _enqueue(job) {
        const run = this._printQueue.then(job, job);
        this._printQueue = run.catch(() => {});
        return run;
    }

    /**
     * Send raw bytes to the connected printer.
     * @private
     */
    _send(bytes, label) {
        return new Promise((resolve, reject) => {
            window.bluetoothSerial.write(
                bytes,
                () => resolve(true),
                (error) => {
                    console.error(`[${label}] Print failed:`, error);
                    reject(error instanceof Error ? error : new Error(error || 'Print failed'));
                }
            );
        });
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
        
        return new Promise((resolve, reject) => {
            UIManager.showLoading();
            
            try {
                window.bluetoothSerial.list(
                    (devices) => {
                        UIManager.hideLoading();
                        resolve(devices || []);
                    },
                    (error) => {
                        UIManager.hideLoading();
                        const errorMsg = error || 'Failed to scan for devices';
                        console.error('[SCAN] Error:', errorMsg);
                        reject(new Error(errorMsg));
                    }
                );
            } catch (error) {
                UIManager.hideLoading();
                const errorMsg = 'Bluetooth scan failed: ' + error.message;
                console.error('[SCAN] Exception:', error);
                reject(new Error(errorMsg));
            }
        });
    }

    async connect(deviceId, deviceName = null) {
        try {
            if (!window.bluetoothSerial) {
                const errorMsg = 'Bluetooth Serial plugin not available';
                console.error('[CONNECT]', errorMsg);
                throw new Error(errorMsg);
            }
            
            UIManager.showLoading();
            
            return new Promise((resolve, reject) => {
                window.bluetoothSerial.connect(
                    deviceId,
                    () => {
                        UIManager.hideLoading();
                        this.device = deviceId;
                        this.printerName = deviceName;
                        resolve(true);
                    },
                    (error) => {
                        UIManager.hideLoading();
                        const errorMsg = error || 'Connection failed';
                        console.error('[CONNECT] Error:', errorMsg);
                        reject(new Error(errorMsg));
                    }
                );
            });
        } catch (error) {
            UIManager.hideLoading();
            const errorMsg = 'Connection failed: ' + error.message;
            console.error('[CONNECT] Exception:', error);
            throw error;
        }
    }

    async disconnect() {
        if (this.device && window.bluetoothSerial) {
            try {
                return new Promise((resolve) => {
                    window.bluetoothSerial.disconnect(
                        () => {
                            this.device = null;
                            this.printerName = null;
                            resolve();
                        },
                        () => {
                            // Even if disconnect fails, clear state
                            this.device = null;
                            this.printerName = null;
                            resolve();
                        }
                    );
                });
            } catch (error) {
                console.error('[DISCONNECT] Error:', error);
            }
        }
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
                const displayName = (itemObj && itemObj.hindiName) ? itemObj.hindiName : item.name;
                
                y = utils.drawLeft(`${displayName} (${t('ui.print.packets_kg', { n: item.weights.length, kg: item.qty.toFixed(1) })})`, y, { size: 18, weight: 'bold' });
                
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

    _drawReceiptHeader(ctx, billData, config, utils, y) {
        y = utils.drawCenter('Receipt', y, config.fonts.title, true);
        if (billData.isCopy) {
            y = utils.drawCenter(copyMark(), y, config.fonts.header, true);
        }
        
        // Bill number on left, the bill's own date/time on right (same line)
        const dateTime = receiptDateTime(billData);
        
        if (billData.billNumber) {
            // Draw bill number on left
            ctx.font = '17px Arial';
            ctx.fillText('Bill: ' + billData.billNumber, config.padding.side, y);
            
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
            y = utils.drawLeft('Customer: ' + billData.customerName, y, { size: 18, weight: 'normal' });
            y += 8;
        }
        return y;
    }

    _drawItemsTable(ctx, billData, config, utils, y) {
        // Table header
        ctx.font = `bold ${config.fonts.header.size}px Arial`;
        ctx.fillStyle = '#000000';
        ctx.textAlign = 'left';
        ctx.fillText(t('ui.print.th_item'), config.columns.item, y);
        ctx.fillText(t('ui.print.th_rate'), config.columns.rate, y);
        ctx.fillText(t('ui.print.th_qty'), config.columns.quantity, y);
        ctx.fillText(t('ui.print.th_total'), config.columns.total, y);
        y += config.spacing.line;
        
        // Items
        ctx.font = `${config.fonts.body.size}px Arial`;
        billData.items.forEach(item => {
            const itemObj = AppState.items.find(i => i.id === item.itemId || i.name === item.name);
            const displayName = (itemObj && itemObj.hindiName) ? itemObj.hindiName : item.name;
            
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
        
        // Get the subtotal (purchases use billTotal, sales use total or saleTotal)
        const subtotal = billData.billTotal || billData.saleTotal || billData.total || 0;
        
        // Subtotal
        ctx.fillText(`${t('ui.bill.total')}:`, config.padding.left, y);
        const totalText = '₹' + Math.round(subtotal);
        const totalWidth = ctx.measureText(totalText).width;
        ctx.fillText(totalText, config.width - totalWidth - config.padding.left, y);
        y += config.spacing.line;
        
        // Labor charges (only for purchases)
        if (billData.isPurchase && billData.laborCharges > 0) {
            if (billData.laborCalc) {
                // Show calculation in middle and amount on right
                ctx.fillText(`${t('ui.bill.labour')}:`, config.padding.left, y);
                const calcWidth = ctx.measureText(billData.laborCalc).width;
                const calcX = (config.width - calcWidth) / 2;
                ctx.fillText(billData.laborCalc, calcX, y);
                const laborText = `₹${billData.laborCharges}`;
                const laborWidth = ctx.measureText(laborText).width;
                ctx.fillText(laborText, config.width - laborWidth - config.padding.left, y);
            } else {
                // No calculation, just show amount
                ctx.fillText(`${t('ui.bill.labour')}:`, config.padding.left, y);
                const laborText = `₹${billData.laborCharges}`;
                const laborWidth = ctx.measureText(laborText).width;
                ctx.fillText(laborText, config.width - laborWidth - config.padding.left, y);
            }
            y += config.spacing.line;
        }
        
        // Add spacing before grand total
        y += 8;
        
        // Grand total - Total bill amount
        ctx.font = `bold ${config.fonts.total.size}px Arial`;
        const grandTotalLabel = `${t('ui.bill.total')}:`;
        ctx.fillText(grandTotalLabel, config.padding.left, y);
        const amountPayable = billData.amountPayable || billData.grandTotal || billData.saleTotal || billData.total ||
                             (subtotal - (billData.laborCharges || 0));
        const payableText = '₹' + Math.round(amountPayable);
        const payableWidth = ctx.measureText(payableText).width;
        ctx.fillText(payableText, config.width - payableWidth - config.padding.left, y);
        y += config.spacing.line;
        
        // Calculate actual received amount (cash + online)
        const cashReceived = Number(billData.payment?.cash) || Number(billData.cashPayment) || 0;
        const onlineReceived = Number(billData.payment?.online) || Number(billData.onlinePayment) || 0;
        const totalReceived = cashReceived + onlineReceived;
        
        // Total Received (कुल प्राप्त / कुल भुगतान)
        y += 4;
        ctx.font = `${config.fonts.body.size}px Arial`;
        const receivedLabel = `${t(billData.isPurchase ? 'ui.print.total_paid' : 'ui.print.total_received')}:`;
        ctx.fillText(receivedLabel, config.padding.left, y);
        const receivedText = '₹' + Math.round(totalReceived);
        const receivedWidth = ctx.measureText(receivedText).width;
        ctx.fillText(receivedText, config.width - receivedWidth - config.padding.left, y);
        y += config.spacing.line;
        
        // Due amount (बकाया)
        const dueAmount = billData.payment?.due || billData.dueAmount || 0;
        if (dueAmount > 0) {
            y += 4; // Small gap
            ctx.font = `bold ${config.fonts.body.size}px Arial`;
            ctx.fillText(`${t('ui.bill.due')}:`, config.padding.left, y);
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
            const noteLabel = 'Note: ';
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

    async generateBillCanvas(billData) {
        const { canvas, height } = this._renderBillCanvas(billData);
        
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
     * Draw the receipt onto an oversized canvas.
     * @returns {{canvas: HTMLCanvasElement, height: number}} canvas and used height
     * @private
     */
    _renderBillCanvas(billData) {
        const config = {
            width: 384, // 58mm thermal printer width
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
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        tempCanvas.width = config.width;
        tempCanvas.height = 2000;
        
        // Initialize with white background
        tempCtx.fillStyle = '#ffffff';
        tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
        tempCtx.fillStyle = '#000000';
        
        // Drawing utilities
        const utils = this._createDrawingUtils(tempCtx, config);
        let y = 20;

        // Draw receipt sections
        y = this._drawWeightsBreakdown(tempCtx, billData, utils, y);
        y += config.spacing.section;
        
        y = this._drawReceiptHeader(tempCtx, billData, config, utils, y);
        y = this._drawCustomerInfo(billData, utils, y);
        y = this._drawItemsTable(tempCtx, billData, config, utils, y);
        y = this._drawTotalsSection(tempCtx, billData, config, utils, y);
        
        return { canvas: tempCanvas, height: y };
    }

    async write(billData) {
        if (!this.device) {
            throw new Error('Not connected to device');
        }

        if (!window.bluetoothSerial) {
            throw new Error('Bluetooth Serial plugin not available');
        }
        
        return this._enqueue(async () => {
            try {
                // Read the used rows straight from the render canvas (no cropped copy)
                const { canvas, height } = this._renderBillCanvas(billData);
                const commandBytes = canvasToEscPos(canvas, height);
                return await this._send(commandBytes, 'WRITE');
            } catch (error) {
                console.error('[WRITE] Print failed:', error);
                throw error;
            }
        });
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
        ctx.fillText('Receipt', config.width / 2, y);
        y += config.fonts.header.size + 10;
        
        // Date and Time
        ctx.font = `${config.fonts.body.size}px Arial`;
        let dateTime;
        let expenseDate;
        
        // Try to parse the date from various possible formats
        if (expense.timestamp) {
            expenseDate = new Date(expense.timestamp);
        } else if (expense.date) {
            // Try parsing the date string
            expenseDate = new Date(expense.date);
        } else {
            expenseDate = new Date();
        }
        
        // Check if date is valid, if not use current date
        if (isNaN(expenseDate.getTime())) {
            expenseDate = new Date();
        }
        
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
        ctx.fillText('Type:', 10, y);
        ctx.fillText(expense.type, 120, y);
        y += config.spacing.line;
        
        // Amount
        ctx.font = `bold ${config.fonts.total.size}px Arial`;
        ctx.fillText('Amount:', 10, y);
        ctx.fillText(`₹${expense.amount}`, 120, y);
        y += config.spacing.line + 5;
        
        ctx.font = `${config.fonts.body.size}px Arial`;
        
        // Person (if available)
        if (expense.personName) {
            ctx.fillText('Name:', 10, y);
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
    
    async writeExpense(expense) {
        if (!this.device) {
            throw new Error('Not connected to device');
        }

        if (!window.bluetoothSerial) {
            throw new Error('Bluetooth Serial plugin not available');
        }
        
        return this._enqueue(async () => {
            try {
                const finalCanvas = await this.generateExpenseCanvas(expense);
                const commandBytes = canvasToEscPos(finalCanvas);
                return await this._send(commandBytes, 'WRITE EXPENSE');
            } catch (error) {
                console.error('[WRITE EXPENSE] Print failed:', error);
                throw error;
            }
        });
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

    async writeStatement(statement) {
        if (!this.device) throw new Error('Not connected to device');
        if (!window.bluetoothSerial) throw new Error('Bluetooth Serial plugin not available');
        return this._enqueue(() => this._send(canvasToEscPos(this.generateStatementCanvas(statement)), 'WRITE STATEMENT'));
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
            UIManager.showToast(t('msg.printer.failed_scan_devices', { message: error.message }));
            throw error;
        }
    },

    async connect(deviceId, deviceName) {
        try {
            await this.manager.connect(deviceId, deviceName);
            this.updateStatus();
            return true;
        } catch (error) {
            console.error('Printer connect error:', error);
            UIManager.showToast(t('msg.printer.failed_connect', { message: error.message }));
            throw error;
        }
    },

    async disconnect() {
        try {
            await this.manager.disconnect();
            this.updateStatus();
            UIManager.showToast(t('msg.common.printer_disconnected'));
        } catch (error) {
            console.error('Disconnect error:', error);
            UIManager.showToast(t('msg.common.failed_disconnect', { message: error.message }));
        }
    },

    async print(billData) {
        try {
            const escpos = this.manager.generateESCPOS(billData);
            await this.manager.print(escpos);
            return true;
        } catch (error) {
            console.error('Print error:', error);
            throw error;
        }
    },

    updateStatus() {
        const statusDiv = document.getElementById('printerStatus');
        const connectBtn = document.getElementById('connectPrinterBtn');
        const disconnectBtn = document.getElementById('disconnectPrinterBtn');
        
        if (AppState.printerSettings.enabled && AppState.printerSettings.deviceName) {
            if (statusDiv) {
                statusDiv.textContent = `Connected: ${AppState.printerSettings.deviceName}`;
                statusDiv.style.color = 'green';
            }
            if (connectBtn) connectBtn.style.display = 'none';
            if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
        } else {
            if (statusDiv) {
                statusDiv.textContent = 'Not Connected';
                statusDiv.style.color = 'red';
            }
            if (connectBtn) connectBtn.style.display = 'inline-block';
            if (disconnectBtn) disconnectBtn.style.display = 'none';
        }
    },

    async testPrint() {
        try {
            const testBill = {
                type: 'TEST',
                date: new Date().toISOString(),
                customerName: 'Test Customer',
                items: [
                    { name: 'Test Item', qty: 10, rate: 100, total: 1000, weights: [10] }
                ],
                billTotal: 1000,
                laborCharges: 6,
                totalPackets: 1,
                amountPayable: 1006,
                isPurchase: true,
                isAutoLabor: true
            };
            
            await this.manager.write(testBill);
            UIManager.showToast(t('msg.printer.test_print_successful'));
        } catch (error) {
            console.error('Test print error:', error);
            UIManager.showToast(t('msg.common.test_print_failed', { message: error.message }));
        }
    },

    async printBill(billData) {
        // Try Bluetooth first if available and connected
        if (this.manager.device && window.bluetoothSerial) {
            try {
                await this.manager.write(billData);
                UIManager.showToast(t('msg.printer.printed_successfully'));
                return true;
            } catch (error) {
                console.error('Bluetooth print failed:', error);
                UIManager.showToast(t('msg.printer.print_failed', { message: error.message || error }));
                // Automatically show preview on Bluetooth failure
                return await this.showBillPreview(billData);
            }
        } else {
            // No Bluetooth printer - show preview
            return await this.showBillPreview(billData);
        }
    },

    async showBillPreview(billData) {
        try {
            // Generate canvas using the same method as Bluetooth printing
            const canvas = await this.manager.generateBillCanvas(billData);
            const billType = billData.isPurchase ? 'purchase' : 'sale';
            const filename = `${billType}_bill_${billData.billNumber || billData.id || Date.now()}${billData.isCopy ? '_copy' : ''}.png`;
            return this.showImagePreview(canvas, filename, 'Bill');
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
        if (this.manager.device && window.bluetoothSerial) {
            try {
                await this.manager.writeStatement(statement);
                UIManager.showToast(t('msg.printer.printed_successfully'));
                return true;
            } catch (error) {
                console.error('Bluetooth statement print failed:', error);
                UIManager.showToast(t('msg.printer.print_failed', { message: error.message || error }));
            }
        }
        try {
            const canvas = this.manager.generateStatementCanvas(statement);
            return this.showImagePreview(canvas, statement.filename || 'statement.png', 'Statement');
        } catch (error) {
            console.error('Statement preview failed:', error);
            UIManager.showToast(t('msg.printer.failed_generate_statement'));
            return false;
        }
    },

    /**
     * Full-screen image preview with Download (share sheet on phones) / Close.
     * @param {HTMLCanvasElement} canvas
     * @param {string} filename
     * @param {string} [shareTitle='Bill']
     * @returns {boolean}
     */
    showImagePreview(canvas, filename, shareTitle = 'Bill') {
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
            downloadBtn.textContent = 'Download';
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
                                console.log('Share failed, trying download:', e);
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
            closeBtn.textContent = 'Close';
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
            
            return true;
        } catch (error) {
            console.error('Preview failed:', error);
            UIManager.showToast(t('msg.printer.failed_generate_preview'));
            return false;
        }
    },

    async printExpense(expense) {
        // Try Bluetooth first if available and connected
        if (this.manager.device && window.bluetoothSerial) {
            try {
                await this.manager.writeExpense(expense);
                UIManager.showToast(t('msg.printer.expense_printed_successfully'));
                return true;
            } catch (error) {
                console.error('Bluetooth expense print failed:', error);
                UIManager.showToast(t('msg.printer.print_failed', { message: error.message || error }));
                // Automatically show preview on Bluetooth failure
                return await this.showExpensePreview(expense);
            }
        } else {
            // No Bluetooth printer - show preview
            return await this.showExpensePreview(expense);
        }
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
            downloadBtn.textContent = 'Download';
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
                                title: 'Expense'
                            });
                            return;
                        } catch (e) {
                            // User cancelled or share failed, fall through to download
                            if (e.name !== 'AbortError') {
                                console.log('Share failed, trying download:', e);
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
            closeBtn.textContent = 'Close';
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
            customerName: saleData.customerName || 'Walk-in Customer',
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

// Create singleton instance
const printerManager = new BluetoothPrinterManager();

// Export PrinterService and manager
export { PrinterService, BluetoothPrinterManager, printerManager };
