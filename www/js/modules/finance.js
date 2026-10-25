/**
 * @fileoverview Finance Management Module
 * Handles financial dashboard, assets tracking, withdrawals, and profit calculations
 * @module modules/finance
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { Helpers } from '../utils/helpers.js';
import { billTotal, outstandingDue, round2 } from '../utils/money.js';
import { computeFinanceSummary, pickReplayBase } from '../utils/finance-calc.js';
import { todayLocalISO, parseLocalDate, parseAnyBillDate, toLocalISODate } from '../utils/dates.js';
import {
    rangeStatus, retryRange, applyRangeState, isFullHistoryLoaded, needsHistoryFrom,
    ensureHistoryFrom, historyLoadedFrom, monthStart
} from '../utils/history-window.js';
import { attachOlderHistoryScroll } from '../ui/infinite-scroll.js';
import { createRenderMemo } from '../utils/render-memo.js';
import { FinanceBreakdownSheet } from '../ui/finance-breakdown-sheet.js';
import { t, getLang } from '../i18n/index.js';

/** Placeholder for all-time figures until the full history is loaded. */
const NOT_LOADED = '—';
/** Cash sessions are read for periods up to this long (one small doc per day). */
const SESSION_MAX_DAYS = 62;
/** Re-read a period's cash sessions after this long (today's session keeps changing). */
const SESSION_TTL_MS = 5 * 60 * 1000;
/** Skips recomputing the dashboard on a tab revisit when nothing changed (#24). */
const dashboardMemo = createRenderMemo();

const isShown = (el) => !!el && el.style.display !== 'none';

/**
 * ₹ amount rounded to the rupee ("—" for null: not computable yet).
 * @param {?number} n
 * @returns {string}
 */
const formatRupees = (n) => {
    if (n === null || n === undefined || !Number.isFinite(n)) return NOT_LOADED;
    const r = Math.round(n);
    return `${r < 0 ? '-' : ''}₹${Math.abs(r).toLocaleString('en-IN')}`;
};

/**
 * Finance Manager - Manages financial operations and reporting
 * @class FinanceManager
 */
export class FinanceManager {
    static currentDateFilter = 'all';
    static customStartDate = null;
    static customEndDate = null;
    static customAccounts = [];

    /**
     * Initialize the finance module
     */
    static init() {
        this.setupBreakdownTaps();
        this.loadCustomAccounts();
        this.filterTab('dashboard', undefined, { skipUnchanged: true });
        this.setupIconPicker();
        this.setDefaultDate();
    }

    /**
     * Every dashboard number with data-finance-card opens its breakdown (#215).
     * One delegated listener; the template is loaded once per session.
     */
    static setupBreakdownTaps() {
        const section = document.getElementById('financeDashboardSection');
        if (!section || section.dataset.breakdownTaps) return;
        section.dataset.breakdownTaps = '1';
        const openFrom = (e) => {
            const el = e.target.closest('[data-finance-card]');
            if (!el || !section.contains(el)) return;
            if (e.type === 'keydown') {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
            }
            this.openBreakdown(el.getAttribute('data-finance-card'));
        };
        section.addEventListener('click', openFrom);
        section.addEventListener('keydown', openFrom);
    }

    /**
     * Opens the "what makes up this number" sheet for a dashboard card.
     * @param {string} cardId key of CARDS in utils/finance-breakdown.js
     */
    static openBreakdown(cardId) {
        FinanceBreakdownSheet.open(cardId, {
            getSummary: () => this.computeSummary({ ...this.getRange(), detail: true }),
            periodLabel: this.getPeriodLabel()
        });
    }

    /**
     * Set default date for withdrawal form
     */
    static setDefaultDate() {
        const dateInput = document.getElementById('withdrawalDate');
        if (dateInput) {
            dateInput.value = todayLocalISO();
        }
    }

    /**
     * Setup icon picker click handlers
     */
    static setupIconPicker() {
        const picker = document.getElementById('accountIconPicker');
        if (picker) {
            picker.querySelectorAll('.icon-option').forEach(btn => {
                btn.addEventListener('click', () => {
                    picker.querySelectorAll('.icon-option').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                });
            });
        }
    }

    /**
     * Load custom accounts from localStorage
     */
    static loadCustomAccounts() {
        try {
            const saved = localStorage.getItem('financeCustomAccounts');
            this.customAccounts = saved ? JSON.parse(saved) : [];
        } catch (e) {
            this.customAccounts = [];
        }
    }

    /**
     * Save custom accounts to localStorage
     */
    static saveCustomAccounts() {
        localStorage.setItem('financeCustomAccounts', JSON.stringify(this.customAccounts));
    }

    /**
     * Switch between finance view tabs
     * @param {'dashboard'|'assets'|'withdrawals'} view - View to display
     * @param {Event} [evt] - Optional click event for button styling
     */
    static filterTab(view, evt, { skipUnchanged = false } = {}) {
        // Update button states - only main tab buttons
        const buttons = document.querySelectorAll('#finance > .filter-buttons > .filter-btn');
        buttons.forEach(btn => btn.classList.remove('active'));
        if (evt) {
            evt.currentTarget.classList.add('active');
        } else {
            // Set first button as active if no event (initial load)
            const firstBtn = buttons[0];
            if (firstBtn) firstBtn.classList.add('active');
        }
        
        // Show/hide sections
        const dashboardSection = document.getElementById('financeDashboardSection');
        const assetsSection = document.getElementById('financeAssetsSection');
        const withdrawalsSection = document.getElementById('financeWithdrawalsSection');
        
        if (dashboardSection) dashboardSection.style.display = view === 'dashboard' ? 'block' : 'none';
        if (assetsSection) assetsSection.style.display = view === 'assets' ? 'block' : 'none';
        if (withdrawalsSection) withdrawalsSection.style.display = view === 'withdrawals' ? 'block' : 'none';
        
        // Render content for the selected view
        if (view === 'dashboard') {
            // Also ensure date filter button is correctly selected
            this.updateDateFilterButtons();
            if (skipUnchanged && dashboardMemo.isCurrent(this.dashboardMemoState())) return;
            this.renderDashboard();
        } else if (view === 'assets') {
            this.renderAssets();
        } else if (view === 'withdrawals') {
            this.renderWithdrawals();
        }
    }

