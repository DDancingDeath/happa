/**
 * @fileoverview Stock Management Module
 * Handles inventory stock tracking, calculation, and adjustments
 * Calculates stock from purchase/sale history and displays current levels
 * @module modules/stock
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { Helpers } from '../utils/helpers.js';
import { attachOlderHistoryScroll } from '../ui/infinite-scroll.js';
import { isFullHistoryLoaded, historyLoadedFrom, formatWindowDate } from '../utils/history-window.js';
import { planStockAdjustment } from '../utils/stock-adjust.js';
import { approxStockNote } from '../utils/stock-check.js';
import { evaluateStockAdjustment, toFlags } from '../utils/bill-checks.js';
import { findDeadStock, daysSinceLabel, localDaysBetween, DEAD_STOCK_DAY_OPTIONS, DEFAULT_DEAD_STOCK_DAYS } from '../utils/dead-stock.js';
import { t } from '../i18n/index.js';
import { can } from '../utils/role-access.js';

const DEAD_STOCK_DAYS_KEY = 'aadhat.deadStockDays';

const STOCK_UPDATING_HTML = '<p class="stock-updating" style="text-align: center; color: #888; margin-top: 40px;">Stock updating… / स्टॉक अपडेट हो रहा है…</p>';

/**
 * Banner for approximate stock (member device, stale checkpoint; #129).
 * @param {?{builtAt: number}} approx AppState.stockApprox
 * @returns {string} HTML, '' when stock is exact
 */
export function stockApproxNoteHtml(approx) {
    const note = approxStockNote(approx);
    if (!note) return '';
    return `<p class="stock-approx" style="background: #fff8e1; color: #8a6d00; border-radius: 6px; padding: 8px 10px; font-size: 13px; margin: 0 0 8px;">${Helpers.escapeHtml(note.en)} — exact once the owner or a manager opens the app.<br>${Helpers.escapeHtml(note.hi)} — मालिक या मैनेजर के ऐप खोलने पर सही होगा।</p>`;
}

/**
 * Stock Manager - Manages inventory stock operations
 * @class StockManager
 */
export class StockManager {
    /**
     * Update stock for a specific item
     * Adds quantity to existing stock or creates new entry
     * @param {string} itemName - Name of the item
     * @param {number} quantity - Quantity to add (can be negative)
     * @param {number} [rate] - Optional rate per kg
     */
    static updateStock(itemName, quantity, rate) {
        if (!AppState.stock[itemName]) {
            AppState.stock[itemName] = { quantity: 0, rate: rate || 0 };
        }
        AppState.stock[itemName].quantity += quantity;
        if (rate) {
            AppState.stock[itemName].rate = rate;
        }
    }

