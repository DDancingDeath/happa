// Wholesale Sales Management Module
import { AppState } from '../utils/state.js';
import { on, REFRESH, ITEM_FREQUENCY_CHANGED, PRINT_STATUS_CHANGED } from '../utils/events.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { PrinterService } from '../services/printer.js';
import { AuditService } from '../services/audit.js';
import { Helpers } from '../utils/helpers.js';
import { computeShortfallsFrom, approxStockNote } from '../utils/stock-check.js';
import { normalizeThresholds, stockCreditFor } from '../utils/bill-checks.js';
import { BillChecksUI, readTypedNumber } from '../ui/bill-highlight.js';
import { attachOlderHistoryScroll } from '../ui/infinite-scroll.js';
import {
    isFullHistoryLoaded, historyLoadedFrom, formatWindowDate, rangeStatus, retryRange, applyRangeState, renderStaleHistoryHint
} from '../utils/history-window.js';
import { filterHistoryBills, resolveHistoryRange, validateCustomRange, billTimeMs } from '../utils/history-filters.js';
import { buildBillRow, buildOpeningGroup, addOpeningToggle, addVoidedToggle, billTableHtml } from '../ui/bill-row.js';
import { editsRowHtml, setBillActions, voidedBannerHtml } from '../ui/bill-status.js';
import { billPool, HistoryManager } from './history.js';
import { todayLocalISO } from '../utils/dates.js';
import { historyCutoff } from '../utils/role-access.js';
import { OutstandingManager } from './outstanding.js';
import { normalizePartyName } from '../utils/aging.js';
import { getLang, t } from '../i18n/index.js';
import { saveFailedText, SAVED_ON_PHONE_KEY, SAVE_UNCONFIRMED_KEY } from '../utils/storage-full.js';
import { buildDraftShareText } from '../utils/bill-share.js';
import { lineItemIdentity, isArchivedItem } from '../utils/item-catalog.js';

const L = (key, params) => Helpers.escapeHtml(t(key, params));
import {
    KEPT_SERVER_PAYMENT_KEY, paymentSplitMessage, readPayment, openingAmount, openingOldTotals, outstandingDue, isOpeningRecord, isActiveBill
} from '../utils/money.js';
import {
    buildPaymentSplit, computeLine, computeWholesaleTotals, draftLineSum, paidOnScreen, paymentSplit, prefillPayment,
    restInDue, shownAmount, typedAmount, validateDuePayment, validatePaymentSplit, wholesaleLiveProfit
} from '../utils/calc/billing.js';

/** Wholesale bills shown under the entry form (the rest are in Wholesale › History). */
const RECENT_SALES = 5;

const PAYMENT_TOLERANCE = 0.01;

/** Buttons disabled while a wholesale save/print is in flight */
const WHOLESALE_BUTTONS = '[onclick*="wholesaleSales.completeSale"], [onclick*="wholesaleSales.printWholesaleSale"]';

let wholesaleSaleItems = [];

/** Live profit last shown on the form (WS-PROFIT), used by the WhatsApp text. */
let shownProfit = 0;

/**
 * Id (and bill number, once issued) of the wholesale sale being entered, reused
 * by every save attempt so a retry cannot create a second bill (#70).
 * @type {{id: string, billNumber: (string|null)}|null}
 */
let pendingBill = null;

function ensurePendingBill() {
    if (!pendingBill) pendingBill = { id: Helpers.generateId(), billNumber: null, attempted: false, date: null, timestamp: null };
    return pendingBill;
}

export class WholesaleSalesManager {
    static async generateBillNumber() {
        return Helpers.generateBillNumber('W', 'wholesaleSales');
    }

    static async pickContact() {
        await Helpers.pickContact('wholesaleCustomerName');
    }

    static loadItemsDropdown() {
        const select = document.getElementById('sellItem');
        if (!select) return;
        
        select.innerHTML = `<option value="">${L('ui.wholesale.select_item')}</option>`;

        // While stock is still being calculated in the background, list every item
        // (the dropdown is refreshed with the stock filter once it is ready)
        const stockReady = AppState.stockReady !== false;
        if (!stockReady) {
            select.options[0].textContent = t('ui.wholesale.select_item_updating');
        }

        // Load only items that have stock
        AppState.items.forEach(item => {
            if (isArchivedItem(item)) return;
            // Check stock by itemId first, then by name
            const stockData = AppState.stock[item.id] || AppState.stock[item.name];
            
            // Only show items with positive stock quantity
            if (!stockReady || (stockData && stockData.quantity > 0)) {
                const opt = document.createElement('option');
                opt.value = item.name;
                const displayName = (AppState.settings.showHindi && item.hindiName) ? item.hindiName : item.name;
                opt.textContent = displayName;
                select.appendChild(opt);
            }
        });
    }

    static loadItemDetails() {
        this.fillItemDetails();
        this.syncItemStats();
    }

    // Stock and average rate are shown only once an item is picked (no "₹-/kg" placeholders)
    static syncItemStats() {
        const box = document.getElementById('wholesaleItemStats');
        const stock = document.getElementById('availableStock');
        const avg = document.getElementById('avgPurchaseRate');
        if (!box || !stock || !avg) return;
        const unknown = (el) => el.textContent.trim() === '-';
        box.hidden = !document.getElementById('sellItem')?.value || (unknown(stock) && unknown(avg));
        const unit = document.getElementById('availableStockUnit');
        if (unit) unit.hidden = !/^-?[\d.]+$/.test(stock.textContent.trim());
        const avgRow = document.getElementById('avgPurchaseRateRow');
        if (avgRow) avgRow.hidden = unknown(avg);
    }

