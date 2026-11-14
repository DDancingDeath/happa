/**
 * @fileoverview Items & Rates Management Module
 * Handles CRUD operations for inventory items and their associated rates
 * Supports purchase, wholesale, and sale rate categories
 * @module modules/items
 */

import { AppState } from '../utils/state.js';
import { on, REFRESH } from '../utils/events.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
import { Helpers } from '../utils/helpers.js';
import { ensureXLSX } from '../utils/lazy-scripts.js';
import { findItemById, findDuplicateItem, duplicateItemMessage, itemUsageFrequency, sortItemsByUsage, sortItemsByName, itemToSheetRow, planItemImport, isArchivedItem, visibleItems } from '../utils/item-catalog.js';
import { adjustItemStock } from '../utils/calc/stock.js';
import { todayLocalISO, formatDateTimeIN } from '../utils/dates.js';
import {
    snapshotItem, diffItemSnapshots, changeWarnings, buildHistoryEntries, historyDocId,
    formatHistoryValue, fieldLabel, RATE_SANITY_FACTOR, RATE_FIELDS
} from '../utils/rate-history.js';
import { createRateEditTracker, diffItemRates, diffItemFields } from '../utils/notification-format.js';
import { canArchiveItem, ITEM_ARCHIVE_LOCKED_KEY, isPermissionDenied } from '../utils/record-permissions.js';
import { t } from '../i18n/index.js';
import { attachScrollCue } from '../ui/scroll-cue.js';
import { CHANGED_ELSEWHERE, isOffline, writeErrorKey } from '../utils/write-conflict.js';
import { suggestHindiName, suggestEnglishName, autofillValue } from '../utils/item-name-autofill.js';
import { formatRate, formatKg } from '../utils/money.js';
import { icon } from '../ui/icons.js';
import { moneyHtml, emptyState } from '../ui/components.js';

/**
 * Items Manager - Manages inventory items and rates
 * @namespace ItemsManager
 */
import { safeSetItem } from '../utils/storage-full.js';

const SORT_KEY = 'happa.itemsSort';