    /**
     * Render current stock levels with loading indicator
     * Calculates stock from Firebase and displays in the UI
     * @async
     * @returns {Promise<void>}
     */
    static async renderStock() {
        const container = document.getElementById("stockList");
        if (!container) return;

        // Hide adjustment tab for staff
        this.hideAdjustmentTabForStaff();

        try {
            // Reuse the stock computed by the data listeners when it is still
            // current; only recalculate when the underlying data changed.
            // While stock is computed from full history in the background, show a
            // placeholder instead of blocking the whole app.
            let stock;
            if (AppState.stockReady === false) {
                container.innerHTML = STOCK_UPDATING_HTML;
                stock = await FirebaseService.getStock();
            } else {
                stock = await UIManager.withLoading(async () => {
                    return await FirebaseService.getStock();
                });
            }
            AppState.stock = stock;

            // Still waiting (e.g. another device is rebuilding the stock checkpoint, #194):
            // the numbers are not current yet; the data listeners re-render once they are.
            if (AppState.stockReady === false) {
                container.innerHTML = STOCK_UPDATING_HTML;
                return;
            }

            if (Object.keys(stock).length === 0) {
                container.innerHTML = '<p style="text-align: center; color: #888; margin-top: 40px;">No stock data available</p>';
                return;
            }

            container.innerHTML = "";

            // Consolidate stock by itemId to prevent duplicates.
            //
            // Buckets may be keyed by either a real catalogue id or a legacy
            // name-based fallback (now normalized lower-case/trimmed by
            // FirebaseService.getItemKey). We match each bucket back to the
            // catalogue using the same normalization so that "Piyar Dana" and
            // "piyar dana" collapse to one row.
            //
            // Buckets with no catalogue match are NOT silently dropped — they
            // surface as their own row tagged "Unmatched" so the user can spot
            // data discrepancies (e.g. a sale stored under a deleted item, or
            // a name typo) instead of seeing wrong totals.
            const normalize = (s) => (s == null ? '' : String(s).trim().toLowerCase());
            // Index the catalogue once; a key resolves to the first item (in
            // array order) whose id equals the key or whose normalized
            // name/hindiName equals the normalized key — same as the former
            // per-key AppState.items.find().
            const indexById = new Map();
            const indexByName = new Map();
            AppState.items.forEach((i, idx) => {
                if (!indexById.has(i.id)) indexById.set(i.id, idx);
                const n = normalize(i.name);
                if (!indexByName.has(n)) indexByName.set(n, idx);
                const h = normalize(i.hindiName);
                if (!indexByName.has(h)) indexByName.set(h, idx);
            });
            const findCatalogueItem = (key) => {
                const byId = indexById.has(key) ? indexById.get(key) : Infinity;
                const nk = normalize(key);
                const byName = indexByName.has(nk) ? indexByName.get(nk) : Infinity;
                const idx = Math.min(byId, byName);
                return idx === Infinity ? undefined : AppState.items[idx];
            };
            const consolidatedStock = {};
            const orphanKeys = [];
            Object.keys(stock).forEach(key => {
                const item = findCatalogueItem(key);

                if (!item) {
                    // Orphan: render under its raw key so the data stays visible.
                    if (!consolidatedStock[`__orphan__${key}`]) {
                        consolidatedStock[`__orphan__${key}`] = {
                            itemId: `__orphan__${key}`,
                            name: key,
                            hindiName: '',
                            quantity: 0,
                            totalValue: 0,
                            rate: 0,
                            isOrphan: true
                        };
                    }
                    consolidatedStock[`__orphan__${key}`].quantity += stock[key].quantity || 0;
                    consolidatedStock[`__orphan__${key}`].totalValue += (stock[key].quantity || 0) * (stock[key].rate || 0);
                    orphanKeys.push(key);
                    return;
                }

                const itemId = item.id;
                if (!consolidatedStock[itemId]) {
                    consolidatedStock[itemId] = {
                        itemId: item.id,
                        name: item.name,
                        hindiName: item.hindiName,
                        quantity: 0,
                        totalValue: 0,
                        rate: 0
                    };
                }

                consolidatedStock[itemId].quantity += stock[key].quantity || 0;
                consolidatedStock[itemId].totalValue += (stock[key].quantity || 0) * (stock[key].rate || 0);
            });

            if (orphanKeys.length > 0) {
                console.warn(
                    `[StockManager] ${orphanKeys.length} stock bucket(s) had no matching catalogue item ` +
                    `and were rendered as "Unmatched" rows:`,
                    orphanKeys
                );
            }
        
        // Calculate weighted average rates
        Object.values(consolidatedStock).forEach(item => {
            if (item.quantity > 0 && item.totalValue > 0) {
                item.rate = item.totalValue / item.quantity;
            }
            delete item.totalValue;
        });

        // Filter and sort.
        //
        // Real catalogue rows are hidden when quantity rounds to 0 kg (the
        // historical behavior). Orphan rows are kept whenever they carry any
        // non-zero quantity — including negative ones — because that's exactly
        // the case the user needs to see: a sale recorded under a different
        // name/id than the catalogue knows about.
        const stockWithDetails = Object.values(consolidatedStock)
            .filter(item => item.isOrphan ? Math.abs(item.quantity) > 0.001 : item.quantity > 0)
            .sort((a, b) => {
                if (a.isOrphan !== b.isOrphan) return a.isOrphan ? 1 : -1;
                return a.name.localeCompare(b.name);
            });
        
        if (stockWithDetails.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #888; margin-top: 40px;">No stock available</p>';
            return;
        }
        
        // Check if user is staff (show limited quantity info for items > 100kg)
        const isStaff = AppState.userRole === 'staff';

        const approxNote = stockApproxNoteHtml(AppState.stockApprox);
        if (approxNote) container.insertAdjacentHTML('beforeend', approxNote);
        
        stockWithDetails.forEach(item => {
            const displayName = (AppState.settings.showHindi && item.hindiName) ? item.hindiName : item.name;
            const div = document.createElement("div");
            div.className = "stock-item";

            if (item.isOrphan) {
                // Orphan rows: highlight in red so the user can spot the
                // discrepancy. Always shown to all users (including staff)
                // because they signal a data integrity issue.
                const qtyColor = item.quantity < 0 ? '#dc3545' : '#f0ad4e';
                div.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center; border-left: 3px solid ${qtyColor}; padding-left: 8px;">
                        <div>
                            <div style="font-weight: 600; font-size: 15px;">${Helpers.escapeHtml(displayName)}</div>
                            <div style="color: ${qtyColor}; font-size: 12px; margin-top: 4px;">
                                ⚠ Unmatched — no catalogue item with this id/name
                            </div>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: 18px; font-weight: 700; color: ${qtyColor};">
                                ${item.quantity.toFixed(1)} kg
                            </div>
                            <div data-perm="profit" style="color: #666; font-size: 12px; margin-top: 4px;">
                                Rate: ₹${item.rate ? item.rate.toFixed(2) : '0.00'}/kg
                            </div>
                        </div>
                    </div>
                `;
                container.appendChild(div);
                return;
            }

            // For staff: show "Available" if quantity > 100, otherwise show actual quantity
            // Rate is always shown, value is hidden when showing "Available"
            const showLimitedQty = isStaff && item.quantity > 100;
            const quantityDisplay = showLimitedQty ? 'Available' : `${item.quantity.toFixed(1)} kg`;
            const valueDisplay = showLimitedQty ? '' : `<div data-perm="stockValue" style="color: #666; font-size: 12px; margin-top: 4px;">≈ ₹${Math.round(item.quantity * (item.rate || 0))}</div>`;
            
            div.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-weight: 600; font-size: 15px;">${Helpers.escapeHtml(displayName)}</div>
                        <div data-perm="profit" style="color: #666; font-size: 13px; margin-top: 4px;">
                            Rate: ₹${item.rate ? item.rate.toFixed(2) : '0.00'}/kg
                        </div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 18px; font-weight: 700; color: #28a745;">
                            ${quantityDisplay}
                        </div>
                        ${valueDisplay}
                    </div>
                </div>
            `;
            
            container.appendChild(div);
            });
        } catch (error) {
            console.error('Error loading stock:', error);
            container.innerHTML = '<p style="text-align: center; color: #dc3545; margin-top: 40px;">Failed to load stock data</p>';
        }
    }

    /**
     * Search and filter stock items by name
     * Hides non-matching items and shows "no results" message
     */
    static searchStock() {
        const searchInput = document.getElementById("stockSearchInput");
        const searchTerm = searchInput?.value.toLowerCase().trim() || '';
        const container = document.getElementById("stockList");
        
        if (!container) return;
        
        // Get all stock items
        const stockItems = container.querySelectorAll('.stock-item');
        
        if (stockItems.length === 0) {
            // No items rendered yet, render first
            this.renderStock();
            return;
        }
        
        let visibleCount = 0;
        
        stockItems.forEach(item => {
            const itemText = item.textContent.toLowerCase();
            if (itemText.includes(searchTerm)) {
                item.style.display = '';
                visibleCount++;
            } else {
                item.style.display = 'none';
            }
        });
        
        // Show "no results" message if nothing matches
        let noResultsMsg = container.querySelector('.no-results-message');
        if (visibleCount === 0 && searchTerm !== '') {
            if (!noResultsMsg) {
                noResultsMsg = document.createElement('p');
                noResultsMsg.className = 'no-results-message';
                noResultsMsg.style.cssText = 'text-align: center; color: #888; margin-top: 40px;';
                noResultsMsg.textContent = 'No items found';
                container.appendChild(noResultsMsg);
            }
        } else if (noResultsMsg) {
            noResultsMsg.remove();
        }
    }

    /**
     * Filter between stock view tabs (current stock vs adjustments)
     * Staff cannot access adjustment section
     * @param {'current'|'adjustment'} section - Section to display
     * @param {Event} [event] - Optional click event for button styling
     */
    static filterStockTab(section, event) {
        // Staff cannot access adjustment section
        if (section === 'adjustment' && AppState.userRole === 'staff') {
            UIManager.showToast(t('msg.stock.do_not_have_permission_access'));
            return;
        }
        if (section === 'dead' && !this.canSeeDeadStock()) {
            UIManager.showToast(t('msg.stock.only_owner_or_manager_can'));
            return;
        }
        
        const sections = {
            current: document.getElementById("currentStockSection"),
            adjustment: document.getElementById("stockAdjustmentSection"),
            dead: document.getElementById("deadStockSection")
        };

        Object.values(sections).forEach(s => s && (s.style.display = 'none'));
        if (sections[section]) sections[section].style.display = 'block';

        document.querySelectorAll('#stock .filter-btn').forEach(btn => btn.classList.remove('active'));
        if (event?.target) {
            event.target.classList.add('active');
        } else {
            // If no event (programmatic call), set the active button based on section
            const btnIndex = { current: 0, adjustment: 1, dead: 2 }[section] ?? 0;
            const buttons = document.querySelectorAll('#stock .filter-btn');
            if (buttons[btnIndex]) buttons[btnIndex].classList.add('active');
        }

        if (section === 'current') {
            this.renderStock();
        } else if (section === 'adjustment') {
            this.loadAdjustItemsDropdown();
            this.renderAdjustmentHistory();
        } else if (section === 'dead') {
            this.renderDeadStock();
        }
    }

    /**
     * Dead stock shows stock ₹ value and average cost: owner/manager, and only
     * when Roles & access (#84) leaves both on for the role.
     * @returns {boolean}
     */
    static canSeeDeadStock() {
        const raw = AppState.settings?.roleAccess;
        return ['owner', 'manager'].includes(AppState.userRole)
            && can(AppState.userRole, 'profit', raw) && can(AppState.userRole, 'stockValue', raw);
    }

    /** Selected "no sale in N days" threshold (remembered on this device). */
    static getDeadStockDays() {
        let saved = NaN;
        try { saved = Number(localStorage.getItem(DEAD_STOCK_DAYS_KEY)); } catch (_) { /* storage blocked */ }
        return DEAD_STOCK_DAY_OPTIONS.includes(saved) ? saved : DEFAULT_DEAD_STOCK_DAYS;
    }

    static setDeadStockDays(days) {
        const n = Number(days);
        if (!DEAD_STOCK_DAY_OPTIONS.includes(n)) return;
        try { localStorage.setItem(DEAD_STOCK_DAYS_KEY, String(n)); } catch (_) { /* storage blocked */ }
        this.renderDeadStock();
    }

    /**
     * Renders items with stock but no sale in the selected number of days,
     * from the already loaded bills only (no extra history reads).
     * @returns {Promise<void>}
     */
    static async renderDeadStock() {
        const container = document.getElementById('deadStockList');
        const summary = document.getElementById('deadStockSummary');
        if (!container) return;
        if (!this.canSeeDeadStock()) {
            container.innerHTML = '';
            if (summary) summary.textContent = '';
            return;
        }
        const minDays = this.getDeadStockDays();
        const select = document.getElementById('deadStockDays');
        if (select) select.value = String(minDays);

        try {
            const stock = await FirebaseService.getStock();
            AppState.stock = stock;
            const now = Date.now();
            const windowStart = isFullHistoryLoaded() ? 0 : historyLoadedFrom();
            const rows = findDeadStock({
                stock,
                items: AppState.items,
                sources: {
                    purchases: AppState.purchaseHistory,
                    wholesaleSales: AppState.salesHistory,
                    retailSales: AppState.retailSalesHistory
                },
                now,
                minDays,
                windowStart
            });
            const windowDays = windowStart > 0 ? localDaysBetween(windowStart, now) : Infinity;
            const e = (v) => Helpers.escapeHtml(v);
            const totalValue = rows.reduce((s, r) => s + r.value, 0);

            if (summary) {
                const windowNote = windowStart > 0
                    ? `Using bills since ${formatWindowDate(windowStart)} (${windowDays} days). "> ${windowDays} days" = no sale in that time. / ${formatWindowDate(windowStart)} से बिल देखे गए।`
                    : 'Using all bills. / सभी बिल देखे गए।';
                summary.innerHTML = rows.length
                    ? `<strong>${e(rows.length)}</strong> items · ≈ ₹${e(Math.round(totalValue).toLocaleString('en-IN'))} in stock<br>${e(windowNote)}`
                    : e(windowNote);
            }

            if (rows.length === 0) {
                container.innerHTML = `<p style="text-align: center; color: #888; margin-top: 30px;">Every item in stock sold in the last ${e(minDays)} days 👍<br>पिछले ${e(minDays)} दिनों में स्टॉक का हर आइटम बिका है</p>`;
                return;
            }

            container.innerHTML = rows.map(r => {
                const displayName = (AppState.settings.showHindi && r.hindiName) ? r.hindiName : r.name;
                const sale = daysSinceLabel(r.daysSinceSale, r.saleBeyondWindow, windowDays);
                const purchase = daysSinceLabel(r.daysSincePurchase, r.purchaseBeyondWindow, windowDays);
                return `
                <div class="stock-item dead-stock-item">
                    <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                        <div>
                            <div style="font-weight: 600; font-size: 15px;">${e(displayName || r.name || '-')}</div>
                            <div style="color: #b45309; font-size: 13px; margin-top: 4px;">Last sale / आखिरी बिक्री: ${e(sale)}${r.uncertain ? ' *' : ''}</div>
                            <div style="color: #666; font-size: 12px; margin-top: 2px;">Last purchase / आखिरी खरीद: ${e(purchase)}</div>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: 18px; font-weight: 700; color: #dc3545;">${e(r.quantity.toFixed(1))} kg</div>
                            <div style="color: #666; font-size: 12px; margin-top: 4px;">≈ ₹${e(Math.round(r.value).toLocaleString('en-IN'))}</div>
                            <div style="color: #888; font-size: 12px;">avg ₹${e(r.rate.toFixed(2))}/kg</div>
                        </div>
                    </div>
                </div>`;
            }).join('') + (rows.some(r => r.uncertain)
                ? `<p style="font-size: 12px; color: #888; margin-top: 8px;">* Loaded bills cover only ${e(windowDays)} days, so a sale up to ${e(minDays)} days ago may not be counted. / * केवल ${e(windowDays)} दिनों के बिल लोड हैं।</p>`
                : '');
        } catch (error) {
            console.error('Error loading dead stock:', error);
            container.innerHTML = '<p style="text-align: center; color: #dc3545; margin-top: 30px;">Failed to load / लोड नहीं हुआ</p>';
        }
    }

    /**
     * Hide stock adjustment tab for staff users
     * Called when stock page is loaded
     */
    static hideAdjustmentTabForStaff() {
        const deadBtn = document.getElementById('deadStockTabBtn');
        if (deadBtn) deadBtn.style.display = this.canSeeDeadStock() ? '' : 'none';
        if (AppState.userRole === 'staff') {
            // Hide the Stock Adjustment button
            const filterButtons = document.querySelectorAll('#stock .filter-btn');
            if (filterButtons.length > 1) {
                filterButtons[1].style.display = 'none';
            }
        }
    }

    /**
     * Load items into the stock adjustment dropdown
     * Populates select element with all inventory items
     */
    static loadAdjustItemsDropdown() {
        const select = document.getElementById("adjustItem");
        if (!select) return;

        select.innerHTML = '<option value="">Select item</option>';
        AppState.items.forEach(item => {
            const option = document.createElement("option");
            option.value = item.id;
            const displayName = (AppState.settings.showHindi && item.hindiName) ? item.hindiName : item.name;
            option.textContent = displayName;
            select.appendChild(option);
        });
    }

    static loadAdjustItemStock() {
        const itemId = document.getElementById("adjustItem")?.value;
        const display = document.getElementById("currentStockDisplay");
        const avgRateDisplay = document.getElementById("avgRateDisplay");
        const avgRateValue = document.getElementById("avgRateValue");
        
        if (!display) return;

        if (!itemId) {
            display.textContent = "";
            if (avgRateDisplay) avgRateDisplay.style.display = "none";
            return;
        }

        const item = AppState.items.find(i => i.id === itemId);
        if (!item) {
            display.textContent = "0.00";
            if (avgRateDisplay) avgRateDisplay.style.display = "none";
            return;
        }

        // Stock is keyed by catalogue id: the replay resolves legacy name-only
        // lines to the id, so a name lookup would only find stale entries.
        const stockData = AppState.stock[item.id] || {};
        const quantity = stockData.quantity || 0;
        const totalValue = quantity * (stockData.rate || 0);
        display.textContent = quantity.toFixed(1);
        
        // Calculate and display average rate
        if (avgRateDisplay && avgRateValue) {
            if (quantity > 0 && totalValue > 0) {
                const avgRate = totalValue / quantity;
                avgRateValue.textContent = `₹${avgRate.toFixed(2)}/kg`;
                avgRateDisplay.style.display = "block";
            } else {
                avgRateDisplay.style.display = "none";
            }
        }
    }

    static updateAdjustmentPlaceholder() {
        const adjustType = document.getElementById("adjustType")?.value;
        const quantityInput = document.getElementById("adjustQuantity");
        
        if (!quantityInput) return;
        
        switch (adjustType) {
            case 'add':
                quantityInput.placeholder = 'Quantity to add';
                break;
            case 'remove':
                quantityInput.placeholder = 'Quantity to remove';
                break;
            case 'set':
                quantityInput.placeholder = 'New stock quantity';
                break;
        }
    }

    static async applyStockAdjustment() {
        const itemId = Helpers.getInputText('adjustItem');
        const adjustType = Helpers.getInputText('adjustType');
        // NaN when blank, so an empty box can't become "set stock to 0"
        const quantity = Helpers.getInputNumber('adjustQuantity', NaN);
        const rate = Helpers.getInputNumber('adjustRate');
        const reasonCode = Helpers.getInputText('adjustReasonCode');
        const reasonNote = Helpers.getInputText('adjustReason');

        const item = itemId ? AppState.items.find(i => i.id === itemId) : null;
        if (!item) {
            UIManager.showToast(t('msg.common.select_item'));
            return;
        }
        const itemName = item.name;

        const currentStock = AppState.stock[item.id]?.quantity || 0;
        const plan = planStockAdjustment({ adjustType, quantity, currentStock, reasonCode, reasonNote });
        if (!plan.ok) {
            UIManager.showToast(plan.error);
            return;
        }
        if (plan.capped) {
            const ok = await UIManager.showModal(
                t('msg.stock.only_kg_in_stock_remove', { quantity: plan.quantity }),
                t('msg.stock.remove_more_than_stock'),
                true
            );
            if (!ok) return;
        }
        const newStock = plan.newStock;
        const reason = plan.reason;

        const adjustment = {
            itemId: item.id,
            itemName,
            adjustType,
            quantity: plan.quantity,
            rawQuantity: plan.rawQuantity,
            rate: rate || 0,
            previousStock: currentStock,
            newStock,
            reason,
            reasonCode,
            date: Helpers.getCurrentDateTime(),
            timestamp: Date.now(),
            createdBy: AppState.currentUser?.uid || 'unknown',
            createdByName: AppState.userName || 'User'
        };
        // Q17 (#37): a large adjustment is saved with a flag for review
        const adjustFlags = toFlags(evaluateStockAdjustment(newStock - currentStock, AppState.settings?.checkThresholds),
            adjustment.createdBy, adjustment.timestamp);
        if (adjustFlags.length) adjustment.flags = adjustFlags;

        try {
            await FirebaseService.saveStockAdjustment(adjustment);
            
            if (!AppState.stock[item.id]) {
                AppState.stock[item.id] = { quantity: 0, rate: 0 };
            }
            AppState.stock[item.id].quantity = newStock;

            document.getElementById("adjustQuantity").value = "";
            document.getElementById("adjustRate").value = "0";
            document.getElementById("adjustReason").value = "";
            const reasonSelect = document.getElementById("adjustReasonCode");
            if (reasonSelect) reasonSelect.value = "";
            
            // Recalculate stock from Firebase data to ensure accuracy
            const freshStock = await FirebaseService.calculateStock();
            AppState.stock = freshStock;
            
            UIManager.showToast(t('msg.stock.stock_adjustment_applied_successfully'));
            this.renderAdjustmentHistory();
            this.loadAdjustItemStock();
            
            // Keep the Current Stock list in step with the adjustment
            if (document.getElementById('currentStockSection')) {
                this.renderStock();
            }
        } catch (error) {
            console.error("Stock adjustment error:", error);
            UIManager.showToast(t('msg.stock.failed_apply_adjustment'));
        }
    }

    static async renderAdjustmentHistory() {
        const container = document.getElementById("adjustmentHistory");
        if (!container) return;

        try {
            // Kept current by the real-time listener; no need to re-read the
            // whole collection on every render.
            const adjustments = [...(AppState.stockAdjustments || [])];
            
            // Sort by timestamp/date (newest first)
            adjustments.sort((a, b) => {
                const timeA = a.timestamp || new Date(a.date).getTime();
                const timeB = b.timestamp || new Date(b.date).getTime();
                return timeB - timeA;
            });

            // Older adjustments load one month at a time as the user scrolls
            attachOlderHistoryScroll(container, { noun: 'adjustments', onLoaded: () => this.renderAdjustmentHistory() });

            if (adjustments.length === 0) {
                const message = isFullHistoryLoaded() ? 'No adjustments yet' : `No adjustments since ${formatWindowDate(historyLoadedFrom())}`;
                container.innerHTML = `<p style="text-align: center; color: #888; margin-top: 20px;">${Helpers.escapeHtml(message)}</p>`;
                return;
            }

            container.innerHTML = "";
            
            adjustments.forEach(adj => {
                const div = document.createElement("div");
                div.className = "history-item";
                
                const typeLabels = { add: 'Added', remove: 'Removed', set: 'Set to' };
                const typeColors = { add: '#28a745', remove: '#dc3545', set: '#007bff' };
                
                // Handle legacy data that might not have adjustType or quantity
                const adjustType = adj.adjustType || 'set';
                const quantity = adj.quantity !== undefined ? adj.quantity : 'Unknown';
                const typeLabel = typeLabels[adjustType] || 'Adjusted';
                const typeColor = typeColors[adjustType] || '#6c757d';
                
                // Find item to show in correct language
                const item = AppState.items.find(i => i.id === adj.itemId || i.name === adj.itemName);
                const displayName = (AppState.settings.showHindi && item?.hindiName) ? item.hindiName : (item?.name || adj.itemName || 'Unknown Item');
                
                // Use adjustment rate if available, otherwise fall back to current stock rate
                const adjustmentRate = adj.rate || 0;
                const stockKey = adj.itemId || adj.itemName;
                const currentStockRate = AppState.stock[stockKey]?.rate || 0;
                const displayRate = adjustmentRate > 0 ? adjustmentRate : currentStockRate;
                
                // Calculate value impact if rate is available
                const valueImpact = (quantity !== 'Unknown' && displayRate > 0) ? quantity * displayRate : null;
                
                div.innerHTML = `
                    <div class="history-header">
                        <strong>${Helpers.escapeHtml(displayName)}</strong>
                        <span style="color: ${typeColor}; font-weight: 600;">
                            ${typeLabel} ${quantity !== 'Unknown' ? Helpers.escapeHtml(quantity) + ' kg' : ''}
                        </span>
                    </div>
                    <div class="history-date">${Helpers.escapeHtml(adj.date || 'Unknown date')}${adj.createdByName ? ` • By: ${Helpers.escapeHtml(adj.createdByName)}` : ''}</div>
                    <div style="margin: 8px 0; padding: 8px; background: #f8f9fa; border-radius: 4px;">
                        ${displayRate > 0 ? `<div style="font-size: 13px; color: #666; margin-bottom: 4px;">Rate: ₹${displayRate.toFixed(2)}/kg${valueImpact ? ` • Value: ₹${Math.round(valueImpact)}` : ''}</div>` : ''}
                        <div style="font-size: 13px; color: #666;">
                            ${(adj.previousStock || 0).toFixed(1)} kg → ${(adj.newStock || 0).toFixed(1)} kg
                            ${Number(adj.rawQuantity) > Number(adj.quantity) ? ` (asked ${Helpers.escapeHtml(adj.rawQuantity)} kg, capped at stock)` : ''}
                        </div>
                        ${adj.reason ? `<div style="font-size: 13px; color: #666; margin-top: 4px;"><em>${Helpers.escapeHtml(adj.reason)}</em></div>` : '<div style="font-size: 13px; color: #999; margin-top: 4px;"><em>No reason provided</em></div>'}
                    </div>
                `;
                
                container.appendChild(div);
            });
        } catch (error) {
            console.error('Error loading adjustment history:', error);
            container.innerHTML = '<p style="text-align: center; color: #dc3545; margin-top: 20px;">Failed to load history</p>';
        }
    }
}
