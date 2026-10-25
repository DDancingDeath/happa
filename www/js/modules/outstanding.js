/**
 * @fileoverview Outstanding Payments Module
 * Handles tracking and managing due payments for purchases and sales
 * Provides filtering, search, and payment clearing functionality
 * @module modules/outstanding
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { Helpers } from '../utils/helpers.js';
import { AuditService } from '../services/audit.js';
import { openingAmount, openingOldTotals, readPayment, round2 } from '../utils/money.js';
import { parseAnyBillDate, todayLocalISO } from '../utils/dates.js';
import { checkPaymentSplit, directionFor } from '../utils/due-payments.js';
import { CashManagementManager } from './cash-management.js';
import { PrinterService } from '../services/printer.js';
import { openExternal } from '../utils/open-external.js';
import { billDateOf } from '../utils/history-filters.js';
import { t } from '../i18n/index.js';
import { tip } from '../tip/index.js';
import { paymentRecordProps, paymentErrorOutcome } from '../tip/scenarios/payment-record.js';

/** i18n key + params for a bill age in days (null = unknown). */
function ageKey(days) {
    if (days === null) return ['ui.outstanding.date_unknown'];
    return [days === 1 ? 'ui.outstanding.day_one' : 'ui.outstanding.days_many', { count: days }];
}
import {
    AGING_BUCKETS, ageInDays, bucketIndex, buildAging, chaseFirst, filterBillsByBucket, normalizePartyName, sortParties
} from '../utils/aging.js';
import {
    buildReminderText, buildStatement, formatINR, normalizePhone, whatsAppReminderUrl
} from '../utils/due-reminder.js';

const PAYMENT_TOLERANCE = 0.01;
const COLLECTION_BY_TYPE = { purchase: 'purchases', retail: 'retailSales', wholesale: 'wholesaleSales' };

const colName = (name) => (window.getCollection ? window.getCollection(name) : name);

/** Record buttons disabled while a due payment is being saved (#70) */
const RECORD_PAYMENT_BUTTONS = '[data-record-payment]';

/**
 * Outstanding Manager - Manages due payments
 * @class OutstandingManager
 */
export class OutstandingManager {
    /**
     * Search and filter outstanding payments
     * Filters by customer name, amount, or date
     */
    static searchOutstanding() {
        const searchInput = document.getElementById("outstandingSearchInput");
        const searchTerm = searchInput?.value.toLowerCase().trim() || '';
        const container = document.getElementById("dueList");
        
        if (!container) return;

        // Party rows of the aging panel follow the same search (#46)
        document.querySelectorAll('#dueAgingParties .aging-party').forEach(row => {
            row.style.display = row.textContent.toLowerCase().includes(searchTerm) ? '' : 'none';
        });
        
        const items = container.querySelectorAll('.history-item');
        
        if (items.length === 0) {
            this.renderDue();
            return;
        }
        
        let visibleCount = 0;
        
        items.forEach(item => {
            const itemText = item.textContent.toLowerCase();
            if (itemText.includes(searchTerm)) {
                item.style.display = '';
                visibleCount++;
            } else {
                item.style.display = 'none';
            }
        });
        
        let noResultsMsg = container.querySelector('.no-results-message');
        if (visibleCount === 0 && searchTerm !== '') {
            if (!noResultsMsg) {
                noResultsMsg = document.createElement('p');
                noResultsMsg.className = 'no-results-message';
                noResultsMsg.style.cssText = 'text-align: center; color: #888; margin-top: 40px;';
                noResultsMsg.textContent = t('ui.outstanding.no_matching');
                container.appendChild(noResultsMsg);
            }
        } else if (noResultsMsg) {
            noResultsMsg.remove();
        }
    }

    /**
     * Filter outstanding payments by type
     * @param {'purchase'|'sale'} filter - Type of transactions to show
     * @param {Event} [evt] - Optional click event for button styling
     */
    static filterDue(filter, evt) {
        AppState.currentDueFilter = filter;
        this.agingBucket = null;
        this.partyFilter = null;
        
        document.querySelectorAll('#due .filter-btn').forEach(btn => btn.classList.remove('active'));
        if (evt) evt.target.classList.add('active');
        
        const searchInput = document.getElementById("outstandingSearchInput");
        if (searchInput) searchInput.value = '';
        
        this.renderDue();
    }

