/**
 * @fileoverview Expenses Module
 * Handles business and personal expense tracking
 * Supports expense categorization, history, and receipt printing
 * @module modules/miscellaneous
 */

import { AppState } from '../utils/state.js';
import { on, REFRESH } from '../utils/events.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { Helpers } from '../utils/helpers.js';
import { AuditService } from '../services/audit.js';
import { attachOlderHistoryScroll } from '../ui/infinite-scroll.js';
import { isFullHistoryLoaded, historyLoadedFrom, formatWindowDate } from '../utils/history-window.js';
import { EXPENSE_LOCKED_KEY, isPermissionDenied } from '../utils/record-permissions.js';
import { askReason, voidedBannerHtml } from '../ui/bill-status.js';
import { t } from '../i18n/index.js';
import { saveFailedText, EXPENSE_UNCONFIRMED_KEY } from '../utils/storage-full.js';
import { refusedForClock } from '../utils/clock-skew.js';

const tx = (key, params) => Helpers.escapeHtml(t(key, params));
import { can, canVoidExpenseWith } from '../utils/role-access.js';
import { expenseMode, formatAmount, isActiveExpense, isPersonalExpense } from '../utils/money.js';
import { entryAmount } from '../utils/calc/billing.js';
import { DEFAULT_EXPENSE_MODE, expenseDateFields, expenseDayRange, validateExpenseEntry } from '../utils/expense-entry.js';
import { toLocalISODate } from '../utils/dates.js';
import { personalDayKey } from '../utils/personal-expenses.js';
import { sessionForDate } from '../utils/cash-session.js';
import { expenseTemplates, expenseTotals, expenseTypes, filterExpenses, isExpenseSearch, sameExpenseType } from '../utils/expense-list.js';

/** Expense save / print buttons, disabled while one is being saved (#95). */
const EXPENSE_BUTTONS = '[data-expense-save]';

/** An input of a section's form: formField('business', 'Amount') → #businessExpenseAmount. */
const formField = (category, name) => document.getElementById(`${category}Expense${name}`);

/** How long the "saved" toast waits to learn whether a back-dated cash day is closed (#118). */
const CLOSED_DAY_WAIT_MS = 1500;

/** Escaped "Cash" / "Online" of an expense (EXP-MODE; no mode = cash). */
const modeLabel = (expense) => tx(expenseMode(expense) === 'online' ? 'ui.expenses.mode_online' : 'ui.expenses.mode_cash');

/** The signed-in user, as canVoidExpenseWith expects it. */
const currentUserInfo = () => ({ uid: AppState.currentUser?.uid, role: AppState.userRole, raw: AppState.settings?.roleAccess });

/**
 * Expenses Manager - Manages expense operations
 * @class ExpensesManager
 */
export class ExpensesManager {
    /**
     * Voided expense being entered again ({ id, category }), or null (#99): the
     * next save of that category is the corrected expense, linked by `replacesId`.
     * @type {{id: string, category: string}|null}
     */
    static replacing = null;

    /** Voided expenses are shown in the lists (struck through) when on. */
    static showVoided = false;

    /** Search of each section's list (#90): words and an expense type ('' = any). */
    static search = { business: { text: '', type: '' }, personal: { text: '', type: '' } };

    /** Template chips on screen per section (#90), in chip order. */
    static templates = { business: [], personal: [] };

    /**
     * New expense whose save this phone has not confirmed yet ({ id, category }):
     * the next save of that category reuses the id (#153).
     * @type {{id: string, category: string}|null}
     */
    static pendingExpense = null;

    /**
     * Create a new expense. Expenses are never changed in place (#99): a
     * correction voids the old one and saves a new one with `replacesId`.
     * @param {Object} expense - Expense built from the form
     * @returns {Promise<false|null>} false when saved; null if this phone refused it
     *   or has not confirmed storing it (message already shown)
     */
    static async persistExpense(expense) {
        const replacing = this.replacing?.category === expense.category ? this.replacing : null;
        if (replacing) expense.replacesId = replacing.id;
        // Shown at once (also offline); the listener reconciles it (#89). A save
        // after "not confirmed" reuses that expense's id so it can't duplicate.
        const pending = this.pendingExpense?.category === expense.category ? this.pendingExpense : null;
        // Sent again unchanged, the second write changes nothing on the server (firestore.rules, #99)
        if (pending && pending.day === expense.day) Object.assign(expense, { timestamp: pending.timestamp, date: pending.date });
        const { record, committed, stored } = FirebaseService.startSaveExpense(expense, { id: pending?.id });
        const forget = () => { if (this.pendingExpense?.id === record.id) this.pendingExpense = null; };
        committed.catch(async err => {
            console.error('Expense save failed:', err);
            forget();
            UIManager.showToast(await refusedForClock(err)
                ? t('msg.common.phone_clock_wrong_save')
                : saveFailedText(err, t('msg.expenses.expense_not_saved', { value: err?.message || err })), 'error');
            this.refreshExpenseViews();
        });
        this.refreshExpenseViews();
        // Not "saved" unless this phone stored it: refused (storage full, #153) or
        // still unconfirmed after a few seconds keeps the form
        const ok = stored ? await stored : true;
        if (ok === null) {
            this.pendingExpense = { id: record.id, category: expense.category, day: expense.day, timestamp: expense.timestamp, date: expense.date };
            UIManager.showToast(t(EXPENSE_UNCONFIRMED_KEY), 'warning');
            return null;
        }
        forget();
        if (ok !== true) return null;
        if (replacing && this.replacing === replacing) this.stopReplacing(false);
        return false;
    }