/** A rate as a money figure; its text is exactly formatRate(rate). */
const rateHtml = (rate) => {
    const html = moneyHtml(rate, 'rate');
    return html === '—' ? Helpers.escapeHtml(formatRate(rate)) : html;
};

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
        
        visibleItems(AppState.items).forEach((item) => {
            // Initialize rates arrays if they don't exist
            if (!item.rates) item.rates = [];
            if (!item.saleRates) item.saleRates = [];
            if (!item.wholesaleRates) item.wholesaleRates = [];
            
            const id = `'${Helpers.escapeJsAttr(item.id)}'`;
            const itemCard = document.createElement('div');
            itemCard.className = 'panel panel-pad rates-card';
            
            // Build purchase rates HTML
            const purchaseRatesHTML = item.rates.map((rate, rateIndex) => `
                <div class="rate-group">
                    <input type="number" class="rate-input purchase" 
                           value="${Helpers.escapeHtml(rate)}" 
                           data-oninput="items.updateRate(${id}, ${rateIndex}, this.value)"
                           data-onchange="items.commitRate(${id}, ${rateIndex})"
                           placeholder="${Helpers.escapeHtml(t('ui.common.rate'))}">
                    <button class="delete-rate" data-onclick="items.deleteRate(${id}, ${rateIndex})">×</button>
                </div>
            `).join('');
            
            // Build sale rates HTML
            const saleRatesHTML = item.saleRates.map((rate, rateIndex) => `
                <div class="rate-group">
                    <input type="number" class="rate-input sale" 
                           value="${Helpers.escapeHtml(rate)}" 
                           data-oninput="items.updateSaleRate(${id}, ${rateIndex}, this.value)"
                           data-onchange="items.commitSaleRate(${id}, ${rateIndex})"
                           placeholder="${Helpers.escapeHtml(t('ui.common.rate'))}">
                    <button class="delete-rate" data-onclick="items.deleteSaleRate(${id}, ${rateIndex})">×</button>
                </div>
            `).join('');
            
            // Build wholesale rates HTML
            const wholesaleRatesHTML = item.wholesaleRates.map((rate, rateIndex) => `
                <div class="rate-group">
                    <input type="number" class="rate-input wholesale" 
                           value="${Helpers.escapeHtml(rate)}" 
                           data-oninput="items.updateWholesaleRate(${id}, ${rateIndex}, this.value)"
                           data-onchange="items.commitWholesaleRate(${id}, ${rateIndex})"
                           placeholder="${Helpers.escapeHtml(t('ui.common.rate'))}">
                    <button class="delete-rate" data-onclick="items.deleteWholesaleRate(${id}, ${rateIndex})">×</button>
                </div>
            `).join('');
            
            itemCard.innerHTML = `
                <div class="rates-card-head">
                    <input type="text" class="input" 
                           value="${Helpers.escapeHtml(item.name)}" 
                           data-oninput="items.updateName(${id}, this.value)"
                           aria-label="${Helpers.escapeHtml(t('ui.items.name_placeholder'))}"
                           placeholder="${Helpers.escapeHtml(t('ui.items.name_placeholder'))}">
                    <button type="button" class="btn btn-danger btn-sm" data-onclick="items.archiveItem(${id})">${Helpers.escapeHtml(t('ui.items.archive_item'))}</button>
                </div>
                <label class="field">
                    <span>${Helpers.escapeHtml(t('ui.items.hindi_name_label'))}</span>
                    <input type="text" class="input" 
                           value="${Helpers.escapeHtml(item.hindiName || '')}" 
                           data-oninput="items.updateHindiName(${id}, this.value)"
                           placeholder="${Helpers.escapeHtml(t('ui.items.hindi_name_placeholder'))}">
                </label>
                <div class="field">
                    <span class="rates-head"><span class="mode-dot" aria-hidden="true"></span>${Helpers.escapeHtml(t('ui.items.purchase_rates_kg'))}</span>
                    <div class="rates-container">${purchaseRatesHTML}<button type="button" class="add-rate-plus purchase" data-onclick="items.addRate(${id})">+</button></div>
                </div>
                <div class="field">
                    <span class="rates-head"><span class="mode-dot wholesale" aria-hidden="true"></span>${Helpers.escapeHtml(t('ui.items.wholesale_rates_kg'))}</span>
                    <div class="rates-container">${wholesaleRatesHTML}<button type="button" class="add-rate-plus wholesale" data-onclick="items.addWholesaleRate(${id})">+</button></div>
                </div>
                <div class="field">
                    <span class="rates-head"><span class="mode-dot sale" aria-hidden="true"></span>${Helpers.escapeHtml(t('ui.items.retail_rates_kg'))}</span>
                    <div class="rates-container">${saleRatesHTML}<button type="button" class="add-rate-plus sale" data-onclick="items.addSaleRate(${id})">+</button></div>
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
            AuditService.note(AuditService.ACTIONS.CREATE_ITEM, { itemId: savedItem.id || null, source: 'row' });
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
            UIManager.showToast(duplicateItemMessage(dup.name, dup.item));
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
            UIManager.showToast(duplicateItemMessage(dup.name, dup.item));
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
     * Archives an item after confirmation (#123): it stays in old bills, stock
     * and statements but is no longer offered for new bills. The item is looked
     * up again after the confirm dialog so a list change while it was open
     * can't redirect the action to another item.
     * @param {string} id
     * @returns {Promise<boolean>} true when archived
     */
    async archiveItem(id) {
        const item = this.requireItem(id);
        if (!item) return false;
        if (!canArchiveItem(AppState.userRole)) {
            UIManager.showToast(t(ITEM_ARCHIVE_LOCKED_KEY), 4000);
            return false;
        }
        const itemName = item.name || 'Unnamed';
        const { quantity } = adjustItemStock(AppState.stock?.[id]);
        const message = [t('msg.items.archive', { itemName }), quantity > 0 ? t('msg.items.archive_stock', { kg: formatKg(quantity) }) : '']
            .filter(Boolean).join(' ');
        const confirmed = await UIManager.showModal(message, t('ui.items.archive_item'), true);
        if (!confirmed) return false;
        if (!this.requireItem(id)) return false;
        return this.setArchived(id, true);
    },

    /**
     * Brings an archived item back into the lists and bill pickers.
     * @param {string} id
     * @returns {Promise<boolean>}
     */
    async unarchiveItem(id) {
        if (!this.requireItem(id)) return false;
        if (!canArchiveItem(AppState.userRole)) {
            UIManager.showToast(t(ITEM_ARCHIVE_LOCKED_KEY), 4000);
            return false;
        }
        return this.setArchived(id, false);
    },

    /** @private */
    async setArchived(id, archived) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            UIManager.showToast(t('msg.items.needs_internet'), 4000);
            return false;
        }
        UIManager.showLoading();
        try {
            const fields = await FirebaseService.setItemArchived(id, archived);
            const current = this.getItem(id);
            if (current) Object.assign(current, fields);
            this.refreshTable();
            const item = this.getItem(id);
            AuditService.note(archived ? AuditService.ACTIONS.ARCHIVE_ITEM : AuditService.ACTIONS.UNARCHIVE_ITEM,
                { itemId: id, itemName: item?.name || '' });
            UIManager.hideLoading();
            UIManager.showToast(t(archived ? 'msg.items.item_archived' : 'msg.items.item_unarchived'));
            return true;
        } catch (error) {
            console.error('Error archiving item:', error);
            UIManager.hideLoading();
            UIManager.showToast(isPermissionDenied(error) ? t(ITEM_ARCHIVE_LOCKED_KEY)
                : t(archived ? 'msg.items.failed_archive_item' : 'msg.items.failed_unarchive_item'));
            return false;
        }
    },

    /** Items list: show or hide archived items. */
    toggleArchived(show) {
        this.showArchived = !!show;
        this.refreshTable();
    },

    showArchived: false,

    /** Rates list order (Q48 of #111): most used first (default) or A–Z; kept on this phone. */
    sortAz: (() => { try { return localStorage.getItem(SORT_KEY) === 'az'; } catch (_) { return false; } })(),

    setSortAz(on) {
        this.sortAz = !!on;
        safeSetItem(SORT_KEY, this.sortAz ? 'az' : 'used');
        this.refreshTable();
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
        const errorList = plan.errors.slice(0, 20).map(er => `<li>${e(t('ui.items.import_row', { row: er.rowNumber }))}: ${e(er.reason)}</li>`).join('');
        const more = plan.errors.length > 20 ? `<li>… ${e(t('ui.items.import_more', { count: plan.errors.length - 20 }))}</li>` : '';
        return `
            <div class="rates-dlg">
                <div class="rates-dlg-line">${icon('refresh', 'i-sm')}<span>${e(t('ui.items.import_update'))}: <strong>${e(plan.updates.length)}</strong></span></div>
                <div class="rates-dlg-line">${icon('plus', 'i-sm')}<span>${e(t('ui.items.import_new'))}: <strong>${e(plan.adds.length)}</strong></span></div>
                <div class="rates-dlg-line">${icon('check', 'i-sm')}<span>${e(t('ui.items.import_unchanged'))}: <strong>${e(plan.unchanged.length)}</strong></span></div>
                <div class="rates-dlg-line">${icon('triangle', 'i-sm')}<span>${e(t('ui.items.import_errors'))}: <strong>${e(plan.errors.length)}</strong></span></div>
                ${plan.skipped ? `<div>${e(t('ui.items.import_skipped'))}: ${e(plan.skipped)}</div>` : ''}
                ${errorList ? `<ul class="rates-dlg-list tone-neg">${errorList}${more}</ul>` : ''}
                <p class="rates-dlg-note">${e(t('ui.items.import_kept_note'))}</p>
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
        let filteredItems = visibleItems(AppState.items, { showArchived: this.showArchived });
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            filteredItems = filteredItems.filter(item => {
                const name = (item.name || '').toLowerCase();
                const hindiName = (item.hindiName || '').toLowerCase();
                return name.includes(query) || hindiName.includes(query);
            });
        }
        
        // Most used first, then alphabetically; or A–Z by the name shown (Q48)
        const shownName = (i) => ((AppState.settings.showHindi && i.hindiName) ? i.hindiName : i.name);
        const sortedItems = this.sortAz ? sortItemsByName(filteredItems, shownName) : sortItemsByUsage(filteredItems, frequency);
        const sortBox = document.getElementById('itemsSortAz');
        if (sortBox) sortBox.checked = this.sortAz;
        
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
                    avgRate = formatRate(stockEntry.rate);
                }
            }
            
            const archivedChip = isArchivedItem(item)
                ? ` <span class="tag item-archived-chip">${Helpers.escapeHtml(t('ui.items.archived_chip'))}</span>` : '';
            const row = document.createElement('tr');
            
            if (!isStaff) {
                row.className = 'is-clickable';
                row.onclick = () => this.openEditModal(item.id);
            }
            
            // Staff view: show item name, purchase rates, and retail sale rates
            // Non-staff view: show item name, purchase rates, sale rates, wholesale rates
            row.innerHTML = `
                    <td class="rates-name">
                        ${Helpers.escapeHtml(displayName || item.name || '-')}${archivedChip}
                    </td>
                    <td data-perm="purchaseRates" class="rates-figs">${Helpers.escapeHtml(purchaseRates)}</td>
                    <td class="rates-figs">${Helpers.escapeHtml(saleRates)}</td>${isStaff ? '' : `
                    <td class="wholesale-column rates-figs">${Helpers.escapeHtml(wholesaleRates)}</td>`}
                `;
            tbody.appendChild(row);
        });
        
        if (sortedItems.length === 0) {
            const colspan = isStaff ? '3' : '4';
            tbody.innerHTML = `<tr><td colspan="${colspan}">${emptyState({ icon: 'search', title: t('ui.stock.no_items_found') })}</td></tr>`;
        }
        attachScrollCue(document.getElementById('itemsTableScroll'));
    },
    
    /** Name fields of the dialog (#134): typed by the user / holding a suggestion. */
    nameFill: { name: { typed: false, suggested: false }, hindiName: { typed: false, suggested: false } },

    /** @private */
    nameInput(field) {
        return document.getElementById(field === 'name' ? 'itemModalName' : 'itemModalHindiName');
    },

    /** @private Resets the suggestion state; a saved name counts as typed. */
    resetNameFill(item) {
        ['name', 'hindiName'].forEach(f => {
            this.nameFill[f] = { typed: !!(item && String(item[f] || '').trim()), suggested: false };
            this.nameInput(f)?.classList.remove('autofill-suggest');
        });
    },

    /**
     * Typing an item name suggests the other language's name (offline, #134).
     * The other field is filled only while empty or holding a suggestion,
     * never over a value the user typed.
     * @param {'name'|'hindiName'} field
     */
    onModalNameInput(field) {
        const other = field === 'name' ? 'hindiName' : 'name';
        const input = this.nameInput(field);
        const otherInput = this.nameInput(other);
        if (!input || !otherInput) return;
        input.classList.remove('autofill-suggest');
        this.nameFill[field] = { typed: !!input.value.trim(), suggested: false };
        const suggestion = field === 'name' ? suggestHindiName(input.value) : suggestEnglishName(input.value);
        const next = autofillValue({ ...this.nameFill[other], value: otherInput.value }, suggestion);
        if (next === null) return;
        otherInput.value = next;
        this.nameFill[other].suggested = !!next;
        otherInput.classList.toggle('autofill-suggest', !!next);
    },

    /**
     * Tapping into a suggested name keeps it as the user's own.
     * @param {'name'|'hindiName'} field
     */
    acceptNameSuggestion(field) {
        if (!this.nameFill[field]?.suggested) return;
        this.nameFill[field] = { typed: true, suggested: false };
        this.nameInput(field)?.classList.remove('autofill-suggest');
    },

    // Open modal to add new item
    openAddModal() {
        this.currentEditingItemId = null;
        this.modalRates = { purchase: [], wholesale: [], sale: [] };
        
        document.getElementById('itemModalName').value = '';
        document.getElementById('itemModalHindiName').value = '';
        document.getElementById('itemModalContactPerson').value = '';
        document.getElementById('itemModalArchiveBtn').style.display = 'none';
        this.setModalTitle('ui.items.dialog_add_title');
        this.resetNameFill(null);
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
        this.setModalTitle('ui.items.dialog_edit_title');
        this.resetNameFill(item);
        const archiveBtn = document.getElementById('itemModalArchiveBtn');
        archiveBtn.style.display = canArchiveItem(AppState.userRole) ? 'block' : 'none';
        archiveBtn.textContent = t(isArchivedItem(item) ? 'ui.items.unarchive_item' : 'ui.items.archive_item');
        
        this.modalRates = {
            purchase: [...(item.rates || [])],
            wholesale: [...(item.wholesaleRates || [])],
            sale: [...(item.saleRates || [])]
        };
        // Values at edit start; history is diffed against these once on save
        this.editStartSnapshot = snapshotItem(item);
        // Its version when opened: saving over a newer one from another phone is refused (#113)
        this.editStartRev = Number(item.rev) || 0;
        this.resetModalHistory(this.canUseHistory());
        
        this.renderModalRates();
        document.getElementById('itemEditOverlay').style.display = 'flex';
    },

    /**
     * Item dialog title: "Add rate" or "Edit rate"; kept through a language change.
     * @param {string} key
     */
    setModalTitle(key) {
        const title = document.getElementById('itemModalTitle');
        if (!title) return;
        title.setAttribute('data-i18n', key);
        title.textContent = t(key);
    },

    /**
     * Shows/hides the "Change history" block and clears loaded entries.
     * @param {boolean} visible
     */
    resetModalHistory(visible) {
        const section = document.getElementById('itemModalHistorySection');
        if (section) section.style.display = visible ? '' : 'none';
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
        list.innerHTML = `<p class="rates-dlg-note">${Helpers.escapeHtml(t('ui.rate_history.loading'))}</p>`;
        try {
            const entries = await FirebaseService.loadRateHistory(id);
            if (this.currentEditingItemId !== id) return;
            const btn = document.getElementById('itemModalHistoryBtn');
            if (btn) btn.style.display = 'none';
            list.innerHTML = this.historyListHtml(entries);
        } catch (error) {
            console.error('Error loading rate history:', error);
            list.innerHTML = `<p class="rates-dlg-note tone-neg">${Helpers.escapeHtml(t('ui.rate_history.load_failed'))}</p>`;
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
            return `<p class="rates-dlg-note">${e(t('ui.rate_history.no_changes'))}</p>`;
        }
        return entries.map(h => {
            const flags = Array.isArray(h.flags) ? h.flags : [];
            const flagText = [
                flags.includes('out-of-band') ? t('ui.rate_history.flag_big', { factor: RATE_SANITY_FACTOR }) : '',
                flags.includes('quick-repeat') ? t('ui.rate_history.flag_repeat') : ''
            ].filter(Boolean).join(' · ');
            return `
                <div class="rate-history-row">
                    <div><strong>${e(fieldLabel(h.field))}</strong>: ${e(formatHistoryValue(h.field, h.old))} → ${e(formatHistoryValue(h.field, h.new))}</div>
                    <div class="tone-muted">${e(formatDateTimeIN(h.at))}${h.by ? ` • ${e(h.by)}` : ''}</div>
                    ${flagText ? `<div class="tone-warn">${e(flagText)}</div>` : ''}
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
            parts.push(`<p><strong>${e(t('ui.rate_history.rename'))}</strong></p><ul class="rates-dlg-list">${rename.map(c =>
                `<li>${e(c.old)} → ${e(c.new || '—')}</li>`).join('')}</ul>
                <p class="rates-dlg-note">${e(t('ui.rate_history.rename_note'))}</p>`);
        }
        if (outOfBand.length) {
            parts.push(`<p><strong>${e(t('ui.rate_history.big_change', { factor: RATE_SANITY_FACTOR }))}</strong></p><ul class="rates-dlg-list">${outOfBand.map(c =>
                `<li>${e(fieldLabel(c.field))}: ${rateHtml(c.old)} → ${rateHtml(c.new)}</li>`).join('')}</ul>
                <p class="rates-dlg-note">${e(t('ui.rate_history.check_rate'))}</p>`);
        }
        return UIManager.showModalWithHtml(`<div class="rates-dlg">${parts.join('')}</div>`, t('msg.items.confirm_changes'), true);
    },
    
    // Render rates in modal
    renderModalRates() {
        // Render purchase rates
        const purchaseContainer = document.getElementById('itemModalPurchaseRates');
        purchaseContainer.innerHTML = this.modalRates.purchase.map((rate, idx) => `
            <div class="rate-group">
                <input type="number" class="rate-input purchase" 
                       value="${Helpers.escapeHtml(rate)}" 
                       data-oninput="items.updateModalRate('purchase', ${idx}, this.value)"
                       placeholder="${Helpers.escapeHtml(t('ui.common.rate'))}">
                <button class="delete-rate" data-onclick="items.deleteModalRate('purchase', ${idx})">×</button>
            </div>
        `).join('');
        
        // Render wholesale rates
        const wholesaleContainer = document.getElementById('itemModalWholesaleRates');
        wholesaleContainer.innerHTML = this.modalRates.wholesale.map((rate, idx) => `
            <div class="rate-group">
                <input type="number" class="rate-input wholesale" 
                       value="${Helpers.escapeHtml(rate)}" 
                       data-oninput="items.updateModalRate('wholesale', ${idx}, this.value)"
                       placeholder="${Helpers.escapeHtml(t('ui.common.rate'))}">
                <button class="delete-rate" data-onclick="items.deleteModalRate('wholesale', ${idx})">×</button>
            </div>
        `).join('');
        
        // Render sale rates
        const saleContainer = document.getElementById('itemModalSaleRates');
        saleContainer.innerHTML = this.modalRates.sale.map((rate, idx) => `
            <div class="rate-group">
                <input type="number" class="rate-input sale" 
                       value="${Helpers.escapeHtml(rate)}" 
                       data-oninput="items.updateModalRate('sale', ${idx}, this.value)"
                       placeholder="${Helpers.escapeHtml(t('ui.common.rate'))}">
                <button class="delete-rate" data-onclick="items.deleteModalRate('sale', ${idx})">×</button>
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
            UIManager.showToast(duplicateItemMessage(dup.name, dup.item));
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
        
        // Item writes need the internet (#113, #143): an offline save would land later over newer changes
        if (isOffline()) {
            UIManager.showToast(t('msg.items.needs_internet'), 4000);
            return;
        }
        UIManager.showLoading();
        
        try {
            if (existing) {
                // Keep fields this dialog doesn't edit; write by id, never by list position
                const updated = { ...existing, ...itemData, id: editingId };
                await FirebaseService.saveItem(updated, { expectedRev: this.editStartRev });
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
                AuditService.note(AuditService.ACTIONS.CREATE_ITEM, { itemId: savedItem.id || null, itemName: savedItem.name || '', source: 'modal' });
                UIManager.showToast(t('msg.items.item_added'));
                this.notifyItemAdded(savedItem);
            }
            
            this.closeItemModal();
            this.refreshTable();
            UIManager.hideLoading();
        } catch (error) {
            console.error('Error saving item:', error);
            UIManager.hideLoading();
            const messageKey = error?.code === CHANGED_ELSEWHERE ? 'msg.items.changed_elsewhere' : writeErrorKey(error, 'msg.items.failed_save_item');
            UIManager.showToast(t(messageKey), 5000);
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

    /** Archive (or unarchive) button in the edit dialog. */
    async archiveFromModal() {
        const id = this.currentEditingItemId;
        if (id === null) return;
        const item = this.requireItem(id);
        if (!item) return;
        const done = isArchivedItem(item) ? await this.unarchiveItem(id) : await this.archiveItem(id);
        if (done) this.closeItemModal();
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

// Data changes re-render this page (firestore-service.js emits, utils/events.js).
on(REFRESH.itemsList, () => ItemsManager.renderItems());
on(REFRESH.itemsTable, () => ItemsManager.refreshTable());
