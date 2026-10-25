/**
 * @fileoverview Items & Rates Management Module
 * Handles CRUD operations for inventory items and their associated rates
 * Supports purchase, wholesale, and sale rate categories
 * @module modules/items
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
import { Helpers } from '../utils/helpers.js';
import { ensureXLSX } from '../utils/lazy-scripts.js';
import { findItemById, findDuplicateItem, duplicateItemMessage, itemUsageFrequency, sortItemsByUsage, itemToSheetRow, planItemImport } from '../utils/item-catalog.js';
import { todayLocalISO, formatDateTimeIN } from '../utils/dates.js';
import {
    snapshotItem, diffItemSnapshots, changeWarnings, buildHistoryEntries, historyDocId,
    formatHistoryValue, fieldLabel, RATE_SANITY_FACTOR, RATE_FIELDS
} from '../utils/rate-history.js';
import { createRateEditTracker, diffItemRates, diffItemFields } from '../utils/notification-format.js';
import { canDeleteItem, ITEM_DELETE_LOCKED_KEY, isPermissionDenied } from '../utils/record-permissions.js';
import { t } from '../i18n/index.js';

/**
 * Items Manager - Manages inventory items and rates
 * @namespace ItemsManager
 */
const ItemsManager = {
    /**
     * Debounce timers for auto-save operations
     * @type {Object.<string, number>}
     * @private
     */
    updateTimers: {},

    /**
     * Rate value at the start of an inline edit, so the notification reports
     * "40 → 45" and not the previous keystroke ("4 → 45").
     * @private
     */
    rateEdits: createRateEditTracker(),
    
    /**
     * Id of the item open in the edit modal (null when adding). An id, not a
     * list position: the live listener replaces AppState.items at any time.
     * @type {string|null}
     */
    currentEditingItemId: null,
    
    /**
     * Modal rates for editing
     * @type {{purchase: Array<number>, wholesale: Array<number>, sale: Array<number>}}
     */
    modalRates: {
        purchase: [],
        wholesale: [],
        sale: []
    },

    /**
     * Item values when the edit dialog opened (#82): history diffs against
     * this once on save, not against each keystroke.
     * @type {?ReturnType<typeof snapshotItem>}
     */
    editStartSnapshot: null,

    /**
     * Inline edits: value before the current typing burst, keyed like the
     * save timers, so "4 → 45" is recorded as one change from the old value.
     * @type {Object.<string, *>}
     */
    pendingOldValues: {},

    /**
     * Time of the last recorded change per `${itemId}:${field}` in this
     * session, for the "two changes within 60 s" review flag.
     * @type {Object.<string, number>}
     */
    lastChangeAt: {},

    /**
     * Looks up an item by id at the moment of action.
     * @param {string} id
     * @returns {Object|null}
     */
    getItem(id) {
        return findItemById(AppState.items, id);
    },

    /**
     * Looks up an item by id; shows a toast when it no longer exists
     * (e.g. deleted from another phone).
     * @param {string} id
     * @returns {Object|null}
     */
    requireItem(id) {
        const item = this.getItem(id);
        if (!item) UIManager.showToast(t('msg.items.item_no_longer_exists'));
        return item;
    },

    /**
     * Render the items list in the DOM
     * Creates item cards with rate inputs for each category
     */
    renderItems() {
        const container = document.getElementById('itemsList');
        if (!container) return;
        
        container.innerHTML = '';
        
        AppState.items.forEach((item) => {
            // Initialize rates arrays if they don't exist
            if (!item.rates) item.rates = [];
            if (!item.saleRates) item.saleRates = [];
            if (!item.wholesaleRates) item.wholesaleRates = [];
            
            const id = `'${Helpers.escapeJsAttr(item.id)}'`;
            const itemCard = document.createElement('div');
            itemCard.className = 'item-card';
            
            // Build purchase rates HTML
            const purchaseRatesHTML = item.rates.map((rate, rateIndex) => `
                <div class="rate-group">
                    <input type="number" class="rate-input purchase" 
                           value="${Helpers.escapeHtml(rate)}" 
                           oninput="window.app.items.updateRate(${id}, ${rateIndex}, this.value)"
                           onchange="window.app.items.commitRate(${id}, ${rateIndex})"
                           placeholder="Rate">
                    <button class="delete-rate" onclick="window.app.items.deleteRate(${id}, ${rateIndex})">×</button>
                </div>
            `).join('');
            
            // Build sale rates HTML
            const saleRatesHTML = item.saleRates.map((rate, rateIndex) => `
                <div class="rate-group">
                    <input type="number" class="rate-input sale" 
                           value="${Helpers.escapeHtml(rate)}" 
                           oninput="window.app.items.updateSaleRate(${id}, ${rateIndex}, this.value)"
                           onchange="window.app.items.commitSaleRate(${id}, ${rateIndex})"
                           placeholder="Rate">
                    <button class="delete-rate" onclick="window.app.items.deleteSaleRate(${id}, ${rateIndex})">×</button>
                </div>
            `).join('');
            
            // Build wholesale rates HTML
            const wholesaleRatesHTML = item.wholesaleRates.map((rate, rateIndex) => `
                <div class="rate-group">
                    <input type="number" class="rate-input wholesale" 
                           value="${Helpers.escapeHtml(rate)}" 
                           oninput="window.app.items.updateWholesaleRate(${id}, ${rateIndex}, this.value)"
                           onchange="window.app.items.commitWholesaleRate(${id}, ${rateIndex})"
                           placeholder="Rate">
                    <button class="delete-rate" onclick="window.app.items.deleteWholesaleRate(${id}, ${rateIndex})">×</button>
                </div>
            `).join('');
            
            itemCard.innerHTML = `
                <div class="item-header">
                    <input type="text" class="item-name-input" 
                           value="${Helpers.escapeHtml(item.name)}" 
                           oninput="window.app.items.updateName(${id}, this.value)"
                           placeholder="Enter item name (English)">
                    <button class="delete-item-btn" onclick="window.app.items.deleteItem(${id})">Delete</button>
                </div>
                <div style="margin-bottom: 12px;">
                    <label style="font-size: 13px; font-weight: 600; color: #666; margin-bottom: 4px; display: block;">Hindi Name:</label>
                    <input type="text" 
                           value="${Helpers.escapeHtml(item.hindiName || '')}" 
                           oninput="window.app.items.updateHindiName(${id}, this.value)"
                           placeholder="हिंदी नाम"
                           style="width: 100%; padding: 10px; border: 2px solid #dee2e6; border-radius: 8px; font-size: 15px;">
                </div>
                <div class="item-row">
                    <div style="margin-bottom: 8px;">
                        <label style="font-size: 14px; font-weight: 600; color: #007bff; margin-bottom: 8px; display: block;">Purchase Rates (₹/kg):</label>
                        <div class="rates-container">${purchaseRatesHTML}<button class="add-rate-plus purchase" onclick="window.app.items.addRate(${id})">+</button></div>
                    </div>
                    <div style="margin-bottom: 8px;">
                        <label style="font-size: 14px; font-weight: 600; color: #ff6b6b; margin-bottom: 8px; display: block;">Wholesale Rates (₹/kg):</label>
                        <div class="rates-container">${wholesaleRatesHTML}<button class="add-rate-plus wholesale" onclick="window.app.items.addWholesaleRate(${id})">+</button></div>
                    </div>
                    <div>
                        <label style="font-size: 14px; font-weight: 600; color: #28a745; margin-bottom: 8px; display: block;">Retail Sale Rates (₹/kg):</label>
                        <div class="rates-container">${saleRatesHTML}<button class="add-rate-plus sale" onclick="window.app.items.addSaleRate(${id})">+</button></div>
                    </div>
                </div>
            `;
            
            container.appendChild(itemCard);
        });
    },

    /**
     * Add a new item to the inventory
     * Creates item with empty rates and saves to Firebase
     * @async
     * @returns {Promise<void>}
     */
    async addItem() {
        const newItem = {
            name: '',
            hindiName: '',
            rates: [],
            saleRates: []
        };
        
        await UIManager.withLoading(async () => {
            const savedItem = await FirebaseService.saveItem(newItem);
            AppState.items.push(savedItem);
            this.renderItems();
        });
        UIManager.showToast(t('msg.items.item_added'));
    },

    /**
     * Debounced save of one item, looked up by id when the timer fires.
     * @private
     * @param {string} key - timer key (already includes the item id)
     * @param {string} id - item id
     * @param {function(Object): void} [afterSave] - runs after a successful save
     */
    scheduleSave(key, id, afterSave) {
        clearTimeout(this.updateTimers[key]);
        this.updateTimers[key] = setTimeout(async () => {
            delete this.updateTimers[key];
            const item = this.getItem(id);
            if (!item) return;
            try {
                await FirebaseService.saveItem(item);
                if (afterSave) afterSave(item);
            } catch (error) {
                console.error('Error saving item:', error);
            }
        }, 500);
    },

    /**
     * Update item name with auto-save
     * Debounced to prevent excessive Firebase calls
     * @param {string} id - Item id
     * @param {string} value - New item name
     */
    updateItemName(id, value) {
        const item = this.getItem(id);
        if (!item) return;
        const dup = findDuplicateItem(AppState.items, { name: value }, id);
        if (dup) {
            clearTimeout(this.updateTimers[`name_${id}`]);
            UIManager.showToast(duplicateItemMessage(dup.name));
            return;
        }
        const key = `name_${id}`;
        this.rememberOldValue(key, item.name || '');
        item.name = value;
        this.scheduleSave(key, id, (saved) => this.recordInlineChange(key, saved, 'name', saved.name));
    },

    // Update item Hindi name (AUTO-SAVE with debounce)
    updateItemHindiName(id, value) {
        const item = this.getItem(id);
        if (!item) return;
        const dup = findDuplicateItem(AppState.items, { hindiName: value }, id);
        if (dup) {
            clearTimeout(this.updateTimers[`hindi_${id}`]);
            UIManager.showToast(duplicateItemMessage(dup.name));
            return;
        }
        const key = `hindi_${id}`;
        this.rememberOldValue(key, item.hindiName || '');
        item.hindiName = value;
        this.scheduleSave(key, id, (saved) => this.recordInlineChange(key, saved, 'hindiName', saved.hindiName));
    },

    /**
     * Keeps the value from before a typing burst (first keystroke wins).
     * @private
     */
    rememberOldValue(key, value) {
        if (!(key in this.pendingOldValues)) this.pendingOldValues[key] = value;
    },

    /**
     * After an inline debounced save: records one history entry from the
     * value before the typing burst to the saved value.
     * @private
     */
    recordInlineChange(key, item, field, newValue, index) {
        const oldValue = this.pendingOldValues[key];
        delete this.pendingOldValues[key];
        const norm = (v) => (v === '' || v === undefined || v === 0 ? null : v);
        if (norm(oldValue) === norm(newValue)) return;
        this.recordHistory(item, [{ field, old: norm(oldValue), new: norm(newValue), index }], 'inline');
    },

    /** Only owner/manager may write (and read) the history (firestore.rules). */
    canUseHistory() {
        return ['owner', 'manager'].includes(AppState.userRole);
    },

    /**
     * Appends rate/name history entries for one save (#82). Fire-and-forget
     * like the audit log: the item is already saved, a failed history write
     * is only logged.
     * @param {Object} item saved item (with id)
     * @param {Array<{field: string, old: *, new: *, index?: number}>} changes
     * @param {string} source 'modal' | 'inline' | 'import'
     */
    recordHistory(item, changes, source) {
        if (!item?.id || !changes || changes.length === 0 || !this.canUseHistory()) return;
        const at = Date.now();
        const entries = buildHistoryEntries(changes, {
            itemId: item.id,
            itemName: item.name || '',
            by: AppState.userName || AppState.currentUser?.email || '',
            byUserId: AppState.currentUser?.uid || '',
            at,
            source,
            lastChangeAt: this.lastChangeAt
        });
        entries.forEach(e => { this.lastChangeAt[`${e.itemId}:${e.field}`] = at; });
        Promise.resolve()
            .then(() => FirebaseService.addRateHistoryEntries(entries.map((data, i) => ({ id: historyDocId(item.id, at, i), data }))))
            .catch(e => console.warn('Rate history not saved:', e));
    },

    /**
     * Saves an item after a rate was added/removed in AppState. On failure the
     * local change is undone and the user is told (inline handlers can't catch).
     * @private
     */
    async _saveItemRates(item, undo) {
        let ok = true;
        try {
            await FirebaseService.saveItem(item);
        } catch (error) {
            ok = false;
            undo();
            console.error('Error saving item rates:', error);
            UIManager.showToast(t('msg.items.rate_not_saved_check_internet'), 3500);
        }
        this.renderItems();
        return ok;
    },

    /**
     * Rate list helpers shared by the purchase / sale / wholesale handlers.
     * @private
     */
    async addRateOfType(id, field) {
        const item = this.requireItem(id);
        if (!item) return;
        if (!item[field]) item[field] = [];
        item[field].push('');
        await this._saveItemRates(item, () => item[field].pop());
    },

    updateRateOfType(id, field, kind, rateIndex, value) {
        const item = this.getItem(id);
        if (!item) return;
        if (!item[field]) item[field] = [];
        const key = `${field}_${id}_${rateIndex}`;
        // Old value = before this typing burst, not the previous keystroke ("4 → 45")
        this.rememberOldValue(key, Number(item[field][rateIndex]) || 0);
        this.rateEdits.begin(key, item[field][rateIndex]);
        const newRate = Number(value);
        item[field][rateIndex] = newRate;
        const historyField = kind === 'sale' ? 'retail' : kind;
        this.scheduleSave(key, id, (saved) => this.recordInlineChange(key, saved, historyField, newRate, rateIndex));
    },

    /**
     * Inline rate input committed (change/blur): one notification comparing
     * the value at edit start with the committed value.
     */
    commitRateOfType(id, field, kind, rateIndex) {
        const item = this.getItem(id);
        const key = `${field}_${id}_${rateIndex}`;
        const change = this.rateEdits.commit(key, item?.[field]?.[rateIndex]);
        if (!item || !change) return;
        // Fire-and-forget; never rejects
        FirebaseService.notifyRateChange(item, kind, change.oldRate, change.newRate)
            .catch(e => console.warn('Rate-change notification failed:', e));
    },

    async deleteRateOfType(id, field, rateIndex) {
        const item = this.requireItem(id);
        if (!item || !item[field]) return;
        const [removed] = item[field].splice(rateIndex, 1);
        const saved = await this._saveItemRates(item, () => item[field].splice(rateIndex, 0, removed));
        const historyField = Object.keys(RATE_FIELDS).find(k => RATE_FIELDS[k] === field);
        if (saved && Number(removed) > 0 && historyField) {
            this.recordHistory(item, [{ field: historyField, old: Number(removed), new: null, index: rateIndex }], 'inline');
        }
    },

    // Purchase rates
    addRate(id) { return this.addRateOfType(id, 'rates'); },
    updateRate(id, rateIndex, value) { this.updateRateOfType(id, 'rates', 'purchase', rateIndex, value); },
    commitRate(id, rateIndex) { this.commitRateOfType(id, 'rates', 'purchase', rateIndex); },
    deleteRate(id, rateIndex) { return this.deleteRateOfType(id, 'rates', rateIndex); },

    // Retail sale rates
    addSaleRate(id) { return this.addRateOfType(id, 'saleRates'); },
    updateSaleRate(id, rateIndex, value) { this.updateRateOfType(id, 'saleRates', 'sale', rateIndex, value); },
    commitSaleRate(id, rateIndex) { this.commitRateOfType(id, 'saleRates', 'sale', rateIndex); },
    deleteSaleRate(id, rateIndex) { return this.deleteRateOfType(id, 'saleRates', rateIndex); },

    // Wholesale rates
    addWholesaleRate(id) { return this.addRateOfType(id, 'wholesaleRates'); },
    updateWholesaleRate(id, rateIndex, value) { this.updateRateOfType(id, 'wholesaleRates', 'wholesale', rateIndex, value); },
    commitWholesaleRate(id, rateIndex) { this.commitRateOfType(id, 'wholesaleRates', 'wholesale', rateIndex); },
    deleteWholesaleRate(id, rateIndex) { return this.deleteRateOfType(id, 'wholesaleRates', rateIndex); },

    /**
     * Deletes an item by id after confirmation. The item is looked up again
     * after the confirm dialog so a list change while it was open can't
     * redirect the delete to another item.
     * @param {string} id
     * @returns {Promise<boolean>} true when deleted
     */
    async deleteItem(id) {
        const item = this.requireItem(id);
        if (!item) return false;
        if (!canDeleteItem(AppState.userRole)) {
            UIManager.showToast(t(ITEM_DELETE_LOCKED_KEY), 4000);
            return false;
        }
        const itemName = item.name || 'Unnamed';
        
        const confirmed = await UIManager.showModal(
            t('msg.items.delete', { itemName }),
            t('msg.common.confirm_delete'),
            true
        );
        
        if (!confirmed) return false;
        if (!this.requireItem(id)) return false;
        
        UIManager.showLoading();
        try {
            await FirebaseService.deleteItem(id);
            const idx = AppState.items.findIndex(i => i.id === id);
            if (idx !== -1) AppState.items.splice(idx, 1);
            this.renderItems();
            this.renderItemsTable(this.currentSearchQuery());
            
            // Log audit entry
            await AuditService.log(AuditService.ACTIONS.DELETE_ITEM, {
                itemId: id,
                itemName: itemName
            });
            
            UIManager.hideLoading();
            UIManager.showToast(t('msg.items.item_deleted'));
            return true;
        } catch (error) {
            console.error('Error deleting item:', error);
            UIManager.hideLoading();
            UIManager.showToast(isPermissionDenied(error) ? t(ITEM_DELETE_LOCKED_KEY) : t('msg.items.failed_delete_item'));
            return false;
        }
    },

    /** Current text in the Items search box (kept across re-renders). */
    currentSearchQuery() {
        return document.getElementById('itemsSearchInput')?.value || '';
    },

    /** Re-renders the Items table keeping the search filter. */
    refreshTable() {
        this.renderItemsTable(this.currentSearchQuery());
    },

    /**
     * Downloads the catalogue as Excel. The ID column lets a later import
     * update the same items instead of creating new ones.
     * @param {string} [fileName]
     */
    async downloadItemsWorkbook(fileName) {
        await ensureXLSX();
        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.json_to_sheet(AppState.items.map(itemToSheetRow));
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Items');
        XLSX.writeFile(workbook, fileName || `items_${todayLocalISO()}.xlsx`);
    },

    // Export items to Excel
    async exportToExcel() {
        try {
            await this.downloadItemsWorkbook();
            UIManager.showToast(t('msg.items.items_exported_successfully'));
        } catch (error) {
            console.error('Export error:', error);
            UIManager.showToast(t('msg.items.failed_export_items'));
        }
    },

    /**
     * Preview text for an import plan (escaped HTML).
     * @param {ReturnType<typeof planItemImport>} plan
     * @returns {string}
     */
    importPreviewHtml(plan) {
        const e = (v) => Helpers.escapeHtml(v);
        const errorList = plan.errors.slice(0, 20).map(er => `<li>Row ${e(er.rowNumber)}: ${e(er.reason)}</li>`).join('');
        const more = plan.errors.length > 20 ? `<li>… ${e(plan.errors.length - 20)} more</li>` : '';
        return `
            <div style="text-align:left">
                <div>✏️ Update / बदलेंगे: <strong>${e(plan.updates.length)}</strong></div>
                <div>➕ New / नए: <strong>${e(plan.adds.length)}</strong></div>
                <div>✔️ Unchanged / कोई बदलाव नहीं: <strong>${e(plan.unchanged.length)}</strong></div>
                <div>⚠️ Rows with errors (not imported) / गलत पंक्तियाँ: <strong>${e(plan.errors.length)}</strong></div>
                ${plan.skipped ? `<div>Empty rows skipped: ${e(plan.skipped)}</div>` : ''}
                ${errorList ? `<ul style="margin:8px 0 0 16px; color:#b91c1c; font-size:13px">${errorList}${more}</ul>` : ''}
                <p style="margin-top:10px; font-size:13px; color:#555">Items not in the sheet are kept. Nothing is deleted. A backup Excel of the current items downloads first.<br>शीट में न होने वाले आइटम नहीं हटेंगे।</p>
            </div>`;
    },

    /**
     * Imports items from Excel as a MERGE: rows update the matching item (by
     * ID column, else by name) in place, unknown names are added, and nothing
     * is deleted. Shows a preview and asks for confirmation before writing.
     */
    async importFromExcel(event) {
        const input = event.target;
        const file = input.files[0];
        if (!file) return;
        
        try {
            await ensureXLSX();
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data);
            const worksheet = workbook.Sheets[workbook.SheetNames[0]];
            // defval keeps blank cells so "clear this field" differs from "column missing"
            const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
            const plan = planItemImport(rows, AppState.items);
            
            if (plan.updates.length === 0 && plan.adds.length === 0) {
                await UIManager.showModalWithHtml(this.importPreviewHtml(plan), t('msg.items.nothing_import'), false);
                return;
            }
            
            const confirmed = await UIManager.showModalWithHtml(this.importPreviewHtml(plan), t('msg.items.confirm_import'), true);
            if (!confirmed) return;
            
            UIManager.showLoading();
            try {
                await this.downloadItemsWorkbook(`items_backup_before_import_${todayLocalISO()}.xlsx`);
            } catch (backupError) {
                console.warn('Pre-import backup download failed:', backupError);
            }
            
            const added = await FirebaseService.importItems(plan.updates, plan.adds);
            plan.updates.forEach(u => {
                const idx = AppState.items.findIndex(i => i.id === u.id);
                if (idx === -1) return;
                const before = AppState.items[idx];
                const after = { ...before, ...u.fields };
                AppState.items[idx] = after;
                this.recordHistory(after, diffItemSnapshots(snapshotItem(before), snapshotItem(after)), 'import');
            });
            added.forEach(item => {
                if (!AppState.items.some(i => i.id === item.id)) AppState.items.push(item);
            });
            
            AuditService.log(AuditService.ACTIONS.EDIT_ITEM, {
                source: 'excel-import',
                updated: plan.updates.length,
                added: plan.adds.length,
                errors: plan.errors.length
            }).catch(e => console.warn('Audit log failed:', e));
            
            this.renderItems();
            this.refreshTable();
            UIManager.hideLoading();
            UIManager.showToast(t(plan.errors.length ? 'msg.items.import_complete_skipped' : 'msg.items.import_complete', { updated: plan.updates.length, added: plan.adds.length, skipped: plan.errors.length }));
        } catch (error) {
            console.error('Import error:', error);
            UIManager.hideLoading();
            UIManager.showToast(t('msg.items.failed_import_items', { message: error.message }));
        } finally {
            input.value = '';
        }
    },
    /**
     * Item usage (bill lines per item id) from the loaded purchase, wholesale
     * and retail histories.
     * @returns {Object.<string, number>}
     */
    calculateItemFrequency() {
        return itemUsageFrequency({
            purchases: AppState.purchaseHistory,
            wholesaleSales: AppState.salesHistory,
            retailSales: AppState.retailSalesHistory
        }, AppState.items);
    },

    // Render items table view
    renderItemsTable(searchQuery = '') {
        const tbody = document.getElementById('itemsViewTableBody');
        if (!tbody) return;
        
        tbody.innerHTML = '';
        
        // Check user role for permissions
        const isStaff = AppState.userRole === 'staff';
        
        // Hide/show wholesale column and action buttons based on role
        const wholesaleColumns = document.querySelectorAll('.wholesale-column');
        const actionButtons = document.getElementById('itemsActionButtons');
        
        wholesaleColumns.forEach(col => {
            col.style.display = isStaff ? 'none' : '';
        });
        
        if (actionButtons) {
            actionButtons.style.display = isStaff ? 'none' : 'flex';
        }
        
        // Calculate frequency for sorting
        const frequency = this.calculateItemFrequency();
        
        // Filter items based on search query
        let filteredItems = AppState.items;
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            filteredItems = AppState.items.filter(item => {
                const name = (item.name || '').toLowerCase();
                const hindiName = (item.hindiName || '').toLowerCase();
                return name.includes(query) || hindiName.includes(query);
            });
        }
        
        // Sort by frequency (most used first), then alphabetically
        const sortedItems = sortItemsByUsage(filteredItems, frequency);
        
        sortedItems.forEach((item) => {
            // Determine which name to display based on settings
            const displayName = (AppState.settings.showHindi && item.hindiName) 
                ? item.hindiName 
                : item.name;
            
            // Format purchase rates
            const purchaseRates = item.rates && item.rates.length > 0 
                ? item.rates.map(r => `${r}`).join(', ') 
                : '-';
            
            // Format wholesale rates
            const wholesaleRates = item.wholesaleRates && item.wholesaleRates.length > 0 
                ? item.wholesaleRates.map(r => `${r}`).join(', ') 
                : '-';
            
            // Format sale rates
            const saleRates = item.saleRates && item.saleRates.length > 0 
                ? item.saleRates.map(r => `${r}`).join(', ') 
                : '-';
            
            // Calculate average rate from stock for staff view
            let avgRate = '-';
            if (isStaff && AppState.stock) {
                // Stock is keyed by catalogue id (stock-replay resolves names to ids)
                const stockEntry = AppState.stock[item.id];
                if (stockEntry && stockEntry.rate) {
                    avgRate = `₹${stockEntry.rate.toFixed(2)}`;
                }
            }
            
            const row = document.createElement('tr');
            row.style.borderBottom = '1px solid #e5e7eb';
            row.style.cursor = isStaff ? 'default' : 'pointer';
            row.style.transition = 'all 0.2s';
            
            if (!isStaff) {
                row.onmouseenter = () => {
                    row.style.background = '#f9fafb';
                    row.style.transform = 'scale(1.01)';
                    row.style.boxShadow = '0 2px 4px rgba(0,0,0,0.05)';
                };
                row.onmouseleave = () => {
                    row.style.background = 'white';
                    row.style.transform = 'scale(1)';
                    row.style.boxShadow = 'none';
                };
                row.onclick = () => this.openEditModal(item.id);
            }
            
            // Staff view: show item name, purchase rates, and retail sale rates
            // Non-staff view: show item name, purchase rates, sale rates, wholesale rates
            if (isStaff) {
                row.innerHTML = `
                    <td style="padding: 16px; font-weight: 600; color: #1f2937; font-size: 15px; border-right: 1px solid #f3f4f6;">
                        ${Helpers.escapeHtml(displayName || item.name || '-')}
                    </td>
                    <td style="padding: 16px; color: #007bff; font-size: 14px; font-weight: 600; border-right: 1px solid #f3f4f6;">${Helpers.escapeHtml(purchaseRates)}</td>
                    <td style="padding: 16px; color: #28a745; font-size: 14px; font-weight: 600;">${Helpers.escapeHtml(saleRates)}</td>
                `;
            } else {
                row.innerHTML = `
                    <td style="padding: 16px; font-weight: 600; color: #1f2937; font-size: 15px; border-right: 1px solid #f3f4f6;">
                        ${Helpers.escapeHtml(displayName || item.name || '-')}
                    </td>
                    <td style="padding: 16px; color: #007bff; font-size: 14px; font-weight: 600; border-right: 1px solid #f3f4f6;">${Helpers.escapeHtml(purchaseRates)}</td>
                    <td style="padding: 16px; color: #28a745; font-size: 14px; font-weight: 600; border-right: 1px solid #f3f4f6;">${Helpers.escapeHtml(saleRates)}</td>
                    <td class="wholesale-column" style="padding: 16px; color: #9333ea; font-size: 14px; font-weight: 600;">${Helpers.escapeHtml(wholesaleRates)}</td>
                `;
            }
            tbody.appendChild(row);
        });
        
        if (sortedItems.length === 0) {
            const colspan = isStaff ? '3' : '4';
            tbody.innerHTML = `<tr><td colspan="${colspan}" style="padding: 24px; text-align: center; color: #999;">No items found</td></tr>`;
        }
    },
    
    // Open modal to add new item
    openAddModal() {
        this.currentEditingItemId = null;
        this.modalRates = { purchase: [], wholesale: [], sale: [] };
        
        document.getElementById('itemModalName').value = '';
        document.getElementById('itemModalHindiName').value = '';
        document.getElementById('itemModalContactPerson').value = '';
        document.getElementById('itemModalDeleteBtn').style.display = 'none';
        this.editStartSnapshot = null;
        this.resetModalHistory(false);
        
        this.renderModalRates();
        document.getElementById('itemEditOverlay').style.display = 'flex';
    },
    
    // Open modal to edit existing item
    openEditModal(id) {
        const item = this.requireItem(id);
        if (!item) return;
        this.currentEditingItemId = id;
        
        document.getElementById('itemModalName').value = item.name || '';
        document.getElementById('itemModalHindiName').value = item.hindiName || '';
        document.getElementById('itemModalContactPerson').value = item.contactPerson || '';
        document.getElementById('itemModalDeleteBtn').style.display = canDeleteItem(AppState.userRole) ? 'block' : 'none';
        
        this.modalRates = {
            purchase: [...(item.rates || [])],
            wholesale: [...(item.wholesaleRates || [])],
            sale: [...(item.saleRates || [])]
        };
        // Values at edit start; history is diffed against these once on save
        this.editStartSnapshot = snapshotItem(item);
        this.resetModalHistory(this.canUseHistory());
        
        this.renderModalRates();
        document.getElementById('itemEditOverlay').style.display = 'flex';
    },

    /**
     * Shows/hides the "Change history" block and clears loaded entries.
     * @param {boolean} visible
     */
    resetModalHistory(visible) {
        const section = document.getElementById('itemModalHistorySection');
        if (section) section.style.display = visible ? 'block' : 'none';
        const list = document.getElementById('itemModalHistoryList');
        if (list) list.innerHTML = '';
        const btn = document.getElementById('itemModalHistoryBtn');
        if (btn) btn.style.display = '';
    },

    /**
     * Loads and shows the open item's rate/name history (newest first).
     * Only on request, to keep Firestore reads low.
     */
    async loadModalHistory() {
        const id = this.currentEditingItemId;
        const list = document.getElementById('itemModalHistoryList');
        if (!id || !list || !this.canUseHistory()) return;
        list.innerHTML = `<p style="color:#888; font-size:13px;">${Helpers.escapeHtml(t('ui.rate_history.loading'))}</p>`;
        try {
            const entries = await FirebaseService.loadRateHistory(id);
            if (this.currentEditingItemId !== id) return;
            const btn = document.getElementById('itemModalHistoryBtn');
            if (btn) btn.style.display = 'none';
            list.innerHTML = this.historyListHtml(entries);
        } catch (error) {
            console.error('Error loading rate history:', error);
            list.innerHTML = `<p style="color:#b91c1c; font-size:13px;">${Helpers.escapeHtml(t('ui.rate_history.load_failed'))}</p>`;
        }
    },

    /**
     * Escaped HTML for history entries.
     * @param {Array<Object>} entries newest first
     * @returns {string}
     */
    historyListHtml(entries) {
        const e = (v) => Helpers.escapeHtml(v);
        if (!entries || entries.length === 0) {
            return `<p style="color:#888; font-size:13px;">${e(t('ui.rate_history.no_changes'))}</p>`;
        }
        return entries.map(h => {
            const flags = Array.isArray(h.flags) ? h.flags : [];
            const flagText = [
                flags.includes('out-of-band') ? t('ui.rate_history.flag_big', { factor: RATE_SANITY_FACTOR }) : '',
                flags.includes('quick-repeat') ? t('ui.rate_history.flag_repeat') : ''
            ].filter(Boolean).join(' · ');
            return `
                <div class="rate-history-row" style="padding:8px 0; border-bottom:1px solid #f1f1f1; font-size:13px;">
                    <div><strong>${e(fieldLabel(h.field))}</strong>: ${e(formatHistoryValue(h.field, h.old))} → ${e(formatHistoryValue(h.field, h.new))}</div>
                    <div style="color:#666;">${e(formatDateTimeIN(h.at))}${h.by ? ` • ${e(h.by)}` : ''}</div>
                    ${flagText ? `<div style="color:#b45309;">${e(flagText)}</div>` : ''}
                </div>`;
        }).join('');
    },

    /**
     * Confirms renames and big rate jumps before saving. Resolves true when
     * there is nothing to confirm or the user agrees.
     * @param {Array<{field: string, old: *, new: *}>} changes
     * @param {boolean} isNew
     * @returns {Promise<boolean>}
     */
    async confirmRiskyChanges(changes, isNew) {
        const { rename, outOfBand } = changeWarnings(changes, { isNew });
        if (rename.length === 0 && outOfBand.length === 0) return true;
        const e = (v) => Helpers.escapeHtml(v);
        const parts = [];
        if (rename.length) {
            parts.push(`<p><strong>${e(t('ui.rate_history.rename'))}</strong></p><ul style="margin:4px 0 8px 16px">${rename.map(c =>
                `<li>${e(c.old)} → ${e(c.new || '—')}</li>`).join('')}</ul>
                <p style="font-size:13px; color:#555">${e(t('ui.rate_history.rename_note'))}</p>`);
        }
        if (outOfBand.length) {
            parts.push(`<p><strong>${e(t('ui.rate_history.big_change', { factor: RATE_SANITY_FACTOR }))}</strong></p><ul style="margin:4px 0 8px 16px">${outOfBand.map(c =>
                `<li>${e(fieldLabel(c.field))}: ₹${e(c.old)} → ₹${e(c.new)}</li>`).join('')}</ul>
                <p style="font-size:13px; color:#555">${e(t('ui.rate_history.check_rate'))}</p>`);
        }
        return UIManager.showModalWithHtml(`<div style="text-align:left">${parts.join('')}</div>`, t('msg.items.confirm_changes'), true);
    },
    
    // Render rates in modal
    renderModalRates() {
        // Render purchase rates
        const purchaseContainer = document.getElementById('itemModalPurchaseRates');
        purchaseContainer.innerHTML = this.modalRates.purchase.map((rate, idx) => `
            <div class="rate-group">
                <input type="number" class="rate-input purchase" 
                       value="${Helpers.escapeHtml(rate)}" 
                       oninput="window.app.items.updateModalRate('purchase', ${idx}, this.value)"
                       placeholder="Rate">
                <button class="delete-rate" onclick="window.app.items.deleteModalRate('purchase', ${idx})">×</button>
            </div>
        `).join('');
        
        // Render wholesale rates
        const wholesaleContainer = document.getElementById('itemModalWholesaleRates');
        wholesaleContainer.innerHTML = this.modalRates.wholesale.map((rate, idx) => `
            <div class="rate-group">
                <input type="number" class="rate-input wholesale" 
                       value="${Helpers.escapeHtml(rate)}" 
                       oninput="window.app.items.updateModalRate('wholesale', ${idx}, this.value)"
                       placeholder="Rate">
                <button class="delete-rate" onclick="window.app.items.deleteModalRate('wholesale', ${idx})">×</button>
            </div>
        `).join('');
        
        // Render sale rates
        const saleContainer = document.getElementById('itemModalSaleRates');
        saleContainer.innerHTML = this.modalRates.sale.map((rate, idx) => `
            <div class="rate-group">
                <input type="number" class="rate-input sale" 
                       value="${Helpers.escapeHtml(rate)}" 
                       oninput="window.app.items.updateModalRate('sale', ${idx}, this.value)"
                       placeholder="Rate">
                <button class="delete-rate" onclick="window.app.items.deleteModalRate('sale', ${idx})">×</button>
            </div>
        `).join('');
    },
    
    // Add rate in modal
    addModalRate(type) {
        this.modalRates[type].push('');
        this.renderModalRates();
    },
    
    // Update rate in modal
    updateModalRate(type, index, value) {
        this.modalRates[type][index] = Number(value);
    },
    
    // Delete rate in modal
    deleteModalRate(type, index) {
        this.modalRates[type].splice(index, 1);
        this.renderModalRates();
    },
    
    // Save item from modal
    async saveItemFromModal() {
        const name = document.getElementById('itemModalName').value.trim();
        const hindiName = document.getElementById('itemModalHindiName').value.trim();
        
        if (!name) {
            UIManager.showToast(t('msg.items.enter_item_name'));
            return;
        }
        
        const editingId = this.currentEditingItemId;
        const dup = findDuplicateItem(AppState.items, { name, hindiName }, editingId);
        if (dup) {
            UIManager.showToast(duplicateItemMessage(dup.name));
            return;
        }
        
        let existing = null;
        if (editingId !== null) {
            existing = this.requireItem(editingId);
            if (!existing) {
                this.closeItemModal();
                this.refreshTable();
                return;
            }
        }
        
        const contactPerson = document.getElementById('itemModalContactPerson').value.trim();
        const itemData = {
            name: name,
            hindiName: hindiName,
            contactPerson: contactPerson,
            rates: this.modalRates.purchase.filter(r => r > 0),
            wholesaleRates: this.modalRates.wholesale.filter(r => r > 0),
            saleRates: this.modalRates.sale.filter(r => r > 0)
        };
        const before = existing ? (this.editStartSnapshot || snapshotItem(existing)) : snapshotItem(null);
        const changes = diffItemSnapshots(before, snapshotItem(itemData));
        if (!(await this.confirmRiskyChanges(changes, !existing))) return;
        if (existing) {
            // Re-read: the live listener may have replaced the item while the confirm was open
            existing = this.requireItem(editingId);
            if (!existing) {
                this.closeItemModal();
                this.refreshTable();
                return;
            }
        }
        
        UIManager.showLoading();
        
        try {
            if (existing) {
                // Keep fields this dialog doesn't edit; write by id, never by list position
                const updated = { ...existing, ...itemData, id: editingId };
                await FirebaseService.saveItem(updated);
                const idx = AppState.items.findIndex(i => i.id === editingId);
                if (idx !== -1) AppState.items[idx] = updated;
                this.recordHistory(updated, changes, 'modal');
                UIManager.showToast(t('msg.items.item_updated'));
                this.notifyModalEdit(existing, updated);
            } else {
                // Add new item
                const savedItem = await FirebaseService.saveItem(itemData);
                AppState.items.push(savedItem);
                this.recordHistory(savedItem, changes, 'modal');
                UIManager.showToast(t('msg.items.item_added'));
                this.notifyItemAdded(savedItem);
            }
            
            this.closeItemModal();
            this.refreshTable();
            UIManager.hideLoading();
        } catch (error) {
            console.error('Error saving item:', error);
            UIManager.hideLoading();
            UIManager.showToast(t('msg.items.failed_save_item'));
        }
    },
    
    /**
     * Edit dialog saved: rate changes go to everyone (wholesale: owners and
     * managers), name/contact changes to owners. Values are compared with the
     * item as it was when the dialog opened. Fire-and-forget.
     * @private
     */
    notifyModalEdit(before, after) {
        try {
            const rateChanges = diffItemRates(before, after);
            if (rateChanges.length) {
                FirebaseService.notifyRateChanges(after, rateChanges)
                    .catch(e => console.warn('Rate-change notification failed:', e));
            }
            const fields = diffItemFields(before, after);
            if (fields.length) {
                FirebaseService.notifyItemEdit(after, 'updated', fields)
                    .catch(e => console.warn('Item notification failed:', e));
            }
        } catch (e) {
            // A notification problem must never fail the save itself.
            console.warn('Item notifications failed:', e);
        }
    },

    /** @private Fire-and-forget "new item" note for owners. */
    notifyItemAdded(item) {
        try {
            FirebaseService.notifyItemEdit(item, 'added')
                .catch(e => console.warn('Item notification failed:', e));
        } catch (e) {
            console.warn('Item notification failed:', e);
        }
    },

    // Delete item from modal
    async deleteItemFromModal() {
        const id = this.currentEditingItemId;
        if (id === null) return;
        const deleted = await this.deleteItem(id);
        if (deleted) this.closeItemModal();
    },
    
    // Close item modal
    closeItemModal() {
        document.getElementById('itemEditOverlay').style.display = 'none';
        this.currentEditingItemId = null;
        this.editStartSnapshot = null;
        this.modalRates = { purchase: [], wholesale: [], sale: [] };
    }
};
// Export ItemsManager
export { ItemsManager };
