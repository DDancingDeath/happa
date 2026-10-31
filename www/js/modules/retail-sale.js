/**
 * @fileoverview Retail Sale module for managing retail sale transactions
 * Handles retail sale creation, weight tracking, and completing sales
 * @module modules/retail-sale
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { PrinterService } from '../services/printer.js';
import { AuditService } from '../services/audit.js';
import { Helpers } from '../utils/helpers.js';
import {
    checkPaymentSplit, KEPT_SERVER_PAYMENT_KEY, paymentSplitMessage, round2, sumMoney
} from '../utils/money.js';
import { BillChecksUI, readTypedNumber } from '../ui/bill-highlight.js';
import { t, tn } from '../i18n/index.js';
import { buildDraftShareText } from '../utils/bill-share.js';
import { lineItemIdentity } from '../utils/item-catalog.js';

/** Name to show for a catalogue item or bill line in the chosen item-name language. */
const lineLabel = (line) => lineItemIdentity(line && 'itemId' in line ? line : { itemId: line?.id, name: line?.name }, AppState.items, AppState.settings.showHindi).label;

/** Buttons disabled while a retail save/print is in flight */
const RETAIL_BUTTONS = '#saveSaleBtn, #printSaleBtn';

/**
 * @type {Array<Object>} Current items for sale mode
 * @private
 */
let saleItems = [];

/**
 * @type {Array<number>} Weight entries for sale mode
 * @private
 */
let saleWeights = [];

/**
 * Id (and bill number, once issued) of the sale being entered, reused by every
 * save attempt so a retry cannot create a second bill (#70).
 * @type {{id: string, billNumber: (string|null)}|null}
 */
let pendingBill = null;

/**
 * Retail Sale Manager - Handles all retail sale operations
 * @namespace RetailSaleManager
 */
