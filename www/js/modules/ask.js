/**
 * @fileoverview Ask page (#88): a box for short questions answered from the
 * data already on this phone, offline, no AI. utils/ask.js understands the
 * question and works out the answer with the home pages' own functions; this
 * module only gathers AppState and renders. Imported on first open.
 * @module modules/ask
 */

import { AppState } from '../utils/state.js';
import { Helpers } from '../utils/helpers.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { t, tn, getLang } from '../i18n/index.js';
import { formatKg, formatRate, formatRupees } from '../utils/money.js';
import { can } from '../utils/role-access.js';
import { parseQuestion, answerQuestion } from '../utils/ask.js';
import { approxStockNote } from '../utils/stock-check.js';
import { pickLang } from '../i18n/localize.js';
import { estimateReportReads, mergeReportBills, reportCsv, reportDays, reportPeriod, reportSheets } from '../utils/ask-report.js';
import { insightsSettings } from '../utils/insights-config.js';
import { exportFilename, stampPairs } from '../utils/export-stamp.js';
import { formatDay, formatDayTime } from '../utils/dates.js';
import { ensureXLSX } from '../utils/lazy-scripts.js';
import { getQuotaStatus } from '../firebase/firestore-meter.js';
import { Exporter } from '../services/exporter.js';
import { UIManager } from '../ui/ui-manager.js';

const esc = (s) => Helpers.escapeHtml(String(s ?? ''));
const EXAMPLES = 6;
const MAX_ANSWERS = 10;
const PAGE_NAMES = { day: 'ui.ask.open_today', due: 'ui.ask.open_outstanding', stock: 'ui.ask.open_stock' };
const bills = (n) => tn('ui.today.bills_count', n);
const parties = (n) => tn('ui.ask.parties_count', n);
let seq = 0;
/** The oldest purchase's time: one read per signed-in person, shared by questions asked meanwhile. */
let oldest = { uid: undefined, promise: null };

