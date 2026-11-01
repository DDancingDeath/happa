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
import { formatRupees } from '../utils/money.js';
import { can } from '../utils/role-access.js';
import { parseQuestion, answerQuestion } from '../utils/ask.js';

const esc = (s) => Helpers.escapeHtml(String(s ?? ''));
const EXAMPLES = 6;
const MAX_ANSWERS = 10;
const PAGE_NAMES = { day: 'ui.ask.open_today', due: 'ui.ask.open_outstanding', stock: 'ui.ask.open_stock' };
const bills = (n) => tn('ui.today.bills_count', n);
const parties = (n) => tn('ui.ask.parties_count', n);
const kg = (q) => (Number(q) || 0).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

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
            .map(q => `<button type="button" class="filter-btn ask-example" onclick="window.app.ask.ask('${Helpers.escapeJsAttr(q)}')">${esc(q)}</button>`)
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
        let stockReady = true;
        if (q.intent === 'item_stock' && q.subject) {
            try {
                await FirebaseService.getStock();
            } catch (e) {
                console.warn('Ask: stock not loaded:', e?.message || e);
            }
            stockReady = AppState.stockReady !== false;
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
        this.answers = [{ question: text, answer }, ...this.answers].slice(0, MAX_ANSWERS);
        this.renderAnswers();
        return answer;
    },

    renderAnswers() {
        const host = document.getElementById('askAnswers');
        if (!host) return;
        host.innerHTML = this.answers.map(a => `<div class="ask-answer"><div class="ask-question">${esc(a.question)}</div>${this.answerHtml(a.answer)}</div>`).join('');
    },

    /** One answer as HTML (text from t(), names escaped). */
    answerHtml(a) {
        const line = (text) => `<div class="ask-line">${esc(text)}</div>`;
        const open = a.page ? `<button type="button" class="filter-btn ask-open" onclick="window.app.nav.showTab('${a.page}', event)">${esc(t(PAGE_NAMES[a.page]))}</button>` : '';
        const choose = (names, more) => line(t('ui.ask.did_you_mean', { names: names.join(', ') }))
            + (more ? line(tn('ui.ask.and_more', more)) : '');
        const itemName = (n) => (getLang() === 'hi' && n.hindiName ? n.hindiName : n.name);

        switch (a.intent) {
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
        case 'item_stock':
            if (a.needsItem) return line(t('ui.ask.which_item'));
            if (a.updating) return line(t('ui.ask.stock_updating')) + open;
            if (!a.name) {
                return (a.matches.length ? choose(a.matches.map(itemName), a.more) : line(t('ui.ask.no_item', { name: a.subject }))) + open;
            }
            return line(a.limited ? t('ui.ask.ans_stock_available', { name: itemName(a) })
                : a.quantity > 0 ? t('ui.ask.ans_stock', { name: itemName(a), kg: kg(a.quantity) })
                    : t('ui.ask.ans_stock_none', { name: itemName(a) })) + open;
        default:
            return line(t('ui.ask.unknown'));
        }
    }
};
