/**
 * @fileoverview Settings › Usage on this phone (#136): the most used features
 * today / last 7 / last 30 days (USE-1), copy and clear. Local only.
 * @module ui/usage-view
 */

import { t } from '../i18n/index.js';
import { Helpers } from '../utils/helpers.js';
import { UIManager } from './ui-manager.js';
import { Usage } from '../services/usage.js';
import { topUsage } from '../utils/usage-stats.js';
import { todayLocalISO, localISODaysAgo } from '../utils/dates.js';

export const PAGE_KEYS = {
    billing: 'ui.nav.billing', day: 'ui.nav.today', history: 'ui.nav.history', due: 'ui.nav.outstanding',
    'wholesale-sales': 'ui.nav.sales', stock: 'ui.nav.stocks', items: 'ui.nav.rates', money: 'ui.nav.money',
    insights: 'ui.nav.insights', statements: 'ui.nav.statements', anomalies: 'ui.nav.anomalies', health: 'ui.nav.health',
    settings: 'ui.nav.settings', diagnostics: 'ui.nav.diagnostics', admin: 'ui.nav.admin', expenses: 'ui.nav.expenses',
    'cash-management': 'ui.usage.page_cash', rentals: 'ui.usage.page_rentals', users: 'ui.usage.page_users', chat: 'ui.nav.ai_assistant'
};

export const RANGE_DAYS = { today: 1, week: 7, month: 30 };

/** Feature name in the app language. */
export function usageLabel(event) {
    if (event.startsWith('page.')) {
        const id = event.slice(5);
        return t('ui.usage.page_opened', { page: PAGE_KEYS[id] ? t(PAGE_KEYS[id]) : id });
    }
    return t(`ui.usage.e_${event.replace(/\./g, '_')}`);
}

export const UsageView = {
    range: 'week',
    last: [],

    rangeOf(range = this.range) {
        const days = RANGE_DAYS[range] || 7;
        return { fromDay: localISODaysAgo(days - 1), toDay: todayLocalISO() };
    },

    async render() {
        const list = document.getElementById('usageList');
        if (!list) return;
        const bar = document.getElementById('usageRange');
        if (bar) {
            bar.querySelectorAll('[data-range]').forEach(b => b.classList.toggle('active', b.dataset.range === this.range));
        }
        let rows = [];
        try {
            rows = await Usage.rows();
        } catch (err) {
            console.warn('Usage not loaded:', err?.message || err);
        }
        this.last = topUsage(rows, { ...this.rangeOf(), limit: 10 });
        list.innerHTML = this.last.length
            ? `<ol class="usage-list">${this.last.map(r => `<li data-event="${Helpers.escapeHtml(r.event)}"><span>${Helpers.escapeHtml(usageLabel(r.event))}</span> <strong>${Helpers.escapeHtml(String(r.count))}</strong></li>`).join('')}</ol>`
            : `<p class="setting-description">${Helpers.escapeHtml(t('ui.usage.empty'))}</p>`;
    },

    setRange(range) {
        if (!RANGE_DAYS[range]) return;
        this.range = range;
        return this.render();
    },

    async copy() {
        await this.render();
        const head = t('ui.usage.copy_title', { range: t(`ui.usage.range_${this.range}`) });
        const text = [head, ...this.last.map(r => `${usageLabel(r.event)}: ${r.count}`)].join('\n');
        try {
            await navigator.clipboard.writeText(text);
            UIManager.showToast(t('msg.usage.copied'), 'success');
        } catch (_) {
            UIManager.showModal(text);
        }
    },

    async clear() {
        const ok = await UIManager.showModal(t('msg.usage.clear_confirm'), t('ui.usage.clear'), true);
        if (!ok) return;
        try {
            await Usage.clear();
        } catch (err) {
            console.warn('Usage not cleared:', err?.message || err);
        }
        await this.render();
    }
};