    /**
     * Render due payments list
     * Shows outstanding amounts for purchases or sales based on filter
     */
    static renderDue() {
        const currentDueFilter = AppState.currentDueFilter;
        const purchaseHistory = AppState.purchaseHistory || [];
        const salesHistory = AppState.salesHistory || [];  // wholesale
        const retailSalesHistory = AppState.retailSalesHistory || [];  // retail
        const container = document.getElementById("dueList");
        
        const dueTransactions = [];
        
        if (currentDueFilter === 'purchase') {
            purchaseHistory.forEach(purchase => {
                const pay = readPayment(purchase);
                const duePaid = pay.due;
                
                if (duePaid > 0 && !purchase.cleared) {
                    const totalPayable = pay.total || openingAmount(purchase);
                    const onlinePaid = pay.online;
                    const cashPaid = pay.cash;
                    const totalPaid = pay.paid;
                    
                    dueTransactions.push({
                        ...purchase,
                        transactionType: 'purchase',
                        outstanding: duePaid,
                        totalAmount: totalPayable,
                        paidAmount: totalPaid,
                        onlinePaid: onlinePaid,
                        cashPaid: cashPaid
                    });
                }
            });
        } else if (currentDueFilter === 'sale') {
            // Only retail sales - wholesale dues are on wholesale page
            retailSalesHistory.forEach(sale => {
                const pay = readPayment(sale);
                const dueReceived = pay.due;
                
                if (dueReceived > 0 && !sale.cleared) {
                    const totalReceivable = sale.total || openingAmount(sale);
                    const onlineReceived = pay.online;
                    const cashReceived = pay.cash;
                    const totalReceived = pay.paid;
                    
                    dueTransactions.push({
                        ...sale,
                        transactionType: 'retail',
                        outstanding: dueReceived,
                        totalAmount: totalReceivable,
                        paidAmount: totalReceived,
                        onlineReceived: onlineReceived,
                        cashReceived: cashReceived
                    });
                }
            });
        }
        
        // Aging summary + per-party rows for the same bills (#46)
        const party = this.partyFilter;
        const partyBills = party ? dueTransactions.filter(t => normalizePartyName(t.customerName) === party.key) : dueTransactions;
        this.renderAging(partyBills, currentDueFilter === 'purchase' ? 'payable' : 'receivable');
        this.renderPartyFilterNote();
        const shownTransactions = filterBillsByBucket(partyBills, this.agingBucket);

        // Sort by date (newest first) - use timestamp if available, otherwise parse date
        shownTransactions.sort((a, b) => {
            const dateA = a.timestamp || parseAnyBillDate(a.date)?.getTime() || 0;
            const dateB = b.timestamp || parseAnyBillDate(b.date)?.getTime() || 0;
            return dateB - dateA;
        });
        
        if (shownTransactions.length === 0) {
            const message = t(partyBills.length > 0 ? 'ui.outstanding.no_bills_in_age_group'
                : party ? 'ui.outstanding.nothing_for_party'
                : currentDueFilter === 'purchase' ? 'ui.outstanding.no_purchase_due' : 'ui.outstanding.no_sale_due');
            container.innerHTML = `<p style="text-align: center; color: #888; margin-top: 40px;">${Helpers.escapeHtml(message)}</p>`;
            return;
        }

        container.innerHTML = "";
        
        const isPurchase = currentDueFilter === 'purchase';
        const headerColor = '#dc3545';
        const bgColor = '#d1ecf1';
        const borderColor = '#17a2b8';
        const tt = (key, params) => Helpers.escapeHtml(t(key, params));
        const totalLabel = tt(isPurchase ? 'ui.outstanding.total_payable' : 'ui.outstanding.total_receivable');
        const paidLabel = tt(isPurchase ? 'ui.outstanding.paid' : 'ui.outstanding.received');

        const today = new Date();
        shownTransactions.forEach(transaction => {
            const div = document.createElement("div");
            div.className = "history-item";
            div.setAttribute('data-type', transaction.transactionType);
            const billDate = billDateOf(transaction);
            const ageDays = billDate ? ageInDays(billDate, today) : null;
            const ageBadge = `<span class="aging-age aging-b${bucketIndex(ageDays)}">${tt(...ageKey(ageDays))}</span>`;
            
            const itemColor = transaction.transactionType === 'purchase' ? '#007bff' : '#28a745';
            const billNumber = transaction.billNumber || transaction.id?.toString().substring(0, 8) || 'N/A';
            
            div.innerHTML = `
                <div class="history-header">
                    <span style="cursor: pointer; color: ${itemColor}; text-decoration: underline;" onclick="window.app.outstanding.showDetails('${Helpers.escapeJsAttr(transaction.id)}', '${Helpers.escapeJsAttr(transaction.transactionType)}')">#${Helpers.escapeHtml(billNumber)}</span>${transaction.customerName ? `  <strong>${Helpers.escapeHtml(transaction.customerName)}</strong>` : ''}
                    <span style="color: ${headerColor}; font-weight: 700;">${tt('ui.outstanding.due_amount', { amount: Math.round(transaction.outstanding) })}</span>
                </div>
                <div class="history-date">${Helpers.formatDate(transaction.date)}${transaction.createdByName ? ` • ${tt('ui.outstanding.by')} <strong>${Helpers.escapeHtml(transaction.createdByName)}</strong>` : ''} ${ageBadge}</div>
                ${openingOldTotals(transaction) ? `<div class="history-date">${tt('ui.outstanding.opening_balance', { total: Math.round(openingOldTotals(transaction).total), paid: Math.round(openingOldTotals(transaction).paid) })}</div>` : ''}
                <div style="background: ${bgColor}; border-left: 4px solid ${borderColor}; padding: 12px; margin: 12px 0; border-radius: 4px;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                        <span>${totalLabel}:</span>
                        <strong>₹${Math.round(transaction.totalAmount)}</strong>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                        <span>${paidLabel}:</span>
                        <strong>₹${Math.round(transaction.paidAmount)}</strong>
                    </div>
                    <div style="display: flex; justify-content: space-between; border-top: 2px solid ${borderColor}; padding-top: 6px; margin-top: 6px;">
                        <span style="font-weight: 600;">${tt('ui.outstanding.outstanding_label')}</span>
                        <strong style="color: ${headerColor}; font-size: 16px;">₹${Math.round(transaction.outstanding)}</strong>
                    </div>
                    <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #ddd; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                        <label style="flex-shrink: 0;">${tt(isPurchase ? 'ui.outstanding.pay_label' : 'ui.outstanding.received_label')}</label>
                        <input type="number" inputmode="decimal" min="0" id="payment_${Helpers.escapeHtml(transaction.id)}" placeholder="${tt('ui.outstanding.cash_placeholder')}" aria-label="${tt('ui.outstanding.cash_amount')}" style="flex: 1; min-width: 80px; padding: 8px; border: 1px solid #ccc; border-radius: 4px;" />
                        <input type="number" inputmode="decimal" min="0" id="paymentOnline_${Helpers.escapeHtml(transaction.id)}" placeholder="${tt('ui.outstanding.online_placeholder')}" aria-label="${tt('ui.outstanding.online_amount')}" style="flex: 1; min-width: 80px; padding: 8px; border: 1px solid #ccc; border-radius: 4px;" />
                        <button data-record-payment onclick="window.app.outstanding.recordPayment('${Helpers.escapeJsAttr(transaction.id)}', '${Helpers.escapeJsAttr(transaction.transactionType)}')" style="background-color: #28a745; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: 600;">${tt('ui.outstanding.record')}</button>
                    </div>
                    <div style="margin-top: 8px;">
                        <button type="button" onclick="window.app.outstanding.markAsCleared('${Helpers.escapeJsAttr(transaction.id)}', '${Helpers.escapeJsAttr(transaction.transactionType)}')" style="background: white; color: #333; border: 1px solid #999; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-weight: 600;">${tt('ui.outstanding.mark_as_cleared')}</button>
                    </div>
                </div>
            `;
            
            container.appendChild(div);
        });
    }