    /**
     * The expense in a section's form, checked (#118: day and mode too), or null
     * after telling the user what is wrong. Editing keeps the expense's date.
     * @param {'business'|'personal'} category
     * @returns {?Object}
     */
    static expenseFromForm(category) {
        const type = formField(category, 'Type').value.trim();
        const personName = formField(category, 'Person').value.trim();
        // Whole rupees (MONEY-ROUND, #129): ₹0.40 is not an amount
        const amount = entryAmount(formField(category, 'Amount').value);
        const remarks = formField(category, 'Remarks').value.trim();

        if (!type) {
            UIManager.showModal(t('msg.expenses.enter_expense_type'));
            return null;
        }

        if (!amount || amount <= 0) {
            UIManager.showModal(t('msg.common.enter_valid_amount'));
            return null;
        }

        const now = new Date();
        const mode = formField(category, 'Mode')?.value || DEFAULT_EXPENSE_MODE;
        // A day the user didn't pick is today at save time (a form left open over midnight, #118)
        const dateInput = formField(category, 'Date');
        const day = dateInput?.dataset.picked && dateInput.value ? dateInput.value : toLocalISODate(now);
        const problem = validateExpenseEntry({ day, mode }, { role: AppState.userRole, roleAccess: AppState.settings?.roleAccess, now });
        if (problem) {
            UIManager.showModal(t(problem.key, problem.params));
            return null;
        }

        return {
            type,
            personName,
            amount,
            remarks,
            category,
            paymentMode: mode,
            ...expenseDateFields(day, now),
            // Save time: the members' edit window counts from it, the expense's day is `date` / `day`
            timestamp: now.getTime(),
            createdBy: AppState.currentUser ? AppState.currentUser.uid : 'unknown',
            createdByName: AppState.userName || (AppState.currentUser ? AppState.currentUser.email : 'Unknown')
        };
    }

    /**
     * Date and mode inputs of both sections (#118): the days the role may pick,
     * today unless the user picked another day.
     */
    static prepareExpenseForms() {
        const range = expenseDayRange({ role: AppState.userRole, roleAccess: AppState.settings?.roleAccess });
        ['business', 'personal'].forEach(category => {
            const input = formField(category, 'Date');
            if (!input) return;
            input.max = range.max;
            if (range.min) input.min = range.min;
            else input.removeAttribute('min');
            if (!input.dataset.prepared) {
                input.dataset.prepared = '1';
                // Picking today is the same as not picking: it follows the clock
                input.addEventListener('change', () => {
                    if (input.value && input.value !== toLocalISODate(new Date())) input.dataset.picked = '1';
                    else delete input.dataset.picked;
                });
            }
            input.disabled = false;
            if (!input.dataset.picked || !input.value) input.value = range.max;
        });
    }

    /**
     * "Saved" toast. A new cash expense dated on an earlier day whose cash is
     * already closed adds that the closed day's figures won't change (#118):
     * the closed session keeps the totals it was counted with.
     * @param {string} key i18n key of the saved message
     * @param {Object} expense
     */
    static async showSavedToast(key, expense) {
        const text = t(key);
        if (expenseMode(expense) !== 'cash' || !expense.day || expense.day >= toLocalISODate(new Date())) {
            UIManager.showToast(text);
            return;
        }
        if (await this.cashDayClosed(expense.day)) UIManager.showToast(t('msg.expenses.saved_cash_day_closed', { message: text }), 5000);
        else UIManager.showToast(text);
    }

    /**
     * Whether a day's cash is closed (waits at most CLOSED_DAY_WAIT_MS; unknown = not closed).
     * @param {string} day YYYY-MM-DD
     * @returns {Promise<boolean>}
     */
    static async cashDayClosed(day) {
        try {
            const timeout = new Promise(resolve => setTimeout(() => resolve(null), CLOSED_DAY_WAIT_MS));
            const sessions = await Promise.race([FirebaseService.loadCashSessionsForDate(day), timeout]);
            return !!sessionForDate(sessions || [], day)?.signedOut;
        } catch (e) {
            console.warn('Expense: cash day not checked:', e?.code || e);
            return false;
        }
    }

