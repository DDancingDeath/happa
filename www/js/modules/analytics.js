/**
 * @fileoverview Analytics Module - Business Insights
 * Provides intelligent analytics, predictions, and actionable insights
 * @module modules/analytics
 */

import { AppState } from '../utils/state.js';
import { Helpers } from '../utils/helpers.js';
import { rangeStatus, retryRange, applyRangeState } from '../utils/history-window.js';
import { createRenderMemo } from '../utils/render-memo.js';
import { FinanceManager } from './finance.js';
import { profitByDay } from '../utils/finance-calc.js';
import { t } from '../i18n/index.js';

const formatCurrency = (amount) => Helpers.formatCurrency(amount);

const PROFIT_PERIOD_DAYS = { '7days': 7, '30days': 30, '90days': 90 };
/** Skips recomputing the overview on a tab revisit when nothing changed (#24). */
const overviewMemo = createRenderMemo();

/**
 * Analytics Manager - Smart Business Insights
 */
export class AnalyticsManager {
    static profitPeriod = '7days';
    static currentTab = 'overview';

    /**
     * Initialize analytics page
     */
    static init() {
        this.currentTab = 'overview';
        if (overviewMemo.isCurrent()) return;
        this.renderAll();
    }

    /**
     * Show a specific tab
     */
    static showTab(tab, evt) {
        this.currentTab = tab;

        // Update button states
        const buttons = document.querySelectorAll('#analytics > .filter-buttons > .filter-btn');
        buttons.forEach(btn => {
            const btnTab = btn.onclick?.toString().match(/showTab\('(\w+)'/)?.[1];
            btn.classList.toggle('active', btnTab === tab);
        });

        // Show/hide tab contents
        const tabs = ['overview', 'trends', 'items', 'insights'];
        tabs.forEach(t => {
            const tabEl = document.getElementById(`analytics${t.charAt(0).toUpperCase() + t.slice(1)}Tab`);
            if (tabEl) {
                tabEl.style.display = t === tab ? 'block' : 'none';
            }
        });

        // Render relevant sections
        this.renderTabContent(tab);
    }

    /**
     * Render content for specific tab
     */
    static renderTabContent(tab) {
        if (!this.ensureRange(tab, () => this.renderTabContent(tab))) return;
        switch (tab) {
            case 'overview':
                this.renderTodayPrediction();
                this.renderMonthSummary();
                this.renderOutstandingDues();
                this.renderMonthlyProjection();
                break;
            case 'trends':
                this.renderProfitTrend();
                this.renderRateTrends();
                break;
            case 'items':
                this.renderItemsToFocus();
                this.renderTopPerformers();
                break;
            case 'insights':
                this.renderSmartSuggestions();
                this.renderCustomerInsights();
                break;
        }
    }

    /**
     * Render all analytics sections
     */
    static renderAll() {
        if (!this.ensureRange('overview', () => this.renderAll())) {
            overviewMemo.reset();
            return;
        }
        this.renderTodayPrediction();
        this.renderMonthSummary();
        this.renderOutstandingDues();
        this.renderMonthlyProjection();
        overviewMemo.record();
        // Other tabs will render on demand
    }

    /**
     * Earliest date a tab's figures read (local midnight). Overview/items/
     * insights use last month and the same weekday over the last 4 weeks;
     * trends also use the profit-trend period.
     * @param {string} tab
     * @returns {Date}
     */
    static requiredStart(tab) {
        const { today, lastMonthStart } = this.getDateHelpers();
        const fourWeeksAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 28);
        let start = lastMonthStart < fourWeeksAgo ? lastMonthStart : fourWeeksAgo;
        if (tab === 'trends') {
            const trendStart = this.profitTrendStart();
            if (trendStart < start) start = trendStart;
        }
        return start;
    }

    /**
     * Local midnight on or before the start of the profit-trend period.
     * @returns {Date}
     */
    static profitTrendStart() {
        const days = PROFIT_PERIOD_DAYS[this.profitPeriod] || 7;
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
    }

    /**
     * Make sure the tab's date range is loaded before computing it; shows a
     * loading notice (and hides stale figures) meanwhile.
     * @param {string} tab
     * @param {Function} rerender
     * @returns {boolean} true when the tab can render now
     */
    static ensureRange(tab, rerender) {
        const owner = `analytics-${tab}`;
        const status = rangeStatus(owner, this.requiredStart(tab), rerender);
        const tabEl = document.getElementById(`analytics${tab.charAt(0).toUpperCase() + tab.slice(1)}Tab`);
        if (tabEl) {
            const scopes = [...tabEl.children].filter(el => !el.classList.contains('history-range-notice'));
            applyRangeState(scopes, status, {
                loadingText: 'Loading older data…',
                onRetry: () => {
                    retryRange(owner);
                    rerender();
                }
            });
        }
        return status !== 'loading';
    }

