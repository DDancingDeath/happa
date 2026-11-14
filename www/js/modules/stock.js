/**
 * @fileoverview Stock Management Module
 * Handles inventory stock tracking, calculation, and adjustments
 * Calculates stock from purchase/sale history and displays current levels
 * @module modules/stock
 */

import { AppState } from '../utils/state.js';
import { on, REFRESH } from '../utils/events.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
import { Helpers } from '../utils/helpers.js';
import { SAVED_ON_PHONE_KEY } from '../utils/storage-full.js';
import { formatAmount, formatRupees, formatRate, formatKg } from '../utils/money.js';
import { parseAnyBillDate, formatDate } from '../utils/dates.js';
import { stockRows, itemValue, stockValue, stockSummary, adjustItemStock, adjustmentValue, deadStockValue } from '../utils/calc/stock.js';
import { attachOlderHistoryScroll } from '../ui/infinite-scroll.js';
import { isFullHistoryLoaded, historyLoadedFrom, formatWindowDate } from '../utils/history-window.js';
import { planStockAdjustment, adjustReasonText, canReverseAdjustment, reversalPlan, stockCountPlan, adjustmentDelta, lastPurchaseRate, restockCost } from '../utils/stock-adjust.js';
import { approxStockNote, lowStockItems, lowStockLevel, stockedItemKeys, DEFAULT_LOW_STOCK_KG } from '../utils/stock-check.js';
import { isArchivedItem } from '../utils/item-catalog.js';
import { evaluateStockAdjustment, toFlags } from '../utils/bill-checks.js';
import { findDeadStock, daysSinceLabel, localDaysBetween, DEAD_STOCK_DAY_OPTIONS, DEFAULT_DEAD_STOCK_DAYS } from '../utils/dead-stock.js';
import { t, hasCatalogue, loadAllCatalogues } from '../i18n/index.js';

const tx = (key, params) => Helpers.escapeHtml(t(key, params));
import { pickLang } from '../i18n/localize.js';
import { can } from '../utils/role-access.js';
import { awaitingServer } from '../utils/data-freshness.js';
import { icon } from '../ui/icons.js';
import { moneyHtml, moneyInText, emptyState } from '../ui/components.js';

const stockKg = (q) => formatKg(q);

const DEAD_STOCK_DAYS_KEY = 'aadhat.deadStockDays';

/**
 * Stock not final: being worked out, or from data the server is about to confirm (#59). A count, a
 * "set to" or a reversal saved from it would store a wrong change of kg: they wait for it.
 */
const stockNotFinal = () => AppState.stockReady === false || awaitingServer();

/** A money figure (moneyHtml); its text is exactly formatRupees(amount, opts), also for a missing amount. */
const figHtml = (amount, opts) => {
    const html = moneyHtml(amount, opts);
    return html === '—' ? Helpers.escapeHtml(formatRupees(amount, opts)) : html;
};

/** Translated text holding a figure (moneyInText). */
const txMoney = (key, params, amount, opts) => moneyInText(t(key, params), amount, opts);

/** The adjustment form's average rate: shown only with a rate (style.display stays the switch others read). */
const showAvgRate = (el, on) => {
    if (!el) return;
    el.hidden = !on;
    el.style.display = on ? 'block' : 'none';
};

const stockUpdatingHtml = () => `<p class="stock-updating empty">${Helpers.escapeHtml(t('ui.stock.updating'))}</p>`;

/**
 * Banner for approximate stock (member device, stale checkpoint; #129).
 * @param {?{builtAt: number}} approx AppState.stockApprox
 * @returns {string} HTML, '' when stock is exact
 */
export function stockApproxNoteHtml(approx) {
    const note = approxStockNote(approx);
    if (!note) return '';
    return `<p class="stock-approx notice warn">${Helpers.escapeHtml(t('ui.stock.approx_note', { note: pickLang(note) }))}</p>`;
}

/**
 * Stock Manager - Manages inventory stock operations
 * @class StockManager
 */
