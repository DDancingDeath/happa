/**
 * @fileoverview Expenses Module
 * Handles business and personal expense tracking
 * Supports expense categorization, history, and receipt printing
 * @module modules/miscellaneous
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { Helpers } from '../utils/helpers.js';
import { AuditService } from '../services/audit.js';
import { attachOlderHistoryScroll } from '../ui/infinite-scroll.js';
import { isFullHistoryLoaded, historyLoadedFrom, formatWindowDate } from '../utils/history-window.js';
import { canChangeExpense, EXPENSE_LOCKED_KEY, isPermissionDenied } from '../utils/record-permissions.js';
import { t } from '../i18n/index.js';
import { can } from '../utils/role-access.js';

/** The signed-in user, as canChangeExpense expects it. */
const currentUserInfo = () => ({ uid: AppState.currentUser?.uid, role: AppState.userRole });

/**
 * Expenses Manager - Manages expense operations
 * @class ExpensesManager
 */
export class ExpensesManager {
    /**
     * Expense currently loaded into a form for editing ({ id, category }), or null.
     * While set, saving that category updates the existing document in place.
     * @type {{id: string, category: string}|null}
     */
    static editingExpense = null;

    /**
     * Create a new expense, or update the one being edited (same doc, no delete).
     * @param {Object} expense - Expense built from the form
     * @returns {Promise<boolean|null>} true if an existing expense was updated,
     *   null if that update was refused (message already shown)
     */
    static async persistExpense(expense) {
        const editing = this.editingExpense;
        if (!editing || editing.category !== expense.category) {
            // Shown at once (also offline); the listener reconciles it (#89)
            const { committed } = FirebaseService.startSaveExpense(expense);
            committed.catch(err => {
                console.error('Expense save failed:', err);
                UIManager.showToast(t('msg.expenses.expense_not_saved', { value: err?.message || err }));
                this.refreshExpenseViews();
            });
            this.refreshExpenseViews();
            return false;
        }

        const original = (AppState.expensesHistory || []).find(e => String(e.id) === String(editing.id)) || {};
        const fields = {
            type: expense.type,
            personName: expense.personName,
            amount: expense.amount,
            remarks: expense.remarks,
            updatedAt: Helpers.getCurrentDateTime(),
            updatedBy: expense.createdBy,
            updatedByName: expense.createdByName
        };
        try {
            await this.updateExistingExpense(editing.id, fields);
        } catch (err) {
            if (!isPermissionDenied(err)) throw err;
            this.cancelExpenseEdit();
            UIManager.showToast(t(EXPENSE_LOCKED_KEY), 4000);
            return null;
        }
        this.cancelExpenseEdit();

        // Keep original creation info on the object used for printing
        if (original.date) expense.date = original.date;
        if (original.createdByName) expense.createdByName = original.createdByName;

        await AuditService.log(AuditService.ACTIONS.EDIT_EXPENSE || 'EDIT_EXPENSE', {
            expenseId: String(editing.id),
            category: expense.category,
            oldAmount: original.amount,
            newAmount: expense.amount,
            oldType: original.type,
            newType: expense.type
        });
        return true;
    }

