/**
 * @fileoverview History Management Module
 * Handles bill history, sales history, and transaction records
 * Provides both card and table view modes for displaying history
 * @module modules/history
 */

import { AppState } from '../utils/state.js';
import { SecurityMonitor } from '../services/security-monitor.js';
import { on, PRINT_STATUS_CHANGED, REFRESH } from '../utils/events.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
import { Helpers } from '../utils/helpers.js';
import { attachOlderHistoryScroll } from '../ui/infinite-scroll.js';
import { PrinterService } from '../services/printer.js';
import {
    ensureHistoryFrom, isFullHistoryLoaded, historyLoadedFrom, formatWindowDate, findBillIndex,
    renderStaleHistoryHint, rangeStatus, retryRange, applyRangeState, needsHistoryFrom, loadOlderHistory, monthStart
} from '../utils/history-window.js';
import {
    filterHistoryBills, resolveHistoryRange, normalizeHistoryFilter, formatHistoryRange, billDateOf, billTimeMs,
    validateCustomRange, olderMonthsToLoad, normalizeHistoryTab, isWholesaleHistoryLink,
    HISTORY_FILTER_KEY, HISTORY_TAB_KEY, WIDE_LOAD_MONTHS
} from '../utils/history-filters.js';
import { buildBillRow, buildOpeningGroup, addOpeningToggle, addVoidedToggle, billTableHtml, printStatusText } from '../ui/bill-row.js';
import { printStatusOf, recordPrint } from '../utils/print-status.js';
import { STORAGE_FULL_KEY } from '../utils/storage-full.js';
import { accessFor, canDeleteBillWith, canVoidBillWith, historyCutoff, withinBillEditWindow } from '../utils/role-access.js';
import { askReason, editsRowHtml, renderEditsList, setBillActions, voidedBannerHtml } from '../ui/bill-status.js';
import { voidBlocker } from '../utils/bill-edits.js';
import { buildReprintPayload, buildBillShareText } from '../utils/bill-share.js';
import { todayLocalISO } from '../utils/dates.js';
import { paymentBreakdown } from '../utils/due-payments.js';
import { whatsAppShareUrl } from '../utils/release-info.js';
import { openExternal } from '../utils/open-external.js';
import { billTraceId } from '../utils/status-report.js';
import { t, tn } from '../i18n/index.js';
import { billLabour, billLineTotal, billTotal, isActiveBill, isOpeningRecord, readPayment } from '../utils/money.js';

const L = (key, params) => Helpers.escapeHtml(t(key, params));
const NOUN_KEYS = { purchase: 'ui.history.noun_purchase', sale: 'ui.history.noun_sale' };
/** Bill type → Firestore collection key and AppState list. */
const BILL_COLLECTION = { purchase: 'purchases', retail: 'retailSales', wholesale: 'wholesaleSales' };
const BILL_STATE = { purchase: 'purchaseHistory', retail: 'retailSalesHistory', wholesale: 'salesHistory' };

/**
 * The bills of a type that History can show and open: AppState's list (bills
 * that count) plus the voided ones FirebaseService keeps aside (#75), each once.
 * @param {'purchase'|'retail'|'wholesale'} type
 * @returns {Array<Object>}
 */
export function billPool(type) {
    const list = AppState[BILL_STATE[type]] || [];
    const voided = BILL_COLLECTION[type] ? (FirebaseService.voidedBills?.(BILL_COLLECTION[type]) || []) : [];
    if (!voided.length) return list;
    const ids = new Set(list.map(b => String(b?.id)));
    return [...list, ...voided.filter(b => !ids.has(String(b?.id)))];
}

/**
 * Stable reference to a bill for inline onclick handlers. Indices into the
 * history arrays shift when live sync or older-history loads add records, so
 * handlers pass the bill id instead ("id:<id>"); viewBill resolves it.
 * @param {Object} bill
 * @returns {string} JS-and-HTML-escaped string literal body
 */
const billRef = (bill) => Helpers.escapeJsAttr(`id:${bill.id}`);

/**
 * History Manager - Manages transaction history
 * @class HistoryManager
 */
export class HistoryManager {
    /**
     * Current view mode for history display
     * @type {'card'|'table'}
     * @static
     */
    static viewMode = 'card';

    /** Search term of the last render (infinite scroll is off while searching). */
    static activeSearch = '';

    /** True while "Search older bills" is loading full history. */
    static searchingOlder = false;

    /** Bills rendered per page; more on "Show more" / scroll (#24). */
    static PAGE_SIZE = 50;
    static visibleCount = 50;
    static pageKey = '';
    /** Full filtered + sorted list of the last render (search covers all of it). */
    static pageBills = [];
    static pageType = 'purchase';
    /** Old-app opening records of the last render (shown only when the toggle is on). */
    static pageOpenings = [];

    /** "Show dues carried from old app" toggle, per tab (off by default). */
    static showOpening = { purchase: false, sale: false };
    /** Old-app opening records matching the current tab, dates and search. */
    static openingCount = 0;

    /** "Show voided bills" toggle, per tab (off by default, #75). */
    static showVoided = { purchase: false, sale: false };
    /** Voided bills of the last render (shown only when the toggle is on). */
    static pageVoided = [];
    /** Voided bills matching the current tab, dates and search. */
    static voidedCount = 0;

    /** A saved filter from before asked for wholesale bills: open Wholesale › History once. */
    static pendingWholesaleRedirect = false;
    static showMoreObserver = null;

    /** Type + date filter (#160); remembered for the browser session. */
    static filter = null;

    /** Active date range of the last render ({from, to} ms, null = open). */
    static activeRange = { from: null, to: null };

    /**
     * Range part not covered by the loaded window and not loaded automatically:
     * 'confirm' = a wide From needing the user's OK, 'older' = a To-only range.
     * @type {?{kind: 'confirm'|'older', from?: number}}
     */
    static rangeGap = null;

    /** Earliest range start the user agreed to load in this page session (ms). */
    static confirmedFrom = null;

    /** True while "Load older" from the range footer is running. */
    static loadingGap = false;

