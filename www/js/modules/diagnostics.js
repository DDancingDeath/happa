/**
 * @fileoverview Diagnostics Manager - UI for viewing telemetry and audit data
 * Owner-only access to view and manage application errors and audit logs
 * @module modules/diagnostics
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { TelemetryService } from '../services/telemetry.js';
import { CrashReports } from '../services/crash-reports.js';
import { AuditService } from '../services/audit.js';
import { Helpers } from '../utils/helpers.js';
import { formatDateTimeIN } from '../utils/dates.js';
import { getStartupTimings, startupRows } from '../utils/startup-timings.js';
import { getQuotaStatus, getIoCounts } from '../firebase/firestore-meter.js';
import { SyncStatus } from '../ui/sync-status.js';
import { PrinterService } from '../services/printer.js';
import { tip, tipDeviceId } from '../tip/index.js';
import { APP_VERSION } from '../version.js';
import { runProbes, analyseProbes } from '../utils/perf-probe.js';
import { statusRows, statusText, speedLines } from '../utils/status-report.js';
import { track } from '../services/usage.js';
import { t, getLang } from '../i18n/index.js';
import { auditActionLabel } from '../i18n/localize.js';
import { formatAuditDetails, auditWho, auditWhoText, peopleById } from '../utils/audit-changes.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { Exporter } from '../services/exporter.js';
import { stampedCsv, stampLine, exportFilename } from '../utils/export-stamp.js';
import { isoMinute } from '../utils/statements.js';
import { toLocalISODate } from '../utils/dates.js';
import { buildErrorReport, errorReportPeriod } from '../utils/error-report.js';
import { readTeamDirectory } from '../firebase/repos/users.js';
import { teamPeople } from '../utils/team-directory.js';

const tx = (key, params) => Helpers.escapeHtml(t(key, params));
import { runNumberChecks } from '../utils/number-checks.js';
import { isFullHistoryLoaded } from '../utils/history-window.js';
import { CashManagementManager } from './cash-management.js';
import { formatKg } from '../utils/money.js';
import { icon } from '../ui/icons.js';
import { moneyHtml, emptyState } from '../ui/components.js';

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
    auditPeople: new Map(),

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

        const sel = (id) => String(this.activeTab === id);
        const numbersBtn = `<button type="button" role="tab" aria-selected="${sel('numbers')}" data-onclick="diagnostics.showTab('numbers')">${tx('ui.numchecks.tab')}</button>`;
        if (!isOwner()) {
            container.innerHTML = `<div class="tabs diag-tabs" role="tablist">${numbersBtn}</div>`;
            return;
        }
        container.innerHTML = `
            <div class="tabs diag-tabs" role="tablist">
                <button type="button" role="tab" aria-selected="${sel('errors')}" data-onclick="diagnostics.showTab('errors')">${tx('ui.diag.tab_errors')}</button>
                <button type="button" role="tab" aria-selected="${sel('audit')}" data-onclick="diagnostics.showTab('audit')">${tx('ui.admin.col_audit_logs')}</button>
                <button type="button" role="tab" aria-selected="${sel('status')}" data-onclick="diagnostics.showTab('status')">${tx('ui.status.tab')}</button>
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
            <details class="panel panel-pad diag-block diagnostics-technical">
                <summary><strong>${Helpers.escapeHtml(t('ui.diagnostics.technical_details'))}</strong></summary>
                <div class="diag-technical-body">
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
        const results = this.numberCheckResults();
        this.numberChecks = { results, at: Date.now() };
        this.renderNumberChecks();
    },

    /** The accounting checks on this phone's loaded data (also TIP NumberChecks, #161). */
    numberCheckResults() {
        return runNumberChecks({
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
    },

    /** One difference row: what it is about, expected, found, difference. */
    numberCheckRowHtml(row) {
        const e = (v) => Helpers.escapeHtml(String(v ?? ''));
        const r = row.ref || {};
        const kinds = { purchase: t('ui.numchecks.kind_purchase'), retail: t('ui.numchecks.kind_retail'), wholesale: t('ui.numchecks.kind_wholesale') };
        const label = r.item ? r.item
            : r.kind ? [kinds[r.kind] || r.kind, r.number, r.party, r.day].filter(Boolean).join(' · ')
                : r.day || '';
        const fmt = (v) => (row.unit === 'qty' ? e(formatKg(v)) : moneyHtml(v, { exact: true }));
        return `<tr><td>${e(label)}</td><td class="num">${fmt(row.expected)}</td>` +
            `<td class="num">${fmt(row.actual)}</td><td class="num tone-neg">${fmt(row.diff)}</td></tr>`;
    },

    /** Number checks tab: pass/fail per check with the differences. */
    renderNumberChecks() {
        const container = document.getElementById('diagnosticsContainer');
        if (!container) return;
        const e = (v) => Helpers.escapeHtml(String(v ?? ''));
        const head = `
            <div class="diag-numchecks-intro">
                <p class="diag-hint">${e(t('ui.numchecks.intro'))}</p>
                <button type="button" class="btn btn-primary" data-onclick="diagnostics.runNumberChecks()">${icon('clipCheck', 'i-sm')} ${e(t('ui.numchecks.run'))}</button>
            </div>`;
        if (!this.numberChecks) {
            container.innerHTML = `${head}${emptyState({ icon: 'clipCheck', title: t('ui.numchecks.not_run') })}`;
            return;
        }
        const cards = this.numberChecks.results.map(r => {
            const badge = r.status === 'pass' ? `<span class="tag pos">${e(t('ui.numchecks.passed'))}</span>`
                : r.status === 'skip' ? `<span class="tag">${e(t('ui.numchecks.skipped'))}</span>`
                    : `<span class="tag neg">${e(t('ui.numchecks.failed', { count: r.problems }))}</span>`;
            const note = r.note ? `<div class="diag-hint">${e(t(r.note))}</div>` : '';
            const table = r.rows.length ? `
                <div class="diag-table-wrap"><table class="table">
                    <thead><tr><th>${e(t('ui.numchecks.col_what'))}</th><th class="num">${e(t('ui.numchecks.col_expected'))}</th>
                    <th class="num">${e(t('ui.numchecks.col_found'))}</th><th class="num">${e(t('ui.numchecks.col_difference'))}</th></tr></thead>
                    <tbody>${r.rows.map(row => this.numberCheckRowHtml(row)).join('')}</tbody>
                </table></div>
                ${r.problems > r.rows.length ? `<div class="diag-hint">${e(t('ui.numchecks.more', { count: r.problems - r.rows.length }))}</div>` : ''}` : '';
            return `
                <div class="panel panel-pad diag-card diag-error-card diag-numcheck" data-check="${e(r.id)}" data-status="${e(r.status)}">
                    <div class="diag-card-head"><span class="tag diag-error-type">${e(r.id)}</span>
                        <span class="diag-error-message">${e(t(r.key))}</span></div>
                    <div class="diag-card-meta">${badge} <span class="diag-hint">${e(t('ui.numchecks.checked', { count: r.checked }))}</span></div>
                    ${note}${table}
                </div>`;
        }).join('');
        container.innerHTML = `${head}<div class="diagnostics-list">${cards}</div>
            <p class="diag-hint">${e(t('ui.numchecks.footer'))}</p>`;
    },

    /**
     * "Data reads" block (#194): estimated Firestore document reads since the
     * app opened, top 5 sources, and daily-limit errors seen this session.
     * @returns {string}
     */
    readStatsHtml() {
        const s = getQuotaStatus();
        const rows = s.top.map(t => `<tr><td>${Helpers.escapeHtml(t.source)}</td><td class="num">${Helpers.escapeHtml(String(t.reads))}</td></tr>`).join('');
        const quota = s.quota.count
            ? `<p class="notice warn">${icon('alert', 'i-sm')}<span class="grow">${tx('ui.diag.quota_hit', { count: s.quota.count, at: formatDateTimeIN(new Date(s.quota.firstAt)), source: s.quota.lastSource })}</span></p>`
            : '';
        return `
            <details class="diag-block diagnostics-reads">
                <summary><strong>${tx('ui.diag.reads_title')}</strong> ≈ ${Helpers.escapeHtml(String(s.reads))}${s.heavy ? ` <span class="tone-warn">${icon('alert', 'i-sm')}</span>` : ''}</summary>
                <p class="diag-hint">${tx('ui.diag.reads_note', { at: formatDateTimeIN(new Date(s.since)) })}</p>
                ${rows ? `<div class="diag-table-wrap"><table class="table"><thead><tr><th>${tx('ui.diag.top_sources')}</th><th class="num">${tx('ui.diag.reads')}</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
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
            return `<tr><td>${Helpers.escapeHtml(r.name)}</td><td class="num">${Helpers.escapeHtml(r.at)}</td>` +
                `<td class="num">+${Helpers.escapeHtml(r.delta)}</td><td class="diag-code">${Helpers.escapeHtml(detail)}</td></tr>`;
        }).join('');
        const listeners = Object.entries(info.listeners || {}).map(([label, l]) =>
            `${label}: ${l.first} (${l.docs} docs) → ${l.readyBy || '?'}`).join('; ');
        return `
            <details class="diag-block diagnostics-startup">
                <summary><strong>${tx('ui.diag.startup_title')}</strong> ${tx('ui.diag.startup_hint')}</summary>
                <div class="diag-table-wrap"><table class="table">
                    <thead><tr><th>${tx('ui.diag.col_step')}</th><th class="num">${tx('ui.diag.col_at')}</th><th class="num">${tx('ui.diag.col_step_time')}</th><th>${tx('ui.diag.col_details')}</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table></div>
                ${listeners ? `<p class="diag-hint diag-code">${tx('ui.diag.listeners', { list: listeners })}</p>` : ''}
            </details>
        `;
    },

    /** Last speed check on this page (#83): { score, suspects, at } or null. */
    speed: null,

    /** This phone's state for the Status tab (#119): codes, counts, states and times only. */
    phoneStatus() {
        const io = getIoCounts();
        const q = getQuotaStatus();
        const conn = typeof navigator !== 'undefined' ? (navigator.connection || null) : null;
        return {
            appVersion: APP_VERSION,
            buildId: (typeof window !== 'undefined' && window.__AADHAT_BUILD__) || tip.getVersion().buildId,
            deviceId: tipDeviceId(AppState.currentUser?.uid),
            online: SyncStatus.isOnline(),
            connection: conn?.effectiveType || null,
            pending: SyncStatus.pendingCount(),
            lastSyncAt: Math.max(SyncStatus.lastSyncAt() || 0, io.lastWriteAckAt || 0) || null,
            printer: PrinterService.linkState(),
            reads: q.reads,
            writes: io.writes,
            writeErrors: io.writeErrors,
            readErrors: io.readErrors,
            errors: TelemetryService.sessionErrors,
            openedAt: q.since
        };
    },

    renderStatus() {
        const container = document.getElementById('diagnosticsContainer');
        if (!container || !isOwner()) return;
        const e = (v) => Helpers.escapeHtml(String(v ?? ''));
        const rows = statusRows(this.phoneStatus()).map(r => `
            <tr data-status-row="${e(r.key)}"><td>${e(r.label)}</td>
                <td class="num"${r.code ? ' lang="zxx" translate="no"' : ''}>${e(r.value)}</td></tr>`).join('');
        const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
        let speed = '';
        if (this.speed) {
            const [score, ...rest] = speedLines(this.speed);
            speed = `<div class="panel panel-pad diag-card diag-speed" data-score="${e(this.speed.score)}">
                <strong>${e(score)}</strong>
                <ul class="diag-list">${rest.map(l => `<li>${e(l.replace(/^- /, ''))}</li>`).join('')}</ul>
            </div>`;
        }
        container.innerHTML = `
            <p class="diag-hint">${tx('ui.status.intro')}</p>
            <div class="panel diag-table-wrap"><table class="table diag-status-table">
                <tbody>${rows}</tbody>
            </table></div>
            <div class="diag-controls">
                <button type="button" class="btn btn-primary" data-onclick="diagnostics.runSpeedCheck()">${tx('ui.speed.run')}</button>
                <button type="button" class="btn" data-onclick="diagnostics.copyStatus()">${tx('ui.status.copy')}</button>
                ${canShare ? `<button type="button" class="btn" data-onclick="diagnostics.shareStatus()">${tx('ui.status.share')}</button>` : ''}
            </div>
            ${speed}
            <p class="diag-hint">${tx('ui.status.copy_note')}</p>
            ${this.errorTestHtml()}`;
    },

    /** Owner-only test of error reports (#122): the web error path, and Crashlytics in the Android app. */
    errorTestHtml() {
        const reach = CrashReports.testReach();
        const note = {
            web: 'ui.diag.test_crash_web',
            'not-set-up': 'ui.diag.test_crash_not_set_up',
            off: 'ui.diag.test_crash_off',
            on: 'ui.diag.test_crash_on'
        }[reach];
        const crashBtn = reach === 'on'
            ? `<button type="button" class="btn btn-danger" data-errtest="crash" data-onclick="diagnostics.sendTestCrash()">${tx('ui.diag.test_send_crash')}</button>`
            : '';
        return `
            <div class="panel panel-pad diag-card diag-errtest" data-crash-reach="${Helpers.escapeHtml(reach)}">
                <h3>${tx('ui.diag.test_title')}</h3>
                <p class="diag-hint">${tx('ui.diag.test_intro')}</p>
                <div class="diag-controls">
                    <button type="button" class="btn btn-tonal" data-errtest="error" data-onclick="diagnostics.sendTestError()">${tx('ui.diag.test_send_error')}</button>
                    ${crashBtn}
                </div>
                <p class="diag-hint" data-errtest-note>${tx(note)}</p>
                <p class="diag-hint" data-errtest-result role="status" aria-live="polite"></p>
            </div>`;
    },

    async sendTestError() {
        if (!isOwner()) return;
        const btn = document.querySelector('[data-errtest="error"]');
        if (btn?.disabled) return;
        if (btn) btn.disabled = true;
        const lines = [];
        try {
            const web = await TelemetryService.sendTestError();
            lines.push(t({ sent: 'msg.diag.test_sent', queued: 'msg.diag.test_queued' }[web] || 'msg.diag.test_failed'));
        } catch (err) {
            console.warn('Test error not recorded:', err?.message || err);
            lines.push(t('msg.diag.test_failed'));
        }
        if (CrashReports.testReach() === 'on') {
            const recorded = await CrashReports.sendTestException();
            lines.push(t(recorded ? 'msg.diag.test_crashlytics_recorded' : 'msg.diag.test_crashlytics_failed'));
        }
        if (btn) btn.disabled = false;
        const out = document.querySelector('[data-errtest-result]');
        if (out) out.textContent = lines.join(' ');
        return lines;
    },

    /** Closes the app on purpose, after a confirm; only while crash reports are on. */
    async sendTestCrash() {
        if (!isOwner()) return false;
        if (CrashReports.testReach() !== 'on') {
            if (this.activeTab === 'status') this.renderStatus();
            return false;
        }
        const ok = await UIManager.showModal(t('msg.diag.test_crash_confirm'), t('ui.diag.test_crash_confirm_title'), true);
        if (!ok) return false;
        return CrashReports.sendTestCrash();
    },

    /** Speed check (#83): local probes only, no reads. */
    async runSpeedCheck() {
        if (!isOwner()) return;
        try {
            const probes = await runProbes(AppState);
            this.speed = { ...analyseProbes(probes), at: Date.now() };
            track('perf.diagnostic_run');
        } catch (err) {
            console.warn('Speed check failed:', err?.message || err);
            this.speed = null;
            UIManager.showToast(t('msg.speed.failed'), 'error');
        }
        if (this.activeTab === 'status') this.renderStatus();
    },

    statusText() {
        return statusText(this.phoneStatus(), this.speed);
    },

    async copyStatus() {
        const text = this.statusText();
        try {
            await navigator.clipboard.writeText(text);
            UIManager.showToast(t('msg.status.copied'), 'success');
        } catch (_) {
            // No clipboard: show the text with its line breaks so it can be selected.
            const msg = document.getElementById('modalMessage');
            const closed = UIManager.showModal(text, t('ui.status.copy'));
            msg?.classList.add('diag-pre-line');
            Promise.resolve(closed).finally(() => msg?.classList.remove('diag-pre-line'));
        }
    },

    async shareStatus() {
        const text = this.statusText();
        try {
            await navigator.share({ text });
        } catch (err) {
            if (err?.name !== 'AbortError') await this.copyStatus();
        }
    },

    /**
     * Switch tab
     * @param {string} tab - Tab name ('errors', 'audit', 'status' or 'numbers')
     */
    async showTab(tab) {
        this.activeTab = !isOwner() ? 'numbers' : tab;
        this.renderTabs();

        if (this.activeTab === 'numbers') {
            this.renderNumberChecks();
        } else if (tab === 'status') {
            this.renderStatus();
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
            // Another tab may have been opened while the reports were read
            if (this.activeTab === 'errors') this.renderErrors();
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

        const metric = (value, key) => `
                <div class="metric">
                    <div class="metric-label">${tx(key)}</div>
                    <div class="metric-value diag-stat-value">${Helpers.escapeHtml(value)}</div>
                </div>`;
        const sel = (v) => (this.filter === v ? 'selected' : '');
        container.innerHTML = `
            <div class="panel metrics diag-metrics">
                ${metric(stats.total, 'ui.diag.unique_errors')}
                ${metric(stats.totalOccurrences, 'ui.diag.total_occurrences')}
                ${metric(stats.byType['uncaught'] || 0, 'ui.diag.uncaught')}
                ${metric(stats.byType['console.error'] || 0, 'ui.diag.console')}
            </div>

            <div class="diag-controls">
                <select id="diagTypeFilter" class="input" data-onchange="diagnostics.filterByType(this.value)">
                    <option value="all" ${sel('all')}>${tx('ui.diag.all_types')}</option>
                    <option value="uncaught" ${sel('uncaught')}>${tx('ui.diag.uncaught')}</option>
                    <option value="unhandledrejection" ${sel('unhandledrejection')}>${tx('ui.diag.rejections')}</option>
                    <option value="console.error" ${sel('console.error')}>${tx('ui.diag.console')}</option>
                    <option value="warning" ${sel('warning')}>${tx('ui.diag.warnings')}</option>
                    <option value="manual" ${sel('manual')}>${tx('ui.diag.manual')}</option>
                    <option value="toast" ${sel('toast')}>${tx('ui.diag.t_toast')}</option>
                </select>
                <button type="button" data-onclick="diagnostics.loadData()" class="btn btn-icon" title="${tx('ui.health.refresh')}" aria-label="${tx('ui.health.refresh')}">${icon('refresh')}</button>
                <button type="button" data-onclick="diagnostics.exportErrorReport()" class="btn" data-export="errors">${tx('ui.diag.export_report')}</button>
                <button type="button" data-onclick="diagnostics.clearAll()" class="btn btn-icon" title="${tx('msg.diagnostics.clear_all_diagnostics')}" aria-label="${tx('msg.diagnostics.clear_all_diagnostics')}">${icon('x')}</button>
            </div>

            <div class="diagnostics-list">
                ${filteredData.length === 0
                    ? emptyState({ icon: 'check', tone: 'pos', title: t('ui.diag.no_errors') })
                    : filteredData.map(error => this.renderErrorCard(error)).join('')}
            </div>
        `;
    },

    /**
     * Render a single error card
     * @param {Object} error - Error data
     * @returns {string} HTML string
     */
    renderErrorCard(error) {
        const tones = {
            'uncaught': 'neg',
            'unhandledrejection': 'warn',
            'console.error': 'warn',
            'warning': 'info',
            'manual': '',
            'toast': 'neg'
        };

        const typeKeys = {
            'uncaught': 'ui.diag.t_uncaught',
            'unhandledrejection': 'ui.diag.t_promise',
            'console.error': 'ui.diag.t_console',
            'warning': 'ui.diag.t_warning',
            'manual': 'ui.diag.t_manual',
            'toast': 'ui.diag.t_toast'
        };
        const known = Object.hasOwn(typeKeys, error.type);
        const tone = known ? tones[error.type] : '';
        const typeLabel = known ? tx(typeKeys[error.type]) : Helpers.escapeHtml(error.type);

        const lastSeen = formatDateTimeIN(error.lastSeen);
        const firstSeen = error.firstSeen ? formatDateTimeIN(error.firstSeen, undefined, lastSeen) : lastSeen;

        return `
            <div class="panel panel-pad diag-card diag-error-card">
                <div class="diag-card-head">
                    <span class="tag ${Helpers.escapeHtml(tone)} diag-error-type">${typeLabel}</span>
                    ${error.type === 'toast' ? `<span class="diag-hint">${tx('ui.diag.ref', { ref: error.id })}</span>` : ''}
                    <span class="tag neg diag-error-count">${Helpers.escapeHtml(error.count || 1)}×</span>
                    <button type="button" data-onclick="diagnostics.deleteError('${Helpers.escapeJsAttr(error.id)}')" class="btn btn-ghost btn-icon btn-sm diag-delete-btn" title="${tx('msg.diagnostics.hide_error_title')}" aria-label="${tx('msg.diagnostics.hide_error_title')}">${icon('x', 'i-sm')}</button>
                </div>
                <div class="diag-error-message">${Helpers.escapeHtml(error.message || t('ui.diag.no_message'))}</div>
                ${error.source ? `<div class="diag-hint diag-code">${icon('file', 'i-sm')} ${Helpers.escapeHtml(error.source)}:${Helpers.escapeHtml(error.line || '?')}</div>` : ''}
                <div class="diag-card-meta diag-hint">
                    <span>${tx('ui.diag.first', { at: firstSeen })}</span>
                    <span>${tx('ui.diag.last', { at: lastSeen })}</span>
                </div>
                ${error.stack ? `
                    <details class="diag-error-stack">
                        <summary>${tx('ui.diag.stack')}</summary>
                        <pre class="diag-pre">${Helpers.escapeHtml(error.stack)}</pre>
                    </details>
                ` : ''}
                ${error.occurrences && error.occurrences.length > 0 ? `
                    <details class="diag-error-occurrences">
                        <summary>${tx('ui.diag.recent', { count: error.occurrences.length })}</summary>
                        <ul class="diag-list">
                            ${error.occurrences.slice(-5).map(o => `
                                <li>${Helpers.escapeHtml(formatDateTimeIN(o.timestamp))} - ${Helpers.escapeHtml(o.userName || t('ui.reports.unknown'))}</li>
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
            // Profiles name the writer: an entry's stored name and role are whatever the phone sent (#85)
            const [logs, people] = await Promise.all([
                AuditService.getRecentLogs(100),
                FirebaseService.loadAuditPeople().catch(e => {
                    console.warn('Audit: profiles not read:', e?.code || e);
                    return [];
                })
            ]);
            this.auditLogs = logs;
            this.auditPeople = peopleById(people);
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

        const sel = (v) => (this.auditFilter === v ? 'selected' : '');
        container.innerHTML = `
            <div class="diag-controls">
                <select id="auditFilterAction" class="input" data-onchange="diagnostics.filterAuditLogs(this.value)">
                    <option value="" ${sel('')}>${tx('ui.diag.all_actions')}</option>
                    <option value="CREATE_BILL" ${sel('CREATE_BILL')}>${tx('ui.diag.a_create_bill')}</option>
                    <option value="DELETE_BILL" ${sel('DELETE_BILL')}>${tx('ui.diag.a_delete_bill')}</option>
                    <option value="CREATE_SALE" ${sel('CREATE_SALE')}>${tx('ui.diag.a_create_sale')}</option>
                    <option value="DELETE_SALE" ${sel('DELETE_SALE')}>${tx('ui.diag.a_delete_sale')}</option>
                    <option value="VOID_BILL" ${sel('VOID_BILL')}>${tx('ui.diag.a_void_bill')}</option>
                    <option value="DELETE_ITEM" ${sel('DELETE_ITEM')}>${tx('ui.diag.a_delete_item')}</option>
                    <option value="UPDATE_PAYMENT" ${sel('UPDATE_PAYMENT')}>${tx('ui.diag.a_update_payment')}</option>
                    <option value="CLEAR_DATA" ${sel('CLEAR_DATA')}>${tx('ui.diag.a_clear_data')}</option>
                </select>
                <button type="button" data-onclick="diagnostics.loadAuditLogs()" class="btn btn-icon" title="${tx('ui.health.refresh')}" aria-label="${tx('ui.health.refresh')}">${icon('refresh')}</button>
                <button type="button" data-onclick="diagnostics.exportAuditCsv()" class="btn" data-export="audit-csv">${tx('ui.statements.download_csv')}</button>
                <button type="button" data-onclick="diagnostics.printAudit()" class="btn" data-export="audit-print">${icon('printer', 'i-sm')} ${tx('ui.statements.print')}</button>
            </div>

            <div class="diagnostics-list">
                ${filteredLogs.length === 0
                    ? emptyState({ icon: 'list', title: t('ui.settings.no_audit_logs') })
                    : filteredLogs.map(log => this.renderAuditCard(log)).join('')}
            </div>
        `;
    },

    /**
     * Render a single audit log card
     * @param {Object} log - Audit log data
     * @returns {string} HTML string
     */
    renderAuditCard(log) {
        const formattedDate = formatDateTimeIN(log.timestamp);

        const tone = this.getActionTone(log.action);
        const details = this.formatDetails(log.details, log.action);
        const who = auditWhoText(auditWho(log, this.auditPeople), Helpers.roleLabel);

        return `
            <div class="panel panel-pad diag-card diag-audit-card">
                <div class="diag-card-head">
                    <span class="lead-icon ${Helpers.escapeHtml(tone)}">${this.getActionIcon(log.action)}</span>
                    <span class="diag-audit-action">${Helpers.escapeHtml(auditActionLabel(log.action))}</span>
                    <span class="diag-hint diag-audit-time">${Helpers.escapeHtml(formattedDate)}</span>
                </div>
                <div class="diag-audit-user">
                    <strong>${Helpers.escapeHtml(who.main)}</strong>${who.note ? ` · <small>${Helpers.escapeHtml(who.note)}</small>` : ''}
                </div>
                ${details ? `<div class="diag-hint">${Helpers.escapeHtml(details)}</div>` : ''}
            </div>
        `;
    },

    /**
     * Sprite icon of an audit action
     * @param {string} action - Action type
     * @returns {string} icon markup
     */
    getActionIcon(action) {
        if (action === 'CLEAR_DATA') return icon('alert', 'i-sm');
        if (String(action).includes('DELETE')) return icon('trash', 'i-sm');
        if (action === 'CREATE_BILL') return icon('arrIn', 'i-sm');
        if (action === 'CREATE_SALE') return icon('arrOut', 'i-sm');
        if (action === 'VOID_BILL') return icon('x', 'i-sm');
        if (action === 'UPDATE_PAYMENT' || action === 'RECORD_PAYMENT') return icon('banknote', 'i-sm');
        if (action === 'LOGIN' || action === 'LOGOUT') return icon('lock', 'i-sm');
        return icon('list', 'i-sm');
    },

    /**
     * Tone of an audit action's icon (lead-icon modifier)
     * @param {string} action - Action type
     * @returns {''|'neg'|'pos'|'accent'}
     */
    getActionTone(action) {
        const a = String(action);
        if (a.includes('DELETE') || a === 'CLEAR_DATA') return 'neg';
        if (a.includes('CREATE')) return 'pos';
        if (a.includes('PAYMENT')) return 'accent';
        return '';
    },

    /**
     * Format audit log details
     * @param {Object} details - Details object
     * @returns {string} Formatted string
     */
    formatDetails(details, action) {
        return formatAuditDetails(details, action);
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
     * The audit entries listed (filter applied), as export rows: time, action, who, details (#85).
     * @param {'en'|'hi'} [lang] the CSV is always English (for accountants and tools); the printed page follows the app
     */
    auditExportRows(lang = getLang()) {
        const list = this.auditFilter ? this.auditLogs.filter(log => log.action === this.auditFilter) : this.auditLogs;
        const roleKeys = { owner: 'ui.roles.owner', manager: 'ui.roles.manager', staff: 'ui.roles.member' };
        const roleLabel = (role) => (roleKeys[role] ? t(roleKeys[role], null, lang) : String(role ?? ''));
        return list.map(log => {
            const who = auditWhoText(auditWho(log, this.auditPeople), roleLabel, lang);
            return {
                at: Number(log.timestamp),
                cells: [isoMinute(Number(log.timestamp)), auditActionLabel(log.action, lang), [who.main, who.note].filter(Boolean).join(' · '), formatAuditDetails(log.details, log.action, lang)]
            };
        });
    },

    auditExportPeriod(rows) {
        const times = rows.map(r => r.at).filter(Number.isFinite);
        if (!times.length) return { from: null, to: null };
        return { from: toLocalISODate(new Date(Math.min(...times))), to: toLocalISODate(new Date(Math.max(...times))) };
    },

    auditHeader(lang = getLang()) {
        return ['ui.export.col_time', 'ui.export.col_action', 'ui.export.col_who', 'ui.export.col_details'].map(k => t(k, null, lang));
    },

    /** Audit log as CSV (#85), through the one export path (#103); English, like the accountant CSV. */
    exportAuditCsv() {
        const rows = this.auditExportRows('en');
        if (!rows.length) {
            UIManager.showToast(t('msg.export.nothing'));
            return Promise.resolve(false);
        }
        return Exporter.run({
            kind: 'audit', format: 'csv', period: this.auditExportPeriod(rows), rows: rows.length, names: true,
            produce: (stamp) => Exporter.saveBlob(new Blob([stampedCsv(this.auditHeader('en'), rows.map(r => r.cells), stamp, 'en')], { type: 'text/csv;charset=utf-8;' }),
                exportFilename(stamp, 'audit', 'csv'), { shareFirst: false })
        });
    },

    /** Audit log as a printable page (Print / PDF, #85). */
    printAudit() {
        const rows = this.auditExportRows();
        if (!rows.length) {
            UIManager.showToast(t('msg.export.nothing'));
            return Promise.resolve(false);
        }
        const e = (v) => Helpers.escapeHtml(String(v ?? ''));
        const title = t('ui.admin.col_audit_logs');
        const html = `<h3>${e(title)}</h3><table><thead><tr>${this.auditHeader().map(h => `<th>${e(h)}</th>`).join('')}</tr></thead>`
            + `<tbody>${rows.map(r => `<tr>${r.cells.map(c => `<td>${e(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        return Exporter.run({
            kind: 'audit', format: 'print', period: this.auditExportPeriod(rows), rows: rows.length, names: true,
            produce: (stamp) => Exporter.printPage({ title, html, stampText: stampLine(stamp), lang: getLang() })
        });
    },

    /** The shop's people's names for the error report (#83): the team list (one read, at most 2 s), the audit profiles already loaded and this user. */
    async reportPeopleNames() {
        const names = [AppState.userName];
        (this.auditPeople instanceof Map ? [...this.auditPeople.values()] : []).forEach(p => names.push(p?.name));
        try {
            const dir = await Promise.race([readTeamDirectory(), new Promise(resolve => setTimeout(() => resolve(null), 2000))]);
            teamPeople(dir).forEach(p => names.push(p.name));
        } catch (e) {
            console.warn('Error report: team list not read:', e?.code || e);
        }
        return names.filter(Boolean);
    },

    /** Error report (#83): the listed errors, scrubbed (people's names too), with this phone's status; owner only, audited. */
    async exportErrorReport() {
        const list = this.filter === 'all' ? (this.data || []) : (this.data || []).filter(d => d.type === this.filter);
        if (!list.length) {
            UIManager.showToast(t('msg.export.nothing'));
            return false;
        }
        if (!Exporter.allowed()) return Exporter.run({ kind: 'errors', format: 'json', produce: () => false });
        const names = await this.reportPeopleNames();
        const period = errorReportPeriod(list, (ms) => toLocalISODate(new Date(ms)));
        return Exporter.run({
            kind: 'errors', format: 'json', period, rows: list.length, names: false,
            produce: (stamp) => {
                const status = this.phoneStatus();
                const report = { stamp, ...buildErrorReport(list, { status: this.statusText(), appVersion: status.appVersion, buildId: status.buildId, names }) };
                return Exporter.saveBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), exportFilename(stamp, 'errors', 'json'));
            }
        });
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
        const confirmed = await UIManager.showModal(t('msg.diagnostics.delete_error'), t('msg.diagnostics.hide_error_title'), true);
        if (!confirmed) return;

        try {
            const entry = this.data.find(d => d.id === errorId);
            const count = await TelemetryService.hideErrors(entry?.docIds?.length ? entry.docIds : [errorId]);
            AuditService.note(AuditService.ACTIONS.HIDE_ERRORS, { reports: count, all: false });
            this.data = this.data.filter(d => d.id !== errorId);
            this.renderErrors();
            UIManager.showToast(t('msg.diagnostics.error_deleted'));
        } catch (error) {
            UIManager.showToast(t('msg.diagnostics.failed_delete_error'), 'error');
        }
    },

    /**
     * Hide every listed error (#116): kept in Firestore, recorded in the audit log
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
            const listed = this.filter === 'all' ? (this.data || []) : (this.data || []).filter(d => d.type === this.filter);
            const count = await TelemetryService.hideErrors(listed.flatMap(d => (d.docIds?.length ? d.docIds : [d.id])));
            AuditService.note(AuditService.ACTIONS.HIDE_ERRORS, { reports: count, all: true });
            const gone = new Set(listed.map(d => d.id));
            this.data = (this.data || []).filter(d => !gone.has(d.id));
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