    /**
     * After a save or an abandoned edit: today and cash again.
     * @param {'business'|'personal'} category
     */
    static resetExpenseForm(category) {
        const input = formField(category, 'Date');
        if (input) {
            delete input.dataset.picked;
            input.value = '';
            input.disabled = false;
        }
        const mode = formField(category, 'Mode');
        if (mode) mode.value = DEFAULT_EXPENSE_MODE;
        this.prepareExpenseForms();
    }

    /**
     * Update expense person autocomplete options
     * Extracts unique person names from expense history
     */
    static updateExpensePersonOptions() {
        const uniquePersons = [...new Set(
            AppState.expensesHistory
                .filter(p => p.personName && p.personName.trim() !== '')
                .map(p => p.personName)
        )];
        
        const businessDatalist = document.getElementById('businessExpensePersonOptions');
        if (businessDatalist) {
            businessDatalist.innerHTML = uniquePersons.map(name => `<option value="${Helpers.escapeHtml(name)}">`).join('');
        }
        
        const personalDatalist = document.getElementById('personalExpensePersonOptions');
        if (personalDatalist) {
            personalDatalist.innerHTML = uniquePersons.map(name => `<option value="${Helpers.escapeHtml(name)}">`).join('');
        }
    }

    /**
     * Filter between business and personal expense tabs
     * @param {'business'|'personal'} view - Tab to display
     * @param {Event} [evt] - Optional click event for button styling
     */
    static filterExpenseTab(view, evt) {
        if (view === 'personal' && !can(AppState.userRole, 'personalExpenses', AppState.settings?.roleAccess)) {
            UIManager.showToast(t('msg.roles.section_not_allowed'));
            return;
        }
        if (this.replacing?.category !== view) this.cancelExpenseEdit();
        const buttons = document.querySelectorAll('#expenses .filter-btn');
        buttons.forEach(btn => btn.classList.remove('active'));
        if (evt) evt.target.classList.add('active');
        
        const businessSection = document.getElementById('businessExpenseSection');
        const personalSection = document.getElementById('personalExpenseSection');
        
        if (view === 'business') {
            businessSection.style.display = 'block';
            personalSection.style.display = 'none';
        } else {
            businessSection.style.display = 'none';
            personalSection.style.display = 'block';
        }
    }

    /**
     * Save a business expense with loading indicator
     * Validates input, creates expense object, and saves to Firebase
     * @async
     * @returns {Promise<void>}
     */
    static saveBusinessExpense() {
        return Helpers.runExclusive('expense', EXPENSE_BUTTONS, () => this._saveBusinessExpense());
    }

    static async _saveBusinessExpense() {
        const expense = this.expenseFromForm('business');
        if (!expense) return;

        // Use withLoading for the Firebase operation
        let result = false;
        await UIManager.withLoading(async () => {
            result = await this.persistExpense(expense);
        });
        if (result === null) return;
        
        
        UIManager.hapticFeedback('medium');
        await this.showSavedToast('msg.expenses.business_expense_saved', expense);
        
        document.getElementById('businessExpenseType').value = '';
        document.getElementById('businessExpensePerson').value = '';
        document.getElementById('businessExpenseAmount').value = '';
        document.getElementById('businessExpenseRemarks').value = '';
        this.resetExpenseForm('business');
        
        if (window.app.finance && document.getElementById('financeOverviewSection') && document.getElementById('financeOverviewSection').style.display !== 'none') {
            window.app.finance.calculateOverview();
        }
        
        // Refresh cash management if available
        if (window.app.cashManagement) {
            window.app.cashManagement.calculateTodayTransactions()
                .catch(e => console.error('Cash refresh after expense failed:', e));
            window.app.cashManagement.updateUI();
        }
    }

    /**
     * Save a personal expense with loading indicator
     * Validates input, creates expense object, and saves to Firebase
     * @async
     * @returns {Promise<void>}
     */
    static savePersonalExpense() {
        return Helpers.runExclusive('expense', EXPENSE_BUTTONS, () => this._savePersonalExpense());
    }

