/**
 * @fileoverview Rentals phase 3 screens (#157): a lease's agreement terms (end
 * month, notice period; the start and the yearly increase % are on the lease
 * already), the lease reminders kept for Today (REM-4) and the yearly report per
 * property (RENT-19) with its CSV (owner). Loaded with import() from rentals.js
 * only when used (not precached).
 * @module rentals/rent-report
 */

import { UIManager } from '../ui/ui-manager.js';
import { AuditService } from '../services/audit.js';
import { AppState } from '../utils/state.js';
import { t, getLang } from '../i18n/index.js';
import { formatINR } from '../utils/due-reminder.js';
import { toCsv } from '../utils/statements.js';
import { saveLeaseReminders } from '../utils/reminders.js';
import { APP_IDENTITY } from '../config/app-identity.js';
import * as store from './rent-store.js';
import { yearData } from './rent-report-store.js';
import { monthLabel, isMonth } from './rent-math.js';
import { agreementError, leaseReminders, noticeBy, reportMonths, yearReport, MAX_NOTICE_MONTHS } from './rent-math-report.js';

const fail = (key) => UIManager.showToast(t(key), 'error');
const lbl = (c, key, field) => `<label class="rent-label">${c.esc(t(key))}${field}</label>`;
const FIELDS = ['rent', 'collected', 'due', 'expenses', 'tax', 'net'];
const report = { year: null, fy: true, data: null };

/** The financial year (April–March) containing `month`: its first year. */
const fyOf = (month) => (Number(month.slice(5, 7)) >= 4 ? Number(month.slice(0, 4)) : Number(month.slice(0, 4)) - 1);

/** Owner / rentals manager: a lease's agreement end month and notice period. */
export async function editAgreement(c, leaseId) {
    const lease = store.snapshot().leases.find(l => l.id === leaseId);
    if (!lease || !c.isManager) return;
    const lang = getLang();
    const ok = await c.dialog(`<h3>📄 ${c.esc(t('ui.rent.agr_title'))}</h3>
        <p class="rent-help">${c.esc(t('ui.rent.agr_start', { month: monthLabel(lease.startMonth, lang) }))} · ${c.esc(t('ui.rent.agr_increase', { pct: Number.isFinite(lease.increasePct) ? lease.increasePct : 5 }))}</p>
        ${lbl(c, 'ui.rent.agr_end', `<input id="rentAgrEnd" type="month" min="${c.esc(lease.startMonth)}" value="${c.esc(lease.agreementEnd || '')}">`)}
        ${lbl(c, 'ui.rent.agr_notice', `<input id="rentAgrNotice" type="number" inputmode="numeric" min="0" max="${MAX_NOTICE_MONTHS}" step="1" value="${c.esc(lease.noticeMonths ?? 0)}">`)}
        <p class="rent-help">${c.esc(t('ui.rent.agr_help'))}</p>`);
    if (!ok) return;
    const terms = { agreementEnd: c.val('rentAgrEnd'), noticeMonths: Number(c.val('rentAgrNotice') || 0) };
    const err = agreementError(terms, lease.startMonth);
    if (err) return fail(err);
    try {
        await store.updateLease(leaseId, { agreementEnd: terms.agreementEnd || null, noticeMonths: terms.noticeMonths });
        UIManager.showToast(t('msg.rent.saved'), 'success');
    } catch (e) {
        console.error('Agreement not saved:', e);
        fail(e?.code === 'permission-denied' ? 'msg.rent.not_allowed' : 'msg.rent.save_failed');
    }
}

/** One line under a tenant: "Agreement till Mar 2027 · notice by Feb 2027". */
export function agreementText(lease, lang = getLang()) {
    if (!isMonth(lease?.agreementEnd)) return '';
    const notice = noticeBy(lease);
    return t('ui.rent.agr_till', { month: monthLabel(lease.agreementEnd, lang) })
        + (notice ? ` · ${t('ui.rent.agr_notice_by', { month: monthLabel(notice, lang) })}` : '');
}

/**
 * Keeps REM-4 for Today: called after the Rent page shows this month with complete data.
 * @param {Object} snap rent-store snapshot
 * @param {string} month this month
 * @param {(unitId: string) => string} place unit's place name
 */
export function noteLeases(snap, month, place) {
    const tenants = new Map(snap.tenants.map(x => [x.id, x.name]));
    const items = leaseReminders(snap.leases, month, { names: (l) => ({ place: place(l.unitId), tenant: tenants.get(l.tenantId) || '' }) });
    saveLeaseReminders(localStorage, { uid: AppState.currentUser?.uid, month, items });
}

