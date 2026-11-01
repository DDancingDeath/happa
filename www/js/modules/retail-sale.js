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
import { KEPT_SERVER_PAYMENT_KEY, paymentSplitMessage } from '../utils/money.js';
import {
    buildPaymentSplit, computeLine, computeRetailTotals, editSplitFor, paidOnScreen, paymentSplit, prefillPayment, restInDue,
    shownAmount, sumWeights, validatePaymentSplit, weightsForEdit
} from '../utils/calc/billing.js';
import { BillChecksUI, readTypedNumber } from '../ui/bill-highlight.js';
import { t, tn } from '../i18n/index.js';
import { saveFailedText, SAVED_ON_PHONE_KEY, SAVE_UNCONFIRMED_KEY } from '../utils/storage-full.js';
import { buildDraftShareText } from '../utils/bill-share.js';
import { lineItemIdentity, isArchivedItem } from '../utils/item-catalog.js';

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
        
        const total = sumWeights(saleWeights);
        
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
        
        let allWeights = [];
        
        const typedWeight = parseFloat(weightInput?.value);
        const hasTypedWeight = typedWeight && typedWeight > 0;
        
        if (saleWeights.length > 0 || hasTypedWeight) {
            allWeights = [...saleWeights];
            if (hasTypedWeight) {
                allWeights.push(typedWeight);
            }
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
        
        const { qty, packets, total } = computeLine({ rate, weights: allWeights });
        
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
        // The edited line is back on the bill: a later picker rebuild may drop an archived item
        document.querySelectorAll('#saleItem option[data-edit-line]').forEach(o => { delete o.dataset.editLine; });
        if (isArchivedItem(item)) {
            UIManager.showToast(t('msg.items.archived_item_billed', { name: item.name || '' }), 4000);
        } else UIManager.showToast(t('msg.retail.added_sale', { itemName }));
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
        this.billingManager?.renderBillNumber?.();
        
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
                <td>₹${shownAmount(item.total)}</td>
                <td><button onclick="event.stopPropagation(); window.app.retailSale.removeSaleItem(${index})" style="background: #e74c3c; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer;">×</button></td>
            </tr>
        `).join('');
        
        // Update totals
        const { screenTotal, packetsShown } = computeRetailTotals(saleItems);
        
        if (saleTotalSpan) saleTotalSpan.textContent = shownAmount(screenTotal);
        if (totalSalePacketsSpan) totalSalePacketsSpan.textContent = packetsShown;
        
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
            if (this.billingManager) this.billingManager.ensureItemOption('saleItem', itemIndex);
            document.getElementById('saleItem').value = itemIndex;
            if (this.billingManager) this.billingManager.loadSaleRates();
            
            setTimeout(() => {
                document.getElementById('saleRate').value = item.rate;
            }, 50);
        }
        
        saleWeights = weightsForEdit(item);
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
        const shown = shownAmount(computeRetailTotals(saleItems).screenTotal);
        
        const saleTotalEl = document.getElementById('saleTotal');
        const amountReceivableEl = document.getElementById('amountReceivable');
        
        if (saleTotalEl) saleTotalEl.textContent = shown;
        if (amountReceivableEl) amountReceivableEl.textContent = shown;
        
        this.updateSalePaymentTotal();
    },

    /**
     * Update sale running total display
     */
    updateSaleRunningTotal() {
        const { kg: totalQty, lines: packetCount } = computeRetailTotals(saleItems);
        
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
        
        const totalReceivedEl = document.getElementById('totalReceived');
        if (totalReceivedEl) totalReceivedEl.textContent = paidOnScreen(split);
        Helpers.showSplitRemaining('saleSplitRemaining', validatePaymentSplit(computeRetailTotals(saleItems).total, split));
        BillChecksUI.schedule('retail');
    },

    /**
     * Cash / online / due as typed on the retail sale form, before rounding.
     * @returns {{cash: number, online: number, due: number}}
     */
    readTypedSplit() {
        return {
            online: Helpers.getInputNumber('saleOnlinePayment'),
            cash: Helpers.getInputNumber('saleCashPayment'),
            due: Helpers.getInputNumber('saleDueAmount')
        };
    },

    /**
     * Cash / online / due typed on the retail sale form, as checked and saved
     * (BF-SAVE; an edited bill's split settles on its new total, #129).
     * @returns {{cash: number, online: number, due: number}}
     */
    readPaymentSplit() {
        const editing = this.billingManager?.editingBillIndex !== undefined ? this.billingManager.getEditingBill?.() : null;
        return editing ? editSplitFor(this.readTypedSplit(), computeRetailTotals(saleItems).total, editing) : paymentSplit(this.readTypedSplit());
    },

    /**
     * One tap: put whatever is not yet received (total − cash − online) in Due.
     */
    putRestInDue() {
        const rest = restInDue(computeRetailTotals(saleItems).total, this.readPaymentSplit());
        if (!rest.ok) {
            UIManager.showToast(paymentSplitMessage(rest.check));
            return;
        }
        const dueInput = document.getElementById('saleDueAmount');
        if (dueInput) dueInput.value = rest.due;
        const dueCheckbox = document.getElementById('saleDueCheckbox');
        if (dueCheckbox) dueCheckbox.checked = rest.dueTicked;
        this.updateSalePaymentTotal();
    },

    /**
     * Fill receivable amount based on payment type
     * @param {'online'|'cash'|'due'} type - Payment type
     */
    fillReceivableAmount(type) {
        Helpers.applyPaymentPrefill(type, prefillPayment(type, computeRetailTotals(saleItems).screenTotal), {
            online: ['saleOnlinePayment', 'saleOnlineCheckbox'],
            cash: ['saleCashPayment', 'saleCashCheckbox'],
            due: ['saleDueAmount', 'saleDueCheckbox']
        });
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

        const { total: salesTotal, packetsSaved: totalPackets } = computeRetailTotals(saleItems);
        const split = this.readPaymentSplit();
        const { online: saleOnline, cash: saleCash, due: saleDue } = split;
        const saleCustomer = Helpers.getInputText('saleCustomerName');
        const saleComments = Helpers.getInputText('saleComments');
        const printComments = document.getElementById('salePrintComments')?.checked || false;
        
        // Payment, name-for-Due, stock (warns only for retail, #33) and the other checks (#37)
        this.updateSalePaymentTotal();
        const checks = await BillChecksUI.confirmSave('retail');
        if (!checks.ok) return;
        
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
                payment: buildPaymentSplit(split),
                ...BillChecksUI.billFields(checks)
            };
            
            const retry = pending.attempted;
            pending.attempted = true;
            const writePromise = FirebaseService.saveRetailSale(sale, { retry });
            if (typeof options.onWriteIssued === 'function') {
                options.onWriteIssued(sale);
            }
            await writePromise;
            // Not confirmed even on this phone: keep the form (a retry reuses the same id) (#153)
            if (FirebaseService.saveUnconfirmed(sale)) {
                UIManager.hideLoading();
                this.billingManager?.renderBillNumber?.();
                UIManager.showToast(t(SAVE_UNCONFIRMED_KEY), 'warning');
                return undefined;
            }
            
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
            UIManager.showToast(FirebaseService.keptServerPayment(sale) ? t(KEPT_SERVER_PAYMENT_KEY)
                : FirebaseService.savedOnPhoneOnly(sale) ? t(SAVED_ON_PHONE_KEY) : t('msg.retail.sale_completed_successfully'));
            UIManager.hapticFeedback('success');
            
            return sale;
            
        } catch (error) {
            UIManager.hideLoading();
            this.billingManager?.renderBillNumber?.();
            UIManager.showToast(saveFailedText(error, t('msg.retail.failed_complete_sale', { message: error.message })), 'error');
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
        this.billingManager?.focusFirstItem?.();
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
        
        const salesTotal = computeRetailTotals(saleItems).screenTotal;
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
                UIManager.showToast(FirebaseService.savedOnPhoneOnly(savedSale) ? t(SAVED_ON_PHONE_KEY) : t('msg.common.sale_saved_printed'));
            }
        } catch (error) {
            console.error('Print sale error:', error);
            UIManager.showToast(saveFailedText(error, t('msg.common.error_2', { value: error?.message || error })), 'error');
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
            total: computeRetailTotals(saleItems).total,
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