    static async _savePersonalExpense() {
        const expense = this.expenseFromForm('personal');
        if (!expense) return;

        // Use withLoading for the Firebase operation
        let result = false;
        await UIManager.withLoading(async () => {
            result = await this.persistExpense(expense);
        });
        if (result === null) return;
        
        UIManager.hapticFeedback('medium');
        await this.showSavedToast('msg.expenses.personal_expense_saved', expense);
        
        
        document.getElementById('personalExpenseType').value = '';
        document.getElementById('personalExpenseAmount').value = '';
        document.getElementById('personalExpensePerson').value = '';
        document.getElementById('personalExpenseRemarks').value = '';
        this.resetExpenseForm('personal');
        
        if (window.app.finance && document.getElementById('financeOverviewSection') && document.getElementById('financeOverviewSection').style.display !== 'none') {
            window.app.finance.calculateOverview();
        }
        
        // Refresh cash management if available
        if (window.app.cashManagement) {
            window.app.cashManagement.calculateTodayTransactions()
                .catch(e => console.error('Cash refresh after expense failed:', e));
            window.app.cashManagement.updateUI();
        }
    }

    /**
     * Redraw every view that shows expenses after a local add/delete (#89).
     */
    static refreshExpenseViews() {
        try {
            if (document.getElementById('businessExpenseHistoryList') || document.getElementById('personalExpenseHistoryList')) {
                this.renderexpensesHistory();
            }
            if (document.getElementById('todayTotalIn')) window.app?.day?.loadTodayData?.();
        } catch (e) {
            console.error('Expense view refresh failed:', e);
        }
    }

    /**
     * Render all expense history (business + personal)
     */
    static renderexpensesHistory() {
        this.prepareExpenseForms();
        this.renderBusinessExpenseHistory();
        this.renderPersonalExpenseHistory();
    }

    /**
     * Render business expense history list
     */
    static renderBusinessExpenseHistory() {
        this.renderExpenseList('business', document.getElementById('businessExpenseHistoryList'));
    }

    /**
     * Expenses of a section for its list, newest first: the counted ones, and the
     * voided ones too when "Show voided" is on (#99).
     * @param {'business'|'personal'} category
     * @returns {Array<Object>}
     */
    static listedExpenses(category) {
        const ofCategory = (e) => e && e.id && (category === 'personal') === isPersonalExpense(e);
        const rows = AppState.expensesHistory.filter(ofCategory);
        if (this.showVoided) rows.push(...FirebaseService.voidedExpenses().filter(ofCategory));
        const listed = filterExpenses(rows, this.search[category]);
        return listed.sort((a, b) => (Helpers.parseDate(b.date)?.getTime() || 0) - (Helpers.parseDate(a.date)?.getTime() || 0));
    }

    /**
     * The search box and type filter of a section changed (#90): redraw its list.
     * @param {'business'|'personal'} category
     */
    static onSearch(category) {
        this.search[category] = {
            text: formField(category, 'Search')?.value || '',
            type: formField(category, 'TypeFilter')?.value || ''
        };
        if (category === 'personal') this.renderPersonalExpenseHistory();
        else this.renderBusinessExpenseHistory();
    }

    /**
     * Above a section's list (#90): today's and this month's totals (EXP-LIST),
     * the total of what a search shows, the type filter and the template chips.
     * @param {'business'|'personal'} category
     * @param {Array<Object>} listed rows on screen
     */
    static renderSectionTools(category, listed) {
        const counted = AppState.expensesHistory.filter(e => e && (category === 'personal') === isPersonalExpense(e));
        const totals = expenseTotals(counted, { now: new Date(), loadedFrom: isFullHistoryLoaded() ? null : historyLoadedFrom(), shown: listed });
        const box = formField(category, 'Totals');
        if (box) {
            const month = totals.partialMonth
                ? tx('ui.expenses.total_month_since', { amount: formatAmount(totals.month), date: formatWindowDate(historyLoadedFrom()) })
                : tx('ui.expenses.total_month', { amount: formatAmount(totals.month) });
            const shown = isExpenseSearch(this.search[category])
                ? ` · <strong>${tx('ui.expenses.total_shown', { count: totals.shownCount, amount: formatAmount(totals.shown) })}</strong>` : '';
            box.innerHTML = `${tx('ui.expenses.total_today', { amount: formatAmount(totals.today) })} · ${month}${shown}`;
        }
        const filter = formField(category, 'TypeFilter');
        if (filter) {
            const want = this.search[category].type;
            const types = expenseTypes(counted);
            const picked = want ? types.find(type => sameExpenseType(type, want)) : '';
            if (want && !picked) types.unshift(want);
            // The list's spelling of the picked type (a newer entry may spell it in another case)
            if (picked) this.search[category].type = picked;
            const selected = picked || want;
            filter.innerHTML = `<option value="">${tx('ui.expenses.all_types')}</option>`
                + types.map(type => `<option value="${Helpers.escapeHtml(type)}"${type === selected ? ' selected' : ''}>${Helpers.escapeHtml(type)}</option>`).join('');
        }
        const chips = formField(category, 'Templates');
        if (chips) {
            const templates = expenseTemplates(counted);
            this.templates[category] = templates;
            chips.hidden = templates.length === 0;
            chips.innerHTML = templates.length === 0 ? '' : `<span class="expense-templates__label">${tx('ui.expenses.templates_label')}</span>`
                + templates.map((tpl, i) => `<button type="button" class="expense-template-chip" onclick="window.app.expenses.applyTemplate('${category}', ${i})">${Helpers.escapeHtml(tpl.type)}${tpl.personName ? ` · ${Helpers.escapeHtml(tpl.personName)}` : ''} · ₹${Helpers.escapeHtml(formatAmount(tpl.amount, { small: true }))}</button>`).join('');
        }
    }

