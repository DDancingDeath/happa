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
import { KEPT_SERVER_PAYMENT_KEY, paymentSplitMessage, formatRate, formatRupees, formatKg, formatAmount } from '../utils/money.js';
import {
    bagChecks, buildPaymentSplit, computeLine, computeRetailTotals, editSplitFor, paidOnScreen, paymentSplit, pendingLine, prefillPayment, restInDue,
    shownAmount, sumWeights, validatePaymentSplit, weightsForEdit
} from '../utils/calc/billing.js';
import { BillChecksUI, clearFieldError, readTypedNumber, showFieldError } from '../ui/bill-highlight.js';
import { settlePendingLine } from '../ui/pending-line.js';
import { checkBagWeight, checkLineRate, confirmLineBags, keptBagChecks } from '../ui/rate-check.js';
import { t, tn } from '../i18n/index.js';
import { icon } from '../ui/icons.js';
import { emit, BILL_CLEARED } from '../utils/events.js';
import { saveFailedText, SAVED_ON_PHONE_KEY, SAVE_UNCONFIRMED_KEY } from '../utils/storage-full.js';
import { buildDraftShareText } from '../utils/bill-share.js';
import { lineItemIdentity, isArchivedItem } from '../utils/item-catalog.js';
import { billTimeFor, validateBillDay } from '../utils/bill-date.js';
import { allowBackdatedCash, billDateWho, lockBillDate, pickedBillDay, resetBillDate } from '../ui/bill-date-input.js';

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
/** Confirms of heavy packets among the weights (BF-BAGCHECK), moved onto the line at Add to bill. */
let saleWeightChecks = [];
/** The line taken back into the entry boxes to edit (its rate confirm is kept if put back unchanged). */
let editedLine = null;

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
        // One packet above 100 kg: confirm first (BF-BAGCHECK)
        const bag = await checkBagWeight(weight, 'packet', 'saleWeight');
        if (!bag.ok) return;
        
        saleWeights.push(weight);
        if (bag.record) saleWeightChecks.push(bag.record);
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
        
        if (totalWeightsSpan) totalWeightsSpan.textContent = formatKg(total);
        if (totalPacketsSpan) totalPacketsSpan.textContent = saleWeights.length;
        
        container.innerHTML = `
            <div class="weights-compact-list">
                ${saleWeights.map((w, i) => `
                    <div class="weight-chip">
                        <span>${formatKg(w)}</span>
                        <button type="button" class="btn btn-ghost btn-icon" data-onclick="retailSale.removeSaleWeight(${i})" aria-label="${Helpers.escapeHtml(t('ui.modals.delete'))}">${icon('x', 'i-sm')}</button>
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
        saleWeightChecks = bagChecks(saleWeights, saleWeightChecks).confirmed;
        this.renderSaleWeights();
        if (this.billingManager) this.billingManager.triggerAutoSave();
        UIManager.hapticFeedback();
    },

    /**
     * Clear all sale weights
     */
    clearSaleWeights() {
        saleWeights = [];
        saleWeightChecks = [];
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
            if (!showFieldError('saleRate', t('msg.common.enter_valid_rate'))) UIManager.showToast(t('msg.common.enter_valid_rate'));
            return;
        }
        clearFieldError('saleRate');
        
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
        
        // Packets above 100 kg are confirmed (BF-BAGCHECK), the weight typed with them too;
        // a weight typed with no packets is the line's total kg, not a packet
        const packetWeights = saleWeights.length > 0 ? allWeights : [];
        const bags = await confirmLineBags(packetWeights, saleWeightChecks, 'packet', 'saleWeight');
        saleWeightChecks = bags.kept;
        if (!bags.ok) return;
        
        const { qty, packets, total } = computeLine({ rate, weights: allWeights });
        // ≥ 5× or ≤ ⅕ of today's rate: confirm first (BF-RATECHECK, OD-02)
        const { ok, rateCheck } = await checkLineRate({ kind: 'retail', item, label: itemName, rate, qty, rateInputId: 'saleRate', keptLines: this.keptLines() });
        if (!ok) return;
        
        saleItems.push({
            itemId: item.id,
            name: item.name,
            rate,
            qty,
            packets,
            weights: allWeights,
            total,
            ...(rateCheck ? { rateCheck } : {}),
            ...(bags.weightCheck.length ? { weightCheck: bags.weightCheck } : {}),
            timestamp: Date.now()
        });
        editedLine = null;
        
        this.renderSalesBill();
        if (this.billingManager) this.billingManager.triggerAutoSave();
        
        // Clear weights and reset inputs
        saleWeights = [];
        saleWeightChecks = [];
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
            tbody.innerHTML = `<tr><td colspan="5" class="empty" data-i18n="msg.common.no_items_in_bill">${Helpers.escapeHtml(t('msg.common.no_items_in_bill'))}</td></tr>`;
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
                        weightLines.push(lineWeights.map(w => formatKg(w)).join('&nbsp;&nbsp;'));
                    }
                    
                    return `
                        <div class="bill-weights bill-weights-sale">
                            <div class="bill-weights-title">
                                ${Helpers.escapeHtml(lineLabel(item))} (${Helpers.escapeHtml(tn('ui.print.packets_kg', item.weights.length, { kg: formatKg(item.qty) }))})
                            </div>
                            <div class="bill-weights-list">
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
            <tr class="bill-line" data-onclick="retailSale.editSaleItem(${index})">
                <td>${Helpers.escapeHtml(lineLabel(item))}</td>
                <td>${formatRate(item.rate)}</td>
                <td>${formatKg(item.qty)} kg</td>
                <td>${formatRupees(shownAmount(item.total))}</td>
                <td><button type="button" class="btn btn-ghost btn-icon bill-line-remove" data-onclick="event.stopPropagation(); retailSale.removeSaleItem(${index})" aria-label="${Helpers.escapeHtml(t('ui.modals.delete'))}" title="${Helpers.escapeHtml(t('ui.modals.delete'))}">${icon('x')}</button></td>
            </tr>
        `).join('');
        
        // Update totals
        const { screenTotal, packetsShown } = computeRetailTotals(saleItems);
        
        if (saleTotalSpan) saleTotalSpan.textContent = formatAmount(shownAmount(screenTotal), 'exact');
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
    async editSaleItem(index) {
        const currentItem = Helpers.getInputText('saleItem');
        const currentRate = Helpers.getInputNumber('saleRate');
        
        if (currentItem && currentRate && saleWeights.length > 0) {
            await this.addToSalesBill(true);
            // The typed line was not added (e.g. "Fix rate"): finish it before opening another
            if (saleWeights.length > 0) return;
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
        saleWeightChecks = keptBagChecks(saleWeights, item.weightCheck);
        editedLine = item;
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
        const shown = formatAmount(shownAmount(computeRetailTotals(saleItems).screenTotal), 'exact');
        
        const saleTotalEl = document.getElementById('saleTotal');
        const amountReceivableEl = document.getElementById('amountReceivable');
        
        if (saleTotalEl) saleTotalEl.textContent = shown;
        if (amountReceivableEl) amountReceivableEl.textContent = shown;
        const barReceivable = document.getElementById('barReceivable');
        if (barReceivable) barReceivable.textContent = shown;
        
        this.updateSalePaymentTotal();
    },

    /**
     * Update sale running total display
     */
    updateSaleRunningTotal() {
        const { kg: totalQty, lines: packetCount } = computeRetailTotals(saleItems);
        
        const runningTotalEl = document.getElementById('saleRunningTotal');
        const packetCountEl = document.getElementById('salePacketCount');
        
        if (runningTotalEl) runningTotalEl.textContent = formatKg(totalQty);
        if (packetCountEl) packetCountEl.textContent = packetCount;
    },

    /**
     * Update sale payment total display
     */
    updateSalePaymentTotal() {
        const split = this.readPaymentSplit();
        
        const totalReceivedEl = document.getElementById('totalReceived');
        if (totalReceivedEl) totalReceivedEl.textContent = formatAmount(paidOnScreen(split), 'exact');
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
        if (!(await this.settleEntryLine())) return undefined;
        // Check if in edit mode
        if (this.billingManager?.editingBillIndex !== undefined) {
            return this.billingManager.saveEditedBill(options);
        }
        
        if (saleItems.length === 0) {
            UIManager.showToast(t('msg.retail.no_items_in_sale'));
            return;
        }
        // A restored copy of a bill the server said is already saved (#93): never written, online or not
        // A restored copy's create-only save given up on: another phone's bill was there, or not known yet
        const late = pendingBill?.restored ? FirebaseService.lateCreateState('retailSales', pendingBill.id) : null;
        if (late === 'foreign') pendingBill.knownSaved = true;
        if (pendingBill?.knownSaved) {
            UIManager.showToast(t('msg.billing.copy_already_saved'), 'warning');
            return;
        }
        if (late === 'pending' && typeof navigator !== 'undefined' && navigator.onLine === false) {
            UIManager.showToast(t('msg.billing.restore_check_pending'), 'warning');
            return;
        }

        const { total: salesTotal, packetsSaved: totalPackets } = computeRetailTotals(saleItems);
        const split = this.readPaymentSplit();
        const { online: saleOnline, cash: saleCash } = split;
        const saleCustomer = Helpers.getInputText('saleCustomerName');
        const saleComments = Helpers.getInputText('saleComments');
        const printComments = document.getElementById('salePrintComments')?.checked || false;
        
        // The bill's day (#147), fixed by the first attempt (a retry is written identically)
        const day = pickedBillDay('saleDate');
        const dayProblem = pendingBill?.timestamp ? null : validateBillDay(day, billDateWho());
        if (dayProblem) {
            UIManager.showToast(t(dayProblem.key, dayProblem.params), 'warning');
            return;
        }
        // Cash on a back-dated bill: owner only (that day's drawer may be closed)
        if (!(await allowBackdatedCash(day, saleCash, pendingBill))) return;
        
        // Payment, name-for-Due, stock (warns only for retail, #33) and the other checks (#37)
        this.updateSalePaymentTotal();
        const checks = await BillChecksUI.confirmSave('retail');
        if (!checks.ok) return;
        
        const wasRestored = !!pendingBill?.restored;
        try {
            UIManager.showLoading();
            const pending = this.ensurePendingBill();
            if (!pending.billNumber) pending.billNumber = await Helpers.generateBillNumber('S', 'retailSales');
            // A retry keeps the first attempt's time so an unchanged sale is written identically
            if (!pending.timestamp) {
                const now = new Date();
                const at = billTimeFor(pickedBillDay('saleDate', now), now);
                pending.timestamp = at.getTime();
                pending.date = at.toISOString();
                pending.enteredAt = now.getTime();
                lockBillDate('saleDate', pending.timestamp);
            }
            
            const sale = {
                id: pending.id,
                billNumber: pending.billNumber,
                items: saleItems,
                total: salesTotal,
                totalPackets: totalPackets,
                onlinePayment: saleOnline,
                cashPayment: saleCash,
                customerName: saleCustomer,
                comments: saleComments,
                printComments: printComments,
                type: 'retail',
                isPurchase: false,
                date: pending.date,
                userId: AppState.currentUser ? AppState.currentUser.uid : 'unknown',
                userName: AppState.userName || 'User',
                timestamp: pending.timestamp,
                enteredAt: pending.enteredAt || pending.timestamp,
                payment: buildPaymentSplit(split),
                ...BillChecksUI.billFields(checks)
            };
            
            // Restored from an auto-save or a draft (#93): online it is saved only while its id is free;
            // offline it is a plain first save (a create-only try wrote nothing), after which the id may
            // be this phone's own bill
            if (pending.restored && typeof navigator !== 'undefined' && navigator.onLine === false) {
                pending.restored = false;
                pending.attempted = false;
            }
            const restored = !!pending.restored;
            const retry = pending.attempted;
            pending.attempted = true;
            // Online, a first save (and every save of a restored copy) only creates the bill: one
            // already under this id was saved by another phone (the same user's auto-save) (#93)
            const writePromise = FirebaseService.saveRetailSale(sale, { retry, createOnly: restored || !retry, ...(restored ? { strict: true } : {}) });
            // A restored copy is printed only once it is known not to be a copy of a saved bill
            if (restored) await writePromise;
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
            emit(BILL_CLEARED, 'sale');
            editedLine = null;
            this.renderSalesBill();
            
            // Reset form
            this.resetForm();
            
            UIManager.hideLoading();
            UIManager.showToast(this.savedText(sale));
            UIManager.hapticFeedback('success');
            
            return sale;
            
        } catch (error) {
            UIManager.hideLoading();
            this.billingManager?.renderBillNumber?.();
            // A create-only try that queued nothing: the next save is a first save again
            if (error?.nothingQueued && pendingBill) {
                pendingBill.attempted = false;
                if (wasRestored) pendingBill.restored = true;
            }
            if (error?.code === 'already-saved') {
                if (pendingBill) pendingBill.knownSaved = true;
                // Kept in the auto-save too, so a later Restore offline knows it
                this.billingManager?.autoSaveToCloud().catch(e => console.warn('Auto-save failed:', e));
                await this.billingManager?.offerSavedBill?.(error.bill, 'retail', { items: saleItems });
                return undefined;
            }
            UIManager.showToast(saveFailedText(error, t('msg.retail.failed_complete_sale', { message: error.message })), 'error');
            console.error('Complete sale error:', error);
            throw error;
        }
    },

    /** What the save toast says for a saved sale (also the first half of the print status). */
    savedText(sale) {
        if (FirebaseService.keptServerPayment(sale)) return t(KEPT_SERVER_PAYMENT_KEY);
        if (FirebaseService.savedOnPhoneOnly(sale)) return t(SAVED_ON_PHONE_KEY);
        return t('msg.retail.sale_completed_successfully');
    },

    /** The entry boxes as BF-PENDING reads them. */
    entryLine() {
        const item = AppState.items[parseInt(document.getElementById('saleItem')?.value)];
        return {
            item,
            entry: {
                itemChosen: !!item,
                rateText: document.getElementById('saleRate')?.value,
                qtyText: document.getElementById('saleWeight')?.value,
                chips: saleWeights
            }
        };
    },

    entryLineEmpty() {
        return pendingLine(this.entryLine().entry).state === 'empty';
    },

    /**
     * A line typed but not added to the sale is never dropped silently (BF-PENDING):
     * the user adds or discards it, or goes back to it.
     * @returns {Promise<boolean>} true when the save may go on
     */
    async settleEntryLine() {
        const { item, entry } = this.entryLine();
        return settlePendingLine({
            entry,
            label: item ? lineLabel(item) : '',
            inputs: { item: 'saleItem', rate: 'saleRate', qty: 'saleWeight' },
            add: async () => {
                const before = saleItems.length;
                await this.addToSalesBill();
                return saleItems.length > before;
            },
            discard: () => {
                saleWeights = [];
                saleWeightChecks = [];
                const itemSelect = document.getElementById('saleItem');
                if (itemSelect) itemSelect.selectedIndex = 0;
                ['saleRate', 'saleWeight'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.value = '';
                });
                this.renderSaleWeights();
                if (this.billingManager) this.billingManager.triggerAutoSave();
            }
        });
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
        resetBillDate('saleDate');
        this.billingManager?.focusFirstItem?.();
    },

    /**
     * Clear the current sale
     */
    clearSale() {
        pendingBill = null;
        saleItems = [];
        emit(BILL_CLEARED, 'sale');
        editedLine = null;
        saleWeights = [];
        saleWeightChecks = [];
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
        if (saleItems.length === 0 && this.entryLineEmpty()) {
            UIManager.showToast(t('msg.retail.no_items_in_sale'));
            return;
        }
        
        let printPromise = null;
        const report = {};
        const editing = this.billingManager?.editingBillIndex !== undefined;
        try {
            const savedSale = await Helpers.runExclusive('retail', RETAIL_BUTTONS, () => this._completeSale({
                onWriteIssued: (sale) => { printPromise = PrinterService.printBill(sale, report); }
            }));
            
            if (!printPromise) {
                return;
            }
            
            const printed = await printPromise;
            if (!savedSale) return;
            PrinterService.showSavePrintStatus({
                printed, report, savedText: editing ? t('msg.billing.sale_updated_successfully') : this.savedText(savedSale),
                printedText: FirebaseService.savedOnPhoneOnly(savedSale) ? t(SAVED_ON_PHONE_KEY) : t('msg.common.sale_saved_printed')
            });
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
    /** Lines whose rate confirm is kept when put back unchanged: the saved bill being edited, the line taken back to edit. */
    keptLines() {
        const bill = this.billingManager?.editingBillIndex !== undefined ? this.billingManager.getEditingBill?.() : null;
        return [...(Array.isArray(bill?.items) ? bill.items : []), ...(editedLine ? [editedLine] : [])];
    },

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
            date: editing ? original?.date : (pendingBill?.date || billTimeFor(pickedBillDay('saleDate')).toISOString()),
            enteredAt: editing ? (original?.enteredAt || original?.timestamp) : (pendingBill?.enteredAt || pendingBill?.timestamp),
            entry: item ? { itemId: item.id, name: item.name, rate: readTypedNumber('saleRate'), qty: readTypedNumber('saleWeight') } : null
        };
    },

    ensurePendingBill() {
        if (!pendingBill) pendingBill = { id: Helpers.generateId(), billNumber: null, attempted: false, date: null, timestamp: null, enteredAt: null };
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
            timestamp: pending.timestamp || null,
            enteredAt: pending.enteredAt || null,
            restored: !!pending.restored,
            knownSaved: !!pending.knownSaved
        } : null;
        // A restored attempt keeps its day, shown locked; otherwise the box starts again
        if (pendingBill?.timestamp) lockBillDate('saleDate', pendingBill.timestamp);
        else resetBillDate('saleDate');
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
        emit(BILL_CLEARED, 'sale');
    },

    /** A bill line taken back into the form to edit (#131: voice undo waits for it). */
    isEditingLine() {
        return !!editedLine;
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
        saleWeightChecks = bagChecks(saleWeights, saleWeightChecks).confirmed;
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