    static fillItemDetails() {
        const itemName = document.getElementById("sellItem")?.value;
        const availableStockEl = document.getElementById("availableStock");
        const avgRateEl = document.getElementById("avgPurchaseRate");
        const sellRateEl = document.getElementById("sellRate");
        
        if (!availableStockEl || !avgRateEl || !sellRateEl) return;

        const approxEl = document.getElementById("availableStockApprox");
        if (approxEl) {
            const note = AppState.stockReady === false ? null : approxStockNote(AppState.stockApprox);
            approxEl.textContent = note ? (getLang() === 'hi' ? note.hi : note.en) : "";
            approxEl.style.display = note ? "block" : "none";
        }
        
        if (!itemName) {
            availableStockEl.textContent = "-";
            avgRateEl.textContent = "-";
            sellRateEl.value = "";
            return;
        }
        
        // Find item to get itemId
        const item = AppState.items.find(i => i.name === itemName);
        if (!item) {
            availableStockEl.textContent = "-";
            avgRateEl.textContent = "-";
            sellRateEl.value = "";
            return;
        }
        
        // Check stock by itemId first, then by name
        const stockData = AppState.stock[item.id] || AppState.stock[itemName];

        if (AppState.stockReady === false) {
            availableStockEl.textContent = t('ui.wholesale.updating');
            avgRateEl.textContent = "-";
        } else if (!stockData) {
            availableStockEl.textContent = "0.00";
            avgRateEl.textContent = "-";
            sellRateEl.value = "";
            return;
        } else {
            availableStockEl.textContent = (stockData.quantity || 0).toFixed(2);
            avgRateEl.textContent = (stockData.rate || 0).toFixed(2);
        }
        
        // Check if item has predefined wholesale rates
        if (item.wholesaleRates && item.wholesaleRates.length > 0) {
            // Use first wholesale rate as default
            const firstValidRate = item.wholesaleRates.find(rate => rate && rate > 0);
            sellRateEl.value = firstValidRate || "";
        } else {
            sellRateEl.value = "";
        }
    }

    static async addToWholesaleBill() {
        const itemName = Helpers.getInputText('sellItem');
        const rate = Helpers.getInputNumber('sellRate');
        const quantity = Helpers.getInputNumber('sellQuantity');
        
        if (!itemName) {
            UIManager.showToast(t('msg.common.select_item'));
            return;
        }
        
        if (!rate || rate <= 0) {
            UIManager.showToast(t('msg.common.enter_valid_rate'));
            return;
        }
        
        if (!quantity || quantity <= 0) {
            UIManager.showToast(t('msg.wholesale.enter_valid_quantity'));
            return;
        }
        
        // Find item
        const item = AppState.items.find(i => i.name === itemName);
        if (!item) {
            UIManager.showToast(t('msg.common.item_not_found'));
            return;
        }
        
        // Check stock
        if (AppState.stockReady === false) {
            UIManager.showToast(t('msg.wholesale.stock_still_updating_try_again'));
            return;
        }
        // Same limit as at save (#37, Q18/Q57): a small oversell only warns, beyond the limit it blocks
        const { oversellBlockKg } = normalizeThresholds(AppState.settings?.checkThresholds);
        const short = computeShortfallsFrom([...wholesaleSaleItems, { itemId: item.id, name: itemName, qty: quantity }],
            { items: AppState.items, stock: AppState.stock, stockReady: AppState.stockReady },
            stockCreditFor(AppState, 'wholesale', { draftId: pendingBill?.id }))
            .find(s => s.key === item.id);
        if (short && short.shortfall > oversellBlockKg + 1e-6) {
            const approx = approxStockNote(AppState.stockApprox);
            if (!approx) {
                UIManager.showToast(t('msg.wholesale.insufficient_stock_available_kg', { available: short.available.toFixed(1) }));
                return;
            }
            // Approximate stock (#129) may be off by older edits: warn only.
            UIManager.showToast(t('msg.wholesale.approx_stock_warning', { itemName, available: short.available.toFixed(1), note: getLang() === 'hi' ? approx.hi : approx.en }), 6000);
        }
        
        const { total } = computeLine({ rate, qty: quantity });
        ensurePendingBill();
        
        wholesaleSaleItems.push({
            itemId: item.id,
            // Catalogue name on the bill; Hindi is only for display (#143, Reports group by item).
            name: item.name,
            rate,
            qty: quantity,
            total,
            timestamp: Date.now()
        });
        
        // Clear inputs
        document.getElementById('sellQuantity').value = '';
        
        this.renderWholesaleBill();
        UIManager.hapticFeedback();
    }

    static renderWholesaleBill() {
        const tbody = document.querySelector('#salesTable tbody');
        const totalEl = document.getElementById('salesTotalAmount');
        const expensesInput = document.getElementById('salesExpensesAmount');
        const profitEl = document.getElementById('salesProfitAmount');
        const profitPercentEl = document.getElementById('salesProfitPercent');
        
        if (!tbody || !totalEl) return;
        
        if (wholesaleSaleItems.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #999; padding: 24px;" data-i18n="msg.common.no_items_in_bill">${L('msg.common.no_items_in_bill')}</td></tr>`;
            totalEl.textContent = '0';
            if (expensesInput) expensesInput.value = '0';
            if (profitEl) profitEl.textContent = '0';
            if (profitPercentEl) profitPercentEl.textContent = '0';
            shownProfit = 0;
            this.updatePaymentTotal();
            return;
        }
        
        tbody.innerHTML = wholesaleSaleItems.map((item, index) => {
            return `
                <tr>
                    <td>${Helpers.escapeHtml(lineItemIdentity(item, AppState.items, AppState.settings.showHindi).label)}</td>
                    <td>₹${item.rate.toFixed(2)}</td>
                    <td>${item.qty.toFixed(1)} kg</td>
                    <td>₹${shownAmount(item.total)}</td>
                    <td><button onclick="window.app.wholesaleSales.removeWholesaleItem(${index})" style="background: #e74c3c; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer;">×</button></td>
                </tr>
            `;
        }).join('');
        
        totalEl.textContent = shownAmount(this.computeTotals().total);
        
        this.updateProfitCalculation();
    }

    /**
     * Sale total, cost (stock average rates) and profit (sale − cost − expenses),
     * computed from the bill lines — the screen is display-only.
     * @returns {{total: number, cost: number, profit: ?number, profitPercent: ?number, unknownCost: number[]}}
     */
    static computeTotals() {
        return computeWholesaleTotals(wholesaleSaleItems, this.costStock(), Helpers.getInputNumber('salesExpensesAmount'), AppState.items);
    }

    /** Stock to cost the lines with: none while it is still loading (no cost is known yet, #102). */
    static costStock() {
        return AppState.stockReady === false ? {} : AppState.stock;
    }

    static updateProfitCalculation() {
        const profitEl = document.getElementById('salesProfitAmount');
        const profitPercentEl = document.getElementById('salesProfitPercent');
        const live = wholesaleLiveProfit(wholesaleSaleItems, this.costStock(), Helpers.getInputNumber('salesExpensesAmount'), AppState.items);
        
        // Cost of a line not known (#102): profit is not known either, never counted at cost ₹0
        if (profitEl) profitEl.textContent = live.shownProfit === null ? '—' : live.shownProfit;
        shownProfit = profitEl ? live.shownProfit : 0;
        if (profitPercentEl) profitPercentEl.textContent = live.profitPercent === null ? '—' : live.profitPercent.toFixed(1);
        this.updatePaymentTotal();
    }