const RetailSaleManager = {
    /**
     * Reference to parent billing manager for shared operations
     * @type {Object}
     */
    billingManager: null,

    /**
     * Initialize with reference to billing manager
     * @param {Object} billingManager - The parent billing manager
     */
    init(billingManager) {
        this.billingManager = billingManager;
    },

    // -------------------- WEIGHT MANAGEMENT --------------------

    /**
     * Add a weight entry
     * @async
     * @param {boolean} autoAddToBill - Whether to auto-add to bill after adding weight
     */
    async addSaleWeight(autoAddToBill = false) {
        const weightInput = document.getElementById('saleWeight');
        const weight = parseFloat(weightInput?.value);
        
        if (!weight || weight <= 0) {
            UIManager.showToast(t('msg.common.enter_valid_weight'));
            return;
        }
        
        saleWeights.push(weight);
        weightInput.value = '';
        weightInput.focus();
        
        this.renderSaleWeights();
        if (this.billingManager) this.billingManager.triggerAutoSave();
        UIManager.hapticFeedback();
        
        if (autoAddToBill && saleWeights.length === 1) {
            await this.addToSalesBill(true);
        }
    },

    /**
     * Render the sale weights display
     */
    renderSaleWeights() {
        const container = document.getElementById('saleWeightsDisplay');
        if (!container) return;
        
        const totalWeightsSpan = document.getElementById('saleRunningTotal');
        const totalPacketsSpan = document.getElementById('salePacketCount');
        
        if (saleWeights.length === 0) {
            container.innerHTML = '';
            if (totalWeightsSpan) totalWeightsSpan.textContent = '0';
            if (totalPacketsSpan) totalPacketsSpan.textContent = '0';
            return;
        }
        
        const total = saleWeights.reduce((sum, w) => sum + w, 0);
        
        if (totalWeightsSpan) totalWeightsSpan.textContent = total.toFixed(1);
        if (totalPacketsSpan) totalPacketsSpan.textContent = saleWeights.length;
        
        container.innerHTML = `
            <div class="weights-compact-list">
                ${saleWeights.map((w, i) => `
                    <div class="weight-chip">
                        <span>${w.toFixed(1)}</span>
                        <button class="weight-chip-remove" onclick="window.app.retailSale.removeSaleWeight(${i})">×</button>
                    </div>
                `).join('')}
            </div>
        `;
    },

    /**
     * Remove a sale weight by index
     * @param {number} index - Index of weight to remove
     */
    removeSaleWeight(index) {
        saleWeights.splice(index, 1);
        this.renderSaleWeights();
        if (this.billingManager) this.billingManager.triggerAutoSave();
        UIManager.hapticFeedback();
    },

    /**
     * Clear all sale weights
     */
    clearSaleWeights() {
        saleWeights = [];
        this.renderSaleWeights();
        if (this.billingManager) this.billingManager.triggerAutoSave();
        UIManager.hapticFeedback();
    },

    // -------------------- SALE BILL MANAGEMENT --------------------

    /**
     * Add current item to sales bill
     * @async
     * @param {boolean} autoAdd - Whether this is an auto-add
     */
    async addToSalesBill(autoAdd = false) {
        const itemSelect = document.getElementById('saleItem');
        const rateInput = document.getElementById('saleRate');
        const weightInput = document.getElementById('saleWeight');
        
        if (!itemSelect || !rateInput) return;
        
        const itemIndex = parseInt(itemSelect.value);
        const rate = parseFloat(rateInput.value);
        
        if (itemIndex === undefined || itemIndex === '' || isNaN(itemIndex)) {
            UIManager.showToast(t('msg.common.select_item'));
            return;
        }
        
        if (!rate || rate <= 0) {
            UIManager.showToast(t('msg.common.enter_valid_rate'));
            return;
        }
        
        let qty;
        let packets;
        let allWeights = [];
        
        const typedWeight = parseFloat(weightInput?.value);
        const hasTypedWeight = typedWeight && typedWeight > 0;
        
        if (saleWeights.length > 0 || hasTypedWeight) {
            allWeights = [...saleWeights];
            if (hasTypedWeight) {
                allWeights.push(typedWeight);
            }
            
            qty = allWeights.reduce((sum, w) => sum + w, 0);
            packets = allWeights.length;
        } else {
            UIManager.showToast(t('msg.retail.add_weights_or_enter_quantity'));
            return;
        }
        
        const item = AppState.items[itemIndex];
        if (!item) {
            UIManager.showToast(t('msg.common.item_not_found'));
            return;
        }
        this.ensurePendingBill();
        
        // Bill lines keep the catalogue name; Hindi is only for display (#143, Reports group by item).
        const itemName = lineLabel(item);
        
        const total = Math.round(qty * rate);
        
        saleItems.push({
            itemId: item.id,
            name: item.name,
            rate,
            qty,
            packets,
            weights: allWeights,
            total,
            timestamp: Date.now()
        });
        
        this.renderSalesBill();
        if (this.billingManager) this.billingManager.triggerAutoSave();
        
        // Clear weights and reset inputs
        saleWeights = [];
        this.renderSaleWeights();
        
        itemSelect.selectedIndex = 0;
        rateInput.value = '';
        if (weightInput) weightInput.value = '';
        
        itemSelect.focus();
        
        UIManager.hapticFeedback();
        UIManager.showToast(t('msg.retail.added_sale', { itemName }));
    },

    /**
     * Render the sales bill table
     */
    renderSalesBill() {
        const tbody = document.querySelector('#saleTable tbody');
        const totalSalePacketsSpan = document.getElementById('totalSalePacketsInBill');
        const saleTotalSpan = document.getElementById('saleTotal');
        const saleWeightBreakdownSection = document.getElementById('saleWeightBreakdownSection');
        
        if (!tbody) return;
        
        if (saleItems.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #999; padding: 24px;" data-i18n="msg.common.no_items_in_bill">${Helpers.escapeHtml(t('msg.common.no_items_in_bill'))}</td></tr>`;
            if (saleTotalSpan) saleTotalSpan.textContent = '0';
            if (totalSalePacketsSpan) totalSalePacketsSpan.textContent = '0';
            if (saleWeightBreakdownSection) saleWeightBreakdownSection.innerHTML = '';
            this.updateSaleTotals();
            this.updateSaleRunningTotal();
            return;
        }
        
        // Render weight breakdown for items with 2 or more packets
        if (saleWeightBreakdownSection) {
            const itemsWithMultipleWeights = saleItems.filter(item => item.weights && item.weights.length >= 2);
            
            if (itemsWithMultipleWeights.length > 0) {
                saleWeightBreakdownSection.innerHTML = itemsWithMultipleWeights.map(item => {
                    const weightsPerLine = 6;
                    const weightLines = [];
                    for (let i = 0; i < item.weights.length; i += weightsPerLine) {
                        const lineWeights = item.weights.slice(i, i + weightsPerLine);
                        weightLines.push(lineWeights.map(w => parseFloat(w).toFixed(1)).join('&nbsp;&nbsp;'));
                    }
                    
                    return `
                        <div style="background: #f8f9fa; padding: 12px; border-radius: 8px; margin-bottom: 8px; border-left: 4px solid #22c55e;">
                            <div style="font-weight: 600; margin-bottom: 6px; color: #333;">
                                ${Helpers.escapeHtml(lineLabel(item))} (${Helpers.escapeHtml(tn('ui.print.packets_kg', item.weights.length, { kg: item.qty.toFixed(1) }))})
                            </div>
                            <div style="font-family: monospace; font-size: 14px; line-height: 1.4; color: #555;">
                                ${weightLines.join('<br>')}
                            </div>
                        </div>
                    `;
                }).join('');
            } else {
                saleWeightBreakdownSection.innerHTML = '';
            }
        }
        
        // Render bill items table
        tbody.innerHTML = saleItems.map((item, index) => `
            <tr style="cursor: pointer;" onclick="window.app.retailSale.editSaleItem(${index})">
                <td>${Helpers.escapeHtml(lineLabel(item))}</td>
                <td>₹${item.rate.toFixed(2)}</td>
                <td>${item.qty.toFixed(1)} kg</td>
                <td>₹${Math.round(item.total)}</td>
                <td><button onclick="event.stopPropagation(); window.app.retailSale.removeSaleItem(${index})" style="background: #e74c3c; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer;">×</button></td>
            </tr>
        `).join('');
        
        // Update totals
        const salesTotal = saleItems.reduce((sum, item) => sum + item.total, 0);
        const totalPackets = saleItems.reduce((sum, item) => sum + (item.packets || 1), 0);
        
        if (saleTotalSpan) saleTotalSpan.textContent = Math.round(salesTotal);
        if (totalSalePacketsSpan) totalSalePacketsSpan.textContent = totalPackets;
        
        this.updateSaleTotals();
        this.updateSaleRunningTotal();
        this.updateSalePaymentTotal();
    },

    /**
     * Remove a sale item by index
     * @param {number} index - Index of item to remove
     */
    removeSaleItem(index) {
        saleItems.splice(index, 1);
        this.renderSalesBill();
        if (this.billingManager) this.billingManager.triggerAutoSave();
        UIManager.hapticFeedback();
    },

    /**
     * Edit a sale item
     * @param {number} index - Index of item to edit
     */
    editSaleItem(index) {
        const currentItem = Helpers.getInputText('saleItem');
        const currentRate = Helpers.getInputNumber('saleRate');
        
        if (currentItem && currentRate && saleWeights.length > 0) {
            this.addToSalesBill(true);
        }
        
        const item = saleItems[index];
        if (!item) return;
        
        saleItems.splice(index, 1);
        this.renderSalesBill();
        
        const itemIndex = AppState.items.findIndex(i => i.id === item.itemId || i.name === item.name);
        if (itemIndex !== -1) {
            document.getElementById('saleItem').value = itemIndex;
            if (this.billingManager) this.billingManager.loadSaleRates();
            
            setTimeout(() => {
                document.getElementById('saleRate').value = item.rate;
            }, 50);
        }
        
        if (item.qty && item.packets) {
            if (item.weights && item.weights.length > 0) {
                saleWeights = [...item.weights];
            } else {
                const avgWeight = item.qty / item.packets;
                saleWeights = Array(item.packets).fill(avgWeight);
            }
        } else {
            saleWeights = [item.qty];
        }
        this.renderSaleWeights();
        
        if (this.billingManager) this.billingManager.triggerAutoSave();
        UIManager.hapticFeedback();
        UIManager.showToast(t('msg.common.item_loaded_editing'));
    },

    // -------------------- TOTALS --------------------

    /**
     * Update sale totals display
     */
    updateSaleTotals() {
        const total = saleItems.reduce((sum, item) => sum + item.total, 0);
        
        const saleTotalEl = document.getElementById('saleTotal');
        const amountReceivableEl = document.getElementById('amountReceivable');
        
        if (saleTotalEl) saleTotalEl.textContent = Math.round(total);
        if (amountReceivableEl) amountReceivableEl.textContent = Math.round(total);
        
        this.updateSalePaymentTotal();
    },

    /**
     * Update sale running total display
     */
    updateSaleRunningTotal() {
        const totalQty = saleItems.reduce((sum, item) => sum + item.qty, 0);
        const packetCount = saleItems.length;
        
        const runningTotalEl = document.getElementById('saleRunningTotal');
        const packetCountEl = document.getElementById('salePacketCount');
        
        if (runningTotalEl) runningTotalEl.textContent = totalQty.toFixed(1);
        if (packetCountEl) packetCountEl.textContent = packetCount;
    },

    /**
     * Update sale payment total display
     */
    updateSalePaymentTotal() {
        const split = this.readPaymentSplit();
        
        const totalReceived = split.online + split.cash;
        
        const totalReceivedEl = document.getElementById('totalReceived');
        if (totalReceivedEl) totalReceivedEl.textContent = Math.round(totalReceived);
        Helpers.showSplitRemaining('saleSplitRemaining', checkPaymentSplit(sumMoney(saleItems, item => item.total), split));
        BillChecksUI.schedule('retail');
    },

    /**
     * Cash / online / due typed on the retail sale form
     * @returns {{cash: number, online: number, due: number}}
     */
    readPaymentSplit() {
        return {
            online: round2(Helpers.getInputNumber('saleOnlinePayment')),
            cash: round2(Helpers.getInputNumber('saleCashPayment')),
            due: round2(Helpers.getInputNumber('saleDueAmount'))
        };
    },

    /**
     * One tap: put whatever is not yet received (total − cash − online) in Due.
     */
    putRestInDue() {
        const total = sumMoney(saleItems, item => item.total);
        const { cash, online } = this.readPaymentSplit();
        const rest = round2(total - cash - online);
        if (rest < 0) {
            UIManager.showToast(paymentSplitMessage(checkPaymentSplit(total, { cash, online })));
            return;
        }
        const dueInput = document.getElementById('saleDueAmount');
        if (dueInput) dueInput.value = rest;
        const dueCheckbox = document.getElementById('saleDueCheckbox');
        if (dueCheckbox) dueCheckbox.checked = rest > 0;
        this.updateSalePaymentTotal();
    },

    /**
     * Fill receivable amount based on payment type
     * @param {'online'|'cash'|'due'} type - Payment type
     */
    fillReceivableAmount(type) {
        const total = saleItems.reduce((sum, item) => sum + item.total, 0);
        const onlineInput = document.getElementById('saleOnlinePayment');
        const cashInput = document.getElementById('saleCashPayment');
        const dueInput = document.getElementById('saleDueAmount');
        const onlineCheckbox = document.getElementById('saleOnlineCheckbox');
        const cashCheckbox = document.getElementById('saleCashCheckbox');
        const dueCheckbox = document.getElementById('saleDueCheckbox');
        
        if (type === 'online' && onlineCheckbox?.checked) {
            if (onlineInput) onlineInput.value = Math.round(total);
            if (cashInput) cashInput.value = '0';
            if (dueInput) dueInput.value = '0';
            if (cashCheckbox) cashCheckbox.checked = false;
            if (dueCheckbox) dueCheckbox.checked = false;
        } else if (type === 'cash' && cashCheckbox?.checked) {
            if (cashInput) cashInput.value = Math.round(total);
            if (onlineInput) onlineInput.value = '0';
            if (dueInput) dueInput.value = '0';
            if (onlineCheckbox) onlineCheckbox.checked = false;
            if (dueCheckbox) dueCheckbox.checked = false;
        } else if (type === 'due' && dueCheckbox?.checked) {
            if (dueInput) dueInput.value = Math.round(total);
            if (onlineInput) onlineInput.value = '0';
            if (cashInput) cashInput.value = '0';
            if (onlineCheckbox) onlineCheckbox.checked = false;
            if (cashCheckbox) cashCheckbox.checked = false;
        }
        
        this.updateSalePaymentTotal();
    },

    // -------------------- COMPLETE SALE --------------------

    /**
     * Generate sale bill number
     * @async
     * @returns {Promise<string>} Generated bill number
     */
    async generateBillNumber() {
        return Helpers.generateBillNumber('S', 'retailSales');
    },

    /**
     * Complete the sale. A second tap while a save is in flight is ignored.
     * @async
     * @param {Object} [options] - See _completeSale
     * @returns {Promise<Object|undefined>} The saved sale
     */
    async completeSale(options = {}) {
        return Helpers.runExclusive('retail', RETAIL_BUTTONS, () => this._completeSale(options));
    },

    /**
     * Complete the sale (unguarded; callers must hold the 'retail' lock)
     * @async
     * @param {Object} [options]
     * @param {Function} [options.onWriteIssued] - Called with the sale once its write is issued
     * @returns {Promise<Object|undefined>} The saved sale
     * @private
     */
    async _completeSale(options = {}) {
        // Check if in edit mode
        if (this.billingManager?.editingBillIndex !== undefined) {
            return this.billingManager.saveEditedBill(options);
        }
        
        if (saleItems.length === 0) {
            UIManager.showToast(t('msg.retail.no_items_in_sale'));
            return;
        }

        const salesTotal = sumMoney(saleItems, item => item.total);
        const saleOnline = round2(Helpers.getInputNumber('saleOnlinePayment'));
        const saleCash = round2(Helpers.getInputNumber('saleCashPayment'));
        const saleDue = round2(Helpers.getInputNumber('saleDueAmount'));
        const saleCustomer = Helpers.getInputText('saleCustomerName');
        const saleComments = Helpers.getInputText('saleComments');
        const printComments = document.getElementById('salePrintComments')?.checked || false;
        
        // Payment, name-for-Due, stock (warns only for retail, #33) and the other checks (#37)
        this.updateSalePaymentTotal();
        const checks = await BillChecksUI.confirmSave('retail');
        if (!checks.ok) return;
        
        const totalPackets = saleItems.reduce((sum, item) => sum + (item.packets || 0), 0);
        
        try {
            UIManager.showLoading();
            const pending = this.ensurePendingBill();
            if (!pending.billNumber) pending.billNumber = await Helpers.generateBillNumber('S', 'retailSales');
            // A retry keeps the first attempt's time so an unchanged sale is written identically
            if (!pending.timestamp) {
                pending.timestamp = Date.now();
                pending.date = new Date().toISOString();
            }
            
            const sale = {
                id: pending.id,
                billNumber: pending.billNumber,
                items: saleItems,
                total: salesTotal,
                totalPackets: totalPackets,
                onlinePayment: saleOnline,
                cashPayment: saleCash,
                dueAmount: saleDue,
                customerName: saleCustomer,
                comments: saleComments,
                printComments: printComments,
                type: 'retail',
                isPurchase: false,
                date: pending.date,
                userId: AppState.currentUser ? AppState.currentUser.uid : 'unknown',
                userName: AppState.userName || 'User',
                timestamp: pending.timestamp,
                payment: {
                    online: saleOnline,
                    cash: saleCash,
                    due: saleDue,
                    total: round2(saleOnline + saleCash + saleDue)
                },
                ...BillChecksUI.billFields(checks)
            };
            
            const retry = pending.attempted;
            pending.attempted = true;
            const writePromise = FirebaseService.saveRetailSale(sale, { retry });
            if (typeof options.onWriteIssued === 'function') {
                options.onWriteIssued(sale);
            }
            await writePromise;
            
            const soldItems = sale.items;
            const billingManager = this.billingManager;
            Helpers.runInBackground([
                () => AuditService.log(AuditService.ACTIONS.CREATE_SALE, {
                    billNumber: sale.billNumber,
                    total: sale.total,
                    customerName: sale.customerName || 'N/A',
                    itemCount: sale.items.length,
                    source: 'billing-tab'
                }),
                () => billingManager?.updateItemFrequency(soldItems, 'sale'),
                () => billingManager?.deleteAutoSave()
            ]);
            
            // Clear sale
            pendingBill = null;
            saleItems = [];
            this.renderSalesBill();
            
            // Reset form
            this.resetForm();
            
            UIManager.hideLoading();
            UIManager.showToast(FirebaseService.keptServerPayment(sale) ? t(KEPT_SERVER_PAYMENT_KEY) : t('msg.retail.sale_completed_successfully'));
            UIManager.hapticFeedback('success');
            
            return sale;
            
        } catch (error) {
            UIManager.hideLoading();
            UIManager.showToast(t('msg.retail.failed_complete_sale', { message: error.message }));
            console.error('Complete sale error:', error);
            throw error;
        }
    },

    /**
     * Reset the sale form
     */
    resetForm() {
        const fields = ['saleCustomerName', 'saleOnlinePayment', 'saleCashPayment', 'saleDueAmount', 'saleComments'];
        fields.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        
        ['saleOnlineCheckbox', 'saleCashCheckbox', 'saleDueCheckbox', 'salePrintComments'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.checked = false;
        });
        
        const totalReceivedEl = document.getElementById('totalReceived');
        if (totalReceivedEl) totalReceivedEl.textContent = '0';
    },

    /**
     * Clear the current sale
     */
    clearSale() {
        pendingBill = null;
        saleItems = [];
        saleWeights = [];
        this.renderSalesBill();
        this.renderSaleWeights();
        this.resetForm();
        if (this.billingManager) this.billingManager.deleteAutoSave().catch(e => console.warn('Auto-save cleanup failed:', e));
    },

    // -------------------- SHARING & PRINTING --------------------

    /**
     * Share sale via WhatsApp
     * @async
     */
    async shareSaleWhatsApp() {
        if (saleItems.length === 0) {
            UIManager.showToast(t('msg.retail.no_items_in_sale'));
            return;
        }
        
        const salesTotal = saleItems.reduce((sum, item) => sum + item.total, 0);
        const message = buildDraftShareText({
            kind: 'retail', customer: document.getElementById('saleCustomerName')?.value, items: saleItems, total: salesTotal
        });
        
        const url = `https://wa.me/?text=${encodeURIComponent(message)}`;
        window.open(url, '_blank');
    },

    /**
     * Print and complete sale
     * @async
     */
    async printSale() {
        if (Helpers.isBusy('retail')) return;
        if (saleItems.length === 0) {
            UIManager.showToast(t('msg.retail.no_items_in_sale'));
            return;
        }
        
        let printPromise = null;
        try {
            const savedSale = await Helpers.runExclusive('retail', RETAIL_BUTTONS, () => this._completeSale({
                onWriteIssued: (sale) => { printPromise = PrinterService.printBill(sale); }
            }));
            
            if (!printPromise) {
                return;
            }
            
            const printed = await printPromise;
            
            if (savedSale && printed === true) {
                UIManager.showToast(t('msg.common.sale_saved_printed'));
            }
        } catch (error) {
            console.error('Print sale error:', error);
            UIManager.showToast(t('msg.common.error_2', { value: error?.message || error }));
        }
    },

    /**
     * Pick contact for sale
     * @async
     */
    async pickSaleContact() {
        await Helpers.pickContact('saleCustomerName');
    },

    // -------------------- STATE ACCESS --------------------

    /**
     * Id/bill number of the sale being entered, created on first use (#70)
     * @returns {{id: string, billNumber: (string|null)}}
     */
    /**
     * The sale as the check engine sees it (utils/bill-checks.js).
     * @returns {Object}
     */
    getCheckDraft() {
        const editing = this.billingManager?.editingBillIndex !== undefined;
        const original = editing ? this.billingManager.getEditingBill?.() || null : null;
        const item = AppState.items[parseInt(document.getElementById('saleItem')?.value)];
        return {
            kind: 'retail',
            isEdit: editing,
            id: editing ? original?.id || null : pendingBill?.id || null,
            editingBill: original,
            items: saleItems,
            total: sumMoney(saleItems, line => line.total),
            payment: this.readPaymentSplit(),
            partyName: Helpers.getInputText('saleCustomerName'),
            date: editing ? original?.date : pendingBill?.date,
            enteredAt: editing ? original?.timestamp : pendingBill?.timestamp,
            entry: item ? { itemId: item.id, name: item.name, rate: readTypedNumber('saleRate'), qty: readTypedNumber('saleWeight') } : null
        };
    },

    ensurePendingBill() {
        if (!pendingBill) pendingBill = { id: Helpers.generateId(), billNumber: null, attempted: false, date: null, timestamp: null };
        return pendingBill;
    },

    /** @returns {{id: string, billNumber: (string|null)}|null} for auto-save / drafts */
    getPendingBill() {
        return pendingBill ? { ...pendingBill } : null;
    },

    /** Restore the sale id from an auto-save / draft. */
    setPendingBill(pending) {
        pendingBill = pending && pending.id ? {
            id: String(pending.id),
            billNumber: pending.billNumber || null,
            attempted: !!pending.attempted,
            date: pending.date || null,
            timestamp: pending.timestamp || null
        } : null;
    },

    /**
     * Get current sale items
     * @returns {Array<Object>} Sale items
     */
    getSaleItems() {
        return saleItems;
    },

    /**
     * Set sale items (for recovery/editing)
     * @param {Array<Object>} items - Items to set
     */
    setSaleItems(items) {
        saleItems = items || [];
    },

    /**
     * Get current sale weights
     * @returns {Array<number>} Sale weights
     */
    getSaleWeights() {
        return saleWeights;
    },

    /**
     * Set sale weights (for recovery/editing)
     * @param {Array<number>} w - Weights to set
     */
    setSaleWeights(w) {
        saleWeights = w || [];
    }
};

BillChecksUI.register('retail', {
    sectionId: 'saleSection',
    tableSelector: '#saleTable',
    saveButtons: '#saveSaleBtn, #printSaleBtn',
    getDraft: () => RetailSaleManager.getCheckDraft(),
    fields: {
        party: { inputs: ['saleCustomerName'] },
        payment: { inputs: ['saleCashPayment', 'saleOnlinePayment', 'saleDueAmount'], anchor: 'saleSplitRemaining' },
        'entry.rate': { inputs: ['saleRate'] },
        'entry.qty': { inputs: ['saleWeight'] }
    }
});

export { RetailSaleManager };
