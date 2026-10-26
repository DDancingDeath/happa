// -------------------- DAY MODULE --------------------
// Manages the Day page with Today's Summary and Cash Management sub-tabs

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { activityBills, outstandingDue, round2 } from '../utils/money.js';
import { parseAnyBillDate, todayLocalISO, displayLocale } from '../utils/dates.js';
import { dueEvents, sumDueEvents, saleTimePayment } from '../utils/due-payments.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { CashManagementManager } from './cash-management.js';
import { AnomaliesManager } from './anomalies.js';
import { HealthManager } from './health.js';
import { t, tn } from '../i18n/index.js';

// Use helper functions
const formatCurrency = (amount) => Helpers.formatCurrency(amount);
const formatDate = (date) => Helpers.formatDate(date);

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

    /**
     * Today's cash session carries drawer legs of due payments whose bills may
     * not be in memory (#95). Load it once if the Cash tab hasn't, then redraw.
     */
    loadTodaySession() {
        const today = todayLocalISO();
        if (CashManagementManager.todaySession?.date === today) return;
        FirebaseService.loadCashSessionsForDate(today)
            .then(sessions => {
                if (CashManagementManager.todaySession?.date === today || sessions.length === 0) return;
                CashManagementManager.todaySession = sessions.find(s => !s.signedOut) || sessions[0];
                this.loadTodayData();
            })
            .catch(e => console.warn('Could not load today\'s cash session:', e?.message || e));
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
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Filter today's purchases
        const todayPurchases = activityBills(AppState.purchaseHistory).filter(p => {
            const date = parseAnyBillDate(p.date);
            return date && date >= today && date < tomorrow;
        });

        // Filter today's wholesale sales
        const todayWholesaleSales = activityBills(AppState.salesHistory).filter(s => {
            const date = parseAnyBillDate(s.date);
            return date && date >= today && date < tomorrow;
        });

        // Filter today's retail sales
        const todayRetailSales = activityBills(AppState.retailSalesHistory).filter(s => {
            const date = parseAnyBillDate(s.date);
            return date && date >= today && date < tomorrow;
        });

        // Filter today's expenses
        const todayExpenses = (AppState.expensesHistory || []).filter(e => {
            const date = parseAnyBillDate(e.date);
            return date && date >= today && date < tomorrow;
        });

        // Calculate totals
        // Purchases can have: grandTotal, amountPayable, billTotal, or total
        const totalPurchases = todayPurchases.reduce((sum, p) => {
            const amount = Number(p.grandTotal) || Number(p.amountPayable) || Number(p.billTotal) || Number(p.total) || 0;
            return sum + amount;
        }, 0);
        const totalWholesaleSales = todayWholesaleSales.reduce((sum, s) => {
            const amount = Number(s.grandTotal) || Number(s.total) || Number(s.saleTotal) || 0;
            return sum + amount;
        }, 0);
        const totalRetailSales = todayRetailSales.reduce((sum, s) => {
            const amount = Number(s.grandTotal) || Number(s.total) || Number(s.saleTotal) || 0;
            return sum + amount;
        }, 0);
        const totalSales = totalWholesaleSales + totalRetailSales;
        
        // Expenses split by category
        const businessExpenses = todayExpenses.filter(e => e.category === 'business');
        const personalExpenses = todayExpenses.filter(e => e.category === 'personal');
        
        const totalBusinessExpenses = businessExpenses.reduce((sum, e) => {
            return sum + (Number(e.amount) || Number(e.total) || 0);
        }, 0);
        const totalPersonalExpenses = personalExpenses.reduce((sum, e) => {
            return sum + (Number(e.amount) || Number(e.total) || 0);
        }, 0);
        const totalExpenses = totalBusinessExpenses + totalPersonalExpenses;

        // Calculate labor cost from purchases
        const totalLaborCost = todayPurchases.reduce((sum, p) => sum + (p.laborCharges || p.labour || 0), 0);

        // Calculate quantities
        let qtyPurchased = 0;
        todayPurchases.forEach(p => {
            (p.items || []).forEach(item => {
                qtyPurchased += parseFloat(item.qty || item.quantity || 0);
            });
        });

        let qtySold = 0;
        [...todayWholesaleSales, ...todayRetailSales].forEach(s => {
            (s.items || []).forEach(item => {
                qtySold += parseFloat(item.qty || item.quantity || 0);
            });
        });

        // Calculate payments
        let cashReceived = 0, onlineReceived = 0, cashPaid = 0, onlinePaid = 0;
        let dueToReceive = 0, dueToPay = 0;

        // From purchases (cash/online paid when saved, due to pay). Money paid
        // later on a bill is a due payment, counted on the day it was paid.
        todayPurchases.forEach(p => {
            const paid = saleTimePayment(p);
            cashPaid += paid.cash;
            onlinePaid += paid.online;
            dueToPay += outstandingDue(p); // 0 once cleared
        });

        // From sales (cash/online received when saved, due to receive)
        [...todayWholesaleSales, ...todayRetailSales].forEach(s => {
            const paid = saleTimePayment(s);
            cashReceived += paid.cash;
            onlineReceived += paid.online;
            dueToReceive += outstandingDue(s);
        });

        // Due payments made today (#95): entries on any loaded bill plus the
        // drawer legs in today's cash session, counted once (cash + online).
        const todayIso = todayLocalISO();
        const session = CashManagementManager.todaySession;
        const dues = sumDueEvents(dueEvents({
            bills: { retail: AppState.retailSalesHistory || [], wholesale: AppState.salesHistory || [], purchase: AppState.purchaseHistory || [] },
            sessions: session && session.date === todayIso ? [session] : [],
            from: today.getTime(),
            to: tomorrow.getTime()
        }));
        const dueReceived = round2(dues.receivedCash + dues.receivedOnline);
        const duePaid = round2(dues.paidCash + dues.paidOnline);

        // Breakdown by method, including due payments; the hero totals are their sums
        const cashIn = round2(cashReceived + dues.receivedCash);
        const onlineIn = round2(onlineReceived + dues.receivedOnline);
        const cashOut = round2(cashPaid + totalExpenses + dues.paidCash);
        const onlineOut = round2(onlinePaid + dues.paidOnline);
        const totalCashIn = round2(cashIn + onlineIn);
        const totalCashOut = round2(cashOut + onlineOut);
        const totalCashFlow = totalCashIn - totalCashOut;

        // Net outflow (Out - In): positive means money went out, negative means money came in
        const netOutflow = totalCashOut - totalCashIn;

        // Update UI - Main Stats
        this.updateElement('todayTotalPurchases', formatCurrency(totalPurchases));
        this.updateElement('todayPurchaseCount', tn('ui.today.bills_count', todayPurchases.length));
        this.updateElement('todayTotalSales', formatCurrency(totalSales));
        this.updateElement('todaySaleCount', tn('ui.today.bills_count', todayWholesaleSales.length + todayRetailSales.length));
        this.updateElement('todayLaborCost', formatCurrency(totalLaborCost));
        
        // Expenses breakdown
        this.updateElement('todayBusinessExpenses', formatCurrency(totalBusinessExpenses));
        this.updateElement('todayBusinessExpenseCount', tn('ui.today.entries_count', businessExpenses.length));
        this.updateElement('todayPersonalExpenses', formatCurrency(totalPersonalExpenses));
        this.updateElement('todayPersonalExpenseCount', tn('ui.today.entries_count', personalExpenses.length));
        
        // Total In and Total Out for hero card
        this.updateElement('todayTotalIn', formatCurrency(totalCashIn));
        this.updateElement('todayTotalOut', formatCurrency(totalCashOut));
        
        // Net outflow with color coding
        const cashFlowLabel = document.getElementById('todayCashFlowLabel');
        if (cashFlowLabel) {
            cashFlowLabel.textContent = t(netOutflow >= 0 ? 'ui.today.net_outflow' : 'ui.today.net_inflow');
        }
        
        const netCashFlowEl = document.getElementById('todayNetCashFlow');
        if (netCashFlowEl) {
            netCashFlowEl.style.color = netOutflow >= 0 ? 'white' : '#a5f3fc';
            netCashFlowEl.textContent = formatCurrency(Math.abs(netOutflow));
        }

        // Payment summary
        this.updateElement('todayCashReceived', formatCurrency(cashIn));
        this.updateElement('todayOnlineReceived', formatCurrency(onlineIn));
        this.updateElement('todayCashPaid', formatCurrency(cashOut));
        this.updateElement('todayOnlinePaid', formatCurrency(onlineOut));
        
        // Total cash flow with color
        const totalCashFlowEl = document.getElementById('todayTotalCashFlow');
        if (totalCashFlowEl) {
            totalCashFlowEl.textContent = (totalCashFlow >= 0 ? '+' : '') + formatCurrency(totalCashFlow);
        }

        // Due summary
        this.updateElement('todayDueReceived', formatCurrency(dueReceived));
        this.updateElement('todayDuePaid', formatCurrency(duePaid));
        this.updateElement('todayDueToReceive', formatCurrency(dueToReceive));
        this.updateElement('todayDueToPay', formatCurrency(dueToPay));

        // Render item-wise details
        this.renderItemWiseDetails(todayPurchases, 'purchase');
        this.renderItemWiseDetails([...todayWholesaleSales, ...todayRetailSales], 'sale');

        // Day report (#187, #40): today's anomalies + review queue, shared with these totals
        AnomaliesManager.renderDayReport({
            sales: totalSales, saleCount: todayWholesaleSales.length + todayRetailSales.length,
            purchases: totalPurchases, purchaseCount: todayPurchases.length,
            expenses: totalExpenses, totalIn: totalCashIn, totalOut: totalCashOut,
            dueReceived, duePaid
        }, session && session.date === todayIso ? session : null);

        // App health banner (#217): a live check below its target today (owner/manager)
        HealthManager.renderTodayBanner().catch(e => console.warn('App health banner failed:', e));
    },

    /**
     * Render item-wise purchase or sale details
     * @param {Array} transactions - Array of purchase or sale transactions
     * @param {string} type - 'purchase' or 'sale'
     */
    renderItemWiseDetails(transactions, type) {
        const containerId = type === 'purchase' ? 'todayPurchaseItems' : 'todaySaleItems';
        const container = document.getElementById(containerId);
        if (!container) return;

        // Aggregate items from all transactions
        const itemsMap = {};

        transactions.forEach(t => {
            const items = t.items || [];
            items.forEach(item => {
                const name = item.item || item.name || 'Unknown';
                if (!itemsMap[name]) {
                    itemsMap[name] = {
                        name: name,
                        count: 0,
                        quantity: 0,
                        totalValue: 0,
                        rates: []
                    };
                }
                itemsMap[name].count += 1;
                itemsMap[name].quantity += parseFloat(item.qty || item.quantity || 0);
                itemsMap[name].totalValue += parseFloat(item.total || item.amount || 0);
                if (item.rate) {
                    itemsMap[name].rates.push(parseFloat(item.rate));
                }
            });
        });

        // Convert to array and sort by total value (popularity)
        const itemsArray = Object.values(itemsMap).sort((a, b) => b.totalValue - a.totalValue);

        if (itemsArray.length === 0) {
            container.innerHTML = `<p class="empty-state">${Helpers.escapeHtml(t(type === 'purchase' ? 'ui.today.no_purchases_today' : 'ui.today.no_sales_today'))}</p>`;
            return;
        }

        const cardClass = type === 'purchase' ? 'stat-card-info-light' : 'stat-card-success-light';
        const labelClass = type === 'purchase' ? 'stat-value-info' : 'stat-value-success';

        const label = (key) => Helpers.escapeHtml(t(key));
        container.innerHTML = itemsArray.map(item => {
            const avgRate = item.quantity > 0 
                ? (item.totalValue / item.quantity).toFixed(2)
                : 0;
            
            return `
                <div class="stat-card ${cardClass}" style="text-align: left; padding: 14px;">
                    <div style="font-weight: 600; color: var(--text-primary); font-size: 15px; margin-bottom: 8px;">${Helpers.escapeHtml(item.name)}</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 13px;">
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
    updateElement(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
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