    /**
     * Cash / online / due typed on the wholesale form
     * @returns {{cash: number, online: number, due: number}}
     */
    static readPaymentSplit() {
        return paymentSplit({
            online: Helpers.getInputNumber('wholesaleOnlinePayment'),
            cash: Helpers.getInputNumber('wholesaleCashPayment'),
            due: Helpers.getInputNumber('wholesaleDueAmount')
        });
    }

    /** Refresh "Total Received" and what is not split yet. */
    static updatePaymentTotal() {
        const split = this.readPaymentSplit();
        const receivedEl = document.getElementById('wholesaleTotalReceived');
        if (receivedEl) receivedEl.textContent = paidOnScreen(split);
        Helpers.showSplitRemaining('wholesaleSplitRemaining', validatePaymentSplit(this.computeTotals().total, split));
        BillChecksUI.schedule('wholesale');
    }

    /**
     * Tick Online / Cash / Due to put the whole bill in that one field
     * (same as the retail sale form).
     * @param {'online'|'cash'|'due'} type
     */
    static fillReceivableAmount(type) {
        Helpers.applyPaymentPrefill(type, prefillPayment(type, this.computeTotals().total), {
            online: ['wholesaleOnlinePayment', 'wholesaleOnlineCheckbox'],
            cash: ['wholesaleCashPayment', 'wholesaleCashCheckbox'],
            due: ['wholesaleDueAmount', 'wholesaleDueCheckbox']
        });
        this.updatePaymentTotal();
    }

    /** One tap: put whatever is not yet received (total − cash − online) in Due. */
    static putRestInDue() {
        const rest = restInDue(this.computeTotals().total, this.readPaymentSplit());
        if (!rest.ok) {
            UIManager.showToast(paymentSplitMessage(rest.check));
            return;
        }
        const dueInput = document.getElementById('wholesaleDueAmount');
        if (dueInput) dueInput.value = rest.due;
        const dueCheckbox = document.getElementById('wholesaleDueCheckbox');
        if (dueCheckbox) dueCheckbox.checked = rest.dueTicked;
        this.updatePaymentTotal();
    }

    static resetPaymentFields() {
        ['wholesaleOnlinePayment', 'wholesaleCashPayment', 'wholesaleDueAmount'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        ['wholesaleOnlineCheckbox', 'wholesaleCashCheckbox', 'wholesaleDueCheckbox'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.checked = false;
        });
        this.updatePaymentTotal();
    }

    /** Current bill lines (for draft recovery / tests). */
    static getItems() {
        return wholesaleSaleItems;
    }

    static setItems(items) {
        wholesaleSaleItems = items || [];
        if (wholesaleSaleItems.length === 0) pendingBill = null;
    }

    /** @returns {{id: string, billNumber: (string|null)}|null} */
    static getPendingBill() {
        return pendingBill ? { ...pendingBill } : null;
    }

    /**
     * The sale as the check engine sees it (utils/bill-checks.js).
     * @returns {Object}
     */
    static getCheckDraft() {
        const itemName = Helpers.getInputText('sellItem');
        const item = itemName ? AppState.items.find(i => i.name === itemName) : null;
        return {
            kind: 'wholesale',
            isEdit: false,
            id: pendingBill?.id || null,
            items: wholesaleSaleItems,
            total: this.computeTotals().total,
            payment: this.readPaymentSplit(),
            partyName: Helpers.getInputText('wholesaleCustomerName'),
            date: pendingBill?.date,
            enteredAt: pendingBill?.timestamp,
            entry: item ? { itemId: item.id, name: item.name, rate: readTypedNumber('sellRate'), qty: readTypedNumber('sellQuantity') } : null
        };
    }

    static removeWholesaleItem(index) {
        wholesaleSaleItems.splice(index, 1);
        this.renderWholesaleBill();
        UIManager.hapticFeedback();
    }

    static async completeSale(options = {}) {
        return Helpers.runExclusive('wholesale', WHOLESALE_BUTTONS, () => this._completeSale(options));
    }