export class StockManager {
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
                this.renderSummary(null);
                container.innerHTML = stockUpdatingHtml();
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
                this.renderSummary(null);
                container.innerHTML = stockUpdatingHtml();
                return;
            }

            if (Object.keys(stock).length === 0) {
                this.renderSummary(null);
                container.innerHTML = this.emptyStockHtml();
                return;
            }

            container.innerHTML = "";

            // Buckets keyed by a catalogue id or a legacy name collapse to one row per
            // item with a weighted average rate; buckets with no catalogue match stay
            // visible as "Unmatched" rows (utils/calc/stock.js stockRows, S1/S2).
            const { rows: stockWithDetails, orphanKeys } = stockRows(stock, AppState.items);

            if (orphanKeys.length > 0) {
                console.warn(
                    `[StockManager] ${orphanKeys.length} stock bucket(s) had no matching catalogue item ` +
                    `and were rendered as "Unmatched" rows:`,
                    orphanKeys
                );
            }
        
        if (stockWithDetails.length === 0) {
            this.renderSummary(null);
            container.innerHTML = this.emptyStockHtml();
            return;
        }
        
        // Check if user is staff (show limited quantity info for items > 100kg)
        const isStaff = AppState.userRole === 'staff';

        this.renderSummary(stockSummary(stockWithDetails), stockValue(stock), isStaff);
        const approxNote = stockApproxNoteHtml(AppState.stockApprox);
        if (approxNote) container.insertAdjacentHTML('beforeend', approxNote);
        container.insertAdjacentHTML('beforeend', this.lowStockHtml(stock, isStaff));
        const canSetAlerts = this.canManageStock();
        const list = document.createElement('div');
        list.className = 'panel stock-rows';
        container.appendChild(list);
        
        stockWithDetails.forEach(item => {
            const displayName = (AppState.settings.showHindi && item.hindiName) ? item.hindiName : item.name;
            const div = document.createElement("div");
            div.className = "stock-item row";
            const rateLine = txMoney('ui.stock.rate_per_kg', { rate: formatAmount(item.rate, 'rate') }, item.rate, 'rate');

            if (item.isOrphan) {
                // Orphan rows: highlight in red so the user can spot the
                // discrepancy. Always shown to all users (including staff)
                // because they signal a data integrity issue.
                div.classList.add('stock-orphan', item.quantity < 0 ? 'tone-neg' : 'tone-warn');
                div.innerHTML = `
                        <div class="row-main">
                            <div class="row-title">${Helpers.escapeHtml(displayName)}</div>
                            <div class="stock-orphan-note">${icon('triangle', 'i-sm')} ${tx('ui.stock.unmatched')}</div>
                        </div>
                        <div class="row-trail">
                            <div class="row-amt">${stockKg(item.quantity)} kg</div>
                            <div class="row-meta" data-perm="profit">${rateLine}</div>
                        </div>
                `;
                list.appendChild(div);
                return;
            }

            // For staff: show "Available" if quantity > 100, otherwise show actual quantity
            // Rate is always shown, value is hidden when showing "Available"
            const showLimitedQty = isStaff && item.quantity > 100;
            const quantityDisplay = showLimitedQty ? tx('ui.stock.available') : `${stockKg(item.quantity)} kg`;
            const valueDisplay = showLimitedQty ? '' : `<div class="row-meta" data-perm="stockValue">≈ ${figHtml(itemValue(item))}</div>`;
            
            const catalogueItem = AppState.items.find(i => i.id === item.itemId);
            const level = lowStockLevel(catalogueItem);
            const alertLine = canSetAlerts && catalogueItem ? `
                        <button type="button" class="btn btn-ghost btn-sm stock-alert-link" data-onclick="stock.editLowStock('${Helpers.escapeJsAttr(catalogueItem.id)}')">
                            ${icon('bell', 'i-sm')}${level > 0 ? tx('ui.stock.alert_below', { level: stockKg(level) }) : tx('ui.stock.alert_off')}
                        </button>` : '';
            div.innerHTML = `
                <div class="row-main">
                    <div class="row-title">${Helpers.escapeHtml(displayName)}</div>
                    <div class="row-meta" data-perm="profit">${rateLine}</div>${alertLine}
                </div>
                <div class="row-trail">
                    <div class="row-amt">${quantityDisplay}</div>
                    ${valueDisplay}
                </div>
            `;
            
            list.appendChild(div);
            });
        } catch (error) {
            console.error('Error loading stock:', error);
            this.renderSummary(null);
            container.innerHTML = `<p class="empty tone-neg">${tx('ui.stock.load_failed')}</p>`;
        }
    }

    /**
     * Summary card above the list (#92): items in stock and their kg (S7), stock value (S4).
     * Members see the item count only: like the list, no exact kg above 100 kg and no value.
     * @param {?{items: number, kg: number}} summary null hides the card
     * @param {number} [value] S4
     * @param {boolean} [isStaff]
     */
    static renderSummary(summary, value = 0, isStaff = false) {
        const box = document.getElementById('stockSummary');
        if (!box) return;
        box.hidden = !summary || summary.items === 0;
        if (box.hidden) return;
        const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        set('stockSummaryItems', formatAmount(summary.items));
        set('stockSummaryKg', `${stockKg(summary.kg)} kg`);
        const valueEl = document.getElementById('stockSummaryValue');
        if (valueEl) valueEl.innerHTML = `≈ ${figHtml(value)}`;
        const kgCell = document.getElementById('stockSummaryKgCell');
        if (kgCell) kgCell.hidden = isStaff;
        const valueCell = document.getElementById('stockSummaryValueCell');
        if (valueCell) valueCell.hidden = isStaff;
    }

    /** Owners and managers adjust stock and set low-stock levels (firestore.rules: items and stockAdjustments). */
    static canManageStock() {
        return ['owner', 'manager'].includes(AppState.userRole);
    }

    /**
     * "Low stock (N)" card at the top of Current stock (#146, S-LOW): items below
     * their own level (default 10 kg), lowest first.
     * @param {Object} stock AppState.stock
     * @param {boolean} isStaff members see "Available" above 100 kg, as in the list
     * @returns {string} HTML ('' when nothing is low)
     */
    static lowStockHtml(stock, isStaff) {
        const stocked = stockedItemKeys({ purchases: AppState.purchaseHistory, stockAdjustments: AppState.stockAdjustments }, AppState.items, stock);
        const rows = lowStockItems(stock, AppState.items, stocked, { lang: AppState.settings?.showHindi ? 'hi' : 'en' });
        if (!rows.length) return '';
        const lines = rows.map(r => `<li><strong>${Helpers.escapeHtml(r.name)}</strong> ${isStaff && r.quantity > 100 ? tx('ui.stock.available')
            : tx('ui.stock.low_row', { qty: stockKg(r.quantity), level: stockKg(r.level) })}</li>`).join('');
        return `<div class="stock-low-card notice warn" role="status">${icon('triangle')}<div class="grow"><b>${tx('ui.stock.low_title', { n: rows.length })}</b><ul class="stock-low-list">${lines}</ul></div></div>`;
    }

    /**
     * Owner/manager: the low-stock level of one item (#146). Blank = the default
     * level, 0 = never alert. Needs the internet (an item write).
     * @param {string} itemId
     */
    static async editLowStock(itemId) {
        const item = AppState.items.find(i => i.id === itemId);
        if (!item || !this.canManageStock()) return;
        const name = (AppState.settings?.showHindi && item.hindiName) ? item.hindiName : item.name;
        const own = typeof item.lowStockKg === 'number' ? item.lowStockKg : '';
        const html = `<div class="field">
            <label for="lowStockInput">${tx('ui.stock.set_alert_label', { def: DEFAULT_LOW_STOCK_KG })}</label>
            <input type="number" inputmode="decimal" min="0" id="lowStockInput" class="input" value="${Helpers.escapeHtml(own)}">
        </div>`;
        const ok = await UIManager.showModalWithHtml(html, t('ui.stock.set_alert_title', { item: name }), true);
        if (!ok) return;
        const raw = String(document.getElementById('lowStockInput')?.value ?? '').trim();
        const kg = raw === '' ? null : Number(raw);
        if (kg !== null && !(Number.isFinite(kg) && kg >= 0)) {
            UIManager.showToast(t('msg.stock.alert_invalid'));
            return;
        }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            UIManager.showToast(t('msg.stock.needs_internet'));
            return;
        }
        try {
            await FirebaseService.setItemLowStock(itemId, kg);
            const current = AppState.items.find(i => i.id === itemId);
            if (current) {
                if (kg === null) delete current.lowStockKg;
                else current.lowStockKg = kg;
            }
            UIManager.showToast(t('msg.stock.alert_saved'));
            this.renderStock();
        } catch (error) {
            console.error('Low-stock level not saved:', error);
            UIManager.showToast(t('msg.stock.alert_failed'));
        }
    }

    /**
     * Reverse on an adjustment row (#146, owner/manager): saves the opposite
     * adjustment, linked by `reversesId`; the original is never changed or deleted.
     * @param {string} adjustmentId
     */
    static async reverseAdjustment(adjustmentId) {
        if (Helpers.isBusy('stock-adjust') || !this.canManageStock()) return;
        if (stockNotFinal()) {
            UIManager.showToast(t('msg.wholesale.stock_still_updating_try_again'));
            return;
        }
        const adjustments = AppState.stockAdjustments || [];
        const adj = adjustments.find(a => String(a.id) === String(adjustmentId));
        if (!adj || !canReverseAdjustment(adj, adjustments)) {
            UIManager.showToast(t('msg.stock.cannot_reverse'));
            return;
        }
        const item = AppState.items.find(i => i.id === adj.itemId || i.name === adj.itemName);
        if (!item) {
            UIManager.showToast(t('msg.common.item_not_found'));
            return;
        }
        const plan = reversalPlan(adj, AppState.stock[item.id]?.quantity || 0);
        if (!plan.quantity) {
            UIManager.showToast(t('msg.stock.no_stock_to_remove'));
            return;
        }
        const name = (AppState.settings?.showHindi && item.hindiName) ? item.hindiName : item.name;
        const full = Math.abs(adjustmentDelta(adj));
        const message = [t('msg.stock.reverse_confirm', { item: name, from: stockKg(plan.previousStock), to: stockKg(plan.newStock) }),
            plan.capped ? t('msg.stock.reverse_capped', { qty: stockKg(plan.quantity), full: stockKg(full) }) : ''].filter(Boolean).join(' ');
        const ok = await UIManager.showModal(message, t('ui.stock.reverse_title'), true);
        if (!ok) return;
        // Kg put back keep a cost (S2), also after a mistaken "remove everything" left it at 0
        const rate = plan.adjustType === 'add' ? this.restockRate(item, adj.rate) : 0;
        const saved = await Helpers.runExclusive('stock-adjust', '[data-stock-adjust]', () => {
            // Reversed meanwhile (another phone): nothing to do
            if (!canReverseAdjustment(adj, AppState.stockAdjustments || [])) {
                UIManager.showToast(t('msg.stock.cannot_reverse'));
                return false;
            }
            return this._saveAdjustment(item,
                { quantity: plan.quantity, rawQuantity: full, newStock: plan.newStock, reason: t('ui.stock.reason_reverse') },
                plan.previousStock, { adjustType: plan.adjustType, rate, reasonCode: 'reverse', reversesId: String(adj.id) });
        });
        if (saved) await this.refreshAfterAdjustment();
    }

    /** @private Cost per kg for kg put back or counted up from nothing (restockCost). */
    static restockRate(item, ownRate = 0) {
        return restockCost({
            ownRate,
            stockRate: AppState.stock[item.id]?.rate,
            lastPurchaseRate: lastPurchaseRate(item, AppState.purchaseHistory),
            catalogueRate: (item.rates || [])[0]
        });
    }

    /**
     * Stock count (#146, owner/manager): every item with its stock now and a box for
     * the counted kg; each item whose count differs gets a "set" adjustment with the
     * reason Physical count. Blank boxes change nothing.
     */
    static async openStockCount() {
        if (Helpers.isBusy('stock-adjust') || !this.canManageStock()) return;
        if (stockNotFinal()) {
            UIManager.showToast(t('msg.wholesale.stock_still_updating_try_again'));
            return;
        }
        const show = (i) => (AppState.settings?.showHindi && i.hindiName) ? i.hindiName : i.name;
        const items = [...AppState.items].filter(i => i && i.id && !i.archived).sort((a, b) => String(show(a)).localeCompare(String(show(b))));
        const rows = items.map(i => `<div class="row stock-count-line">
                <label class="row-main" for="count_${Helpers.escapeHtml(i.id)}"><span class="row-title">${Helpers.escapeHtml(show(i))}</span>
                    <span class="row-meta">${tx('ui.stock.count_now', { qty: stockKg(AppState.stock[i.id]?.quantity) })}</span></label>
                <input type="number" inputmode="decimal" min="0" id="count_${Helpers.escapeHtml(i.id)}" class="input" data-count-item="${Helpers.escapeHtml(i.id)}" placeholder="${tx('ui.stock.counted_kg')}">
            </div>`).join('');
        const html = `<div class="stock-count"><p class="stock-note">${tx('ui.stock.count_explain')}</p>${rows}</div>`;
        const ok = await UIManager.showModalWithHtml(html, t('ui.stock.count_title'), true);
        if (!ok) return;
        const counted = [...document.querySelectorAll('[data-count-item]')].map(input => ({
            itemId: input.dataset.countItem,
            counted: input.value.trim(),
            current: AppState.stock[input.dataset.countItem]?.quantity || 0
        }));
        const { changes, invalid } = stockCountPlan(counted);
        if (invalid.length) {
            UIManager.showToast(t('msg.stock.count_invalid'));
            return;
        }
        if (!changes.length) {
            UIManager.showToast(t('msg.stock.count_none'));
            return;
        }
        const sure = await UIManager.showModal(t('msg.stock.count_confirm', { n: changes.length }), t('ui.stock.count_title'), true);
        if (!sure) return;
        const saved = await Helpers.runExclusive('stock-adjust', '[data-stock-adjust]', () => {
            let n = 0;
            changes.forEach(c => {
                const item = AppState.items.find(i => i.id === c.itemId);
                // Counted up from nothing: the kg need a cost; otherwise the replay keeps the average cost
                const rate = item && c.previousStock <= 0 && c.newStock > 0 ? this.restockRate(item) : 0;
                const ok1 = item && this._saveAdjustment(item,
                    { quantity: c.newStock, rawQuantity: c.newStock, newStock: c.newStock, reason: t('ui.stock.reason_count') },
                    c.previousStock, { adjustType: 'set', rate, reasonCode: 'count', quiet: true });
                if (ok1) n++;
            });
            return n;
        });
        if (saved) {
            UIManager.showToast(t('msg.stock.count_saved', { n: saved }));
            await this.refreshAfterAdjustment();
        }
    }

    /**
     * Empty Stock list: says why (no stock set yet) and, for people who may
     * adjust stock, offers "Set opening stock" (F15).
     * @returns {string} HTML
     */
    static emptyStockHtml() {
        const e = (v) => Helpers.escapeHtml(v);
        const canAdjust = AppState.userRole !== 'staff';
        return `<div class="stock-empty empty">
            <b>${e(t('ui.stock.empty_title'))}</b>
            <p class="stock-empty-hint">${e(t(canAdjust ? 'ui.stock.empty_hint' : 'ui.stock.empty_hint_member'))}</p>
            ${canAdjust ? `<button type="button" class="btn btn-primary" data-onclick="stock.startOpeningStock()">${e(t('ui.stock.set_opening_stock'))}</button>` : ''}
        </div>`;
    }

    /** "Set opening stock": the adjustment form, ready for one item's opening quantity and cost per kg. */
    static startOpeningStock() {
        this.filterStockTab('adjustment');
        const type = document.getElementById('adjustType');
        if (type) type.value = 'set';
        const reason = document.getElementById('adjustReasonCode');
        if (reason) reason.value = 'opening';
        const rate = document.getElementById('adjustRate');
        if (rate && rate.value === '0') rate.value = '';
        this.updateAdjustmentPlaceholder();
        document.getElementById('adjustItem')?.focus();
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
                noResultsMsg.className = 'no-results-message empty';
                noResultsMsg.textContent = t('ui.stock.no_items_found');
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

        Object.values(sections).forEach(s => s && (s.hidden = true));
        if (sections[section]) sections[section].hidden = false;

        const btnIndex = { current: 0, adjustment: 1, dead: 2 }[section] ?? 0;
        document.querySelectorAll('#stock .stock-seg > button').forEach((btn, i) => btn.setAttribute('aria-pressed', String(i === btnIndex)));

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
    /** Language switched: redraw the JS-written parts of the Stock page from memory (no reads). */
    static refreshForLanguage() {
        const dead = document.getElementById('deadStockSection');
        if (dead && !dead.hidden) this.renderDeadStock();
        if (document.querySelector('#stockList .stock-item')) this.renderStock();
        this.updateAdjustmentPlaceholder();
        this.renderAdjustmentHistory();
        const updating = document.querySelector('#stockList .stock-updating');
        if (updating) updating.outerHTML = stockUpdatingHtml();
        const approx = document.querySelector('#stockList .stock-approx');
        if (approx) approx.outerHTML = stockApproxNoteHtml(AppState.stockApprox);
    }

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
            const totalValue = deadStockValue(rows);

            if (summary) {
                const windowNote = windowStart > 0
                    ? t('ui.deadstock.window_note', { date: formatWindowDate(windowStart), days: windowDays })
                    : t('ui.deadstock.all_bills');
                summary.innerHTML = rows.length
                    ? `${txMoney('ui.deadstock.summary', { n: rows.length, value: formatAmount(totalValue) }, totalValue)}<br>${e(windowNote)}`
                    : e(windowNote);
            }

            if (rows.length === 0) {
                container.innerHTML = emptyState({ icon: 'check', tone: 'pos', title: t('ui.deadstock.all_sold', { days: minDays }) });
                return;
            }

            container.innerHTML = `<div class="panel stock-rows">${rows.map(r => {
                const displayName = (AppState.settings.showHindi && r.hindiName) ? r.hindiName : r.name;
                const sale = daysSinceLabel(r.daysSinceSale, r.saleBeyondWindow, windowDays);
                const purchase = daysSinceLabel(r.daysSincePurchase, r.purchaseBeyondWindow, windowDays);
                return `
                <div class="stock-item dead-stock-item row">
                        <div class="row-main">
                            <div class="row-title">${e(displayName || r.name || '-')}</div>
                            <div class="row-meta tone-warn">${e(t('ui.deadstock.last_sale'))}: ${e(sale)}${r.uncertain ? ' *' : ''}</div>
                            <div class="row-meta">${e(t('ui.deadstock.last_purchase'))}: ${e(purchase)}</div>
                        </div>
                        <div class="row-trail">
                            <div class="row-amt tone-neg">${e(stockKg(r.quantity))} kg</div>
                            <div class="row-meta">≈ ${figHtml(r.value)}</div>
                            <div class="row-meta">${txMoney('ui.deadstock.avg_rate', { rate: formatRate(r.rate) }, r.rate, 'rate')}</div>
                        </div>
                </div>`;
            }).join('')}</div>` + (rows.some(r => r.uncertain)
                ? `<p class="stock-note">* ${e(t('ui.deadstock.uncertain_note', { windowDays, days: minDays }))}</p>`
                : '');
        } catch (error) {
            console.error('Error loading dead stock:', error);
            container.innerHTML = `<p class="empty tone-neg">${Helpers.escapeHtml(t('ui.deadstock.failed_load'))}</p>`;
        }
    }

    /**
     * Hide stock adjustment tab for staff users
     * Called when stock page is loaded
     */
    static hideAdjustmentTabForStaff() {
        const deadBtn = document.getElementById('deadStockTabBtn');
        if (deadBtn) deadBtn.hidden = !this.canSeeDeadStock();
        if (AppState.userRole === 'staff') {
            // Hide the Stock Adjustment button
            const filterButtons = document.querySelectorAll('#stock .stock-seg > button');
            if (filterButtons.length > 1) {
                filterButtons[1].hidden = true;
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

        select.innerHTML = `<option value="">${tx('ui.wholesale.select_item')}</option>`;
        AppState.items.forEach(item => {
            const option = document.createElement("option");
            option.value = item.id;
            const displayName = (AppState.settings.showHindi && item.hindiName) ? item.hindiName : item.name;
            option.textContent = isArchivedItem(item) ? `${displayName} (${t('ui.items.archived_chip')})` : displayName;
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
            showAvgRate(avgRateDisplay, false);
            return;
        }

        const item = AppState.items.find(i => i.id === itemId);
        if (!item) {
            display.textContent = "0.00";
            showAvgRate(avgRateDisplay, false);
            return;
        }

        // Stock is keyed by catalogue id: the replay resolves legacy name-only
        // lines to the id, so a name lookup would only find stale entries.
        const { quantity, avgRate } = adjustItemStock(AppState.stock[item.id]);
        display.textContent = formatKg(quantity);
        
        // Average rate (S2)
        if (avgRateDisplay && avgRateValue) {
            if (avgRate !== null) {
                avgRateValue.innerHTML = `${figHtml(avgRate, 'rate')}/kg`;
                showAvgRate(avgRateDisplay, true);
            } else {
                showAvgRate(avgRateDisplay, false);
            }
        }
    }

    static updateAdjustmentPlaceholder() {
        const adjustType = document.getElementById("adjustType")?.value;
        const quantityInput = document.getElementById("adjustQuantity");
        
        if (!quantityInput) return;
        
        switch (adjustType) {
            case 'add':
                quantityInput.placeholder = t('ui.stock.qty_to_add');
                break;
            case 'remove':
                quantityInput.placeholder = t('ui.stock.qty_to_remove');
                break;
            case 'set':
                quantityInput.placeholder = t('ui.stock.qty_new');
                break;
        }
    }

    static async applyStockAdjustment() {
        if (Helpers.isBusy('stock-adjust')) return;
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

        const currentStock = AppState.stock[item.id]?.quantity || 0;
        const plan = planStockAdjustment({ adjustType, quantity, currentStock, reasonCode, reasonNote, rate });
        if (!plan.ok) {
            UIManager.showToast(plan.error);
            return;
        }
        // "Set to" and a remove capped at the stock are worked out from the current stock
        if ((adjustType === 'set' || plan.capped) && stockNotFinal()) {
            UIManager.showToast(t('msg.wholesale.stock_still_updating_try_again'));
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
        const saved = await Helpers.runExclusive('stock-adjust', '[data-stock-adjust]', () => this._saveAdjustment(item, plan, currentStock, { adjustType, rate, reasonCode }));
        if (saved) await this.refreshAfterAdjustment();
    }

    static _saveAdjustment(item, plan, currentStock, { adjustType, rate, reasonCode, reversesId, quiet = false }) {
        const itemName = item.name;
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
        if (reversesId) adjustment.reversesId = reversesId;
        // Q17 (#37): a large adjustment is saved with a flag for review
        const adjustFlags = toFlags(evaluateStockAdjustment(newStock - currentStock, AppState.settings?.checkThresholds),
            adjustment.createdBy, adjustment.timestamp);
        if (adjustFlags.length) adjustment.flags = adjustFlags;

        let committed;
        try {
            ({ committed } = reversesId
                ? FirebaseService.startSaveStockAdjustment(adjustment, { id: `rev_${reversesId}` })
                : FirebaseService.startSaveStockAdjustment(adjustment));
        } catch (error) {
            console.error("Stock adjustment error:", error);
            UIManager.showToast(t('msg.stock.failed_apply_adjustment'));
            return false;
        }
        // Saved on the phone at once (also offline); a refused write is taken out again.
        // One audit entry once the server has answered (#85)
        const auditDetails = {
            itemId: item.id, itemName, adjustType, from: currentStock, to: newStock, reason: String(reason || '').slice(0, 200),
            ...(reversesId ? { reversesId } : {})
        };
        committed.then(
            () => AuditService.note(AuditService.ACTIONS.ADJUST_STOCK, { ...auditDetails, outcome: 'saved' }),
            error => {
                console.error("Stock adjustment error:", error);
                UIManager.showToast(t('msg.stock.failed_apply_adjustment'));
                AuditService.note(AuditService.ACTIONS.ADJUST_STOCK, { ...auditDetails, outcome: 'refused' });
                this.refreshAfterAdjustment().catch(e => console.error('Stock refresh failed:', e));
            });

        if (!AppState.stock[item.id]) {
            AppState.stock[item.id] = { quantity: 0, rate: 0 };
        }
        AppState.stock[item.id].quantity = newStock;

        if (quiet) return true;
        if (!reversesId) {
            document.getElementById("adjustQuantity").value = "";
            document.getElementById("adjustRate").value = "0";
            document.getElementById("adjustReason").value = "";
            const reasonSelect = document.getElementById("adjustReasonCode");
            if (reasonSelect) reasonSelect.value = "";
        }

        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        UIManager.showToast(t(offline ? SAVED_ON_PHONE_KEY : (reversesId ? 'msg.stock.reversed' : 'msg.stock.stock_adjustment_applied_successfully')));
        return true;
    }

    /** Stock, adjustment list and Current Stock after an adjustment (outside the save lock). */
    static async refreshAfterAdjustment() {
        try {
            this.renderAdjustmentHistory();
            this.loadAdjustItemStock();
            AppState.stock = await FirebaseService.calculateStock();
            this.loadAdjustItemStock();
            if (document.getElementById('currentStockSection')) {
                this.renderStock();
            }
        } catch (error) {
            console.error("Stock refresh after adjustment failed:", error);
        }
    }

    /**
     * Reverse button / "Reversed" chip of an adjustment row (#146).
     * @returns {string} HTML
     */
    static reverseControlHtml(adj, adjustments, canReverse) {
        if (adjustments.some(a => a?.reversesId && String(a.reversesId) === String(adj.id))) {
            return `<span class="tag">${tx('ui.stock.reversed_chip')}</span>`;
        }
        if (!canReverse || !canReverseAdjustment(adj, adjustments)) return '';
        if (!AppState.items.some(i => i.id === adj.itemId || i.name === adj.itemName)) return '';
        return `<button type="button" class="btn btn-ghost btn-sm" data-stock-adjust data-onclick="stock.reverseAdjustment('${Helpers.escapeJsAttr(adj.id)}')">${tx('ui.stock.reverse_btn')}</button>`;
    }

    static async renderAdjustmentHistory() {
        const container = document.getElementById("adjustmentHistory");
        if (!container) return;
        // A reason saved in the other language is recognised with both catalogues (#59)
        if (!hasCatalogue('en') || !hasCatalogue('hi')) await loadAllCatalogues().catch(() => {});

        try {
            // Kept current by the real-time listener; no need to re-read the
            // whole collection on every render.
            const adjustments = [...(AppState.stockAdjustments || [])];
            
            // Sort by timestamp/date (newest first)
            adjustments.sort((a, b) => {
                const timeA = a.timestamp || parseAnyBillDate(a.date)?.getTime() || 0;
                const timeB = b.timestamp || parseAnyBillDate(b.date)?.getTime() || 0;
                return timeB - timeA;
            });

            // Older adjustments load one month at a time as the user scrolls
            attachOlderHistoryScroll(container, { noun: 'adjustments', onLoaded: () => this.renderAdjustmentHistory() });

            if (adjustments.length === 0) {
                const message = isFullHistoryLoaded() ? t('ui.stock.no_adjustments_yet') : t('ui.stock.no_adjustments_since', { date: formatWindowDate(historyLoadedFrom()) });
                container.innerHTML = emptyState({ icon: 'box', title: message });
                return;
            }

            container.innerHTML = "";
            const canReverse = this.canManageStock();
            
            adjustments.forEach(adj => {
                const div = document.createElement("div");
                div.className = "history-item stock-adj";
                
                const typeLabels = { add: t('ui.stock.adj_added'), remove: t('ui.stock.adj_removed'), set: t('ui.stock.adj_set_to') };
                
                // Handle legacy data that might not have adjustType or quantity
                const adjustType = adj.adjustType || 'set';
                const quantity = adj.quantity !== undefined ? adj.quantity : 'Unknown';
                const typeLabel = typeLabels[adjustType] || t('ui.stock.adj_adjusted');
                
                // Find item to show in correct language
                const item = AppState.items.find(i => i.id === adj.itemId || i.name === adj.itemName);
                const displayName = (AppState.settings.showHindi && item?.hindiName) ? item.hindiName : (item?.name || adj.itemName || t('ui.stock.unknown_item'));
                
                // Rate shown and value (S5): the adjustment's own rate, else the item's current average rate
                const { rate: displayRate, value: valueImpact, rounded: valueShown } = adjustmentValue(adj, AppState.stock);
                
                div.innerHTML = `
                    <div class="history-header">
                        <strong>${Helpers.escapeHtml(displayName)}</strong>
                        <span class="stock-adj-type ${adjustType === 'add' ? 'tone-pos' : adjustType === 'remove' ? 'tone-neg' : adjustType === 'set' ? 'tone-info' : 'tone-muted'}">
                            ${Helpers.escapeHtml(typeLabel)} ${quantity !== 'Unknown' ? `${formatKg(quantity)} kg` : ''}
                        </span>
                    </div>
                    <div class="history-date">${Helpers.escapeHtml(formatDate(adj.date, 'datetime') || adj.date || t('ui.stock.unknown_date'))}${adj.createdByName ? ` • ${tx('ui.stock.by', { name: adj.createdByName })}` : ''}</div>
                    <div class="stock-adj-body">
                        ${displayRate > 0 ? `<div>${txMoney('ui.stock.rate_per_kg', { rate: formatAmount(displayRate, 'rate') }, displayRate, 'rate')}${valueImpact ? ` • ${txMoney('ui.stock.value', { amount: formatAmount(valueShown) }, valueShown)}` : ''}</div>` : ''}
                        <div>
                            ${formatKg(adj.previousStock)} kg → ${formatKg(adj.newStock)} kg
                            ${Number(adj.rawQuantity) > Number(adj.quantity) ? ` ${tx('ui.stock.capped', { qty: formatKg(adj.rawQuantity) })}` : ''}
                        </div>
                        ${adj.reason ? `<div><em>${Helpers.escapeHtml(adjustReasonText(adj))}</em></div>` : `<div><em>${tx('ui.stock.no_reason')}</em></div>`}
                        ${adj.reversesId ? `<div class="stock-adj-note">${icon('refresh', 'i-sm')} ${tx('ui.stock.reverses_note')}</div>` : ''}
                    </div>
                    ${this.reverseControlHtml(adj, adjustments, canReverse)}
                `;
                
                container.appendChild(div);
            });
        } catch (error) {
            console.error('Error loading adjustment history:', error);
            container.innerHTML = `<p class="empty tone-neg">${tx('ui.stock.history_failed')}</p>`;
        }
    }
}

// Data changes re-render this page (firestore-service.js emits, utils/events.js).
on(REFRESH.stockAdjustmentHistory, () => StockManager.renderAdjustmentHistory());
on(REFRESH.stockView, () => StockManager.renderStock());
