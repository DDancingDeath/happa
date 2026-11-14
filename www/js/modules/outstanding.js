/**
 * @fileoverview Outstanding Payments Module
 * Handles tracking and managing due payments for purchases and sales
 * Provides filtering, search, and payment clearing functionality
 * @module modules/outstanding
 */

import { AppState } from '../utils/state.js';
import { on, REFRESH } from '../utils/events.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { readBillFromServer, updateBillInTransaction, updateBillsInTransaction } from '../firebase/repos/bill-payments.js';
import { Helpers } from '../utils/helpers.js';
import { AuditService } from '../services/audit.js';
import {
    isRetryOf, paymentEntryOf, paymentIntentIds, paymentIntentKey, paymentOutcomeUnknown, pendingPaymentIntent, settlePaymentIntent
} from '../services/payment-intents.js';
import { formatAmount, formatRupees, isActiveBill, isOpeningRecord, openingOldTotals, outstandingDue, readPayment, round2, sumMoney } from '../utils/money.js';
import { formatDayTime, parseAnyBillDate, startOfLocalDay, todayLocalISO } from '../utils/dates.js';
import { directionFor, duePaymentUpdate, partyDues, settleDueUpdate } from '../utils/due-payments.js';
import { allocateOldestFirst, checkAllocation, hasPaise, validateDuePayment } from '../utils/calc/billing.js';
import { CashManagementManager } from './cash-management.js';
import { PrinterService } from '../services/printer.js';
import { openExternal } from '../utils/open-external.js';
import { billDateOf } from '../utils/history-filters.js';
import { getLang, t } from '../i18n/index.js';
import { byNameHtml } from '../ui/bill-row.js';
import { tip } from '../tip/index.js';
import { track } from '../services/usage.js';
import { paymentRecordProps, paymentErrorOutcome } from '../tip/scenarios/payment-record.js';
import { refusedForClock } from '../utils/clock-skew.js';
import { icon } from '../ui/icons.js';
import { moneyHtml, emptyState } from '../ui/components.js';

/** i18n key + params for a bill age in days (null = unknown). */
function ageKey(days) {
    if (days === null) return ['ui.outstanding.date_unknown'];
    if (days === 0) return ['ui.outstanding.today'];
    return [days === 1 ? 'ui.outstanding.day_one' : 'ui.outstanding.days_many', { count: days }];
}
import {
    AGING_BUCKETS, DUE_FILTERS, ageInDays, bucketIndex, buildAging, chaseFirst, dueRows, filterBillsByBucket, sortParties
} from '../utils/aging.js';
import { partyNameKey } from '../utils/parties.js';
import { can } from '../utils/role-access.js';
import {
    buildReminderText, buildStatement, normalizePhone, whatsAppReminderUrl
} from '../utils/due-reminder.js';

const PAYMENT_TOLERANCE = 0.01;
/** Most bills one party payment is spread over (oldest first), as Complete all due. */
const PARTY_PAY_MAX = 100;
/** ₹ with paise only when there are any (party payment dialog: old dues may carry paise). */
const paiseText = (v) => formatRupees(v, { decimals: hasPaise(v) ? 2 : 0 });
const COLLECTION_BY_TYPE = { purchase: 'purchases', retail: 'retailSales', wholesale: 'wholesaleSales' };
/** Aging panel title of each receivables list (#125). */
const RECEIVABLE_TITLE = { retail: 'ui.outstanding.retail_by_age', wholesale: 'ui.outstanding.wholesale_by_age' };

/** Record / Mark cleared buttons disabled while a due payment is being saved (#70, #95) */
const RECORD_PAYMENT_BUTTONS = '[data-record-payment], [data-mark-cleared], [data-write-off]';

/** Age tag tone per aging bucket: ink, amber after 30 days, red after 90 (DIRECTION 3.1). */
const AGE_TONE = ['', ' warn', ' warn', ' neg'];
const AGE_TEXT_TONE = ['', ' tone-warn', ' tone-warn', ' tone-neg'];

/** Translated text that holds formatRupees(amount), with that figure drawn by moneyHtml(); the text is unchanged. */
function withMoney(text, amount) {
    const s = String(text ?? '');
    const figure = formatRupees(amount);
    const i = s.indexOf(figure);
    if (i < 0) return Helpers.escapeHtml(s);
    return `${Helpers.escapeHtml(s.slice(0, i))}${moneyHtml(amount)}${Helpers.escapeHtml(s.slice(i + figure.length))}`;
}