export const AskManager = {
    answers: [],

    init() {
        this.renderExamples();
        this.renderAnswers();
        const input = document.getElementById('askInput');
        if (input && !window.matchMedia?.('(pointer: coarse)')?.matches) input.focus();
    },

    renderExamples() {
        const host = document.getElementById('askExamples');
        if (!host) return;
        host.innerHTML = Array.from({ length: EXAMPLES }, (_, i) => t(`ui.ask.example_${i + 1}`))
            .map(q => `<button type="button" class="filter-btn ask-example" data-onclick="ask.ask('${Helpers.escapeJsAttr(q)}')">${esc(q)}</button>`)
            .join('');
    },

    submit(event) {
        event?.preventDefault?.();
        const input = document.getElementById('askInput');
        const text = String(input?.value || '').trim();
        if (!text) return;
        if (input) input.value = '';
        return this.ask(text);
    },

    async ask(text) {
        const q = parseQuestion(text);
        if (q.intent === 'item_report') {
            const entry = { uid: this.uid(), id: `a${++seq}`, question: text, q, answer: null };
            entry.answer = await this.reportAnswer(entry);
            this.answers = [entry, ...this.mine()].slice(0, MAX_ANSWERS);
            this.renderAnswers();
            return entry.answer;
        }
        let stockReady = true;
        let stockFailed = false;
        if (q.intent === 'item_stock' && q.subject) {
            try {
                await FirebaseService.getStock();
            } catch (e) {
                console.warn('Ask: stock not loaded:', e?.message || e);
                stockFailed = true;
            }
            stockReady = !stockFailed && AppState.stockReady !== false;
        }
        const answer = answerQuestion(q, {
            bills: { purchases: AppState.purchaseHistory, retailSales: AppState.retailSalesHistory, wholesaleSales: AppState.salesHistory },
            expenses: AppState.expensesHistory,
            stock: AppState.stock,
            items: AppState.items,
            settings: AppState.settings
        }, {
            role: AppState.userRole,
            wholesale: can(AppState.userRole, 'wholesale', AppState.settings?.roleAccess),
            stockReady,
            today: new Date()
        });
        if (answer.intent === 'item_stock') Object.assign(answer, { failed: stockFailed, approx: stockFailed ? null : AppState.stockApprox || null });
        this.answers = [{ uid: this.uid(), id: `a${++seq}`, question: text, answer }, ...this.mine()].slice(0, MAX_ANSWERS);
        this.renderAnswers();
        return answer;
    },

    /** Sign-out: nothing of this person's answers stays on the page. */
    reset() {
        this.answers = [];
        oldest = { uid: undefined, promise: null };
        const host = document.getElementById('askAnswers');
        if (host) host.innerHTML = '';
    },

    uid() {
        return AppState.currentUser?.uid || null;
    },

    /** Answers asked by the person signed in now (another sign-in on this phone never sees them). */
    mine() {
        const uid = this.uid();
        return this.answers.filter(a => a.uid === uid);
    },

    /**
     * An item report (ASK-5) from the bills on the phone, plus the ones read for a report
     * earlier in this session. Without all the bills its period needs: no figures, an estimate
     * of the reads it would take, and the owner's confirm loads them (loadOlder).
     */
    async reportAnswer(entry) {
        const now = new Date();
        const cfg = insightsSettings(AppState.settings?.insights);
        const windowFrom = FirebaseService.isFullHistoryLoaded() ? 0 : Number(FirebaseService.getHistoryWindowStart()) || 0;
        const { loadFrom } = reportPeriod(entry.q.range, now, cfg);
        const needOlder = windowFrom > 0 && (loadFrom === null || loadFrom < windowFrom);
        const held = needOlder ? FirebaseService.reportBillsInMemory('purchases', loadFrom) : null;
        const purchases = held
            ? mergeReportBills(AppState.purchaseHistory, held.bills, FirebaseService.voidedBills('purchases').map(b => b.id))
            : AppState.purchaseHistory;
        const answer = answerQuestion(entry.q, { bills: { purchases }, items: AppState.items }, {
            role: AppState.userRole, today: now, cfg, covered: !needOlder || !!held
        });
        if (held) answer.readAt = held.readAt;
        if (answer.needsOlder) {
            answer.windowFrom = windowFrom;
            answer.estimate = estimateReportReads({ loaded: AppState.purchaseHistory, windowFrom, now: now.getTime(), oldest: await this.oldestPurchase(), from: loadFrom });
        }
        return answer;
    },

    oldestPurchase() {
        const uid = this.uid();
        if (oldest.uid !== uid || !oldest.promise) {
            const entry = { uid, promise: null };
            entry.promise = FirebaseService.oldestBillTime('purchases').catch((e) => {
                console.warn('Ask: oldest purchase not read:', e?.message || e);
                if (oldest === entry) oldest = { uid: undefined, promise: null };
                return null;
            });
            oldest = entry;
        }
        return oldest.promise;
    },

    /** The owner's confirm, then one read of the older purchase bills (owner only). */
    async loadOlder(id) {
        const entry = this.mine().find(e => e.id === id);
        const a = entry?.answer;
        if (!a?.needsOlder || entry.busy || !Exporter.allowed()) return;
        const quota = getQuotaStatus();
        if (quota.quota.count || quota.overCap) {
            entry.answer = { ...a, stopped: true };
            this.renderAnswers();
            return;
        }
        const text = a.estimate ? t('msg.ask.load_confirm', { count: a.estimate.toLocaleString('en-IN') }) : t('msg.ask.load_confirm_unknown');
        if (!(await UIManager.showModal(text, t('msg.ask.load_title'), true))) return;
        entry.busy = true;
        entry.answer = { ...a, loading: true, failed: false };
        this.renderAnswers();
        try {
            await FirebaseService.readReportBills('purchases', a.period.loadFrom);
            entry.answer = await this.reportAnswer(entry);
        } catch (e) {
            console.warn('Ask: older purchases not read:', e?.message || e);
            entry.answer = { ...a, loading: false, failed: true };
        } finally {
            entry.busy = false;
        }
        this.renderAnswers();
    },

    /** The report as an Excel book (Summary + one sheet per kind), or CSV (owner only, Exporter). */
    async download(id, format) {
        const a = this.mine().find(e => e.id === id)?.answer;
        if (!a?.report) return false;
        let fmt = format === 'csv' ? 'csv' : 'xlsx';
        if (fmt === 'xlsx' && Exporter.allowed()) {
            try {
                await ensureXLSX();
            } catch (e) {
                console.warn('Ask: Excel not loaded:', e?.message || e);
                UIManager.showToast(t('msg.ask.excel_offline'));
                fmt = 'csv';
            }
        }
        const lang = getLang();
        const label = this.periodLabel(a.period.preset);
        return Exporter.run({
            kind: 'ask', format: fmt, period: { ...reportDays(a.period, new Date()), label }, rows: a.report.rowCount,
            produce: (stamp) => {
                const sheets = reportSheets(a.report, { lang, stamp: stampPairs(stamp, lang), period: label });
                const name = exportFilename(stamp, 'item-report', fmt);
                return fmt === 'xlsx'
                    ? Exporter.saveWorkbook(sheets, name)
                    : Exporter.saveBlob(new Blob([reportCsv(sheets)], { type: 'text/csv;charset=utf-8;' }), name, { shareFirst: false });
            }
        });
    },

    periodLabel(preset) {
        return t(`ui.ask.period_${String(preset).replace(/-/g, '_')}`);
    },

    /** One item report answer (ASK-5) as HTML. */
    reportHtml(a, id, { line, choose, itemName }) {
        if (a.ownerOnly) return line(t('ui.ask.report_owner_only'));
        if (a.notItems) return line(t('ui.ask.report_not_item', { words: a.notItems.join(' ') }));
        if (!a.kinds.length && !a.needsOlder) return a.near.length ? choose(a.near.map(itemName), a.nearMore) : line(t('ui.ask.no_item', { name: a.subject }));
        const lang = getLang();
        let html = line(t('ui.ask.report_head', { period: this.periodLabel(a.period.preset) }))
            + line(a.kinds.length ? t('ui.ask.report_kinds', { names: a.kinds.map(itemName).join(', ') }) : t('ui.ask.report_no_item_here', { name: a.subject }))
            + (a.near.length ? line(t('ui.ask.report_not_included', { names: a.near.map(itemName).join(', ') })) : '');
        if (a.needsOlder) {
            if (a.stopped) return html + line(t('ui.ask.report_quota'));
            if (a.loading) return html + line(t('ui.ask.report_loading'));
            return html + line(t(a.failed ? 'ui.ask.report_load_failed' : 'ui.ask.report_needs_older', { date: formatDay(a.windowFrom, { lang }) }))
                + `<button type="button" class="filter-btn ask-open" data-onclick="ask.loadOlder('${Helpers.escapeJsAttr(id)}')">${esc(t('ui.ask.report_load'))}</button>`;
        }
        const shown = a.report.groups.filter(g => g.totals.bills);
        if (!shown.length) return html + line(t('ui.ask.report_none'));
        const figures = (x) => ({ kg: formatKg(x.kg), rate: x.avgRate === null ? '—' : formatRate(x.avgRate), amount: formatRupees(x.amount), net: formatRupees(x.net), bills: bills(x.bills) });
        html += shown.map(g => line(t('ui.ask.report_kind', { name: itemName(g), ...figures(g.totals) }))).join('');
        if (shown.length > 1) html += line(t('ui.ask.report_total', figures(a.report.totals)));
        html += line(t('ui.ask.report_after_labour', figures(a.report.totals)));
        if (a.readAt) html += line(t('ui.ask.report_as_of', { time: formatDayTime(a.readAt, { lang }) }));
        if (!Exporter.allowed()) return html;
        return html + `<button type="button" class="filter-btn ask-open" data-onclick="ask.download('${Helpers.escapeJsAttr(id)}', 'xlsx')">${esc(t('ui.ask.download_excel'))}</button>`
            + `<button type="button" class="filter-btn ask-open" data-onclick="ask.download('${Helpers.escapeJsAttr(id)}', 'csv')">${esc(t('ui.ask.download_csv'))}</button>`;
    },

    renderAnswers() {
        const host = document.getElementById('askAnswers');
        if (!host) return;
        this.answers = this.mine();
        host.innerHTML = this.answers.map(a => `<div class="ask-answer"><div class="ask-question">${esc(a.question)}</div>${this.answerHtml(a.answer, a.id)}</div>`).join('');
    },

    /** One answer as HTML (text from t(), names escaped). */
    answerHtml(a, id) {
        const line = (text) => `<div class="ask-line">${esc(text)}</div>`;
        const open = a.page ? `<button type="button" class="filter-btn ask-open" data-onclick="nav.showTab('${a.page}', event)">${esc(t(PAGE_NAMES[a.page]))}</button>` : '';
        const choose = (names, more) => line(t('ui.ask.did_you_mean', { names: names.join(', ') }))
            + (more ? line(tn('ui.ask.and_more', more)) : '');
        const itemName = (n) => (getLang() === 'hi' && n.hindiName ? n.hindiName : n.name);

        switch (a.intent) {
        case 'today_only':
            return line(t('ui.ask.today_only'));
        case 'help':
            return line(t('ui.ask.help'));
        case 'sales_today':
        case 'purchases_today':
        case 'expenses_today':
            return line(t(`ui.ask.ans_${a.intent}`, { amount: formatRupees(a.amount), bills: bills(a.count), entries: tn('ui.ask.entries_count', a.count) })) + open;
        case 'total_due':
            return line(t('ui.ask.ans_total_receive', { amount: formatRupees(a.receive), parties: parties(a.receiveCount) }))
                + line(t('ui.ask.ans_total_pay', { amount: formatRupees(a.pay), parties: parties(a.payCount) })) + open;
        case 'party_due':
            if (!a.name) {
                return (a.matches.length ? choose(a.matches, a.more) : line(t('ui.ask.no_party', { name: a.subject }))) + open;
            }
            return (a.receive ? line(t('ui.ask.ans_party_receive', { name: a.name, amount: formatRupees(a.receive.total), bills: bills(a.receive.count) })) : '')
                + (a.pay ? line(t('ui.ask.ans_party_pay', { name: a.name, amount: formatRupees(a.pay.total), bills: bills(a.pay.count) })) : '')
                + open;
        case 'item_report':
            return this.reportHtml(a, id, { line, choose, itemName });
        case 'item_stock':
            if (a.needsItem) return line(t('ui.ask.which_item'));
            if (a.failed) return line(t('ui.ask.stock_failed')) + open;
            if (a.updating) return line(t('ui.ask.stock_updating')) + open;
            if (!a.name) {
                return (a.matches.length ? choose(a.matches.map(itemName), a.more) : line(t('ui.ask.no_item', { name: a.subject }))) + open;
            }
            return line(a.limited ? t('ui.ask.ans_stock_available', { name: itemName(a) })
                : a.quantity > 0 ? t('ui.ask.ans_stock', { name: itemName(a), kg: formatKg(a.quantity) })
                    : t('ui.ask.ans_stock_none', { name: itemName(a) }))
                + (a.approx ? line(pickLang(approxStockNote(a.approx))) : '') + open;
        default:
            return line(t('ui.ask.unknown'));
        }
    }
};