    /** Selected aging bucket key (null = all) and party sort, kept while the tab is open. */
    static agingBucket = null;
    static agingSort = 'amount';
    static partiesOpen = true;

    /**
     * Aging panel above the bill list (#46): bucket totals (tap to filter),
     * who to chase first (receivables) and one row per party with
     * Remind / Statement actions (#77).
     * @param {Array<Object>} bills Open bills of the current filter
     * @param {'receivable'|'payable'} kind
     */
    static renderAging(bills, kind) {
        const el = document.getElementById('dueAging');
        if (!el) return;
        const aging = buildAging(bills);
        if (aging.count === 0) {
            el.innerHTML = '';
            return;
        }
        const isPayable = kind === 'payable';
        const esc = (v) => Helpers.escapeHtml(v);
        const attr = (v) => Helpers.escapeJsAttr(v);
        const tt = (key, params) => esc(t(key, params));
        const daysText = (d) => t(...ageKey(d));
        const billsText = (n) => t(n === 1 ? 'ui.outstanding.bills_one' : 'ui.outstanding.bills_many', { count: n });
        const partyName = (p) => (p.name ? esc(p.name) : `<em>${tt('ui.outstanding.no_name')}</em>`);

        const buckets = aging.buckets.map((b, i) => `
            <button type="button" class="aging-bucket aging-b${i}${this.agingBucket === b.key ? ' active' : ''}"
                aria-pressed="${this.agingBucket === b.key}"
                onclick="window.app.outstanding.setAgingBucket('${attr(b.key)}')">
                <span class="aging-bucket-label">${tt('ui.outstanding.bucket_days', { label: b.label })}</span>
                <strong class="aging-bucket-amount">${esc(formatINR(b.total))}</strong>
                <span class="aging-bucket-count">${esc(billsText(b.count))}</span>
            </button>`).join('');

        const chase = isPayable ? [] : chaseFirst(aging.parties);
        const chaseHtml = isPayable ? '' : `
            <div class="aging-chase">
                <div class="aging-subtitle">${tt('ui.outstanding.who_to_chase')}</div>
                ${chase.length ? `<ol>${chase.map(p => `
                    <li class="aging-b${p.bucket}"><strong>${partyName(p)}</strong> — ${esc(formatINR(p.total))}
                        <span class="aging-age aging-b${p.bucket}">${tt('ui.outstanding.oldest', { age: daysText(p.oldestDays) })}</span></li>`).join('')}</ol>`
                    : `<div class="aging-empty">${tt('ui.outstanding.no_one_owes')}</div>`}
            </div>`;

        const parties = sortParties(aging.parties, this.agingSort)
            .filter(p => !this.agingBucket || p.bills.some(b => AGING_BUCKETS[b.bucket].key === this.agingBucket));
        const rows = parties.map(p => `
            <div class="aging-party aging-b${p.bucket}">
                <div class="aging-party-main">
                    <div class="aging-party-name">${partyName(p)}${p.longOverdue ? ` <span class="aging-badge">${tt('ui.outstanding.long_overdue')}</span>` : ''}</div>
                    <div class="aging-party-meta">${esc(billsText(p.bills.length))} · ${tt('ui.outstanding.oldest', { age: daysText(p.oldestDays) })}</div>
                </div>
                <strong class="aging-party-total">${esc(formatINR(p.total))}</strong>
                <div class="aging-party-actions">
                    ${isPayable ? '' : `<button type="button" class="aging-btn aging-remind" onclick="window.app.outstanding.sendReminder('${attr(p.key)}')">${tt('ui.outstanding.remind')}</button>`}
                    <button type="button" class="aging-btn" onclick="window.app.outstanding.printStatement('${attr(p.key)}')">${tt('ui.outstanding.statement')}</button>
                </div>
            </div>`).join('');

        const sortBtn = (by, label) => `<button type="button" class="aging-sort-btn${this.agingSort === by ? ' active' : ''}" aria-pressed="${this.agingSort === by}" onclick="window.app.outstanding.setAgingSort('${by}')">${label}</button>`;

        el.innerHTML = `
            <div class="aging-panel">
                <div class="aging-head">
                    <span class="aging-title">${tt(isPayable ? 'ui.outstanding.payables_by_age' : 'ui.outstanding.receivables_by_age')}</span>
                    <strong class="aging-total">${esc(formatINR(aging.total))}</strong>
                </div>
                <div class="aging-buckets">${buckets}</div>
                ${this.agingBucket ? `<div class="aging-filter-note">${tt('ui.outstanding.one_age_group')}</div>` : ''}
                ${chaseHtml}
                <details class="aging-parties"${this.partiesOpen ? ' open' : ''} ontoggle="window.app?.outstanding?.setPartiesOpen(this.open)">
                    <summary>${tt('ui.outstanding.by_party', { count: parties.length })}</summary>
                    <div class="aging-sort">${tt('ui.outstanding.sort')} ${sortBtn('amount', tt('ui.outstanding.sort_amount'))} ${sortBtn('age', tt('ui.outstanding.sort_oldest'))}</div>
                    <div id="dueAgingParties">${rows}</div>
                </details>
                <div class="aging-subtitle aging-bills-title">${tt('ui.outstanding.bills_title')}</div>
            </div>`;
    }