    /**
     * Update date filter buttons to match current filter
     */
    static updateDateFilterButtons() {
        const buttons = document.querySelectorAll('#financeDashboardSection .card > .filter-buttons .filter-btn');
        buttons.forEach(btn => {
            btn.classList.remove('active');
            // Match button text to current filter
            const btnText = btn.textContent.toLowerCase().trim();
            if ((btnText === 'all' && this.currentDateFilter === 'all') ||
                (btnText === 'year' && this.currentDateFilter === 'year') ||
                (btnText === 'month' && this.currentDateFilter === 'month') ||
                (btnText === 'week' && this.currentDateFilter === 'week') ||
                (btnText === 'custom' && this.currentDateFilter === 'custom')) {
                btn.classList.add('active');
            }
        });
    }

    /**
     * Set date filter for dashboard
     * @param {'week'|'month'|'year'|'all'|'custom'} filter - Date filter
     * @param {Event} [evt] - Click event
     */
    static setDateFilter(filter, evt) {
        this.currentDateFilter = filter;
        
        // Update button states - only date filter buttons
        const buttons = document.querySelectorAll('#financeDashboardSection .card > .filter-buttons .filter-btn');
        buttons.forEach(btn => btn.classList.remove('active'));
        if (evt) evt.currentTarget.classList.add('active');
        
        // Show/hide custom date range inputs
        const customRange = document.getElementById('financeCustomDateRange');
        if (customRange) {
            customRange.style.display = filter === 'custom' ? 'block' : 'none';
        }
        
        // Only render if not custom (wait for user to click Go)
        if (filter !== 'custom') {
            this.renderDashboard();
        }
    }

    /**
     * Apply custom date filter
     */
    static applyCustomDateFilter() {
        const startDate = document.getElementById('financeStartDate').value;
        const endDate = document.getElementById('financeEndDate').value;
        
        if (!startDate || !endDate) {
            UIManager.showToast(t('msg.finance.select_both_start_end_dates'));
            return;
        }
        
        if (parseLocalDate(startDate) > parseLocalDate(endDate)) {
            UIManager.showToast(t('msg.finance.start_date_must_before_end'));
            return;
        }
        
        this.customStartDate = startDate;
        this.customEndDate = endDate;
        this.renderDashboard();
    }

