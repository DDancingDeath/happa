// -------------------- DAY MODULE --------------------
// Manages the Day page with Today's Summary and Cash Management sub-tabs

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { formatKg, labourCalcText } from '../utils/labour.js';
import { parseAnyBillDate, todayLocalISO, displayLocale } from '../utils/dates.js';
import { todaySummary } from '../utils/calc/today.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { CashManagementManager } from './cash-management.js';
import { sessionForDate } from '../utils/cash-session.js';
import { AnomaliesManager } from './anomalies.js';
import { HealthManager } from './health.js';
import { t, tn } from '../i18n/index.js';

// Use helper functions
const formatCurrency = (amount) => Helpers.formatCurrency(amount);
const formatDate = (date) => Helpers.formatDate(date);
const LABOUR_GAP_KEYS = { same: 'ui.today.labour_same', more: 'ui.today.labour_more', less: 'ui.today.labour_less' };

export const DayManager = {
    currentSubTab: 'today',
    
    /**
     * Initialize the Day page
     */
    init() {
        this.updateTodayHeader();
        this.loadTodayData();
        this.loadTodaySession();
    },

    /** Every cash session of `date` (usually one; legacy days can have more), from one query. */
    daySessions: { date: null, list: [] },
    daySessionsLoading: null,

    /**
     * Today's cash sessions carry drawer legs of due payments whose bills may
     * not be in memory (#95). Read all of the day's sessions (one query, as
     * before: again only while there is no drawer session for today) and
     * redraw; the drawer session, if the Cash tab hasn't picked one, is the
     * one the Cash page would pick.
     */
    loadTodaySession() {
        const today = todayLocalISO();
        if (this.daySessionsLoading === today) return;
        if (this.daySessions.date === today && CashManagementManager.todaySession?.date === today) return;
        this.daySessionsLoading = today;
        FirebaseService.loadCashSessionsForDate(today)
            .then(sessions => {
                this.daySessions = { date: today, list: sessions || [] };
                const pick = sessionForDate(sessions, today);
                if (pick && CashManagementManager.todaySession?.date !== today) CashManagementManager.todaySession = pick;
                if (this.daySessions.list.length > 0) this.loadTodayData();
            })
            .catch(e => console.warn('Could not load today\'s cash sessions:', e?.message || e))
            .finally(() => { if (this.daySessionsLoading === today) this.daySessionsLoading = null; });
    },

    /**
     * Sessions whose due legs count on `date` (T6–T14): every session of the
     * day, as the day book, plus the live one the Cash tab holds (it may have
     * legs this phone just added). dueEvents counts each payment id once.
     * @param {string} date YYYY-MM-DD
     * @returns {Object[]}
     */
    sessionsOn(date) {
        const live = CashManagementManager.todaySession;
        const day = this.daySessions.date === date ? this.daySessions.list : [];
        return live && live.date === date ? [live, ...day] : day;
    },

    /**
     * Show a sub-tab (today or cash)
     * @param {string} tab - 'today' or 'cash'
     */
    showSubTab(tab) {
        this.currentSubTab = tab;
        
        // Update tab button styles
        const todayBtn = document.getElementById('dayTabToday');
        const cashBtn = document.getElementById('dayTabCash');
        const todayContent = document.getElementById('dayTodayContent');
        const cashContent = document.getElementById('dayCashContent');
        
        if (tab === 'today') {
            todayBtn.classList.add('active');
            cashBtn.classList.remove('active');
            todayContent.style.display = 'block';
            cashContent.style.display = 'none';
            this.loadTodayData();
        } else {
            cashBtn.classList.add('active');
            todayBtn.classList.remove('active');
            todayContent.style.display = 'none';
            cashContent.style.display = 'block';
            this.loadCashManagement();
        }
    },

    /**
     * Update the today header with current date
     */
    updateTodayHeader() {
        const header = document.getElementById('todayDateHeader');
        const subheader = document.getElementById('todayDateSubheader');
        
        if (header) {
            const today = new Date();
            const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
            header.textContent = t('ui.today.activity_title');
            if (subheader) {
                subheader.textContent = today.toLocaleDateString(displayLocale(), options);
            }
        }
    },

    /**
     * Load today's summary data
     */
    loadTodayData() {
        const todayIso = todayLocalISO();
        const session = CashManagementManager.todaySession;
        // Without the personal rows (listener not started/delivered) today's total comes from personalExpenseDays (#98)
        const personalReadable = !!FirebaseService.personalRowsLoaded?.();
        if (!personalReadable) this.loadPersonalDay(todayIso);
        const s = todaySummary({
            bills: { purchase: AppState.purchaseHistory, wholesale: AppState.salesHistory, retail: AppState.retailSalesHistory },
            expenses: AppState.expensesHistory,
            personalDay: personalReadable ? null : FirebaseService.personalExpenseDay?.(todayIso),
            sessions: this.sessionsOn(todayIso),
            settings: AppState.settings,
            today: new Date()
        });
        const { labour } = s;

        // Update UI - Main Stats
        this.updateElement('todayTotalPurchases', formatCurrency(s.purchases));
        this.updateElement('todayPurchaseCount', tn('ui.today.bills_count', s.purchaseCount));
        this.updateElement('todayTotalSales', formatCurrency(s.sales));
        this.updateElement('todaySaleCount', tn('ui.today.bills_count', s.saleCount));
        this.updateElement('todayLaborCost', formatCurrency(labour.deducted.amount));
        this.renderLabour(labour);
        
        // Expenses breakdown
        this.updateElement('todayBusinessExpenses', formatCurrency(s.businessExpenses));
        this.updateElement('todayBusinessExpenseCount', tn('ui.today.entries_count', s.businessExpenseCount));
        this.updateElement('todayPersonalExpenses', formatCurrency(s.personalExpenses));
        this.updateElement('todayPersonalExpenseCount', tn('ui.today.entries_count', s.personalExpenseCount));
        
        // Total In and Total Out for hero card
        this.updateElement('todayTotalIn', formatCurrency(s.totalIn));
        this.updateElement('todayTotalOut', formatCurrency(s.totalOut));
        
        // Net outflow with color coding
        const cashFlowLabel = document.getElementById('todayCashFlowLabel');
        if (cashFlowLabel) {
            cashFlowLabel.textContent = t(s.isOutflow ? 'ui.today.net_outflow' : 'ui.today.net_inflow');
        }
        
        const netCashFlowEl = document.getElementById('todayNetCashFlow');
        if (netCashFlowEl) {
            netCashFlowEl.style.color = s.isOutflow ? 'white' : '#a5f3fc';
            netCashFlowEl.textContent = formatCurrency(s.netAmount);
        }

        // Payment summary
        this.updateElement('todayCashReceived', formatCurrency(s.cashIn));
        this.updateElement('todayOnlineReceived', formatCurrency(s.onlineIn));
        this.updateElement('todayCashPaid', formatCurrency(s.cashOut));
        this.updateElement('todayOnlinePaid', formatCurrency(s.onlineOut));
        
        // Total cash flow with color
        const totalCashFlowEl = document.getElementById('todayTotalCashFlow');
        if (totalCashFlowEl) {
            totalCashFlowEl.textContent = (s.net >= 0 ? '+' : '') + formatCurrency(s.net);
        }

        // Due summary
        this.updateElement('todayDueReceived', formatCurrency(s.dueReceived));
        this.updateElement('todayDuePaid', formatCurrency(s.duePaid));
        this.updateElement('todayDueToReceive', formatCurrency(s.dueToReceive));
        this.updateElement('todayDueToPay', formatCurrency(s.dueToPay));

        // Render item-wise details
        this.renderItemWiseDetails(s.purchaseItems, 'purchase');
        this.renderItemWiseDetails(s.saleItems, 'sale');

        // Day report (#187, #40): today's anomalies + review queue, shared with these totals
        AnomaliesManager.renderDayReport({
            sales: s.sales, saleCount: s.saleCount,
            purchases: s.purchases, purchaseCount: s.purchaseCount,
            expenses: s.expenses, totalIn: s.totalIn, totalOut: s.totalOut,
            dueReceived: s.dueReceived, duePaid: s.duePaid,
            labourDeducted: labour.deducted.amount, labourDeductedBills: labour.deducted.bills,
            labourToPay: labour.toPay
        }, session && session.date === todayIso ? session : null);

        // App health banner (#217): a live check below its target today (owner/manager)
        HealthManager.renderTodayBanner().catch(e => console.warn('App health banner failed:', e));
    },

    /**
     * Render item-wise purchase or sale cards (T17)
     * @param {Array<Object>} itemsArray - todaySummary().purchaseItems / saleItems
     * @param {string} type - 'purchase' or 'sale'
     */
    renderItemWiseDetails(itemsArray, type) {
        const containerId = type === 'purchase' ? 'todayPurchaseItems' : 'todaySaleItems';
        const container = document.getElementById(containerId);
        if (!container) return;

        if (itemsArray.length === 0) {
            container.innerHTML = `<p class="empty-state">${Helpers.escapeHtml(t(type === 'purchase' ? 'ui.today.no_purchases_today' : 'ui.today.no_sales_today'))}</p>`;
            return;
        }

        const cardClass = type === 'purchase' ? 'stat-card-info-light' : 'stat-card-success-light';
        const labelClass = type === 'purchase' ? 'stat-value-info' : 'stat-value-success';

        const label = (key) => Helpers.escapeHtml(t(key));
        container.innerHTML = itemsArray.map(item => {
            const avgRate = item.avgRate === null ? 0 : item.avgRate.toFixed(2);
            
            return `
                <div class="stat-card ${cardClass}" style="text-align: left; padding: 14px;">
                    <div style="font-weight: 600; color: var(--text-primary); font-size: 15px; margin-bottom: 8px;">${Helpers.escapeHtml(item.name)}</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 14px;">
                        <div><span style="color: var(--text-secondary);">${label(type === 'purchase' ? 'ui.today.purchases_label' : 'ui.today.sales_label')}</span> <strong>${item.count}x</strong></div>
                        <div><span style="color: var(--text-secondary);">${label('ui.today.qty_label')}</span> <strong>${item.quantity.toFixed(2)} kg</strong></div>
                        <div><span style="color: var(--text-secondary);">${label('ui.billing.total_colon')}</span> <strong class="${labelClass}">${formatCurrency(item.totalValue)}</strong></div>
                        <div><span style="color: var(--text-secondary);">${label('ui.today.avg_rate_label')}</span> <strong>₹${avgRate}/kg</strong></div>
                    </div>
                </div>
            `;
        }).join('');
    },

    /**
     * Helper to update element text
     */
    /**
     * Loads today's personal expense total for a role that can't read the rows
     * (#98) and redraws once it arrives (FirebaseService reuses it for a minute).
     * @param {string} day YYYY-MM-DD
     */
    loadPersonalDay(day) {
        if (this.personalDayLoading) return;
        const before = JSON.stringify(FirebaseService.personalExpenseDay?.(day) ?? null);
        this.personalDayLoading = Promise.resolve(FirebaseService.loadPersonalExpenseDay?.(day))
            .then(() => {
                if (JSON.stringify(FirebaseService.personalExpenseDay?.(day) ?? null) !== before
                    && document.getElementById('todayTotalIn')) this.loadTodayData();
            })
            .catch(e => console.warn('Personal expense day total not loaded:', e))
            .finally(() => { this.personalDayLoading = null; });
    },

    updateElement(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    },

    /**
     * Today › Labour card: deducted from farmers (T-LAB-1), to pay labour (T-LAB-2) and the gap.
     * @param {Object} labour - todaySummary().labour (labourSummary + gap + packets)
     */
    renderLabour(labour) {
        this.lastLabour = labour;
        const { deducted, toPay, gap } = labour;
        this.updateElement('todayLabourDeductedBills', tn('ui.today.labour_deducted_bills', deducted.bills));
        this.updateElement('todayLabourToPay', formatCurrency(toPay.amount));
        this.updateElement('todayLabourToPayCalc', labourCalcText(toPay, 'ui.today.labour_to_pay_calc'));
        this.updateElement('todayLabourDiff', t(LABOUR_GAP_KEYS[gap.kind], { amount: formatCurrency(gap.amount) }));
    },

    /** Tap on the Labour card: today's purchase bills with kg, packets and labour deducted. */
    showLabourBreakdown() {
        const labour = this.lastLabour;
        if (!labour) return Promise.resolve(false);
        const esc = (v) => Helpers.escapeHtml(v == null ? '' : String(v));
        const { deducted, toPay, rows, packets } = labour;
        const body = rows.length ? rows.map(({ bill, kg, packets, labour: amount }) => {
            const name = [bill.billNumber ? `#${bill.billNumber}` : '', bill.customerName || bill.seller || ''].filter(Boolean).join(' ');
            return `<tr><td>${esc(name || t('ui.reports.unknown'))}</td><td>${esc(formatKg(kg))}</td><td>${esc(packets)}</td><td>${esc(formatCurrency(amount))}</td></tr>`;
        }).join('') : `<tr><td colspan="4">${esc(t('ui.today.no_purchases_today'))}</td></tr>`;
        const html = `
            <table class="labour-breakdown-table">
                <thead><tr><th>${esc(t('ui.today.labour_col_bill'))}</th><th>${esc(t('ui.today.labour_col_kg'))}</th><th>${esc(t('ui.today.labour_col_packets'))}</th><th>${esc(t('ui.today.labour_col_deducted'))}</th></tr></thead>
                <tbody>${body}</tbody>
                <tfoot><tr><th>${esc(t('ui.today.labour_total'))}</th><th>${esc(formatKg(toPay.kg))}</th><th>${esc(packets)}</th><th>${esc(formatCurrency(deducted.amount))}</th></tr></tfoot>
            </table>
            <p class="labour-breakdown-note"><strong>${esc(t('ui.today.labour_to_pay'))}</strong> ${esc(formatCurrency(toPay.amount))} ${esc(labourCalcText(toPay, 'ui.today.labour_to_pay_calc'))}</p>
            <p class="labour-breakdown-note">${esc(t('ui.today.labour_note'))}</p>`;
        return UIManager.showModalWithHtml(html, t('ui.today.labour_breakdown_title'));
    },

    /**
     * Render today's transactions list
     */
    renderTransactionsList(purchases, wholesaleSales, retailSales, expenses) {
        const container = document.getElementById('todayTransactionsList');
        if (!container) return;

        const filter = document.getElementById('todayTransactionFilter')?.value || 'all';

        // Combine all transactions with type
        let transactions = [];

        if (filter === 'all' || filter === 'purchase') {
            purchases.forEach(p => transactions.push({
                type: 'purchase',
                icon: '🛒',
                label: t('ui.reports.pdf_purchase'),
                party: p.seller || t('ui.reports.unknown'),
                amount: p.total || 0,
                date: p.date,
                color: '#059669',
                bgColor: '#d1fae5'
            }));
        }

        if (filter === 'all' || filter === 'sale') {
            wholesaleSales.forEach(s => transactions.push({
                type: 'sale',
                icon: '💰',
                label: t('ui.finance.bill_wholesale'),
                party: s.buyer || t('ui.reports.unknown'),
                amount: s.total || 0,
                date: s.date,
                color: '#2563eb',
                bgColor: '#dbeafe'
            }));
        }

        if (filter === 'all' || filter === 'retail') {
            retailSales.forEach(s => transactions.push({
                type: 'retail',
                icon: '🛍️',
                label: t('ui.finance.bill_retail'),
                party: s.buyer || t('ui.today.walk_in'),
                amount: s.total || 0,
                date: s.date,
                color: '#7c3aed',
                bgColor: '#f3e8ff'
            }));
        }

        if (filter === 'all' || filter === 'expense') {
            expenses.forEach(e => transactions.push({
                type: 'expense',
                icon: '💳',
                label: e.type || t('ui.today.expense'),
                party: e.description || (e.category === 'personal' ? t('ui.expenses.personal_expenses') : e.category === 'business' ? t('ui.expenses.business_expenses') : (e.category || t('ui.today.misc'))),
                amount: e.amount || 0,
                date: e.date,
                color: '#d97706',
                bgColor: '#fef3c7'
            }));
        }

        // Sort by date (newest first)
        transactions.sort((a, b) => {
            const dateA = parseAnyBillDate(a.date) || 0;
            const dateB = parseAnyBillDate(b.date) || 0;
            return dateB - dateA;
        });

        if (transactions.length === 0) {
            container.innerHTML = `<p style="text-align: center; color: #9ca3af; padding: 20px;">${Helpers.escapeHtml(t('ui.today.no_transactions'))}</p>`;
            return;
        }

        container.innerHTML = transactions.map(t => {
            const time = parseAnyBillDate(t.date);
            const timeStr = time ? Helpers.formatTime(time) : '';
            
            return `
                <div style="display: flex; align-items: center; gap: 12px; padding: 12px; border-bottom: 1px solid #f3f4f6;">
                    <div style="width: 40px; height: 40px; border-radius: 10px; background: ${t.bgColor}; display: flex; align-items: center; justify-content: center; font-size: 18px;">
                        ${t.icon}
                    </div>
                    <div style="flex: 1; min-width: 0;">
                        <div style="font-weight: 600; color: #374151; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${Helpers.escapeHtml(t.party)}</div>
                        <div style="font-size: 12px; color: #9ca3af;">${Helpers.escapeHtml(t.label)} • ${timeStr}</div>
                    </div>
                    <div style="font-weight: 700; color: ${t.color}; font-size: 15px;">
                        ${t.type === 'expense' || t.type === 'purchase' ? '-' : '+'}${formatCurrency(t.amount)}
                    </div>
                </div>
            `;
        }).join('');
    },

    /**
     * Filter transactions based on dropdown
     */
    filterTransactions() {
        this.loadTodayData();
    },

    /**
     * Load cash management content into the sub-tab
     */
    loadCashManagement() {
        const container = document.getElementById('dayCashManagementContainer');
        const cashManagementTab = document.getElementById('cash-management');
        
        if (container && cashManagementTab) {
            // Clone the inner content of cash management (skip the outer div)
            const innerContent = cashManagementTab.querySelector('div[style*="padding"]');
            if (innerContent) {
                container.innerHTML = innerContent.innerHTML;
            } else {
                container.innerHTML = cashManagementTab.innerHTML;
            }
            
            // Re-initialize cash management
            if (window.app && window.app.cashManagement) {
                setTimeout(() => {
                    window.app.cashManagement.init()
                        .catch(e => console.error('Cash management re-init failed:', e));
                }, 100);
            }
        }
    }
};
