/**
 * @fileoverview Billing Core module for coordinating purchase and sale transactions
 * Handles mode switching, item dropdowns, drafts, auto-save, and editing
 * @module modules/billing
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { PrinterService } from '../services/printer.js';
import { AuditService } from '../services/audit.js';
import { Helpers } from '../utils/helpers.js';
import { round2, sumMoney } from '../utils/money.js';
import { BillChecksUI } from '../ui/bill-highlight.js';
import { findBillIndex } from '../utils/history-window.js';
import { TIME_MS, AUTO_SAVE_DELAY } from '../utils/constants.js';
import { PurchaseManager } from './purchase.js';
import { RetailSaleManager } from './retail-sale.js';
import { t } from '../i18n/index.js';
import { canEditBillFor, BILL_WINDOW_PASSED_KEY } from '../utils/record-permissions.js';

const EDIT_OFFLINE_KEY = 'msg.billing.edit_offline';
const EDIT_TIMEOUT_MS = 20000;

/**
 * Who may edit a bill (firestore.rules canFullyEditBill): the owner always; a
 * manager or the bill's creator for 2 days after it was saved (#87).
 */
export function canEditBill(bill) {
    return canEditBillFor(bill, { uid: AppState.currentUser?.uid, role: AppState.userRole });
}
export const EDIT_NOT_ALLOWED_KEY = 'msg.billing.edit_not_allowed';

/** Message key explaining why canEditBill(bill) is false. */
export function editBlockedKey(bill) {
    const uid = AppState.currentUser?.uid;
    const mayEditInWindow = AppState.userRole === 'manager' || !!(uid && bill?.userId && bill.userId === uid);
    return mayEditInWindow ? BILL_WINDOW_PASSED_KEY : EDIT_NOT_ALLOWED_KEY;
}