    /**
     * Tab (Purchase / Sale, remembered per device) + dates (remembered for the session).
     * @returns {{type: 'purchase'|'sale', preset: string, from: string, to: string}}
     */
    static getFilter() {
        if (!this.filter) {
            let saved = null;
            let tab = null;
            try { saved = sessionStorage.getItem(HISTORY_FILTER_KEY); } catch { /* storage blocked */ }
            try { tab = localStorage.getItem(HISTORY_TAB_KEY); } catch { /* storage blocked */ }
            if (!tab && isWholesaleHistoryLink(saved)) this.pendingWholesaleRedirect = true;
            const filter = normalizeHistoryFilter(saved);
            this.filter = { ...filter, type: tab ? normalizeHistoryTab(tab) : filter.type };
        }
        return this.filter;
    }

    static setFilter(patch) {
        this.filter = normalizeHistoryFilter({ ...this.getFilter(), ...patch });
        try { sessionStorage.setItem(HISTORY_FILTER_KEY, JSON.stringify(this.filter)); } catch { /* storage blocked */ }
        if (patch.type !== undefined) {
            try { localStorage.setItem(HISTORY_TAB_KEY, this.filter.type); } catch { /* storage blocked */ }
        }
        return this.filter;
    }

    /** Wholesale bills live on the Wholesale page: old History links go to Wholesale › History. */
    static openWholesaleHistory() {
        this.pendingWholesaleRedirect = false;
        window.app?.nav?.showTab?.('wholesale-history');
    }

    /**
     * Render purchase or (retail) sale bills with date filter, search and paging.
     * Wholesale bills are on the Wholesale page. Old-app opening records are
     * hidden unless the tab's "Show dues carried from old app" toggle is on.
     * Supports both card and table view modes
     * @param {'purchase'|'sale'} [type] - Tab (defaults to the remembered one;
     *   old values: 'retail' = Sale, 'all' = Purchase, 'wholesale' opens Wholesale › History)
     * @param {string} [searchTerm=''] - Optional search term to filter by
     */
    static renderHistory(type, searchTerm = '') {
        const container = document.getElementById("historyList");
        if (!container) return;

        if (isWholesaleHistoryLink(type) || (this.getFilter() && this.pendingWholesaleRedirect)) {
            this.openWholesaleHistory();
            return;
        }
        if (type && normalizeHistoryTab(type) !== this.getFilter().type) this.setFilter({ type: normalizeHistoryTab(type) });
        const filter = this.getFilter();
        type = filter.type;
        this.syncFilterUi();

        const range = resolveHistoryRange(filter.preset, new Date(), filter);
        this.activeRange = range;
        // Ranges older than the loaded window load on demand (with a notice);
        // wide ones wait for the user's OK, To-only ones load on "Load older".
        // "All dates" keeps the month-by-month infinite scroll instead.
        this.rangeGap = null;
        let status = 'ready';
        if (range.from !== null) {
            const confirmed = this.confirmedFrom !== null && this.confirmedFrom <= range.from;
            if (needsHistoryFrom(range.from) && !confirmed &&
                olderMonthsToLoad(range.from, historyLoadedFrom()) > WIDE_LOAD_MONTHS) {
                this.rangeGap = { kind: 'confirm', from: range.from };
            } else {
                status = rangeStatus('history', range.from, () => this.refreshHistory());
            }
        } else if (range.to !== null && !isFullHistoryLoaded()) {
            this.rangeGap = { kind: 'older' };
        }
        applyRangeState(container, status, {
            loadingText: t('ui.history.loading_older_bills'),
            errorText: t('ui.history.older_load_failed', { date: formatWindowDate(historyLoadedFrom()) }),
            onRetry: () => { retryRange('history'); this.refreshHistory(); }
        });
        
        // Purchases or retail sales (wholesale bills are on the Wholesale page)
        const tabBills = type === 'sale'
            ? billPool('retail').map(s => ({ ...s, type: 'retail', isPurchase: false }))
            : billPool('purchase').map(b => ({ ...b, type: 'purchase', isPurchase: true }));
        const cutoff = historyCutoff(AppState.userRole, AppState.settings?.roleAccess);
        const allHistory = tabBills.filter(b => cutoff === null || billTimeMs(b) >= cutoff);
        
        const matched = filterHistoryBills(allHistory, { type, range, search: searchTerm });
        // Voided bills (#75) and old-app carried dues are hidden unless their toggle is on.
        const voided = matched.filter(b => !isActiveBill(b));
        const live = matched.filter(isActiveBill);
        const openings = live.filter(b => isOpeningRecord(b));
        const sortedBills = live.filter(b => !isOpeningRecord(b));
        const showOpenings = !!this.showOpening[type] && openings.length > 0;
        const showVoided = !!this.showVoided[type] && voided.length > 0;
        this.pageOpenings = showOpenings ? openings : [];
        this.openingCount = openings.length;
        this.pageVoided = showVoided ? voided : [];
        this.voidedCount = voided.length;
        this.updateRangeLabel(range, sortedBills.length + this.pageOpenings.length + this.pageVoided.length);
        
        // Check view mode and render accordingly
        this.activeSearch = (searchTerm || '').trim();
        // Only the first PAGE_SIZE bills go into the DOM; live refreshes keep
        // how many are shown, a new filter/search/view starts over (#24).
        const pageKey = `${type}|${filter.preset}|${range.from}|${range.to}|${this.activeSearch}|${this.viewMode}|${showOpenings}|${showVoided}`;
        if (pageKey !== this.pageKey) {
            this.pageKey = pageKey;
            this.visibleCount = this.PAGE_SIZE;
        }
        this.pageBills = sortedBills;
        this.pageType = type;
        if (this.viewMode === 'table') {
            this.renderHistoryTable(sortedBills.slice(0, this.visibleCount), type);
            this.renderShowMore(container);
            this.updateOlderHistoryUi();
            return;
        }

        if (sortedBills.length === 0 && !showOpenings && !showVoided) {
            container.innerHTML = `<p style="text-align: center; color: #888; margin-top: 40px;">${Helpers.escapeHtml(this.emptyMessage(type, searchTerm))}</p>`;
            this.renderShowMore(container);
            this.updateOlderHistoryUi();
            return;
        }

        container.innerHTML = "";
        const fragment = document.createDocumentFragment();
        if (showOpenings) fragment.appendChild(buildOpeningGroup(openings, bill => this.buildHistoryCard(bill)));
        if (showVoided) fragment.appendChild(buildOpeningGroup(voided, bill => this.buildHistoryCard(bill), 'voided'));
        sortedBills.slice(0, this.visibleCount).forEach(bill => fragment.appendChild(this.buildHistoryCard(bill)));
        container.appendChild(fragment);
        this.renderShowMore(container);
        this.updateOlderHistoryUi();
    }

