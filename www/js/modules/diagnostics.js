/**
 * @fileoverview Diagnostics Manager - UI for viewing telemetry and audit data
 * Owner-only access to view and manage application errors and audit logs
 * @module modules/diagnostics
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { TelemetryService } from '../services/telemetry.js';
import { AuditService } from '../services/audit.js';
import { Helpers } from '../utils/helpers.js';
import { formatDateTimeIN } from '../utils/dates.js';
import { getStartupTimings, startupRows } from '../utils/startup-timings.js';
import { getQuotaStatus } from '../firebase/firestore-meter.js';
import { t } from '../i18n/index.js';
import { runNumberChecks } from '../utils/number-checks.js';
import { isFullHistoryLoaded } from '../utils/history-window.js';
import { CashManagementManager } from './cash-management.js';

const isOwner = () => AppState.userRole === 'owner';
/** Number checks (#216) are for owners and managers; errors and audit logs stay owner-only. */
const canRunNumberChecks = () => AppState.userRole === 'owner' || AppState.userRole === 'manager';

/**
 * Diagnostics Manager - View and manage application telemetry and audit logs
 * @namespace DiagnosticsManager
 */
const DiagnosticsManager = {
    /**
     * Current telemetry data
     * @type {Array}
     */
    data: [],

    /**
     * Audit logs data
     * @type {Array}
     */
    auditLogs: [],

    /**
     * Current error filter
     * @type {string}
     */
    filter: 'all',

    /**
     * Current audit filter
     * @type {string}
     */
    auditFilter: '',

    /**
     * Current active tab
     * @type {string}
     */
    activeTab: 'errors',

    /**
     * Initialize diagnostics
     */
    async init() {
        if (!canRunNumberChecks()) {
            UIManager.showToast(t('msg.common.access_denied'), 'error');
            return;
        }
        if (!isOwner()) this.activeTab = 'numbers';
        await this.showTab(this.activeTab);
    },

    /**
     * Render the tab buttons
     */
    renderTabs() {
        this.renderSubtitle();
        const container = document.getElementById('diagnosticsTabsContainer');
        if (!container) return;

        const numbersBtn = `
                <button class="filter-btn ${this.activeTab === 'numbers' ? 'active' : ''}"
                        onclick="window.app.diagnostics.showTab('numbers')">
                    ${Helpers.escapeHtml(t('ui.numchecks.tab'))}
                </button>`;
        if (!isOwner()) {
            container.innerHTML = `<div class="filter-buttons" style="margin-bottom: 16px;">${numbersBtn}</div>`;
            return;
        }
        container.innerHTML = `
            <div class="filter-buttons" style="margin-bottom: 16px;">
                <button class="filter-btn ${this.activeTab === 'errors' ? 'active' : ''}" 
                        onclick="window.app.diagnostics.showTab('errors')">
                    🐛 Errors
                </button>
                <button class="filter-btn ${this.activeTab === 'audit' ? 'active' : ''}" 
                        onclick="window.app.diagnostics.showTab('audit')">
                    📋 Audit Logs
                </button>
                ${numbersBtn}
            </div>
            ${this.technicalDetailsHtml()}
        `;
    },

    /** Subtitle i18n key: managers see only Number checks (F24). */
    subtitleKey() {
        return isOwner() ? 'ui.diagnostics.subtitle_owner' : 'ui.diagnostics.subtitle_manager';
    },

    renderSubtitle() {
        const el = document.getElementById('diagnosticsSubtitle');
        if (el) el.textContent = t(this.subtitleKey());
    },

    /** Developer timings and read counts, folded away for the owner (F24). */
    technicalDetailsHtml() {
        return `
            <details class="diagnostics-technical" style="margin-bottom: 16px;">
                <summary><strong>${Helpers.escapeHtml(t('ui.diagnostics.technical_details'))}</strong></summary>
                <div style="margin-top: 8px;">
                    ${this.startupTimingsHtml()}
                    ${this.readStatsHtml()}
                </div>
            </details>
        `;
    },

    /** Last Number checks run (#216): { results, at } or null. */
    numberChecks: null,

    /**
     * Runs the accounting checks (docs/calculations.md AC1–AC8) on the data
     * already loaded on this device. Reads nothing from the server.
     */
    runNumberChecks() {
        if (!canRunNumberChecks()) return;
        const results = runNumberChecks({
            items: AppState.items || [],
            purchases: AppState.purchaseHistory || [],
            wholesaleSales: AppState.salesHistory || [],
            retailSales: AppState.retailSalesHistory || [],
            stockAdjustments: AppState.stockAdjustments || []
        }, {
            fullHistory: isFullHistoryLoaded(),
            session: CashManagementManager.todaySession || null,
            transactionsFor: (date, session) => CashManagementManager.calculateTransactionsForDate(date, session)
        });
        this.numberChecks = { results, at: Date.now() };
        this.renderNumberChecks();
    },

    /** One difference row: what it is about, expected, found, difference. */
    numberCheckRowHtml(row) {
        const e = (v) => Helpers.escapeHtml(String(v ?? ''));
        const r = row.ref || {};
        const kinds = { purchase: t('ui.numchecks.kind_purchase'), retail: t('ui.numchecks.kind_retail'), wholesale: t('ui.numchecks.kind_wholesale') };
        const label = r.item ? r.item
            : r.kind ? [kinds[r.kind] || r.kind, r.number, r.party, r.day].filter(Boolean).join(' · ')
                : r.day || '';
        const fmt = (v) => (row.unit === 'qty' ? Number(v).toLocaleString('en-IN') : `₹${Number(v).toLocaleString('en-IN')}`);
        return `<tr><td>${e(label)}</td><td style="text-align:right">${e(fmt(row.expected))}</td>` +
            `<td style="text-align:right">${e(fmt(row.actual))}</td><td style="text-align:right;color:#b91c1c">${e(fmt(row.diff))}</td></tr>`;
    },

    /** Number checks tab: pass/fail per check with the differences. */
    renderNumberChecks() {
        const container = document.getElementById('diagnosticsContainer');
        if (!container) return;
        const e = (v) => Helpers.escapeHtml(String(v ?? ''));
        const head = `
            <div class="diag-numchecks-intro" style="margin-bottom:12px;">
                <p style="margin:0 0 8px 0;color:var(--text-muted,#666);font-size:0.9rem;">${e(t('ui.numchecks.intro'))}</p>
                <button class="diag-btn refresh" onclick="window.app.diagnostics.runNumberChecks()">${e(t('ui.numchecks.run'))}</button>
            </div>`;
        if (!this.numberChecks) {
            container.innerHTML = `${head}<div class="diag-empty">${e(t('ui.numchecks.not_run'))}</div>`;
            return;
        }
        const cards = this.numberChecks.results.map(r => {
            const badge = r.status === 'pass' ? `<span style="color:#15803d;font-weight:600">${e(t('ui.numchecks.passed'))}</span>`
                : r.status === 'skip' ? `<span style="color:#6b7280;font-weight:600">${e(t('ui.numchecks.skipped'))}</span>`
                    : `<span style="color:#b91c1c;font-weight:600">${e(t('ui.numchecks.failed', { count: r.problems }))}</span>`;
            const note = r.note ? `<div style="font-size:0.8rem;color:#6b7280;margin-top:4px;">${e(t(r.note))}</div>` : '';
            const table = r.rows.length ? `
                <table style="width:100%;font-size:13px;margin-top:8px;border-collapse:collapse;">
                    <thead><tr><th style="text-align:left">${e(t('ui.numchecks.col_what'))}</th><th style="text-align:right">${e(t('ui.numchecks.col_expected'))}</th>
                    <th style="text-align:right">${e(t('ui.numchecks.col_found'))}</th><th style="text-align:right">${e(t('ui.numchecks.col_difference'))}</th></tr></thead>
                    <tbody>${r.rows.map(row => this.numberCheckRowHtml(row)).join('')}</tbody>
                </table>
                ${r.problems > r.rows.length ? `<div style="font-size:0.8rem;color:#6b7280;margin-top:4px;">${e(t('ui.numchecks.more', { count: r.problems - r.rows.length }))}</div>` : ''}` : '';
            return `
                <div class="diag-error-card diag-numcheck" data-check="${e(r.id)}" data-status="${e(r.status)}">
                    <div class="diag-error-header"><span class="diag-error-type">${e(r.id)}</span>
                        <span class="diag-error-message" style="margin:0">${e(t(r.key))}</span></div>
                    <div>${badge} <span style="font-size:0.8rem;color:#6b7280">${e(t('ui.numchecks.checked', { count: r.checked }))}</span></div>
                    ${note}${table}
                </div>`;
        }).join('');
        container.innerHTML = `${head}<div class="diagnostics-list">${cards}</div>
            <p style="font-size:0.8rem;color:#6b7280;margin-top:12px;">${e(t('ui.numchecks.footer'))}</p>`;
    },

    /**
     * "Data reads" block (#194): estimated Firestore document reads since the
     * app opened, top 5 sources, and daily-limit errors seen this session.
     * @returns {string}
     */
    readStatsHtml() {
        const s = getQuotaStatus();
        const rows = s.top.map(t => `<tr><td>${Helpers.escapeHtml(t.source)}</td><td style="text-align:right">${Helpers.escapeHtml(String(t.reads))}</td></tr>`).join('');
        const quota = s.quota.count
            ? `<div style="color:#b45309;margin-top:6px;">⚠️ Daily free limit reached: ${s.quota.count} error(s), first ${Helpers.escapeHtml(formatDateTimeIN(new Date(s.quota.firstAt)))} (${Helpers.escapeHtml(s.quota.lastSource)})</div>`
            : '';
        return `
            <details class="diagnostics-reads" style="margin-bottom: 16px;">
                <summary><strong>📊 Data reads this session</strong> ≈ ${Helpers.escapeHtml(String(s.reads))}${s.heavy ? ' ⚠️' : ''}</summary>
                <div style="font-size:12px;color:#6b7280;margin-top:6px;">Since app open ${Helpers.escapeHtml(formatDateTimeIN(new Date(s.since)))}. Estimate; free limit is 50,000 reads/day shared by everyone.</div>
                ${rows ? `<table style="width:100%;font-size:13px;margin-top:8px;border-collapse:collapse;"><thead><tr><th style="text-align:left">Top sources</th><th style="text-align:right">Reads</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
                ${quota}
            </details>
        `;
    },

    /**
     * "Startup timings" block: ms since page start for each app-open step (#13).
     * @returns {string}
     */
    startupTimingsHtml() {
        const { marks, info } = getStartupTimings();
        if (!marks.length) return '';
        const rows = startupRows(marks).map((r, i) => {
            const detail = marks[i].detail ? JSON.stringify(marks[i].detail) : '';
            return `<tr><td>${Helpers.escapeHtml(r.name)}</td><td style="text-align:right">${Helpers.escapeHtml(r.at)}</td>` +
                `<td style="text-align:right">+${Helpers.escapeHtml(r.delta)}</td><td style="font-size:11px;color:#6b7280">${Helpers.escapeHtml(detail)}</td></tr>`;
        }).join('');
        const listeners = Object.entries(info.listeners || {}).map(([label, l]) =>
            `${label}: ${l.first} (${l.docs} docs) → ${l.readyBy || '?'}`).join('; ');
        return `
            <details class="diagnostics-startup" style="margin-bottom: 16px;">
                <summary><strong>⏱ Startup timings</strong> (ms since page start)</summary>
                <table style="width:100%;font-size:13px;margin-top:8px;border-collapse:collapse;">
                    <thead><tr><th style="text-align:left">Step</th><th style="text-align:right">At</th><th style="text-align:right">Step time</th><th style="text-align:left">Details</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
                ${listeners ? `<div style="font-size:11px;color:#6b7280;margin-top:6px;">Listeners: ${Helpers.escapeHtml(listeners)}</div>` : ''}
            </details>
        `;
    },

    /**
     * Switch tab
     * @param {string} tab - Tab name ('errors' or 'audit')
     */
    async showTab(tab) {
        this.activeTab = !isOwner() ? 'numbers' : tab;
        this.renderTabs();

        if (this.activeTab === 'numbers') {
            this.renderNumberChecks();
        } else if (tab === 'errors') {
            await this.loadData();
        } else {
            await this.loadAuditLogs();
        }
    },

    /**
     * Load telemetry data
     */
    async loadData() {
        try {
            UIManager.showLoading();
            this.data = await TelemetryService.getTelemetryData();
            this.renderErrors();
        } catch (error) {
            UIManager.showToast(t('msg.diagnostics.failed_load_diagnostics_data'), 'error');
        } finally {
            UIManager.hideLoading();
        }
    },

    /**
     * Render the errors tab content
     */
    renderErrors() {
        const container = document.getElementById('diagnosticsContainer');
        if (!container) return;

        const filteredData = this.filter === 'all' 
            ? this.data 
            : this.data.filter(d => d.type === this.filter);

        // Group by type for stats
        const stats = {
            total: this.data.length,
            totalOccurrences: this.data.reduce((sum, d) => sum + (d.count || 1), 0),
            byType: {}
        };
        this.data.forEach(d => {
            stats.byType[d.type] = (stats.byType[d.type] || 0) + 1;
        });

        container.innerHTML = `
            <!-- Stats Cards -->
            <div class="diagnostics-stats">
                <div class="diag-stat-card">
                    <div class="diag-stat-value">${Helpers.escapeHtml(stats.total)}</div>
                    <div class="diag-stat-label">Unique Errors</div>
                </div>
                <div class="diag-stat-card">
                    <div class="diag-stat-value">${Helpers.escapeHtml(stats.totalOccurrences)}</div>
                    <div class="diag-stat-label">Total Occurrences</div>
                </div>
                <div class="diag-stat-card">
                    <div class="diag-stat-value">${Helpers.escapeHtml(stats.byType['uncaught'] || 0)}</div>
                    <div class="diag-stat-label">Uncaught Errors</div>
                </div>
                <div class="diag-stat-card">
                    <div class="diag-stat-value">${stats.byType['console.error'] || 0}</div>
                    <div class="diag-stat-label">Console Errors</div>
                </div>
            </div>

            <!-- Controls -->
            <div class="diagnostics-controls">
                <select id="diagTypeFilter" onchange="window.app.diagnostics.filterByType(this.value)">
                    <option value="all" ${this.filter === 'all' ? 'selected' : ''}>All Types</option>
                    <option value="uncaught" ${this.filter === 'uncaught' ? 'selected' : ''}>Uncaught Errors</option>
                    <option value="unhandledrejection" ${this.filter === 'unhandledrejection' ? 'selected' : ''}>Promise Rejections</option>
                    <option value="console.error" ${this.filter === 'console.error' ? 'selected' : ''}>Console Errors</option>
                    <option value="warning" ${this.filter === 'warning' ? 'selected' : ''}>Warnings</option>
                    <option value="manual" ${this.filter === 'manual' ? 'selected' : ''}>Manual Logs</option>
                </select>
                <button onclick="window.app.diagnostics.loadData()" class="diag-btn refresh">🔄</button>
                <button onclick="window.app.diagnostics.clearAll()" class="diag-btn danger">🗑️</button>
            </div>

            <!-- Error List -->
            <div class="diagnostics-list">
                ${filteredData.length === 0 ? `
                    <div class="diag-empty">
                        <span class="diag-empty-icon">✅</span>
                        <p>No errors found</p>
                    </div>
                ` : filteredData.map(error => this.renderErrorCard(error)).join('')}
            </div>
        `;
    },

    /**
     * Render a single error card
     * @param {Object} error - Error data
     * @returns {string} HTML string
     */
    renderErrorCard(error) {
        const typeColors = {
            'uncaught': '#ef4444',
            'unhandledrejection': '#f97316',
            'console.error': '#eab308',
            'warning': '#3b82f6',
            'manual': '#8b5cf6'
        };

        const typeLabels = {
            'uncaught': '🔴 Uncaught',
            'unhandledrejection': '🟠 Promise',
            'console.error': '🟡 Console',
            'warning': '🔵 Warning',
            'manual': '🟣 Manual'
        };

        const lastSeen = formatDateTimeIN(error.lastSeen);
        const firstSeen = error.firstSeen ? formatDateTimeIN(error.firstSeen, undefined, lastSeen) : lastSeen;

        return `
            <div class="diag-error-card" style="border-left: 4px solid ${typeColors[error.type] || '#666'};">
                <div class="diag-error-header">
                    <span class="diag-error-type">${typeLabels[error.type] || Helpers.escapeHtml(error.type)}</span>
                    <span class="diag-error-count">${Helpers.escapeHtml(error.count || 1)}x</span>
                    <button onclick="window.app.diagnostics.deleteError('${Helpers.escapeJsAttr(error.id)}')" class="diag-delete-btn">×</button>
                </div>
                <div class="diag-error-message">${this.escapeHtml(error.message || 'No message')}</div>
                ${error.source ? `<div class="diag-error-source">📍 ${Helpers.escapeHtml(error.source)}:${Helpers.escapeHtml(error.line || '?')}</div>` : ''}
                <div class="diag-error-meta">
                    <span>First: ${firstSeen}</span>
                    <span>Last: ${lastSeen}</span>
                </div>
                ${error.stack ? `
                    <details class="diag-error-stack">
                        <summary>Stack Trace</summary>
                        <pre>${this.escapeHtml(error.stack)}</pre>
                    </details>
                ` : ''}
                ${error.occurrences && error.occurrences.length > 0 ? `
                    <details class="diag-error-occurrences">
                        <summary>Recent Occurrences (${error.occurrences.length})</summary>
                        <ul>
                            ${error.occurrences.slice(-5).map(o => `
                                <li>${formatDateTimeIN(o.timestamp)} - ${Helpers.escapeHtml(o.userName || 'Unknown')}</li>
                            `).join('')}
                        </ul>
                    </details>
                ` : ''}
            </div>
        `;
    },

    /**
     * Load audit logs
     */
    async loadAuditLogs() {
        if (AppState.userRole !== 'owner') {
            UIManager.showToast(t('msg.common.only_owners_can_view_audit'));
            return;
        }
        
        UIManager.showLoading();
        try {
            this.auditLogs = await AuditService.getRecentLogs(100);
            this.renderAuditLogs();
        } catch (error) {
            console.error('Error loading audit logs:', error);
            UIManager.showToast(t('msg.common.failed_load_audit_logs'));
        } finally {
            UIManager.hideLoading();
        }
    },

    /**
     * Render the audit logs tab content
     */
    renderAuditLogs() {
        const container = document.getElementById('diagnosticsContainer');
        if (!container) return;

        let filteredLogs = this.auditLogs;
        if (this.auditFilter) {
            filteredLogs = this.auditLogs.filter(log => log.action === this.auditFilter);
        }

        container.innerHTML = `
            <!-- Controls -->
            <div class="diagnostics-controls">
                <select id="auditFilterAction" onchange="window.app.diagnostics.filterAuditLogs(this.value)">
                    <option value="" ${this.auditFilter === '' ? 'selected' : ''}>All Actions</option>
                    <option value="CREATE_BILL" ${this.auditFilter === 'CREATE_BILL' ? 'selected' : ''}>Create Bill</option>
                    <option value="DELETE_BILL" ${this.auditFilter === 'DELETE_BILL' ? 'selected' : ''}>Delete Bill</option>
                    <option value="CREATE_SALE" ${this.auditFilter === 'CREATE_SALE' ? 'selected' : ''}>Create Sale</option>
                    <option value="DELETE_SALE" ${this.auditFilter === 'DELETE_SALE' ? 'selected' : ''}>Delete Sale</option>
                    <option value="DELETE_ITEM" ${this.auditFilter === 'DELETE_ITEM' ? 'selected' : ''}>Delete Item</option>
                    <option value="UPDATE_PAYMENT" ${this.auditFilter === 'UPDATE_PAYMENT' ? 'selected' : ''}>Update Payment</option>
                    <option value="CLEAR_DATA" ${this.auditFilter === 'CLEAR_DATA' ? 'selected' : ''}>Clear Data</option>
                </select>
                <button onclick="window.app.diagnostics.loadAuditLogs()" class="diag-btn refresh">🔄</button>
            </div>

            <!-- Audit List -->
            <div class="diagnostics-list">
                ${filteredLogs.length === 0 ? `
                    <div class="diag-empty">
                        <span class="diag-empty-icon">📋</span>
                        <p>No audit logs found</p>
                    </div>
                ` : filteredLogs.map(log => this.renderAuditCard(log)).join('')}
            </div>
        `;
    },

    /**
     * Render a single audit log card
     * @param {Object} log - Audit log data
     * @returns {string} HTML string
     */
    renderAuditCard(log) {
        const formattedDate = formatDateTimeIN(log.timestamp, {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        const actionIcon = this.getActionIcon(log.action);
        const actionColor = this.getActionColor(log.action);
        const details = this.formatDetails(log.details);

        return `
            <div class="diag-audit-card" style="border-left: 4px solid ${actionColor};">
                <div class="diag-audit-header">
                    <span class="diag-audit-icon">${actionIcon}</span>
                    <span class="diag-audit-action" style="color: ${actionColor};">${Helpers.escapeHtml(log.action.replace(/_/g, ' '))}</span>
                    <span class="diag-audit-time">${formattedDate}</span>
                </div>
                <div class="diag-audit-user">
                    <strong>${Helpers.escapeHtml(log.userName)}</strong> (${Helpers.escapeHtml(Helpers.roleLabel(log.userRole))})
                </div>
                ${details ? `<div class="diag-audit-details">${Helpers.escapeHtml(details)}</div>` : ''}
            </div>
        `;
    },

    /**
     * Get action icon
     * @param {string} action - Action type
     * @returns {string} Emoji icon
     */
    getActionIcon(action) {
        const icons = {
            'CREATE_BILL': '📥',
            'DELETE_BILL': '🗑️',
            'CREATE_SALE': '📤',
            'DELETE_SALE': '🗑️',
            'DELETE_ITEM': '🗑️',
            'UPDATE_PAYMENT': '💰',
            'RECORD_PAYMENT': '💰',
            'CLEAR_DATA': '⚠️',
            'LOGIN': '🔑',
            'LOGOUT': '🚪'
        };
        return icons[action] || '📋';
    },

    /**
     * Get action color
     * @param {string} action - Action type
     * @returns {string} Color code
     */
    getActionColor(action) {
        if (action.includes('DELETE') || action === 'CLEAR_DATA') return '#e74c3c';
        if (action.includes('CREATE')) return '#27ae60';
        if (action.includes('PAYMENT')) return '#3498db';
        return '#666';
    },

    /**
     * Format audit log details
     * @param {Object} details - Details object
     * @returns {string} Formatted string
     */
    formatDetails(details) {
        if (!details || typeof details !== 'object') return '';
        
        const parts = [];
        if (details.billNumber) parts.push(`Bill: ${details.billNumber}`);
        if (details.amount) parts.push(`Amount: ₹${details.amount}`);
        if (details.customer) parts.push(`Customer: ${details.customer}`);
        if (details.itemName) parts.push(`Item: ${details.itemName}`);
        if (details.paymentAmount) parts.push(`Payment: ₹${details.paymentAmount}`);
        if (details.collections) parts.push(`Collections: ${details.collections.join(', ')}`);
        if (details.recordsDeleted) parts.push(`Records: ${details.recordsDeleted}`);
        
        return parts.join(' • ');
    },

    /**
     * Filter audit logs
     * @param {string} action - Action to filter by
     */
    filterAuditLogs(action) {
        this.auditFilter = action;
        this.renderAuditLogs();
    },

    /**
     * Escape HTML to prevent XSS
     * @param {string} str - String to escape
     * @returns {string} Escaped string
     */
    escapeHtml(str) {
        if (!str) return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    },

    /**
     * Filter by type
     * @param {string} type - Error type
     */
    filterByType(type) {
        this.filter = type;
        this.renderErrors();
    },

    /**
     * Delete a specific error
     * @param {string} errorId - Error ID
     */
    async deleteError(errorId) {
        const confirmed = await UIManager.showModal(t('msg.diagnostics.delete_error'), t('msg.common.confirm_delete'), true);
        if (!confirmed) return;

        try {
            const entry = this.data.find(d => d.id === errorId);
            await TelemetryService.deleteError(errorId, entry?.docIds);
            this.data = this.data.filter(d => d.id !== errorId);
            this.renderErrors();
            UIManager.showToast(t('msg.diagnostics.error_deleted'));
        } catch (error) {
            UIManager.showToast(t('msg.diagnostics.failed_delete_error'), 'error');
        }
    },

    /**
     * Clear all errors
     */
    async clearAll() {
        const confirmed = await UIManager.showModal(
            t('msg.diagnostics.will_delete_all_telemetry_data'),
            t('msg.diagnostics.clear_all_diagnostics'),
            true
        );
        if (!confirmed) return;

        try {
            UIManager.showLoading();
            await TelemetryService.clearTelemetryData();
            this.data = [];
            this.renderErrors();
            UIManager.showToast(t('msg.diagnostics.all_diagnostics_cleared'));
        } catch (error) {
            UIManager.showToast(t('msg.diagnostics.failed_clear_diagnostics'), 'error');
        } finally {
            UIManager.hideLoading();
        }
    }
};

export { DiagnosticsManager };