/** Draft fields that make the bill checks treat the form as an edit of `bill` (#37). */
const editCheckContext = (bill) => ({
    isEdit: true, id: bill.id, editingBill: bill, date: bill.date, enteredAt: bill.timestamp
});

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
            
            // Preserve current selections
            const currentItem = document.getElementById('saleItem')?.value;
            const currentRate = document.getElementById('saleRate')?.value;
            const currentWeight = document.getElementById('saleWeight')?.value;
            
            this.loadSaleItemsDropdown();
            
            if (currentItem) {
                const saleItemSelect = document.getElementById('saleItem');
                if (saleItemSelect) {
                    saleItemSelect.value = currentItem;
                    this.loadSaleRates();
                }
            }
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
        
        UIManager.hapticFeedback();
    },

    // -------------------- ITEM FREQUENCY --------------------

    /**
     * Load item frequency data from Firebase (global, shared across all users)
     * @async
     */
    async loadItemFrequency() {
        try {
            // Use a global document instead of per-user to ensure all users see same order
            const doc = await db.collection(window.getCollection ? window.getCollection('itemFrequency') : 'itemFrequency').doc('global').get();
            if (doc.exists) {
                this.itemFrequency = doc.data();
            } else {
                this.itemFrequency = { purchase: {}, sale: {} };
            }
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
            
            const FieldValue = firebase.firestore.FieldValue;
            const modeUpdate = {};
            Object.entries(deltas).forEach(([itemId, delta]) => {
                // Optimistic local update so dropdown ordering reflects the sale immediately
                const existing = this.itemFrequency[mode][itemId];
                const local = (existing && typeof existing === 'object') ? existing : { score: 0, lastUsed: 0, count: 0 };
                local.score = (local.score || 0) + delta.score;
                local.count = (local.count || 0) + delta.count;
                local.lastUsed = now;
                local.effectiveScore = local.score;
                this.itemFrequency[mode][itemId] = local;
                
                // Atomic increments: concurrent devices no longer overwrite each other.
                // effectiveScore is only a ranking hint (decay is applied on read).
                modeUpdate[itemId] = {
                    score: FieldValue.increment(delta.score),
                    count: FieldValue.increment(delta.count),
                    lastUsed: now,
                    effectiveScore: local.score
                };
            });
            if (Object.keys(modeUpdate).length === 0) return;
            
            // Nested object + merge (not dotted update paths) so item IDs containing
            // '.', '/', etc. are treated as literal map keys.
            await db.collection(window.getCollection ? window.getCollection('itemFrequency') : 'itemFrequency').doc('global')
                .set({ [mode]: modeUpdate }, { merge: true });
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
            const opt = document.createElement('option');
            const originalIndex = AppState.items.findIndex(i => i.id === item.id || i.name === item.name);
            opt.value = originalIndex;
            const displayName = (AppState.settings.showHindi && item.hindiName) ? item.hindiName : item.name;
            opt.textContent = displayName;
            select.appendChild(opt);
        });
        
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
            const opt = document.createElement('option');
            const originalIndex = AppState.items.findIndex(i => i.id === item.id || i.name === item.name);
            opt.value = originalIndex;
            const displayName = (AppState.settings.showHindi && item.hindiName) ? item.hindiName : item.name;
            opt.textContent = displayName;
            select.appendChild(opt);
        });
        
        if (AppState.items.length > 0) {
            this.loadSaleRates();
        }
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
        rateInput.placeholder = 'Select or enter rate';
        
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
        rateInput.placeholder = 'Select or enter rate';
        
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
    async saveDraft() {
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

        try {
            await db.collection(window.getCollection ? window.getCollection('drafts') : 'drafts').doc(draft.id).set(draft);
            
            UIManager.showToast(t('msg.billing.draft_saved_cloud'));
            UIManager.hapticFeedback('light');
            await this.updateDraftCount();

            this.clearBill();
        } catch (error) {
            console.error('Failed to save draft:', error);
            UIManager.showToast(t('msg.billing.failed_save_draft'));
        }
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

            const snapshot = await db.collection(window.getCollection ? window.getCollection('drafts') : 'drafts')
                .where('userId', '==', currentUser.uid)
                .get();
            
            const drafts = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
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
                            <button onclick="window.app.billing.loadDraft('${Helpers.escapeJsAttr(draft.id)}')" style="flex: 1; padding: 8px; background: #3b82f6; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600;">
                                ${Helpers.escapeHtml(t('ui.billing.load'))}
                            </button>
                            <button onclick="window.app.billing.deleteDraft('${Helpers.escapeJsAttr(draft.id)}')" style="flex: 1; padding: 8px; background: #ef4444; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600;">
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
     * Load a draft
     * @async
     * @param {string} draftId - Draft ID to load
     */
    async loadDraft(draftId) {
        try {
            const draftDoc = await db.collection(window.getCollection ? window.getCollection('drafts') : 'drafts').doc(draftId).get();
            
            if (!draftDoc.exists) {
                UIManager.showToast(t('msg.billing.draft_not_found'));
                return;
            }

            const draft = draftDoc.data();

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
            this.closeDrafts();

            await db.collection(window.getCollection ? window.getCollection('drafts') : 'drafts').doc(draftId).delete();
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
            await db.collection(window.getCollection ? window.getCollection('drafts') : 'drafts').doc(draftId).delete();
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
            
            const snapshot = await db.collection(window.getCollection ? window.getCollection('drafts') : 'drafts')
                .where('userId', '==', currentUser.uid)
                .get();
            
            const countElement = document.getElementById('draftCount');
            if (countElement) {
                countElement.textContent = snapshot.size;
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
                await this.deleteAutoSave();
                return;
            }

            const autoSaveData = {
                userId: AppState.currentUser.uid,
                userName: AppState.userName,
                mode: mode,
                lastSaved: firebase.firestore.FieldValue.serverTimestamp(),
                deviceInfo: navigator.userAgent
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

            await db.collection(window.getCollection ? window.getCollection('autoSaves') : 'autoSaves').doc(AppState.currentUser.uid).set(autoSaveData);
            
        } catch (error) {
            console.error('Auto-save failed:', error);
        }
    },

    /**
     * Delete auto-save
     * @async
     */
    async deleteAutoSave() {
        try {
            if (!AppState.currentUser) return;
            await db.collection(window.getCollection ? window.getCollection('autoSaves') : 'autoSaves').doc(AppState.currentUser.uid).delete();
        } catch (error) {
            if (error.code !== 'not-found') {
                console.error('Failed to delete auto-save:', error);
            }
        }
    },

    /**
     * Check for auto-save on load
     * @async
     */
    async checkAutoSave() {
        try {
            if (!AppState.currentUser) return;
            
            const autoSaveDoc = await db.collection(window.getCollection ? window.getCollection('autoSaves') : 'autoSaves').doc(AppState.currentUser.uid).get();
            
            if (!autoSaveDoc.exists) return;
            
            const autoSaveData = autoSaveDoc.data();
            
            const shouldRecover = confirm(
                t(autoSaveData.mode === 'purchase' ? 'msg.billing.recover_purchase' : 'msg.billing.recover_sale', {
                    when: autoSaveData.lastSaved ? new Date(autoSaveData.lastSaved.toDate()).toLocaleString('en-IN') : t('msg.billing.recover_earlier')
                })
            );
            
            if (shouldRecover) {
                await this.recoverAutoSave(autoSaveData);
            } else {
                await this.deleteAutoSave();
            }
        } catch (error) {
            console.error('Failed to check auto-save:', error);
        }
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
                UIManager.showToast(t(editBlockedKey(bill)));
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
                if (bill.laborCharges) document.getElementById('manualLaborCharges').value = bill.laborCharges;
                
                if (bill.payment) {
                    if (bill.payment.online > 0) {
                        document.getElementById('onlinePayment').value = bill.payment.online;
                        document.getElementById('onlineCheckbox').checked = true;
                    }
                    if (bill.payment.cash > 0) {
                        document.getElementById('cashPayment').value = bill.payment.cash;
                        document.getElementById('cashCheckbox').checked = true;
                    }
                    if (bill.payment.due > 0) {
                        document.getElementById('dueAmount').value = bill.payment.due;
                        document.getElementById('dueCheckbox').checked = true;
                    }
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
                
                // Check payments from payment object or top-level properties
                const onlineValue = bill.payment?.online || bill.onlinePayment || 0;
                const cashValue = bill.payment?.cash || bill.cashPayment || 0;
                
                if (onlineValue > 0) {
                    document.getElementById('saleOnlinePayment').value = onlineValue;
                    document.getElementById('saleOnlineCheckbox').checked = true;
                }
                if (cashValue > 0) {
                    document.getElementById('saleCashPayment').value = cashValue;
                    document.getElementById('saleCashCheckbox').checked = true;
                }
                
                // Check due from payment.due or dueAmount
                const dueValue = bill.payment?.due || bill.dueAmount || 0;
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
                const onlinePayment = round2(Helpers.getInputNumber('onlinePayment'));
                const cashPayment = round2(Helpers.getInputNumber('cashPayment'));
                const dueAmount = round2(Helpers.getInputNumber('dueAmount'));
                const customerName = Helpers.getInputText('customerName');
                const comments = Helpers.getInputText('billComments');
                const printComments = readPrintComments('billPrintComments');
                
                const checks = await BillChecksUI.confirmSave('purchase', editCheckContext(bill));
                if (!checks.ok) return undefined;
                
                const laborCalculationSpan = document.getElementById('laborCalculation');
                const laborCalc = laborCalculationSpan?.textContent || null;

                const updatedBill = {
                    ...bill,
                    items: billItems,
                    billTotal,
                    laborCharges,
                    laborCalc,
                    totalPackets,
                    grandTotal,
                    amountPayable: grandTotal,
                    onlinePayment,
                    cashPayment,
                    dueAmount,
                    customerName,
                    comments,
                    printComments,
                    payment: {
                        online: onlinePayment,
                        cash: cashPayment,
                        due: dueAmount,
                        total: round2(onlinePayment + cashPayment + dueAmount)
                    },
                    editedAt: new Date().toISOString(),
                    editedBy: AppState.currentUser ? AppState.currentUser.uid : 'unknown',
                    ...BillChecksUI.billFields(checks, bill)
                };

                // Wait for the server: only a committed edit is printed, kept and cleared from the editor.
                FirebaseService.withLoadedPaymentSignature(updatedBill, this.editingBillPaymentSig);
                await commitBillEdit(FirebaseService.updatePurchase(updatedBill));
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
                const salesTotal = sumMoney(saleItems, item => item.total);
                const totalPackets = saleItems.reduce((sum, item) => sum + (item.packets || 0), 0);
                const saleOnline = round2(Helpers.getInputNumber('saleOnlinePayment'));
                const saleCash = round2(Helpers.getInputNumber('saleCashPayment'));
                const saleDue = round2(Helpers.getInputNumber('saleDueAmount'));
                const saleCustomer = Helpers.getInputText('saleCustomerName');
                const saleComments = Helpers.getInputText('saleComments');
                const printComments = readPrintComments('salePrintComments');

                const checks = await BillChecksUI.confirmSave('retail', editCheckContext(bill));
                if (!checks.ok) return undefined;

                const updatedSale = {
                    ...bill,
                    items: saleItems,
                    total: salesTotal,
                    saleTotal: salesTotal,
                    totalPackets: totalPackets,
                    onlinePayment: saleOnline,
                    cashPayment: saleCash,
                    dueAmount: saleDue,
                    customerName: saleCustomer,
                    comments: saleComments,
                    printComments: printComments,
                    payment: {
                        online: saleOnline,
                        cash: saleCash,
                        due: saleDue,
                        total: round2(saleOnline + saleCash + saleDue)
                    },
                    editedAt: new Date().toISOString(),
                    editedBy: AppState.currentUser ? AppState.currentUser.uid : 'unknown',
                    ...BillChecksUI.billFields(checks, bill)
                };

                FirebaseService.withLoadedPaymentSignature(updatedSale, this.editingBillPaymentSig);
                await commitBillEdit(FirebaseService.updateRetailSale(updatedSale));
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
            if (error?.code === 'conflict' || error?.code === 'edit-timeout') {
                UIManager.showToast(t(error.code === 'conflict' ? 'msg.billing.edit_conflict' : 'msg.billing.edit_timeout'));
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