    /**
     * Get date helpers
     */
    static getDateHelpers() {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const dayOfMonth = now.getDate();
        const daysRemaining = daysInMonth - dayOfMonth;

        return { now, today, monthStart, lastMonthStart, lastMonthEnd, daysInMonth, dayOfMonth, daysRemaining };
    }

    /**
     * Parse transaction date
     */
    static parseDate(dateField) {
        if (!dateField) return new Date(0);
        if (dateField.toDate) return dateField.toDate();
        return new Date(dateField);
    }

    /**
     * Filter transactions by date range
     */
    static filterByDateRange(transactions, startDate, endDate = new Date()) {
        return (transactions || []).filter(t => {
            const date = this.parseDate(t.date);
            return date >= startDate && date <= endDate;
        });
    }

    /**
     * Get transaction total
     */
    static getTotal(t) {
        return Number(t.grandTotal) || Number(t.amountPayable) || Number(t.billTotal) || Number(t.total) || 0;
    }

    /**
     * Render Today's Cash Prediction
     */
    static renderTodayPrediction() {
        const { today } = this.getDateHelpers();
        const dayOfWeek = today.getDay();

        // Get last 4 weeks of same weekday data
        const sameDayData = [];
        for (let i = 1; i <= 4; i++) {
            const pastDate = new Date(today);
            pastDate.setDate(pastDate.getDate() - (i * 7));
            const nextDay = new Date(pastDate);
            nextDay.setDate(nextDay.getDate() + 1);

            const dayPurchases = this.filterByDateRange(AppState.purchaseHistory, pastDate, nextDay);
            const daySales = [
                ...this.filterByDateRange(AppState.salesHistory, pastDate, nextDay),
                ...this.filterByDateRange(AppState.retailSalesHistory, pastDate, nextDay)
            ];

            const purchaseTotal = dayPurchases.reduce((sum, p) => sum + this.getTotal(p), 0);
            const salesTotal = daySales.reduce((sum, s) => sum + this.getTotal(s), 0);
            const cashPaid = dayPurchases.reduce((sum, p) => sum + (p.cashPayment || p.payment?.cash || 0), 0);
            const cashReceived = daySales.reduce((sum, s) => sum + (s.cashPayment || s.payment?.cash || 0), 0);

            sameDayData.push({ purchaseTotal, salesTotal, cashPaid, cashReceived });
        }

        // Calculate averages
        const validData = sameDayData.filter(d => d.purchaseTotal > 0 || d.salesTotal > 0);
        const dataPoints = validData.length || 1;

        const avgPurchases = validData.reduce((sum, d) => sum + d.purchaseTotal, 0) / dataPoints;
        const avgSales = validData.reduce((sum, d) => sum + d.salesTotal, 0) / dataPoints;
        const avgCashPaid = validData.reduce((sum, d) => sum + d.cashPaid, 0) / dataPoints;
        const avgCashReceived = validData.reduce((sum, d) => sum + d.cashReceived, 0) / dataPoints;

        const cashNeeded = Math.max(0, avgCashPaid - avgCashReceived);
        const confidence = Math.min(95, 50 + (dataPoints * 10));

        this.updateElement('predictedPurchases', formatCurrency(avgPurchases));
        this.updateElement('predictedSales', formatCurrency(avgSales));
        this.updateElement('predictedCashNeed', formatCurrency(cashNeeded));
        this.updateElement('predictionConfidence', `${confidence}%`);
    }

    /**
     * This month (1st to now): the Finance summary, so profit is the same number
     * Finance shows (#36: sales − cost of goods sold − business expenses − bad debts).
     */
    static monthProfit() {
        const { monthStart, now } = this.getDateHelpers();
        return FinanceManager.profitSummary({ from: monthStart.getTime(), to: now.getTime() + 1 });
    }

    /**
     * Render This Month Summary
     */
    static renderMonthSummary() {
        const { monthStart, lastMonthStart, lastMonthEnd, now } = this.getDateHelpers();

        // This month data
        const thisMonthPurchases = this.filterByDateRange(AppState.purchaseHistory, monthStart);
        const thisMonthSales = [
            ...this.filterByDateRange(AppState.salesHistory, monthStart),
            ...this.filterByDateRange(AppState.retailSalesHistory, monthStart)
        ];
        const thisMonthExpenses = this.filterByDateRange(AppState.expensesHistory, monthStart)
            .filter(e => e.category !== 'personal');

        // Last month data (for comparison)
        const lastMonthPurchases = this.filterByDateRange(AppState.purchaseHistory, lastMonthStart, lastMonthEnd);
        const lastMonthSales = [
            ...this.filterByDateRange(AppState.salesHistory, lastMonthStart, lastMonthEnd),
            ...this.filterByDateRange(AppState.retailSalesHistory, lastMonthStart, lastMonthEnd)
        ];

        // Calculate totals
        const revenue = thisMonthSales.reduce((sum, s) => sum + this.getTotal(s), 0);
        const purchases = thisMonthPurchases.reduce((sum, p) => sum + this.getTotal(p), 0);
        const expenses = thisMonthExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);
        const month = this.monthProfit();
        const profit = month.profit;
        const profitMargin = profit === null ? '—' : month.sales.total > 0 ? ((profit / month.sales.total) * 100).toFixed(1) : 0;