    /**
     * A template chip (#90): fills the type, name and amount of the form; the
     * user checks the day and mode and saves it (never saved by the tap).
     * @param {'business'|'personal'} category
     * @param {number} index
     */
    static applyTemplate(category, index) {
        const tpl = this.templates[category]?.[index];
        if (!tpl) return;
        const set = (name, value) => { const el = formField(category, name); if (el) el.value = value; };
        set('Type', tpl.type);
        set('Person', tpl.personName);
        set('Amount', String(tpl.amount));
        formField(category, 'Amount')?.focus?.();
    }

    /**
     * One section's expense cards; voided ones struck through with a chip (#99).
     * @param {'business'|'personal'} category
     * @param {?HTMLElement} container
     */
    static renderExpenseList(category, container) {
        if (!container) return;
        const expenses = this.listedExpenses(category);
        this.attachExpenseScroll(container);
        this.renderSectionTools(category, expenses);
        if (expenses.length === 0) {
            const empty = isExpenseSearch(this.search[category]) ? t('ui.expenses.no_match') : this.emptyExpenseMessage(category);
            container.innerHTML = `<p style="text-align: center; color: #888; margin-top: 40px;">${Helpers.escapeHtml(empty)}</p>`;
            return;
        }
        container.innerHTML = expenses.map(payment => {
            const voided = !isActiveExpense(payment);
            return `
            <div class="expense-card${voided ? ' expense-card--voided' : ''}" style="background: white; border-radius: 12px; padding: 16px; margin-bottom: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); cursor: pointer; transition: all 0.2s ease;"
                 onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,0.15)'; this.style.transform='translateY(-2px)'"
                 onmouseout="this.style.boxShadow='0 2px 4px rgba(0,0,0,0.1)'; this.style.transform='translateY(0)'"
                 onclick="window.app.expenses.viewExpenseDetails('${Helpers.escapeJsAttr(payment.id)}', '${category}')">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                    <div>
                        ${payment.personName ? `<div style="font-weight: 600; font-size: 16px; color: #333;">${Helpers.escapeHtml(payment.personName)}</div>` : ''}
                        <div style="font-size: 13px; color: #666; margin-top: 4px;">${Helpers.escapeHtml(payment.type)}${voided ? ` <span class="voided-chip">${tx('ui.void.chip')}</span>` : ''}</div>
                    </div>
                    <div style="text-align: right;">
                        <div class="expense-card__amount" style="font-size: 18px; font-weight: bold; color: #2c3e50;">₹${Helpers.escapeHtml(payment.amount)}</div>
                    </div>
                </div>
                ${payment.remarks ? `<div style="font-size: 13px; color: #777; font-style: italic; margin-top: 8px;">📝 ${Helpers.escapeHtml(payment.remarks)}</div>` : ''}
                <div style="font-size: 12px; color: #999; margin-top: 8px;">📅 ${Helpers.escapeHtml(payment.date)} • ${modeLabel(payment)}${payment.createdByName ? ` • ${tx('ui.stock.by', { name: payment.createdByName })}` : ''}</div>
            </div>`;
        }).join('');
    }

    /** "Show voided" switch of the expense lists (both sections follow it). */
    static toggleVoided(show) {
        this.showVoided = !!show;
        document.querySelectorAll('[data-expense-voided-toggle]').forEach(box => { box.checked = this.showVoided; });
        this.renderexpensesHistory();
    }

    /**
     * Older expenses load one month at a time as the user scrolls the list.
     * @param {HTMLElement} container
     */
    static attachExpenseScroll(container) {
        attachOlderHistoryScroll(container, { noun: 'expenses', onLoaded: () => this.renderexpensesHistory() });
    }

    /**
     * @param {'business'|'personal'} category
     * @returns {string} plain text
     */
    static emptyExpenseMessage(category) {
        const kind = category === 'personal' ? 'personal' : 'business';
        if (isFullHistoryLoaded()) return t(`ui.expenses.no_${kind}_expenses_recorded_yet`);
        return t(`ui.expenses.no_${kind}_since`, { date: formatWindowDate(historyLoadedFrom()) });
    }

