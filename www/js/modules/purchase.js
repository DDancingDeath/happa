/**
 * @fileoverview Purchase module for managing purchase transactions
 * Handles purchase bill creation, weight tracking, and saving
 * @module modules/purchase
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
import { PrinterService } from '../services/printer.js';
import { Helpers } from '../utils/helpers.js';
import { KEPT_SERVER_PAYMENT_KEY, normalizeLabourSettings, paymentSplitMessage, formatRate, formatRupees, formatKg, formatAmount } from '../utils/money.js';
import {
    autoLabour, bagChecks, buildPaymentSplit, computeLine, computePurchaseTotals, draftLineSum, editSplitFor, paidOnScreen, payableOnScreen,
    paymentSplit, pendingLine, prefillPayment, restInDue, shownAmount, sumWeights, validatePaymentSplit
} from '../utils/calc/billing.js';
import { BillChecksUI, readTypedNumber } from '../ui/bill-highlight.js';
import { settlePendingLine } from '../ui/pending-line.js';
import { checkBagWeight, checkLineRate, confirmLineBags, keptBagChecks } from '../ui/rate-check.js';
import { t, tn } from '../i18n/index.js';
import { emit, BILL_CLEARED } from '../utils/events.js';
import { saveFailedText, SAVED_ON_PHONE_KEY, SAVE_UNCONFIRMED_KEY } from '../utils/storage-full.js';
import { buildDraftShareText } from '../utils/bill-share.js';
import { lineItemIdentity, isArchivedItem } from '../utils/item-catalog.js';
import { billTimeFor, validateBillDay } from '../utils/bill-date.js';
import { allowBackdatedCash, billDateWho, lockBillDate, pickedBillDay, resetBillDate } from '../ui/bill-date-input.js';

/** Name to show for a catalogue item or bill line in the chosen item-name language. */
const lineLabel = (line) => lineItemIdentity(line && 'itemId' in line ? line : { itemId: line?.id, name: line?.name }, AppState.items, AppState.settings.showHindi).label;

/** Buttons disabled while a purchase save/print is in flight */
const PURCHASE_BUTTONS = '#saveBillBtn, #printBillBtn';

/**
 * @type {Array<Object>} Current bill items for purchase mode
 * @private
 */
let billItems = [];

/**
 * @type {Array<number>} Weight entries for purchase mode
 * @private
 */
let weights = [];
/** Confirms of heavy bags among the weights (BF-BAGCHECK), moved onto the line at Add to bill. */
let weightChecks = [];
/** The line taken back into the entry boxes to edit (its rate confirm is kept if put back unchanged). */
let editedLine = null;

/**
 * Id (and bill number, once issued) of the bill being entered. Created with the
 * bill and reused by every save attempt, so a retry after a timeout overwrites
 * the same document instead of creating a second bill (#70). Cleared only after
 * a confirmed save or when the bill is discarded.
 * @type {{id: string, billNumber: (string|null)}|null}
 */
let pendingBill = null;

/**
 * Purchase Manager - Handles all purchase operations
 * @namespace PurchaseManager
 */