    /** Tap a bucket to show only its bills/parties; tap again for all. */
    static setAgingBucket(key) {
        this.agingBucket = this.agingBucket === key ? null : key;
        this.renderDue();
    }

    /** Party opened from a bill's "Already owes" line (#166): {key, name} or null. */
    static partyFilter = null;

    /**
     * Open Outstanding showing only one party's open bills.
     * @param {'purchase'|'sale'} filter
     * @param {string} name Party name as typed on the bill
     */
    static showParty(filter, name) {
        const key = normalizePartyName(name);
        this.filterDue(filter === 'purchase' ? 'purchase' : 'sale');
        document.querySelectorAll('#due .filter-btn').forEach(btn => {
            btn.classList.toggle('active', btn.classList.contains(filter === 'purchase' ? 'filter-purchase' : 'filter-sale'));
        });
        if (!key) return;
        this.partyFilter = { key, name: String(name).trim() };
        this.renderDue();
    }

    static clearPartyFilter() {
        this.partyFilter = null;
        this.renderDue();
    }

    static renderPartyFilterNote() {
        const el = document.getElementById('dueAging');
        if (!el || !this.partyFilter) return;
        el.insertAdjacentHTML('afterbegin', `
            <div class="party-filter-note">
                <span>${Helpers.escapeHtml(t('ui.outstanding.showing_only'))} <strong>${Helpers.escapeHtml(this.partyFilter.name)}</strong></span>
                <button type="button" class="aging-btn" onclick="window.app.outstanding.clearPartyFilter()">${Helpers.escapeHtml(t('ui.outstanding.show_all'))}</button>
            </div>`);
    }

    static setAgingSort(by) {
        this.agingSort = by === 'age' ? 'age' : 'amount';
        this.renderDue();
    }

    static setPartiesOpen(open) {
        this.partiesOpen = !!open;
    }

    /**
     * A party's open bills on the current Outstanding filter, aged now.
     * @param {string} partyKey normalized name
     * @returns {{party: ?Object, kind: 'receivable'|'payable'}}
     */
    static findParty(partyKey) {
        const kind = AppState.currentDueFilter === 'purchase' ? 'payable' : 'receivable';
        const bills = kind === 'payable' ? AppState.purchaseHistory : AppState.retailSalesHistory;
        const party = buildAging(bills).parties.find(p => p.key === String(partyKey ?? '')) || null;
        return { party, kind };
    }

    /** Shop details for messages/statements, when set in settings. */
    static shopDetails() {
        const s = AppState.settings || {};
        return { shopName: s.shopName || '', upiId: s.upiId || '' };
    }

    /**
     * Opens WhatsApp with a polite bilingual reminder of the party's open
     * bills (#77): straight to their chat when a phone is on their bills,
     * otherwise the share sheet / WhatsApp contact picker.
     */
    static async sendReminder(partyKey) {
        const { party } = this.findParty(partyKey);
        if (!party) {
            UIManager.showToast(t('msg.outstanding.nothing_due_from_party'));
            return false;
        }
        const text = buildReminderText(party, this.shopDetails());
        const phone = normalizePhone(party.phone);
        try {
            if (!phone && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
                try {
                    await navigator.share({ text });
                    return true;
                } catch (e) {
                    if (e && e.name === 'AbortError') return false;
                    // Share sheet unavailable: fall back to WhatsApp
                }
            }
            openExternal(whatsAppReminderUrl(text, phone));
            return true;
        } catch (error) {
            console.error('Could not open WhatsApp:', error);
            UIManager.showToast(t('msg.common.could_not_open_whatsapp'));
            return false;
        }
    }

