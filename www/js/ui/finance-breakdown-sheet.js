/**
 * @fileoverview Finance card breakdown sheet (#215): tap a dashboard card to
 * see the formula (each term opens its own breakdown) and the records behind
 * the number, grouped / sorted / searchable, 50 rows at a time. Phone: bottom
 * sheet; desktop (desktop.css): side panel. Uses only data already loaded.
 * @module ui/finance-breakdown-sheet
 */

import { Helpers } from '../utils/helpers.js';
import { t, getLang, tn } from '../i18n/index.js';
import {
    CARDS, buildBreakdown, searchRows, sortRows, groupRows, groupOptions, sumRows, PAGE_SIZE
} from '../utils/finance-breakdown.js';

const esc = (v) => Helpers.escapeHtml(String(v ?? ''));
const SHEET_ID = 'financeBreakdownSheet';

const rupees = (n, { paise = false } = {}) => {
    if (n === null || n === undefined || !Number.isFinite(n)) return '—';
    const abs = Math.abs(n);
    const text = paise
        ? abs.toLocaleString('en-IN', { maximumFractionDigits: 2 })
        : Math.round(abs).toLocaleString('en-IN');
    return `${n < 0 && (paise ? abs >= 0.005 : Math.round(abs) > 0) ? '-' : ''}₹${text}`;
};
const qtyText = (q) => (Number(q) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const dateText = (ms) => (ms == null ? '' : new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }));

const BILL_TYPE_KEYS = { retail: 'ui.finance.bill_retail', wholesale: 'ui.finance.bill_wholesale', purchase: 'ui.finance.bill_purchase' };
const ADJ_KEYS = { add: 'ui.finance.adj_add', remove: 'ui.finance.adj_remove', set: 'ui.finance.adj_set' };

/**
 * Title / second line for a row, from the fields it carries.
 * @param {Object} r
 * @param {boolean} showTerm prefix the formula term the row comes from
 * @returns {{title: string, sub: string}}
 */
export function describeRow(r, showTerm = false) {
    const lang = getLang();
    const item = lang === 'hi' ? (r.itemHi || r.item) : r.item;
    let title;
    let sub;
    if (r.billType) {
        title = [dateText(r.t), r.billNo ? `#${r.billNo}` : '', r.party || t(BILL_TYPE_KEYS[r.billType])].filter(Boolean).join(' · ');
        if (r.rest) sub = t('ui.finance.bill_difference');
        else if (r.writeOff) sub = t('ui.finance.written_off');
        else if (r.labour) sub = t('ui.finance.labour_on_bill');
        else if (r.term === 'uncosted') sub = t('ui.finance.uncosted_line', { item, qty: qtyText(r.qty), rate: qtyText(r.rate) });
        else if (r.cash !== undefined) sub = t('ui.finance.cash_online', { cash: qtyText(r.cash), online: qtyText(r.online) });
        else if (r.term === 'cogs') sub = t('ui.finance.line_avg_cost', { item, qty: qtyText(r.qty), rate: qtyText(r.rate) });
        else sub = t('ui.finance.line_rate', { item, qty: qtyText(r.qty), rate: qtyText(r.rate) });
    } else if (r.category !== undefined) {
        const cat = r.category === 'personal' ? t('ui.finance.personal_expenses')
            : r.category === 'business' ? t('ui.finance.business_expenses') : t('ui.finance.no_type');
        title = [dateText(r.t), cat, r.party].filter(Boolean).join(' · ');
        sub = r.note || '';
    } else if (r.term === 'withdrawn') {
        title = [dateText(r.t), r.party].filter(Boolean).join(' · ');
        sub = r.note || '';
    } else if (r.term === 'stockAdjustments') {
        title = [dateText(r.t), item].filter(Boolean).join(' · ');
        sub = `${ADJ_KEYS[r.note] ? t(ADJ_KEYS[r.note]) : r.note} ${qtyText(r.qty)}`;
    } else if (r.term === 'stockCheck') {
        title = item;
        sub = t('ui.finance.gap_hint');
    } else {
        title = item;
        sub = t('ui.finance.qty_avg_cost', { qty: qtyText(r.qty), rate: qtyText(r.rate) });
    }
    if (showTerm && r.term) sub = `${t(CARDS[r.term]?.label || '')} · ${sub}`;
    return { title, sub };
}