    static renderPersonalExpenseHistory() {
        const container = document.getElementById('personalExpenseHistoryList');
        if (!container) return;
        if (!can(AppState.userRole, 'personalExpenses', AppState.settings?.roleAccess)) {
            container.innerHTML = '';
            return;
        }
        this.renderExpenseList('personal', container);
    }

    static async printExpenseReceipt(expense) {
        // Always use PrinterService for consistent preview/print experience
        if (window.app && window.app.printer) {
            await window.app.printer.printExpense(expense);
        } else {
            UIManager.showToast(t('msg.expenses.printer_service_not_available'));
        }
    }

    static saveAndPrintBusiness() {
        return Helpers.runExclusive('expense', EXPENSE_BUTTONS, () => this._saveAndPrintBusiness());
    }

    static async _saveAndPrintBusiness() {
        const expense = this.expenseFromForm('business');
        if (!expense) return;

        if (await this.persistExpense(expense) === null) return;
        
        UIManager.hapticFeedback('medium');
        await this.showSavedToast('msg.expenses.business_expense_saved', expense);
        
        document.getElementById('businessExpenseType').value = '';
        document.getElementById('businessExpensePerson').value = '';
        document.getElementById('businessExpenseAmount').value = '';
        document.getElementById('businessExpenseRemarks').value = '';
        this.resetExpenseForm('business');
        
        if (window.app.finance && document.getElementById('financeOverviewSection') && document.getElementById('financeOverviewSection').style.display !== 'none') {
            window.app.finance.calculateOverview();
        }

        // Print the expense
        this.printExpenseReceipt(expense).catch(e => {
            console.error('Expense print failed:', e);
            UIManager.showToast(t('msg.expenses.expense_saved_but_printing_failed'), 3500);
        });
    }

    /**
     * An expense of a section by id: a counted one, or a voided one (#99).
     * @param {string} expenseId
     * @param {'business'|'personal'} category
     * @returns {?Object}
     */
    static findExpense(expenseId, category) {
        const match = (p) => String(p.id) === String(expenseId) && (category === 'personal') === isPersonalExpense(p);
        return AppState.expensesHistory.find(match) || FirebaseService.voidedExpenses().find(match) || null;
    }

    static viewExpenseDetails(expenseId, category) {
        const expense = this.findExpense(expenseId, category);
        
        if (!expense) {
            UIManager.showToast(t('msg.expenses.expense_not_found'));
            return;
        }

        // Store current expense for edit/delete operations
        window.currentExpenseId = String(expense.id);
        window.currentExpenseCategory = category;

        const content = `
            <div style="padding: 8px 0;">
                ${voidedBannerHtml(expense)}
                <div style="background: #f8f9fa; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
                    <div style="display: grid; gap: 12px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                            <div style="display: flex; align-items: center;">
                                <span style="font-size: 20px; margin-right: 12px;">🏷️</span>
                                <span style="font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">${tx('ui.expenses.d_category')}</span>
                            </div>
                            <span style="font-size: 15px; color: #333; font-weight: 600; text-transform: capitalize;">${tx(category === 'personal' ? 'ui.expenses.personal_expenses' : 'ui.expenses.business_expenses')}</span>
                        </div>
                        
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                            <div style="display: flex; align-items: center;">
                                <span style="font-size: 20px; margin-right: 12px;">📅</span>
                                <span style="font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">${tx('ui.history.date')}</span>
                            </div>
                            <span style="font-size: 14px; color: #333; font-weight: 500;">${Helpers.escapeHtml(expense.date)}</span>
                        </div>

                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                            <div style="display: flex; align-items: center;">
                                <span style="font-size: 20px; margin-right: 12px;">💳</span>
                                <span style="font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">${tx('ui.expenses.d_paid_by')}</span>
                            </div>
                            <span style="font-size: 14px; color: #333; font-weight: 500;">${modeLabel(expense)}</span>
                        </div>
                        
                        ${expense.createdByName ? `
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                            <div style="display: flex; align-items: center;">
                                <span style="font-size: 20px; margin-right: 12px;">👨‍💼</span>
                                <span style="font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">${tx('ui.expenses.d_created_by')}</span>
                            </div>
                            <span style="font-size: 14px; color: #333; font-weight: 500;">${Helpers.escapeHtml(expense.createdByName)}</span>
                        </div>
                        ` : ''}
                    </div>
                </div>
                
                <div style="background: white; border-radius: 12px; padding: 24px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 2px solid #f0f0f0;">
                        <span style="font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">${tx('ui.reports.pdf_type')}</span>
                        <span style="font-size: 18px; font-weight: 600; color: #2c3e50;">${Helpers.escapeHtml(expense.type)}</span>
                    </div>
                    
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 2px solid #f0f0f0;">
                        <span style="font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">${tx('ui.outstanding.sort_amount')}</span>
                        <span style="font-size: 36px; font-weight: bold; color: #667eea; letter-spacing: 1px;">₹${Helpers.escapeHtml(expense.amount)}</span>
                    </div>
                    
                    ${expense.personName ? `
                    <div style="display: flex; align-items: center; justify-content: space-between;">
                        <span style="font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">${tx('ui.expenses.d_person')}</span>
                        <span style="font-size: 18px; font-weight: 500; color: #2c3e50;">👤 ${Helpers.escapeHtml(expense.personName)}</span>
                    </div>
                    ` : ''}
                </div>
                
                ${expense.remarks ? `
                <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 16px; border-radius: 8px;">
                    <div style="font-size: 11px; color: #856404; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">📝 ${tx('ui.expenses.d_remarks')}</div>
                    <div style="font-size: 14px; color: #856404; line-height: 1.5;">${Helpers.escapeHtml(expense.remarks)}</div>
                </div>
                ` : ''}
            </div>
        `;

        document.getElementById('expenseDetailsContent').innerHTML = content;
        // Hide what the rules would refuse (#99): void inside the role's edit window
        const allowed = canVoidExpenseWith(expense, currentUserInfo());
        const voidBtn = document.getElementById('expenseVoidBtn');
        if (voidBtn) voidBtn.style.display = allowed ? '' : 'none';
        // Re-entry on the same day must still be inside the role's back-dating window
        const reenterBtn = document.getElementById('expenseReenterBtn');
        if (reenterBtn) reenterBtn.style.display = allowed && !this.reenterProblem(expense) ? '' : 'none';
        document.getElementById('expenseDetailsOverlay').classList.add('active');
    }