    /**
     * Update an expense document in place. Resolves docs the same way as
     * FirebaseService.deleteExpense: numeric ids are legacy `id` fields, others are doc ids.
     * @param {string|number} expenseId
     * @param {Object} fields
     */
    static async updateExistingExpense(expenseId, fields) {
        await FirebaseService.updateExpense(expenseId, fields);
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
        this.cancelExpenseEdit();
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
    static async saveBusinessExpense() {
        const type = document.getElementById('businessExpenseType').value.trim();
        const personName = document.getElementById('businessExpensePerson').value.trim();
        const amount = Number(document.getElementById('businessExpenseAmount').value);
        const remarks = document.getElementById('businessExpenseRemarks').value.trim();

        if (!type) {
            UIManager.showModal(t('msg.expenses.enter_expense_type'));
            return;
        }

        if (!amount || amount <= 0) {
            UIManager.showModal(t('msg.common.enter_valid_amount'));
            return;
        }

        const expense = {
            type,
            personName,
            amount,
            remarks,
            category: 'business',
            date: Helpers.getCurrentDateTime(),
            createdBy: AppState.currentUser ? AppState.currentUser.uid : 'unknown',
            createdByName: AppState.userName || (AppState.currentUser ? AppState.currentUser.email : 'Unknown')
        };

        // Use withLoading for the Firebase operation
        let updated = false;
        await UIManager.withLoading(async () => {
            updated = await this.persistExpense(expense);
        });
        if (updated === null) return;
        
        
        UIManager.hapticFeedback('medium');
        UIManager.showToast(updated ? t('msg.expenses.business_expense_updated') : t('msg.expenses.business_expense_saved'));
        
        document.getElementById('businessExpenseType').value = '';
        document.getElementById('businessExpensePerson').value = '';
        document.getElementById('businessExpenseAmount').value = '';
        document.getElementById('businessExpenseRemarks').value = '';
        
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
    static async savePersonalExpense() {
        const type = document.getElementById('personalExpenseType').value.trim();
        const amount = Number(document.getElementById('personalExpenseAmount').value);
        const personName = document.getElementById('personalExpensePerson').value.trim();
        const remarks = document.getElementById('personalExpenseRemarks').value.trim();

        if (!type) {
            UIManager.showModal(t('msg.expenses.enter_expense_type'));
            return;
        }

        if (!amount || amount <= 0) {
            UIManager.showModal(t('msg.common.enter_valid_amount'));
            return;
        }

        const expense = {
            type,
            personName,
            amount,
            remarks,
            category: 'personal',
            date: Helpers.getCurrentDateTime(),
            createdBy: AppState.currentUser ? AppState.currentUser.uid : 'unknown',
            createdByName: AppState.userName || (AppState.currentUser ? AppState.currentUser.email : 'Unknown')
        };

        // Use withLoading for the Firebase operation
        let updated = false;
        await UIManager.withLoading(async () => {
            updated = await this.persistExpense(expense);
        });
        if (updated === null) return;
        
        UIManager.hapticFeedback('medium');
        UIManager.showToast(updated ? t('msg.expenses.personal_expense_updated') : t('msg.expenses.personal_expense_saved'));
        
        
        document.getElementById('personalExpenseType').value = '';
        document.getElementById('personalExpenseAmount').value = '';
        document.getElementById('personalExpensePerson').value = '';
        document.getElementById('personalExpenseRemarks').value = '';
        
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
        this.renderBusinessExpenseHistory();
        this.renderPersonalExpenseHistory();
    }

    /**
     * Render business expense history list
     * Displays expense cards with hover effects
     */
    static renderBusinessExpenseHistory() {
        const container = document.getElementById('businessExpenseHistoryList');
        const businessExpenses = AppState.expensesHistory
            .filter(p => p.category === 'business' && p.id)
            .sort((a, b) => {
                const dateA = Helpers.parseDate(a.date);
                const dateB = Helpers.parseDate(b.date);
                return (dateB?.getTime() || 0) - (dateA?.getTime() || 0);
            });
        
        this.attachExpenseScroll(container);

        if (businessExpenses.length === 0) {
            container.innerHTML = `<p style="text-align: center; color: #888; margin-top: 40px;">${Helpers.escapeHtml(this.emptyExpenseMessage('business'))}</p>`;
            return;
        }

        container.innerHTML = businessExpenses.map((payment, index) => `
            <div style="background: white; border-radius: 12px; padding: 16px; margin-bottom: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); cursor: pointer; transition: all 0.2s ease;"
                 onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,0.15)'; this.style.transform='translateY(-2px)'"
                 onmouseout="this.style.boxShadow='0 2px 4px rgba(0,0,0,0.1)'; this.style.transform='translateY(0)'"
                 onclick="window.app.expenses.viewExpenseDetails('${Helpers.escapeJsAttr(payment.id)}', 'business')">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                    <div>
                        ${payment.personName ? `<div style="font-weight: 600; font-size: 16px; color: #333;">${Helpers.escapeHtml(payment.personName)}</div>` : ''}
                        <div style="font-size: 13px; color: #666; margin-top: 4px;">${Helpers.escapeHtml(payment.type)}</div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 18px; font-weight: bold; color: #2c3e50;">₹${Helpers.escapeHtml(payment.amount)}</div>
                    </div>
                </div>
                ${payment.remarks ? `<div style="font-size: 13px; color: #777; font-style: italic; margin-top: 8px;">📝 ${Helpers.escapeHtml(payment.remarks)}</div>` : ''}
                <div style="font-size: 12px; color: #999; margin-top: 8px;">📅 ${Helpers.escapeHtml(payment.date)}${payment.createdByName ? ` • By: ${Helpers.escapeHtml(payment.createdByName)}` : ''}</div>
            </div>
        `).join('');
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
        if (isFullHistoryLoaded()) return `No ${category} expenses recorded yet`;
        return `No ${category} expenses since ${formatWindowDate(historyLoadedFrom())}`;
    }

    static renderPersonalExpenseHistory() {
        const container = document.getElementById('personalExpenseHistoryList');
        if (!container) return;
        if (!can(AppState.userRole, 'personalExpenses', AppState.settings?.roleAccess)) {
            container.innerHTML = '';
            return;
        }
        const personalExpenses = AppState.expensesHistory
            .filter(p => p.category === 'personal' && p.id)
            .sort((a, b) => {
                const dateA = Helpers.parseDate(a.date);
                const dateB = Helpers.parseDate(b.date);
                return (dateB?.getTime() || 0) - (dateA?.getTime() || 0);
            });
        
        this.attachExpenseScroll(container);

        if (personalExpenses.length === 0) {
            container.innerHTML = `<p style="text-align: center; color: #888; margin-top: 40px;">${Helpers.escapeHtml(this.emptyExpenseMessage('personal'))}</p>`;
            return;
        }

        container.innerHTML = personalExpenses.map((payment, index) => `
            <div style="background: white; border-radius: 12px; padding: 16px; margin-bottom: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); cursor: pointer; transition: all 0.2s ease;"
                 onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,0.15)'; this.style.transform='translateY(-2px)'"
                 onmouseout="this.style.boxShadow='0 2px 4px rgba(0,0,0,0.1)'; this.style.transform='translateY(0)'"
                 onclick="window.app.expenses.viewExpenseDetails('${Helpers.escapeJsAttr(payment.id)}', 'personal')">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                    <div>
                        ${payment.personName ? `<div style="font-weight: 600; font-size: 16px; color: #333;">${Helpers.escapeHtml(payment.personName)}</div>` : ''}
                        <div style="font-size: 13px; color: #666; margin-top: 4px;">${Helpers.escapeHtml(payment.type)}</div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 18px; font-weight: bold; color: #2c3e50;">₹${Helpers.escapeHtml(payment.amount)}</div>
                    </div>
                </div>
                ${payment.remarks ? `<div style="font-size: 13px; color: #777; font-style: italic; margin-top: 8px;">📝 ${Helpers.escapeHtml(payment.remarks)}</div>` : ''}
                <div style="font-size: 12px; color: #999; margin-top: 8px;">📅 ${Helpers.escapeHtml(payment.date)}${payment.createdByName ? ` • By: ${Helpers.escapeHtml(payment.createdByName)}` : ''}</div>
            </div>
        `).join('');
    }

    static async printExpenseReceipt(expense) {
        // Always use PrinterService for consistent preview/print experience
        if (window.app && window.app.printer) {
            await window.app.printer.printExpense(expense);
        } else {
            UIManager.showToast(t('msg.expenses.printer_service_not_available'));
        }
    }

    static async saveAndPrintBusiness() {
        const type = document.getElementById('businessExpenseType').value.trim();
        const personName = document.getElementById('businessExpensePerson').value.trim();
        const amount = Number(document.getElementById('businessExpenseAmount').value);
        const remarks = document.getElementById('businessExpenseRemarks').value.trim();

        if (!type) {
            UIManager.showModal(t('msg.expenses.enter_expense_type'));
            return;
        }

        if (!amount || amount <= 0) {
            UIManager.showModal(t('msg.common.enter_valid_amount'));
            return;
        }

        const expense = {
            type,
            personName,
            amount,
            remarks,
            category: 'business',
            date: Helpers.getCurrentDateTime(),
            createdBy: AppState.currentUser ? AppState.currentUser.uid : 'unknown',
            createdByName: AppState.userName || (AppState.currentUser ? AppState.currentUser.email : 'Unknown')
        };

        const updated = await this.persistExpense(expense);
        if (updated === null) return;
        
        UIManager.hapticFeedback('medium');
        UIManager.showToast(updated ? t('msg.expenses.business_expense_updated') : t('msg.expenses.business_expense_saved'));
        
        document.getElementById('businessExpenseType').value = '';
        document.getElementById('businessExpensePerson').value = '';
        document.getElementById('businessExpenseAmount').value = '';
        document.getElementById('businessExpenseRemarks').value = '';
        
        if (window.app.finance && document.getElementById('financeOverviewSection') && document.getElementById('financeOverviewSection').style.display !== 'none') {
            window.app.finance.calculateOverview();
        }

        // Print the expense
        this.printExpenseReceipt(expense).catch(e => {
            console.error('Expense print failed:', e);
            UIManager.showToast(t('msg.expenses.expense_saved_but_printing_failed'), 3500);
        });
    }

    static viewExpenseDetails(expenseId, category) {
        const expense = AppState.expensesHistory.find(p => p.id == expenseId && p.category === category);
        
        if (!expense) {
            UIManager.showToast(t('msg.expenses.expense_not_found'));
            return;
        }

        // Store current expense for edit/delete operations
        window.currentExpenseId = String(expense.id);
        window.currentExpenseCategory = category;

        const content = `
            <div style="padding: 8px 0;">
                <div style="background: #f8f9fa; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
                    <div style="display: grid; gap: 12px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                            <div style="display: flex; align-items: center;">
                                <span style="font-size: 20px; margin-right: 12px;">🏷️</span>
                                <span style="font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">Category</span>
                            </div>
                            <span style="font-size: 15px; color: #333; font-weight: 600; text-transform: capitalize;">${Helpers.escapeHtml(category)}</span>
                        </div>
                        
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                            <div style="display: flex; align-items: center;">
                                <span style="font-size: 20px; margin-right: 12px;">📅</span>
                                <span style="font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">Date</span>
                            </div>
                            <span style="font-size: 14px; color: #333; font-weight: 500;">${Helpers.escapeHtml(expense.date)}</span>
                        </div>
                        
                        ${expense.createdByName ? `
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                            <div style="display: flex; align-items: center;">
                                <span style="font-size: 20px; margin-right: 12px;">👨‍💼</span>
                                <span style="font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">Created By</span>
                            </div>
                            <span style="font-size: 14px; color: #333; font-weight: 500;">${Helpers.escapeHtml(expense.createdByName)}</span>
                        </div>
                        ` : ''}
                    </div>
                </div>
                
                <div style="background: white; border-radius: 12px; padding: 24px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 2px solid #f0f0f0;">
                        <span style="font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">Type</span>
                        <span style="font-size: 18px; font-weight: 600; color: #2c3e50;">${Helpers.escapeHtml(expense.type)}</span>
                    </div>
                    
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 2px solid #f0f0f0;">
                        <span style="font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">Amount</span>
                        <span style="font-size: 36px; font-weight: bold; color: #667eea; letter-spacing: 1px;">₹${Helpers.escapeHtml(expense.amount)}</span>
                    </div>
                    
                    ${expense.personName ? `
                    <div style="display: flex; align-items: center; justify-content: space-between;">
                        <span style="font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">Person Name</span>
                        <span style="font-size: 18px; font-weight: 500; color: #2c3e50;">👤 ${Helpers.escapeHtml(expense.personName)}</span>
                    </div>
                    ` : ''}
                </div>
                
                ${expense.remarks ? `
                <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 16px; border-radius: 8px;">
                    <div style="font-size: 11px; color: #856404; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">📝 Remarks</div>
                    <div style="font-size: 14px; color: #856404; line-height: 1.5;">${Helpers.escapeHtml(expense.remarks)}</div>
                </div>
                ` : ''}
            </div>
        `;

        document.getElementById('expenseDetailsContent').innerHTML = content;
        // Hide what the rules would refuse (#18): members change only their own, recent expenses
        const allowed = canChangeExpense(expense, currentUserInfo());
        ['expenseDeleteBtn', 'expenseEditBtn'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.style.display = allowed ? '' : 'none';
        });
        document.getElementById('expenseDetailsOverlay').classList.add('active');
    }

    static closeExpenseDetails() {
        document.getElementById('expenseDetailsOverlay').classList.remove('active');
        window.currentExpenseId = null;
        window.currentExpenseCategory = null;
    }

    static editExpenseFromModal() {
        const expenseId = window.currentExpenseId;
        const category = window.currentExpenseCategory;
        
        if (!expenseId || !category) {
            UIManager.showToast(t('msg.expenses.expense_not_found'));
            return;
        }

        this.closeExpenseDetails();
        this.editExpense(expenseId, category);
    }

    static async confirmDeleteExpense() {
        const expenseId = window.currentExpenseId;
        const category = window.currentExpenseCategory;
        
        if (!expenseId || !category) {
            UIManager.showToast(t('msg.expenses.expense_not_found'));
            return;
        }

        // Show confirmation toast with action
        const confirmed = await new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 10000;';
            
            const dialog = document.createElement('div');
            dialog.style.cssText = 'background: white; padding: 24px; border-radius: 16px; max-width: 320px; box-shadow: 0 10px 40px rgba(0,0,0,0.3);';
            dialog.innerHTML = `
                <div style="font-size: 18px; font-weight: 600; color: #333; margin-bottom: 12px;">Delete Expense</div>
                <div style="font-size: 14px; color: #666; margin-bottom: 24px;">Are you sure you want to delete this expense? This action cannot be undone.</div>
                <div style="display: flex; gap: 12px;">
                    <button id="cancelDelete" style="flex: 1; padding: 12px; border: 1px solid #ddd; background: white; border-radius: 8px; font-size: 14px; font-weight: 500; color: #666; cursor: pointer;">Cancel</button>
                    <button id="confirmDelete" style="flex: 1; padding: 12px; border: none; background: #dc3545; border-radius: 8px; font-size: 14px; font-weight: 500; color: white; cursor: pointer;">Delete</button>
                </div>
            `;
            
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            
            document.getElementById('cancelDelete').onclick = () => {
                document.body.removeChild(overlay);
                resolve(false);
            };
            
            document.getElementById('confirmDelete').onclick = () => {
                document.body.removeChild(overlay);
                resolve(true);
            };
            
            overlay.onclick = (e) => {
                if (e.target === overlay) {
                    document.body.removeChild(overlay);
                    resolve(false);
                }
            };
        });