    // Unguarded save; callers must hold the 'wholesale' lock.
    // options.onWriteIssued(saleData) is called as soon as the write is issued.
    static async _completeSale(options = {}) {
        if (wholesaleSaleItems.length === 0) {
            UIManager.showToast(t('msg.wholesale.add_items_bill'));
            return;
        }

        const customerName = Helpers.getInputText('wholesaleCustomerName');
        const comments = Helpers.getInputText('salesComments');
        const expenses = typedAmount(Helpers.getInputNumber('salesExpensesAmount'));
        
        // Total and profit come from the bill lines, never from the text on screen
        const totals = this.computeTotals();
        const { total, profit, profitPercent } = totals;
        const { unknownCost } = totals;
        const split = this.readPaymentSplit();
        const { cash, online, due } = split;
        
        // Payment, name-for-Due, stock and the other bill checks (#23, #68, #37)
        this.updatePaymentTotal();
        const checks = await BillChecksUI.confirmSave('wholesale');
        if (!checks.ok) return;
        
        try {
            const pending = ensurePendingBill();
            if (!pending.billNumber) pending.billNumber = await Helpers.generateBillNumber('W', 'wholesaleSales');
            // A retry keeps the first attempt's time so an unchanged sale is written identically
            if (!pending.timestamp) {
                pending.timestamp = Date.now();
                pending.date = Helpers.getCurrentDateTime();
            }
            
            const saleData = {
                id: pending.id,
                billNumber: pending.billNumber,
                customerName,
                items: wholesaleSaleItems.map((item, i) => ({
                    itemId: item.itemId,
                    name: item.name,
                    rate: item.rate,
                    quantity: item.qty,
                    total: item.total,
                    ...(unknownCost.includes(i) ? { costUnknown: true } : {})
                })),
                total,
                expenses,
                profit,
                profitPercent,
                ...(unknownCost.length ? { costUnknown: true } : {}),
                comments,
                type: 'wholesale',
                // Top-level copies keep readPayment(), the cash drawer and Outstanding in step
                onlinePayment: online,
                cashPayment: cash,
                dueAmount: due,
                payment: buildPaymentSplit(split),
                date: pending.date,
                timestamp: pending.timestamp,
                createdBy: AppState.currentUser?.uid || 'unknown',
                createdByName: AppState.userName || 'User',
                source: 'sales-tab',
                ...BillChecksUI.billFields(checks)
            };
            
            const retry = pending.attempted;
            pending.attempted = true;
            const writePromise = FirebaseService.saveWholesaleSale(saleData, { retry });
            if (typeof options.onWriteIssued === 'function') {
                options.onWriteIssued(saleData);
            }
            await writePromise;
            // Not confirmed even on this phone: keep the form (a retry reuses the same id) (#153)
            if (FirebaseService.saveUnconfirmed(saleData)) {
                UIManager.showToast(t(SAVE_UNCONFIRMED_KEY), 'warning');
                return undefined;
            }
            
            Helpers.runInBackground([
                () => AuditService.log(AuditService.ACTIONS.CREATE_SALE, {
                    billNumber: saleData.billNumber,
                    total: saleData.total,
                    customerName: saleData.customerName || 'N/A',
                    itemCount: saleData.items.length,
                    source: 'sales-tab'
                })
            ]);
            
            // Update customer options
            this.updateWholesaleCustomerOptions(customerName);
            
            // Clear bill
            pendingBill = null;
            wholesaleSaleItems = [];
            document.getElementById('wholesaleCustomerName').value = '';
            document.getElementById('sellQuantity').value = '';
            document.getElementById('sellRate').value = '';
            document.getElementById('salesComments').value = '';
            document.getElementById('salesExpensesAmount').value = '0';
            this.resetPaymentFields();
            
            // Clear stock details
            document.getElementById('availableStock').textContent = '-';
            document.getElementById('avgPurchaseRate').textContent = '-';
            this.syncItemStats();
            
            this.renderWholesaleBill();
            this.renderSalesHistory();
            
            // Stock is not recalculated here: the wholesaleSales realtime listener
            // fires on the local write, recalculates AppState.stock and refreshes
            // this dropdown. The item detail fields were cleared above so no stale
            // per-item stock is shown in the meantime.
            
            UIManager.showToast(FirebaseService.keptServerPayment(saleData) ? t(KEPT_SERVER_PAYMENT_KEY)
                : FirebaseService.savedOnPhoneOnly(saleData) ? t(SAVED_ON_PHONE_KEY) : t('msg.wholesale.sale_completed_successfully'));
            UIManager.hapticFeedback();
            return saleData;
        } catch (error) {
            console.error('Error completing sale:', error);
            UIManager.showToast(saveFailedText(error, t('msg.common.error', { message: error.message })), 'error');
        }
    }

    static async printWholesaleSale() {
        if (Helpers.isBusy('wholesale')) return;
        if (wholesaleSaleItems.length === 0) {
            UIManager.showToast(t('msg.wholesale.no_items_print'));
            return;
        }
        
        let printPromise = null;
        try {
            // Print the exact sale being saved, as soon as its write is issued
            const savedSale = await Helpers.runExclusive('wholesale', WHOLESALE_BUTTONS, () => this._completeSale({
                onWriteIssued: (sale) => { printPromise = PrinterService.printWholesaleSale(sale); }
            }));
            
            if (!printPromise) return;
            const printed = await printPromise;
            
            if (savedSale && printed === true) {
                UIManager.showToast(FirebaseService.savedOnPhoneOnly(savedSale) ? t(SAVED_ON_PHONE_KEY) : t('msg.common.sale_saved_printed'));
            }
        } catch (error) {
            console.error('Print error:', error);
            UIManager.showToast(t('msg.common.error_2', { value: error?.message || error }));
        }
    }

    static shareViaWhatsApp() {
        if (wholesaleSaleItems.length === 0) {
            UIManager.showToast(t('msg.wholesale.no_items_share'));
            return;
        }
        
        const customerName = Helpers.getInputText('wholesaleCustomerName');
        const total = draftLineSum(wholesaleSaleItems);
        const expenses = typedAmount(Helpers.getInputNumber('salesExpensesAmount'));
        const profit = shownProfit;
        const comments = Helpers.getInputText('salesComments');
        
        const message = buildDraftShareText({
            kind: 'wholesale', customer: customerName, note: comments, items: wholesaleSaleItems, total, expenses, profit
        });
        
        const url = `https://wa.me/?text=${encodeURIComponent(message)}`;
        window.open(url, '_blank');
    }

    /**
     * Wholesale page tabs: Sales (entry + recent bills), History (every
     * wholesale bill, with date filter, search and Table View), Outstanding.
     * @param {'sales'|'history'|'outstanding'} view
     * @param {Event} [evt]
     */
    static filterSalesTab(view, evt) {
        this.outstandingParty = null;
        const buttons = document.querySelectorAll('#wholesale-sales .filter-btn');
        buttons.forEach(btn => btn.classList.remove('active'));
        const target = evt?.target?.closest?.('.filter-btn') || document.querySelector(`#wholesale-sales .filter-btn[data-view="${view}"]`);
        target?.classList.add('active');
        
        const sections = {
            sales: document.getElementById('salesEntrySection'),
            history: document.getElementById('salesHistorySection'),
            outstanding: document.getElementById('salesOutstandingSection')
        };
        Object.entries(sections).forEach(([key, el]) => {
            if (el) el.style.display = key === view ? 'block' : 'none';
        });
        if (view === 'outstanding') this.renderSalesOutstanding();
        else if (view === 'history') this.renderWholesaleHistory();
    }

    static updateWholesaleCustomerOptions(newCustomer) {
        const salesHistory = AppState.salesHistory;
        const uniqueCustomers = [...new Set(
            salesHistory
                .filter(s => s.source === 'sales-tab' && s.customerName)
                .map(s => s.customerName)
        )];
        
        if (newCustomer && !uniqueCustomers.includes(newCustomer)) {
            uniqueCustomers.unshift(newCustomer);
        }
        
        const datalist = document.getElementById('wholesaleCustomerOptions');
        if (datalist) {
            datalist.innerHTML = uniqueCustomers.map(name => `<option value="${Helpers.escapeHtml(name)}">`).join('');
        }
    }

    static async recordPayment(saleId) {
        return Helpers.runExclusive('due-payment', '[data-record-payment], [data-mark-cleared]', () => this._recordPayment(saleId));
    }