const PurchaseManager = {
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
    async addWeight(autoAddToBill = false) {
        const weightInput = document.getElementById('newWeight');
        const weight = parseFloat(weightInput?.value);
        
        if (!weight || weight <= 0) {
            UIManager.showToast(t('msg.common.enter_valid_weight'));
            return;
        }
        // One bag above 100 kg: confirm first (BF-BAGCHECK)
        const bag = await checkBagWeight(weight, 'bag', 'newWeight');
        if (!bag.ok) return;
        
        weights.push(weight);
        if (bag.record) weightChecks.push(bag.record);
        weightInput.value = '';
        weightInput.focus();
        
        this.renderWeights();
        if (this.billingManager) this.billingManager.triggerAutoSave();
        UIManager.hapticFeedback();
        
        if (autoAddToBill && weights.length === 1) {
            await this.addToBill(true);
        }
    },

    /**
     * Render the weights display
     */
    renderWeights() {
        const container = document.getElementById('weightsDisplay');
        if (!container) return;
        
        const totalWeightsSpan = document.getElementById('totalWeights');
        const totalPacketsSpan = document.getElementById('totalPackets');
        
        if (weights.length === 0) {
            container.innerHTML = '';
            if (totalWeightsSpan) totalWeightsSpan.textContent = '0';
            if (totalPacketsSpan) totalPacketsSpan.textContent = '0';
            return;
        }
        
        const total = sumWeights(weights);
        
        if (totalWeightsSpan) totalWeightsSpan.textContent = formatKg(total);
        if (totalPacketsSpan) totalPacketsSpan.textContent = weights.length;
        
        container.innerHTML = `
            <div class="weights-compact-list">
                ${weights.map((w, i) => `
                    <div class="weight-chip">
                        <span>${formatKg(w)}</span>
                        <button class="weight-chip-remove" data-onclick="purchase.removeWeight(${i})">×</button>
                    </div>
                `).join('')}
            </div>
        `;
    },

    /**
     * Remove a weight by index
     * @param {number} index - Index of weight to remove
     */
    removeWeight(index) {
        weights.splice(index, 1);
        weightChecks = bagChecks(weights, weightChecks).confirmed;
        this.renderWeights();
        if (this.billingManager) this.billingManager.triggerAutoSave();
        UIManager.hapticFeedback();
    },

    /**
     * Clear all weights
     */
    clearWeights() {
        weights = [];
        weightChecks = [];
        this.renderWeights();
        if (this.billingManager) this.billingManager.triggerAutoSave();
        UIManager.hapticFeedback();
    },

    // -------------------- BILL MANAGEMENT --------------------

    /**
     * Add current item to bill
     * @async
     * @param {boolean} autoAdd - Whether this is an auto-add
     */
    async addToBill(autoAdd = false) {
        const itemSelect = document.getElementById('billItem');
        const rateInput = document.getElementById('billRate');
        const weightInput = document.getElementById('newWeight');
        
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
        
        // If there's a weight typed in the input but not added, add it first
        const pendingWeight = parseFloat(weightInput?.value);
        if (pendingWeight && pendingWeight > 0) {
            // One bag above 100 kg: confirm first (BF-BAGCHECK)
            const bag = await checkBagWeight(pendingWeight, 'bag', 'newWeight');
            if (!bag.ok) return;
            weights.push(pendingWeight);
            if (bag.record) weightChecks.push(bag.record);
            weightInput.value = '';
            this.renderWeights();
        }
        
        if (weights.length === 0) {
            UIManager.showToast(t('msg.purchase.add_at_least_one_weight'));
            return;
        }
        
        const item = AppState.items[itemIndex];
        if (!item) {
            UIManager.showToast(t('msg.common.item_not_found'));
            return;
        }
        this.ensurePendingBill();
        
        const lineWeights = [...weights];
        const { qty, total } = computeLine({ rate, weights: lineWeights });
        // A heavy bag not confirmed yet (e.g. weights of a restored bill) is asked now
        const bags = await confirmLineBags(lineWeights, weightChecks, 'bag', 'newWeight');
        weightChecks = bags.kept;
        if (!bags.ok) return;
        
        // Bill lines keep the catalogue name; Hindi is only for display (#143, Reports group by item).
        const displayName = lineLabel(item);
        // ≥ 5× or ≤ ⅕ of today's rate: confirm first (BF-RATECHECK, OD-02)
        const { ok, rateCheck } = await checkLineRate({ kind: 'purchase', item, label: displayName, rate, qty, rateInputId: 'billRate', keptLines: this.keptLines() });
        if (!ok) return;
        
        billItems.push({
            itemId: item.id,
            name: item.name,
            rate,
            qty,
            total,
            weights: lineWeights,
            ...(rateCheck ? { rateCheck } : {}),
            ...(bags.weightCheck.length ? { weightCheck: bags.weightCheck } : {}),
            timestamp: Date.now()
        });
        
        // Clear inputs
        weights = [];
        weightChecks = [];
        editedLine = null;
        this.renderWeights();
        this.renderBill();
        if (this.billingManager) this.billingManager.triggerAutoSave();
        
        // Reset form
        const newWeightInput = document.getElementById('newWeight');
        if (newWeightInput) {
            newWeightInput.value = '';
            newWeightInput.focus();
        }
        
        UIManager.hapticFeedback();
        // The edited line is back on the bill: a later picker rebuild may drop an archived item
        document.querySelectorAll('#billItem option[data-edit-line]').forEach(o => { delete o.dataset.editLine; });
        if (isArchivedItem(item)) {
            UIManager.showToast(t('msg.items.archived_item_billed', { name: item.name || '' }), 4000);
        } else UIManager.showToast(t('msg.purchase.added_bill', { displayName }));
    },

    /**
     * Render the bill table
     */
    renderBill() {
        const tbody = document.querySelector('#billTable tbody');
        const weightBreakdownSection = document.getElementById('weightBreakdownSection');
        if (!tbody) return;
        this.billingManager?.renderBillNumber?.();
        
        const totalPacketsInBillSpan = document.getElementById('totalPacketsInBill');
        const billTotalSpan = document.getElementById('billTotal');
        
        if (billItems.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="bill-empty" data-i18n="msg.common.no_items_in_bill">${Helpers.escapeHtml(t('msg.common.no_items_in_bill'))}</td></tr>`;
            if (billTotalSpan) billTotalSpan.textContent = '0';
            if (totalPacketsInBillSpan) totalPacketsInBillSpan.textContent = '0';
            if (weightBreakdownSection) weightBreakdownSection.innerHTML = '';
            this.updateTotals();
            return;
        }
        
        // Render weight breakdown for items with 2 or more packets
        if (weightBreakdownSection) {
            const itemsWithMultipleWeights = billItems.filter(item => item.weights.length >= 2);
            
            if (itemsWithMultipleWeights.length > 0) {
                weightBreakdownSection.innerHTML = itemsWithMultipleWeights.map(item => {
                    const weightsPerLine = 6;
                    const weightLines = [];
                    for (let i = 0; i < item.weights.length; i += weightsPerLine) {
                        const lineWeights = item.weights.slice(i, i + weightsPerLine);
                        weightLines.push(lineWeights.map(w => formatKg(w)).join('&nbsp;&nbsp;'));
                    }
                    
                    return `
                        <div class="bill-weights bill-weights-purchase">
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
                weightBreakdownSection.innerHTML = '';
            }
        }
        
        // Render bill items table
        tbody.innerHTML = billItems.map((item, index) => {
            return `
                <tr class="bill-line" data-onclick="purchase.editBillItem(${index})">
                    <td>${Helpers.escapeHtml(lineLabel(item))}</td>
                    <td>${formatRate(item.rate)}</td>
                    <td>${formatKg(item.qty)} kg</td>
                    <td>${formatRupees(shownAmount(item.total))}</td>
                    <td><button type="button" class="remove-bill-item" data-onclick="event.stopPropagation(); purchase.deleteBillItem(${index})" aria-label="${Helpers.escapeHtml(t('ui.modals.delete'))}" title="${Helpers.escapeHtml(t('ui.modals.delete'))}">×</button></td>
                </tr>
            `;
        }).join('');
        
        // Update totals
        const { billTotal, totalPackets } = this.computeTotals(0);
        
        if (billTotalSpan) billTotalSpan.textContent = formatAmount(shownAmount(billTotal), 'exact');
        if (totalPacketsInBillSpan) totalPacketsInBillSpan.textContent = totalPackets;
        
        // Don't clear manually set flag when in edit mode
        const laborChargesInput = document.getElementById('manualLaborCharges');
        if (laborChargesInput && this.billingManager?.editingBillIndex === undefined) {
            delete laborChargesInput.dataset.manuallySet;
        }
        
        this.updateTotals();
    },

    /**
     * Delete a bill item by index
     * @param {number} index - Index of item to delete
     */
    deleteBillItem(index) {
        billItems.splice(index, 1);
        this.renderBill();
        if (this.billingManager) this.billingManager.triggerAutoSave();
        UIManager.hapticFeedback();
    },

    /**
     * Edit a bill item
     * @param {number} index - Index of item to edit
     */
    async editBillItem(index) {
        const currentItem = Helpers.getInputText('billItem');
        const currentRate = Helpers.getInputNumber('billRate');
        
        if (currentItem && currentRate && weights.length > 0) {
            await this.addToBill(true);
            // The typed line was not added (e.g. "Fix rate"): finish it before opening another
            if (weights.length > 0) return;
        }
        
        const item = billItems[index];
        if (!item) return;
        
        billItems.splice(index, 1);
        this.renderBill();
        
        const itemIndex = AppState.items.findIndex(i => i.id === item.itemId || i.name === item.name);
        if (itemIndex !== -1) {
            if (this.billingManager) this.billingManager.ensureItemOption('billItem', itemIndex);
            document.getElementById('billItem').value = itemIndex;
            if (this.billingManager) this.billingManager.loadRates();
            
            setTimeout(() => {
                document.getElementById('billRate').value = item.rate;
            }, 50);
        }
        
        weights = item.weights || [];
        weightChecks = keptBagChecks(weights, item.weightCheck);
        editedLine = item;
        this.renderWeights();
        
        if (this.billingManager) this.billingManager.triggerAutoSave();
        UIManager.hapticFeedback();
        UIManager.showToast(t('msg.common.item_loaded_editing'));
    },

    // -------------------- TOTALS --------------------

    /**
     * Totals of the current bill computed from its items (the screen is display-only).
     * @param {number} [laborCharges] - labour to deduct; defaults to the labour field
     *   (0 when the Labour checkbox is unticked)
     * @returns {{billTotal: number, laborCharges: number, grandTotal: number, totalPackets: number, heavyPackets: number}}
     */
    computeTotals(laborCharges) {
        if (laborCharges === undefined) laborCharges = this.typedLabour();
        const { heavyWeightThreshold } = normalizeLabourSettings(AppState.settings);
        return computePurchaseTotals(billItems, laborCharges, heavyWeightThreshold);
    },

    /**
     * Update totals display. Heavy packets are counted from the bill items.
     */
    updateTotals() {
        const { billTotal, heavyPackets: heavyPacketsCount } = this.computeTotals(0);
        const autoLaborCheckbox = document.getElementById('autoLaborCharge');
        const laborCalculationSpan = document.getElementById('laborCalculation');
        const laborChargesInput = document.getElementById('manualLaborCharges');
        
        let laborCharges = 0;
        if (autoLaborCheckbox?.checked) {
            // Shared rate for every device (#20); blank/invalid falls back to ₹6
            const suggested = autoLabour(AppState.settings, heavyPacketsCount);
            
            if (laborChargesInput && !laborChargesInput.dataset.manuallySet && this.billingManager?.editingBillIndex === undefined) {
                laborChargesInput.value = suggested.box;
            }
            
            if (laborChargesInput) {
                laborChargesInput.disabled = false;
                laborChargesInput.style.opacity = '1';
                laborChargesInput.style.cursor = 'text';
            }
            if (laborCalculationSpan) {
                laborCalculationSpan.textContent = suggested.working;
            }
            
            laborCharges = parseFloat(laborChargesInput?.value || 0);
        } else {
            if (laborChargesInput) {
                laborChargesInput.value = '0';
                laborChargesInput.disabled = true;
                laborChargesInput.style.opacity = '0.5';
                laborChargesInput.style.cursor = 'not-allowed';
            }
            if (laborCalculationSpan) {
                laborCalculationSpan.textContent = '';
            }
            laborCharges = 0;
        }
        
        const payableShown = formatAmount(payableOnScreen(billTotal, laborCharges), 'exact');
        const grandTotalElement = document.getElementById('amountPayable');
        if (grandTotalElement) {
            grandTotalElement.textContent = payableShown;
        }
        // The phone action bar repeats BF-PAYABLE
        const barPayable = document.getElementById('barPayable');
        if (barPayable) barPayable.textContent = payableShown;
        
        this.updatePaymentTotal();
    },

    /**
     * Update payment total display
     */
    updatePaymentTotal() {
        const split = this.readPaymentSplit();
        
        const totalPaymentElement = document.getElementById('totalPayment');
        if (totalPaymentElement) {
            totalPaymentElement.textContent = formatAmount(paidOnScreen(split), 'exact');
        }
        Helpers.showSplitRemaining('purchaseSplitRemaining', validatePaymentSplit(this.computeTotals().grandTotal, split));
        BillChecksUI.schedule('purchase');
    },

    /**
     * The Labour box as typed (0 when Labour is unticked), before rounding.
     * @returns {number}
     */
    typedLabour() {
        const autoLaborCheckbox = document.getElementById('autoLaborCharge');
        const labourOn = autoLaborCheckbox ? autoLaborCheckbox.checked : true;
        return labourOn ? Helpers.getInputNumber('manualLaborCharges') : 0;
    },

    /**
     * Cash / online / due as typed, before rounding.
     * @returns {{cash: number, online: number, due: number}}
     */
    readTypedSplit() {
        return {
            online: Helpers.getInputNumber('onlinePayment'),
            cash: Helpers.getInputNumber('cashPayment'),
            due: Helpers.getInputNumber('dueAmount')
        };
    },

    /**
     * Cash / online / due typed on the purchase form, as checked and saved
     * (BF-SAVE; an edited bill's split settles on its new total, #129).
     * @returns {{cash: number, online: number, due: number}}
     */
    readPaymentSplit() {
        const editing = this.billingManager?.editingBillIndex !== undefined ? this.billingManager.getEditingBill?.() : null;
        return editing ? editSplitFor(this.readTypedSplit(), this.computeTotals().grandTotal, editing) : paymentSplit(this.readTypedSplit());
    },

    /**
     * One tap: put whatever is not yet paid (total − cash − online) in Due.
     */
    putRestInDue() {
        const rest = restInDue(this.computeTotals().grandTotal, this.readPaymentSplit());
        if (!rest.ok) {
            UIManager.showToast(paymentSplitMessage(rest.check));
            return;
        }
        const dueInput = document.getElementById('dueAmount');
        if (dueInput) dueInput.value = rest.due;
        const dueCheckbox = document.getElementById('dueCheckbox');
        if (dueCheckbox) dueCheckbox.checked = rest.dueTicked;
        this.updatePaymentTotal();
    },

    /**
     * Fill payable amount based on payment type
     * @param {'online'|'cash'|'due'} type - Payment type
     */
    fillPayableAmount(type) {
        Helpers.applyPaymentPrefill(type, prefillPayment(type, this.computeTotals().grandTotal), {
            online: ['onlinePayment', 'onlineCheckbox'],
            cash: ['cashPayment', 'cashCheckbox'],
            due: ['dueAmount', 'dueCheckbox']
        });
        this.updatePaymentTotal();
    },

    // -------------------- SAVE PURCHASE --------------------

    /**
     * Generate bill number
     * @async
     * @returns {Promise<string>} Generated bill number
     */
    async generateBillNumber() {
        return Helpers.generateBillNumber('P', 'purchases');
    },

    /**
     * Save bill to history. A second tap while a save is in flight is ignored.
     * @async
     * @param {Object} [options] - See _saveBill
     * @returns {Promise<Object|undefined>} The saved bill
     */
    async saveBillToHistory(options = {}) {
        return Helpers.runExclusive('purchase', PURCHASE_BUTTONS, () => this._saveBill(options));
    },

    /**
     * Save the bill and print it. Printing starts as soon as the bill write is
     * issued, using the exact bill object being saved.
     * @async
     */
    async printBill() {
        if (Helpers.isBusy('purchase')) return;
        if (billItems.length === 0 && this.entryLineEmpty()) {
            UIManager.showToast(t('msg.common.no_items_in_bill'));
            return;
        }
        
        let printPromise = null;
        const report = {};
        const editing = this.billingManager?.editingBillIndex !== undefined;
        try {
            const savedBill = await Helpers.runExclusive('purchase', PURCHASE_BUTTONS, () => this._saveBill({
                onWriteIssued: (bill) => { printPromise = PrinterService.printBill(bill, report); }
            }));
            
            if (!printPromise) return;
            const printed = await printPromise;
            if (!savedBill) return;
            PrinterService.showSavePrintStatus({
                printed, report, savedText: editing ? t('msg.billing.bill_updated_successfully') : this.savedText(savedBill),
                printedText: FirebaseService.savedOnPhoneOnly(savedBill) ? t(SAVED_ON_PHONE_KEY) : t('msg.purchase.bill_saved_printed')
            });
        } catch (error) {
            console.error('Print error:', error);
            UIManager.showToast(saveFailedText(error, t('msg.common.error_2', { value: error?.message || error })), 'error');
        }
    },

    /**
     * Save bill (unguarded; callers must hold the 'purchase' lock)
     * @async
     * @param {Object} [options]
     * @param {Function} [options.onWriteIssued] - Called with the bill once its write is issued
     * @returns {Promise<Object|undefined>} The saved bill
     * @private
     */
    async _saveBill(options = {}) {
        if (!(await this.settleEntryLine())) return undefined;
        // Check if in edit mode
        if (this.billingManager?.editingBillIndex !== undefined) {
            return this.billingManager.saveEditedBill(options);
        }
        
        if (billItems.length === 0) {
            UIManager.showToast(t('msg.common.no_items_in_bill'));
            return;
        }
        // A restored copy of a bill the server said is already saved (#93): never written, online or not
        // A restored copy's create-only save given up on: another phone's bill was there, or not known yet
        const late = pendingBill?.restored ? FirebaseService.lateCreateState('purchases', pendingBill.id) : null;
        if (late === 'foreign') pendingBill.knownSaved = true;
        if (pendingBill?.knownSaved) {
            UIManager.showToast(t('msg.billing.copy_already_saved'), 'warning');
            return;
        }
        if (late === 'pending' && typeof navigator !== 'undefined' && navigator.onLine === false) {
            UIManager.showToast(t('msg.billing.restore_check_pending'), 'warning');
            return;
        }
        
        // Totals come from the items, never from the (rounded) text on screen
        const { billTotal, laborCharges, totalPackets, grandTotal } = this.computeTotals();
        const split = this.readPaymentSplit();
        const { online: onlinePayment, cash: cashPayment } = split;
        const customerName = Helpers.getInputText('customerName');
        const comments = Helpers.getInputText('billComments');
        const printComments = document.getElementById('billPrintComments')?.checked || false;
        
        // The bill's day (#147), fixed by the first attempt (a retry is written identically)
        const day = pickedBillDay('billDate');
        const dayProblem = pendingBill?.timestamp ? null : validateBillDay(day, billDateWho());
        if (dayProblem) {
            UIManager.showToast(t(dayProblem.key, dayProblem.params), 'warning');
            return;
        }
        // Cash on a back-dated bill: owner only (that day's drawer may be closed)
        if (!(await allowBackdatedCash(day, cashPayment, pendingBill))) return;
        
        // Payment, name-for-Due and the other bill checks (#23, #68, #37)
        this.updatePaymentTotal();
        const checks = await BillChecksUI.confirmSave('purchase');
        if (!checks.ok) return;
        
        const autoLaborCheckbox = document.getElementById('autoLaborCharge');
        const laborChargesInput = document.getElementById('manualLaborCharges');
        const laborCalculationSpan = document.getElementById('laborCalculation');
        const laborCalc = (autoLaborCheckbox?.checked && !laborChargesInput?.dataset.manuallySet) 
            ? laborCalculationSpan?.textContent || null 
            : null;
        
        const wasRestored = !!pendingBill?.restored;
        try {
            UIManager.showLoading();
            const pending = this.ensurePendingBill();
            if (!pending.billNumber) pending.billNumber = await Helpers.generateBillNumber('P', 'purchases');
            // A retry keeps the first attempt's time so an unchanged bill is written identically
            if (!pending.timestamp) {
                const now = new Date();
                const at = billTimeFor(pickedBillDay('billDate', now), now);
                pending.timestamp = at.getTime();
                pending.date = at.toISOString();
                pending.enteredAt = now.getTime();
                lockBillDate('billDate', pending.timestamp);
            }
            
            const bill = {
                id: pending.id,
                billNumber: pending.billNumber,
                items: billItems,
                billTotal,
                laborCharges,
                laborCalc,
                totalPackets,
                grandTotal,
                amountPayable: grandTotal,
                onlinePayment,
                cashPayment,
                customerName,
                comments,
                printComments,
                type: 'purchase',
                isPurchase: true,
                date: pending.date,
                userId: AppState.currentUser ? AppState.currentUser.uid : 'unknown',
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
            const writePromise = FirebaseService.savePurchase(bill, { retry, createOnly: restored || !retry, ...(restored ? { strict: true } : {}) });
            // A restored copy is printed only once it is known not to be a copy of a saved bill
            if (restored) await writePromise;
            if (typeof options.onWriteIssued === 'function') {
                options.onWriteIssued(bill);
            }
            await writePromise;
            // Not confirmed even on this phone: keep the form (a retry reuses the same id) (#153)
            if (FirebaseService.saveUnconfirmed(bill)) {
                UIManager.hideLoading();
                this.billingManager?.renderBillNumber?.();
                UIManager.showToast(t(SAVE_UNCONFIRMED_KEY), 'warning');
                return undefined;
            }
            
            const savedItems = bill.items;
            const billingManager = this.billingManager;
            Helpers.runInBackground([
                () => AuditService.log(AuditService.ACTIONS.CREATE_BILL, {
                    billNumber: bill.billNumber,
                    total: bill.billTotal,
                    customerName: bill.customerName || 'N/A',
                    itemCount: bill.items.length
                }),
                () => billingManager?.updateItemFrequency(savedItems, 'purchase'),
                () => billingManager?.deleteAutoSave()
            ]);
            
            // Clear bill
            pendingBill = null;
            billItems = [];
            emit(BILL_CLEARED, 'purchase');
            editedLine = null;
            weights = [];
            weightChecks = [];
            this.renderBill();
            this.renderWeights();
            
            // Reset form
            this.resetForm();
            
            UIManager.hideLoading();
            UIManager.showToast(this.savedText(bill));
            UIManager.hapticFeedback('success');
            
            return bill;
            
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
                await this.billingManager?.offerSavedBill?.(error.bill, 'purchase', { items: billItems });
                return undefined;
            }
            UIManager.showToast(saveFailedText(error, t('msg.purchase.failed_save_bill', { message: error.message })), 'error');
            console.error('Save bill error:', error);
            throw error;
        }
    },

    /** What the save toast says for a saved bill (also the first half of the print status). */
    savedText(bill) {
        if (FirebaseService.keptServerPayment(bill)) return t(KEPT_SERVER_PAYMENT_KEY);
        if (FirebaseService.savedOnPhoneOnly(bill)) return t(SAVED_ON_PHONE_KEY);
        return t('msg.purchase.bill_saved_successfully');
    },

    /** The entry boxes as BF-PENDING reads them. */
    entryLine() {
        const item = AppState.items[parseInt(document.getElementById('billItem')?.value)];
        return {
            item,
            entry: {
                itemChosen: !!item,
                rateText: document.getElementById('billRate')?.value,
                qtyText: document.getElementById('newWeight')?.value,
                chips: weights
            }
        };
    },

    entryLineEmpty() {
        return pendingLine(this.entryLine().entry).state === 'empty';
    },

    /**
     * A line typed but not added to the bill is never dropped silently (BF-PENDING):
     * the user adds or discards it, or goes back to it.
     * @returns {Promise<boolean>} true when the save may go on
     */
    async settleEntryLine() {
        const { item, entry } = this.entryLine();
        return settlePendingLine({
            entry,
            label: item ? lineLabel(item) : '',
            inputs: { item: 'billItem', rate: 'billRate', qty: 'newWeight' },
            add: async () => {
                const before = billItems.length;
                await this.addToBill();
                return billItems.length > before;
            },
            discard: () => {
                weights = [];
                weightChecks = [];
                const weightInput = document.getElementById('newWeight');
                if (weightInput) weightInput.value = '';
                this.renderWeights();
                if (this.billingManager) this.billingManager.triggerAutoSave();
            }
        });
    },

    /**
     * Reset the purchase form
     */
    resetForm() {
        const fields = ['customerName', 'onlinePayment', 'cashPayment', 'dueAmount', 'manualLaborCharges', 'billComments'];
        fields.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = id === 'manualLaborCharges' ? '0' : '';
        });
        
        ['onlineCheckbox', 'cashCheckbox', 'dueCheckbox', 'billPrintComments'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.checked = false;
        });
        
        resetBillDate('billDate');
        this.updateTotals();
        this.billingManager?.focusFirstItem?.();
    },

    /**
     * Clear the current bill
     */
    clearBill() {
        pendingBill = null;
        billItems = [];
        emit(BILL_CLEARED, 'purchase');
        editedLine = null;
        weights = [];
        weightChecks = [];
        this.renderBill();
        this.renderWeights();
        this.resetForm();
        if (this.billingManager) this.billingManager.deleteAutoSave().catch(e => console.warn('Auto-save cleanup failed:', e));
    },

    // -------------------- SHARING --------------------

    /**
     * Share bill via WhatsApp
     * @async
     */
    async shareWhatsApp() {
        if (billItems.length === 0) {
            UIManager.showToast(t('msg.common.no_items_in_bill'));
            return;
        }
        
        const total = draftLineSum(billItems);
        const { laborCharges } = this.computeTotals();
        const message = buildDraftShareText({
            kind: 'purchase', customer: Helpers.getInputText('customerName'), items: billItems, total, labour: laborCharges
        });
        
        const url = `https://wa.me/?text=${encodeURIComponent(message)}`;
        window.open(url, '_blank');
    },

    // -------------------- STATE ACCESS --------------------

    /**
     * Id/bill number of the bill being entered, created on first use (#70)
     * @returns {{id: string, billNumber: (string|null)}}
     */
    /** Lines whose rate confirm is kept when put back unchanged: the saved bill being edited, the line taken back to edit. */
    keptLines() {
        const bill = this.billingManager?.editingBillIndex !== undefined ? this.billingManager.getEditingBill?.() : null;
        return [...(Array.isArray(bill?.items) ? bill.items : []), ...(editedLine ? [editedLine] : [])];
    },

    /**
     * The bill as the check engine sees it (utils/bill-checks.js).
     * @returns {Object}
     */
    getCheckDraft() {
        const editing = this.billingManager?.editingBillIndex !== undefined;
        const original = editing ? this.billingManager.getEditingBill?.() || null : null;
        const item = AppState.items[parseInt(document.getElementById('billItem')?.value)];
        return {
            kind: 'purchase',
            isEdit: editing,
            id: editing ? original?.id || null : pendingBill?.id || null,
            editingBill: original,
            items: billItems,
            total: this.computeTotals().grandTotal,
            payment: this.readPaymentSplit(),
            partyName: Helpers.getInputText('customerName'),
            date: editing ? original?.date : (pendingBill?.date || billTimeFor(pickedBillDay('billDate')).toISOString()),
            enteredAt: editing ? (original?.enteredAt || original?.timestamp) : (pendingBill?.enteredAt || pendingBill?.timestamp),
            entry: item ? { itemId: item.id, name: item.name, rate: readTypedNumber('billRate'), qty: readTypedNumber('newWeight') } : null
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

    /** Restore the bill id from an auto-save / draft. */
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
        if (pendingBill?.timestamp) lockBillDate('billDate', pendingBill.timestamp);
        else resetBillDate('billDate');
    },

    /**
     * Get current bill items
     * @returns {Array<Object>} Bill items
     */
    getBillItems() {
        return billItems;
    },

    /**
     * Set bill items (for recovery/editing)
     * @param {Array<Object>} items - Items to set
     */
    setBillItems(items) {
        billItems = items || [];
        emit(BILL_CLEARED, 'purchase');
    },

    /** A bill line taken back into the form to edit (#131: voice undo waits for it). */
    isEditingLine() {
        return !!editedLine;
    },

    /**
     * Get current weights
     * @returns {Array<number>} Weights
     */
    getWeights() {
        return weights;
    },

    /**
     * Set weights (for recovery/editing)
     * @param {Array<number>} w - Weights to set
     */
    setWeights(w) {
        weights = w || [];
        weightChecks = bagChecks(weights, weightChecks).confirmed;
    }
};

BillChecksUI.register('purchase', {
    sectionId: 'purchaseSection',
    tableSelector: '#billTable',
    saveButtons: '#saveBillBtn, #printBillBtn',
    getDraft: () => PurchaseManager.getCheckDraft(),
    fields: {
        party: { inputs: ['customerName'] },
        payment: { inputs: ['cashPayment', 'onlinePayment', 'dueAmount'], anchor: 'purchaseSplitRemaining' },
        'entry.rate': { inputs: ['billRate'] },
        'entry.qty': { inputs: ['newWeight'] }
    }
});

export { PurchaseManager };