    /** Read-only statement of the party's open bills, printed or shown as an image (#77). */
    static async printStatement(partyKey) {
        const { party, kind } = this.findParty(partyKey);
        if (!party) {
            UIManager.showToast(t('msg.outstanding.nothing_due_party'));
            return false;
        }
        const statement = buildStatement(party, { kind, shopName: this.shopDetails().shopName });
        return PrinterService.printStatement(statement);
    }

    static async recordPayment(transactionId, transactionType) {
        // Cash and online parts (#107): only the cash part reaches the drawer
        const paymentInput = document.getElementById(`payment_${transactionId}`);
        const onlineInput = document.getElementById(`paymentOnline_${transactionId}`);
        const cash = Number(paymentInput?.value) || 0;
        const online = Number(onlineInput?.value) || 0;
        const entryId = this.paymentEntryId(paymentInput, `${round2(cash)}|${round2(online)}`);
        const ok = await this.recordDuePayment({ billType: transactionType, billId: transactionId, cash, online, entryId });
        if (ok) {
            this.clearPaymentEntryId(paymentInput);
            if (paymentInput) paymentInput.value = '';
            if (onlineInput) onlineInput.value = '';
        }
    }

    /**
     * Id for the payment typed in `input`: kept while the same amount is retried,
     * so a retry after a timeout cannot record the payment twice (#70).
     * @param {HTMLInputElement|null} input
     * @param {number|string} amountKey
     * @returns {string}
     */
    static paymentEntryId(input, amountKey) {
        if (!input) return Helpers.generateId();
        if (!input.dataset.paymentId || input.dataset.paymentAmount !== String(amountKey)) {
            input.dataset.paymentId = Helpers.generateId();
            input.dataset.paymentAmount = String(amountKey);
        }
        return input.dataset.paymentId;
    }

    /** Forget the retry id once the payment is recorded. */
    static clearPaymentEntryId(input) {
        if (!input) return;
        delete input.dataset.paymentId;
        delete input.dataset.paymentAmount;
    }

    /** Bill of a type ('purchase' | 'retail' | 'wholesale') from AppState. */
    static findBill(billType, billId) {
        const list = billType === 'purchase' ? AppState.purchaseHistory
            : billType === 'retail' ? AppState.retailSalesHistory
                : AppState.salesHistory;
        return (list || []).find(b => String(b.id) === String(billId)) || null;
    }

    /**
     * The one way to record a due payment (#98), used by Outstanding and the
     * Cash tab: reduces the bill's due (payment.due + dueAmount + payments[])
     * and, when a cash session is open today, adds the payment to it as a
     * drawer leg — all in one transaction.
     * @param {Object} args
     * @param {'purchase'|'retail'|'wholesale'} args.billType
     * @param {string} args.billId
     * @param {number} args.cash Cash part
     * @param {number} [args.online=0] Online part
     * @param {string} [args.note]
     * @param {string} [args.entryId] Payment id reused when the same payment is retried (#70)
     * @returns {Promise<boolean>} true when recorded
     */
    static async recordDuePayment(args) {
        // One payment at a time: a double tap on Record saves one payment (#70)
        const ok = await Helpers.runExclusive('due-payment', RECORD_PAYMENT_BUTTONS, () => this._recordDuePayment(args));
        return ok === true;
    }