    static async _recordPayment(saleId) {
        const salesHistory = AppState.salesHistory;
        const sale = salesHistory.find(s => s.id == saleId);
        if (!sale) {
            UIManager.showToast(t('msg.wholesale.error_sale_not_found'));
            return;
        }
        
        const paymentInput = document.getElementById(`payment_${saleId}`);
        const check = validateDuePayment(paymentInput?.value, 0, readPayment(sale).due, PAYMENT_TOLERANCE);
        if (!check.ok) {
            UIManager.showToast(t(check.error === 'exceeds-due' ? 'msg.common.payment_amount_exceeds_outstanding_amount' : 'msg.common.enter_valid_payment_amount'));
            return;
        }
        const paymentAmount = check.total;
        
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            UIManager.showToast(t('msg.common.internet_required_record_payment'));
            return;
        }
        
        const payment = {
            id: OutstandingManager.paymentEntryId(paymentInput, paymentAmount),
            amount: paymentAmount,
            date: Helpers.getCurrentDateTime(),
            recordedBy: AppState.userName || (AppState.currentUser ? AppState.currentUser.email : 'Unknown')
        };
        
        try {
            // Same server-side transaction as the Due screen, so a payment recorded
            // concurrently on another device is never overwritten by a full-document write
            const written = await OutstandingManager.applyPaymentTransaction('wholesale', sale, paymentAmount, payment);
            Object.assign(sale, written);
            
            OutstandingManager.clearPaymentEntryId(paymentInput);
            if (paymentInput) paymentInput.value = '';
            this.renderSalesOutstanding();
            this.renderSalesHistory();
            window.app?.outstanding?.renderDue?.();
            UIManager.showToast(t('msg.wholesale.payment_recorded', { paymentAmount }));
        } catch (error) {
            console.error('Error recording payment:', error);
            if (error && error.code === 'exceeds-due') {
                UIManager.showToast(t('msg.common.payment_amount_exceeds_outstanding_amount_2', { due: error.due }));
                this.renderSalesOutstanding();
            } else if (OutstandingManager.isOfflineError(error)) {
                UIManager.showToast(t('msg.common.internet_required_record_payment'));
            } else {
                UIManager.showToast(await OutstandingManager.paymentRefusedText(error));
            }
        }
    }

    static async markSaleAsCleared(saleId) {
        const checkbox = document.getElementById(`clear_${saleId}`);
        if (checkbox) checkbox.checked = false;
        // Same honest clearing as Outstanding (#104): received in cash/online, or written off with a reason
        const cleared = await OutstandingManager.markAsCleared(saleId, 'wholesale');
        if (cleared) this.renderSalesHistory();
    }

    /** Party opened from the bill's "Already owes" line (#166): {key, name} or null. */
    static outstandingParty = null;

    /**
     * Open the Outstanding view showing only one customer's open bills.
     * @param {string} name Customer name as typed on the bill
     */
    static showOutstandingParty(name) {
        const outstandingBtn = document.querySelectorAll('#wholesale-sales .filter-btn')[1];
        this.filterSalesTab('outstanding', outstandingBtn ? { target: outstandingBtn } : undefined);
        const key = normalizePartyName(name);
        if (!key) return;
        this.outstandingParty = { key, name: String(name).trim() };
        this.renderSalesOutstanding();
    }

    static clearOutstandingParty() {
        this.outstandingParty = null;
        this.renderSalesOutstanding();
    }

    static renderSalesOutstanding() {
        const salesHistory = AppState.salesHistory;
        const container = document.getElementById("salesOutstandingList");
        const party = this.outstandingParty;
        
        const outstandingSales = salesHistory
            .filter(sale => {
                if (sale.source !== 'sales-tab') return false;
                if (sale.cleared) return false;
                if (party && normalizePartyName(sale.customerName) !== party.key) return false;
                return outstandingDue(sale) > 0;
            })
            .map(sale => {
                const pay = readPayment(sale);
                return {
                    ...sale,
                    outstanding: outstandingDue(sale),
                    totalAmount: pay.total || openingAmount(sale),
                    paidAmount: pay.paid
                };
            })
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        
        const partyNote = party ? `
            <div class="party-filter-note">
                <span>${L('ui.outstanding.showing_only')} <strong>${Helpers.escapeHtml(party.name)}</strong></span>
                <button type="button" class="aging-btn" onclick="window.app.wholesaleSales.clearOutstandingParty()">${L('ui.outstanding.show_all')}</button>
            </div>` : '';

        if (outstandingSales.length === 0) {
            container.innerHTML = `${partyNote}<p style="text-align: center; color: #888; margin-top: 40px;">${L(party ? 'ui.outstanding.nothing_for_party' : 'ui.wholesale.no_outstanding_payments')}</p>`;
            return;
        }

        container.innerHTML = partyNote;

        outstandingSales.forEach(sale => {
                const div = document.createElement("div");
                div.className = "history-item";
                
                const billNumber = sale.billNumber || sale.id;
                div.innerHTML = `
                    <div class="history-header">
                        <span><span style="cursor: pointer; color: #22c55e; text-decoration: underline;" onclick="window.app.wholesaleSales.reprintSaleById('${Helpers.escapeJsAttr(sale.id)}')">#${Helpers.escapeHtml(billNumber)}</span>${sale.customerName ? `  <strong>${Helpers.escapeHtml(sale.customerName)}</strong>` : ''}</span>
                        <span style="color: #dc3545; font-weight: 700;">${L('ui.outstanding.due_amount', { amount: Math.round(sale.outstanding) })}</span>
                    </div>
                    <div class="history-date">${Helpers.escapeHtml(sale.date)}${sale.createdByName ? ` • ${L('ui.outstanding.by')} <strong>${Helpers.escapeHtml(sale.createdByName)}</strong>` : ''}</div>
                    ${openingOldTotals(sale) ? `<div class="history-date">${L('ui.outstanding.opening_balance', { total: Math.round(openingOldTotals(sale).total), paid: Math.round(openingOldTotals(sale).paid) })}</div>` : ''}
                    <div style="background: #d1ecf1; border-left: 4px solid #22c55e; padding: 12px; margin: 12px 0; border-radius: 4px;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                            <span>${L('ui.common.total_receivable')}</span>
                            <strong>₹${Math.round(sale.totalAmount)}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                            <span>${L('ui.outstanding.received_label')}</span>
                            <strong>₹${Math.round(sale.paidAmount)}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between; border-top: 2px solid #17a2b8; padding-top: 6px; margin-top: 6px;">
                            <span style="font-weight: 600;">${L('ui.outstanding.outstanding_label')}</span>
                            <strong style="color: #dc3545; font-size: 16px;">₹${Math.round(sale.outstanding)}</strong>
                        </div>
                        <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #17a2b8;">
                            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                                <label style="font-weight: 500;">${L('ui.wholesale.payment_rs')}</label>
                                <input type="number" inputmode="decimal" id="payment_${Helpers.escapeHtml(sale.id)}" placeholder="${L('ui.cash.enter_amount')}" style="flex: 1; padding: 6px; border: 1px solid #17a2b8; border-radius: 4px;" />
                                <button data-record-payment onclick="window.app.wholesaleSales.recordPayment('${Helpers.escapeJsAttr(sale.id)}')" style="padding: 6px 12px; background: #15803d; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 500;">${L('ui.outstanding.record')}</button>
                            </div>
                            <div style="display: flex; align-items: center;">
                                <input type="checkbox" data-mark-cleared id="clear_${Helpers.escapeHtml(sale.id)}" onchange="window.app.wholesaleSales.markSaleAsCleared('${Helpers.escapeJsAttr(sale.id)}')" style="margin-right: 8px; transform: scale(1.2);" />
                                <label for="clear_${Helpers.escapeHtml(sale.id)}" style="cursor: pointer; font-weight: 500;">${L('ui.wholesale.mark_as_cleared')}</label>
                            </div>
                        </div>
                    </div>
                `;
                
                container.appendChild(div);
        });
    }

    /** Re-render the recent bills under the entry form and Wholesale › History. */
    static renderSalesHistory() {
        this.renderRecentSales();
        this.renderWholesaleHistory();
    }

    /** Oldest time (ms) this role may see in History lists (role's "days back"); null = no limit. */
    static historyCutoff() {
        return historyCutoff(AppState.userRole, AppState.settings?.roleAccess);
    }

    /**
     * Wholesale bills as list rows (opening records included; callers filter),
     * without bills older than the role's History "days back" limit.
     */
    static wholesaleBills() {
        const cutoff = this.historyCutoff();
        // Voided bills (#75) come along for the "Show voided bills" toggle; callers split them off.
        return billPool('wholesale')
            .filter(s => cutoff === null || billTimeMs(s) >= cutoff)
            .map(s => ({ ...s, type: 'wholesale', isPurchase: false }));
    }

    static buildSaleRow(sale) {
        return buildBillRow(sale, {
            kind: 'wholesale',
            onclick: `window.app.wholesaleSales.reprintSaleById('${Helpers.escapeJsAttr(sale.id)}')`
        });
    }

    /** Latest few wholesale bills under the entry form (old-app dues left out). */
    static renderRecentSales() {
        const container = document.getElementById('salesRecentList');
        if (!container) return;
        const recent = filterHistoryBills(this.wholesaleBills().filter(b => isActiveBill(b) && !isOpeningRecord(b)), {}).slice(0, RECENT_SALES);
        if (recent.length === 0) {
            const message = isFullHistoryLoaded() ? t('ui.wholesale.no_sales_yet') : t('ui.wholesale.no_sales_since', { date: formatWindowDate(historyLoadedFrom()) });
            container.innerHTML = `<p style="text-align: center; color: #888; margin-top: 20px;">${Helpers.escapeHtml(message)}</p>`;
            return;
        }
        container.innerHTML = '';
        const fragment = document.createDocumentFragment();
        recent.forEach(sale => fragment.appendChild(this.buildSaleRow(sale)));
        container.appendChild(fragment);
    }

    /** Wholesale › History state (date filter, search, view, old-app dues toggle). */
    static historyFilter = { preset: 'all', from: '', to: '' };
    static historySearch = '';
    static historyView = 'card';
    static showOpening = false;
    static historyOpenings = [];
    /** "Show voided bills" toggle (#75) and the voided bills of the last render. */
    static showVoided = false;
    static historyVoided = [];

    /**
     * Wholesale › History: every wholesale bill (not only outstanding), newest
     * first, same row and Table View as History. Old-app carried dues are
     * hidden unless the toggle is on.
     */
    static renderWholesaleHistory() {
        const container = document.getElementById('salesHistoryList');
        if (!container) return;
        const f = this.historyFilter;
        const range = resolveHistoryRange(f.preset, new Date(), f);
        // Never load months the role may not see: the load starts at the cutoff at the earliest.
        const cutoff = this.historyCutoff();
        const loadFrom = cutoff === null ? range.from : Math.max(range.from ?? cutoff, cutoff);
        const status = loadFrom !== null ? rangeStatus('wholesaleHistory', loadFrom, () => this.renderWholesaleHistory()) : 'ready';
        applyRangeState(container, status, {
            loadingText: t('ui.history.loading_older_bills'),
            errorText: t('ui.history.older_load_failed', { date: formatWindowDate(historyLoadedFrom()) }),
            onRetry: () => { retryRange('wholesaleHistory'); this.renderWholesaleHistory(); }
        });
        this.syncHistoryUi();

        const matched = filterHistoryBills(this.wholesaleBills(), { type: 'wholesale', range, search: this.historySearch });
        const voided = matched.filter(b => !isActiveBill(b));
        const live = matched.filter(isActiveBill);
        const openings = live.filter(b => isOpeningRecord(b));
        const bills = live.filter(b => !isOpeningRecord(b));
        const showOpenings = this.showOpening && openings.length > 0;
        const showVoided = this.showVoided && voided.length > 0;
        this.historyOpenings = showOpenings ? openings : [];
        this.historyVoided = showVoided ? voided : [];
        const placeToggle = () => {
            addVoidedToggle(container, {
                id: 'wholesaleVoidedToggle', count: voided.length, on: showVoided,
                onToggle: () => { this.showVoided = !this.showVoided; this.renderWholesaleHistory(); }
            });
            addOpeningToggle(container, {
                id: 'wholesaleOpeningToggle', count: openings.length, on: showOpenings,
                onToggle: () => { this.showOpening = !this.showOpening; this.renderWholesaleHistory(); }
            });
        };

        const ranged = range.from !== null || range.to !== null;
        // Older months load one at a time as the user scrolls (all dates, no search).
        attachOlderHistoryScroll(container, {
            noun: 'sales',
            enabled: () => !this.historySearch && !ranged && cutoff === null,
            onLoaded: () => this.renderSalesHistory()
        });
        const shown = [...this.historyOpenings, ...this.historyVoided, ...bills];
        renderStaleHistoryHint(container, {
            id: 'wholesaleStaleHint',
            onRefreshed: () => this.renderSalesHistory(),
            isRelevant: (info) => shown.some(b => { const ms = billTimeMs(b); return ms !== null && ms < info.liveFrom; })
        });

        if (bills.length === 0 && !showOpenings && !showVoided) {
            let message;
            if (this.historySearch) message = t('ui.history.no_results_for', { searchTerm: this.historySearch });
            else if (ranged) message = t('ui.history.none_in_period', { noun: t('ui.history.noun_wholesale') });
            else message = isFullHistoryLoaded() ? t('ui.wholesale.no_sales_yet') : t('ui.wholesale.no_sales_since', { date: formatWindowDate(historyLoadedFrom()) });
            container.innerHTML = `<p style="text-align: center; color: #888; margin-top: 40px;">${Helpers.escapeHtml(message)}</p>`;
            placeToggle();
            return;
        }

        if (this.historyView === 'table') {
            container.innerHTML = billTableHtml(bills, {
                openings: this.historyOpenings,
                voided: this.historyVoided,
                onclickFor: (sale) => `window.app.wholesaleSales.reprintSaleById('${Helpers.escapeJsAttr(sale.id)}')`
            });
            placeToggle();
            return;
        }
        container.innerHTML = '';
        const fragment = document.createDocumentFragment();
        if (showOpenings) fragment.appendChild(buildOpeningGroup(openings, sale => this.buildSaleRow(sale)));
        if (showVoided) fragment.appendChild(buildOpeningGroup(voided, sale => this.buildSaleRow(sale), 'voided'));
        bills.forEach(sale => fragment.appendChild(this.buildSaleRow(sale)));
        container.appendChild(fragment);
        placeToggle();
    }

    /** Reflect the Wholesale › History filter in its controls. */
    static syncHistoryUi() {
        const f = this.historyFilter;
        const preset = document.getElementById('wholesaleHistoryPreset');
        if (preset && preset.value !== f.preset) preset.value = f.preset;
        const custom = document.getElementById('wholesaleHistoryCustomRange');
        if (custom) custom.hidden = f.preset !== 'custom';
        const toggle = document.getElementById('wholesaleHistoryViewToggle');
        if (toggle) toggle.textContent = t(this.historyView === 'card' ? 'ui.history.table_view' : 'ui.history.card_view');
    }

    static setHistoryPreset(preset) {
        const f = { ...this.historyFilter, preset };
        if (preset === 'custom' && !f.from && !f.to) {
            f.from = f.to = todayLocalISO();
            const from = document.getElementById('wholesaleHistoryFrom');
            const to = document.getElementById('wholesaleHistoryTo');
            if (from && to) { from.value = f.from; to.value = f.to; }
        }
        this.historyFilter = f;
        this.showHistoryRangeHint('');
        this.renderWholesaleHistory();
    }

    /** Apply the custom From/To dates (invalid dates show a hint, nothing loads). */
    static applyHistoryRange(from, to) {
        if (from === undefined) from = document.getElementById('wholesaleHistoryFrom')?.value || '';
        if (to === undefined) to = document.getElementById('wholesaleHistoryTo')?.value || '';
        const check = validateCustomRange(from, to);
        this.showHistoryRangeHint(check.ok ? '' : check.error);
        if (!check.ok) return false;
        this.historyFilter = { preset: 'custom', from: check.from, to: check.to };
        this.renderWholesaleHistory();
        return true;
    }

    static showHistoryRangeHint(text) {
        const hint = document.getElementById('wholesaleHistoryRangeHint');
        if (!hint) return;
        hint.textContent = text || '';
        hint.hidden = !text;
    }

    static searchHistory(term) {
        this.historySearch = String(term || '').trim();
        this.renderWholesaleHistory();
    }

    static toggleHistoryView() {
        this.historyView = this.historyView === 'card' ? 'table' : 'card';
        this.renderWholesaleHistory();
    }

    static async reprintSale(index) {
        // Bills that count and voided ones (#75); index into this list
        const salesHistory = billPool('wholesale');
        const sale = salesHistory[index];
        if (!sale) {
            UIManager.showModal(t('msg.common.sale_not_found'));
            return;
        }
        
        // Store index and type for edit/delete functionality
        window.currentBillIndex = index;
        window.currentBillId = sale.id;
        window.currentBillType = 'wholesale';
        
        const itemsHTML = sale.items.map(item => {
            const qty = item.qty || item.quantity || 0;
            return `
                <tr>
                    <td style="padding: 10px 8px; border-bottom: 1px solid #e5e7eb;">${Helpers.escapeHtml(item.name)}</td>
                    <td style="padding: 10px 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">${Helpers.escapeHtml(item.rate)}</td>
                    <td style="padding: 10px 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">${Helpers.escapeHtml(qty)}</td>
                    <td style="padding: 10px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;"><strong>${Math.round(item.total)}</strong></td>
                </tr>
            `;
        }).join('');
        
        const pay = readPayment(sale);
        const payment = { online: pay.online, cash: pay.cash, due: outstandingDue(sale) };
        const paymentHTML = (payment.online > 0 || payment.cash > 0 || payment.due > 0) ? `
            <div style="background: white; padding: 14px; border-radius: 10px; border: 1px solid #dee2e6; margin-top: 12px;">
                <h4 style="margin: 0 0 12px 0; font-size: 15px; color: #212529;">${L('ui.history.payment_details')}</h4>
                ${payment.online > 0 ? `
                    <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px;">
                        <span>${L('ui.history.online')}</span>
                        <span style="display: inline-block; padding: 4px 12px; border-radius: 6px; font-weight: 600; background: #cfe2ff; color: #084298;">₹${Math.round(payment.online)}</span>
                    </div>
                ` : ''}
                ${payment.cash > 0 ? `
                    <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px;">
                        <span>${L('ui.history.cash')}</span>
                        <span style="display: inline-block; padding: 4px 12px; border-radius: 6px; font-weight: 600; background: #d1e7dd; color: #0f5132;">₹${Math.round(payment.cash)}</span>
                    </div>
                ` : ''}
                ${payment.due > 0 ? `
                    <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px;">
                        <span>${L('ui.history.due')}</span>
                        <span style="display: inline-block; padding: 4px 12px; border-radius: 6px; font-weight: 600; background: #fff3cd; color: #997404;">₹${Math.round(payment.due)}</span>
                    </div>
                ` : ''}
            </div>
        ` : '';
        
        const paymentsHistoryHTML = sale.payments && sale.payments.length > 0 ? `
            <div style="background: #e7f5e9; padding: 14px; border-radius: 10px; border: 1px solid #c3e6c3; margin-top: 12px;">
                <h4 style="margin: 0 0 12px 0; font-size: 15px; color: #155724;">${L('ui.wholesale.payment_history')}</h4>
                ${sale.payments.map(p => `
                    <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px;">
                        <span>• ${Helpers.escapeHtml(p.date)}${p.recordedBy ? ` ${L('ui.wholesale.by_name', { name: p.recordedBy })}` : ''}${p.kind === 'writeOff' ? ` — ${L('ui.wholesale.written_off', { reason: p.reason || '' })}` : ''}</span>
                        <strong>₹${Math.round(p.amount)}</strong>
                    </div>
                `).join('')}
            </div>
        ` : '';
        
        const billNumber = sale.billNumber || sale.id;
        
        const content = `
            <div style="padding: 16px; max-width: 100%;">
                ${voidedBannerHtml(sale)}
                <div class="bill-info-section">
                    <div class="bill-info-row">
                        <div class="bill-info-label">${L('ui.history.bill_no')}</div>
                        <div class="bill-info-value"><strong style="color: #28a745;">#${Helpers.escapeHtml(billNumber)}</strong></div>
                    </div>
                    <div class="bill-info-row">
                        <div class="bill-info-label">${L('ui.history.date_label')}</div>
                        <div class="bill-info-value">${Helpers.escapeHtml(sale.date)}</div>
                    </div>
                    ${sale.createdByName ? `
                        <div class="bill-info-row">
                            <div class="bill-info-label">${L('ui.history.created_by')}</div>
                            <div class="bill-info-value">${Helpers.escapeHtml(sale.createdByName)}</div>
                        </div>
                    ` : ''}
                    ${sale.customerName ? `
                        <div class="bill-info-row">
                            <div class="bill-info-label">${L('ui.common.customer')}</div>
                            <div class="bill-info-value"><strong>${Helpers.escapeHtml(sale.customerName)}</strong></div>
                        </div>
                    ` : ''}
                </div>
                
                ${sale.comments ? `
                    <div style="margin-bottom: 12px; padding: 10px; background: #fff3cd; border-radius: 8px; border-left: 4px solid #ffc107;">
                        <span style="color: #6c757d; font-size: 14px;">${L('ui.wholesale.comments')}</span>
                        <div style="font-size: 14px; color: #212529; margin-top: 4px;">${Helpers.escapeHtml(sale.comments)}</div>
                    </div>
                ` : ''}
                
                <h4 style="margin: 16px 0 12px 0; color: #212529; font-size: 15px;">${L('ui.history.sale_items')}</h4>
                <table style="width: 100%; border-collapse: collapse; background: white; margin-bottom: 16px;">
                    <thead>
                        <tr style="background: #f8f9fa; border-bottom: 2px solid #dee2e6;">
                            <th style="padding: 10px 8px; text-align: left; font-size: 14px; font-weight: 600; color: #495057;">${L('ui.common.item_2')}</th>
                            <th style="padding: 10px 8px; text-align: center; font-size: 14px; font-weight: 600; color: #495057;">${L('ui.history.rate_rs')}</th>
                            <th style="padding: 10px 8px; text-align: center; font-size: 14px; font-weight: 600; color: #495057;">${L('ui.history.qty_kg')}</th>
                            <th style="padding: 10px 8px; text-align: right; font-size: 14px; font-weight: 600; color: #495057;">${L('ui.history.total_rs')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${itemsHTML}
                    </tbody>
                </table>
                
                <div style="background: white; padding: 14px; border-radius: 10px; border: 1px solid #dee2e6;">
                    <div style="display: flex; justify-content: space-between; padding: 8px 0; font-size: 15px;">
                        <span style="font-weight: 600;">${L('ui.billing.sale_total')}</span>
                        <strong style="font-size: 17px; color: #28a745;">₹${Math.round(sale.total)}</strong>
                    </div>
                </div>
                
                ${paymentHTML}
                ${paymentsHistoryHTML}
                ${editsRowHtml(sale, 'window.app.history.showEdits()')}
            </div>
        `;
        
        document.getElementById('billDetailsContent').innerHTML = content;
        // Wholesale bills are not edited here; Void / Delete permanently as in History (#75)
        setBillActions(sale, { uid: AppState.currentUser?.uid, role: AppState.userRole, raw: AppState.settings?.roleAccess }, { editable: false });
        HistoryManager.renderPrintStatus();
        document.getElementById('billDetailsOverlay').classList.add('active');
    }

    static async reprintSaleById(saleId) {
        const salesHistory = billPool('wholesale');
        const index = salesHistory.findIndex(s => String(s.id) === String(saleId));
        if (index === -1) {
            UIManager.showModal(t('msg.common.sale_not_found'));
            return;
        }
        await this.reprintSale(index);
    }
}

