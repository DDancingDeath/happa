/**
 * @fileoverview Statements page (docs/insights-redesign.md §5.4): day book,
 * month statement, party ledger, item ledger and the CSV export, each with
 * WhatsApp, Print / PDF and CSV. Rows come from utils/statements.js and
 * utils/business-metrics.js; this module only renders and shares.
 * @module modules/statements
 */

import { AppState } from '../utils/state.js';
import { Helpers } from '../utils/helpers.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { UIManager } from '../ui/ui-manager.js';
import { t, getLang } from '../i18n/index.js';
import { formatRupees } from '../utils/money.js';
import { formatDay, formatMonth, formatDayTime, toLocalISODate, parseLocalDate, todayLocalISO } from '../utils/dates.js';
import { pickReplayBase } from '../utils/finance-calc.js';
import { historyLoadedFrom, isFullHistoryLoaded, ensureHistoryFrom } from '../utils/history-window.js';
import { openExternal } from '../utils/open-external.js';
import { moneySummary } from '../utils/business-metrics.js';
import { dayBook, partyLedger, partyChoices, itemLedger, exportLines, toCsv } from '../utils/statements.js';
import { getInsightsContext, setInsightsContext } from '../utils/insights-context.js';
import { monthBounds, monthKeyOf } from '../utils/month-snapshots.js';
import { APP_IDENTITY } from '../config/app-identity.js';

const esc = (s) => Helpers.escapeHtml(String(s ?? ''));
const money = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '—' : formatRupees(Number(v)));
const KINDS = ['day', 'month', 'party', 'item', 'csv'];

