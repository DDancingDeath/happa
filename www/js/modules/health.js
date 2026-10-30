// -------------------- APP HEALTH (Test in Production, #217) --------------------
// Owner/manager page over the tipHealth counters and tipFailures samples that
// every device reports (tip/index.js), plus the red banner on Today when a
// check is below its target. Reads are bounded: the page reads the last 14
// days (≤ HEALTH_LIMIT docs) + the latest failures; the banner reads today's
// docs at most every 30 minutes.

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { t } from '../i18n/index.js';
import { tip, tipTargets, tipReasons } from '../tip/index.js';
import { dayKeyOf, normalizePolicies } from '../tip/tip.js';
import {
    aggregateHealth, belowTarget, countedRuns, lastDays, passRate, reasonName, DEFAULT_TARGET
} from '../tip/health-stats.js';

import { attachScrollCue } from '../ui/scroll-cue.js';

const esc = (v) => Helpers.escapeHtml(v == null ? '' : String(v));
const L = (key, params) => esc(t(key, params));
const DAYS = 14;
const SHOW_DAYS = 7;
const HEALTH_LIMIT = 300;
const FAILURE_LIMIT = 30;
const BANNER_TTL_MS = 30 * 60 * 1000;
const BANNER_LIMIT = 50;

const TEST_LABEL_KEYS = {
    AppStart: 'ui.health.test_app_start',
    BillSave: 'ui.health.test_bill_save',
    PaymentRecord: 'ui.health.test_payment_record',
    CashClose: 'ui.health.test_cash_close'
};
const RESULT_LABEL_KEYS = {
    fail: 'ui.health.result_fail',
    abandoned: 'ui.health.result_abandoned',
    expired: 'ui.health.result_expired',
    rolled_back: 'ui.health.result_rolled_back'
};

const canSee = () => AppState.userRole === 'owner' || AppState.userRole === 'manager';
const testLabel = (id) => (TEST_LABEL_KEYS[id] ? t(TEST_LABEL_KEYS[id]) : id);
const prettyReason = (name) => String(name || '').replace(/_/g, ' ');
const dayLabel = (key) => `${key.slice(6, 8)}/${key.slice(4, 6)}`;
const target = (test) => {
    const v = tipTargets()[test];
    return Number.isFinite(v) ? v : DEFAULT_TARGET;
};

/** A pass-rate cell: green at/above target, amber within 5 points, red below. */
function rateCell(n, test) {
    const rate = passRate(n);
    if (rate === null) return '<td class="health-rate health-none">–</td>';
    const goal = target(test);
    const cls = rate >= goal ? 'ok' : rate >= goal - 5 ? 'near' : 'bad';
    return `<td class="health-rate health-${cls}" title="${esc(countedRuns(n))}">${esc(rate)}%<small>${esc(countedRuns(n))}</small></td>`;
}

const ROLE_LABEL_KEYS = { owner: 'ui.health.role_owner', manager: 'ui.roles.manager', staff: 'ui.roles.member' };

/**
 * Who uses a device (profile name, else role) and a short device tag (F34): `tag` = role (when named) and `code`.
 * @returns {{who: string, tag: string, role: string, code: string}}
 */
export function deviceLabel(dev, usersById = {}) {
    const user = dev?.uid ? usersById[dev.uid] : null;
    const role = user?.role ? t(ROLE_LABEL_KEYS[user.role] || 'ui.roles.member') : '';
    const name = String(user?.name || '').trim();
    const id = String(dev?.deviceId || '');
    const tag = `#${id.slice(-4)}`;
    if (name) return { who: name, tag: role ? `${role} · ${tag}` : tag, role, code: tag };
    return { who: role || t('ui.health.unknown_user'), tag, role: '', code: tag };
}

function deviceCellHtml(dev, usersById) {
    const { who, role, code } = deviceLabel(dev, usersById);
    // The device id is a code, not words in either language (lang="zxx").
    const codeHtml = `<span lang="zxx" translate="no">${esc(code)}</span>`;
    return `<strong>${esc(who)}</strong><div class="health-muted" title="${esc(dev.deviceId)}">${role ? `${esc(role)} · ` : ''}${codeHtml}</div>`;
}