export const FinanceBreakdownSheet = {
    stack: [],
    summary: null,
    period: '',
    state: null,
    onKey: null,

    /**
     * Opens the breakdown of a card.
     * @param {string} cardId key of CARDS
     * @param {{getSummary: Function, periodLabel?: string}} opts getSummary() → computeFinanceSummary(..., detail: true)
     */
    open(cardId, { getSummary, periodLabel = '' }) {
        this.summary = getSummary();
        this.period = periodLabel;
        this.stack = [];
        this.push(cardId);
        if (!this.onKey) {
            this.onKey = (e) => {
                if (e.key === 'Escape' && this.root()?.classList.contains('active')
                    && !document.getElementById('billDetailsOverlay')?.classList.contains('active')) this.close();
            };
            document.addEventListener('keydown', this.onKey);
        }
        this.root().querySelector('[data-action="close"]')?.focus();
    },

    push(cardId) {
        this.stack.push(cardId);
        this.state = { group: 'none', sort: 'amount', query: '', shown: PAGE_SIZE, openGroup: null };
        this.render();
    },

    back() {
        if (this.stack.length <= 1) return this.close();
        this.stack.pop();
        this.state = { group: 'none', sort: 'amount', query: '', shown: PAGE_SIZE, openGroup: null };
        this.render();
    },

    close() {
        this.root()?.classList.remove('active');
        this.stack = [];
        this.summary = null;
    },

    root() {
        let el = document.getElementById(SHEET_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = SHEET_ID;
            el.className = 'fin-sheet-overlay';
            el.setAttribute('role', 'dialog');
            el.setAttribute('aria-modal', 'true');
            el.addEventListener('click', (e) => this.handleClick(e));
            el.addEventListener('keydown', (e) => {
                if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-action]')) {
                    e.preventDefault();
                    this.handleClick(e);
                }
            });
            el.addEventListener('input', (e) => {
                if (e.target.matches('[data-action="search"]')) {
                    this.state.query = e.target.value;
                    this.state.shown = PAGE_SIZE;
                    this.renderList();
                }
            });
            el.addEventListener('change', (e) => {
                const action = e.target.getAttribute('data-action');
                if (action === 'group' || action === 'sort') {
                    this.state[action] = e.target.value;
                    this.state.shown = PAGE_SIZE;
                    this.state.openGroup = null;
                    this.renderList();
                }
            });
            document.body.appendChild(el);
        }
        return el;
    },

    handleClick(e) {
        const root = this.root();
        if (e.target === root) return this.close();
        const el = e.target.closest('[data-action]');
        if (!el || !root.contains(el)) return;
        const action = el.getAttribute('data-action');
        if (action === 'close') this.close();
        else if (action === 'back') this.back();
        else if (action === 'drill') this.push(el.getAttribute('data-card'));
        else if (action === 'more') {
            this.state.shown += PAGE_SIZE;
            this.renderList();
        } else if (action === 'open-group') {
            const key = el.getAttribute('data-key');
            this.state.openGroup = this.state.openGroup === key ? null : key;
            this.state.shown = PAGE_SIZE;
            this.renderList();
        } else if (action === 'bill') {
            const id = el.getAttribute('data-bill-id');
            const type = el.getAttribute('data-bill-type');
            if (id && type) window.app?.history?.viewBill?.(`id:${id}`, type);
        }
    },

    current() {
        return buildBreakdown(this.summary, this.stack[this.stack.length - 1]);
    },

    render() {
        const root = this.root();
        const b = this.current();
        if (!b) return this.close();
        const formula = b.formula ? b.formula.map((term, i) => {
            const op = i === 0 ? (term.sign < 0 ? '− ' : '') : (term.sign < 0 ? ' − ' : ' + ');
            return `${op}<button type="button" class="fin-term" data-action="drill" data-card="${esc(term.cardId)}">${esc(t(term.label))} <strong>${esc(rupees(term.value))}</strong></button>`;
        }).join('') + ` = <strong>${esc(rupees(b.value))}</strong>` : '';

        root.innerHTML = `
            <div class="fin-sheet" role="document">
                <div class="fin-sheet-header">
                    ${this.stack.length > 1 ? `<button type="button" class="fin-sheet-btn" data-action="back" aria-label="${esc(t('ui.finance.back'))}">←</button>` : ''}
                    <div class="fin-sheet-title">
                        <h3>${esc(t(b.label))}</h3>
                        <span>${esc(this.period)}</span>
                    </div>
                    <button type="button" class="fin-sheet-btn" data-action="close" aria-label="${esc(t('ui.common.close'))}">✕</button>
                </div>
                <div class="fin-sheet-value">${esc(rupees(b.value))}</div>
                ${formula ? `<div class="fin-sheet-formula">${formula}</div>` : ''}
                ${b.notes.length ? `<div class="fin-sheet-notes">${b.notes.map(note => `<button type="button" class="fin-term fin-note" data-action="drill" data-card="${esc(note.cardId)}">${esc(t(note.label))} <strong>${esc(rupees(note.value))}</strong> · ${esc(t('ui.finance.not_included'))}</button>`).join('')}</div>` : ''}
                <div class="fin-sheet-tools"></div>
                <div class="fin-sheet-list"></div>
                <div class="fin-sheet-total"></div>
            </div>`;
        root.classList.add('active');
        this.renderTools(b);
        this.renderList();
    },

    renderTools(b) {
        const tools = this.root().querySelector('.fin-sheet-tools');
        if (!tools) return;
        if (!b.available || b.rows.length === 0) {
            tools.innerHTML = '';
            return;
        }
        const opt = (value, key, cur) => `<option value="${value}"${value === cur ? ' selected' : ''}>${esc(t(key))}</option>`;
        const groups = groupOptions(b.rows);
        tools.innerHTML = `
            <input type="search" class="form-control" data-action="search" value="${esc(this.state.query)}"
                placeholder="${esc(t('ui.finance.search_placeholder'))}" aria-label="${esc(t('ui.finance.search_placeholder'))}">
            <select class="form-control" data-action="group" aria-label="${esc(t('ui.finance.group_label'))}">
                ${groups.map(g => opt(g, `ui.finance.group_${g}`, this.state.group)).join('')}
            </select>
            <select class="form-control" data-action="sort" aria-label="${esc(t('ui.finance.sort_label'))}">
                ${opt('amount', 'ui.finance.sort_amount', this.state.sort)}
                ${opt('date', 'ui.finance.sort_date', this.state.sort)}
                ${opt('date-asc', 'ui.finance.sort_date_asc', this.state.sort)}
            </select>`;
    },

    rowHtml(r, showTerm) {
        const { title, sub } = describeRow(r, showTerm);
        const tappable = r.billId && r.billType;
        const attrs = tappable
            ? ` data-action="bill" data-bill-id="${esc(r.billId)}" data-bill-type="${esc(r.billType)}" role="button" tabindex="0"`
            : '';
        return `<div class="fin-row${tappable ? ' fin-row-tappable' : ''}"${attrs}>
            <div class="fin-row-main">
                <div class="fin-row-title">${esc(title)}</div>
                ${sub ? `<div class="fin-row-sub">${esc(sub)}</div>` : ''}
            </div>
            <div class="fin-row-amt ${r.amount < 0 ? 'amount-negative' : 'amount-positive'}">${esc(rupees(r.amount, { paise: true }))}</div>
        </div>`;
    },

    moreHtml(left) {
        return left > 0
            ? `<button type="button" class="history-search-older-btn fin-more" data-action="more">${esc(t('ui.finance.show_more', { count: Math.min(left, PAGE_SIZE) }))}</button>`
            : '';
    },

    renderList() {
        const root = this.root();
        const list = root.querySelector('.fin-sheet-list');
        const totalEl = root.querySelector('.fin-sheet-total');
        if (!list || !totalEl) return;
        const b = this.current();
        if (!b.available) {
            list.innerHTML = `<p class="empty-state">${esc(t('ui.finance.needs_full_history'))}</p>`;
            totalEl.innerHTML = '';
            return;
        }
        const rows = sortRows(searchRows(b.rows, this.state.query), this.state.sort);
        const showTerm = !!b.formula && this.stack[this.stack.length - 1] !== 'stockCheck';
        if (rows.length === 0) {
            list.innerHTML = `<p class="empty-state">${esc(t(b.rows.length ? 'ui.finance.no_match' : 'ui.finance.no_rows'))}</p>`;
        } else if (this.state.group === 'none') {
            list.innerHTML = rows.slice(0, this.state.shown).map(r => this.rowHtml(r, showTerm)).join('')
                + this.moreHtml(rows.length - this.state.shown);
        } else {
            const groups = groupRows(rows, this.state.group, { lang: getLang() });
            list.innerHTML = groups.map(g => {
                const label = this.state.group === 'term' ? t(g.label) : (g.label || t(this.state.group === 'day' ? 'ui.finance.no_date' : 'ui.finance.no_name'));
                const open = this.state.openGroup === g.key;
                const body = open
                    ? `<div class="fin-group-rows">${g.rows.slice(0, this.state.shown).map(r => this.rowHtml(r, showTerm)).join('')}${this.moreHtml(g.rows.length - this.state.shown)}</div>`
                    : '';
                return `<div class="fin-group">
                    <button type="button" class="fin-group-head" data-action="open-group" data-key="${esc(g.key)}" aria-expanded="${open}">
                        <span>${open ? '▾' : '▸'} ${esc(label)} <small>(${esc(tn('ui.finance.entries_count', g.count))})</small></span>
                        <strong class="${g.subtotal < 0 ? 'amount-negative' : 'amount-positive'}">${esc(rupees(g.subtotal))}</strong>
                    </button>${body}
                </div>`;
            }).join('');
        }
        const shownTotal = sumRows(rows);
        totalEl.innerHTML = this.state.query.trim()
            ? `<span>${esc(t('ui.finance.matching_total', { count: rows.length, total: rupees(b.total) }))}</span><strong>${esc(rupees(shownTotal))}</strong>`
            : `<span>${esc(tn('ui.finance.total_entries', rows.length))}</span><strong>${esc(rupees(b.total))}</strong>`;
    }
};