    /** True while loaded bills matching the current filter are not in the DOM yet. */
    static hasHiddenBills() {
        return this.pageBills.length > this.visibleCount;
    }

    /**
     * Adds the next PAGE_SIZE bills of the current list (Show more button,
     * or automatically when the button scrolls into view).
     */
    static showMoreHistory() {
        const container = document.getElementById('historyList');
        if (!container || !this.hasHiddenBills()) return;
        const from = this.visibleCount;
        this.visibleCount += this.PAGE_SIZE;
        if (this.viewMode === 'table') {
            this.renderHistoryTable(this.pageBills.slice(0, this.visibleCount), this.pageType);
        } else {
            container.querySelector('.history-show-more')?.remove();
            const fragment = document.createDocumentFragment();
            this.pageBills.slice(from, this.visibleCount).forEach(bill => fragment.appendChild(this.buildHistoryCard(bill)));
            container.appendChild(fragment);
        }
        this.renderShowMore(container);
        this.updateOlderHistoryUi();
    }

    /** "Show more" row at the end of the list while loaded bills are hidden. */
    static renderShowMore(container) {
        this.showMoreObserver?.disconnect();
        this.showMoreObserver = null;
        container.querySelector('.history-show-more')?.remove();
        if (!this.hasHiddenBills()) return;
        const row = document.createElement('div');
        row.className = 'history-show-more';
        row.style.cssText = 'text-align:center;padding:12px;';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'infinite-scroll-more';
        btn.textContent = t('ui.history.show_more', { count: this.pageBills.length - this.visibleCount });
        btn.addEventListener('click', () => this.showMoreHistory());
        row.appendChild(btn);
        container.appendChild(row);
        if (typeof IntersectionObserver === 'function') {
            this.showMoreObserver = new IntersectionObserver(entries => {
                if (entries.some(e => e.isIntersecting)) this.showMoreHistory();
            }, { rootMargin: '0px 0px 300px 0px' });
            this.showMoreObserver.observe(row);
        }
    }

    /**
     * One history row (shared layout with Wholesale › History, see ui/bill-row.js).
     * @param {Object} bill - type-tagged ('purchase' | 'retail')
     * @returns {HTMLElement}
     */
    static buildHistoryCard(bill) {
        return buildBillRow(bill, {
            kind: bill.type,
            onclick: `window.app.history.viewBill('${billRef(bill)}', '${Helpers.escapeJsAttr(bill.type)}')`
        });
    }

    /** "Show dues carried from old app" chip for the current tab. */
    static toggleOpenings() {
        const tab = this.getFilter().type;
        this.showOpening = { ...this.showOpening, [tab]: !this.showOpening[tab] };
        this.refreshHistory();
    }

    /** "Show voided bills" chip for the current tab (#75). */
    static toggleVoided() {
        const tab = this.getFilter().type;
        this.showVoided = { ...this.showVoided, [tab]: !this.showVoided[tab] };
        this.refreshHistory();
    }

    /**
     * Empty-list message; mentions the loaded window when older bills may exist.
     * @param {string} type
     * @param {string} searchTerm
     * @returns {string} plain text (caller escapes)
     */
    static emptyMessage(type, searchTerm) {
        if (searchTerm && searchTerm.trim()) return t('ui.history.no_results_for', { searchTerm });
        const noun = t(NOUN_KEYS[type] || NOUN_KEYS.purchase);
        const r = this.activeRange;
        if (this.rangeGap && (this.rangeGap.kind === 'confirm' || (r.to !== null && r.to <= historyLoadedFrom()))) {
            const date = formatWindowDate(historyLoadedFrom());
            return t('ui.history.not_loaded_tap_load_older', { date });
        }
        if (r.from !== null || r.to !== null) {
            return t('ui.history.none_in_period', { noun });
        }
        if (!isFullHistoryLoaded()) {
            return t('ui.history.none_since', { noun, date: formatWindowDate(historyLoadedFrom()) });
        }
        return t('ui.history.none_yet', { noun });
    }

    /**
     * Infinite scroll sentinel (loads one older month at a time) and the
     * "Search older bills" footer shown while searching a partial window.
     */
    static updateOlderHistoryUi() {
        const list = document.getElementById('historyList');
        if (!list) return;

        addVoidedToggle(list, {
            id: 'historyVoidedToggle', count: this.voidedCount, on: this.pageVoided.length > 0,
            onToggle: () => this.toggleVoided()
        });
        addOpeningToggle(list, {
            id: 'historyOpeningToggle', count: this.openingCount, on: this.pageOpenings.length > 0,
            onToggle: () => this.toggleOpenings()
        });
        const ranged = this.activeRange.from !== null || this.activeRange.to !== null;
        attachOlderHistoryScroll(list, {
            noun: 'bills',
            // Older months load only once every loaded bill is on screen.
            enabled: () => !this.activeSearch && !this.hasHiddenBills() && !ranged,
            onLoaded: () => this.refreshHistory()
        });
        // Only while bills older than the live window are on screen.
        const shown = [...this.pageOpenings, ...this.pageVoided, ...this.pageBills.slice(0, this.visibleCount)];
        renderStaleHistoryHint(list, {
            id: 'historyStaleHint',
            onRefreshed: () => this.refreshHistory(),
            isRelevant: (info) => shown.some(b => { const ms = billTimeMs(b); return ms !== null && ms < info.liveFrom; })
        });
        this.renderRangeGap(list);

        let footer = document.getElementById('historySearchFooter');
        if (!footer) {
            footer = document.createElement('div');
            footer.id = 'historySearchFooter';
            footer.className = 'history-search-footer';
            list.parentNode?.appendChild(footer);
        }
        if (!this.activeSearch || ranged || (isFullHistoryLoaded() && !this.searchingOlder)) {
            footer.style.display = 'none';
            footer.textContent = '';
            return;
        }
        footer.style.display = '';
        footer.textContent = '';
        const text = document.createElement('span');
        text.textContent = t('ui.history.matches_since', { date: formatWindowDate(historyLoadedFrom()) });
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'history-search-older-btn';
        btn.disabled = this.searchingOlder;
        btn.textContent = t(this.searchingOlder ? 'ui.history.searching_older' : 'ui.history.search_older');
        btn.addEventListener('click', () => this.searchOlderBills());
        footer.append(text, ' ', btn);
    }