    /**
     * Earliest date the current filter needs (local midnight; null = all time).
     * Matches isInDateRange.
     * @returns {Date|null}
     */
    static getRangeStart() {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        switch (this.currentDateFilter) {
            case 'week':
                return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7);
            case 'month': {
                const d = new Date(today);
                d.setMonth(d.getMonth() - 1);
                return d;
            }
            case 'year': {
                const d = new Date(today);
                d.setFullYear(d.getFullYear() - 1);
                return d;
            }
            case 'custom':
                if (this.customStartDate && this.customEndDate) return parseLocalDate(this.customStartDate);
                return null;
            case 'all':
            default:
                return null;
        }
    }

    /**
     * Gate a finance view on its history range. Only kicks off a load when the
     * view is on screen; hidden views just report 'loading'.
     * @param {string} owner
     * @param {Date|null} start
     * @param {HTMLElement} sectionEl
     * @param {Function} rerender
     * @returns {'ready'|'loading'|'error'}
     */
    static gate(owner, start, sectionEl, rerender) {
        if (!needsHistoryFrom(start)) {
            retryRange(owner);
            return 'ready';
        }
        if (!isShown(sectionEl)) return 'loading';
        return rangeStatus(owner, start, rerender);
    }

    /**
     * Check if a date falls within the current filter
     * @param {Date|string} date - Date to check
     * @returns {boolean}
     */
    static isInDateRange(date) {
        const d = parseAnyBillDate(date) || new Date(NaN);
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        
        switch (this.currentDateFilter) {
            case 'week':
                const weekAgo = new Date(today);
                weekAgo.setDate(weekAgo.getDate() - 7);
                return d >= weekAgo;
            case 'month':
                const monthAgo = new Date(today);
                monthAgo.setMonth(monthAgo.getMonth() - 1);
                return d >= monthAgo;
            case 'year':
                const yearAgo = new Date(today);
                yearAgo.setFullYear(yearAgo.getFullYear() - 1);
                return d >= yearAgo;
            case 'custom':
                if (this.customStartDate && this.customEndDate) {
                    const start = parseLocalDate(this.customStartDate);
                    const end = parseLocalDate(this.customEndDate);
                    end.setHours(23, 59, 59, 999);
                    return d >= start && d <= end;
                }
                return true;
            case 'all':
            default:
                return true;
        }
    }

    /**
     * Get period label for display
     * @returns {string}
     */
    static getPeriodLabel() {
        switch (this.currentDateFilter) {
            case 'week': return t('ui.finance.period_week');
            case 'month': return t('ui.finance.period_month');
            case 'year': return t('ui.finance.period_year');
            case 'custom': 
                if (this.customStartDate && this.customEndDate) {
                    const start = parseLocalDate(this.customStartDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
                    const end = parseLocalDate(this.customEndDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
                    return `${start} - ${end}`;
                }
                return t('ui.finance.period_custom');
            case 'all':
            default: return t('ui.finance.period_all');
        }
    }

    /**
     * Render the dashboard with financial overview
     */
    static renderDashboard() {
        // Never show partial totals: wait until the selected period is loaded
        const section = document.getElementById('financeDashboardSection');
        const start = this.getRangeStart();
        const status = this.gate('financeDashboard', start, section, () => this.renderDashboard());
        if (section) {
            const scopes = [...section.children].filter(el =>
                !el.querySelector('.filter-buttons') && !el.classList.contains('history-range-notice'));
            applyRangeState(scopes, isShown(section) ? status : 'ready', {
                loadingText: start ? 'Loading older data for this period…' : 'Loading full history…',
                onRetry: () => {
                    retryRange('financeDashboard');
                    this.renderDashboard();
                }
            });
        }
        if (status === 'loading') {
            dashboardMemo.reset();
            return;
        }

        const summary = this.computeSummary();

        const updateElement = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

        updateElement('financeNetProfit', formatRupees(summary.profit));
        updateElement('financeProfitPeriod', this.getPeriodLabel());
        updateElement('financeAfterPersonalLine',
            `${t('ui.finance.profit_after_personal')}: ${formatRupees(summary.afterPersonal)}`);

        updateElement('financeRevenue', formatRupees(summary.sales.total));
        updateElement('financeRevenueCount', summary.sales.due > 0
            ? `${t('ui.finance.sales_count', { count: summary.sales.count })} · ${t('ui.finance.still_due', { amount: Math.round(summary.sales.due).toLocaleString('en-IN') })}`
            : t('ui.finance.sales_count', { count: summary.sales.count }));
        updateElement('financeCogs', formatRupees(summary.cogs));
        updateElement('financeBusinessExp', formatRupees(summary.expenses.business));
        updateElement('financeBusinessExpCount', t('ui.finance.entries_count', { count: summary.expenses.businessCount }));
        updateElement('financeStockNow', formatRupees(summary.stock ? summary.stock.now : this.calculateStockValue()));

        updateElement('financePersonalExp', formatRupees(summary.expenses.personal));
        updateElement('financePersonalExpCount', t('ui.finance.personal_note'));
        updateElement('financeTotalWithdrawn', formatRupees(summary.withdrawn));
        updateElement('financeAvailableBalance', formatRupees(summary.afterWithdrawals));

        const warn = document.getElementById('financeProfitWarning');
        if (warn) {
            warn.style.display = summary.uncostedWarning ? 'block' : 'none';
            warn.textContent = summary.uncostedWarning ? `⚠️ ${this.uncostedText(summary.stock.uncosted)}` : '';
        }

        this.renderFullHistoryPrompt(!!summary.stock);
        this.renderProfitBreakdown(summary);
        this.renderStockBreakdown(summary);
        this.renderCashFlow(summary);

        this.renderMonthlyChart();
        dashboardMemo.record(this.dashboardMemoState());
    }

    /**
     * Selected period as [from, to) in ms (same days as isInDateRange).
     * @returns {{from: number, to: number}}
     */
    static getRange() {
        const start = this.getRangeStart();
        let to = Infinity;
        if (this.currentDateFilter === 'custom' && this.customStartDate && this.customEndDate) {
            const end = parseLocalDate(this.customEndDate);
            to = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1).getTime();
        }
        return { from: start ? start.getTime() : -Infinity, to };
    }

    /**
     * Finance numbers for [from, to) from the loaded history (#215). Cost of
     * goods sold starts from the stock checkpoint, or from the beginning when
     * the full history is loaded; otherwise profit and stock show "—".
     * @param {{from: number, to: number, detail?: boolean}} [range] detail: also the rows behind each number
     * @returns {ReturnType<typeof computeFinanceSummary>}
     */
    static computeSummary({ from, to, detail = false, cashSessions } = this.getRange()) {
        const dues = cashSessions || this.periodSessions({ from, to });
        const base = pickReplayBase({
            checkpoint: FirebaseService.getStockCheckpointState?.() || null,
            fullHistory: isFullHistoryLoaded(),
            from
        });
        return computeFinanceSummary({
            sources: {
                purchases: AppState.purchaseHistory || [],
                wholesaleSales: AppState.salesHistory || [],
                retailSales: AppState.retailSalesHistory || [],
                stockAdjustments: AppState.stockAdjustments || []
            },
            items: AppState.items || [],
            base,
            expenses: AppState.expensesHistory || [],
            withdrawals: AppState.withdrawalsHistory || [],
            sessions: dues.sessions,
            duesComplete: dues.complete,
            from,
            to,
            detail
        });
    }

    /**
     * Business profit (F4: sales − cost of goods sold − business expenses − bad
     * debts) for [from, to), the one profit Reports and Analytics show too (#36).
     * No cash-session reads: those only affect cash flow.
     * @param {{from: number, to: number, detail?: boolean}} range
     * @returns {ReturnType<typeof computeFinanceSummary>} `.profit` is null when cost of goods sold isn't known
     */
    static profitSummary({ from, to, detail = false }) {
        return this.computeSummary({ from, to, detail, cashSessions: { sessions: [], complete: true } });
    }

    /**
     * Cash sessions for [from, to): their due-payment legs count the final
     * payment on an old bill that is no longer in memory. Not needed once the
     * full history is loaded; read (small, cached) for periods up to
     * SESSION_MAX_DAYS; longer periods stay approximate.
     * @param {{from: number, to: number}} range
     * @returns {{sessions: Array, complete: boolean}}
     */
    static periodSessions({ from, to }) {
        if (isFullHistoryLoaded()) return { sessions: [], complete: true };
        const now = Date.now();
        const end = Math.min(to, now);
        if (!Number.isFinite(from) || end - from > SESSION_MAX_DAYS * 86400000) return { sessions: [], complete: false };
        const key = `${toLocalISODate(new Date(from))}|${toLocalISODate(new Date(Math.max(from, end - 1)))}`;
        if (!this.sessionCache) this.sessionCache = new Map();
        const hit = this.sessionCache.get(key);
        if (hit?.sessions && now - hit.at < SESSION_TTL_MS) return { sessions: hit.sessions, complete: true };
        if (!hit || (!hit.pending && now - hit.at >= SESSION_TTL_MS)) {
            const [a, b] = key.split('|');
            const entry = { pending: true, at: now, sessions: hit?.sessions || null };
            this.sessionCache.set(key, entry);
            FirebaseService.loadCashSessionsBetween(a, b).then(sessions => {
                this.sessionCache.set(key, { pending: false, at: Date.now(), sessions });
                if (isShown(document.getElementById('financeDashboardSection'))) this.renderDashboard();
            }).catch(e => {
                console.error('Finance: loading cash sessions failed:', e);
                this.sessionCache.set(key, { pending: false, at: Date.now(), sessions: null });
            });
        }
        return { sessions: hit?.sessions || [], complete: false };
    }

    /**
     * "X kg sold before purchase recorded — profit may be overstated by ~₹Y".
     * @param {{qty: number, estimate: number, unknownCost: number}} u
     * @returns {string}
     */
    static uncostedText(u) {
        const qty = (Math.round(u.qty * 100) / 100).toLocaleString('en-IN');
        return u.estimate > 0
            ? t('ui.finance.uncosted_warning', { qty, amount: Math.round(u.estimate).toLocaleString('en-IN') })
            : t('ui.finance.uncosted_warning_unknown', { qty });
    }

    /** Filter state the dashboard depends on (besides data). */
    static dashboardMemoState() {
        return [this.currentDateFilter, this.customStartDate?.getTime?.() ?? this.customStartDate, this.customEndDate?.getTime?.() ?? this.customEndDate, getLang()];
    }

    /**
     * Prompt under the profit breakdown while profit / stock value show "—"
     * (the period starts before the stock checkpoint and older history isn't loaded).
     * @param {boolean} ready
     */
    static renderFullHistoryPrompt(ready) {
        const anchor = document.getElementById('financeProfitBreakdown');
        const card = anchor?.closest('.card');
        if (!card) return;
        let prompt = card.querySelector('.finance-full-history-prompt');
        if (ready) {
            prompt?.remove();
            return;
        }
        if (!prompt) {
            prompt = document.createElement('div');
            prompt.className = 'history-search-footer finance-full-history-prompt';
            card.appendChild(prompt);
        }
        prompt.textContent = '';
        const text = document.createElement('span');
        text.textContent = t('ui.finance.needs_full_history');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'history-search-older-btn';
        btn.disabled = !!this.loadingFullHistory;
        btn.textContent = t(this.loadingFullHistory ? 'ui.finance.loading_full_history' : 'ui.finance.load_full_history');
        btn.addEventListener('click', () => this.loadFullHistory());
        prompt.append(text, ' ', btn);
    }

    /**
     * Load every older record (explicit user action), then re-render.
     * @async
     */
    static async loadFullHistory() {
        if (this.loadingFullHistory) return;
        this.loadingFullHistory = true;
        this.renderFullHistoryPrompt(false);
        try {
            const covered = await ensureHistoryFrom(null);
            if (!covered) UIManager.showToast(t('msg.finance.couldn_t_load_full_history'));
        } catch (error) {
            console.error('Loading full history failed:', error);
            UIManager.showToast(t('msg.finance.couldn_t_load_full_history'));
        } finally {
            this.loadingFullHistory = false;
            this.renderDashboard();
        }
    }

    /**
     * Rows of a breakdown table.
     * @param {Array<[string, ?number, string?, string?, string?]>} rows [text, amount, sign '+'|'-'|'', rowClass, cardId]
     * @returns {string}
     */
    static breakdownRows(rows) {
        return rows.map(([label, amount, sign = '', rowClass = '', cardId = '']) => {
            const text = Helpers.escapeHtml(label);
            const value = amount === null ? NOT_LOADED : `${sign}${formatRupees(sign ? Math.abs(amount) : amount)}`;
            const cls = amount === null ? '' : (sign === '-' || amount < 0 ? 'amount-negative' : 'amount-positive');
            const strong = rowClass === 'breakdown-subtotal' || rowClass === 'breakdown-total';
            const classes = [rowClass, cardId ? 'finance-tappable' : ''].filter(Boolean).join(' ');
            const tap = cardId ? ` data-finance-card="${cardId}" role="button" tabindex="0"` : '';
            return `<tr${classes ? ` class="${classes}"` : ''}${tap}>
                <td>${strong ? `<strong>${text}</strong>` : text}</td>
                <td class="${cls}">${strong ? `<strong>${value}</strong>` : value}</td>
            </tr>`;
        }).join('');
    }

    /**
     * Profit on goods sold: sales − cost of goods sold − business expenses;
     * personal expenses and withdrawals below it, not part of it.
     * @param {ReturnType<typeof computeFinanceSummary>} s
     */
    static renderProfitBreakdown(s) {
        const tbody = document.getElementById('financeProfitBreakdown');
        if (!tbody) return;
        const rows = [
            [`📈 ${t('ui.finance.sales')}`, s.sales.total, '+', '', 'sales'],
            [`📦 ${t('ui.finance.cogs')}`, s.cogs, '-', '', 'cogs'],
            [t('ui.finance.gross_profit'), s.grossProfit, '', 'breakdown-subtotal', 'gross'],
            [`🏢 ${t('ui.finance.business_expenses')}`, s.expenses.business, '-', '', 'business']
        ];
        if (s.expenses.uncategorised > 0) {
            rows.push([t('ui.finance.uncategorised', { amount: Math.round(s.expenses.uncategorised).toLocaleString('en-IN') }), s.expenses.uncategorised, '', 'breakdown-note', 'business']);
        }
        if (s.badDebts) rows.push([`🧾 ${t('ui.finance.bad_debts')}`, s.badDebts, '-', '', 'badDebts']);
        rows.push(
            [t('ui.finance.profit_on_goods_sold'), s.profit, '', 'breakdown-total', 'profit'],
            [`👤 ${t('ui.finance.personal_expenses')}`, s.expenses.personal, '-', '', 'personal'],
            [t('ui.finance.profit_after_personal'), s.afterPersonal, '', 'breakdown-subtotal', 'afterPersonal'],
            [`💸 ${t('ui.finance.withdrawn')}`, s.withdrawn, '-', '', 'withdrawn'],
            [t('ui.finance.left_after_withdrawals'), s.afterWithdrawals, '', 'breakdown-subtotal', 'afterWithdrawals']
        );
        // Shown, not included (owner questions / data warnings).
        if (s.uncostedWarning) rows.push([`⚠️ ${this.uncostedText(s.stock.uncosted)}`, s.stock.uncosted.estimate || null, '', 'breakdown-note', 'uncosted']);
        if (s.purchases.labour) rows.push([t('ui.finance.labour_note'), s.purchases.labour, '', 'breakdown-note', 'labour']);
        tbody.innerHTML = this.breakdownRows(rows);
    }

    /**
     * Stock value for the period and the check line
     * (opening + purchases − cost of goods sold ± corrections = closing).
     * @param {ReturnType<typeof computeFinanceSummary>} s
     */
    static renderStockBreakdown(s) {
        const tbody = document.getElementById('financeStockBreakdown');
        const check = document.getElementById('financeStockCheck');
        const st = s.stock;
        if (tbody) {
            const rows = [
                [t('ui.finance.opening_stock'), st ? st.opening : null, '', '', 'stockOpening'],
                [`+ ${t('ui.finance.purchases')}`, st ? st.purchases : null, '+', '', 'stockPurchases'],
                [`− ${t('ui.finance.cogs')}`, st ? st.cogs : null, '-', '', 'cogs']
            ];
            if (st && st.adjustments !== 0) {
                rows.push([`± ${t('ui.finance.stock_corrections')}`, st.adjustments, st.adjustments < 0 ? '-' : '+', '', 'stockAdjustments']);
            }
            rows.push(
                [t('ui.finance.closing_stock'), st ? st.closing : null, '', 'breakdown-subtotal', 'stockClosing'],
                [t('ui.finance.stock_value_now'), st ? st.now : this.calculateStockValue(), '', 'breakdown-total', 'stockNow']
            );
            tbody.innerHTML = this.breakdownRows(rows);
        }
        if (check) {
            check.style.display = s.stockMismatch ? 'block' : 'none';
            check.textContent = s.stockMismatch
                ? `⚠️ ${t(s.mismatchFromEarlierSales ? 'ui.finance.check_mismatch_earlier' : 'ui.finance.check_mismatch', {
                    amount: Math.round(Math.abs(s.stock.gap)).toLocaleString('en-IN'),
                    qty: (Math.round(s.stock.deficitRefilled.qty * 100) / 100).toLocaleString('en-IN')
                })}`
                : '';
        }
    }

    /**
     * Cash flow: money received − money paid in the period.
     * @param {ReturnType<typeof computeFinanceSummary>} s
     */
    static renderCashFlow(s) {
        const tbody = document.getElementById('financeCashFlow');
        if (!tbody) return;
        const c = s.cash;
        tbody.innerHTML = this.breakdownRows([
            [t('ui.finance.received_at_sale'), c.receivedAtSale, '+', '', 'receivedAtSale'],
            [t('ui.finance.due_received'), c.dueReceived, '+', '', 'dueReceived'],
            [t('ui.finance.money_in'), c.moneyIn, '', 'breakdown-subtotal', 'moneyIn'],
            [t('ui.finance.paid_at_purchase'), c.paidAtPurchase, '-', '', 'paidAtPurchase'],
            [t('ui.finance.due_paid'), c.duePaid, '-', '', 'duePaid'],
            [t('ui.finance.all_expenses'), round2(s.expenses.business + s.expenses.personal), '-', '', 'expensesAll'],
            [t('ui.finance.money_out'), c.moneyOut, '', 'breakdown-subtotal', 'moneyOut'],
            [t('ui.finance.net_cash_flow'), c.net, '', 'breakdown-total', 'netCash']
        ]);
        const note = document.getElementById('financeCashNote');
        if (note) {
            note.style.display = s.duesApproximate ? 'block' : 'none';
            note.textContent = s.duesApproximate ? t('ui.finance.cash_approximate') : '';
        }
    }

    /**
     * Render monthly profit chart (profit on goods sold per calendar month)
     */
    static renderMonthlyChart() {
        const container = document.getElementById('financeMonthlyChart');
        if (!container) return;

        // The chart shows the last 6 calendar months: load them first
        const chartStart = monthStart(5);
        const status = this.gate('financeChart', chartStart,
            document.getElementById('financeDashboardSection'), () => this.renderMonthlyChart());
        if (status === 'loading') {
            container.innerHTML = `<p class="empty-state">${Helpers.escapeHtml(t('ui.finance.loading_older_months'))}</p>`;
            return;
        }
        // Only months fully inside the loaded window (older due-only bills
        // would otherwise show up as tiny, wrong bars)
        const loadedFrom = isFullHistoryLoaded() ? -Infinity : historyLoadedFrom();

        const months = [];
        for (let back = 5; back >= 0; back--) {
            const from = monthStart(back).getTime();
            const to = back === 0 ? Infinity : monthStart(back - 1).getTime();
            if (from < loadedFrom) continue;
            const s = this.computeSummary({ from, to, cashSessions: { sessions: [], complete: isFullHistoryLoaded() } });
            if (s.profit === null) continue;
            if (s.sales.count === 0 && s.purchases.count === 0 && s.expenses.business === 0) continue;
            months.push({ date: new Date(from), profit: s.profit });
        }

        if (months.length === 0) {
            container.innerHTML = `<p class="empty-state">${Helpers.escapeHtml(t('ui.finance.no_data'))}</p>`;
            return;
        }

        const maxProfit = Math.max(...months.map(m => Math.abs(m.profit)), 1);
        const locale = getLang() === 'hi' ? 'hi-IN' : 'en';

        let html = '';
        months.forEach(({ date, profit }) => {
            const height = Math.max(10, (Math.abs(profit) / maxProfit) * 150);
            const color = profit >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
            const monthName = date.toLocaleString(locale, { month: 'short' });

            html += `
                <div style="display: flex; flex-direction: column; align-items: center; flex: 1;">
                    <div style="background: ${color}; width: 100%; max-width: 40px; height: ${height}px; border-radius: 6px 6px 0 0;"></div>
                    <div style="font-size: 11px; margin-top: 6px; font-weight: 500;">${Helpers.escapeHtml(monthName)}</div>
                    <div style="font-size: 10px; color: var(--text-muted);">₹${(profit / 1000).toFixed(1)}k</div>
                </div>
            `;
        });

        container.innerHTML = html;
    }

    /**
     * Render assets section
     */
    static renderAssets() {
        // Calculate stock value
        const stockValue = this.calculateStockValue();
        
        // Calculate outstanding amounts
        const { dueToReceive, dueToPay } = this.calculateOutstanding();
        
        // Calculate business balance (profit - withdrawals) — needs all history
        const section = document.getElementById('financeAssetsSection');
        const allStatus = this.gate('financeAssets', null, section, () => this.renderAssets());
        this.applyAllTimeState(section, allStatus, () => {
            retryRange('financeAssets');
            this.renderAssets();
        });
        const allTimeReady = allStatus === 'ready';
        const businessBalance = allTimeReady ? this.calculateBusinessBalance() : 0;
        
        // Calculate custom accounts total
        let customAssetsTotal = 0;
        let customLiabilitiesTotal = 0;
        this.customAccounts.forEach(acc => {
            if (acc.type === 'asset') {
                customAssetsTotal += acc.balance;
            } else {
                customLiabilitiesTotal += acc.balance;
            }
        });
        
        // Net worth = Stock + Due to Receive - Due to Pay + Business Balance + Custom Assets - Custom Liabilities
        const netWorth = stockValue + dueToReceive - dueToPay + businessBalance + customAssetsTotal - customLiabilitiesTotal;
        
        // Update UI
        const updateElement = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

        updateElement('financeNetWorth', allTimeReady ? `₹${Math.round(netWorth).toLocaleString('en-IN')}` : NOT_LOADED);
        updateElement('assetStockValue', `₹${Math.round(stockValue).toLocaleString('en-IN')}`);
        updateElement('assetDueReceive', `₹${Math.round(dueToReceive).toLocaleString('en-IN')}`);
        updateElement('assetDuePay', `-₹${Math.round(dueToPay).toLocaleString('en-IN')}`);
        updateElement('assetBusinessBalance', allTimeReady ? `₹${Math.round(businessBalance).toLocaleString('en-IN')}` : NOT_LOADED);
        
        // Render custom accounts
        this.renderCustomAccounts();
    }

    /**
     * Calculate total stock value
     * @returns {number}
     */
    static calculateStockValue() {
        const stock = AppState.stock || {};
        let total = 0;
        
        Object.values(stock).forEach(item => {
            const qty = parseFloat(item.quantity) || 0;
            const rate = parseFloat(item.rate) || 0;
            total += qty * rate;
        });
        
        return total;
    }

    /**
     * Calculate outstanding amounts
     * @returns {{dueToReceive: number, dueToPay: number}}
     */
    static calculateOutstanding() {
        const salesHistory = AppState.salesHistory || [];
        const retailSalesHistory = AppState.retailSalesHistory || [];
        const purchaseHistory = AppState.purchaseHistory || [];
        
        let dueToReceive = 0;
        let dueToPay = 0;
        
        // Due from sales (wholesale + retail), same rule as the Outstanding screen
        [...salesHistory, ...retailSalesHistory].forEach(sale => {
            dueToReceive += outstandingDue(sale);
        });
        
        // Due for purchases
        purchaseHistory.forEach(purchase => {
            dueToPay += outstandingDue(purchase);
        });
        
        return { dueToReceive, dueToPay };
    }

    /**
     * Calculate business balance (all-time profit - withdrawals)
     * @returns {number}
     */
    static calculateBusinessBalance() {
        const salesHistory = AppState.salesHistory || [];
        const retailSalesHistory = AppState.retailSalesHistory || [];
        const purchaseHistory = AppState.purchaseHistory || [];
        const expensesHistory = AppState.expensesHistory || [];
        const withdrawalsHistory = AppState.withdrawalsHistory || [];
        
        let revenue = 0;
        [...salesHistory, ...retailSalesHistory].forEach(s => revenue += parseFloat(s.total) || 0);
        
        let costs = 0;
        purchaseHistory.forEach(p => costs += billTotal(p));
        expensesHistory.forEach(e => costs += parseFloat(e.amount) || 0);
        
        let withdrawals = 0;
        withdrawalsHistory.forEach(w => withdrawals += parseFloat(w.amount) || 0);
        
        return revenue - costs - withdrawals;
    }

    /**
     * Render custom accounts list
     */
    static renderCustomAccounts() {
        const container = document.getElementById('customAccountsList');
        if (!container) return;
        
        if (this.customAccounts.length === 0) {
            container.innerHTML = '<p class="empty-state">No custom accounts added yet. Click + to add.</p>';
            return;
        }
        
        let html = '';
        this.customAccounts.forEach((acc, index) => {
            const isAsset = acc.type === 'asset';
            html += `
                <div class="asset-item" onclick="window.app.finance.editAccount(${index})">
                    <div class="asset-info">
                        <span class="asset-icon">${Helpers.escapeHtml(acc.icon)}</span>
                        <div>
                            <div class="asset-name">${Helpers.escapeHtml(acc.name)}</div>
                            <div class="asset-desc">${isAsset ? 'Asset' : 'Liability'}</div>
                        </div>
                    </div>
                    <div class="asset-amount ${isAsset ? 'asset-positive' : 'asset-negative'}">
                        ${isAsset ? '' : '-'}₹${Math.round(acc.balance).toLocaleString('en-IN')}
                    </div>
                </div>
            `;
        });
        
        container.innerHTML = html;
    }

    /**
     * Show add account modal
     */
    static showAddAccountModal() {
        document.getElementById('addAccountModal').style.display = 'flex';
        document.getElementById('newAccountName').value = '';
        document.getElementById('newAccountBalance').value = '';
        document.getElementById('newAccountType').value = 'asset';
        
        // Reset icon selection
        const picker = document.getElementById('accountIconPicker');
        picker.querySelectorAll('.icon-option').forEach((b, i) => {
            b.classList.toggle('active', i === 0);
        });
    }

    /**
     * Close add account modal
     */
    static closeAccountModal() {
        document.getElementById('addAccountModal').style.display = 'none';
    }

    /**
     * Save new account
     */
    static saveNewAccount() {
        const name = document.getElementById('newAccountName').value.trim();
        const balance = parseFloat(document.getElementById('newAccountBalance').value) || 0;
        const type = document.getElementById('newAccountType').value;
        const activeIcon = document.querySelector('#accountIconPicker .icon-option.active');
        const icon = activeIcon ? activeIcon.dataset.icon : '💳';
        
        if (!name) {
            UIManager.showToast(t('msg.finance.enter_account_name'), 'error');
            return;
        }
        
        this.customAccounts.push({ name, balance, type, icon });
        this.saveCustomAccounts();
        this.closeAccountModal();
        this.renderAssets();
        UIManager.showToast(t('msg.finance.account_added_successfully'), 'success');
    }

    /**
     * Quick add a common account type
     */
    static quickAddAccount(name, icon) {
        // Check if already exists
        if (this.customAccounts.some(a => a.name === name)) {
            UIManager.showToast(t('msg.finance.account_already_exists'), 'error');
            return;
        }
        
        this.customAccounts.push({ name, balance: 0, type: 'asset', icon });
        this.saveCustomAccounts();
        this.renderAssets();
        UIManager.showToast(t('msg.finance.added', { name }), 'success');
    }

    /**
     * Edit existing account
     */
    static editAccount(index) {
        const acc = this.customAccounts[index];
        if (!acc) return;
        
        document.getElementById('editAccountId').value = index;
        document.getElementById('editAccountName').value = acc.name;
        document.getElementById('editAccountBalance').value = acc.balance;
        document.getElementById('editAccountModal').style.display = 'flex';
    }

    /**
     * Close edit account modal
     */
    static closeEditAccountModal() {
        document.getElementById('editAccountModal').style.display = 'none';
    }

    /**
     * Update existing account
     */
    static updateAccount() {
        const index = parseInt(document.getElementById('editAccountId').value);
        const name = document.getElementById('editAccountName').value.trim();
        const balance = parseFloat(document.getElementById('editAccountBalance').value) || 0;
        
        if (!name) {
            UIManager.showToast(t('msg.finance.enter_account_name'), 'error');
            return;
        }
        
        if (this.customAccounts[index]) {
            this.customAccounts[index].name = name;
            this.customAccounts[index].balance = balance;
            this.saveCustomAccounts();
            this.closeEditAccountModal();
            this.renderAssets();
            UIManager.showToast(t('msg.finance.account_updated'), 'success');
        }
    }

    /**
     * Delete account
     */
    static deleteAccount() {
        const index = parseInt(document.getElementById('editAccountId').value);
        
        if (confirm(t('msg.finance.are_sure_want_delete_account'))) {
            this.customAccounts.splice(index, 1);
            this.saveCustomAccounts();
            this.closeEditAccountModal();
            this.renderAssets();
            UIManager.showToast(t('msg.finance.account_deleted'), 'success');
        }
    }

    /**
     * Loading/error notice for views whose figures need the full history.
     * @param {HTMLElement|null} section
     * @param {'ready'|'loading'|'error'} status
     * @param {Function} onRetry
     */
    static applyAllTimeState(section, status, onRetry) {
        if (!section) return;
        const first = [...section.children].find(el => !el.classList.contains('history-range-notice'));
        applyRangeState(first, isShown(section) ? status : 'ready', {
            loadingText: 'Loading full history…',
            errorText: "Couldn't load full history, so all-time totals are hidden.",
            onRetry
        });
    }

    /**
     * Render withdrawals section
     */
    static renderWithdrawals() {
        const withdrawalsHistory = AppState.withdrawalsHistory || [];

        // Totals are all-time: load full history when this view is opened
        const section = document.getElementById('financeWithdrawalsSection');
        const allStatus = this.gate('financeWithdrawals', null, section, () => this.renderWithdrawals());
        this.applyAllTimeState(section, allStatus, () => {
            retryRange('financeWithdrawals');
            this.renderWithdrawals();
        });
        const allTimeReady = allStatus === 'ready';
        
        let totalWithdrawn = 0;
        withdrawalsHistory.forEach(w => totalWithdrawn += parseFloat(w.amount) || 0);
        
        // Calculate available = all-time profit - already withdrawn
        const salesHistory = AppState.salesHistory || [];
        const retailSalesHistory = AppState.retailSalesHistory || [];
        const purchaseHistory = AppState.purchaseHistory || [];
        const expensesHistory = AppState.expensesHistory || [];
        
        let revenue = 0;
        [...salesHistory, ...retailSalesHistory].forEach(s => revenue += parseFloat(s.total) || 0);
        let costs = 0;
        purchaseHistory.forEach(p => costs += billTotal(p));
        expensesHistory.forEach(e => costs += parseFloat(e.amount) || 0);
        
        const profit = revenue - costs;
        const available = profit - totalWithdrawn;
        
        const updateElement = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

        updateElement('withdrawalTotal', allTimeReady ? `₹${Math.round(totalWithdrawn).toLocaleString('en-IN')}` : NOT_LOADED);
        updateElement('withdrawalAvailable', allTimeReady ? `₹${Math.round(available).toLocaleString('en-IN')}` : NOT_LOADED);
        
        // Populate person datalist
        this.populateWithdrawalPersons();
        
        // Render history
        this.renderWithdrawalHistory();
    }

    /**
     * Populate withdrawal persons datalist
     */
    static populateWithdrawalPersons() {
        const withdrawalsHistory = AppState.withdrawalsHistory || [];
        const persons = [...new Set(withdrawalsHistory.map(w => w.person).filter(Boolean))];
        
        const datalist = document.getElementById('withdrawalPersonOptions');
        if (datalist) {
            datalist.innerHTML = persons.map(p => `<option value="${Helpers.escapeHtml(p)}">`).join('');
        }
    }

    /**
     * Toggle other purpose input visibility
     */
    static toggleOtherPurpose() {
        const purpose = document.getElementById('withdrawalPurpose').value;
        const otherRow = document.getElementById('withdrawalOtherPurposeRow');
        if (otherRow) {
            otherRow.style.display = purpose === 'Other' ? 'block' : 'none';
        }
    }

    /**
     * Record a new withdrawal
     */
    static async recordWithdrawal() {
        const amount = parseFloat(document.getElementById('withdrawalAmount').value);
        const person = document.getElementById('withdrawalPerson').value.trim();
        let purpose = document.getElementById('withdrawalPurpose').value;
        const date = document.getElementById('withdrawalDate').value;
        
        if (purpose === 'Other') {
            purpose = document.getElementById('withdrawalOtherPurpose').value.trim() || 'Other';
        }
        
        if (!amount || amount <= 0) {
            UIManager.showToast(t('msg.common.enter_valid_amount'), 'error');
            return;
        }
        
        if (!person) {
            UIManager.showToast(t('msg.finance.enter_who_withdrew_money'), 'error');
            return;
        }
        
        if (!date) {
            UIManager.showToast(t('msg.finance.select_date'), 'error');
            return;
        }
        
        try {
            const withdrawal = {
                amount,
                person,
                purpose,
                date,
                createdAt: new Date().toISOString()
            };
            
            await FirebaseService.saveWithdrawal(withdrawal);
            
            // Clear form
            document.getElementById('withdrawalAmount').value = '';
            document.getElementById('withdrawalPerson').value = '';
            document.getElementById('withdrawalPurpose').value = 'Personal Use';
            document.getElementById('withdrawalOtherPurpose').value = '';
            document.getElementById('withdrawalOtherPurposeRow').style.display = 'none';
            this.setDefaultDate();
            
            UIManager.showToast(t('msg.finance.withdrawal_recorded_successfully'), 'success');
            this.renderWithdrawals();
        } catch (error) {
            console.error('Error recording withdrawal:', error);
            UIManager.showToast(t('msg.finance.error_recording_withdrawal'), 'error');
        }
    }

    /**
     * Render withdrawal history
     */
    static renderWithdrawalHistory() {
        const container = document.getElementById('withdrawalHistoryList');
        if (!container) return;
        
        const withdrawalsHistory = AppState.withdrawalsHistory || [];

        // Older withdrawals load one month at a time as the user scrolls
        attachOlderHistoryScroll(container, { noun: 'withdrawals', onLoaded: () => this.renderWithdrawalHistory() });

        if (withdrawalsHistory.length === 0) {
            container.innerHTML = isFullHistoryLoaded()
                ? '<p class="empty-state">No withdrawals recorded yet</p>'
                : '<p class="empty-state">No recent withdrawals</p>';
            return;
        }
        
        // Sort by date descending
        const sorted = [...withdrawalsHistory].sort((a, b) => new Date(b.date) - new Date(a.date));
        
        let html = '<div class="withdrawal-list">';
        sorted.forEach(w => {
            const date = new Date(w.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
            html += `
                <div class="withdrawal-item">
                    <div class="withdrawal-info">
                        <div class="withdrawal-person">💸 ${Helpers.escapeHtml(w.person)}</div>
                        <div class="withdrawal-purpose">${Helpers.escapeHtml(w.purpose)}</div>
                        <div class="withdrawal-date">${date}</div>
                    </div>
                    <div class="withdrawal-amount">-₹${Math.round(w.amount).toLocaleString('en-IN')}</div>
                </div>
            `;
        });
        html += '</div>';
        
        container.innerHTML = html;
    }
}