/** Up to two initials of a party name for its avatar (drawn by CSS, so not part of the row's text). */
function initials(name) {
    return String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
        .map(w => Array.from(w)[0].toUpperCase()).join('');
}

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
                noResultsMsg.className = 'no-results-message empty';
                noResultsMsg.textContent = t('ui.outstanding.no_matching');
                container.appendChild(noResultsMsg);
            }
        } else if (noResultsMsg) {
            noResultsMsg.remove();
        }
    }

    /**
     * Filter outstanding payments by type (#125): Purchases, or Sales with All /
     * Retail / Wholesale (wholesale only for roles that may open Wholesale).
     * @param {'purchase'|'sale'|'retail'|'wholesale'} filter
     */
    static filterDue(filter) {
        AppState.currentDueFilter = DUE_FILTERS.includes(filter) ? filter : 'purchase';
        this.agingBucket = null;
        this.partyFilter = null;
        
        const searchInput = document.getElementById("outstandingSearchInput");
        if (searchInput) searchInput.value = '';
        
        this.renderDue();
    }

    /** Whether this role sees wholesale dues here (the Wholesale page's switch). */
    static seesWholesale() {
        return can(AppState.userRole, 'wholesale', AppState.settings?.roleAccess);
    }

    /** The list shown: 'retail' / 'wholesale' collapse to 'sale' for a role without Wholesale. */
    static dueFilter() {
        const f = DUE_FILTERS.includes(AppState.currentDueFilter) ? AppState.currentDueFilter : 'purchase';
        return f === 'wholesale' && !this.seesWholesale() ? 'sale' : f;
    }

    /** Purchases | Sales buttons, and All / Retail / Wholesale under Sales. */
    static syncFilterButtons(filter = this.dueFilter()) {
        const sale = filter !== 'purchase';
        const set = (btn, on) => { btn.classList.toggle('active', on); btn.setAttribute('aria-pressed', String(on)); };
        document.querySelectorAll('#due .filter-purchase').forEach(btn => set(btn, !sale));
        document.querySelectorAll('#due .filter-sale').forEach(btn => set(btn, sale));
        const kinds = document.getElementById('dueSaleKinds');
        if (kinds) kinds.hidden = !sale || !this.seesWholesale();
        document.querySelectorAll('#dueSaleKinds [data-due-kind]').forEach(btn => set(btn, btn.dataset.dueKind === filter));
        const search = document.getElementById('outstandingSearchInput');
        if (search) {
            const key = sale ? 'ui.outstanding.search_customer_name_id' : 'ui.outstanding.search_supplier_name_id';
            search.dataset.i18nPlaceholder = key;
            search.dataset.i18nAriaLabel = key;
            search.placeholder = t(key);
            search.setAttribute('aria-label', t(key));
        }
    }

    /**
     * Render due payments list
     * Shows outstanding amounts for purchases or sales based on filter
     */
    static renderDue() {
        // Outstanding loads on first visit (#66): nothing to draw before then
        if (!document.getElementById("dueList")) return;
        const currentDueFilter = this.dueFilter();
        const container = document.getElementById("dueList");
        this.syncFilterButtons(currentDueFilter);
        // BILL-DUE of each open bill (voided and cleared bills owe nothing, #75)
        const dueTransactions = dueRows({
            purchases: AppState.purchaseHistory, retailSales: AppState.retailSalesHistory, wholesaleSales: AppState.salesHistory
        }, currentDueFilter, { wholesale: this.seesWholesale() });
        
        // Aging summary + per-party rows for the same bills (#46)
        const party = this.partyFilter;
        const partyBills = party ? dueTransactions.filter(t => partyNameKey(t.customerName) === party.key) : dueTransactions;
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
                : currentDueFilter === 'purchase' ? 'ui.outstanding.no_purchase_due'
                : currentDueFilter === 'retail' ? 'ui.outstanding.no_retail_due'
                : currentDueFilter === 'wholesale' ? 'ui.outstanding.no_wholesale_due' : 'ui.outstanding.no_sale_due');
            container.innerHTML = emptyState({ icon: 'wallet', title: message });
            return;
        }

        container.innerHTML = "";
        
        const isPurchase = currentDueFilter === 'purchase';
        const tt = (key, params) => Helpers.escapeHtml(t(key, params));
        const totalLabel = tt(isPurchase ? 'ui.outstanding.total_payable' : 'ui.outstanding.total_receivable');
        const paidLabel = tt(isPurchase ? 'ui.outstanding.paid' : 'ui.outstanding.received');

        const today = startOfLocalDay();
        shownTransactions.forEach(transaction => {
            const div = document.createElement("div");
            div.className = "history-item due-bill";
            div.setAttribute('data-type', transaction.transactionType);
            const billDate = billDateOf(transaction);
            const ageDays = billDate ? ageInDays(billDate, today) : null;
            const bucket = bucketIndex(ageDays);
            const ageBadge = `<span class="aging-age tag${Helpers.escapeHtml(AGE_TONE[bucket])} aging-b${Number(bucket)}">${tt(...ageKey(ageDays))}</span>`;
            
            const billNumber = transaction.billNumber || transaction.id?.toString().substring(0, 8) || 'N/A';
            const id = Helpers.escapeJsAttr(transaction.id);
            const type = Helpers.escapeJsAttr(transaction.transactionType);
            const inputIds = this.paymentInputIds(transaction.id, transaction.transactionType);
            
            div.innerHTML = `
                <div class="history-header">
                    <div class="due-bill-title"><span class="due-bill-no"><button type="button" class="due-bill-link" data-onclick="outstanding.showDetails('${id}', '${type}')">#${Helpers.escapeHtml(billNumber)}</button></span>${isOpeningRecord(transaction) ? ` <span class="old-app-chip">${tt('ui.history.old_app_chip')}</span>` : ''}${currentDueFilter === 'sale' && this.seesWholesale() ? ` <span class="due-kind-chip tag">${tt(transaction.transactionType === 'wholesale' ? 'ui.outstanding.kind_wholesale' : 'ui.outstanding.kind_retail')}</span>` : ''}${transaction.customerName ? `  <strong>${Helpers.escapeHtml(transaction.customerName)}</strong>` : ''}</div>
                    <span class="due-bill-due">${withMoney(t('ui.outstanding.due_amount', { amount: formatAmount(transaction.outstanding) }), transaction.outstanding)}</span>
                </div>
                <div class="history-date">${Helpers.formatDate(transaction.date)}${transaction.createdByName ? ` • ${byNameHtml(transaction.createdByName)}` : ''} ${ageBadge}</div>
                ${openingOldTotals(transaction) ? `<div class="history-date">${tt('ui.outstanding.opening_balance', { total: formatAmount(openingOldTotals(transaction).total), paid: formatAmount(openingOldTotals(transaction).paid) })}</div>` : ''}
                <div class="due-bill-body">
                    <div class="due-bill-line">
                        <span>${totalLabel}:</span>
                        <strong>${moneyHtml(transaction.totalAmount)}</strong>
                    </div>
                    <div class="due-bill-line">
                        <span>${paidLabel}:</span>
                        <strong>${moneyHtml(transaction.paidAmount)}</strong>
                    </div>
                    <div class="due-bill-line due-bill-out">
                        <span>${tt('ui.outstanding.outstanding_label')}</span>
                        <strong>${moneyHtml(transaction.outstanding)}</strong>
                    </div>
                    <div class="due-bill-pay">
                        <label for="${Helpers.escapeHtml(inputIds.cash)}">${tt(isPurchase ? 'ui.outstanding.pay_label' : 'ui.outstanding.received_label')}</label>
                        <input type="number" class="input" inputmode="decimal" min="0" id="${Helpers.escapeHtml(inputIds.cash)}" placeholder="${tt('ui.outstanding.cash_placeholder')}" aria-label="${tt('ui.outstanding.cash_amount')}" />
                        <input type="number" class="input" inputmode="decimal" min="0" id="${Helpers.escapeHtml(inputIds.online)}" placeholder="${tt('ui.outstanding.online_placeholder')}" aria-label="${tt('ui.outstanding.online_amount')}" />
                        <button type="button" class="btn btn-tonal" data-record-payment data-onclick="outstanding.recordPayment('${id}', '${type}')">${tt('ui.outstanding.record')}</button>
                    </div>
                    <div class="due-bill-actions">
                        <button type="button" class="btn btn-sm btn-ghost" data-mark-cleared data-onclick="outstanding.markAsCleared('${id}', '${type}')">${tt('ui.outstanding.mark_as_cleared')}</button>
                        ${transaction.transactionType === 'purchase' ? '' : `<button type="button" class="btn btn-sm btn-ghost due-write-off" data-write-off data-onclick="outstanding.writeOffDue('${id}', '${type}')">${tt('ui.outstanding.write_off_bad_debt')}</button>`}
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
            <button type="button" class="aging-bucket aging-b${i}${b.total > 0 ? '' : ' is-zero'}${this.agingBucket === b.key ? ' active' : ''}"
                aria-pressed="${this.agingBucket === b.key}"
                data-onclick="outstanding.setAgingBucket('${attr(b.key)}')">
                <span class="aging-dot" aria-hidden="true"></span>
                <span class="aging-bucket-label">${tt('ui.outstanding.bucket_days', { label: b.label })}</span>
                <strong class="aging-bucket-amount">${moneyHtml(b.total)}</strong>
                <span class="aging-bucket-count">${esc(billsText(b.count))}</span>
            </button>`).join('');
        // Meter: each age group's share of the total, as flex weights (no arithmetic here)
        const meter = aging.buckets.map((b, i) => (b.total > 0 ? `<span class="aging-b${Number(i)}" style="--w: ${Number(b.total)}"></span>` : '')).join('');

        // Receive payment works on one list's bills; a party with retail and wholesale dues pays on either list.
        const kinds = new Map();
        bills.forEach(b => {
            const k = partyNameKey(b.customerName);
            if (!kinds.has(k)) kinds.set(k, new Set());
            kinds.get(k).add(b.transactionType);
        });
        const payType = (p) => (kinds.get(p.key)?.size === 1 ? [...kinds.get(p.key)][0] : null);
        const chase = isPayable ? [] : chaseFirst(aging.parties);
        const chaseHtml = isPayable ? '' : `
            <div class="aging-chase">
                <h3 class="aging-subtitle">${tt('ui.outstanding.who_to_chase')}</h3>
                ${chase.length ? `<ol class="panel">${chase.map(p => `
                    <li class="row aging-b${p.bucket}"><span class="row-main"><strong>${partyName(p)}</strong> — ${moneyHtml(p.total)} · ${withMoney(t('ui.outstanding.party_overdue', { amount: formatRupees(p.overdue) }), p.overdue)}</span>
                        <span class="aging-age tag${esc(AGE_TONE[p.bucket])} aging-b${p.bucket}">${tt('ui.outstanding.oldest', { age: daysText(p.oldestDays) })}</span></li>`).join('')}</ol>`
                    : emptyState({ icon: 'check', tone: 'pos', title: t('ui.outstanding.no_one_owes') })}
            </div>`;

        const parties = sortParties(aging.parties, this.agingSort)
            .filter(p => !this.agingBucket || p.bills.some(b => AGING_BUCKETS[b.bucket].key === this.agingBucket));
        const rows = parties.map(p => `
            <div class="aging-party row aging-b${p.bucket}">
                <span class="lead-icon aging-avatar" data-initials="${esc(initials(p.name))}" aria-hidden="true">${p.name ? '' : icon('user')}</span>
                <div class="aging-party-main">
                    <div class="aging-party-name">${partyName(p)}${p.longOverdue ? ` <span class="aging-badge tag neg">${tt('ui.outstanding.long_overdue')}</span>` : ''}</div>
                    <div class="aging-party-meta">${esc(billsText(p.bills.length))} · <span class="aging-oldest${esc(AGE_TEXT_TONE[p.bucket])}">${tt('ui.outstanding.oldest', { age: daysText(p.oldestDays) })}</span>${p.overdue > 0 ? ` · ${withMoney(t('ui.outstanding.party_overdue', { amount: formatRupees(p.overdue) }), p.overdue)}` : ''}</div>
                </div>
                <strong class="aging-party-total row-amt">${moneyHtml(p.total)}</strong>
                <div class="aging-party-actions">
                    ${!this.canReceiveFromParty() ? '' : payType(p) ? `<button type="button" class="btn btn-sm btn-tonal" data-party-pay data-onclick="outstanding.receiveFromParty('${attr(p.key)}', '${attr(payType(p))}')">${tt(isPayable ? 'ui.outstanding.party_pay_pay' : 'ui.outstanding.party_pay_receive')}</button>`
                        : `<span class="aging-party-meta">${tt('ui.outstanding.party_pay_pick_list')}</span>`}
                    ${isPayable ? '' : `<button type="button" class="btn btn-sm aging-remind" data-onclick="outstanding.sendReminder('${attr(p.key)}')">${icon('wa', 'i-sm i-fill')}${tt('ui.outstanding.remind')}</button>`}
                    <button type="button" class="btn btn-sm" data-onclick="outstanding.printStatement('${attr(p.key)}')">${icon('file', 'i-sm')}${tt('ui.outstanding.statement')}</button>
                </div>
            </div>`).join('');

        const sortBtn = (by, label) => `<button type="button"${this.agingSort === by ? ' class="active"' : ''} aria-pressed="${this.agingSort === by}" data-onclick="outstanding.setAgingSort('${by}')">${label}</button>`;

        el.innerHTML = `
            <div>
                <section class="aging-hero" aria-labelledby="dueAgingTitle">
                    <div class="aging-head">
                        <p class="aging-title" id="dueAgingTitle">${tt(isPayable ? 'ui.outstanding.payables_by_age' : RECEIVABLE_TITLE[this.dueFilter()] || 'ui.outstanding.receivables_by_age')}</p>
                        <strong class="aging-total hero-num">${moneyHtml(aging.total)}</strong>
                    </div>
                    <div class="aging-overdue">${tt('ui.outstanding.overdue_total')} <strong class="aging-overdue-amount">${moneyHtml(aging.overdue)}</strong></div>
                    <div class="meter aging-meter" aria-hidden="true">${meter}</div>
                    <div class="aging-buckets">${buckets}</div>
                    ${this.agingBucket ? `<div class="aging-filter-note">${tt('ui.outstanding.one_age_group')}</div>` : ''}
                </section>
                ${chaseHtml}
                <details class="aging-parties"${this.partiesOpen ? ' open' : ''} data-ontoggle="outstanding.setPartiesOpen(this.open)">
                    <summary class="aging-subtitle">${tt('ui.outstanding.by_party', { count: parties.length })}</summary>
                    <div class="aging-sort"><span id="dueAgingSortLabel">${tt('ui.outstanding.sort')}</span> <div class="seg" role="group" aria-labelledby="dueAgingSortLabel">${sortBtn('amount', tt('ui.outstanding.sort_amount'))} ${sortBtn('age', tt('ui.outstanding.sort_oldest'))}</div></div>
                    <div id="dueAgingParties" class="panel">${rows}</div>
                </details>
                <h3 class="aging-subtitle aging-bills-title">${tt('ui.outstanding.bills_title')}</h3>
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
     * @param {'purchase'|'sale'|'retail'|'wholesale'} filter
     * @param {string} name Party name as typed on the bill
     */
    static showParty(filter, name) {
        const key = partyNameKey(name);
        this.filterDue(DUE_FILTERS.includes(filter) ? filter : 'sale');
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
            <div class="party-filter-note notice info">
                <span class="grow">${Helpers.escapeHtml(t('ui.outstanding.showing_only'))} <strong>${Helpers.escapeHtml(this.partyFilter.name)}</strong></span>
                <button type="button" class="btn btn-sm" data-onclick="outstanding.clearPartyFilter()">${Helpers.escapeHtml(t('ui.outstanding.show_all'))}</button>
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
        const filter = this.dueFilter();
        const kind = filter === 'purchase' ? 'payable' : 'receivable';
        const bills = dueRows({
            purchases: AppState.purchaseHistory, retailSales: AppState.retailSalesHistory, wholesaleSales: AppState.salesHistory
        }, filter, { wholesale: this.seesWholesale() });
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

    /**
     * Ids of a bill's cash / online inputs. Wholesale rows get their own (#125): the
     * Wholesale page lists the same bills with `payment_<id>`.
     */
    static paymentInputIds(id, type) {
        return type === 'wholesale'
            ? { cash: `duePayment_${id}`, online: `duePaymentOnline_${id}` }
            : { cash: `payment_${id}`, online: `paymentOnline_${id}` };
    }

    static async recordPayment(transactionId, transactionType) {
        // Cash and online parts (#107): only the cash part reaches the drawer
        const ids = this.paymentInputIds(transactionId, transactionType);
        const cash = Number(document.getElementById(ids.cash)?.value) || 0;
        const online = Number(document.getElementById(ids.online)?.value) || 0;
        const ok = await this.recordDuePayment({ billType: transactionType, billId: transactionId, cash, online });
        if (ok) {
            // The row may have been redrawn meanwhile: clear the inputs shown now
            const paymentInput = document.getElementById(ids.cash);
            const onlineInput = document.getElementById(ids.online);
            if (paymentInput) paymentInput.value = '';
            if (onlineInput) onlineInput.value = '';
        }
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
     * Cash tab: reduces the bill's due (payment.due + payments[]; the dueAmount mirror
     * follows, repos/bill-due.js)
     * and, when a cash session is open today, adds the payment to it as a
     * drawer leg — all in one transaction, with its audit entry (D-3). The payment's id
     * belongs to services/payment-intents.js (same bill, amounts and action = same id until
     * it is known to be recorded), so a retry after a lost answer is never recorded twice (D-1).
     * @param {Object} args
     * @param {'purchase'|'retail'|'wholesale'} args.billType
     * @param {string} args.billId
     * @param {number} args.cash Cash part
     * @param {number} [args.online=0] Online part
     * @param {string} [args.note]
     * @returns {Promise<boolean>} true when recorded
     */
    static async recordDuePayment(args) {
        if (Helpers.isBusy('due-payment')) return false;
        const landed = await this.landedBeforeSend(args);
        if (landed !== null) return landed;
        // One payment at a time: a double tap on Record saves one payment (#70)
        const ok = await Helpers.runExclusive('due-payment', RECORD_PAYMENT_BUTTONS, () => this._recordDuePayment(args));
        return ok === true;
    }

    /** Intent key of a due payment (services/payment-intents.js): action, bill, cash and online. */
    static dueIntentKey({ billType, cash, online = 0, clear = false }, bill) {
        return paymentIntentKey({ kind: clear ? 'clear' : 'pay', billType, billId: bill.id, cash, online });
    }

    /**
     * Before a payment is sent (outside the lock, it may ask): did an earlier try of the same
     * payment, whose answer was lost, land on this phone's copy of the bill? Within
     * PAYMENT_RETRY_WINDOW_MS of that try this is its retry: reported as already recorded, nothing
     * sent (D-1). Later it may be a new payment of the same amount: the user is asked.
     * @returns {Promise<?boolean>} null: send it; true / false: done (true = nothing left to record)
     */
    static async landedBeforeSend(args) {
        const bill = this.findBill(args.billType, args.billId);
        if (!bill) return null;
        const key = this.dueIntentKey(args, bill);
        const open = pendingPaymentIntent(key);
        const entry = open ? paymentEntryOf(bill, open.ids[0]) : null;
        if (!entry) return null;
        const total = formatAmount(Number(entry.amount) || 0, { exact: true });
        if (!isRetryOf(open)) {
            const again = await UIManager.showModal(
                t('msg.outstanding.payment_recorded_earlier', { total, time: formatDayTime(entry.at, { lang: getLang() }) }),
                t('ui.outstanding.record_again_title'), true);
            settlePaymentIntent(key);
            if (again) return null;
        } else {
            settlePaymentIntent(key);
        }
        UIManager.showToast(t('msg.outstanding.payment_already_recorded', { total }));
        this.refreshAfterPayment();
        return true;
    }

    static async _recordDuePayment({ billType, billId, cash, online = 0, note = '', clear = false }) {
        let run = null;
        let sent = null;
        try {
            const transaction = this.findBill(billType, billId);
            if (!transaction) {
                UIManager.showToast(t('msg.outstanding.error_transaction_not_found'));
                return false;
            }

            const key = this.dueIntentKey({ billType, cash, online, clear }, transaction);

            const outstanding = readPayment(transaction).due;
            const split = validateDuePayment(cash, online, outstanding, PAYMENT_TOLERANCE);
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
                id: paymentIntentIds(key, [transaction.id])[0],
                amount: split.total,
                date: Helpers.getCurrentDateTime(),
                recordedBy: AppState.userName || (AppState.currentUser ? AppState.currentUser.email : 'Unknown')
            };
            if (note) entry.note = note;

            // Server-side read-modify-write so concurrent payments from two devices can't overwrite each other
            if (clear) entry.settlesDue = true;
            run = tip.start('PaymentRecord', { flags: { billType, clear: !!clear, split: split.cash > 0 && split.online > 0 } });
            this.lastPaymentTip = null;
            sent = { key, billType, billId: transaction.id, entryId: entry.id, total: split.total, dueBefore: outstanding, clear, online: split.online };
            const audit = this.paymentAudit(transaction, billType, split);
            const written = await this.applyPaymentTransaction(billType, transaction, { cash: split.cash, online: split.online }, entry, { clear, audit });
            settlePaymentIntent(key);
            Object.assign(transaction, written);
            track('payment.record');
            try {
                const info = this.lastPaymentTip || {};
                run.complete(paymentRecordProps(info.fresh || null, written, info));
            } catch (_) { /* TIP never breaks a payment */ }

            this.refreshAfterPayment();
            UIManager.showToast(this.recordedText(sent));
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
                UIManager.showToast(t('msg.common.payment_amount_exceeds_outstanding_amount_2', { due: formatAmount(error.due, { exact: true }) }));
                this.renderDue();
                return false;
            }
            if (!sent) {
                UIManager.showToast(OutstandingManager.isOfflineError(error) ? t('msg.common.internet_required_record_payment') : await this.paymentRefusedText(error));
                return false;
            }
            return this.afterPaymentFailure(error, sent);
        }
    }

    /** "Payment recorded" / "due cleared" text of a recorded payment. */
    static recordedText(sent) {
        const total = formatAmount(sent.total, { exact: true });
        if (!sent.clear) return t('msg.outstanding.payment_recorded', { total });
        return t(sent.online > 0 ? 'msg.outstanding.due_cleared_online' : 'msg.outstanding.due_cleared_cash', { total });
    }

    /**
     * The audit entry written in the payment's own transaction (D-3): id from the payment id.
     * @returns {{action: string, details: Object}}
     */
    static paymentAudit(bill, billType, split) {
        return {
            action: AuditService.ACTIONS.UPDATE_PAYMENT,
            details: {
                billNumber: bill.billNumber || 'N/A',
                paymentAmount: split.total,
                cash: split.cash,
                online: split.online,
                transactionType: billType,
                customer: bill.customerName || bill.customer || bill.supplier || 'N/A'
            }
        };
    }

    /** Copies a bill's payment fields as read on the server onto this phone's copy. */
    static takeServerPayment(billType, billId, server) {
        const local = this.findBill(billType, billId);
        if (!local || !server) return;
        ['payment', 'payments', 'dueAmount', 'openDue', 'paidAt', 'cleared', 'clearedAt', 'clearedBy', 'clearedByName']
            .forEach(k => { if (Object.prototype.hasOwnProperty.call(server, k)) local[k] = server[k]; });
    }

    /**
     * A sent payment failed. A refusal is told in plain words (D-2: another phone's payment came
     * first, so the due is shown again from the server); any other error may hide a commit whose
     * answer was lost, so the bill is checked (this phone's copy, then the server) and the user
     * is told whether it was recorded, never just "try again" (D-1).
     * @param {*} error
     * @param {{key: string, billType: string, billId: string, entryId: string, total: number, dueBefore: number}} sent
     * @returns {Promise<boolean>} true when the payment turned out to be recorded
     */
    static async afterPaymentFailure(error, sent) {
        const collKey = COLLECTION_BY_TYPE[sent.billType] || 'wholesaleSales';
        const total = formatAmount(sent.total, { exact: true });
        if (error?.code === 'voided' || error?.code === 'not-found' || error?.code === 'invalid-argument') {
            UIManager.showToast(error.code === 'not-found' ? t('msg.outstanding.error_transaction_not_found') : await this.paymentRefusedText(error));
            return false;
        }
        if (error?.code === 'permission-denied') {
            if (await refusedForClock(error)) {
                UIManager.showToast(t('msg.common.phone_clock_wrong_payment'));
                return false;
            }
            const server = await readBillFromServer(collKey, sent.billId);
            if (server && paymentEntryOf(server, sent.entryId)) return this.paymentFoundRecorded(sent, server);
            if (server) {
                this.takeServerPayment(sent.billType, sent.billId, server);
                this.refreshAfterPayment();
            }
            UIManager.showToast(server && round2(readPayment(server).due) !== round2(sent.dueBefore)
                ? t('msg.outstanding.payment_changed_elsewhere', { total, due: formatAmount(outstandingDue(server), { exact: true }) })
                : t('msg.outstanding.payment_refused'));
            return false;
        }
        if (!paymentOutcomeUnknown(error)) {
            UIManager.showToast(await this.paymentRefusedText(error));
            return false;
        }
        UIManager.showToast(t('msg.outstanding.payment_checking'));
        if (paymentEntryOf(this.findBill(sent.billType, sent.billId), sent.entryId)) return this.paymentFoundRecorded(sent, null);
        const server = await readBillFromServer(collKey, sent.billId);
        if (server && paymentEntryOf(server, sent.entryId)) return this.paymentFoundRecorded(sent, server);
        if (server === null) {
            UIManager.showToast(t('msg.outstanding.payment_unconfirmed', { total }));
            return false;
        }
        if (server) {
            this.takeServerPayment(sent.billType, sent.billId, server);
            this.refreshAfterPayment();
        }
        UIManager.showToast(t('msg.outstanding.payment_not_saved', { total }));
        return false;
    }

    /** The payment whose answer was lost is on the bill: recorded once (with its audit entry). */
    static paymentFoundRecorded(sent, server) {
        settlePaymentIntent(sent.key);
        if (server) this.takeServerPayment(sent.billType, sent.billId, server);
        this.refreshAfterPayment();
        UIManager.showToast(this.recordedText(sent));
        UIManager.hapticFeedback('light');
        return true;
    }

    /**
     * Toast text for a payment or write-off the server refused. The rules refuse an
     * entry whose time is 10 minutes or more off the server's (#184): a phone with a
     * wrong clock is told so instead of a bare permission error. Never the raw error text (D-2).
     * @param {*} error
     * @returns {Promise<string>}
     */
    static async paymentRefusedText(error) {
        if (error?.code === 'voided') return t('msg.void.bill_was_voided');
        if (await refusedForClock(error)) return t('msg.common.phone_clock_wrong_payment');
        return t('msg.outstanding.payment_refused');
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
     * @param {{clear?: boolean, audit?: ?{action: string, details: Object}}} [opts] `audit`: an
     *   audit entry created in the same transaction as the payment (id `pay_<entry id>`, D-3)
     * @returns {Promise<Object>} The bill fields written (for patching local state)
     */
    static async applyPaymentTransaction(transactionType, bill, amount, entry, { clear = false, audit = null } = {}) {
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
        const today = todayLocalISO();
        let legWritten = null;
        let tipInfo = null;

        // Re-read on the server: bill (and today's session) in one transaction; the
        // fields below are computed from that fresh data (the transaction may retry).
        const collKey = COLLECTION_BY_TYPE[transactionType] || 'wholesaleSales';
        const written = await updateBillInTransaction(collKey, bill.id, sessionId, (fresh, openSession) => {
            legWritten = null;
            tipInfo = null;
            if (!isActiveBill(fresh)) throw Object.assign(new Error('This bill was voided'), { code: 'voided' });
            const pay = readPayment(fresh);
            const entries = Array.isArray(fresh.payments) ? fresh.payments : [];
            tipInfo = { fresh, sessionOpen: !!(openSession && !openSession.signedOut && openSession.date === today), retried: false };

            // A retry of a payment that already reached the server: nothing to add (#70)
            if (entry?.id && entries.some(p => p && p.id === entry.id)) {
                tipInfo.retried = true;
                // The stored payment state as it is, for this phone's copy (nothing is written)
                const { dueAmount } = fresh;
                const current = { payment: fresh.payment, payments: entries, openDue: fresh.openDue,
                    ...(Object.prototype.hasOwnProperty.call(fresh, 'dueAmount') ? { dueAmount } : {}) };
                return { result: current };
            }

            if (total > pay.due + PAYMENT_TOLERANCE) {
                const err = new Error('Payment amount exceeds outstanding amount');
                err.code = 'exceeds-due';
                err.due = pay.due;
                throw err;
            }

            // Phones keep loading an older bill paid inside their history window (#163): paidAt.
            const { update, due: newDue } = duePaymentUpdate(fresh, { cash, online }, fullEntry, PAYMENT_TOLERANCE);
            // "Mark as cleared" with cash/online: the payment settles the whole due
            if (clear && newDue === 0) Object.assign(update, this.clearedFields());
            update.openDue = FirebaseService.billHasOpenDue(collKey, { ...fresh, ...update });
            update.clientVersion = FirebaseService.CLIENT_VERSION;
            const auditDoc = audit ? { id: `pay_${fullEntry.id}`, data: AuditService.entry(audit.action, audit.details) } : null;

            if (openSession && !openSession.signedOut && openSession.date === today) {
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
                legWritten = leg;
                const duePayments = [...(Array.isArray(openSession.duePayments) ? openSession.duePayments : []), leg];
                return { bill: update, session: { duePayments }, result: update, audit: auditDoc };
            }
            return { bill: update, result: update, audit: auditDoc };
        });

        const local = CashManagementManager.todaySession;
        if (legWritten && local && String(local.id) === sessionId) {
            local.duePayments = [...(local.duePayments || []).filter(l => l.id !== legWritten.id), legWritten];
        }
        this.lastPaymentTip = tipInfo ? { ...tipInfo, legWritten: !!legWritten } : null;
        return written;
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
        if (Helpers.isBusy('due-payment')) return false;
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
            <div class="due-dlg">
                <div>${esc(t('ui.outstanding.bill_no', { billNumber: transaction.billNumber || String(transaction.id).slice(0, 8) }))}${party}<br>
                    ${esc(t('ui.outstanding.remaining_due'))} <strong>${moneyHtml(due, { exact: true })}</strong></div>
                <div class="due-dlg-head">${esc(t('ui.outstanding.how_settled'))}</div>
                <label class="due-dlg-opt"><input type="radio" name="clearMethod" value="cash"> ${esc(t(isPurchase ? 'ui.outstanding.paid_in_cash' : 'ui.outstanding.received_in_cash', { amount: formatAmount(due, { exact: true }) }))}</label>
                <label class="due-dlg-opt"><input type="radio" name="clearMethod" value="online"> ${esc(t(isPurchase ? 'ui.outstanding.paid_online' : 'ui.outstanding.received_online', { amount: formatAmount(due, { exact: true }) }))}</label>
                <label class="due-dlg-opt"><input type="radio" name="clearMethod" value="writeOff"> ${esc(t(isPurchase ? 'ui.outstanding.write_off_not_paid' : 'ui.outstanding.write_off_not_received'))}</label>
                <label for="clearReason">${esc(t('ui.outstanding.write_off_reason'))}</label>
                <textarea id="clearReason" class="input" rows="2" maxlength="300"></textarea>
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
        return this.confirmWriteOff(transactionType, transaction, reason);
    }

    /**
     * "Write off as bad debt" (OD-13): a due to receive that will never come is taken off with
     * a reason as a write-off entry (applyWriteOffTransaction), never by zeroing it. It counts as
     * a bad debt in Money (M5) and stays on the bill and in the customer's history.
     * @param {string} transactionId
     * @param {'purchase'|'retail'|'wholesale'} transactionType
     * @returns {Promise<boolean>} true when written off
     */
    static async writeOffDue(transactionId, transactionType) {
        if (Helpers.isBusy('due-payment')) return false;
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
        const esc = (v) => Helpers.escapeHtml(v);
        const amount = formatRupees(due, { exact: true });
        const party = transaction.customerName ? ` — ${esc(transaction.customerName)}` : '';
        const html = `
            <div class="due-dlg">
                <div>${esc(t('ui.outstanding.bill_no', { billNumber: transaction.billNumber || String(transaction.id).slice(0, 8) }))}${party}</div>
                <div>${esc(t('ui.outstanding.write_off_explain', { amount }))}</div>
                <label for="writeOffReason">${esc(t('ui.outstanding.write_off_reason'))}</label>
                <textarea id="writeOffReason" class="input" rows="2" maxlength="300"></textarea>
            </div>`;
        const confirmed = await UIManager.showModalWithHtml(html, t('ui.outstanding.write_off_title', { amount }), true);
        if (!confirmed) return false;
        return this.confirmWriteOff(transactionType, transaction, (document.getElementById('writeOffReason')?.value || '').trim());
    }

    /** Writes off a bill's remaining due once a reason is given (Mark as cleared or Write off). @private */
    static async confirmWriteOff(transactionType, transaction, reason) {
        if (reason.length < 3) {
            UIManager.showToast(t('msg.outstanding.write_reason_write_off'));
            return false;
        }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            UIManager.showToast(t('msg.outstanding.internet_required_clear_due'));
            return false;
        }
        const ok = await Helpers.runExclusive('due-payment', RECORD_PAYMENT_BUTTONS, () => this._writeOff(transactionType, transaction, reason));
        return ok === true;
    }

    static async _writeOff(transactionType, transaction, reason) {
        try {
            const written = await this.applyWriteOffTransaction(transactionType, transaction, reason);
            Object.assign(transaction, written);
            this.refreshAfterPayment();
            UIManager.hapticFeedback('light');
            UIManager.showToast(t('msg.outstanding.due_written_off'));
            return true;
        } catch (error) {
            console.error('Error writing off due:', error);
            UIManager.showToast(OutstandingManager.isOfflineError(error) ? t('msg.outstanding.internet_required_clear_due') : await this.paymentRefusedText(error));
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
     * "Complete all due" (#150): settles the whole due of every given bill in ONE
     * transaction (all or none), received in cash or online. Each bill gets its own
     * payments[] entry at the same time `at` (now; the rules allow ±10 min, #184), its
     * due goes to 0 and it is marked cleared, exactly as a single "Mark as cleared"
     * payment writes it. The due is re-read on the server: a bill paid meanwhile is
     * skipped, a part-paid one settles what is left. No cash-session legs: the
     * session takes one leg per write (rules), and the drawer counts the bill
     * entries (due-payments.js dueEvents).
     * @param {'purchase'|'retail'|'wholesale'} billType
     * @param {Object[]} bills - the bills (with `id`)
     * @param {'cash'|'online'} method
     * @param {number[]} [confirmed] - each bill's due the user confirmed: a higher due on the
     *   server (an edit meanwhile) aborts with code 'due-changed', so no more money is recorded
     * @param {string[]} [entryIds] - one payments[] id per bill, reused when the same settle is retried
     *   (#70): entries already on the server with these ids count as this settle's, written once
     * @param {{name?: string}} [opts] - `name`: the party, for the UPDATE_PAYMENT audit entry written by the
     *   same transaction (id `pay_<first entry id>`, D-3); none without it, or when nothing new is written
     * @returns {Promise<{settled: Array<{bill: Object, amount: number, fields: Object}>, total: number}>}
     */
    static async settleAllDues(billType, bills, method, confirmed = [], entryIds = null, { name = null } = {}) {
        const collKey = COLLECTION_BY_TYPE[billType] || 'wholesaleSales';
        const at = Date.now();
        const recordedBy = AppState.userName || (AppState.currentUser ? AppState.currentUser.email : 'Unknown');
        const recordedById = AppState.currentUser ? AppState.currentUser.uid : 'unknown';
        const ids = bills.map((_, i) => entryIds?.[i] || Helpers.generateId());
        const cleared = this.clearedFields();
        // The document id, not the id field: a legacy doc may carry a different one
        const docIds = bills.map(b => (FirebaseService.documentIdOf ? FirebaseService.documentIdOf(b) : String(b.id)));
        const result = await updateBillsInTransaction(collKey, docIds, (freshList) => {
            const updates = [];
            const settled = [];
            freshList.forEach((fresh, i) => {
                if (!isActiveBill(fresh)) throw Object.assign(new Error('This bill was voided'), { code: 'voided' });
                // This settle's entry is already there: a re-run or a retry after a commit whose answer was lost
                const mine = (Array.isArray(fresh.payments) ? fresh.payments : []).find(p => p && p.id === ids[i]);
                if (mine) {
                    updates.push(null);
                    settled.push({ index: i, amount: Number(mine.amount) || 0, fields: { ...fresh } });
                    return;
                }
                const part = settleDueUpdate(fresh, method, {
                    id: ids[i], at, date: Helpers.getCurrentDateTime(), recordedBy, recordedById, settlesDue: true, bulk: true
                }, PAYMENT_TOLERANCE, confirmed[i] ?? Infinity);
                if (part?.changed) throw Object.assign(new Error('A due changed'), { code: 'due-changed' });
                if (!part) {
                    updates.push(null);
                    return;
                }
                const update = { ...part.update, ...cleared };
                update.openDue = FirebaseService.billHasOpenDue(collKey, { ...fresh, ...update });
                update.clientVersion = FirebaseService.CLIENT_VERSION;
                updates.push(update);
                settled.push({ index: i, amount: part.amount, fields: update });
            });
            const written = settled.filter(s => updates[s.index]);
            const audit = name !== null && written.length ? {
                id: `pay_${ids[0]}`,
                data: AuditService.entry(AuditService.ACTIONS.UPDATE_PAYMENT, {
                    bulk: true,
                    transactionType: billType,
                    customer: name,
                    method,
                    paymentAmount: sumMoney(written, s => s.amount),
                    billNumbers: written.map(s => freshList[s.index].billNumber || String(bills[s.index].id)).join(', ').slice(0, 900)
                })
            } : null;
            return { bills: updates, result: settled, audit };
        });
        const settled = result.map(s => ({ bill: bills[s.index], amount: s.amount, fields: s.fields }));
        return { settled, total: sumMoney(settled, s => s.amount) };
    }

    /** "Receive payment" from a party over their bills (#152): owner and managers, like Complete all due. */
    static canReceiveFromParty() {
        return AppState.userRole === 'owner' || AppState.userRole === 'manager';
    }

    /** The bills of one Outstanding list (wholesale: the sales-tab bills). */
    static partyPayList(billType) {
        return (billType === 'purchase' ? AppState.purchaseHistory
            : billType === 'retail' ? AppState.retailSalesHistory
                : (AppState.salesHistory || []).filter(s => s && s.source === 'sales-tab')) || [];
    }

    /** A party's open bills of one kind, oldest first (DUE-ALL list): the first PARTY_PAY_MAX and how many in all. */
    static partyOpenBills(billType, partyKey) {
        const group = partyDues(this.partyPayList(billType), partyKey, partyNameKey);
        return { chosen: group.bills.slice(0, PARTY_PAY_MAX), all: group.bills.length };
    }

    /**
     * One payment from (or to) a party spread over their open bills (#152): the
     * amount fills the oldest bills first (DUE-FIFO); each bill's part can be
     * changed by hand before saving. All bills are written in one transaction.
     * @param {string} partyKey - partyNameKey of the party
     * @param {'purchase'|'retail'|'wholesale'} [billType] - default: the Outstanding list shown
     */
    static async receiveFromParty(partyKey, billType = ({ purchase: 'purchase', wholesale: 'wholesale' })[this.dueFilter()] || 'retail') {
        if (Helpers.isBusy('due-payment')) return;
        if (!this.canReceiveFromParty()) {
            UIManager.showToast(t('msg.common.access_denied'), 'error');
            return;
        }
        const { chosen, all } = this.partyOpenBills(billType, String(partyKey ?? ''));
        if (!chosen.length) {
            UIManager.showToast(t('msg.outstanding.nothing_due_party'));
            return;
        }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            UIManager.showToast(t('msg.common.internet_required_record_payment'));
            return;
        }
        const dues = chosen.map(x => x.due);
        this.partyPay = { dues };
        const esc = (v) => Helpers.escapeHtml(String(v ?? ''));
        const name = String(chosen[0].bill.customerName || '').trim();
        const rows = chosen.map((x, i) => `<tr>
                <td>${esc(x.bill.billNumber || String(x.bill.id))}<br><small>${esc(Helpers.formatDate(billDateOf(x.bill) || x.bill.date))}</small></td>
                <td class="num">${moneyHtml(x.due, { decimals: hasPaise(x.due) ? 2 : 0 })}</td>
                <td class="num"><input type="number" class="input due-pp-part" inputmode="decimal" min="0" step="0.01" id="ppPart-${i}" data-party-part
                    data-oninput="outstanding.partyPaySum()" aria-label="${esc(t('ui.outstanding.party_pay_part', { bill: x.bill.billNumber || '' }))}"></td></tr>`).join('');
        const isPay = billType === 'purchase';
        const html = `
            <div class="due-dlg">
                <div><strong>${esc(name)}</strong><br>${esc(t('ui.outstanding.party_pay_summary', { count: chosen.length, total: paiseText(sumMoney(chosen, x => x.due)) }))}</div>
                ${chosen.length < all ? `<div>${esc(t('ui.outstanding.party_pay_oldest', { count: chosen.length, all }))}</div>` : ''}
                <label class="field">${esc(t(isPay ? 'ui.outstanding.party_pay_amount_paid' : 'ui.outstanding.party_pay_amount_received'))}
                    <input type="number" class="input" inputmode="decimal" min="0" step="1" id="ppAmount" required data-oninput="outstanding.partyPayFill()"></label>
                <div class="due-dlg-head">${esc(t('ui.outstanding.party_pay_how'))}</div>
                <label class="due-dlg-opt"><input type="radio" name="partyPayMethod" value="cash"> ${esc(t('ui.wholesale.complete_all_due_cash'))}</label>
                <label class="due-dlg-opt"><input type="radio" name="partyPayMethod" value="online"> ${esc(t('ui.wholesale.complete_all_due_online'))}</label>
                <div class="due-dlg-note">${esc(t('ui.outstanding.party_pay_oldest_first'))}</div>
                <table class="table due-pp-table">
                    <thead><tr><th>${esc(t('ui.outstanding.party_pay_col_bill'))}</th><th class="num">${esc(t('ui.outstanding.party_pay_col_due'))}</th><th class="num">${esc(t('ui.outstanding.party_pay_col_part'))}</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
                <div id="ppSum" class="due-dlg-head" role="status"></div>
            </div>`;
        const ok = await UIManager.showModalWithHtml(html, t(isPay ? 'ui.outstanding.party_pay_title_pay' : 'ui.outstanding.party_pay_title_receive'), true);
        if (!ok) return;
        const method = document.querySelector('input[name="partyPayMethod"]:checked')?.value || '';
        const check = this.partyPayCheck();
        if (!check.ok) {
            UIManager.showToast(this.partyPayProblem(check));
            return;
        }
        if (!method) {
            UIManager.showToast(t('msg.outstanding.choose_how_due_was_settled'));
            return;
        }
        const picked = chosen.map((x, i) => ({ bill: x.bill, due: x.due, amount: check.amounts[i] })).filter(x => x.amount > 0);
        if (await this.partyLandedBeforeSend(billType, name, picked, method)) return;
        await Helpers.runExclusive('due-payment', `${RECORD_PAYMENT_BUTTONS}, [data-complete-all], [data-party-pay]`,
            () => this._receiveFromParty(billType, name, picked, method));
    }

    /** Dialog: the amount typed fills the bills oldest first (DUE-FIFO). */
    static partyPayFill() {
        const dues = this.partyPay?.dues || [];
        const { amounts } = allocateOldestFirst(dues, document.getElementById('ppAmount')?.value);
        amounts.forEach((a, i) => {
            const el = document.getElementById(`ppPart-${i}`);
            if (el) el.value = a > 0 ? String(a) : '';
        });
        this.partyPaySum();
    }

    /** The dialog's amount and parts checked against each other (DUE-FIFO, checkAllocation). */
    static partyPayCheck() {
        const dues = this.partyPay?.dues || [];
        return checkAllocation(dues, dues.map((_, i) => document.getElementById(`ppPart-${i}`)?.value ?? ''),
            document.getElementById('ppAmount')?.value ?? '', PAYMENT_TOLERANCE);
    }

    /** What is wrong with the amount or the parts, in the app language. */
    static partyPayProblem(check) {
        if (check.error === 'no-amount') return t('ui.outstanding.party_pay_enter');
        if (check.error === 'exceeds-due') return t('msg.common.payment_amount_exceeds_outstanding_amount');
        if (check.error === 'mismatch') {
            return t(check.diff > 0 ? 'msg.outstanding.party_pay_parts_more' : 'msg.outstanding.party_pay_parts_less', {
                total: paiseText(check.total), amount: paiseText(check.received), diff: paiseText(check.gap)
            });
        }
        return t('msg.common.enter_valid_payment_amount');
    }

    /** Dialog: the total of the parts (or what is wrong with them). */
    static partyPaySum() {
        const el = document.getElementById('ppSum');
        if (!el) return;
        const check = this.partyPayCheck();
        el.textContent = check.ok
            ? t('ui.outstanding.party_pay_total', { total: paiseText(check.total) })
                + (check.excess > 0 ? ` · ${t(check.allFull ? 'ui.outstanding.party_pay_more_than_due' : 'ui.outstanding.party_pay_paise_left', { amount: paiseText(check.excess) })}` : '')
            : this.partyPayProblem(check);
    }

    /**
     * Intent key of a party payment (#70, D-1): same list, party, method and total. Not the split:
     * once a lost payment lands, the same amount fills the bills differently (DUE-FIFO).
     */
    static partyPayKey(billType, name, picked, method) {
        return paymentIntentKey({ kind: 'party', billType, billId: partyNameKey(name), cash: sumMoney(picked, x => x.amount), parts: [method] });
    }

    /** Document id of a bill (a legacy doc may carry another `id` field). */
    static docIdOf(bill) {
        return FirebaseService.documentIdOf ? FirebaseService.documentIdOf(bill) : String(bill.id);
    }

    /**
     * Before a party payment is sent (outside the lock, it may ask): did an earlier try of the same
     * payment (party, method, total), whose answer was lost, land? All its bills were written in one
     * transaction, so one entry found means all landed. Looked up on this phone's bills, and on the
     * server when this try would leave out a bill of that one. Within PAYMENT_RETRY_WINDOW_MS it is
     * reported as already recorded; later the user is asked (D-1).
     * @returns {Promise<boolean>} true when nothing is to be sent
     */
    static async partyLandedBeforeSend(billType, name, picked, method) {
        const key = this.partyPayKey(billType, name, picked, method);
        const open = pendingPaymentIntent(key);
        if (!open) return false;
        let entry = null;
        this.partyPayList(billType).some(b => open.ids.some(id => (entry = paymentEntryOf(b, id))));
        const docs = new Set(picked.map(x => this.docIdOf(x.bill)));
        if (!entry && open.docs.some(d => !docs.has(d))) {
            const server = await readBillFromServer(COLLECTION_BY_TYPE[billType] || 'wholesaleSales', open.docs[0]);
            if (server === null) {
                UIManager.showToast(t('msg.outstanding.payment_unconfirmed', { total: formatAmount(sumMoney(picked, x => x.amount), { exact: true }) }));
                return true;
            }
            entry = server ? paymentEntryOf(server, open.ids[0]) : null;
        }
        if (!entry) return false;
        const total = formatAmount(sumMoney(picked, x => x.amount), { exact: true });
        if (!isRetryOf(open)) {
            const again = await UIManager.showModal(
                t('msg.outstanding.party_pay_recorded_earlier', { total, name: String(name || ''), time: formatDayTime(entry.at, { lang: getLang() }) }),
                t('ui.outstanding.record_again_title'), true);
            settlePaymentIntent(key);
            if (again) return false;
        } else {
            settlePaymentIntent(key);
        }
        UIManager.showToast(t('msg.outstanding.payment_already_recorded', { total }));
        this.refreshAfterPayment();
        return true;
    }

    static async _receiveFromParty(billType, name, picked, method) {
        let result;
        const key = this.partyPayKey(billType, name, picked, method);
        const sum = sumMoney(picked, x => x.amount);
        const total = formatAmount(sum, { exact: true });
        const entryIds = paymentIntentIds(key, picked.map(x => this.docIdOf(x.bill)));
        try {
            result = await this.receivePartyPayment(billType, picked.map(x => x.bill), picked.map(x => x.amount), method, entryIds, { name });
        } catch (error) {
            console.error('Party payment failed:', error);
            if (paymentOutcomeUnknown(error)) {
                UIManager.showToast(t('msg.outstanding.payment_checking'));
                const first = picked[0].bill;
                const docId = this.docIdOf(first);
                // One transaction for all the bills: the first bill's entry says whether it landed
                const server = paymentEntryOf(this.findBill(billType, first.id), entryIds[0])
                    ? true : await readBillFromServer(COLLECTION_BY_TYPE[billType] || 'wholesaleSales', docId);
                if (server === true || (server && paymentEntryOf(server, entryIds[0]))) {
                    settlePaymentIntent(key);
                    UIManager.showToast(t('msg.outstanding.party_pay_done', { count: picked.length, total: paiseText(sum) }));
                    UIManager.hapticFeedback('light');
                } else {
                    UIManager.showToast(t(server === null ? 'msg.outstanding.payment_unconfirmed' : 'msg.outstanding.payment_not_saved', { total }));
                }
            } else if (error?.code === 'due-changed') {
                UIManager.showToast(t('msg.outstanding.party_pay_changed'));
            } else if (error?.code === 'not-found') {
                UIManager.showToast(t('msg.outstanding.error_transaction_not_found'));
            } else {
                UIManager.showToast(await this.paymentRefusedText(error));
            }
            this.refreshAfterPayment();
            return;
        }
        settlePaymentIntent(key);
        const { settled } = result;
        settled.forEach(s => Object.assign(s.bill, s.fields));
        UIManager.showToast(t('msg.outstanding.party_pay_done', { count: settled.length, total: paiseText(result.total) }));
        UIManager.hapticFeedback('light');
        try {
            this.refreshAfterPayment();
        } catch (e) {
            console.warn('Redraw after party payment failed:', e);
        }
    }

    /**
     * DUE-FIFO write: `amounts[i]` (paise) received on `bills[i]` in cash or online, all
     * bills in ONE transaction (all or none). Each bill gets its own payments[] entry at the
     * same time `at` (now; the rules allow ±10 min, #184) and its due goes down by its part,
     * as one "Record payment" would write it; the due is re-read on the server and a part
     * now above it (paid meanwhile) aborts with code 'due-changed'. No cash-session legs:
     * the drawer counts the bill entries (due-payments.js dueEvents), as for Complete all due.
     * @param {'purchase'|'retail'|'wholesale'} billType
     * @param {Object[]} bills
     * @param {number[]} amounts - > 0, same order
     * @param {'cash'|'online'} method
     * @param {string[]} [entryIds] - reused when the same payment is retried (#70)
     * @param {{name?: string}} [opts] - `name`: the party, for the audit entry written in the same
     *   transaction (id `pay_<first entry id>`, D-3); none without it
     * @returns {Promise<{settled: Array<{bill: Object, amount: number, fields: Object}>, total: number}>}
     */
    static async receivePartyPayment(billType, bills, amounts, method, entryIds = null, { name = null } = {}) {
        const collKey = COLLECTION_BY_TYPE[billType] || 'wholesaleSales';
        const at = Date.now();
        const recordedBy = AppState.userName || (AppState.currentUser ? AppState.currentUser.email : 'Unknown');
        const recordedById = AppState.currentUser ? AppState.currentUser.uid : 'unknown';
        const ids = bills.map((_, i) => entryIds?.[i] || Helpers.generateId());
        const docIds = bills.map(b => (FirebaseService.documentIdOf ? FirebaseService.documentIdOf(b) : String(b.id)));
        const result = await updateBillsInTransaction(collKey, docIds, (freshList) => {
            const updates = [];
            const settled = [];
            // One transaction wrote all of an earlier try's entries: one found = that try landed, write nothing
            const landed = freshList.some((fresh, i) => paymentEntryOf(fresh, ids[i]));
            freshList.forEach((fresh, i) => {
                if (!isActiveBill(fresh)) throw Object.assign(new Error('This bill was voided'), { code: 'voided' });
                const mine = paymentEntryOf(fresh, ids[i]);
                if (mine || landed) {
                    updates.push(null);
                    if (mine) settled.push({ index: i, amount: Number(mine.amount) || 0, fields: { ...fresh } });
                    return;
                }
                const amount = round2(amounts[i]);
                const parts = method === 'online' ? { cash: 0, online: amount } : { cash: amount, online: 0 };
                const entry = { id: ids[i], at, amount, ...parts, date: Helpers.getCurrentDateTime(), recordedBy, recordedById, bulk: true };
                const out = duePaymentUpdate(fresh, parts, entry, PAYMENT_TOLERANCE);
                if (!out.ok || fresh.cleared) throw Object.assign(new Error('A due changed'), { code: 'due-changed' });
                const update = out.update;
                update.openDue = FirebaseService.billHasOpenDue(collKey, { ...fresh, ...update });
                update.clientVersion = FirebaseService.CLIENT_VERSION;
                updates.push(update);
                settled.push({ index: i, amount, fields: update });
            });
            const audit = name !== null && updates.some(Boolean) ? {
                id: `pay_${ids[0]}`,
                data: AuditService.entry(AuditService.ACTIONS.UPDATE_PAYMENT, {
                    bulk: true,
                    oldestFirst: true,
                    transactionType: billType,
                    customer: name,
                    method,
                    paymentAmount: sumMoney(settled, s => s.amount),
                    billNumbers: settled.map(s => freshList[s.index].billNumber || String(bills[s.index].id)).join(', ').slice(0, 900)
                })
            } : null;
            return { bills: updates, result: settled, audit };
        });
        const settled = result.map(s => ({ bill: bills[s.index], amount: s.amount, fields: s.fields }));
        return { settled, total: sumMoney(settled, s => s.amount) };
    }
    /**
     * Write off the remaining due in one transaction: payment.due to 0 (and its
     * dueAmount mirror, repos/bill-due.js), payment.writtenOff raised by the amount, and a payments[] entry
     * { kind: 'writeOff', amount, reason, who, when } — never counted as money; a due to receive
     * counts as a bad debt (M5). Its CLEAR_DUE audit entry (`auditLogs/wo_<entry id>`) is
     * written by the same transaction (D-3); a run that finds nothing due writes neither.
     * @returns {Promise<Object>} fields written
     */
    static async applyWriteOffTransaction(transactionType, bill, reason) {
        return updateBillInTransaction(COLLECTION_BY_TYPE[transactionType] || 'wholesaleSales', bill.id, null, (fresh) => {
            if (!isActiveBill(fresh)) throw Object.assign(new Error('This bill was voided'), { code: 'voided' });
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
            let audit = null;
            if (amount > 0) {
                const by = this.clearedFields();
                const at = Date.now();
                const id = Helpers.generateId();
                update.payments = [...(Array.isArray(fresh.payments) ? fresh.payments : []), {
                    id,
                    kind: 'writeOff',
                    amount,
                    reason,
                    date: by.clearedAt,
                    at,
                    recordedBy: by.clearedByName,
                    recordedById: by.clearedBy
                }];
                // A write-off is a bad debt of this period: phones keep loading the bill (#163).
                update.paidAt = at;
                audit = {
                    id: `wo_${id}`,
                    data: AuditService.entry(AuditService.ACTIONS.CLEAR_DUE, {
                        billNumber: fresh.billNumber || bill.billNumber || 'N/A',
                        transactionType,
                        method: 'writeOff',
                        amount,
                        reason,
                        customer: fresh.customerName || 'N/A'
                    })
                };
            }
            update.openDue = false;
            update.clientVersion = FirebaseService.CLIENT_VERSION;
            return { bill: update, result: update, audit };
        });
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
            // wholesale: the Wholesale page's bill view, found by id
            await window.app.wholesaleSales.reprintSaleById(transactionId);
        }
    }
}

// Data changes re-render this page (firestore-service.js emits, utils/events.js).
on(REFRESH.due, () => OutstandingManager.renderDue());