    /**
     * Load the full history (explicit user action — expensive) and re-run
     * the current search over it.
     * @async
     */
    static async searchOlderBills() {
        if (this.searchingOlder) return;
        this.searchingOlder = true;
        this.updateOlderHistoryUi();
        try {
            const covered = await ensureHistoryFrom(null);
            if (!covered) UIManager.showToast(t('msg.history.couldn_t_load_older_bills'));
        } catch (error) {
            console.error('Loading full history failed:', error);
            UIManager.showToast(t('msg.history.couldn_t_load_older_bills'));
        } finally {
            this.searchingOlder = false;
            this.refreshHistory();
        }
    }

    /**
     * Resolve a viewBill reference ("id:<id>" from the list, or a legacy
     * numeric index) to the bill's current index in `history`.
     * @param {Array<Object>} history
     * @param {string|number} ref
     * @returns {number}
     */
    static resolveBillIndex(history, ref) {
        if (typeof ref === 'string' && ref.startsWith('id:')) {
            return findBillIndex(history, ref.slice(3));
        }
        const index = Number(ref);
        return Number.isInteger(index) ? index : -1;
    }

    static async viewBill(ref, type = 'purchase') {
        if (!BILL_STATE[type]) {
            UIManager.showModal(t('msg.history.unknown_bill_type', { type }));
            return;
        }
        // Bills that count and voided ones (#75)
        const history = billPool(type);
        const index = this.resolveBillIndex(history, ref);
        const bill = history[index];
        
        if (!bill) {
            UIManager.showModal(t('msg.common.bill_not_found'));
            return;
        }
        
        // Store bill index, id and type for edit/delete (id re-resolves the
        // index later in case the arrays shifted in between)
        window.currentBillIndex = index;
        window.currentBillId = bill.id;
        window.currentBillType = type;
        
        const totalPackets = bill.totalPackets || 0;
        const isPurchase = type === 'purchase';
        const billColor = isPurchase ? '#007bff' : '#28a745';
        
        // Build weight breakdown (purchases and sales)
        let weightBreakdownHTML = '';
        bill.items.forEach(item => {
            // Only show weight breakdown if there are 2 or more packets
            if (item.weights && item.weights.length >= 2) {
                const weightsDisplay = item.weights.map(w => parseFloat(w).toFixed(1)).join('&nbsp;&nbsp;');
                weightBreakdownHTML += `
                    <div style="background: #f8f9fa; padding: 12px; border-radius: 8px; margin-bottom: 12px; border-left: 4px solid ${billColor};">
                        <div style="font-weight: 600; color: #495057; margin-bottom: 6px;">${Helpers.escapeHtml(item.name)} (${Helpers.escapeHtml(tn('ui.history.packets_kg', item.weights.length, { packets: item.weights.length, kg: (item.qty || 0).toFixed(1) }))})</div>
                        <div style="color: #6c757d; font-size: 14px; white-space: pre;">${weightsDisplay}</div>
                    </div>
                `;
            }
        });
        
        // Build items table
        const itemsHTML = bill.items.map(item => `
            <tr>
                <td style="padding: 10px 8px; border-bottom: 1px solid #e5e7eb;">${Helpers.escapeHtml(item.name)}</td>
                <td style="padding: 10px 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">${Helpers.escapeHtml(item.rate)}</td>
                <td style="padding: 10px 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">${Number(item.qty || item.quantity || 0).toFixed(1)}</td>
                <td style="padding: 10px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;"><strong>${Helpers.escapeHtml(item.total)}</strong></td>
            </tr>
        `).join('');
        
        // Paid at save, paid later, written off and still due add up to the total (T18 on Today shows the same parts)
        // A voided bill counts nowhere, but its details still show what was paid (it may need refunding)
        const voidPay = isActiveBill(bill) ? null : readPayment(bill);
        const parts = voidPay
            ? { atSave: { cash: voidPay.cash, online: voidPay.online }, later: { cash: 0, online: 0, total: 0 }, writtenOff: 0, due: 0 }
            : paymentBreakdown(bill);
        const afterSave = parts.later.total > 0 || parts.writtenOff > 0;
        const money = (v) => Helpers.escapeHtml(Helpers.formatCurrency(v));
        const payRow = (key, value, bg, fg, note = '') => `
                    <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 0; font-size: 14px;">
                        <span>${L(key)}${note ? `<br><small style="color: #595959;">${Helpers.escapeHtml(note)}</small>` : ''}</span>
                        <span style="display: inline-block; padding: 4px 12px; border-radius: 6px; font-weight: 600; background: ${bg}; color: ${fg};">${money(value)}</span>
                    </div>`;
        const paymentHTML = (parts.atSave.online > 0 || parts.atSave.cash > 0 || afterSave || parts.due > 0) ? `
            <div style="background: white; padding: 14px; border-radius: 10px; border: 1px solid #dee2e6; margin-top: 12px;">
                <h4 style="margin: 0 0 12px 0; font-size: 15px; color: #212529;">${L('ui.history.payment_details')}</h4>
                ${parts.atSave.online > 0 ? payRow(afterSave ? 'ui.history.online_at_save' : 'ui.history.online', parts.atSave.online, '#cfe2ff', '#084298') : ''}
                ${parts.atSave.cash > 0 ? payRow(afterSave ? 'ui.history.cash_at_save' : 'ui.history.cash', parts.atSave.cash, '#d1e7dd', '#0f5132') : ''}
                ${parts.later.total > 0 ? payRow('ui.history.paid_later', parts.later.total, '#e0f2fe', '#075985',
                    t('ui.history.paid_later_split', { cash: Helpers.formatCurrency(parts.later.cash), online: Helpers.formatCurrency(parts.later.online) })) : ''}
                ${parts.writtenOff > 0 ? payRow('ui.history.written_off', parts.writtenOff, '#f3f4f6', '#374151') : ''}
                ${parts.due > 0 ? payRow('ui.history.due', parts.due, '#fff3cd', '#997404') : ''}
            </div>
        ` : '';
                const billNumber = bill.billNumber || (typeof bill.id === 'string' ? bill.id.substring(0, 8) : bill.id);
        
        const content = `
            <div style="padding: 16px; max-width: 100%;">
                ${voidedBannerHtml(bill)}
                <div class="bill-info-section">
                    <div class="bill-info-row">
                        <div class="bill-info-label">${L('ui.history.bill_no')}</div>
                        <div class="bill-info-value"><strong style="color: ${billColor};">#${Helpers.escapeHtml(billNumber)}</strong></div>
                    </div>
                    <div class="bill-info-row">
                        <div class="bill-info-label">${L('ui.history.date_label')}</div>
                        <div class="bill-info-value">${Helpers.formatDateTime(billDateOf(bill) || bill.date)}</div>
                    </div>
                    ${bill.createdByName || bill.userName ? `
                        <div class="bill-info-row">
                            <div class="bill-info-label">${L('ui.history.created_by')}</div>
                            <div class="bill-info-value">${Helpers.escapeHtml(bill.createdByName || bill.userName)}</div>
                        </div>
                    ` : ''}
                    ${bill.customerName ? `
                        <div class="bill-info-row">
                            <div class="bill-info-label">${L('ui.common.customer')}</div>
                            <div class="bill-info-value"><strong>${Helpers.escapeHtml(bill.customerName)}</strong></div>
                        </div>
                    ` : ''}
                    ${billTraceId(bill, type) ? `
                        <div class="bill-info-row bill-trace-row">
                            <div class="bill-info-label">${L('ui.status.trace_id')}</div>
                            <div class="bill-info-value"><code lang="zxx" translate="no" style="font-size:12px;">${Helpers.escapeHtml(billTraceId(bill, type))}</code>
                                <button type="button" class="btn-link bill-trace-copy" onclick="window.app.history.copyTraceId()" style="margin-left:6px;font-size:12px;">${L('ui.status.copy_short')}</button></div>
                        </div>
                    ` : ''}
                </div>
                
                ${bill.comments ? `
                    <div style="margin-bottom: 12px; padding: 10px; background: #fff3cd; border-radius: 8px; border-left: 4px solid #ffc107;">
                        <span style="color: #6c757d; font-size: 14px;">${L('ui.wholesale.comments')}</span>
                        <div style="font-size: 14px; color: #212529; margin-top: 4px;">${Helpers.escapeHtml(bill.comments)}</div>
                    </div>
                ` : ''}
                
                ${weightBreakdownHTML ? `
                    <div style="margin: 16px 0;">
                        <h4 style="margin-bottom: 12px; color: #212529; font-size: 15px;">${L('ui.history.weight_breakdown')}</h4>
                        ${weightBreakdownHTML}
                    </div>
                ` : ''}
                
                <h4 style="margin: 16px 0 12px 0; color: #212529; font-size: 15px;">${L(isPurchase ? 'ui.common.bill_items' : 'ui.history.sale_items')}</h4>
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
                
                <div style="text-align: right; padding: 8px 0; font-size: 14px; color: #6c757d; margin-bottom: 12px;">
                    ${L('ui.billing.total_packets')} <strong style="color: #212529; font-size: 15px;">${Helpers.escapeHtml(totalPackets)}</strong>
                </div>
                
                <div style="background: white; padding: 14px; border-radius: 10px; border: 1px solid #dee2e6;">
                    ${isPurchase ? `
                        <div style="display: flex; justify-content: space-between; padding: 8px 0; font-size: 15px;">
                            <span style="font-weight: 600;">${L('ui.billing.purchase_total')}</span>
                            <strong style="font-size: 17px; color: ${billColor};">₹${Math.round(billLineTotal(bill, true))}</strong>
                        </div>
                        
                        ${billLabour(bill) > 0 ? `
                            <div style="display: flex; justify-content: space-between; padding: 8px 0; font-size: 15px; border-top: 1px solid #e9ecef;">
                                <span style="font-weight: 600;">${L('ui.billing.labor')}</span>
                                <strong style="font-size: 17px; color: #ffc107;">₹${Math.round(billLabour(bill))}</strong>
                            </div>
                            
                            <div style="display: flex; justify-content: space-between; padding: 12px 0; font-size: 16px; border-top: 2px solid ${billColor}; margin-top: 8px; background: linear-gradient(135deg, #e3f2fd, #bbdefb); margin: 8px -14px -14px -14px; padding: 12px 14px; border-radius: 0 0 10px 10px;">
                                <span style="font-weight: 700;">${L('ui.billing.total_payable')}</span>
                                <strong style="font-size: 18px; color: #1976d2;">₹${Math.round(billTotal(bill))}</strong>
                            </div>
                        ` : ''}
                    ` : `
                        <div style="display: flex; justify-content: space-between; padding: 8px 0; font-size: 15px;">
                            <span style="font-weight: 600;">${L('ui.billing.sale_total')}</span>
                            <strong style="font-size: 17px; color: ${billColor};">₹${Math.round(billTotal(bill))}</strong>
                        </div>
                    `}
                </div>
                
                ${paymentHTML}
                ${editsRowHtml(bill, 'window.app.history.showEdits()')}
            </div>
        `;
        
        document.getElementById('billDetailsContent').innerHTML = content;
        
        // Edit / Void only while this user may still change the bill (#87 edit window, #84, #75)
        const who = { uid: AppState.currentUser?.uid, role: AppState.userRole, raw: AppState.settings?.roleAccess };
        setBillActions(bill, who, { editable: type !== 'wholesale' });
        if (isActiveBill(bill) && AppState.userRole !== 'owner' && !withinBillEditWindow(bill, who)) {
            document.getElementById('billDetailsContent').insertAdjacentHTML('beforeend',
                `<div class="bill-window-note" style="margin: 0 16px 16px; padding: 10px; background: #f8f9fa; border-radius: 8px; color: #6c757d; font-size: 13px;">🔒 ${L('msg.roles.edit_window_closed', { days: accessFor(AppState.userRole, who.raw).editDays })}</div>`);
        }
        this.renderPrintStatus();
        
        document.getElementById('billDetailsOverlay').classList.add('active');
    }

