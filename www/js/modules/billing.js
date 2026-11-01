/**
 * @fileoverview Billing Core module for coordinating purchase and sale transactions
 * Handles mode switching, item dropdowns, drafts, auto-save, and editing
 * @module modules/billing
 */

import { AppState } from '../utils/state.js';
import { SecurityMonitor } from '../services/security-monitor.js';
import { on, REFRESH, ITEM_FREQUENCY_CHANGED } from '../utils/events.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import * as BillDrafts from '../firebase/repos/bill-drafts.js';
import { PrinterService } from '../services/printer.js';
import { AuditService } from '../services/audit.js';
import { Helpers } from '../utils/helpers.js';
import { billLabour, isActiveBill, readPayment, sumMoney } from '../utils/money.js';
import { buildPaymentSplit, computeRetailTotals, editKeepsMoney } from '../utils/calc/billing.js';
import { BillChecksUI } from '../ui/bill-highlight.js';
import { findBillIndex } from '../utils/history-window.js';
import { TIME_MS, AUTO_SAVE_DELAY } from '../utils/constants.js';
import { PurchaseManager } from './purchase.js';
import { RetailSaleManager } from './retail-sale.js';
import { t } from '../i18n/index.js';
import { isStorageFullError, saveFailedText, STORAGE_FULL_KEY, SAVED_ON_PHONE_KEY } from '../utils/storage-full.js';
import { accessFor, canEditBillWith } from '../utils/role-access.js';
import { billEditChanges, hasEditChanges } from '../utils/bill-edits.js';
import { askReason } from '../ui/bill-status.js';
import { autoSaveSummary, nextBillNumberHint } from '../utils/calc/billing.js';
import { formatDateTimeIN } from '../utils/dates.js';
import { isArchivedItem } from '../utils/item-catalog.js';

const EDIT_OFFLINE_KEY = 'msg.billing.edit_offline';
const EDIT_TIMEOUT_MS = 20000;

/**
 * Who may edit a bill (firestore.rules canFullyEditBill): owner; a manager any
 * bill, the creator their own, both only within the role's edit window (#87,
 * days set in Roles & access, #84). Legacy bills without userId/createdAt: owner.
 */
export function canEditBill(bill) {
    return canEditBillWith(bill, {
        uid: AppState.currentUser?.uid, role: AppState.userRole, raw: AppState.settings?.roleAccess
    });
}
export const EDIT_NOT_ALLOWED_KEY = 'msg.billing.edit_not_allowed';
export const EDIT_WINDOW_CLOSED_KEY = 'msg.roles.edit_window_closed';

/** Message for a refused edit: the window closed, or not this user's bill. */
export function editRefusedMessage(bill) {
    const role = AppState.userRole;
    const mine = !!bill?.userId && bill.userId === AppState.currentUser?.uid;
    if (role === 'manager' || mine) {
        return t(EDIT_WINDOW_CLOSED_KEY, { days: accessFor(role, AppState.settings?.roleAccess).editDays });
    }
    return t(EDIT_NOT_ALLOWED_KEY);
}

/** Draft fields that make the bill checks treat the form as an edit of `bill` (#37). */
const editCheckContext = (bill) => ({
    isEdit: true, id: bill.id, editingBill: bill, date: bill.date, enteredAt: bill.timestamp
});

/**
 * The reason for an edit (#121), asked only when the edit changes something
 * that is recorded: '' when nothing recorded changes, null when cancelled.
 * @returns {Promise<?string>}
 */
async function askEditReason(bill, updated) {
    if (!hasEditChanges(billEditChanges(bill, updated))) return '';
    return askReason({ titleKey: 'ui.edits.reason_title', explainKey: 'ui.edits.reason_explain', labelKey: 'ui.edits.reason_label' });
}

// Per-bill "Print comments" toggle: carried through edit, drafts and autosave.
const readPrintComments = (id) => !!document.getElementById(id)?.checked;
function setPrintComments(id, value) {
    const el = document.getElementById(id);
    if (el) el.checked = !!value;
}