    static closeExpenseDetails() {
        document.getElementById('expenseDetailsOverlay').classList.remove('active');
        window.currentExpenseId = null;
        window.currentExpenseCategory = null;
    }

    /**
     * Voids the open expense with a reason (#99): it stays in the list, struck
     * through, and counts in no total. A cash expense's money goes back into its
     * day's drawer while that day's cash is open; a closed day keeps its count.
     * @param {{reenter?: boolean}} [opts] reenter: then put it in the form to save it corrected
     * @returns {Promise<boolean>} true when voided
     */
    static async voidExpenseFromModal({ reenter = false } = {}) {
        const category = window.currentExpenseCategory;
        const expense = this.findExpense(window.currentExpenseId, category);
        if (!expense) {
            UIManager.showToast(t('msg.expenses.expense_not_found'));
            return false;
        }
        if (!canVoidExpenseWith(expense, currentUserInfo())) {
            UIManager.showToast(t(EXPENSE_LOCKED_KEY), 4000);
            return false;
        }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            UIManager.showToast(t('msg.expenses.void_needs_internet'));
            return false;
        }
        const day = expense.day || personalDayKey(expense.date);
        if (reenter && this.reenterProblem(expense)) {
            UIManager.showToast(t('msg.expenses.reenter_too_old'), 5000);
            return false;
        }
        const cash = expenseMode(expense) === 'cash';
        const explainKey = !cash ? 'ui.expenses.void_explain'
            : (day && await this.cashDayClosed(day)) ? 'ui.expenses.void_explain_closed' : 'ui.expenses.void_explain_cash';
        const reason = await askReason({
            titleKey: reenter ? 'ui.expenses.reenter_title' : 'ui.expenses.void_title',
            explainKey,
            labelKey: 'ui.expenses.void_reason'
        });
        if (!reason) return false;
        this.closeExpenseDetails();
        try {
            await UIManager.withLoading(() => FirebaseService.voidExpense(expense.id, reason));
        } catch (error) {
            console.error('Error voiding expense:', error);
            UIManager.showToast(isPermissionDenied(error) ? t(EXPENSE_LOCKED_KEY)
                : error?.code === 'already-voided' ? t('msg.expenses.already_voided')
                    : t('msg.expenses.void_failed'), 4000);
            this.refreshExpenseViews();
            return false;
        }
        AuditService.log(AuditService.ACTIONS.VOID_EXPENSE, {
            expenseId: String(expense.id),
            category,
            amount: expense.amount,
            type: expense.type,
            reason
        }).catch(e => console.warn('Audit log failed:', e));
        UIManager.hapticFeedback('medium');
        this.refreshExpenseViews();
        if (window.app.cashManagement) {
            window.app.cashManagement.calculateTodayTransactions()
                .catch(e => console.error('Cash refresh after void failed:', e));
            window.app.cashManagement.updateUI();
        }
        if (reenter) this.startReentry(expense, category);
        else UIManager.showToast(t('msg.expenses.voided'));
        return true;
    }

    /**
     * Why the voided expense couldn't be saved again on its own day (back-dating
     * window of the role, #118), or null. Checked before the void.
     * @param {Object} expense
     * @returns {?Object}
     */
    static reenterProblem(expense) {
        return validateExpenseEntry({ day: expense.day || personalDayKey(expense.date), mode: expenseMode(expense) },
            { role: AppState.userRole, roleAccess: AppState.settings?.roleAccess, now: new Date() });
    }

    /** "Void & re-enter" of the open expense. */
    static reenterExpenseFromModal() {
        return this.voidExpenseFromModal({ reenter: true });
    }

    /**
     * Puts a voided expense in its section's form to be saved corrected, on its
     * own day; the save links the new expense to it (`replacesId`).
     * @param {Object} expense the voided expense
     * @param {'business'|'personal'} category
     */
    static startReentry(expense, category) {
        this.stopReplacing();
        const tabBtn = [...document.querySelectorAll('#expenses .filter-btn')][category === 'personal' ? 1 : 0];
        this.filterExpenseTab(category, tabBtn ? { target: tabBtn } : undefined);
        formField(category, 'Type').value = expense.type || '';
        formField(category, 'Amount').value = expense.amount || '';
        formField(category, 'Person').value = expense.personName || '';
        formField(category, 'Remarks').value = expense.remarks || '';
        const modeInput = formField(category, 'Mode');
        if (modeInput) modeInput.value = expenseMode(expense);
        const dateInput = formField(category, 'Date');
        const day = expense.day || personalDayKey(expense.date);
        if (dateInput && day) {
            dateInput.value = day;
            if (day !== toLocalISODate(new Date())) dateInput.dataset.picked = '1';
        }
        const replacing = { id: String(expense.id), category };
        this.replacing = replacing;
        // Clearing the amount (or leaving the tab) ends the re-entry: the next save is a plain new expense
        const amountInput = formField(category, 'Amount');
        const onAmountInput = () => {
            if (amountInput.value.trim() === '' && this.replacing === replacing) this.stopReplacing();
        };
        amountInput?.addEventListener('input', onAmountInput);
        replacing.cleanup = () => amountInput?.removeEventListener('input', onAmountInput);
        UIManager.showToast(t('msg.expenses.reenter_hint'), 4000);
    }

    /**
     * Ends a re-entry: the next save is a new expense (today, cash, unless picked).
     * @param {boolean} [resetForm=true]
     */
    static stopReplacing(resetForm = true) {
        const was = this.replacing;
        was?.cleanup?.();
        this.replacing = null;
        if (was && resetForm && typeof document !== 'undefined') this.resetExpenseForm(was.category);
    }

    /** Leaving the section or the tab abandons a re-entry. */
    static cancelExpenseEdit() {
        this.stopReplacing();
    }

    static saveAndPrintPersonal() {
        return Helpers.runExclusive('expense', EXPENSE_BUTTONS, () => this._saveAndPrintPersonal());
    }

    static async _saveAndPrintPersonal() {
        const expense = this.expenseFromForm('personal');
        if (!expense) return;

        if (await this.persistExpense(expense) === null) return;
        
        UIManager.hapticFeedback('medium');
        await this.showSavedToast('msg.expenses.personal_expense_saved', expense);
        
        document.getElementById('personalExpenseType').value = '';
        document.getElementById('personalExpenseAmount').value = '';
        document.getElementById('personalExpensePerson').value = '';
        document.getElementById('personalExpenseRemarks').value = '';
        this.resetExpenseForm('personal');
        
        if (window.app.finance && document.getElementById('financeOverviewSection') && document.getElementById('financeOverviewSection').style.display !== 'none') {
            window.app.finance.calculateOverview();
        }

        // Print the expense
        this.printExpenseReceipt(expense).catch(e => {
            console.error('Expense print failed:', e);
            UIManager.showToast(t('msg.expenses.expense_saved_but_printing_failed'), 3500);
        });
    }
}

// Leaving the Expenses tab abandons any in-progress edit; showing it (or the app again) moves
// the date inputs to today if the day changed meanwhile (#118)
if (typeof window !== 'undefined') {
    window.addEventListener('aadhat:tabshown', (event) => {
        if (event.detail?.tabId !== 'expenses') ExpensesManager.cancelExpenseEdit();
        else ExpensesManager.prepareExpenseForms();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') ExpensesManager.prepareExpenseForms();
    });
}

// Data changes re-render this page (firestore-service.js emits, utils/events.js).
on(REFRESH.expensesHistory, () => ExpensesManager.renderexpensesHistory());