        // Last month totals
        const lastRevenue = lastMonthSales.reduce((sum, s) => sum + this.getTotal(s), 0);
        const lastPurchases = lastMonthPurchases.reduce((sum, p) => sum + this.getTotal(p), 0);

        // Growth calculations
        const revenueGrowth = lastRevenue > 0 ? (((revenue - lastRevenue) / lastRevenue) * 100).toFixed(0) : 0;
        const purchaseGrowth = lastPurchases > 0 ? (((purchases - lastPurchases) / lastPurchases) * 100).toFixed(0) : 0;

        this.updateElement('monthRevenue', formatCurrency(revenue));
        this.updateElement('monthPurchases', formatCurrency(purchases));
        this.updateElement('monthProfit', profit === null ? '—' : formatCurrency(profit));
        this.updateElement('monthExpenses', formatCurrency(expenses));
        this.updateElement('monthProfitMargin', `${profitMargin}% margin`);
        this.updateElement('monthExpensesCount', `${thisMonthExpenses.length} transactions`);

        const revenueGrowthEl = document.getElementById('monthRevenueGrowth');
        if (revenueGrowthEl) {
            const arrow = revenueGrowth >= 0 ? '↑' : '↓';
            const color = revenueGrowth >= 0 ? '#16a34a' : '#dc2626';
            revenueGrowthEl.innerHTML = `<span style="color: ${color}">${arrow} ${Math.abs(revenueGrowth)}%</span> vs last month`;
        }

