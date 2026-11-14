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
import { estimateReportReads, groupLabel, mergeReportBills, quickItemSummary, quickPeriodOk, REPORT_COLLECTIONS, REPORT_GROUPS, REPORT_PRESETS, REPORT_TYPES, reportBillTypes, reportCsv, reportDays, reportPeriod, reportSheets, totalLabelKey } from '../utils/ask-report.js';
import { insightsSettings } from '../utils/insights-config.js';
import { exportFilename, stampPairs } from '../utils/export-stamp.js';
import { formatDay, formatDayTime } from '../utils/dates.js';
import { ensureXLSXWriter } from '../utils/lazy-scripts.js';
import { getQuotaStatus } from '../firebase/firestore-meter.js';
import { Exporter } from '../services/exporter.js';
import { UIManager } from '../ui/ui-manager.js';
import { historyCutoff } from '../utils/role-access.js';

const esc = (s) => Helpers.escapeHtml(String(s ?? ''));
const EXAMPLES = 6;
const MAX_ANSWERS = 10;
/** A quick figure reads about one stats doc per kind and year: more kinds than this wait for the bills. */
const QUICK_MAX_KINDS = 20;
const PAGE_NAMES = { day: 'ui.ask.open_today', due: 'ui.ask.open_outstanding', stock: 'ui.ask.open_stock' };
/** Bill type → the AppState list of the bills on the phone. */
const LOADED = { purchase: 'purchaseHistory', retail: 'retailSalesHistory', wholesale: 'salesHistory' };
const bills = (n) => tn('ui.today.bills_count', n);
const parties = (n) => tn('ui.ask.parties_count', n);
let seq = 0;
/** The oldest bill's time per collection: one read per signed-in person, shared by questions asked meanwhile. */
let oldest = { uid: undefined, promises: new Map() };

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
            .map(q => `<button type="button" class="chip ask-example" title="${esc(q)}" data-onclick="ask.ask('${Helpers.escapeJsAttr(q)}')">${esc(q)}</button>`)
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
        oldest = { uid: undefined, promises: new Map() };
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

    /** The role may see wholesale bills (all sales are retail only without it). */
    wholesale() {
        return AppState.userRole === 'owner' || can(AppState.userRole, 'wholesale', AppState.settings?.roleAccess);
    },

    /**
     * An item report (ASK-5, ASK-6) from the bills on the phone, plus the ones read for a report
     * earlier in this session. Without all the bills its period needs the owner gets no figures,
     * an estimate of the reads it would take, and the confirm loads them (loadOlder); a manager
     * gets the bills on the phone only, within History's days back.
     */
    async reportAnswer(entry) {
        const now = new Date();
        const role = AppState.userRole;
        const owner = role === 'owner';
        const access = AppState.settings?.roleAccess;
        const cfg = insightsSettings(AppState.settings?.insights);
        const windowFrom = FirebaseService.isFullHistoryLoaded() ? 0 : Number(FirebaseService.getHistoryWindowStart()) || 0;
        const { loadFrom } = reportPeriod(entry.q.range, now, cfg);
        const needOlder = windowFrom > 0 && (loadFrom === null || loadFrom < windowFrom);
        const types = reportBillTypes(entry.q.billType, this.wholesale());
        const held = needOlder && owner ? types.map(type => FirebaseService.reportBillsInMemory(REPORT_COLLECTIONS[type], loadFrom)) : [];
        const covered = !needOlder || (held.length > 0 && held.every(Boolean));
        const src = {};
        types.forEach((type, i) => {
            const coll = REPORT_COLLECTIONS[type];
            const loaded = AppState[LOADED[type]] || [];
            src[coll] = needOlder && covered ? mergeReportBills(loaded, held[i].bills, FirebaseService.voidedBills(coll).map(b => b.id), windowFrom) : loaded;
        });
        const answer = answerQuestion(entry.q, { bills: src, items: AppState.items }, {
            role, wholesale: this.wholesale(), reports: can(role, 'reports', access), today: now, cfg, covered,
            limitFrom: owner ? 0 : Math.max(windowFrom, historyCutoff(role, access, now.getTime()) || 0)
        });
        if (needOlder && covered) answer.readAt = Math.min(...held.map(h => h.readAt));
        if (answer.needsOlder) {
            answer.windowFrom = windowFrom;
            // bill types already read this session cost nothing more
            answer.estimate = await this.estimate(types.filter((_, i) => !held[i]), { windowFrom, now: now.getTime(), from: loadFrom });
            // The answer (and its Load button) never waits for the stats: the quick figure is added when it comes.
            this.quickPending = this.quickFigure(answer, types.map(type => ({ type, bills: src[REPORT_COLLECTIONS[type]] })), windowFrom, now)
                .then((quick) => {
                    if (!quick) return;
                    answer.quick = quick;
                    if (entry.answer === answer && this.mine().includes(entry)) this.renderAnswers();
                });
        }
        return answer;
    },

    /**
     * ASK-7: an older period's figures per kind at once from Insights › Seasons' item stats (a few
     * reads, no bills), while the bill-by-bill report waits for the owner's confirm. Only for kinds
     * named, grouped by kind, with no party; null when the stats can't give it.
     */
    async quickFigure(a, sources, windowFrom, now) {
        if (a.groupBy !== 'item' || a.party || a.maybeParty || !a.kinds?.length || a.kinds.length > QUICK_MAX_KINDS) return null;
        const catalogue = new Set((AppState.items || []).map(i => i.id));
        const ids = a.kinds.map(k => k.key).filter(k => catalogue.has(k));
        const quota = getQuotaStatus();
        if (!ids.length || quota.quota.count || quota.overCap || !quickPeriodOk(a.period, now)) return null;
        try {
            const held = await FirebaseService.reportItemStats(ids);
            return held ? quickItemSummary({ kinds: a.kinds, items: AppState.items, stats: held.docs, sources, period: a.period, windowFrom, now }) : null;
        } catch (e) {
            console.warn('Ask: item stats not read:', e?.message || e);
            return null;
        }
    },

    /** About how many reads loading the older bills of these bill types takes; null when not known. */
    async estimate(types, { windowFrom, now, from }) {
        const counts = await Promise.all(types.map(async type => estimateReportReads({
            loaded: AppState[LOADED[type]], windowFrom, now, oldest: await this.oldestBill(REPORT_COLLECTIONS[type]), from
        })));
        return counts.some(n => n === null) ? null : counts.reduce((a, n) => a + n, 0);
    },

    oldestBill(collKey) {
        const uid = this.uid();
        if (oldest.uid !== uid) oldest = { uid, promises: new Map() };
        const cache = oldest;
        if (!cache.promises.has(collKey)) {
            const promise = FirebaseService.oldestBillTime(collKey).catch((e) => {
                console.warn('Ask: oldest bill not read:', e?.message || e);
                if (cache.promises.get(collKey) === promise) cache.promises.delete(collKey);
                return null;
            });
            cache.promises.set(collKey, promise);
        }
        return cache.promises.get(collKey);
    },

    /** The owner's confirm, then one read of the older bills of the report's bill types (owner only). */
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
            for (const type of reportBillTypes(a.billType, this.wholesale())) {
                await FirebaseService.readReportBills(REPORT_COLLECTIONS[type], a.period.loadFrom);
            }
            entry.answer = await this.reportAnswer(entry);
        } catch (e) {
            console.warn('Ask: older bills not read:', e?.message || e);
            entry.answer = { ...a, loading: false, failed: true };
        } finally {
            entry.busy = false;
        }
        this.renderAnswers();
    },

    /** "Change": the report's bills, period or grouping picked by hand, answered again. */
    async changeReport(id, field, value) {
        const entry = this.mine().find(e => e.id === id);
        const allowed = { billType: REPORT_TYPES, range: REPORT_PRESETS, groupBy: REPORT_GROUPS }[field];
        if (!entry || entry.busy || entry.q?.intent !== 'item_report' || !allowed?.includes(value) || entry.q[field] === value) return;
        const q = { ...entry.q, [field]: value };
        // another bill type has other kinds
        if (field === 'billType') delete q.keys;
        await this.rerun(entry, q, field);
    },

    /** A kind added to or taken out of the report by hand. */
    async toggleKind(id, key) {
        const entry = this.mine().find(e => e.id === id);
        const a = entry?.answer;
        if (!a?.pool?.some(k => k.key === key) || entry.busy) return;
        const on = new Set((a.kinds || []).map(k => k.key));
        if (on.has(key)) on.delete(key); else on.add(key);
        await this.rerun(entry, { ...entry.q, keys: [...on] });
        const chips = [...document.querySelectorAll(`[data-ask-ctl="${entry.id}-kinds"] .ask-kind`)];
        chips[(entry.answer?.pool || []).findIndex(k => k.key === key)]?.focus();
    },

    async rerun(entry, q, field) {
        entry.busy = true;
        try {
            entry.q = q;
            entry.answer = await this.reportAnswer(entry);
        } finally {
            entry.busy = false;
        }
        this.renderAnswers();
        if (field) document.querySelector(`[data-ask-ctl="${entry.id}-${field}"]`)?.focus();
    },

    /** The report as an Excel book (Summary + one sheet per group), or CSV (owner only, Exporter). */
    async download(id, format) {
        const a = this.mine().find(e => e.id === id)?.answer;
        if (!a?.report || a.report.kgOnly) return false;
        let fmt = format === 'csv' ? 'csv' : 'xlsx';
        if (fmt === 'xlsx' && Exporter.allowed()) {
            try {
                await ensureXLSXWriter();
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
            // party names in the file: grouped by party, a party column (by month) or one party's bills
            names: a.report.groupBy !== 'item' || !!a.report.party,
            produce: (stamp) => {
                const sheets = reportSheets(a.report, { lang, stamp: stampPairs(stamp, lang) });
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

    /** "Change": the report's bills, period, grouping and kinds, picked by hand. */
    controlsHtml(a, id, itemName) {
        const jsId = Helpers.escapeJsAttr(id);
        const select = (field, value, options) => `<label class="ask-change-field">${esc(t(`ui.ask.change_${field}`))}`
            + `<select data-ask-ctl="${esc(`${id}-${field}`)}" data-onchange="ask.changeReport('${jsId}', '${Helpers.escapeJsAttr(field)}', this.value)">`
            + options.map(([v, label]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(label)}</option>`).join('')
            + '</select></label>';
        const types = REPORT_TYPES.filter(tp => tp !== 'wholesale' || this.wholesale());
        const on = new Set((a.kinds || []).map(k => k.key));
        const chips = (a.pool || []).map(k => `<button type="button" class="chip ask-kind" aria-pressed="${on.has(k.key) ? 'true' : 'false'}" `
            + `data-onclick="ask.toggleKind('${jsId}', '${Helpers.escapeJsAttr(k.key)}')">${esc(itemName(k) || t('ui.ask.no_item_name'))}</button>`).join('');
        return `<div class="ask-change">${select('billType', a.billType, types.map(tp => [tp, t(`ui.ask.type_${tp}`)]))}`
            + select('range', a.period.preset, REPORT_PRESETS.map(p => [p, this.periodLabel(p)]))
            + select('groupBy', a.groupBy, REPORT_GROUPS.map(g => [g, t(`ui.ask.group_${g}`)]))
            + '</div>'
            + (chips ? `<div class="ask-kinds" role="group" data-ask-ctl="${esc(`${id}-kinds`)}" aria-label="${esc(t('ui.ask.change_kinds'))}">${chips}</div>` : '');
    },

    /** ASK-7 quick figure lines ('' when there is none). */
    quickHtml(a, { line, label }) {
        const q = a.quick;
        if (!q) return '';
        const figures = (x) => ({ kg: formatKg(x.kg), rate: x.avgRate === null ? '—' : formatRate(x.avgRate), amount: formatRupees(x.amount) });
        let html = line(t(a.billType === 'purchase' ? 'ui.ask.quick_head_purchase' : 'ui.ask.quick_head_sale'));
        html += q.groups.length
            ? q.groups.map(g => line(t('ui.ask.report_kind', { name: label(g), ...figures(g.totals), bills: bills(g.totals.bills) }))).join('')
            : line(t('ui.ask.report_none'));
        if (q.groups.length > 1) html += line(t('ui.ask.quick_total', { name: t('ui.ask.total_kinds'), ...figures(q.totals) }));
        if (q.left.length) html += line(t('ui.ask.quick_left', { names: q.left.map(label).join(', ') }));
        return html;
    },

    /** One item report answer (ASK-5, ASK-6) as HTML. */
    reportHtml(a, id, { line, choose, itemName }) {
        if (a.notAllowed) return line(t('ui.ask.report_not_allowed'));
        const lang = getLang();
        const named = (k) => itemName(k) || t('ui.ask.no_item_name');
        const controls = this.controlsHtml(a, id, itemName);
        let html = line(t('ui.ask.report_head', { type: t(`ui.ask.type_${a.billType}`), period: this.periodLabel(a.period.preset) }))
            + (a.party ? line(t('ui.ask.report_party', { name: a.party })) : '')
            + (a.retailOnly ? line(t('ui.ask.report_retail_only')) : '');
        if (a.partyMatches) return html + choose(a.partyMatches, a.partyMore) + controls;
        if (a.notItems) return html + line(t('ui.ask.report_not_item', { words: a.notItems.join(' ') })) + controls;
        if (a.kinds && !a.kinds.length && !a.noKinds && !a.needsOlder && a.limited === undefined) {
            return html + (a.near.length ? choose(a.near.map(named), a.nearMore) : line(t('ui.ask.report_nothing_named', { name: a.subject }))) + controls;
        }
        html += a.kinds === null ? line(t('ui.ask.report_all_items'))
            : a.kinds.length ? line(t('ui.ask.report_kinds', { names: a.kinds.map(named).join(', ') }))
                : line(t(a.noKinds ? 'ui.ask.report_pick_kind' : 'ui.ask.report_no_item_here', { name: a.subject }));
        if (a.near.length && !a.picked) html += line(t('ui.ask.report_not_included', { names: a.near.map(named).join(', ') }));
        if (a.noKinds) return html + controls;
        if (a.limited !== undefined) return html + line(t('ui.ask.report_limited', { date: formatDay(a.limited, { lang }) })) + controls;
        if (a.needsOlder) {
            if (a.stopped) return html + line(t('ui.ask.report_quota')) + controls;
            const quickHtml = this.quickHtml(a, { line, label: named });
            if (a.loading) return html + quickHtml + line(t('ui.ask.report_loading'));
            return html + quickHtml + line(t(a.failed ? 'ui.ask.report_load_failed' : 'ui.ask.report_needs_older', { date: formatDay(a.windowFrom, { lang }) }))
                + (quickHtml ? line(t('ui.ask.quick_exact')) : '')
                + `<button type="button" class="btn btn-sm ask-open ask-load" data-onclick="ask.loadOlder('${Helpers.escapeJsAttr(id)}')">${esc(t('ui.ask.report_load'))}</button>`
                + controls;
        }
        const r = a.report;
        if (!r) return html + controls;
        const shown = r.groups.filter(g => g.totals.bills);
        if (!shown.length) return html + line(t('ui.ask.report_none')) + controls;
        const label = (g) => groupLabel(r, g, lang);
        if (r.kgOnly) {
            const kg = (name, x) => line(t('ui.ask.report_kind_kg', { name, kg: formatKg(x.kg), bills: bills(x.bills) }));
            html += shown.map(g => kg(label(g), g.totals)).join('');
            if (shown.length > 1) html += kg(t(totalLabelKey(r)), r.totals);
            return html + controls;
        }
        const figures = (x) => ({ kg: formatKg(x.kg), rate: x.avgRate === null ? '—' : formatRate(x.avgRate), amount: formatRupees(x.amount), net: formatRupees(x.net), bills: bills(x.bills) });
        html += shown.map(g => line(t('ui.ask.report_kind', { name: label(g), ...figures(g.totals) }))).join('');
        if (shown.length > 1) html += line(t('ui.ask.report_kind', { name: t(totalLabelKey(r)), ...figures(r.totals) }));
        if (r.billType === 'purchase') html += line(t('ui.ask.report_after_labour', figures(r.totals)));
        if (r.totals.billsTotal !== null) html += line(t('ui.ask.report_bills_total', { amount: formatRupees(r.totals.billsTotal) }));
        if (a.readAt) html += line(t('ui.ask.report_as_of', { time: formatDayTime(a.readAt, { lang }) }));
        if (Exporter.allowed()) {
            html += `<button type="button" class="btn btn-sm ask-open ask-xlsx" data-onclick="ask.download('${Helpers.escapeJsAttr(id)}', 'xlsx')">${esc(t('ui.ask.download_excel'))}</button>`
                + `<button type="button" class="btn btn-sm ask-open ask-csv" data-onclick="ask.download('${Helpers.escapeJsAttr(id)}', 'csv')">${esc(t('ui.ask.download_csv'))}</button>`;
        }
        return html + controls;
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
        const open = a.page ? `<button type="button" class="btn btn-sm ask-open" data-onclick="nav.showTab('${a.page}', event)">${esc(t(PAGE_NAMES[a.page]))}</button>` : '';
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