    /** Copies the open bill's trace id (#119): kind letter + document id, no name or amount. */
    static async copyTraceId() {
        const bill = billPool(window.currentBillType).find(b => String(b.id) === String(window.currentBillId));
        const id = billTraceId(bill, window.currentBillType);
        if (!id) return;
        try {
            await navigator.clipboard.writeText(id);
            UIManager.showToast(t('msg.status.trace_copied', { id }), 'success');
        } catch (_) {
            UIManager.showModal(id);
        }
    }

    static closeBillDetails() {
        document.getElementById('billDetailsOverlay').classList.remove('active');
    }

    /**
     * "View changes" in the bill details (#121): reads the open bill's edit records
     * (one read each) the first time, then shows / hides them.
     */
    static async showEdits() {
        const list = document.getElementById('billEditsList');
        const toggle = document.getElementById('billEditsToggle');
        const current = this.currentBill();
        if (!list || !current) return;
        if (!list.hidden) {
            list.hidden = true;
            if (toggle) toggle.textContent = t('ui.edits.view_changes');
            return;
        }
        list.hidden = false;
        if (toggle) toggle.textContent = t('ui.edits.hide_changes');
        if (list.dataset.loaded === String(current.bill.id)) return;
        list.textContent = t('ui.edits.loading');
        try {
            const edits = await FirebaseService.loadBillEdits(BILL_COLLECTION[current.type], current.bill);
            renderEditsList(list, edits);
            list.dataset.loaded = String(current.bill.id);
        } catch (error) {
            console.error('Loading bill edits failed:', error);
            list.textContent = t('ui.edits.load_failed');
        }
    }