export const StatementsManager = {
    kind: null,
    day: null,
    month: null,
    partyKind: 'customer',
    partyKey: null,
    itemKey: null,
    csvFrom: null,
    csvTo: null,
    current: null,

    init(route) {
        if (route && KINDS.includes(route)) this.open(route);
        else this.back();
    },

    back() {
        this.kind = null;
        const list = document.getElementById('statementsList');
        const view = document.getElementById('statementsView');
        if (list) list.hidden = false;
        if (view) view.hidden = true;
    },

    open(kind) {
        if (!KINDS.includes(kind)) return;
        this.kind = kind;
        const list = document.getElementById('statementsList');
        const view = document.getElementById('statementsView');
        if (list) list.hidden = true;
        if (view) view.hidden = false;
        const now = new Date();
        if (!this.day) this.day = todayLocalISO();
        if (!this.month) {
            const m = /^month:(\d{4}-\d{2})$/.exec(getInsightsContext().preset);
            this.month = m ? m[1] : monthKeyOf(now.getTime());
        }
        if (!this.itemKey) this.itemKey = getInsightsContext().itemId;
        if (!this.csvFrom) this.csvFrom = toLocalISODate(new Date(now.getFullYear(), now.getMonth(), 1));
        if (!this.csvTo) this.csvTo = todayLocalISO();
        this.renderControls();
        this.render();
    },

    /** Chooses the party the ledger opens on next (Insights › Parties row). */
    selectParty(partyKey, kind = 'customer') {
        this.partyKey = partyKey || null;
        this.partyKind = kind === 'supplier' ? 'supplier' : 'customer';
    },

    /** Party ledger for a party (from Insights › Parties or Outstanding). */
    openParty(partyKey, kind = 'customer') {
        this.partyKey = partyKey;
        this.partyKind = kind === 'supplier' ? 'supplier' : 'customer';
        this.open('party');
    },

    src() {
        return {
            purchases: AppState.purchaseHistory || [],
            wholesaleSales: AppState.salesHistory || [],
            retailSales: AppState.retailSalesHistory || [],
            stockAdjustments: AppState.stockAdjustments || [],
            expenses: AppState.expensesHistory || [],
            withdrawals: AppState.withdrawalsHistory || []
        };
    },

    covered(from) {
        return isFullHistoryLoaded() || (Number.isFinite(from) && from >= historyLoadedFrom());
    },

    renderControls() {
        const lang = getLang();
        const heading = { day: 'ui.statements.day_book', month: 'ui.statements.month', party: 'ui.statements.party', item: 'ui.statements.item', csv: 'ui.statements.csv' }[this.kind];
        const h = document.getElementById('statementsHeading');
        if (h) h.textContent = t(heading);
        let html = '';
        if (this.kind === 'day') {
            html = `<label>${esc(t('ui.statements.pick_day'))} <input type="date" class="form-control" value="${esc(this.day)}" onchange="window.app.statements.set('day', this.value)"></label>`;
        } else if (this.kind === 'month') {
            const now = new Date();
            const opts = Array.from({ length: 24 }, (_, i) => monthKeyOf(new Date(now.getFullYear(), now.getMonth() - i, 1).getTime()));
            html = `<label>${esc(t('ui.statements.pick_month'))} <select class="form-control" onchange="window.app.statements.set('month', this.value)">${opts.map(k => `<option value="${k}"${k === this.month ? ' selected' : ''}>${esc(formatMonth(monthBounds(k).from, { lang }))}</option>`).join('')}</select></label>`;
        } else if (this.kind === 'party') {
            const parties = partyChoices(this.src(), this.partyKind);
            if (!this.partyKey || !parties.some(p => p.key === this.partyKey)) this.partyKey = parties[0]?.key || null;
            html = `<div class="ins-tabs ins-subtabs"><button type="button" class="ins-tab${this.partyKind === 'customer' ? ' active' : ''}" onclick="window.app.statements.set('partyKind', 'customer')">${esc(t('ui.insights.customers'))}</button>`
                + `<button type="button" class="ins-tab${this.partyKind === 'supplier' ? ' active' : ''}" onclick="window.app.statements.set('partyKind', 'supplier')">${esc(t('ui.insights.suppliers'))}</button></div>`
                + `<label>${esc(t('ui.insights.party'))} <select class="form-control" onchange="window.app.statements.set('partyKey', this.value)">${parties.map(p => `<option value="${esc(p.key)}"${p.key === this.partyKey ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>`;
        } else if (this.kind === 'item') {
            const items = (AppState.items || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
            if (!this.itemKey || !items.some(i => i.id === this.itemKey)) this.itemKey = items[0]?.id || null;
            html = `<label>${esc(t('ui.insights.item'))} <select class="form-control" onchange="window.app.statements.set('itemKey', this.value)">${items.map(i => `<option value="${esc(i.id)}"${i.id === this.itemKey ? ' selected' : ''}>${esc(lang === 'hi' ? i.hindiName || i.name : i.name)}</option>`).join('')}</select></label>`;
        } else if (this.kind === 'csv') {
            html = `<label>${esc(t('ui.statements.from'))} <input type="date" class="form-control" value="${esc(this.csvFrom)}" onchange="window.app.statements.set('csvFrom', this.value)"></label>`
                + `<label>${esc(t('ui.statements.to'))} <input type="date" class="form-control" value="${esc(this.csvTo)}" onchange="window.app.statements.set('csvTo', this.value)"></label>`;
        }
        const el = document.getElementById('statementsControls');
        if (el) el.innerHTML = html;
    },

    set(field, value) {
        if (!['day', 'month', 'partyKind', 'partyKey', 'itemKey', 'csvFrom', 'csvTo'].includes(field)) return;
        this[field] = value;
        if (field === 'partyKind') this.partyKey = null;
        if (field === 'itemKey') setInsightsContext({ itemId: value });
        this.renderControls();
        this.render();
    },

    render() {
        const doc = document.getElementById('statementsDoc');
        if (!doc || !this.kind) return;
        const fn = { day: 'renderDay', month: 'renderMonth', party: 'renderParty', item: 'renderItem', csv: 'renderCsv' }[this.kind];
        this.current = this[fn]();
        doc.innerHTML = this.current.html;
    },

    notLoaded(label, from) {
        return {
            title: label, html: `<div class="ins-empty"><p>${esc(t('ui.money.older_not_loaded', { period: label }))}</p><button type="button" class="btn btn-primary" onclick="window.app.statements.loadOlder(${Number.isFinite(from) ? from : 'null'})">${esc(t('ui.money.load_older'))}</button></div>`,
            share: '', csvHeader: [], csvRows: []
        };
    },

    async loadOlder(from) {
        try {
            const ok = await ensureHistoryFrom(from === null ? null : new Date(from));
            if (!ok) UIManager.showToast(t('msg.money.could_not_load'));
        } catch (e) {
            console.error('Statements: loading older bills failed:', e);
            UIManager.showToast(t('msg.money.could_not_load'));
        }
        this.renderControls();
        this.render();
    },

    kindLabel(kind) {
        return t(`ui.statements.k_${String(kind).replace(/[A-Z]/g, ch => `_${ch.toLowerCase()}`)}`);
    },

    renderDay() {
        const lang = getLang();
        const d = parseLocalDate(this.day) || new Date();
        const from = d.getTime();
        const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
        const title = `${t('ui.statements.day_book')} · ${formatDay(d, { lang })}`;
        if (!this.covered(from)) return this.notLoaded(formatDay(d, { lang }), from);
        const { rows, totals } = dayBook(this.src(), { from, to });
        const isToday = this.day === todayLocalISO();
        const body = rows.map(r => `<tr><td>${esc(r.t ? formatDayTime(r.t, { lang }).split(', ').pop() : '')}</td><td>${esc(this.kindLabel(r.kind))}</td><td>${esc([r.billNo, r.party, r.note].filter(Boolean).join(' · '))}</td><td class="num">${money(r.amount)}</td><td class="num">${r.due ? money(r.due) : ''}</td></tr>`).join('');
        const tot = [
            ['ui.statements.t_sales', totals.sales, totals.salesCount], ['ui.statements.t_purchases', totals.purchases, totals.purchaseCount],
            ['ui.statements.t_expenses', totals.expenses], ['ui.statements.t_withdrawals', totals.withdrawals],
            ['ui.statements.t_due_received', totals.dueReceived], ['ui.statements.t_due_paid', totals.duePaid]
        ];
        const html = (isToday ? `<p class="ins-hint"><button type="button" class="ins-link" onclick="window.app.nav.showTab('day')">${esc(t('ui.statements.today_link'))} ›</button></p>` : '')
            + `<h3 class="st-title">${esc(title)}</h3>`
            + `<div class="ins-scroll"><table class="ins-table"><thead><tr><th>${esc(t('ui.statements.time'))}</th><th>${esc(t('ui.statements.what'))}</th><th>${esc(t('ui.statements.details'))}</th><th class="num">${esc(t('ui.money.amount'))}</th><th class="num">${esc(t('ui.statements.due'))}</th></tr></thead><tbody>${body || `<tr><td colspan="5">${esc(t('ui.statements.nothing'))}</td></tr>`}</tbody></table></div>`
            + `<div class="st-totals">${tot.map(([k, v, c]) => `<div class="ins-row"><span>${esc(t(k))}${c !== undefined ? ` (${c})` : ''}</span><span data-metric-export="${k === 'ui.statements.t_sales' ? 'M1' : k === 'ui.statements.t_purchases' ? 'M16' : 'M4'}">${money(v)}</span></div>`).join('')}</div>`;
        const share = [title, ...tot.map(([k, v]) => `${t(k)}: ${formatRupees(v)}`)].join('\n');
        const csvHeader = [t('ui.statements.time'), t('ui.statements.what'), t('ui.statements.bill_no'), t('ui.insights.party'), t('ui.statements.details'), t('ui.money.amount'), t('ui.statements.cash'), t('ui.statements.online'), t('ui.statements.due')];
        const csvRows = rows.map(r => [r.t ? formatDayTime(r.t, { lang }) : '', this.kindLabel(r.kind), r.billNo, r.party, r.note, r.amount, r.cash, r.online, r.due]);
        return { title, html, share, csvHeader, csvRows };
    },

    renderMonth() {
        const lang = getLang();
        const b = monthBounds(this.month);
        const to = Math.min(b.to, Date.now() + 1);
        const label = formatMonth(b.from, { lang });
        const title = `${t('ui.statements.month')} · ${label}`;
        if (!this.covered(b.from)) return this.notLoaded(label, b.from);
        const base = pickReplayBase({ checkpoint: FirebaseService.getStockCheckpointState?.() || null, fullHistory: isFullHistoryLoaded(), from: b.from });
        const m = moneySummary({ ...this.src(), items: AppState.items || [], base }, { from: b.from, to });
        const lines = [
            ['ui.money.sales', m.M1.total, 'M1'], ['ui.money.cogs_minus', m.M2, 'M2'], ['ui.money.gross_eq', m.M3.total, 'M3'],
            ['ui.money.business_minus', m.M4.total, 'M4'], ['ui.money.bad_debts_minus', m.M5, 'M5'], ['ui.money.profit_eq', m.M6.total, 'M6'],
            ['ui.money.labour_line', m.M7, 'M7'], ['ui.money.personal_expenses', m.M8.total, 'M8'], ['ui.money.withdrawals', m.M9, 'M9'],
            ['ui.money.kept', m.M10, 'M10'], ['ui.money.money_in', m.M12.total, 'M12'], ['ui.money.money_out', m.M13.total, 'M13'],
            ['ui.money.net_money', m.M14, 'M14'], ['ui.money.bought', m.M16.total, 'M16']
        ];
        const stock = m.M17 ? [['ui.money.opening_stock', m.M17.opening], ['ui.money.closing_stock', m.M17.closing]] : [];
        const html = `<h3 class="st-title">${esc(title)}</h3>`
            + lines.map(([k, v, id]) => `<div class="ins-row${/eq$|kept|net_money/.test(k) ? ' ins-total' : ''}"><span>${esc(t(k))}</span><span data-metric-export="${id}">${money(v)}</span></div>`).join('')
            + stock.map(([k, v]) => `<div class="ins-row ins-sub"><span>${esc(t(k))}</span><span>${money(v)}</span></div>`).join('')
            + (m.caveats.length ? m.caveats.map(c => `<div class="ins-caveat">⚠ ${esc(t(`ui.money.caveat_${c.key}`, { qty: c.qty, amount: Math.round(c.estimate ?? c.amount ?? c.gap ?? 0) }))}</div>`).join('') : '');
        const share = [title, ...lines.map(([k, v]) => `${t(k).replace(/^[−=+±]\s*/, '')}: ${v === null ? '—' : formatRupees(v)}`)].join('\n');
        return { title, html, share, csvHeader: [t('ui.statements.what'), t('ui.money.amount')], csvRows: lines.map(([k, v]) => [t(k), v === null ? '' : v]) };
    },

    renderParty() {
        const lang = getLang();
        if (!this.partyKey) return { title: t('ui.statements.party'), html: `<p class="ins-empty-text">${esc(t('ui.insights.no_parties'))}</p>`, share: '', csvHeader: [], csvRows: [] };
        const l = partyLedger(this.src(), this.partyKey, this.partyKind);
        const title = `${t('ui.statements.party')} · ${l.name}`;
        const matches = Math.abs(l.closing - l.due) <= 1;
        const word = (v) => t(this.partyKind === 'supplier' ? 'ui.statements.to_pay' : 'ui.statements.to_receive', { amount: formatRupees(Math.abs(v)) });
        const body = l.rows.map(r => `<tr><td>${esc(formatDay(r.t, { lang }))}</td><td>${esc([this.kindLabel(r.kind), r.billNo].filter(Boolean).join(' · '))}</td><td class="num">${r.debit ? money(r.debit) : ''}</td><td class="num">${r.credit ? money(r.credit) : ''}</td><td class="num">${money(r.balance)}</td></tr>`).join('');
        const loadedNote = isFullHistoryLoaded() ? '' : `<p class="ins-hint">${esc(t('ui.statements.loaded_only'))} <button type="button" class="ins-link" onclick="window.app.statements.loadOlder(null)">${esc(t('ui.money.load_older'))}</button></p>`;
        const html = `<h3 class="st-title">${esc(title)}</h3>`
            + `<div class="ins-hero st-balance"><div class="ins-hero-label">${esc(t('ui.statements.balance'))}</div><div class="ins-hero-value" data-metric-export="O4">${esc(word(l.closing))}</div>`
            + `<div class="ins-compare">${matches ? `✓ ${esc(t('ui.statements.matches_outstanding'))}` : `⚠ ${esc(t('ui.statements.differs_outstanding', { amount: formatRupees(l.due) }))}`}</div></div>`
            + loadedNote
            + `<div class="ins-scroll"><table class="ins-table"><thead><tr><th>${esc(t('ui.statements.date'))}</th><th>${esc(t('ui.statements.what'))}</th><th class="num">${esc(t(this.partyKind === 'supplier' ? 'ui.statements.bought_col' : 'ui.statements.sold_col'))}</th><th class="num">${esc(t('ui.statements.paid_col'))}</th><th class="num">${esc(t('ui.statements.balance'))}</th></tr></thead><tbody>${body || `<tr><td colspan="5">${esc(t('ui.statements.nothing'))}</td></tr>`}</tbody></table></div>`;
        const share = [title, word(l.closing), ...l.rows.slice(-10).map(r => `${formatDay(r.t, { lang })} ${this.kindLabel(r.kind)} ${r.billNo} ${r.debit ? `+${formatRupees(r.debit)}` : `−${formatRupees(r.credit)}`} = ${formatRupees(r.balance)}`)].join('\n');
        const csvHeader = [t('ui.statements.date'), t('ui.statements.what'), t('ui.statements.bill_no'), t(this.partyKind === 'supplier' ? 'ui.statements.bought_col' : 'ui.statements.sold_col'), t('ui.statements.paid_col'), t('ui.statements.balance')];
        const csvRows = l.rows.map(r => [toLocalISODate(new Date(r.t)), this.kindLabel(r.kind), r.billNo, r.debit || '', r.credit || '', r.balance]);
        return { title, html, share, csvHeader, csvRows };
    },

    renderItem() {
        const lang = getLang();
        const item = (AppState.items || []).find(i => i.id === this.itemKey);
        if (!item) return { title: t('ui.statements.item'), html: `<p class="ins-empty-text">${esc(t('ui.statements.nothing'))}</p>`, share: '', csvHeader: [], csvRows: [] };
        const name = lang === 'hi' ? item.hindiName || item.name : item.name;
        const title = `${t('ui.statements.item')} · ${name}`;
        if (!isFullHistoryLoaded()) {
            const n = this.notLoaded(name, null);
            n.html = `<p class="ins-hint">${esc(t('ui.statements.item_needs_all'))}</p>${n.html}`;
            return n;
        }
        const l = itemLedger(this.src(), AppState.items || [], this.itemKey);
        const body = l.rows.map(r => `<tr${r.belowCost || r.beforeBought ? ' class="st-flag"' : ''}><td>${esc(r.t ? formatDay(r.t, { lang }) : '')}</td><td>${esc([this.kindLabel(r.kind), r.billNo, r.party].filter(Boolean).join(' · '))}${r.belowCost ? ` ⚠ ${esc(t('ui.statements.below_cost'))}` : ''}${r.beforeBought ? ` ⚠ ${esc(t('ui.statements.before_bought'))}` : ''}</td><td class="num">${r.qty > 0 ? '+' : ''}${r.qty}</td><td class="num">${r.balanceQty}</td><td class="num">${r.avgCost}</td></tr>`).join('');
        const html = `<h3 class="st-title">${esc(title)}</h3>`
            + `<div class="ins-row ins-total"><span>${esc(t('ui.statements.closing_stock'))}</span><span data-metric-export="S4">${esc(t('ui.statements.kg_at', { kg: l.closing.qty, rate: l.closing.rate, value: formatRupees(l.closing.value) }))}</span></div>`
            + `<div class="ins-scroll"><table class="ins-table"><thead><tr><th>${esc(t('ui.statements.date'))}</th><th>${esc(t('ui.statements.what'))}</th><th class="num">${esc(t('ui.insights.kg'))}</th><th class="num">${esc(t('ui.statements.stock_kg'))}</th><th class="num">${esc(t('ui.statements.avg_cost'))}</th></tr></thead><tbody>${body || `<tr><td colspan="5">${esc(t('ui.statements.nothing'))}</td></tr>`}</tbody></table></div>`;
        const share = [title, t('ui.statements.kg_at', { kg: l.closing.qty, rate: l.closing.rate, value: formatRupees(l.closing.value) })].join('\n');
        const csvHeader = [t('ui.statements.date'), t('ui.statements.what'), t('ui.statements.bill_no'), t('ui.insights.party'), t('ui.insights.kg'), t('ui.statements.rate'), t('ui.statements.stock_kg'), t('ui.statements.avg_cost')];
        const csvRows = l.rows.map(r => [r.t ? toLocalISODate(new Date(r.t)) : '', this.kindLabel(r.kind), r.billNo, r.party, r.qty, r.rate, r.balanceQty, r.avgCost]);
        return { title, html, share, csvHeader, csvRows };
    },

    renderCsv() {
        const lang = getLang();
        const from = (parseLocalDate(this.csvFrom) || new Date()).getTime();
        const toD = parseLocalDate(this.csvTo) || new Date();
        const to = new Date(toD.getFullYear(), toD.getMonth(), toD.getDate() + 1).getTime();
        const label = `${formatDay(from, { lang })} – ${formatDay(toD, { lang })}`;
        const title = `${t('ui.statements.csv')} · ${label}`;
        if (!this.covered(from)) return this.notLoaded(label, from);
        const rows = exportLines(this.src(), AppState.items || [], { from, to });
        const bills = new Set(rows.map(r => `${r.type}|${r.billNo}|${r.date}`)).size;
        const html = `<h3 class="st-title">${esc(title)}</h3><p>${esc(t('ui.statements.csv_ready', { lines: rows.length, bills }))}</p>`;
        const csvHeader = ['date', 'type', 'bill_no', 'party', 'item', 'kg', 'rate', 'line_amount', 'labour', 'amount_after_labour', 'bill_total', 'cash', 'online', 'due']
            .map(k => t(`ui.statements.csv_${k}`));
        const csvRows = rows.map(r => [r.date, this.kindLabel(r.type), r.billNo, r.party, r.item, r.qty, r.rate, r.lineAmount, r.labour, r.amount, r.billTotal, r.cash, r.online, r.due]);
        return { title, html, share: `${title}\n${t('ui.statements.csv_ready', { lines: rows.length, bills })}`, csvHeader, csvRows };
    },

    // ---- share

    shareWhatsApp() {
        if (!this.current || !this.current.share) return;
        const shop = AppState.settings?.shopName || APP_IDENTITY.appName;
        openExternal(`https://wa.me/?text=${encodeURIComponent(`${shop}\n${this.current.share}`)}`);
    },

    downloadCsv() {
        if (!this.current || !this.current.csvHeader.length) return;
        const csv = toCsv(this.current.csvHeader, this.current.csvRows);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${APP_IDENTITY.appName}_${this.kind}_${todayLocalISO()}.csv`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    print() {
        if (!this.current) return;
        const w = window.open('', '_blank');
        if (!w) { UIManager.showToast(t('msg.statements.popup_blocked')); return; }
        const shop = AppState.settings?.shopName || APP_IDENTITY.appName;
        w.document.write(`<!doctype html><html lang="${getLang()}"><head><meta charset="utf-8"><title>${esc(this.current.title)}</title>`
            + '<style>body{font-family:system-ui,sans-serif;margin:24px;color:#111}table{width:100%;border-collapse:collapse;font-size:13px}th,td{border-bottom:1px solid #ddd;padding:6px;text-align:left}td.num,th.num{text-align:right}.ins-row{display:flex;justify-content:space-between;border-bottom:1px solid #eee;padding:6px 0}.ins-total{font-weight:700}.ins-hero{border:1px solid #ccc;padding:10px;border-radius:8px;margin:8px 0}.ins-hero-value{font-size:22px;font-weight:700}button,.ins-hint{display:none}@page{size:A4;margin:14mm}</style>'
            + `</head><body><h2>${esc(shop)}</h2>${this.current.html}<p style="color:#555;font-size:12px">${esc(formatDayTime(new Date(), { lang: getLang() }))}</p></body></html>`);
        w.document.close();
        w.onload = () => w.print();
    }
};