        if (!confirmed) return;

        this.closeExpenseDetails();
        await this.deleteExpense(expenseId, category, false);
    }

    static async editExpense(expenseId, category) {
        this.cancelExpenseEdit();
        const expense = AppState.expensesHistory.find(p => p.id == expenseId);
        if (!expense) {
            UIManager.showToast(t('msg.expenses.expense_not_found'));
            return;
        }
        if (!canChangeExpense(expense, currentUserInfo())) {
            UIManager.showToast(t(EXPENSE_LOCKED_KEY), 4000);
            return;
        }

        // Populate the form fields
        if (category === 'business') {
            document.getElementById('businessExpenseType').value = expense.type || '';
            document.getElementById('businessExpenseAmount').value = expense.amount || '';
            document.getElementById('businessExpensePerson').value = expense.personName || '';
            document.getElementById('businessExpenseRemarks').value = expense.remarks || '';
        } else {
            document.getElementById('personalExpenseType').value = expense.type || '';
            document.getElementById('personalExpenseAmount').value = expense.amount || '';
            document.getElementById('personalExpensePerson').value = expense.personName || '';
            document.getElementById('personalExpenseRemarks').value = expense.remarks || '';
        }

        // Edit in place: saving this category updates the same document (nothing is deleted)
        this.editingExpense = { id: String(expense.id), category };

        // Abandoning the edit (clearing the amount, switching expense tab or app tab) must
        // turn the next save back into a new expense instead of overwriting this one.
        const amountInput = document.getElementById(category === 'business' ? 'businessExpenseAmount' : 'personalExpenseAmount');
        const editing = this.editingExpense;
        const onAmountInput = () => {
            if (amountInput.value.trim() === '' && this.editingExpense === editing) {
                this.cancelExpenseEdit();
            }
        };
        amountInput?.addEventListener('input', onAmountInput);
        editing.cleanup = () => amountInput?.removeEventListener('input', onAmountInput);
        
        UIManager.showToast(t('msg.expenses.edit_expense_save_update'));
    }

    /** Stops editing: the next save creates a new expense. */
    static cancelExpenseEdit() {
        this.editingExpense?.cleanup?.();
        this.editingExpense = null;
    }

    static async deleteExpense(expenseId, category, showConfirm = true) {
        if (!expenseId || expenseId === 'undefined') {
            console.error('Invalid expense ID:', expenseId);
            UIManager.showToast(t('msg.expenses.invalid_expense_id'));
            return;
        }
        
        const list = AppState.expensesHistory || [];
        const index = list.findIndex(e => String(e.id) === String(expenseId));
        const existing = index !== -1 ? list[index] : null;
        if (existing && !canChangeExpense(existing, currentUserInfo())) {
            UIManager.showToast(t(EXPENSE_LOCKED_KEY), 4000);
            return;
        }

        if (showConfirm && !confirm(t('msg.expenses.are_sure_want_delete_expense'))) {
            return;
        }

        try {
            // Remove from the screen at once (#89); restored if the delete fails
            if (index !== -1) list.splice(index, 1);
            this.refreshExpenseViews();
            await FirebaseService.deleteExpense(String(expenseId));
            if (this.editingExpense && String(this.editingExpense.id) === String(expenseId)) {
                this.cancelExpenseEdit();
            }
            await AuditService.log(AuditService.ACTIONS.DELETE_EXPENSE || 'DELETE_EXPENSE', {
                expenseId: String(expenseId),
                category: existing?.category || category,
                amount: existing?.amount,
                type: existing?.type
            });
            UIManager.hapticFeedback('medium');
            UIManager.showToast(t('msg.expenses.expense_deleted'));
            
            if (window.app.finance && document.getElementById('financeOverviewSection') && document.getElementById('financeOverviewSection').style.display !== 'none') {
                window.app.finance.calculateOverview();
            }
        } catch (error) {
            console.error('Error deleting expense:', error);
            if (existing && !(AppState.expensesHistory || []).some(e => String(e.id) === String(expenseId))) {
                AppState.expensesHistory = [...(AppState.expensesHistory || []), existing];
            }
            this.refreshExpenseViews();
            UIManager.showToast(isPermissionDenied(error) ? t(EXPENSE_LOCKED_KEY) : t('msg.expenses.failed_delete_expense'), isPermissionDenied(error) ? 4000 : undefined);
        }
    }

    static async saveAndPrintPersonal() {
        const type = document.getElementById('personalExpenseType').value.trim();
        const amount = Number(document.getElementById('personalExpenseAmount').value);
        const personName = document.getElementById('personalExpensePerson').value.trim();
        const remarks = document.getElementById('personalExpenseRemarks').value.trim();

        if (!type) {
            UIManager.showModal(t('msg.expenses.enter_expense_type'));
            return;
        }

        if (!amount || amount <= 0) {
            UIManager.showModal(t('msg.common.enter_valid_amount'));
            return;
        }

        const expense = {
            type,
            personName,
            amount,
            remarks,
            category: 'personal',
            date: Helpers.getCurrentDateTime(),
            createdBy: AppState.currentUser ? AppState.currentUser.uid : 'unknown',
            createdByName: AppState.userName || (AppState.currentUser ? AppState.currentUser.email : 'Unknown')
        };

        const updated = await this.persistExpense(expense);
        if (updated === null) return;
        
        UIManager.hapticFeedback('medium');
        UIManager.showToast(updated ? t('msg.expenses.personal_expense_updated') : t('msg.expenses.personal_expense_saved'));
        
        document.getElementById('personalExpenseType').value = '';
        document.getElementById('personalExpenseAmount').value = '';
        document.getElementById('personalExpensePerson').value = '';
        document.getElementById('personalExpenseRemarks').value = '';
        
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

// Leaving the Expenses tab abandons any in-progress edit
if (typeof window !== 'undefined') {
    window.addEventListener('aadhat:tabshown', (event) => {
        if (event.detail?.tabId !== 'expenses') ExpensesManager.cancelExpenseEdit();
    });
}