    /**
     * Void the open bill (#75): who may (canVoidBillWith), not with later payments
     * (voidBlocker), needs the internet and a reason. The bill stays in History
     * marked Voided and stops counting everywhere.
     */
    static async confirmVoidBill() {
        if (Helpers.isBusy('bill-void')) return;
        const current = this.currentBill();
        if (!current) {
            this.closeBillDetails();
            UIManager.showToast(t('msg.common.bill_not_found'));
            return;
        }
        const { bill, type } = current;
        const uid = AppState.currentUser?.uid;
        const who = { uid, role: AppState.userRole, raw: AppState.settings?.roleAccess };
        if (!canVoidBillWith(bill, who)) {
            const mine = !!bill.userId && bill.userId === uid;
            if (mine && isActiveBill(bill)) SecurityMonitor.noteOldBillTry(bill, type, 'void');
            UIManager.showToast(!isActiveBill(bill) ? t('msg.void.already')
                : mine ? t('msg.roles.edit_window_closed', { days: accessFor(AppState.userRole, who.raw).editDays })
                    : t('msg.history.only_person_who_created_bill'));
            return;
        }
        if (voidBlocker(bill) === 'payments') {
            UIManager.showModal(t('msg.void.has_payments'), t('ui.void.title'));
            return;
        }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            UIManager.showToast(t('msg.void.needs_internet'));
            return;
        }
        const reason = await askReason({ titleKey: 'ui.void.title', explainKey: 'ui.void.explain', labelKey: 'ui.void.reason_label' });
        if (!reason) return;
        await Helpers.runExclusive('bill-void', '#billVoidBtn', () => this.voidBill(type, bill, reason));
    }

    /** @private */
    static async voidBill(type, bill, reason) {
        try {
            UIManager.showLoading();
            await FirebaseService.voidBill(BILL_COLLECTION[type], bill, reason);
            AuditService.log(AuditService.ACTIONS.VOID_BILL, {
                billNumber: bill.billNumber || 'N/A',
                billType: type,
                amount: billTotal(bill),
                customer: bill.customerName || 'N/A',
                reason
            }).catch(e => console.warn('Audit log failed:', e));
            this.afterBillRemoved();
            UIManager.hideLoading();
            UIManager.showToast(t('msg.void.done'));
        } catch (error) {
            console.error('Error voiding bill:', error);
            UIManager.hideLoading();
            const key = error?.code === 'has-payments' ? 'msg.void.has_payments'
                : error?.code === 'already-voided' ? 'msg.void.already'
                    : (error?.code === 'unavailable' || (typeof navigator !== 'undefined' && navigator.onLine === false)) ? 'msg.void.needs_internet'
                        : 'msg.void.failed';
            UIManager.showToast(t(key));
        }
    }

    /** Closes the details and refreshes what a voided or deleted bill changes. @private */
    static afterBillRemoved() {
        this.closeBillDetails();
        this.refreshHistory();
        window.app?.wholesaleSales?.renderHistory?.();
        window.app?.wholesaleSales?.renderOutstanding?.();
        FirebaseService.calculateStock()
            .then(stock => { AppState.stock = stock; })
            .catch(error => console.error('Stock recalculation after void failed:', error));
        window.app?.outstanding?.renderDue?.();
    }

    /** Owner only: delete a voided bill for good (test data, mistakes). */
    static async confirmDeleteBill() {
        const current = this.currentBill();
        if (!current || !canDeleteBillWith(current.bill, { role: AppState.userRole })) {
            UIManager.showToast(t('msg.common.bill_not_found'));
            return;
        }
        const confirmed = await UIManager.showModal(
            t('msg.void.delete_confirm'),
            t('msg.history.delete_bill'),
            true
        );
        if (confirmed) await this.deleteBill();
    }

    static async deleteBill() {
        const current = this.currentBill();
        if (!current || !canDeleteBillWith(current.bill, { role: AppState.userRole })) {
            this.closeBillDetails();
            UIManager.showToast(t('msg.common.bill_not_found'));
            return;
        }
        const { bill, type } = current;
        try {
            UIManager.showLoading();
            await FirebaseService.deleteVoidedBill(BILL_COLLECTION[type], bill);
            AuditService.log(type === 'purchase' ? AuditService.ACTIONS.DELETE_BILL : AuditService.ACTIONS.DELETE_SALE, {
                billNumber: bill.billNumber || 'N/A',
                amount: billTotal(bill),
                customer: bill.customerName || 'N/A',
                voided: true
            }).catch(e => console.warn('Audit log failed:', e));
            this.afterBillRemoved();
            UIManager.hideLoading();
            UIManager.showToast(t('msg.void.deleted'));
        } catch (error) {
            console.error('Error deleting bill:', error);
            UIManager.hideLoading();
            // Refused by the rules (only the owner deletes, and only a voided bill: #75)
            UIManager.showToast(t(error?.code === 'permission-denied' ? 'msg.void.delete_refused' : 'msg.history.failed_delete_bill'));
        }
    }

    static searchHistory(searchTerm) {
        this.renderHistory(this.getFilter().type, searchTerm);
    }

    static refreshHistory() {
        const searchInput = document.getElementById('historySearch');
        this.searchHistory(searchInput ? searchInput.value : '');
    }

    /**
     * Tab (Purchase / Sale). Keeps the search text and date range so they work
     * together; the tab is remembered on this device. Old 'wholesale' links
     * open Wholesale › History.
     * @param {string} type
     */
    static filterHistory(type) {
        if (isWholesaleHistoryLink(type)) {
            this.openWholesaleHistory();
            return;
        }
        this.pendingWholesaleRedirect = false;
        this.setFilter({ type: normalizeHistoryTab(type) });
        this.refreshHistory();
    }

    /** Date preset select (all/today/yesterday/week/month/lastMonth/custom). */
    static setDatePreset(preset) {
        const patch = { preset };
        if (preset === 'custom' && !this.getFilter().from && !this.getFilter().to) {
            patch.from = patch.to = todayLocalISO();
        }
        this.setFilter(patch);
        this.showRangeHint('');
        this.refreshHistory();
    }

    /**
     * Apply the custom From/To dates (Apply button). Invalid or half-typed
     * dates are rejected with a hint; loading many months older than the
     * window asks first. Nothing is saved or loaded unless it passes.
     * @param {string} [from] - defaults to the From input
     * @param {string} [to] - defaults to the To input
     * @returns {Promise<boolean>} true when applied
     */
    static async applyCustomRange(from, to) {
        if (from === undefined) from = document.getElementById('historyFromDate')?.value || '';
        if (to === undefined) to = document.getElementById('historyToDate')?.value || '';
        const check = validateCustomRange(from, to);
        this.showRangeHint(check.ok ? '' : check.error);
        if (!check.ok) return false;
        const range = resolveHistoryRange('custom', new Date(), check);
        if (range.from !== null) {
            if (!(await this.confirmOlderLoad(range.from))) return false;
            if (this.confirmedFrom === null || range.from < this.confirmedFrom) this.confirmedFrom = range.from;
        }
        this.setFilter({ preset: 'custom', from: check.from, to: check.to });
        this.refreshHistory();
        return true;
    }

    /** @deprecated kept for callers of the old API; same as applyCustomRange */
    static setCustomRange(from, to) {
        return this.applyCustomRange(from || '', to || '');
    }

    /** Bilingual validation hint under the custom range inputs. */
    static showRangeHint(text) {
        const hint = document.getElementById('historyRangeHint');
        if (!hint) return;
        hint.textContent = text || '';
        hint.hidden = !text;
    }

    /**
     * Ask before loading many months older than the loaded window (data use).
     * @param {number} fromMs
     * @returns {Promise<boolean>} true = go ahead
     */
    static async confirmOlderLoad(fromMs) {
        const months = olderMonthsToLoad(fromMs, historyLoadedFrom());
        if (months <= WIDE_LOAD_MONTHS) return true;
        return !!(await UIManager.showModal(
            t('msg.history.will_load_months_older_bills', { months }),
            t('msg.history.load_older_bills'),
            true
        ));
    }

    /** "Bills before <date> aren't loaded — Load older" row for an unloaded range part. */
    static renderRangeGap(list) {
        let row = document.getElementById('historyRangeGap');
        if (!this.rangeGap) {
            row?.remove();
            return;
        }
        if (!row) {
            row = document.createElement('div');
            row.id = 'historyRangeGap';
            row.className = 'history-search-footer history-range-gap';
        }
        if (row.previousElementSibling !== list) list.after(row);
        const date = formatWindowDate(historyLoadedFrom());
        row.textContent = '';
        const text = document.createElement('span');
        text.textContent = t('ui.history.bills_before_not_loaded', { date });
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'history-search-older-btn';
        btn.disabled = this.loadingGap;
        btn.textContent = t(this.loadingGap ? 'ui.history.loading' : 'ui.history.load_older');
        btn.addEventListener('click', () => this.loadRangeGap());
        row.append(text, ' ', btn);
    }

    /**
     * "Load older": a wide From range loads after the confirm; a To-only range
     * loads back to the month of its To date (confirming if that is wide), or
     * one more month when the window already reaches it.
     */
    static async loadRangeGap() {
        const gap = this.rangeGap;
        if (!gap || this.loadingGap) return;
        if (gap.kind === 'confirm') {
            if (!(await this.confirmOlderLoad(gap.from))) return;
            this.confirmedFrom = gap.from;
            this.refreshHistory();
            return;
        }
        this.loadingGap = true;
        this.refreshHistory();
        try {
            const to = this.activeRange.to;
            const target = to !== null ? monthStart(0, new Date(to - 1)).getTime() : null;
            if (target !== null && needsHistoryFrom(target)) {
                if (await this.confirmOlderLoad(target)) {
                    const covered = await ensureHistoryFrom(target);
                    if (!covered) UIManager.showToast(t('msg.history.couldn_t_load_older_bills'));
                }
            } else {
                await loadOlderHistory(1);
            }
        } catch (error) {
            console.error('Loading older bills failed:', error);
            UIManager.showToast(t('msg.history.couldn_t_load_older_bills'));
        } finally {
            this.loadingGap = false;
            this.refreshHistory();
        }
    }

    /** Reflect the remembered filter in the History controls. */
    static syncFilterUi() {
        const filter = this.getFilter();
        document.querySelectorAll('#history .history-type-filter .filter-btn').forEach(btn => {
            const active = btn.dataset.type === filter.type;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        const preset = document.getElementById('historyDatePreset');
        if (preset && preset.value !== filter.preset) preset.value = filter.preset;
        const custom = document.getElementById('historyCustomRange');
        if (custom) custom.hidden = filter.preset !== 'custom';
        const from = document.getElementById('historyFromDate');
        const to = document.getElementById('historyToDate');
        // Only when the saved range changed: a live re-render must not wipe dates being typed.
        const key = `${filter.from}|${filter.to}`;
        if (from && to && (this.syncedRangeKey !== key || from.dataset.synced !== '1')) {
            from.value = filter.from;
            to.value = filter.to;
            from.dataset.synced = '1';
            this.syncedRangeKey = key;
        }
    }

    static syncedRangeKey = null;

    /** "01/10/2026 – 22/10/2026 · 12 bills" under the filters. */
    static updateRangeLabel(range, count) {
        const label = document.getElementById('historyRangeLabel');
        if (!label) return;
        const text = formatHistoryRange(range);
        label.textContent = text ? `${text} · ${t(count === 1 ? 'ui.outstanding.bills_one' : 'ui.outstanding.bills_many', { count })}` : '';
        label.hidden = !text;
    }

    /**
     * The bill open in the details overlay (re-resolved by id; arrays shift).
     * @returns {{bill: Object, type: string}|null}
     */
    static currentBill() {
        const type = window.currentBillType;
        if (!BILL_STATE[type]) return null;
        const history = billPool(type);
        const index = findBillIndex(history, window.currentBillId, window.currentBillIndex);
        const bill = history[index];
        return bill ? { bill, type } : null;
    }

    /**
     * Reprint the open bill with its own date and a "COPY / प्रति" mark.
     * Uses the normal print path (Bluetooth, else image preview with
     * share/download), works from cached bills offline, never changes the bill.
     */
    static async reprintBill() {
        const current = this.currentBill();
        if (!current) {
            UIManager.showToast(t('msg.common.bill_not_found'));
            return;
        }
        try {
            await PrinterService.printBill(buildReprintPayload(current.bill, current.type));
        } catch (error) {
            console.error('Reprint failed:', error);
            UIManager.showToast(t('msg.history.reprint_failed'));
        }
    }

    /**
     * The open bill's print status on this phone (#132). After a failed or
     * may-have-printed print: Print again (no COPY mark, the customer has no slip
     * yet); until printed: Mark printed by hand.
     */
    static renderPrintStatus() {
        const host = document.getElementById('billDetailsContent');
        const current = this.currentBill();
        host?.querySelector('#billPrintStatus')?.remove();
        if (!host || !current || !isActiveBill(current.bill) || isOpeningRecord(current.bill)) return;
        const st = printStatusOf(current.bill);
        const retry = !!st && (st.s === 'failed' || st.s === 'uncertain');
        const markHand = !st || st.s === 'failed' || st.s === 'uncertain';
        host.insertAdjacentHTML('beforeend', `
            <div class="bill-print-status" id="billPrintStatus" data-state="${Helpers.escapeHtml(st ? st.s : 'none')}">
                <span class="bill-print-status__text">🖨️ ${Helpers.escapeHtml(printStatusText(current.bill, (e) => PrinterService.errorText(e)))}</span>
                ${retry ? `<button type="button" class="filter-btn" onclick="window.app.history.retryPrint()">${L('ui.print_status.retry')}</button>` : ''}
                ${markHand ? `<button type="button" class="filter-btn" onclick="window.app.history.markPrintedByHand()">${L('ui.print_status.mark_hand')}</button>` : ''}
            </div>`);
    }

    static async retryPrint() {
        const current = this.currentBill();
        if (!current) return;
        try {
            await PrinterService.printBill({ ...buildReprintPayload(current.bill, current.type), isCopy: false });
        } catch (error) {
            console.error('Print again failed:', error);
            UIManager.showToast(t('msg.history.reprint_failed'));
        }
    }

    static markPrintedByHand() {
        const current = this.currentBill();
        if (!current) return;
        if (!recordPrint(current.bill, 'hand')) {
            UIManager.showToast(t(STORAGE_FULL_KEY), 'error');
            return;
        }
        UIManager.showToast(t('msg.print_status.marked'));
    }

    /** Share the open bill on WhatsApp (bill date, COPY mark, bilingual). */
    static shareBill() {
        const current = this.currentBill();
        if (!current) {
            UIManager.showToast(t('msg.common.bill_not_found'));
            return;
        }
        openExternal(whatsAppShareUrl(buildBillShareText(current.bill, current.type)));
    }

    static toggleView() {
        this.viewMode = this.viewMode === 'card' ? 'table' : 'card';
        const toggleBtn = document.getElementById('historyViewToggle');
        if (toggleBtn) {
            toggleBtn.textContent = t(this.viewMode === 'card' ? 'ui.history.table_view' : 'ui.history.card_view');
        }
        this.refreshHistory();
    }

    static renderHistoryTable(bills, type) {
        const container = document.getElementById("historyList");
        
        if (bills.length === 0 && this.pageOpenings.length === 0 && this.pageVoided.length === 0) {
            const searchInput = document.getElementById('historySearch');
            const searchTerm = searchInput ? searchInput.value : '';
            container.innerHTML = `<p style="text-align: center; color: #888; margin-top: 40px;">${Helpers.escapeHtml(this.emptyMessage(type, searchTerm))}</p>`;
            return;
        }

        container.innerHTML = billTableHtml(bills, {
            openings: this.pageOpenings,
            voided: this.pageVoided,
            onclickFor: (bill) => `window.app.history.viewBill('${billRef(bill)}', '${Helpers.escapeJsAttr(bill.type)}')`
        });
    }
}

// Data changes re-render this page (firestore-service.js emits, utils/events.js).
on(REFRESH.history, () => HistoryManager.refreshHistory());
// Only redraw an open History: a hidden one redraws when it is shown.
on(PRINT_STATUS_CHANGED, () => {
    if (document.getElementById('history')?.classList.contains('active')) HistoryManager.refreshHistory();
    if (document.getElementById('billDetailsOverlay')?.classList.contains('active')) HistoryManager.renderPrintStatus();
});