        const purchaseGrowthEl = document.getElementById('monthPurchasesGrowth');
        if (purchaseGrowthEl) {
            const arrow = purchaseGrowth >= 0 ? '↑' : '↓';
            const color = purchaseGrowth <= 0 ? '#16a34a' : '#dc2626'; // Lower is better for purchases
            purchaseGrowthEl.innerHTML = `<span style="color: ${color}">${arrow} ${Math.abs(purchaseGrowth)}%</span> vs last month`;
        }
    }

    /**
     * Set profit trend period
     */
    static setProfitPeriod(period, evt) {
        this.profitPeriod = period;
        
        // Update button states
        const buttons = document.querySelectorAll('#analytics .settings-card .filter-btn');
        buttons.forEach(btn => {
            if (btn.onclick && btn.onclick.toString().includes('setProfitPeriod')) {
                btn.classList.toggle('active', btn.onclick.toString().includes(`'${period}'`));
            }
        });

        if (this.ensureRange('trends', () => this.renderTabContent('trends'))) {
            this.renderProfitTrend();
        }
    }

    /**
     * Render Profit Trend Chart
     */
    static renderProfitTrend() {
        const container = document.getElementById('profitTrendChart');
        const summaryContainer = document.getElementById('profitTrendSummary');
        if (!container) return;

        // Calculate date range
        const now = new Date();
        let startDate;
        switch (this.profitPeriod) {
            case '7days': startDate = new Date(now - 7 * 24 * 60 * 60 * 1000); break;
            case '30days': startDate = new Date(now - 30 * 24 * 60 * 60 * 1000); break;
            case '90days': startDate = new Date(now - 90 * 24 * 60 * 60 * 1000); break;
            default: startDate = new Date(now - 7 * 24 * 60 * 60 * 1000);
        }

        // Group data by day
        const dailyData = {};
        const dayStart = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
        const summary = FinanceManager.profitSummary({ from: dayStart.getTime(), to: Infinity, detail: true });
        if (summary.profit === null) {
            container.innerHTML = `<p style="text-align: center; color: var(--text-secondary); padding: 40px;">${Helpers.escapeHtml(t('ui.finance.needs_full_history'))}</p>`;
            if (summaryContainer) summaryContainer.innerHTML = '';
            return;
        }

        // Initialize all days in range
        const currentDate = new Date(startDate);
        while (currentDate <= now) {
            const dateKey = currentDate.toLocaleDateString('en-IN');
            dailyData[dateKey] = { profit: 0 };
            currentDate.setDate(currentDate.getDate() + 1);
        }

        // Same profit as Finance, per day (#36)
        const byDay = profitByDay(summary.detail, (ms) => new Date(ms).toLocaleDateString('en-IN'));
        Object.entries(byDay).forEach(([date, profit]) => {
            if (dailyData[date]) dailyData[date].profit = profit;
        });

        const sortedDates = Object.keys(dailyData).sort((a, b) => {
            const [d1, m1, y1] = a.split('/');
            const [d2, m2, y2] = b.split('/');
            return new Date(y1, m1 - 1, d1) - new Date(y2, m2 - 1, d2);
        });

        if (sortedDates.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 40px;">No data available</p>';
            return;
        }

        // Find max absolute value for scaling
        const maxProfit = Math.max(...sortedDates.map(d => Math.abs(dailyData[d].profit)));
        const chartHeight = 160;

        // Render chart
        let chartHTML = `<div style="display: flex; gap: 4px; align-items: center; height: ${chartHeight + 20}px; padding: 10px 0; overflow-x: auto;">`;
        
        sortedDates.forEach((date, index) => {
            const data = dailyData[date];
            const isPositive = data.profit >= 0;
            const barHeight = maxProfit > 0 ? (Math.abs(data.profit) / maxProfit) * (chartHeight / 2) : 0;
            const color = isPositive ? '#16a34a' : '#dc2626';
            const bgColor = isPositive ? 'rgba(22, 163, 74, 0.8)' : 'rgba(220, 38, 38, 0.8)';

            chartHTML += `
                <div style="flex: 1; min-width: 30px; display: flex; flex-direction: column; align-items: center; height: 100%;">
                    <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; width: 100%;">
                        ${isPositive ? `
                            <div style="height: ${chartHeight / 2}px; display: flex; align-items: flex-end; justify-content: center;">
                                <div style="width: 80%; height: ${barHeight}px; background: ${bgColor}; border-radius: 3px 3px 0 0;" title="${formatCurrency(data.profit)}"></div>
                            </div>
                            <div style="height: ${chartHeight / 2}px; border-top: 1px solid var(--border-color);"></div>
                        ` : `
                            <div style="height: ${chartHeight / 2}px; border-bottom: 1px solid var(--border-color);"></div>
                            <div style="height: ${chartHeight / 2}px; display: flex; align-items: flex-start; justify-content: center;">
                                <div style="width: 80%; height: ${barHeight}px; background: ${bgColor}; border-radius: 0 0 3px 3px;" title="${formatCurrency(data.profit)}"></div>
                            </div>
                        `}
                    </div>
                    <div style="font-size: 9px; color: var(--text-secondary); margin-top: 4px; white-space: nowrap;">
                        ${date.split('/')[0]}/${date.split('/')[1]}
                    </div>
                </div>
            `;
        });

        chartHTML += '</div>';
        container.innerHTML = chartHTML;

        // Summary stats
        const totalProfit = sortedDates.reduce((sum, d) => sum + dailyData[d].profit, 0);
        const avgProfit = totalProfit / sortedDates.length;
        const profitDays = sortedDates.filter(d => dailyData[d].profit > 0).length;
        const lossDays = sortedDates.filter(d => dailyData[d].profit < 0).length;

        if (summaryContainer) {
            summaryContainer.innerHTML = `
                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; text-align: center;">
                    <div>
                        <div style="font-size: 11px; color: var(--text-secondary);">Total Profit</div>
                        <div style="font-size: 16px; font-weight: 700; color: ${totalProfit >= 0 ? '#16a34a' : '#dc2626'};">${formatCurrency(totalProfit)}</div>
                    </div>
                    <div>
                        <div style="font-size: 11px; color: var(--text-secondary);">Avg Daily</div>
                        <div style="font-size: 16px; font-weight: 700; color: ${avgProfit >= 0 ? '#16a34a' : '#dc2626'};">${formatCurrency(avgProfit)}</div>
                    </div>
                    <div>
                        <div style="font-size: 11px; color: var(--text-secondary);">Profit Days</div>
                        <div style="font-size: 16px; font-weight: 700; color: #16a34a;">${profitDays}</div>
                    </div>
                    <div>
                        <div style="font-size: 11px; color: var(--text-secondary);">Loss Days</div>
                        <div style="font-size: 16px; font-weight: 700; color: #dc2626;">${lossDays}</div>
                    </div>
                </div>
            `;
        }
    }

    /**
     * Render Item Rate Trends
     */
    static renderRateTrends() {
        const container = document.getElementById('rateTrendsContainer');
        if (!container) return;

        const { monthStart, lastMonthStart, lastMonthEnd } = this.getDateHelpers();

        // Get purchase data for rate analysis
        const thisMonthPurchases = this.filterByDateRange(AppState.purchaseHistory, monthStart);
        const lastMonthPurchases = this.filterByDateRange(AppState.purchaseHistory, lastMonthStart, lastMonthEnd);

        // Aggregate rates by item
        const thisMonthRates = {};
        const lastMonthRates = {};

        thisMonthPurchases.forEach(p => {
            (p.items || []).forEach(item => {
                const name = item.item || item.name;
                if (!name || !item.rate) return;
                if (!thisMonthRates[name]) thisMonthRates[name] = [];
                thisMonthRates[name].push(Number(item.rate));
            });
        });

        lastMonthPurchases.forEach(p => {
            (p.items || []).forEach(item => {
                const name = item.item || item.name;
                if (!name || !item.rate) return;
                if (!lastMonthRates[name]) lastMonthRates[name] = [];
                lastMonthRates[name].push(Number(item.rate));
            });
        });

        // Calculate average rates and trends
        const rateTrends = [];
        Object.keys(thisMonthRates).forEach(item => {
            const thisAvg = thisMonthRates[item].reduce((a, b) => a + b, 0) / thisMonthRates[item].length;
            const lastAvg = lastMonthRates[item] 
                ? lastMonthRates[item].reduce((a, b) => a + b, 0) / lastMonthRates[item].length 
                : thisAvg;
            
            const change = lastAvg > 0 ? ((thisAvg - lastAvg) / lastAvg) * 100 : 0;
            
            rateTrends.push({
                item,
                currentRate: thisAvg,
                lastRate: lastAvg,
                change,
                purchases: thisMonthRates[item].length
            });
        });

        // Sort by absolute change
        rateTrends.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

        if (rateTrends.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">No rate data available this month</p>';
            return;
        }

        container.innerHTML = rateTrends.slice(0, 8).map(trend => {
            const isUp = trend.change > 0;
            const arrow = isUp ? '↑' : (trend.change < 0 ? '↓' : '→');
            const color = isUp ? '#dc2626' : (trend.change < 0 ? '#16a34a' : '#6b7280');
            const bgColor = isUp ? '#fee2e2' : (trend.change < 0 ? '#dcfce7' : '#f3f4f6');

            return `
                <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: ${bgColor}; border-radius: 8px; margin-bottom: 8px;">
                    <div style="flex: 1;">
                        <div style="font-weight: 600; font-size: 14px; color: var(--text-primary);">${Helpers.escapeHtml(trend.item)}</div>
                        <div style="font-size: 12px; color: var(--text-secondary);">₹${trend.currentRate.toFixed(2)}/kg • ${trend.purchases} purchases</div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-weight: 700; font-size: 16px; color: ${color};">${arrow} ${Math.abs(trend.change).toFixed(1)}%</div>
                        <div style="font-size: 11px; color: var(--text-secondary);">vs last month</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    /**
     * Render Items to Focus
     */
    static renderItemsToFocus() {
        const container = document.getElementById('itemsToFocus');
        if (!container) return;

        const { monthStart } = this.getDateHelpers();

        // Get this month's transactions
        const purchases = this.filterByDateRange(AppState.purchaseHistory, monthStart);
        const sales = [
            ...this.filterByDateRange(AppState.salesHistory, monthStart),
            ...this.filterByDateRange(AppState.retailSalesHistory, monthStart)
        ];

        // Calculate item-wise profit margins
        const itemStats = {};

        // Aggregate purchase costs
        purchases.forEach(p => {
            (p.items || []).forEach(item => {
                const name = item.item || item.name;
                if (!name) return;
                if (!itemStats[name]) itemStats[name] = { purchased: 0, purchaseQty: 0, sold: 0, soldQty: 0 };
                itemStats[name].purchased += Number(item.total) || 0;
                itemStats[name].purchaseQty += Number(item.qty || item.quantity) || 0;
            });
        });

        // Aggregate sales revenue
        sales.forEach(s => {
            (s.items || []).forEach(item => {
                const name = item.item || item.name;
                if (!name) return;
                if (!itemStats[name]) itemStats[name] = { purchased: 0, purchaseQty: 0, sold: 0, soldQty: 0 };
                itemStats[name].sold += Number(item.total) || 0;
                itemStats[name].soldQty += Number(item.qty || item.quantity) || 0;
            });
        });

        // Calculate metrics and recommendations
        const recommendations = [];
        Object.keys(itemStats).forEach(item => {
            const stats = itemStats[item];
            const profit = stats.sold - stats.purchased;
            const profitMargin = stats.sold > 0 ? (profit / stats.sold) * 100 : 0;
            const avgPurchaseRate = stats.purchaseQty > 0 ? stats.purchased / stats.purchaseQty : 0;
            const avgSaleRate = stats.soldQty > 0 ? stats.sold / stats.soldQty : 0;

            let reason = '';
            let priority = 0;
            let icon = '';

            // High margin items
            if (profitMargin > 15 && stats.sold > 5000) {
                reason = `High profit margin (${profitMargin.toFixed(0)}%) - Push more sales`;
                priority = 3;
                icon = '🔥';
            }
            // Low margin but high volume
            else if (profitMargin > 0 && profitMargin < 10 && stats.soldQty > 50) {
                reason = `High volume, low margin - Negotiate better rates`;
                priority = 2;
                icon = '💡';
            }
            // Items with good sale rate vs purchase rate
            else if (avgSaleRate > avgPurchaseRate * 1.2 && stats.soldQty > 20) {
                reason = `Good markup (₹${avgSaleRate.toFixed(0)} vs ₹${avgPurchaseRate.toFixed(0)}) - Increase stock`;
                priority = 2;
                icon = '📈';
            }
            // Purchased but not selling
            else if (stats.purchased > 10000 && stats.sold < stats.purchased * 0.5) {
                reason = `Low turnover - Focus on clearing stock`;
                priority = 1;
                icon = '⚠️';
            }

            if (reason) {
                recommendations.push({ item, reason, priority, icon, profitMargin, revenue: stats.sold });
            }
        });

        // Sort by priority
        recommendations.sort((a, b) => b.priority - a.priority || b.revenue - a.revenue);

        if (recommendations.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Not enough data for recommendations yet</p>';
            return;
        }

        container.innerHTML = recommendations.slice(0, 5).map((rec, idx) => `
            <div style="display: flex; align-items: flex-start; gap: 12px; padding: 12px; background: var(--bg-secondary); border-radius: 10px; margin-bottom: 10px; border-left: 4px solid ${rec.priority === 3 ? '#f59e0b' : rec.priority === 2 ? '#3b82f6' : '#6b7280'};">
                <div style="font-size: 24px;">${rec.icon}</div>
                <div style="flex: 1;">
                    <div style="font-weight: 600; font-size: 15px; color: var(--text-primary); margin-bottom: 4px;">${Helpers.escapeHtml(rec.item)}</div>
                    <div style="font-size: 13px; color: var(--text-secondary);">${Helpers.escapeHtml(rec.reason)}</div>
                </div>
            </div>
        `).join('');
    }

    /**
     * Render Top Performers
     */
    static renderTopPerformers() {
        const revenueContainer = document.getElementById('topByRevenue');
        const qtyContainer = document.getElementById('topByQuantity');
        if (!revenueContainer || !qtyContainer) return;

        const { monthStart } = this.getDateHelpers();

        const sales = [
            ...this.filterByDateRange(AppState.salesHistory, monthStart),
            ...this.filterByDateRange(AppState.retailSalesHistory, monthStart)
        ];

        // Aggregate by item
        const itemData = {};
        sales.forEach(s => {
            (s.items || []).forEach(item => {
                const name = item.item || item.name;
                if (!name) return;
                if (!itemData[name]) itemData[name] = { revenue: 0, quantity: 0 };
                itemData[name].revenue += Number(item.total) || 0;
                itemData[name].quantity += Number(item.qty || item.quantity) || 0;
            });
        });

        const items = Object.entries(itemData).map(([name, data]) => ({ name, ...data }));

        // Top by revenue
        const topRevenue = [...items].sort((a, b) => b.revenue - a.revenue).slice(0, 5);
        revenueContainer.innerHTML = topRevenue.length === 0 
            ? '<p style="color: var(--text-secondary); font-size: 13px;">No sales data</p>'
            : topRevenue.map((item, idx) => `
                <div style="display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--border-color);">
                    <div style="width: 22px; height: 22px; border-radius: 50%; background: ${idx === 0 ? '#fbbf24' : idx === 1 ? '#9ca3af' : idx === 2 ? '#cd7c32' : '#e5e7eb'}; color: ${idx < 3 ? 'white' : '#666'}; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600;">${idx + 1}</div>
                    <div style="flex: 1; font-size: 13px; color: var(--text-primary);">${Helpers.escapeHtml(item.name)}</div>
                    <div style="font-weight: 600; font-size: 13px; color: #16a34a;">${formatCurrency(item.revenue)}</div>
                </div>
            `).join('');

        // Top by quantity
        const topQty = [...items].sort((a, b) => b.quantity - a.quantity).slice(0, 5);
        qtyContainer.innerHTML = topQty.length === 0 
            ? '<p style="color: var(--text-secondary); font-size: 13px;">No sales data</p>'
            : topQty.map((item, idx) => `
                <div style="display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--border-color);">
                    <div style="width: 22px; height: 22px; border-radius: 50%; background: ${idx === 0 ? '#fbbf24' : idx === 1 ? '#9ca3af' : idx === 2 ? '#cd7c32' : '#e5e7eb'}; color: ${idx < 3 ? 'white' : '#666'}; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600;">${idx + 1}</div>
                    <div style="flex: 1; font-size: 13px; color: var(--text-primary);">${Helpers.escapeHtml(item.name)}</div>
                    <div style="font-weight: 600; font-size: 13px; color: #2563eb;">${item.quantity.toFixed(1)} kg</div>
                </div>
            `).join('');
    }

    /**
     * Render Customer Insights
     */
    static renderCustomerInsights() {
        const { monthStart } = this.getDateHelpers();

        const purchases = this.filterByDateRange(AppState.purchaseHistory, monthStart);
        const sales = [
            ...this.filterByDateRange(AppState.salesHistory, monthStart),
            ...this.filterByDateRange(AppState.retailSalesHistory, monthStart)
        ];

        // Get unique buyers and sellers
        const buyers = new Set();
        const sellers = new Set();
        const customerRevenue = {};

        sales.forEach(s => {
            const buyer = s.buyer || s.customer || 'Walk-in';
            if (buyer && buyer !== 'Walk-in') {
                buyers.add(buyer);
                customerRevenue[buyer] = (customerRevenue[buyer] || 0) + this.getTotal(s);
            }
        });

        purchases.forEach(p => {
            const seller = p.seller || p.vendor || 'Unknown';
            if (seller && seller !== 'Unknown') sellers.add(seller);
        });

        const totalCustomerRevenue = Object.values(customerRevenue).reduce((a, b) => a + b, 0);
        const avgPerCustomer = buyers.size > 0 ? totalCustomerRevenue / buyers.size : 0;

        this.updateElement('activeBuyers', buyers.size);
        this.updateElement('activeSellers', sellers.size);
        this.updateElement('avgPerCustomer', formatCurrency(avgPerCustomer));

        // Top customers
        const topCustomers = Object.entries(customerRevenue)
            .map(([name, revenue]) => ({ name, revenue }))
            .sort((a, b) => b.revenue - a.revenue)
            .slice(0, 5);

        const customersContainer = document.getElementById('topCustomers');
        if (customersContainer) {
            customersContainer.innerHTML = topCustomers.length === 0 
                ? '<p style="color: var(--text-secondary); font-size: 13px; text-align: center;">No customer data this month</p>'
                : `
                    <div style="font-size: 13px; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px;">Top Customers</div>
                    ${topCustomers.map((c, idx) => `
                        <div style="display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border-color);">
                            <div style="width: 24px; height: 24px; border-radius: 50%; background: #eff6ff; color: #2563eb; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600;">${idx + 1}</div>
                            <div style="flex: 1; font-size: 14px; color: var(--text-primary);">${Helpers.escapeHtml(c.name)}</div>
                            <div style="font-weight: 600; font-size: 14px; color: #16a34a;">${formatCurrency(c.revenue)}</div>
                        </div>
                    `).join('')}
                `;
        }
    }

    /**
     * Render Smart Suggestions
     */
    static renderSmartSuggestions() {
        const container = document.getElementById('smartSuggestions');
        if (!container) return;

        const { monthStart, daysRemaining, dayOfMonth } = this.getDateHelpers();
        const suggestions = [];

        // Get data
        const sales = [
            ...this.filterByDateRange(AppState.salesHistory, monthStart),
            ...this.filterByDateRange(AppState.retailSalesHistory, monthStart)
        ];
        const expenses = this.filterByDateRange(AppState.expensesHistory, monthStart)
            .filter(e => e.category !== 'personal');

        const totalRevenue = sales.reduce((sum, s) => sum + this.getTotal(s), 0);
        const totalExpenses = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
        const month = this.monthProfit();
        const profit = month.profit;

        // Outstanding analysis
        const purchaseDue = (AppState.purchaseHistory || [])
            .filter(p => (p.due || p.payment?.due) > 0)
            .reduce((sum, p) => sum + (p.due || p.payment?.due || 0), 0);
        const saleDue = [...(AppState.salesHistory || []), ...(AppState.retailSalesHistory || [])]
            .filter(s => (s.due || s.payment?.due) > 0)
            .reduce((sum, s) => sum + (s.due || s.payment?.due || 0), 0);

        // Generate suggestions
        if (saleDue > 50000) {
            suggestions.push({
                icon: '💳',
                text: `Collect ${formatCurrency(saleDue)} in pending dues from customers to improve cash flow`
            });
        }

        if (purchaseDue > saleDue * 1.5 && purchaseDue > 30000) {
            suggestions.push({
                icon: '⚠️',
                text: `You owe ${formatCurrency(purchaseDue)} to suppliers - prioritize clearing high-interest dues`
            });
        }

        if (profit !== null && profit < 0 && month.sales.count > 0) {
            suggestions.push({
                icon: '📉',
                text: `This month is in loss by ${formatCurrency(Math.abs(profit))} - Review expenses and margins`
            });
        } else if (profit > 0 && dayOfMonth > 15) {
            const projectedProfit = (profit / dayOfMonth) * 30;
            suggestions.push({
                icon: '📈',
                text: `On track for ${formatCurrency(projectedProfit)} profit this month - Keep it up!`
            });
        }

        if (totalExpenses > totalRevenue * 0.1) {
            suggestions.push({
                icon: '💡',
                text: `Expenses are ${((totalExpenses / totalRevenue) * 100).toFixed(0)}% of revenue - Look for cost savings`
            });
        }

        const avgDailySales = totalRevenue / dayOfMonth;
        if (avgDailySales < 10000 && dayOfMonth > 7) {
            suggestions.push({
                icon: '🎯',
                text: `Average daily sales: ${formatCurrency(avgDailySales)} - Consider promotions to boost sales`
            });
        }

        // Stock suggestions
        const lowStockItems = Object.entries(AppState.stock || {})
            .filter(([_, data]) => (data.quantity || 0) < 10)
            .map(([item]) => item);
        
        if (lowStockItems.length > 0) {
            suggestions.push({
                icon: '📦',
                text: `Low stock alert: ${lowStockItems.slice(0, 3).join(', ')}${lowStockItems.length > 3 ? ` +${lowStockItems.length - 3} more` : ''}`
            });
        }

        if (suggestions.length === 0) {
            suggestions.push({
                icon: '✨',
                text: 'Your business is running smoothly! Keep maintaining good practices.'
            });
        }

        container.innerHTML = suggestions.map(s => `
            <div style="display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.2);">
                <div style="font-size: 20px;">${s.icon}</div>
                <div style="font-size: 14px; line-height: 1.4;">${Helpers.escapeHtml(s.text)}</div>
            </div>
        `).join('');
    }

    /**
     * Render Outstanding Dues
     */
    static renderOutstandingDues() {
        // Purchase dues (you owe)
        const purchaseDues = (AppState.purchaseHistory || [])
            .filter(p => (p.due || p.payment?.due) > 0);
        const totalPayable = purchaseDues.reduce((sum, p) => sum + (p.due || p.payment?.due || 0), 0);

        // Sale dues (you'll receive)
        const saleDues = [...(AppState.salesHistory || []), ...(AppState.retailSalesHistory || [])]
            .filter(s => (s.due || s.payment?.due) > 0);
        const totalReceivable = saleDues.reduce((sum, s) => sum + (s.due || s.payment?.due || 0), 0);

        this.updateElement('totalPayable', formatCurrency(totalPayable));
        this.updateElement('payableCount', `${purchaseDues.length} bills`);
        this.updateElement('totalReceivable', formatCurrency(totalReceivable));
        this.updateElement('receivableCount', `${saleDues.length} bills`);
    }

    /**
     * Render Monthly Projection
     */
    static renderMonthlyProjection() {
        const { monthStart, daysInMonth, dayOfMonth, daysRemaining } = this.getDateHelpers();

        const sales = [
            ...this.filterByDateRange(AppState.salesHistory, monthStart),
            ...this.filterByDateRange(AppState.retailSalesHistory, monthStart)
        ];
        const purchases = this.filterByDateRange(AppState.purchaseHistory, monthStart);
        const expenses = this.filterByDateRange(AppState.expensesHistory, monthStart)
            .filter(e => e.category !== 'personal');

        const currentRevenue = sales.reduce((sum, s) => sum + this.getTotal(s), 0);
        const currentPurchases = purchases.reduce((sum, p) => sum + this.getTotal(p), 0);
        const currentExpenses = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);

        // Project based on daily average
        const dailyAvgRevenue = dayOfMonth > 0 ? currentRevenue / dayOfMonth : 0;
        const dailyAvgPurchases = dayOfMonth > 0 ? currentPurchases / dayOfMonth : 0;
        const dailyAvgExpenses = dayOfMonth > 0 ? currentExpenses / dayOfMonth : 0;

        const projectedRevenue = currentRevenue + (dailyAvgRevenue * daysRemaining);
        const monthProfit = this.monthProfit().profit;
        const projectedProfit = monthProfit === null ? null : monthProfit + (dayOfMonth > 0 ? (monthProfit / dayOfMonth) * daysRemaining : 0);

        // Cash required = remaining purchases + expenses - expected cash from sales
        const projectedCashRequired = Math.max(0, (dailyAvgPurchases * daysRemaining) + (dailyAvgExpenses * daysRemaining));

        this.updateElement('projectedRevenue', formatCurrency(projectedRevenue));
        this.updateElement('projectedProfit', projectedProfit === null ? '—' : formatCurrency(projectedProfit));
        this.updateElement('projectedCashRequired', formatCurrency(projectedCashRequired));
        this.updateElement('daysRemaining', daysRemaining);
    }

    /**
     * Helper to update element text
     */
    static updateElement(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }
}

// Legacy export for window.app.analytics
export const Analytics = AnalyticsManager;