function reportHtml(c) {
    const lang = getLang();
    const r = yearReport(report.data, reportMonths(report.year, report.fy));
    const head = `<tr><th></th>${FIELDS.map(f => `<th class="num">${c.esc(t(`ui.rent.yr_${f}`))}</th>`).join('')}</tr>`;
    const line = (label, x, cls = '') => `<tr${cls}><td>${c.esc(label)}</td>${FIELDS.map(f => `<td class="num">${c.esc(formatINR(x[f]))}</td>`).join('')}</tr>`;
    const props = r.rows.map(p => `<h4>${c.esc(p.name || t('ui.rent.yr_no_property'))}</h4><div class="rent-scroll"><table class="rent-table">${head}`
        + r.months.map(m => line(monthLabel(m, lang), p.months[m])).join('')
        + line(t('ui.rent.yr_total'), p.total, ' class="rent-total"') + '</table></div>').join('');
    const base = report.fy ? fyOf(c.month) : Number(c.month.slice(0, 4));
    const years = [...new Set([base, base - 1, base - 2, base - 3, report.year])].sort((a, b) => b - a);
    const yearLabel = (y) => (report.fy ? t('ui.money.fy_label', { years: `${y}-${String((y + 1) % 100).padStart(2, '0')}` }) : String(y));
    const picker = `<div class="rent-actions">
        <select onchange="window.app.rentals.reportAction('year', this.value)" aria-label="${c.esc(t('ui.rent.yr_year'))}">${years
        .map(y => `<option value="${y}"${y === report.year ? ' selected' : ''}>${c.esc(yearLabel(y))}</option>`).join('')}</select>
        <button type="button" class="rent-btn" onclick="window.app.rentals.reportAction('kind')">${c.esc(t(report.fy ? 'ui.rent.yr_calendar' : 'ui.rent.yr_fy'))}</button>
        ${c.isOwner ? `<button type="button" class="rent-btn" onclick="window.app.rentals.reportAction('csv')">⬇ ${c.esc(t('ui.rent.yr_csv'))}</button>` : ''}</div>`;
    return `<h3>📊 ${c.esc(t('ui.rent.yr_title', { year: yearLabel(report.year) }))}</h3>${picker}
        <div class="rent-cards">${[['ui.rent.yr_collected', r.total.collected], ['ui.rent.yr_expenses', r.total.expenses], ['ui.rent.yr_net', r.total.net]]
        .map(([k, v]) => `<div class="rent-card"><div class="rent-card-label">${c.esc(t(k))}</div><div class="rent-card-value">${c.esc(formatINR(v))}</div></div>`).join('')}</div>
        ${report.data.cut ? `<p class="rent-help">⚠ ${c.esc(t('msg.rent.limit_reached'))}</p>` : ''}
        <p class="rent-help">${c.esc(t('ui.rent.yr_help'))}</p>${props || `<p class="rent-empty">${c.esc(t('ui.rent.yr_none'))}</p>`}`;
}

async function load(c) {
    const months = reportMonths(report.year, report.fy);
    const d = await yearData(months[0], months[11]);
    report.data = { ...d, properties: store.snapshot().properties };
    return reportHtml(c);
}

/** Owner / rentals manager: the yearly report per property (RENT-19), this financial year first. */
export async function showYearReport(c) {
    if (!c.isManager) return;
    if (report.year === null) report.year = fyOf(c.month);
    let html;
    try { html = await load(c); } catch (e) {
        console.error('Yearly report not loaded:', e);
        return fail('msg.rent.could_not_load');
    }
    await c.dialog(`<div id="rentReport">${html}</div>`, { info: true });
}

/** Report controls: 'year' (a year), 'kind' (financial / calendar year), 'csv' (owner). */
export async function action(c, name, value) {
    if (name === 'csv') return c.isOwner && report.data ? downloadCsv() : undefined;
    if (name === 'year') report.year = Number(value);
    if (name === 'kind') {
        report.fy = !report.fy;
        report.year = report.fy ? fyOf(c.month) : Number(c.month.slice(0, 4));
    }
    try {
        const html = await load(c);
        const box = document.getElementById('rentReport');
        if (box) box.innerHTML = html;
    } catch (e) {
        console.error('Yearly report not loaded:', e);
        fail('msg.rent.could_not_load');
    }
}

/** RENT-19 as CSV: one row per property and month, then the property's total (headers in the app language). */
function downloadCsv() {
    const r = yearReport(report.data, reportMonths(report.year, report.fy));
    const header = [t('ui.rent.yr_property'), t('ui.rent.yr_month'), ...FIELDS.map(f => t(`ui.rent.yr_${f}`))];
    const rows = r.rows.flatMap(p => [
        ...r.months.map(m => [p.name, m, ...FIELDS.map(f => p.months[m][f])]),
        [p.name, t('ui.rent.yr_total'), ...FIELDS.map(f => p.total[f])]
    ]);
    const blob = new Blob([toCsv(header, rows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${APP_IDENTITY.appName}_rent_${report.fy ? 'fy' : 'year'}_${report.year}.csv`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    AuditService.log('RENT_REPORT_CSV', { year: report.year, fy: report.fy }).catch(e => console.warn('Rentals audit entry not written:', e?.code || e));
}