/** Waits for a bill edit transaction; gives up waiting after EDIT_TIMEOUT_MS. */
async function commitBillEdit(writePromise) {
    let timer = null;
    try {
        return await Promise.race([
            writePromise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(Object.assign(
                    new Error('Saving the edit is taking too long — check the internet connection and try again'),
                    { code: 'edit-timeout' }
                )), EDIT_TIMEOUT_MS);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * @type {number|null} Timer ID for auto-save functionality
 * @private
 */
let autoSaveTimer = null;
let autoSaveFullWarnedAt = 0;

/**
 * Billing Manager - Coordinates purchase and sale operations
 * @namespace BillingManager
 */
const BillingManager = {
    /**
     * Current billing mode
     * @type {'purchase'|'sale'}
     */
    currentMode: 'purchase',
    
    /**
     * Whether auto-save is enabled
     * @type {boolean}
     */
    autoSaveEnabled: true,
    
    /**
     * Cached item frequency data from database
     * @type {{purchase: Object, sale: Object}}
     */
    itemFrequency: { purchase: {}, sale: {} },

    /**
     * Current bill being edited (undefined if not editing)
     * @type {number|undefined}
     */
    editingBillIndex: undefined,

    /**
     * ID of bill being edited
     * @type {string|undefined}
     */
    editingBillId: undefined,

    /**
     * Type of bill being edited
     * @type {'purchase'|'sale'|undefined}
     */
    editingBillType: undefined,

    /**
     * Payment-state signature of the bill when the editor opened (see FirebaseService.loadedPaymentSignature)
     * @type {?string|undefined}
     */
    editingBillPaymentSig: undefined,

    /**
     * Initialize the billing manager
     */
    init() {
        // Initialize child managers with reference to this
        PurchaseManager.init(this);
        RetailSaleManager.init(this);
    },

    // -------------------- MODE SWITCHING --------------------

    /**
     * Switch between purchase and sale modes
     * @param {'purchase'|'sale'} mode - The mode to switch to
     * @param {Event} [event] - Optional click event for button styling
     */
    switchMode(mode, event) {
        const purchaseSection = document.getElementById('purchaseSection');
        const saleSection = document.getElementById('saleSection');
        const purchaseBtn = document.getElementById('purchaseModeBtn');
        const saleBtn = document.getElementById('saleModeBtn');
        
        if (!purchaseSection || !saleSection) return;
        
        // Auto-save current mode before switching
        if (this.autoSaveEnabled && this.currentMode !== mode) {
            this.autoSaveToCloud().catch(e => console.warn('Auto-save failed:', e));
        }
        
        // Update button states
        if (event) {
            purchaseBtn.classList.remove('active');
            saleBtn.classList.remove('active');
            purchaseBtn.style.background = '';
            purchaseBtn.style.borderColor = '';
            saleBtn.style.background = '';
            saleBtn.style.borderColor = '';
            event.currentTarget.classList.add('active');
        }
        
        if (mode === 'sale') {
            this.currentMode = 'sale';
            purchaseSection.style.display = 'none';
            saleSection.style.display = 'block';
            
            if (saleBtn.classList.contains('active')) {
                saleBtn.style.background = '#22c55e';
                saleBtn.style.borderColor = '#22c55e';
            }
            
            // Preserve current selections (the picker keeps its item by id)
            const currentRate = document.getElementById('saleRate')?.value;
            const currentWeight = document.getElementById('saleWeight')?.value;
            
            this.loadSaleItemsDropdown();
            
            if (currentRate) {
                setTimeout(() => {
                    const saleRateInput = document.getElementById('saleRate');
                    if (saleRateInput) saleRateInput.value = currentRate;
                }, 50);
            }
            if (currentWeight) {
                const saleWeightInput = document.getElementById('saleWeight');
                if (saleWeightInput) saleWeightInput.value = currentWeight;
            }
            
            RetailSaleManager.renderSalesBill();
            RetailSaleManager.renderSaleWeights();
            RetailSaleManager.updateSaleTotals();
        } else {
            this.currentMode = 'purchase';
            saleSection.style.display = 'none';
            purchaseSection.style.display = 'block';
            
            PurchaseManager.renderBill();
            PurchaseManager.renderWeights();
            PurchaseManager.updateTotals();
        }
        
        if (this.pendingRecovery) this.showRecoveryBanner(this.pendingRecovery);
        this.focusFirstItem();
        UIManager.hapticFeedback();
    },

    /**
     * The bill number line above Save (#117, BF-NO): the edited bill's number, the
     * number this bill already got on a failed save, or the likely next one.
     */
    renderBillNumber() {
        const editingMode = this.editingBillIndex === undefined ? null
            : (this.editingBillType === 'retail' ? 'sale' : 'purchase');
        [['purchase', 'purchaseBillNo', PurchaseManager.getPendingBill(), 'P', AppState.purchaseHistory],
            ['sale', 'saleBillNo', RetailSaleManager.getPendingBill(), 'S', AppState.retailSalesHistory]
        ].forEach(([mode, id, pending, prefix, bills]) => {
            const el = document.getElementById(id);
            if (!el) return;
            const known = editingMode === mode ? this.getEditingBill()?.billNumber : pending?.billNumber;
            if (editingMode === mode && !known) {
                el.replaceChildren();
                return;
            }
            const number = document.createElement('strong');
            number.lang = 'zxx';
            number.translate = false;
            number.textContent = known || nextBillNumberHint(prefix, bills);
            el.replaceChildren(document.createTextNode(`${t(known ? 'ui.billing.bill_no' : 'ui.billing.next_bill_no')} `), number);
        });
    },

    /**
     * A fresh bill starts on the Item box (#117), on a desktop only: on a phone the
     * focus would open the keyboard over the form.
     */
    focusFirstItem() {
        if (this.editingBillIndex !== undefined) return;
        if (typeof window.matchMedia !== 'function' || !window.matchMedia('(min-width: 1024px) and (pointer: fine)').matches) return;
        if (!document.getElementById('billing')?.classList.contains('active')) return;
        if (document.getElementById('modalOverlay')?.classList.contains('active')) return;
        const purchase = this.currentMode === 'purchase';
        if ((purchase ? PurchaseManager.getBillItems() : RetailSaleManager.getSaleItems()).length > 0) return;
        const active = document.activeElement;
        if (active && active.matches?.('input, select, textarea')) return;
        document.getElementById(purchase ? 'billItem' : 'saleItem')?.focus({ preventScroll: true });
    },

    // -------------------- ITEM FREQUENCY --------------------

    /**
     * Load item frequency data from Firebase (global, shared across all users)
     * @async
     */
    async loadItemFrequency() {
        try {
            // Use a global document instead of per-user to ensure all users see same order
            const data = await BillDrafts.loadItemFrequency();
            this.itemFrequency = data || { purchase: {}, sale: {} };
        } catch (error) {
            console.error('Failed to load item frequency:', error);
            this.itemFrequency = { purchase: {}, sale: {} };
        }
    },

    /**
     * Update item frequency after a transaction (global, shared across all users)
     * @async
     * @param {Array<Object>} items - Items used in the transaction
     * @param {'purchase'|'sale'} [mode='purchase'] - The transaction mode
     */
    async updateItemFrequency(items, mode = 'purchase') {
        try {
            const now = Date.now();
            if (!this.itemFrequency[mode]) this.itemFrequency[mode] = {};
            
            // Aggregate per item so a bill with repeated items sends one increment each.
            const deltas = {};
            (items || []).forEach(item => {
                const itemId = item.itemId || item.name;
                if (!itemId) return;
                const baseScore = 100;
                const quantityBonus = (item.qty || 0) / 10;
                const recencyMultiplier = 1.0;
                const score = (baseScore + quantityBonus) * recencyMultiplier;
                if (!deltas[itemId]) deltas[itemId] = { score: 0, count: 0 };
                deltas[itemId].score += score;
                deltas[itemId].count += 1;
            });
            
            const added = {};
            Object.entries(deltas).forEach(([itemId, delta]) => {
                // Optimistic local update so dropdown ordering reflects the sale immediately
                const existing = this.itemFrequency[mode][itemId];
                const local = (existing && typeof existing === 'object') ? existing : { score: 0, lastUsed: 0, count: 0 };
                local.score = (local.score || 0) + delta.score;
                local.count = (local.count || 0) + delta.count;
                local.lastUsed = now;
                local.effectiveScore = local.score;
                this.itemFrequency[mode][itemId] = local;
                
                // Score and count are added atomically by the repository; effectiveScore
                // is only a ranking hint (decay is applied on read).
                added[itemId] = {
                    score: delta.score,
                    count: delta.count,
                    lastUsed: now,
                    effectiveScore: local.score
                };
            });
            if (Object.keys(added).length === 0) return;
            
            await BillDrafts.addItemFrequency(mode, added);
        } catch (error) {
            console.error('Failed to update item frequency:', error);
        }
    },

    /**
     * Get item frequency for a mode, with time decay applied to effectiveScore
     * (items unused for 90 days keep 10% of their score).
     * @param {'purchase'|'sale'} mode - The mode
     * @returns {Object} Frequency data
     */
    getItemFrequency(mode = 'purchase') {
        const source = this.itemFrequency[mode] || {};
        const now = Date.now();
        const result = {};
        Object.keys(source).forEach(itemId => {
            const itemData = source[itemId];
            if (itemData && typeof itemData === 'object' && typeof itemData.score === 'number') {
                const daysSinceLastUse = (now - (itemData.lastUsed || 0)) / TIME_MS.DAY;
                const decayFactor = Math.max(0.1, 1 - (daysSinceLastUse / 90));
                result[itemId] = { ...itemData, effectiveScore: itemData.score * decayFactor };
            } else {
                result[itemId] = itemData;
            }
        });
        return result;
    },

    // -------------------- DROPDOWNS --------------------

    /**
     * Load items dropdown for purchase mode
     */
    loadItemsDropdown() {
        const select = document.getElementById('billItem');
        if (!select) return;
        const kept = { ...(select.selectedOptions?.[0]?.dataset || {}) };
        
        select.innerHTML = '';
        
        const freq = this.getItemFrequency('purchase');
        
        const sortedItems = [...AppState.items].sort((a, b) => {
            const dataA = freq[a.id] || freq[a.name];
            const dataB = freq[b.id] || freq[b.name];
            const scoreA = dataA ? (dataA.effectiveScore || dataA.score || dataA) : 0;
            const scoreB = dataB ? (dataB.effectiveScore || dataB.score || dataB) : 0;
            return scoreB - scoreA;
        });
        
        sortedItems.forEach((item) => {
            if (isArchivedItem(item)) return;
            const opt = document.createElement('option');
            const originalIndex = AppState.items.findIndex(i => i.id === item.id || i.name === item.name);
            opt.value = originalIndex;
            if (item.id) opt.dataset.itemId = item.id;
            const displayName = (AppState.settings.showHindi && item.hindiName) ? item.hindiName : item.name;
            opt.textContent = displayName;
            select.appendChild(opt);
        });
        
        this.keepSelection('billItem', kept);
        if (AppState.items.length > 0) {
            this.loadRates();
        }
    },

    /**
     * Load items dropdown for sale mode
     */
    loadSaleItemsDropdown() {
        const select = document.getElementById('saleItem');
        if (!select) return;
        const kept = { ...(select.selectedOptions?.[0]?.dataset || {}) };
        
        select.innerHTML = '';
        
        const freq = this.getItemFrequency('sale');
        
        const sortedItems = [...AppState.items].sort((a, b) => {
            const dataA = freq[a.id] || freq[a.name];
            const dataB = freq[b.id] || freq[b.name];
            const scoreA = dataA ? (dataA.effectiveScore || dataA.score || dataA) : 0;
            const scoreB = dataB ? (dataB.effectiveScore || dataB.score || dataB) : 0;
            return scoreB - scoreA;
        });
        
        sortedItems.forEach((item) => {
            if (isArchivedItem(item)) return;
            const opt = document.createElement('option');
            const originalIndex = AppState.items.findIndex(i => i.id === item.id || i.name === item.name);
            opt.value = originalIndex;
            if (item.id) opt.dataset.itemId = item.id;
            const displayName = (AppState.settings.showHindi && item.hindiName) ? item.hindiName : item.name;
            opt.textContent = displayName;
            select.appendChild(opt);
        });
        
        this.keepSelection('saleItem', kept);
        if (AppState.items.length > 0) {
            this.loadSaleRates();
        }
    },

    /**
     * Editing a bill line (#123): the pickers leave archived items out, so add
     * that one option back for this line, and mark the line's option so a picker
     * rebuild keeps it even if the item is archived meanwhile.
     * @param {string} selectId
     * @param {number} itemIndex position in AppState.items
     */
    ensureItemOption(selectId, itemIndex) {
        const select = document.getElementById(selectId);
        const item = AppState.items[itemIndex];
        if (!select || !item) return;
        const existing = [...select.options].find(o => o.value === String(itemIndex));
        if (existing) {
            existing.dataset.editLine = '1';
            return;
        }
        const opt = document.createElement('option');
        opt.value = itemIndex;
        if (item.id) opt.dataset.itemId = item.id;
        opt.dataset.editLine = '1';
        opt.textContent = (AppState.settings.showHindi && item.hindiName) ? item.hindiName : item.name;
        select.appendChild(opt);
    },

    /**
     * A rebuilt picker (another phone's bill, an item change) keeps the item that
     * was selected, found again by id since positions in AppState.items can
     * shift. An archived item comes back only for a bill line being edited, so
     * its weights can't move to another item; otherwise it drops out.
     * @param {string} selectId
     * @param {{itemId?: string, editLine?: string}} kept dataset of the option selected before the rebuild
     */
    keepSelection(selectId, kept) {
        if (!kept?.itemId) return;
        const index = AppState.items.findIndex(i => i && i.id === kept.itemId);
        if (index === -1) return;
        if (isArchivedItem(AppState.items[index])) {
            if (kept.editLine !== '1') return;
            this.ensureItemOption(selectId, index);
        }
        const select = document.getElementById(selectId);
        if ([...select.options].some(o => o.value === String(index))) select.value = String(index);
    },

    /**
     * Load rates for selected purchase item
     */
    loadRates() {
        const itemIndex = document.getElementById('billItem')?.value;
        const rateInput = document.getElementById('billRate');
        const rateDatalist = document.getElementById('rateOptions');
        
        if (!rateInput || !rateDatalist) return;
        
        rateDatalist.innerHTML = '';
        rateInput.value = '';
        rateInput.placeholder = t('ui.billing.select_enter_rate');
        
        if (itemIndex !== undefined && itemIndex !== '') {
            const item = AppState.items[parseInt(itemIndex)];
            if (item && item.rates && item.rates.length > 0) {
                item.rates.forEach(rate => {
                    const option = document.createElement('option');
                    option.value = rate;
                    rateDatalist.appendChild(option);
                });
            }
        }
    },

    /**
     * Load rates for selected sale item
     */
    loadSaleRates() {
        const itemIndex = document.getElementById('saleItem')?.value;
        const rateInput = document.getElementById('saleRate');
        const rateDatalist = document.getElementById('saleRateOptions');
        
        if (!rateInput || !rateDatalist) return;
        
        rateDatalist.innerHTML = '';
        rateInput.value = '';
        rateInput.placeholder = t('ui.billing.select_enter_rate');
        
        if (itemIndex !== undefined && itemIndex !== '') {
            const item = AppState.items[parseInt(itemIndex)];
            if (item && item.saleRates && item.saleRates.length > 0) {
                item.saleRates.forEach(rate => {
                    const option = document.createElement('option');
                    option.value = rate;
                    rateDatalist.appendChild(option);
                });
            }
        }
    },

    // -------------------- DRAFT MANAGEMENT --------------------

    /**
     * Save current bill as draft
     * @async
     */
    saveDraft() {
        return Helpers.runExclusive('draft', '#saveDraftBtn', () => this._saveDraft());
    },

    async _saveDraft() {
        const mode = this.currentMode;
        
        const currentUser = firebase.auth().currentUser;
        if (!currentUser) {
            UIManager.showToast(t('msg.billing.login_save_drafts'));
            return;
        }

        const draft = {
            id: Helpers.generateId(),
            userId: currentUser.uid,
            userName: AppState.userName || currentUser.email || 'User',
            mode: mode,
            timestamp: Date.now(),
            date: Helpers.getCurrentDateTime()
        };

        if (mode === 'purchase') {
            const weightInput = document.getElementById('newWeight');
            const pendingWeight = parseFloat(weightInput?.value);
            if (pendingWeight && pendingWeight > 0) {
                const weights = PurchaseManager.getWeights();
                weights.push(pendingWeight);
                PurchaseManager.setWeights(weights);
                weightInput.value = '';
                PurchaseManager.renderWeights();
            }

            const billItems = PurchaseManager.getBillItems();
            const weights = PurchaseManager.getWeights();
            
            if (billItems.length === 0 && weights.length === 0) {
                UIManager.showToast(t('msg.billing.no_items_or_weights_save'));
                return;
            }
            draft.items = [...billItems];
            draft.weights = [...weights];
            draft.pendingBill = PurchaseManager.getPendingBill();
            draft.customerName = Helpers.getInputText('customerName');
            draft.laborCharges = Helpers.getInputNumber('manualLaborCharges');
            draft.comments = Helpers.getInputText('billComments');
            draft.printComments = readPrintComments('billPrintComments');
            draft.billTotal = PurchaseManager.computeTotals(0).billTotal;
        } else {
            const saleWeightInput = document.getElementById('saleWeight');
            const pendingSaleWeight = parseFloat(saleWeightInput?.value);
            if (pendingSaleWeight && pendingSaleWeight > 0) {
                const saleWeights = RetailSaleManager.getSaleWeights();
                saleWeights.push(pendingSaleWeight);
                RetailSaleManager.setSaleWeights(saleWeights);
                saleWeightInput.value = '';
                RetailSaleManager.renderSaleWeights();
            }

            const saleItems = RetailSaleManager.getSaleItems();
            const saleWeights = RetailSaleManager.getSaleWeights();
            
            if (saleItems.length === 0 && saleWeights.length === 0) {
                UIManager.showToast(t('msg.billing.no_items_or_weights_save'));
                return;
            }
            draft.items = [...saleItems];
            draft.weights = [...saleWeights];
            draft.pendingBill = RetailSaleManager.getPendingBill();
            draft.customerName = Helpers.getInputText('saleCustomerName');
            draft.comments = Helpers.getInputText('saleComments');
            draft.printComments = readPrintComments('salePrintComments');
            draft.saleTotal = sumMoney(saleItems, item => item.total);
        }

        let write;
        try {
            // Saved on the phone at once (also offline); if the server refuses it, the bill comes back
            write = BillDrafts.saveDraft(draft);
        } catch (error) {
            console.error('Failed to save draft:', error);
            UIManager.showToast(saveFailedText(error, t('msg.billing.failed_save_draft')), 'error');
            return;
        }
        write.catch(error => {
            console.error('Failed to save draft:', error);
            UIManager.showToast(saveFailedText(error, t('msg.billing.failed_save_draft')), 'error');
            if (this.editorEmpty(draft.mode)) this.applyDraft(draft);
            this.updateDraftCount().catch(e => console.error('Draft count refresh failed:', e));
        });
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        UIManager.showToast(t(offline ? SAVED_ON_PHONE_KEY : 'msg.billing.draft_saved_cloud'));
        UIManager.hapticFeedback('light');
        this.clearBill();
        this.updateDraftCount().catch(e => console.error('Draft count refresh failed:', e));
    },

    /** Whether the bill editor of `mode` has no items and no weights. */
    editorEmpty(mode) {
        return mode === 'purchase'
            ? PurchaseManager.getBillItems().length === 0 && PurchaseManager.getWeights().length === 0
            : RetailSaleManager.getSaleItems().length === 0 && RetailSaleManager.getSaleWeights().length === 0;
    },

    /**
     * Clear current bill
     */
    clearBill() {
        if (this.currentMode === 'purchase') {
            PurchaseManager.clearBill();
        } else {
            RetailSaleManager.clearSale();
        }
        this.deleteAutoSave().catch(e => console.warn('Auto-save cleanup failed:', e));
    },

    /**
     * Show drafts overlay
     * @async
     */
    async showDrafts() {
        const overlay = document.getElementById('draftsOverlay');
        const content = document.getElementById('draftsContent');

        try {
            const currentUser = firebase.auth().currentUser;
            if (!currentUser) {
                content.innerHTML = `<p style="text-align: center; color: #888; padding: 40px;">${Helpers.escapeHtml(t('ui.billing.login_to_view_drafts'))}</p>`;
                overlay.classList.add('active');
                return;
            }

            const drafts = (await BillDrafts.listDrafts(currentUser.uid))
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

            if (drafts.length === 0) {
                content.innerHTML = `<p style="text-align: center; color: #888; padding: 40px;">${Helpers.escapeHtml(t('ui.billing.no_saved_drafts'))}</p>`;
            } else {
                content.innerHTML = drafts.map((draft) => `
                    <div class="history-item" style="margin-bottom: 12px;">
                        <div class="history-header">
                            <span style="font-weight: 600;">${Helpers.escapeHtml(t(draft.mode === 'purchase' ? 'ui.billing.purchase_draft' : 'ui.billing.sale_draft'))}</span>
                            <span style="color: #666; font-size: 14px;">${Helpers.escapeHtml(t(draft.weights?.length > 0 ? 'ui.billing.draft_items_weights' : 'ui.billing.draft_items', { items: draft.items?.length || 0, weights: draft.weights?.length || 0 }))}</span>
                        </div>
                        <div class="history-date">${Helpers.escapeHtml(draft.date)}</div>
                        ${draft.customerName ? `<div style="color: #666; font-size: 13px; margin-top: 4px;">${Helpers.escapeHtml(t('ui.common.customer'))} ${Helpers.escapeHtml(draft.customerName)}</div>` : ''}
                        <div style="display: flex; gap: 8px; margin-top: 8px;">
                            <button onclick="window.app.billing.loadDraft('${Helpers.escapeJsAttr(draft.id)}')" style="flex: 1; padding: 8px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600;">
                                ${Helpers.escapeHtml(t('ui.billing.load'))}
                            </button>
                            <button onclick="window.app.billing.deleteDraft('${Helpers.escapeJsAttr(draft.id)}')" style="flex: 1; padding: 8px; background: #dc2626; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600;">
                                ${Helpers.escapeHtml(t('ui.modals.delete'))}
                            </button>
                        </div>
                    </div>
                `).join('');
            }

            overlay.classList.add('active');
        } catch (error) {
            console.error('Failed to load drafts:', error);
            content.innerHTML = `<p style="text-align: center; color: #ef4444; padding: 40px;">${Helpers.escapeHtml(t('ui.billing.failed_load_drafts'))}</p>`;
            overlay.classList.add('active');
        }
    },

    /**
     * Close drafts overlay
     */
    closeDrafts() {
        document.getElementById('draftsOverlay').classList.remove('active');
    },

    /**
     * Put a draft's bill back into the editor.
     * @param {Object} draft
     */
    applyDraft(draft) {
        this.switchMode(draft.mode);

        if (draft.mode === 'purchase') {
            PurchaseManager.setBillItems(draft.items || []);
            PurchaseManager.setWeights(draft.weights || []);
            PurchaseManager.setPendingBill(draft.pendingBill);
            PurchaseManager.renderBill();
            PurchaseManager.renderWeights();
            if (draft.customerName) document.getElementById('customerName').value = draft.customerName;
            if (draft.laborCharges) document.getElementById('manualLaborCharges').value = draft.laborCharges;
            if (draft.comments) document.getElementById('billComments').value = draft.comments;
            setPrintComments('billPrintComments', draft.printComments);
        } else {
            RetailSaleManager.setSaleItems(draft.items || []);
            RetailSaleManager.setSaleWeights(draft.weights || []);
            RetailSaleManager.setPendingBill(draft.pendingBill);
            RetailSaleManager.renderSalesBill();
            RetailSaleManager.renderSaleWeights();
            if (draft.customerName) document.getElementById('saleCustomerName').value = draft.customerName;
            if (draft.comments) document.getElementById('saleComments').value = draft.comments;
            setPrintComments('salePrintComments', draft.printComments);
        }

        PurchaseManager.updateTotals();
    },

    /**
     * Load a draft
     * @async
     * @param {string} draftId - Draft ID to load
     */
    async loadDraft(draftId) {
        try {
            const draft = await BillDrafts.getDraft(draftId);
            
            if (!draft) {
                UIManager.showToast(t('msg.billing.draft_not_found'));
                return;
            }

            this.applyDraft(draft);
            this.closeDrafts();

            await BillDrafts.deleteDraft(draftId);
            await this.updateDraftCount();

            UIManager.showToast(t('msg.billing.draft_loaded'));
            UIManager.hapticFeedback('light');
        } catch (error) {
            console.error('Failed to load draft:', error);
            UIManager.showToast(t('msg.billing.failed_load_draft'));
        }
    },

    /**
     * Delete a draft
     * @async
     * @param {string} draftId - Draft ID to delete
     */
    async deleteDraft(draftId) {
        try {
            await BillDrafts.deleteDraft(draftId);
            await this.updateDraftCount();
            await this.showDrafts();
            UIManager.showToast(t('msg.billing.draft_deleted'));
        } catch (error) {
            console.error('Failed to delete draft:', error);
            UIManager.showToast(t('msg.billing.failed_delete_draft'));
        }
    },

    /**
     * Update draft count display
     * @async
     */
    async updateDraftCount() {
        try {
            const currentUser = firebase.auth().currentUser;
            if (!currentUser) return;
            
            const count = await BillDrafts.countDrafts(currentUser.uid);
            
            const countElement = document.getElementById('draftCount');
            if (countElement) {
                countElement.textContent = count;
            }
        } catch (error) {
            console.error('Failed to update draft count:', error);
        }
    },

    // -------------------- AUTO-SAVE --------------------

    /**
     * Trigger auto-save timer
     */
    triggerAutoSave() {
        if (!this.autoSaveEnabled) return;
        
        if (autoSaveTimer) {
            clearTimeout(autoSaveTimer);
        }
        
        autoSaveTimer = setTimeout(() => {
            this.autoSaveToCloud().catch(e => console.warn('Auto-save failed:', e));
        }, AUTO_SAVE_DELAY);
    },

    /**
     * Auto-save to cloud
     * @async
     */
    async autoSaveToCloud() {
        try {
            if (!AppState.currentUser) return;
            
            const mode = this.currentMode;
            const billItems = PurchaseManager.getBillItems();
            const weights = PurchaseManager.getWeights();
            const saleItems = RetailSaleManager.getSaleItems();
            const saleWeights = RetailSaleManager.getSaleWeights();
            
            const hasPurchaseData = billItems.length > 0 || weights.length > 0 || document.getElementById('newWeight')?.value;
            const hasSaleData = saleItems.length > 0 || saleWeights.length > 0 || document.getElementById('saleWeight')?.value;
            
            if (!hasPurchaseData && !hasSaleData) {
                // Nothing typed yet: the unsaved bill on the banner stays where it is
                if (!this.pendingRecovery) await this.deleteAutoSave();
                return;
            }
            // A new bill is being typed: the one on the banner moves to Drafts first
            this.keepRecoveryAsDrafts();

            const autoSaveData = {
                userId: AppState.currentUser.uid,
                userName: AppState.userName,
                mode: mode,
                deviceInfo: navigator.userAgent,
                ...(this.editingBillIndex !== undefined ? { editingBillId: this.editingBillId || 'unknown' } : {})
            };

            autoSaveData.purchase = {
                items: billItems,
                weights: weights,
                pendingBill: PurchaseManager.getPendingBill(),
                typedWeight: document.getElementById('newWeight')?.value || '',
                selectedItem: Helpers.getInputText('billItem'),
                rate: Helpers.getInputText('billRate'),
                customerName: Helpers.getInputText('customerName'),
                laborCharges: Helpers.getInputNumber('manualLaborCharges'),
                comments: Helpers.getInputText('billComments'),
                printComments: readPrintComments('billPrintComments'),
                billTotal: PurchaseManager.computeTotals(0).billTotal
            };

            autoSaveData.sale = {
                items: saleItems,
                weights: saleWeights,
                pendingBill: RetailSaleManager.getPendingBill(),
                typedWeight: Helpers.getInputText('saleWeight'),
                selectedItem: Helpers.getInputText('saleItem'),
                rate: Helpers.getInputText('saleRate'),
                customerName: Helpers.getInputText('saleCustomerName'),
                comments: Helpers.getInputText('saleComments'),
                printComments: readPrintComments('salePrintComments'),
                saleTotal: sumMoney(saleItems, item => item.total)
            };

            // lastSaved: the server time, added by the repository
            await BillDrafts.saveAutoSave(AppState.currentUser.uid, autoSaveData);
            
        } catch (error) {
            console.error('Auto-save failed:', error);
            if (isStorageFullError(error) && Date.now() - autoSaveFullWarnedAt > TIME_MS.MINUTE) {
                autoSaveFullWarnedAt = Date.now();
                UIManager.showToast(t(STORAGE_FULL_KEY), 'error');
            }
        }
    },

    /**
     * Delete auto-save
     * @async
     */
    async deleteAutoSave() {
        try {
            if (!AppState.currentUser) return;
            // After a save the save's own toast stays on screen
            this.keepRecoveryAsDrafts({ quiet: true });
            await BillDrafts.deleteAutoSave(AppState.currentUser.uid);
        } catch (error) {
            if (error.code !== 'not-found') {
                console.error('Failed to delete auto-save:', error);
            }
        }
    },

    /**
     * Look for an auto-saved bill at start. Found: a banner offers Restore / Discard
     * without blocking the app (#117). Typing a new bill (or saving / clearing one)
     * before picking moves it to Drafts, so it is never lost.
     * @async
     */
    async checkAutoSave() {
        this.setRecovery(null);
        try {
            if (!AppState.currentUser) return;
            
            const autoSaveData = await BillDrafts.getAutoSave(AppState.currentUser.uid);
            
            if (!autoSaveData) return;
            
            this.setRecovery({ ...autoSaveData, userId: autoSaveData.userId || AppState.currentUser.uid });
        } catch (error) {
            console.error('Failed to check auto-save:', error);
        }
    },

    /** Auto-save waiting for Restore / Discard on the banner; null when none. */
    pendingRecovery: null,

    /** Shows the banner for `data`, or hides it (null). */
    setRecovery(data) {
        this.pendingRecovery = data || null;
        const banner = document.getElementById('autoSaveBanner');
        if (banner) banner.hidden = !data;
        if (data) this.showRecoveryBanner(data);
    },

    /** The banner's auto-save when it belongs to the signed-in user (another user's is dropped). */
    takeRecovery() {
        const data = this.pendingRecovery;
        if (!data) return null;
        this.setRecovery(null);
        return data.userId === AppState.currentUser?.uid ? data : null;
    },

    showRecoveryBanner(data) {
        const text = document.getElementById('autoSaveBannerText');
        if (!text) return;
        const { mode, lines, total } = autoSaveSummary(data);
        text.textContent = t(mode === 'purchase' ? 'ui.billing.recover_purchase' : 'ui.billing.recover_sale', {
            when: formatDateTimeIN(data.lastSaved, undefined, t('msg.billing.recover_earlier')),
            lines,
            total: Helpers.formatCurrency(total)
        });
    },

    /**
     * Moves the auto-save on the banner into Drafts (one draft per form that has
     * lines or weights) and hides the banner. The draft writes are queued at once
     * (also offline), before the auto-save is overwritten or deleted.
     */
    keepRecoveryAsDrafts({ quiet = false } = {}) {
        const data = this.takeRecovery();
        // An unfinished edit of a saved bill is not a new bill: it is dropped, as before
        if (!data || data.editingBillId) return;
        const now = Date.now();
        const drafts = ['purchase', 'sale'].map(mode => {
            const form = data[mode] || (data.mode === mode && !data.purchase && !data.sale ? data : null);
            if (!form || !((form.items || []).length || (form.weights || []).length)) return null;
            const draft = {
                id: Helpers.generateId(),
                userId: data.userId,
                userName: AppState.userName || 'User',
                mode,
                timestamp: now,
                date: Helpers.getCurrentDateTime(),
                items: form.items || [],
                weights: form.weights || [],
                pendingBill: form.pendingBill || null,
                customerName: form.customerName || '',
                comments: form.comments || '',
                printComments: !!form.printComments
            };
            if (mode === 'purchase') {
                draft.laborCharges = form.laborCharges || 0;
                draft.billTotal = form.billTotal || 0;
            } else {
                draft.saleTotal = form.saleTotal || 0;
            }
            return draft;
        }).filter(Boolean);
        if (!drafts.length) return;
        drafts.forEach(draft => {
            try {
                BillDrafts.saveDraft(draft).catch(e => console.error('Failed to keep the unsaved bill as a draft:', e));
            } catch (e) {
                console.error('Failed to keep the unsaved bill as a draft:', e);
            }
        });
        if (!quiet) UIManager.showToast(t('msg.billing.unsaved_moved_to_drafts'), 'info');
        this.updateDraftCount().catch(e => console.error('Draft count refresh failed:', e));
    },

    /**
     * The banner's Restore (true) or Discard (false). Restore needs an empty form:
     * it never replaces a bill on screen or a bill opened for editing.
     * @async
     * @param {boolean} restore
     */
    async resolveRecovery(restore) {
        if (restore && this.pendingRecovery) {
            if (this.editingBillIndex !== undefined || !this.editorEmpty('purchase') || !this.editorEmpty('sale')) {
                UIManager.showToast(t('msg.billing.restore_needs_empty_form'), 'warning');
                return;
            }
            const data = this.takeRecovery();
            if (data) {
                await this.recoverAutoSave(data);
                this.triggerAutoSave();
            }
            return;
        }
        if (this.takeRecovery()) await BillDrafts.deleteAutoSave(AppState.currentUser.uid).catch(e => console.error('Failed to delete auto-save:', e));
    },

    /** Redraws the banner and the bill number lines in the new language. */
    refreshForLanguage() {
        if (this.pendingRecovery) this.showRecoveryBanner(this.pendingRecovery);
        this.renderBillNumber();
    },

    /**
     * Recover auto-saved data
     * @async
     * @param {Object} autoSaveData - Auto-save data to recover
     */
    async recoverAutoSave(autoSaveData) {
        try {
            if (autoSaveData.mode !== this.currentMode) {
                const modeBtn = autoSaveData.mode === 'purchase' 
                    ? document.getElementById('purchaseModeBtn')
                    : document.getElementById('saleModeBtn');
                if (modeBtn) {
                    this.switchMode(autoSaveData.mode, { currentTarget: modeBtn });
                }
            }
            
            await new Promise(resolve => setTimeout(resolve, 50));
            
            // Restore purchase data
            const purchaseData = autoSaveData.purchase || (autoSaveData.mode === 'purchase' ? autoSaveData : {});
            if (purchaseData.items || purchaseData.weights || purchaseData.selectedItem || purchaseData.rate) {
                PurchaseManager.setBillItems(purchaseData.items || []);
                PurchaseManager.setWeights(purchaseData.weights || []);
                PurchaseManager.setPendingBill(purchaseData.pendingBill);
                
                if (purchaseData.selectedItem) {
                    const itemSelect = document.getElementById('billItem');
                    if (itemSelect) {
                        itemSelect.value = purchaseData.selectedItem;
                        this.loadRates();
                    }
                }
                
                setTimeout(() => {
                    if (purchaseData.rate) {
                        const rateInput = document.getElementById('billRate');
                        if (rateInput) rateInput.value = purchaseData.rate;
                    }
                }, 100);
                
                if (purchaseData.typedWeight) {
                    const weightInput = document.getElementById('newWeight');
                    if (weightInput) weightInput.value = purchaseData.typedWeight;
                }
                
                if (purchaseData.customerName) document.getElementById('customerName').value = purchaseData.customerName;
                if (purchaseData.laborCharges) document.getElementById('manualLaborCharges').value = purchaseData.laborCharges;
                if (purchaseData.comments) document.getElementById('billComments').value = purchaseData.comments;
                setPrintComments('billPrintComments', purchaseData.printComments);
                
                PurchaseManager.renderBill();
                PurchaseManager.renderWeights();
            }

            // Restore sale data
            const saleData = autoSaveData.sale || (autoSaveData.mode === 'sale' ? autoSaveData : {});
            if (saleData.items || saleData.weights || saleData.selectedItem || saleData.rate) {
                RetailSaleManager.setSaleItems(saleData.items || []);
                RetailSaleManager.setSaleWeights(saleData.weights || []);
                RetailSaleManager.setPendingBill(saleData.pendingBill);
                
                if (saleData.selectedItem) {
                    const saleItemSelect = document.getElementById('saleItem');
                    if (saleItemSelect) {
                        saleItemSelect.value = saleData.selectedItem;
                        this.loadSaleRates();
                    }
                }
                
                setTimeout(() => {
                    if (saleData.rate) {
                        const saleRateInput = document.getElementById('saleRate');
                        if (saleRateInput) saleRateInput.value = saleData.rate;
                    }
                }, 100);
                
                if (saleData.typedWeight) {
                    const saleWeightInput = document.getElementById('saleWeight');
                    if (saleWeightInput) saleWeightInput.value = saleData.typedWeight;
                }
                
                if (saleData.customerName) document.getElementById('saleCustomerName').value = saleData.customerName;
                if (saleData.comments) document.getElementById('saleComments').value = saleData.comments;
                setPrintComments('salePrintComments', saleData.printComments);
                
                RetailSaleManager.renderSalesBill();
                RetailSaleManager.renderSaleWeights();
            }

            UIManager.showToast(t('msg.billing.bill_recovered_successfully'));
            UIManager.hapticFeedback('success');
            
        } catch (error) {
            console.error('Failed to recover auto-save:', error);
            UIManager.showToast(t('msg.billing.failed_recover_bill'));
        }
    },

    // -------------------- EDIT BILL --------------------

    /**
     * Edit an existing bill
     * @async
     * @param {number} billIndex - Index of bill in history
     * @param {'purchase'|'sale'} billType - Type of bill
     */
    async editBill(billIndex, billType = 'purchase') {
        try {
            // Determine which history array to use based on type
            let history;
            if (billType === 'purchase') {
                history = AppState.purchaseHistory;
            } else if (billType === 'retail') {
                history = AppState.retailSalesHistory;
            } else if (billType === 'wholesale') {
                history = AppState.salesHistory;
            } else {
                UIManager.showToast(t('msg.billing.unknown_bill_type', { billType }));
                return;
            }
            // Prefer the id stored by viewBill: indices shift when records are added
            const resolvedIndex = findBillIndex(history, window.currentBillId, billIndex);
            const bill = history[resolvedIndex];
            if (!bill) {
                UIManager.showToast(t('msg.common.bill_not_found'));
                return;
            }
            if (!canEditBill(bill)) {
                // #124: a try to change a bill past its edit window goes to the owner's review
                if (isActiveBill(bill) && (AppState.userRole === 'manager' || (bill.userId && bill.userId === AppState.currentUser?.uid))) {
                    SecurityMonitor.noteOldBillTry(bill, billType, 'edit');
                }
                UIManager.showToast(editRefusedMessage(bill));
                return;
            }

            this.editingBillIndex = resolvedIndex;
            this.editingBillId = bill.id;
            this.editingBillType = billType;
            // Payment state when the editor opened: a payment recorded elsewhere before
            // saving must cause a conflict instead of being overwritten by the form values
            this.editingBillPaymentSig = FirebaseService.loadedPaymentSignature(bill);

            // Retail bills use 'sale' mode, wholesale cannot be edited from billing tab
            const mode = billType === 'retail' ? 'sale' : 'purchase';
            if (this.currentMode !== mode) {
                const btn = mode === 'sale' ? document.getElementById('saleModeBtn') : document.getElementById('purchaseModeBtn');
                this.switchMode(mode, { currentTarget: btn });
            }

            const overlay = document.getElementById('billDetailsOverlay');
            if (overlay) overlay.classList.remove('active');

            if (mode === 'purchase') {
                PurchaseManager.setBillItems(bill.items.map(item => ({ ...item })));
                PurchaseManager.setWeights([]);
                
                if (bill.customerName) document.getElementById('customerName').value = bill.customerName;
                if (bill.comments) document.getElementById('billComments').value = bill.comments;
                setPrintComments('billPrintComments', bill.printComments);
                // Labour and payment as BILL-PAY reads them (every stored shape), so an edit that
                // changes no money is recognised and keeps the stored figures (#129)
                const labour = billLabour(bill);
                if (labour) document.getElementById('manualLaborCharges').value = labour;
                
                const paid = readPayment(bill);
                if (paid.online > 0) {
                    document.getElementById('onlinePayment').value = paid.online;
                    document.getElementById('onlineCheckbox').checked = true;
                }
                if (paid.cash > 0) {
                    document.getElementById('cashPayment').value = paid.cash;
                    document.getElementById('cashCheckbox').checked = true;
                }
                if (paid.due > 0) {
                    document.getElementById('dueAmount').value = paid.due;
                    document.getElementById('dueCheckbox').checked = true;
                }
                
                PurchaseManager.renderBill();
                PurchaseManager.updateTotals();
                
                window.app.nav.showTab('billing');
                UIManager.showToast(t('msg.billing.editing_bill_modify_save'));
            } else {
                RetailSaleManager.setSaleItems(bill.items.map(item => ({ ...item })));
                RetailSaleManager.setSaleWeights([]);
                
                if (bill.customerName) document.getElementById('saleCustomerName').value = bill.customerName;
                if (bill.comments) document.getElementById('saleComments').value = bill.comments;
                setPrintComments('salePrintComments', bill.printComments);
                
                // Payment as BILL-PAY reads it (payment object first, then top-level fields)
                const paid = readPayment(bill);
                const onlineValue = paid.online;
                const cashValue = paid.cash;
                
                if (onlineValue > 0) {
                    document.getElementById('saleOnlinePayment').value = onlineValue;
                    document.getElementById('saleOnlineCheckbox').checked = true;
                }
                if (cashValue > 0) {
                    document.getElementById('saleCashPayment').value = cashValue;
                    document.getElementById('saleCashCheckbox').checked = true;
                }
                
                const dueValue = paid.due;
                if (dueValue > 0) {
                    document.getElementById('saleDueAmount').value = dueValue;
                    document.getElementById('saleDueCheckbox').checked = true;
                }
                
                RetailSaleManager.renderSalesBill();
                RetailSaleManager.updateSaleTotals();
                
                window.app.nav.showTab('billing');
                // Switch to sale mode for retail sales
                setTimeout(() => {
                    const saleBtn = document.getElementById('saleModeBtn');
                    if (saleBtn) {
                        window.app.billing.switchMode('sale', { currentTarget: saleBtn });
                    }
                }, 100);
                UIManager.showToast(t('msg.billing.editing_sale_modify_save'));
            }
            
        } catch (error) {
            console.error('Failed to load bill for editing:', error);
            UIManager.showToast(t('msg.billing.failed_load_bill'));
        }
    },

    /**
     * Saved copy of the bill open in the editor (null when not editing / not found).
     * @returns {Object|null}
     */
    getEditingBill() {
        if (this.editingBillIndex === undefined) return null;
        const type = this.editingBillType || 'purchase';
        const history = type === 'purchase' ? AppState.purchaseHistory
            : type === 'retail' ? AppState.retailSalesHistory : AppState.salesHistory;
        const index = findBillIndex(history || [], this.editingBillId, this.editingBillIndex);
        return index === -1 ? null : history[index] || null;
    },

    /**
     * Save edited bill. Called from inside the purchase/retail save locks.
     * @async
     * @param {Object} [options]
     * @param {Function} [options.onWriteIssued] - Called with the updated bill as soon
     *   as the Firestore write is issued (used to start printing early)
     * @returns {Promise<Object>} Updated bill
     */
    async saveEditedBill(options = {}) {
        try {
            if (this.editingBillIndex === undefined) {
                return this.currentMode === 'purchase' ? PurchaseManager._saveBill(options) : RetailSaleManager._completeSale(options);
            }
            // Edits are checked against the server copy (transaction), so they need a connection.
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                UIManager.showToast(t(EDIT_OFFLINE_KEY));
                return undefined;
            }

            const billIndex = this.editingBillIndex;
            const billType = this.editingBillType || 'purchase';
            
            // Determine which history array to use based on type
            let history;
            if (billType === 'purchase') {
                history = AppState.purchaseHistory;
            } else if (billType === 'retail') {
                history = AppState.retailSalesHistory;
            } else if (billType === 'wholesale') {
                history = AppState.salesHistory;
            } else {
                UIManager.showToast(t('msg.billing.unknown_bill_type', { billType }));
                return;
            }
            const currentIndex = findBillIndex(history, this.editingBillId, billIndex);
            const bill = history[currentIndex];
            
            if (!bill) {
                UIManager.showToast(t('msg.billing.original_bill_not_found'));
                return;
            }

            if (this.currentMode === 'purchase') {
                const billItems = PurchaseManager.getBillItems();
                // Totals come from the items, never from the (rounded) text on screen
                const { billTotal, laborCharges, totalPackets, grandTotal } = PurchaseManager.computeTotals();
                // Money untouched: the stored figures stay exactly (paise of an old bill included);
                // else whole rupees with the split settled on the new payable (MONEY-ROUND, #129)
                const keepMoney = editKeepsMoney({ bill, items: billItems, labour: PurchaseManager.typedLabour(), typed: PurchaseManager.readTypedSplit() });
                const split = PurchaseManager.readPaymentSplit();
                const customerName = Helpers.getInputText('customerName');
                const comments = Helpers.getInputText('billComments');
                const printComments = readPrintComments('billPrintComments');
                
                const checks = await BillChecksUI.confirmSave('purchase', editCheckContext(bill));
                if (!checks.ok) return undefined;
                
                const laborCalculationSpan = document.getElementById('laborCalculation');
                const laborCalc = laborCalculationSpan?.textContent || null;

                const money = keepMoney ? {} : {
                    items: billItems,
                    billTotal,
                    laborCharges,
                    laborCalc,
                    totalPackets,
                    grandTotal,
                    amountPayable: grandTotal,
                    onlinePayment: split.online,
                    cashPayment: split.cash,
                    dueAmount: split.due,
                    payment: buildPaymentSplit(split)
                };
                const updatedBill = {
                    ...bill,
                    ...money,
                    customerName,
                    comments,
                    printComments,
                    editedAt: new Date().toISOString(),
                    editedBy: AppState.currentUser ? AppState.currentUser.uid : 'unknown',
                    ...BillChecksUI.billFields(checks, bill)
                };

                // Wait for the server: only a committed edit is printed, kept and cleared from the editor.
                const reason = await askEditReason(bill, updatedBill);
                if (reason === null) return undefined;
                FirebaseService.withLoadedPaymentSignature(updatedBill, this.editingBillPaymentSig);
                await commitBillEdit(FirebaseService.updatePurchase(updatedBill, { reason }));
                if (typeof options.onWriteIssued === 'function') options.onWriteIssued(updatedBill);
                const savedIndex = findBillIndex(AppState.purchaseHistory, bill.id, currentIndex);
                if (savedIndex !== -1) AppState.purchaseHistory[savedIndex] = updatedBill;
                
                AuditService.log(AuditService.ACTIONS.EDIT_BILL, {
                    billNumber: updatedBill.billNumber || 'N/A',
                    amount: billTotal,
                    supplier: customerName
                }).catch(e => console.warn('Audit log failed:', e));
                
                this._refreshAfterEdit();
                
                UIManager.showToast(t('msg.billing.bill_updated_successfully'));
                
                this.editingBillIndex = undefined;
                this.editingBillId = undefined;
                this.editingBillType = undefined;
                this.editingBillPaymentSig = undefined;
                PurchaseManager.clearBill();
                
                return updatedBill;
            } else {
                const saleItems = RetailSaleManager.getSaleItems();
                const { total: salesTotal, packetsSaved: totalPackets } = computeRetailTotals(saleItems);
                const keepMoney = editKeepsMoney({ bill, items: saleItems, typed: RetailSaleManager.readTypedSplit() });
                const saleSplit = RetailSaleManager.readPaymentSplit();
                const saleCustomer = Helpers.getInputText('saleCustomerName');
                const saleComments = Helpers.getInputText('saleComments');
                const printComments = readPrintComments('salePrintComments');

                const checks = await BillChecksUI.confirmSave('retail', editCheckContext(bill));
                if (!checks.ok) return undefined;

                const saleMoney = keepMoney ? {} : {
                    items: saleItems,
                    total: salesTotal,
                    saleTotal: salesTotal,
                    totalPackets: totalPackets,
                    onlinePayment: saleSplit.online,
                    cashPayment: saleSplit.cash,
                    dueAmount: saleSplit.due,
                    payment: buildPaymentSplit(saleSplit)
                };
                const updatedSale = {
                    ...bill,
                    ...saleMoney,
                    customerName: saleCustomer,
                    comments: saleComments,
                    printComments: printComments,
                    editedAt: new Date().toISOString(),
                    editedBy: AppState.currentUser ? AppState.currentUser.uid : 'unknown',
                    ...BillChecksUI.billFields(checks, bill)
                };

                const reason = await askEditReason(bill, updatedSale);
                if (reason === null) return undefined;
                FirebaseService.withLoadedPaymentSignature(updatedSale, this.editingBillPaymentSig);
                await commitBillEdit(FirebaseService.updateRetailSale(updatedSale, { reason }));
                if (typeof options.onWriteIssued === 'function') options.onWriteIssued(updatedSale);
                const saleIndex = AppState.retailSalesHistory.findIndex(s => s.id === bill.id);
                if (saleIndex !== -1) {
                    AppState.retailSalesHistory[saleIndex] = updatedSale;
                }
                
                AuditService.log(AuditService.ACTIONS.EDIT_SALE, {
                    billNumber: updatedSale.billNumber || 'N/A',
                    amount: salesTotal,
                    customer: saleCustomer
                }).catch(e => console.warn('Audit log failed:', e));
                
                this._refreshAfterEdit();
                
                UIManager.showToast(t('msg.billing.sale_updated_successfully'));
                
                this.editingBillIndex = undefined;
                this.editingBillId = undefined;
                this.editingBillType = undefined;
                this.editingBillPaymentSig = undefined;
                RetailSaleManager.clearSale();
                
                return updatedSale;
            }
            
        } catch (error) {
            console.error('Failed to update bill:', error);
            // Known outcomes keep the editor open so nothing typed is lost.
            if (isStorageFullError(error)) {
                UIManager.showToast(t(STORAGE_FULL_KEY), 'error');
                return undefined;
            }
            if (error?.code === 'conflict' || error?.code === 'edit-timeout' || error?.code === 'reason-required') {
                UIManager.showToast(t(error.code === 'edit-timeout' ? 'msg.billing.edit_timeout' : 'msg.billing.edit_conflict'));
                return undefined;
            }
            if (error?.code === 'voided') {
                UIManager.showToast(t('msg.billing.edit_voided'));
                return undefined;
            }
            if (error?.code === 'unavailable' || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
                UIManager.showToast(t(EDIT_OFFLINE_KEY));
                return undefined;
            }
            UIManager.showToast(t('msg.billing.failed_update_bill', { message: error.message }));
            throw error;
        }
    },

    /**
     * Refresh derived views after an edit without blocking the save.
     * @private
     */
    _refreshAfterEdit() {
        Promise.resolve()
            .then(() => FirebaseService.calculateStock())
            .then(stock => { AppState.stock = stock; })
            .catch(error => console.error('Stock recalculation after edit failed:', error))
            .finally(() => {
                if (typeof window.app?.finance?.calculateOverview === 'function') {
                    window.app.finance.calculateOverview();
                }
                if (typeof window.app?.outstanding?.renderDue === 'function') {
                    window.app.outstanding.renderDue();
                }
            });
    },

    // -------------------- DELEGATE METHODS --------------------
    // These methods delegate to the appropriate manager for backward compatibility

    // Purchase delegates
    addWeight: (autoAdd) => PurchaseManager.addWeight(autoAdd),
    renderWeights: () => PurchaseManager.renderWeights(),
    removeWeight: (index) => PurchaseManager.removeWeight(index),
    clearWeights: () => PurchaseManager.clearWeights(),
    addToBill: (autoAdd) => PurchaseManager.addToBill(autoAdd),
    renderBill: () => PurchaseManager.renderBill(),
    deleteBillItem: (index) => PurchaseManager.deleteBillItem(index),
    editBillItem: (index) => PurchaseManager.editBillItem(index),
    updateTotals: (heavy) => PurchaseManager.updateTotals(heavy),
    updatePaymentTotal: () => PurchaseManager.updatePaymentTotal(),
    fillPayableAmount: (type) => PurchaseManager.fillPayableAmount(type),
    saveBillToHistory: (options) => PurchaseManager.saveBillToHistory(options),
    printBill: () => PurchaseManager.printBill(),
    shareWhatsApp: () => PurchaseManager.shareWhatsApp(),
    pickContact: () => Helpers.pickContact('customerName'),
    getBillItems: () => PurchaseManager.getBillItems(),
    getWeights: () => PurchaseManager.getWeights(),

    // Retail sale delegates  
    addSaleWeight: (autoAdd) => RetailSaleManager.addSaleWeight(autoAdd),
    renderSaleWeights: () => RetailSaleManager.renderSaleWeights(),
    removeSaleWeight: (index) => RetailSaleManager.removeSaleWeight(index),
    clearSaleWeights: () => RetailSaleManager.clearSaleWeights(),
    addToSalesBill: (autoAdd) => RetailSaleManager.addToSalesBill(autoAdd),
    renderSalesBill: () => RetailSaleManager.renderSalesBill(),
    removeSalesItem: (index) => RetailSaleManager.removeSaleItem(index),
    removeSaleItem: (index) => RetailSaleManager.removeSaleItem(index),
    editSaleItem: (index) => RetailSaleManager.editSaleItem(index),
    updateSaleTotals: () => RetailSaleManager.updateSaleTotals(),
    updateSaleRunningTotal: () => RetailSaleManager.updateSaleRunningTotal(),
    updateSalePaymentTotal: () => RetailSaleManager.updateSalePaymentTotal(),
    fillReceivableAmount: (type) => RetailSaleManager.fillReceivableAmount(type),
    fillSalePayableAmount: (type) => RetailSaleManager.fillReceivableAmount(type),
    putRestInDue: (mode) => (mode === 'sale' ? RetailSaleManager.putRestInDue() : PurchaseManager.putRestInDue()),
    completeSale: () => RetailSaleManager.completeSale(),
    shareSaleWhatsApp: () => RetailSaleManager.shareSaleWhatsApp(),
    printSale: () => RetailSaleManager.printSale(),
    pickSaleContact: () => RetailSaleManager.pickSaleContact(),
    getSaleItems: () => RetailSaleManager.getSaleItems(),
    getSaleWeights: () => RetailSaleManager.getSaleWeights()
};

// Note: BillingManager.init() is called from main.js after all modules are loaded

export { BillingManager, PurchaseManager, RetailSaleManager };

// Data changes re-render this page (firestore-service.js emits, utils/events.js).
on(REFRESH.billingDropdown, () => {
    BillingManager.loadItemsDropdown();
    BillingManager.renderBillNumber();
});
on(ITEM_FREQUENCY_CHANGED, () => {
    BillingManager.loadItemsDropdown();
    BillingManager.loadSaleItemsDropdown();
});