export const HealthManager = {
    /** Page data: { docs, failures, at } */
    data: null,
    /** Today banner cache: { day, docs, at } */
    banner: null,

    openPage() {
        window.app?.nav?.showTab('health');
    },

    async init() {
        const denied = document.getElementById('healthDenied');
        const body = document.getElementById('healthBody');
        if (!canSee()) {
            if (denied) denied.style.display = 'block';
            if (body) body.style.display = 'none';
            return;
        }
        if (denied) denied.style.display = 'none';
        if (body) body.style.display = 'block';
        this.renderPolicyCard();
        if (this.data) this.render();
        if (!this.data || Date.now() - this.data.at > BANNER_TTL_MS) await this.refresh();
    },

    async refresh() {
        if (!canSee()) return;
        const status = document.getElementById('healthStatus');
        if (status) status.textContent = t('ui.health.loading');
        try {
            const today = dayKeyOf(Date.now());
            const [docs, failures, users] = await Promise.all([
                FirebaseService.loadTipHealth({ sinceDay: lastDays(today, DAYS)[DAYS - 1], limit: HEALTH_LIMIT }),
                FirebaseService.loadTipFailures({ limit: FAILURE_LIMIT }).catch(e => {
                    console.warn('TIP failures not loaded:', e?.code || e);
                    return [];
                }),
                FirebaseService.loadUsers().catch(e => {
                    console.warn('Users for device names not loaded:', e?.code || e);
                    return [];
                })
            ]);
            this.data = { docs, failures, users, at: Date.now() };
            this.banner = { day: today, docs: docs.filter(d => d.day === today), at: Date.now() };
            this.render();
        } catch (error) {
            console.warn('App health not loaded:', error?.code || error);
            if (status) status.textContent = t('ui.health.load_failed', { message: error?.code || error?.message || '' });
        }
    },

    render() {
        const { docs = [], failures = [], users = [], at } = this.data || {};
        const usersById = Object.fromEntries((users || []).map(u => [u.id, u]));
        const agg = aggregateHealth(docs, { reasonsByTest: tipReasons() });
        const today = dayKeyOf(Date.now());
        const status = document.getElementById('healthStatus');
        if (status) {
            status.textContent = t('ui.health.updated', {
                time: Helpers.formatTime(at || Date.now()),
                docs: docs.length
            });
        }
        const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
        const empty = `<div class="health-empty">${L('ui.health.no_data')}</div>`;
        if (!agg.tests.length) {
            ['healthSummary', 'healthByDay', 'healthByVersion', 'healthReasons', 'healthDurations', 'healthDevices'].forEach(id => set(id, empty));
            set('healthFailures', this.failuresHtml(failures) || empty);
            return;
        }

        const days7 = lastDays(today, SHOW_DAYS);
        const todayN = (test) => agg.byTestDay[test]?.[today] || {};
        const sumDays = (test, keys) => keys.reduce((acc, d) => {
            Object.entries(agg.byTestDay[test]?.[d] || {}).forEach(([k, v]) => { acc[k] = (acc[k] || 0) + v; });
            return acc;
        }, {});

        set('healthSummary', `<table class="health-table"><thead><tr>
            <th>${L('ui.health.check')}</th><th>${L('ui.health.today')}</th><th>${L('ui.health.last_7_days')}</th>
            <th>${L('ui.health.last_14_days')}</th><th>${L('ui.health.target')}</th><th>${L('ui.health.failing_devices')}</th>
            </tr></thead><tbody>${agg.tests.map(test => `<tr>
                <th scope="row">${esc(testLabel(test))}</th>
                ${rateCell(todayN(test), test)}${rateCell(sumDays(test, days7), test)}${rateCell(agg.totals[test], test)}
                <td>${esc(target(test))}%</td>
                <td>${esc(agg.devicesByTest[test]?.failing || 0)} / ${esc(agg.devicesByTest[test]?.total || 0)}</td>
            </tr>`).join('')}</tbody></table>`);

        set('healthByDay', `<table class="health-table"><thead><tr><th>${L('ui.health.check')}</th>${days7.map(d => `<th>${esc(dayLabel(d))}</th>`).join('')}</tr></thead>
            <tbody>${agg.tests.map(test => `<tr><th scope="row">${esc(testLabel(test))}</th>${days7.map(d => rateCell(agg.byTestDay[test]?.[d] || {}, test)).join('')}</tr>`).join('')}</tbody></table>`);

        const versions = [...new Set(agg.tests.flatMap(test => Object.keys(agg.byTestVersion[test] || {})))].sort().reverse();
        set('healthByVersion', `<table class="health-table"><thead><tr><th>${L('ui.health.check')}</th>${versions.map(v => `<th>${esc(v.replace(/_/g, '.'))}</th>`).join('')}</tr></thead>
            <tbody>${agg.tests.map(test => `<tr><th scope="row">${esc(testLabel(test))}</th>${versions.map(v => rateCell(agg.byTestVersion[test]?.[v] || {}, test)).join('')}</tr>`).join('')}</tbody></table>`);

        set('healthReasons', agg.reasons.length ? `<ol class="health-list">${agg.reasons.slice(0, 10).map(r =>
            `<li><strong>${esc(testLabel(r.test))}</strong>: ${esc(prettyReason(r.name))} <span class="health-count">× ${esc(r.count)}</span></li>`).join('')}</ol>`
            : `<div class="health-empty">${L('ui.health.no_failures')}</div>`);

        set('healthDurations', `<table class="health-table"><thead><tr><th>${L('ui.health.check')}</th><th>${L('ui.health.p50')}</th><th>${L('ui.health.p90')}</th></tr></thead>
            <tbody>${agg.tests.map(test => {
                const d = agg.durations[test] || {};
                const fmt = (ms) => (ms == null ? '–' : `≤ ${ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`}`);
                return `<tr><th scope="row">${esc(testLabel(test))}</th><td>${esc(fmt(d.p50))}</td><td>${esc(fmt(d.p90))}</td></tr>`;
            }).join('')}</tbody></table>`);

        set('healthDevices', `<table class="health-table"><thead><tr><th>${L('ui.health.device')}</th><th>${L('ui.health.platform')}</th>
            <th>${L('ui.health.version')}</th><th>${L('ui.health.last_seen')}</th><th>${L('ui.health.runs')}</th><th>${L('ui.health.failed')}</th></tr></thead>
            <tbody>${agg.devices.slice(0, 30).map(dev => `<tr class="${dev.failed ? 'health-row-bad' : ''}">
                <td>${deviceCellHtml(dev, usersById)}</td><td>${esc(dev.platform)}</td><td>${esc(dev.appVersion)}</td>
                <td>${esc(dev.lastDay ? dayLabel(dev.lastDay) : '')}</td><td>${esc(dev.runs)}</td><td>${esc(dev.failed)}</td></tr>`).join('')}</tbody></table>`);

        set('healthFailures', this.failuresHtml(failures) || `<div class="health-empty">${L('ui.health.no_failures')}</div>`);
        document.querySelectorAll('#health .scroll-cue-inner').forEach(attachScrollCue);
    },

    failuresHtml(failures) {
        if (!failures || !failures.length) return '';
        const reasons = tipReasons();
        return `<div class="health-failures">${failures.map(f => {
            const when = Number(f.at) ? Helpers.formatDateTime(Number(f.at)) : '';
            const resultKey = RESULT_LABEL_KEYS[f.result];
            const flags = Object.entries(f.flags || {}).map(([k, v]) => `${k}=${v}`).join(', ');
            return `<div class="health-failure">
                <div><strong>${esc(testLabel(f.test))}</strong> · ${esc(resultKey ? t(resultKey) : f.result)} · ${esc(prettyReason(f.reasonName || reasonName(f.test, f.reason, reasons)))}</div>
                <div class="health-muted">${esc(when)} · ${esc(f.appVersion)} · ${esc(f.platform || '')} · <code>${esc(f.deviceId)}</code>${flags ? ` · ${esc(flags)}` : ''}</div>
            </div>`;
        }).join('')}</div>`;
    },

    /** Owner: edit settings/app.tipPolicies; everyone who sees the page: this device's policy state. */
    renderPolicyCard() {
        const card = document.getElementById('healthPolicyCard');
        if (!card) return;
        card.style.display = 'block';
        const policies = tip.getPolicies();
        const textarea = document.getElementById('healthPolicies');
        if (textarea) {
            textarea.value = JSON.stringify(Object.keys(policies).length ? policies : {
                billChecksBlocking: { test: 'BillSave', reason: 'blocked_valid_bill', passrate: 25, count: 5, telemetryOnly: true }
            }, null, 2);
            textarea.readOnly = AppState.userRole !== 'owner';
        }
        const saveBtn = card.querySelector('button');
        if (saveBtn) saveBtn.style.display = AppState.userRole === 'owner' ? '' : 'none';
        const state = document.getElementById('healthPolicyState');
        if (state) {
            const rows = Object.entries(policies).map(([key, p]) => {
                const s = tip.policyState(key);
                const mode = p.telemetryOnly ? t('ui.health.report_only') : t('ui.health.switches_safe_mode');
                const now = s.tripped ? t('ui.health.policy_tripped', { rate: s.passrate }) : t('ui.health.policy_ok', { runs: s.runs });
                return `<li><strong>${esc(key)}</strong> (${esc(testLabel(p.test))}, ${esc(mode)}): ${esc(now)}</li>`;
            });
            state.innerHTML = rows.length ? `<ul class="health-list">${rows.join('')}</ul>` : `<div class="health-muted">${L('ui.health.no_policies')}</div>`;
        }
    },

    async savePolicies() {
        if (AppState.userRole !== 'owner') return;
        let parsed;
        try {
            parsed = JSON.parse(document.getElementById('healthPolicies')?.value || '{}');
        } catch (_) {
            UIManager.showToast(t('msg.health.policies_invalid'));
            return;
        }
        const policies = normalizePolicies(parsed);
        try {
            await FirebaseService.saveTipPolicies(policies);
            tip.setPolicies(policies);
            this.renderPolicyCard();
            UIManager.showToast(t('msg.health.policies_saved', { count: Object.keys(policies).length }));
        } catch (error) {
            UIManager.showToast(t('msg.health.policies_not_saved', { message: error?.message || error }));
        }
    },

    /**
     * Today banner (owner/manager): checks below target today. Reads today's
     * docs at most every 30 minutes; never throws.
     */
    async renderTodayBanner() {
        const el = document.getElementById('tipHealthBanner');
        if (!el) return;
        try {
            if (!canSee()) { el.style.display = 'none'; return; }
            const today = dayKeyOf(Date.now());
            if (!this.banner || this.banner.day !== today || Date.now() - this.banner.at > BANNER_TTL_MS) {
                const docs = await FirebaseService.loadTipHealth({ sinceDay: today, untilDay: today, limit: BANNER_LIMIT });
                this.banner = { day: today, docs, at: Date.now() };
            }
            const low = belowTarget(this.banner.docs, { day: today, targets: tipTargets() });
            if (!low.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
            el.innerHTML = `<div class="tip-health-banner-text">⚠️ ${low.map(x => esc(t('ui.health.banner_line', {
                check: testLabel(x.test), rate: x.rate, target: x.target, runs: x.runs
            }))).join('<br>')}</div>
                <button type="button" class="btn btn-secondary" onclick="window.app.health.openPage()">${L('ui.health.open_health')}</button>`;
            el.style.display = 'flex';
        } catch (error) {
            console.warn('App health banner not loaded:', error?.code || error);
            el.style.display = 'none';
        }
    }
};