BillChecksUI.register('wholesale', {
    sectionId: 'salesEntrySection',
    tableSelector: '#salesTable',
    saveButtons: WHOLESALE_BUTTONS,
    getDraft: () => WholesaleSalesManager.getCheckDraft(),
    fields: {
        party: { inputs: ['wholesaleCustomerName'] },
        payment: { inputs: ['wholesaleCashPayment', 'wholesaleOnlinePayment', 'wholesaleDueAmount'], anchor: 'wholesaleSplitRemaining' },
        'entry.rate': { inputs: ['sellRate'] },
        'entry.qty': { inputs: ['sellQuantity'] }
    }
});

// Data changes re-render this page (firestore-service.js emits, utils/events.js).
on(REFRESH.salesDropdown, () => WholesaleSalesManager.loadItemsDropdown());
on(REFRESH.wholesaleHistory, () => WholesaleSalesManager.renderSalesHistory());
on(REFRESH.wholesaleOutstanding, () => WholesaleSalesManager.renderSalesOutstanding());
on(ITEM_FREQUENCY_CHANGED, () => WholesaleSalesManager.loadItemsDropdown());
on(PRINT_STATUS_CHANGED, () => {
    if (document.getElementById('wholesale-sales')?.classList.contains('active')) WholesaleSalesManager.renderSalesHistory();
});