    static async _recordDuePayment({ billType, billId, cash, online = 0, note = '', clear = false, entryId = null }) {
        let run = null;
        try {
            const transaction = this.findBill(billType, billId);
            if (!transaction) {
                UIManager.showToast(t('msg.outstanding.error_transaction_not_found'));
                return false;
            }

            const outstanding = readPayment(transaction).due;
            const split = checkPaymentSplit(cash, online, outstanding, PAYMENT_TOLERANCE);
            if (!split.ok) {
                UIManager.showToast(split.error === 'exceeds-due'
                    ? t('msg.common.payment_amount_exceeds_outstanding_amount')
                    : t('msg.common.enter_valid_payment_amount'));
                return false;
            }

            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                UIManager.showToast(t('msg.common.internet_required_record_payment'));
                return false;
            }

            const entry = {
                amount: split.total,
                date: Helpers.getCurrentDateTime(),
                recordedBy: AppState.userName || (AppState.currentUser ? AppState.currentUser.email : 'Unknown')
            };
            if (note) entry.note = note;
            if (entryId) entry.id = entryId;

            // Server-side read-modify-write so concurrent payments from two devices can't overwrite each other
            if (clear) entry.settlesDue = true;
            run = tip.start('PaymentRecord', { flags: { billType, clear: !!clear, split: split.cash > 0 && split.online > 0 } });
            this.lastPaymentTip = null;
            const written = await this.applyPaymentTransaction(billType, transaction, { cash: split.cash, online: split.online }, entry, { clear });
            Object.assign(transaction, written);
            try {
                const info = this.lastPaymentTip || {};
                run.complete(paymentRecordProps(info.fresh || null, written, info));
            } catch (_) { /* TIP never breaks a payment */ }

            this.refreshAfterPayment();

            // Log audit entry
            await AuditService.log(AuditService.ACTIONS.UPDATE_PAYMENT, {
                billNumber: transaction.billNumber || 'N/A',
                paymentAmount: split.total,
                cash: split.cash,
                online: split.online,
                transactionType: billType,
                customer: transaction.customerName || transaction.customer || transaction.supplier || 'N/A'
            });

            UIManager.showToast(clear ? t(split.online > 0 ? 'msg.outstanding.due_cleared_online' : 'msg.outstanding.due_cleared_cash', { total: split.total }) : t('msg.outstanding.payment_recorded', { total: split.total }));
            UIManager.hapticFeedback('light');
            return true;
        } catch (error) {
            console.error('Error recording payment:', error);
            try {
                const outcome = paymentErrorOutcome(error, OutstandingManager.isOfflineError(error));
                if (run && outcome === 'fail') run.completeAndFail('tx_error', { code: String(error?.code || 'unknown').slice(0, 40) });
                else run?.discard();
            } catch (_) { /* TIP never breaks a payment */ }
            if (error && error.code === 'exceeds-due') {
                UIManager.showToast(t('msg.common.payment_amount_exceeds_outstanding_amount_2', { due: error.due }));
                this.renderDue();
            } else if (OutstandingManager.isOfflineError(error)) {
                UIManager.showToast(t('msg.common.internet_required_record_payment'));
            } else {
                UIManager.showToast(t('msg.common.error', { message: error.message }));
            }
            return false;
        }
    }

    /** Re-render every screen that shows dues or today's money. */
    static refreshAfterPayment() {
        this.renderDue();
        const app = typeof window !== 'undefined' ? window.app : null;
        try {
            app?.wholesaleSales?.renderOutstanding?.();
            if (document.getElementById('todayTotalIn')) app?.day?.loadTodayData?.();
            if (CashManagementManager.todaySession) {
                CashManagementManager.calculateTodayTransactions()
                    .then(() => CashManagementManager.updateUI())
                    .catch(e => console.error('Cash refresh after payment failed:', e));
            }
        } catch (e) {
            console.error('Refresh after payment failed:', e);
        }
    }

    static isOfflineError(error) {
        if (!error) return false;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
        const msg = String(error.message || '').toLowerCase();
        return error.code === 'unavailable' || msg.includes('offline') || msg.includes('network');
    }

    /**
     * Today's open cash session, if any (one small query when the Cash tab
     * hasn't loaded it). Failures just mean "no drawer leg".
     * @returns {Promise<?string>} session id
     */
    static async findOpenSessionId() {
        const today = todayLocalISO();
        const local = CashManagementManager.todaySession;
        if (local && local.date === today) return local.signedOut ? null : String(local.id);
        try {
            const sessions = await FirebaseService.loadCashSessionsForDate(today);
            const open = sessions.find(s => !s.signedOut);
            return open ? String(open.id) : null;
        } catch (e) {
            console.warn('Could not look up today\'s cash session:', e?.message || e);
            return null;
        }
    }

    /**
     * Record a payment against a bill inside a Firestore transaction.
     * Re-reads the bill from the server, recomputes due from the fresh doc and
     * writes only payment fields (payment.*, payments[], and dueAmount if
     * present). When today's cash session is open, the same payment (same id)
     * is added to its duePayments in the same transaction.
     * @param {string} transactionType 'purchase' | 'retail' | 'wholesale'
     * @param {Object} bill
     * @param {number|{cash: number, online: number}} amount A number = all cash
     * @param {Object} entry payments[] entry (amount/date/recordedBy…)
     * @returns {Promise<Object>} The bill fields written (for patching local state)
     */
    static async applyPaymentTransaction(transactionType, bill, amount, entry, { clear = false } = {}) {
        const parts = typeof amount === 'number' ? { cash: amount, online: 0 } : amount;
        const cash = round2(parts.cash || 0);
        const online = round2(parts.online || 0);
        const total = round2(cash + online);
        const at = Date.now();
        const fullEntry = {
            ...entry,
            id: entry.id || Helpers.generateId(),
            amount: total,
            cash,
            online,
            at,
            recordedById: AppState.currentUser ? AppState.currentUser.uid : 'unknown'
        };

        const sessionId = await this.findOpenSessionId();
        const sessionRef = sessionId ? FirebaseService.cashSessionRef(sessionId) : null;
        const today = todayLocalISO();
        let legWritten = null;
        let tipInfo = null;

        const written = await this.withBillRef(transactionType, bill, (db, ref) => db.runTransaction(async (tx) => {
            legWritten = null;
            tipInfo = null;
            const snap = await tx.get(ref);
            const sessionSnap = sessionRef ? await tx.get(sessionRef) : null;
            if (!snap.exists) return null;
            const fresh = snap.data() || {};
            const pay = readPayment(fresh);
            const entries = Array.isArray(fresh.payments) ? fresh.payments : [];
            const openSession = sessionSnap && sessionSnap.exists ? sessionSnap.data() : null;
            tipInfo = { fresh, sessionOpen: !!(openSession && !openSession.signedOut && openSession.date === today), retried: false };

            // A retry of a payment that already reached the server: nothing to add (#70)
            if (entry?.id && entries.some(p => p && p.id === entry.id)) {
                tipInfo.retried = true;
                const current = { payment: fresh.payment, payments: entries, openDue: fresh.openDue };
                if (Object.prototype.hasOwnProperty.call(fresh, 'dueAmount')) current.dueAmount = fresh.dueAmount;
                return current;
            }

            if (total > pay.due + PAYMENT_TOLERANCE) {
                const err = new Error('Payment amount exceeds outstanding amount');
                err.code = 'exceeds-due';
                err.due = pay.due;
                throw err;
            }

            const newCash = round2(pay.cash + cash);
            const newOnline = round2(pay.online + online);
            let newDue = round2(pay.due - total);
            if (newDue < PAYMENT_TOLERANCE) newDue = 0;

            const update = {
                payment: {
                    ...(fresh.payment && typeof fresh.payment === 'object' ? fresh.payment : {}),
                    online: newOnline,
                    cash: newCash,
                    due: newDue,
                    total: round2(newOnline + newCash)
                },
                payments: [...(Array.isArray(fresh.payments) ? fresh.payments : []), fullEntry]
            };
            if (Object.prototype.hasOwnProperty.call(fresh, 'dueAmount')) {
                update.dueAmount = newDue;
            }
            // "Mark as cleared" with cash/online: the payment settles the whole due
            if (clear && newDue === 0) Object.assign(update, this.clearedFields());
            update.openDue = FirebaseService.billHasOpenDue(COLLECTION_BY_TYPE[transactionType] || 'wholesaleSales', { ...fresh, ...update });
            update.clientVersion = FirebaseService.CLIENT_VERSION;
            tx.update(ref, update);

            const session = sessionSnap && sessionSnap.exists ? sessionSnap.data() : null;
            if (session && !session.signedOut && session.date === today) {
                const leg = {
                    id: fullEntry.id,
                    billId: String(fresh.id ?? bill.id),
                    billType: transactionType,
                    billNumber: fresh.billNumber || bill.billNumber || '',
                    type: directionFor(transactionType),
                    customer: fresh.customerName || bill.customerName || 'N/A',
                    amount: total,
                    cash,
                    online,
                    // Older app versions count only method 'cash' legs (by amount)
                    method: cash > 0 && online > 0 ? 'split' : (cash > 0 ? 'cash' : 'online'),
                    notes: entry.note || '',
                    timestamp: new Date(at).toISOString(),
                    recordedBy: fullEntry.recordedBy || 'Unknown'
                };
                tx.update(sessionRef, { duePayments: [...(Array.isArray(session.duePayments) ? session.duePayments : []), leg] });
                legWritten = leg;
            }
            return update;
        }));

        const local = CashManagementManager.todaySession;
        if (legWritten && local && String(local.id) === sessionId) {
            local.duePayments = [...(local.duePayments || []).filter(l => l.id !== legWritten.id), legWritten];
        }
        this.lastPaymentTip = tipInfo ? { ...tipInfo, legWritten: !!legWritten } : null;
        return written;
    }

    /**
     * Runs `run(db, ref)` on the bill's document; FirebaseService saves bills
     * at doc(String(bill.id)), but legacy docs may only carry an `id` field,
     * so a null result retries once with the doc found by that field.
     * @returns {Promise<Object>} run's result
     */
    static async withBillRef(transactionType, bill, run) {
        const db = FirebaseService.db;
        const coll = db.collection(colName(COLLECTION_BY_TYPE[transactionType] || 'wholesaleSales'));
        let ref = coll.doc(String(bill.id));
        for (let attempt = 0; attempt < 2; attempt++) {
            const written = await run(db, ref);
            if (written) return written;
            if (attempt === 0) {
                const snap = await coll.where('id', '==', bill.id).limit(2).get();
                if (snap.size !== 1) break;
                ref = snap.docs[0].ref;
            }
        }
        throw new Error('Transaction not found');
    }

    /**
     * "Mark as cleared" (#104): asks how the remaining due was settled —
     * received in cash, received online, or written off (reason required) —
     * and records it. Never zeroes a due silently.
     * @param {string} transactionId
     * @param {'purchase'|'retail'|'wholesale'} transactionType
     * @returns {Promise<boolean>} true when the bill was cleared
     */
    static async markAsCleared(transactionId, transactionType) {
        const transaction = this.findBill(transactionType, transactionId);
        if (!transaction) {
            UIManager.showToast(t('msg.outstanding.error_transaction_not_found'));
            return false;
        }
        const due = readPayment(transaction).due;
        if (due <= PAYMENT_TOLERANCE) {
            UIManager.showToast(t('msg.outstanding.nothing_due_on_bill'));
            return false;
        }

        const isPurchase = transactionType === 'purchase';
        const esc = (v) => Helpers.escapeHtml(v);
        const party = transaction.customerName ? ` — ${Helpers.escapeHtml(transaction.customerName)}` : '';
        const html = `
            <div style="text-align: left;">
                <div style="margin-bottom: 10px;">${esc(t('ui.outstanding.bill_no', { billNumber: transaction.billNumber || String(transaction.id).slice(0, 8) }))}${party}<br>
                    ${esc(t('ui.outstanding.remaining_due'))} <strong>₹${Helpers.escapeHtml(due)}</strong></div>
                <div style="margin-bottom: 6px; font-weight: 600;">${esc(t('ui.outstanding.how_settled'))}</div>
                <label style="display: block; margin: 4px 0;"><input type="radio" name="clearMethod" value="cash"> ${esc(t(isPurchase ? 'ui.outstanding.paid_in_cash' : 'ui.outstanding.received_in_cash', { amount: due }))}</label>
                <label style="display: block; margin: 4px 0;"><input type="radio" name="clearMethod" value="online"> ${esc(t(isPurchase ? 'ui.outstanding.paid_online' : 'ui.outstanding.received_online', { amount: due }))}</label>
                <label style="display: block; margin: 4px 0;"><input type="radio" name="clearMethod" value="writeOff"> ${esc(t(isPurchase ? 'ui.outstanding.write_off_not_paid' : 'ui.outstanding.write_off_not_received'))}</label>
                <div style="margin-top: 8px;">${esc(t('ui.outstanding.write_off_reason'))}</div>
                <textarea id="clearReason" rows="2" maxlength="300" style="width: 100%; box-sizing: border-box; padding: 6px;"></textarea>
            </div>`;
        const confirmed = await UIManager.showModalWithHtml(html, t('msg.outstanding.mark_as_cleared'), true);
        if (!confirmed) return false;

        const method = document.querySelector('input[name="clearMethod"]:checked')?.value || '';
        const reason = (document.getElementById('clearReason')?.value || '').trim();
        if (!method) {
            UIManager.showToast(t('msg.outstanding.choose_how_due_was_settled'));
            return false;
        }
        if (method === 'writeOff' && reason.length < 3) {
            UIManager.showToast(t('msg.outstanding.write_reason_write_off'));
            return false;
        }

        if (method === 'cash' || method === 'online') {
            return this.recordDuePayment({
                billType: transactionType,
                billId: transactionId,
                cash: method === 'cash' ? due : 0,
                online: method === 'online' ? due : 0,
                note: reason,
                clear: true
            });
        }

        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            UIManager.showToast(t('msg.outstanding.internet_required_clear_due'));
            return false;
        }
        try {
            const written = await this.applyWriteOffTransaction(transactionType, transaction, reason);
            Object.assign(transaction, written);
            this.refreshAfterPayment();
            await AuditService.log(AuditService.ACTIONS.CLEAR_DUE, {
                billNumber: transaction.billNumber || 'N/A',
                transactionType,
                method: 'writeOff',
                amount: written.payment?.writtenOff,
                reason,
                customer: transaction.customerName || 'N/A'
            });
            UIManager.hapticFeedback('light');
            UIManager.showToast(t('msg.outstanding.due_written_off'));
            return true;
        } catch (error) {
            console.error('Error writing off due:', error);
            UIManager.showToast(OutstandingManager.isOfflineError(error) ? t('msg.outstanding.internet_required_clear_due') : t('msg.common.error', { message: error.message }));
            return false;
        }
    }

    /** Who/when fields for a cleared bill (all allowed bookkeeping fields in firestore.rules). */
    static clearedFields() {
        return {
            cleared: true,
            clearedAt: Helpers.getCurrentDateTime(),
            clearedBy: AppState.currentUser ? AppState.currentUser.uid : 'unknown',
            clearedByName: AppState.userName || (AppState.currentUser ? AppState.currentUser.email : 'Unknown')
        };
    }

    /**
     * Write off the remaining due in one transaction: both due fields to 0,
     * payment.writtenOff raised by the amount, and a payments[] entry
     * { kind: 'writeOff', amount, reason, who, when } — never counted as money.
     * @returns {Promise<Object>} fields written
     */
    static async applyWriteOffTransaction(transactionType, bill, reason) {
        return this.withBillRef(transactionType, bill, (db, ref) => db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists) return null;
            const fresh = snap.data() || {};
            const pay = readPayment(fresh);
            const amount = pay.due > PAYMENT_TOLERANCE ? pay.due : 0;
            const base = fresh.payment && typeof fresh.payment === 'object' ? fresh.payment : {};
            const update = {
                payment: {
                    ...base,
                    cash: pay.cash,
                    online: pay.online,
                    due: 0,
                    writtenOff: round2((Number(base.writtenOff) || 0) + amount)
                },
                ...this.clearedFields()
            };
            if (amount > 0) {
                const by = this.clearedFields();
                update.payments = [...(Array.isArray(fresh.payments) ? fresh.payments : []), {
                    id: Helpers.generateId(),
                    kind: 'writeOff',
                    amount,
                    reason,
                    date: by.clearedAt,
                    at: Date.now(),
                    recordedBy: by.clearedByName,
                    recordedById: by.clearedBy
                }];
            }
            if (Object.prototype.hasOwnProperty.call(fresh, 'dueAmount')) update.dueAmount = 0;
            update.openDue = false;
            update.clientVersion = FirebaseService.CLIENT_VERSION;
            tx.update(ref, update);
            return update;
        }));
    }

    static async showDetails(transactionId, transactionType) {
        if (transactionType === 'purchase') {
            const purchaseIndex = AppState.purchaseHistory.findIndex(b => String(b.id) === String(transactionId));
            if (purchaseIndex >= 0) {
                await window.app.history.viewBill(purchaseIndex, 'purchase');
            } else {
                UIManager.showModal(t('msg.outstanding.purchase_not_found'));
            }
        } else if (transactionType === 'retail') {
            const saleIndex = AppState.retailSalesHistory.findIndex(s => String(s.id) === String(transactionId));
            if (saleIndex >= 0) {
                await window.app.history.viewBill(saleIndex, 'retail');
            } else {
                UIManager.showModal(t('msg.outstanding.retail_sale_not_found'));
            }
        } else {
            // wholesale
            const saleIndex = AppState.salesHistory.findIndex(s => String(s.id) === String(transactionId));
            if (saleIndex >= 0) {
                await window.app.wholesaleSales.reprintSale(saleIndex);
            } else {
                UIManager.showModal(t('msg.common.sale_not_found'));
            }
        }
    }
}
