/**
 * @fileoverview Cash Management Module
 * Handles daily cash sessions, sign-in/out, transactions, and reconciliation
 * Tracks cash flow from sales, purchases, and expenses
 * @module modules/cash-management
 */

import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { todayLocalISO, parseLocalDate, parseAnyBillDate } from '../utils/dates.js';
import { needsHistoryFrom, ensureHistoryFrom } from '../utils/history-window.js';
import { sessionTotals, parseCashAmount, isNotCounted, lastCountedSession, autoCloseFields } from '../utils/cash-session.js';
import { round2, outstandingDue } from '../utils/money.js';
import { evaluateCashCount, toFlags } from '../utils/bill-checks.js';
import { OutstandingManager } from './outstanding.js';
import { dueEvents, sumDueEvents, saleTimePayment, normalizeParty, sameParty, billParty } from '../utils/due-payments.js';
import { t } from '../i18n/index.js';
import { can } from '../utils/role-access.js';
import { tip } from '../tip/index.js';
import { cashCloseProps } from '../tip/scenarios/cash-close.js';

const L = (key, params) => Helpers.escapeHtml(t(key, params));

/** TIP CashClose run (#217); never throws. */
function startCashCloseRun(session, expected, counted, difference) {
    try {
        return tip.start('CashClose', {
            flags: { offline: typeof navigator !== 'undefined' && navigator.onLine === false },
            props: cashCloseProps({ session, expected, counted, difference })
        });
    } catch (_) {
        return { complete() {}, completeAndFail() {} };
    }
}

/** Cash-tab bill picker values that are not bills. */
const DUE_BILL_NONE = '__none__';
const DUE_BILL_UNLINKED = '__nobill__';

const sessionRef = (sessionId) => {
    const name = window.getCollection ? window.getCollection('cashManagement') : 'cashManagement';
    return FirebaseService.db.collection(name).doc(String(sessionId));
};

const billTime = (value) => {
    const d = parseAnyBillDate(value);
    return d ? d.getTime() : NaN;
};

/**
 * Cash Management Manager - Manages daily cash operations
 * @class CashManagementManager
 */
export class CashManagementManager {
    /**
     * Current day's cash session
     * @type {Object|null}
     * @static
     */
    static todaySession = null;
    
    /**
     * Aggregated transactions for today
     * @type {{cashSales: number, cashPurchases: number, businessExpenses: number, personalExpenses: number, dueReceived: number, duePaid: number, cashDeposits: number}}
     * @static
     */
    static todayTransactions = {
        cashSales: 0,
        cashPurchases: 0,
        businessExpenses: 0,
        personalExpenses: 0,
        dueReceived: 0,
        duePaid: 0,
        cashDeposits: 0
    };

    /**
     * Initialize cash management module
     * Loads today's session, calculates transactions, and sets up UI
     * @async
     * @returns {Promise<void>}
     */
    static async init() {
        await UIManager.withLoading(async () => {
            // Load all sessions once and cache
            const sessions = await FirebaseService.loadCashSessions();
            this.cachedSessions = sessions;
            
            // Auto sign-out any previous day sessions that weren't closed
            await this.autoSignOutPreviousDays(sessions);
            
            // Load today's cash session from cached data
            this.loadTodaySessionFromCache(sessions);
            
            // Recalculate transactions to get latest data
            this.calculateTodayTransactions().catch(e => console.error('Cash transactions refresh failed:', e));
        });
        this.updateUI();
        this.loadCustomerOptions();
        this.renderHistoryFromCache();
        
        // Listen for cash amount input changes for validation
        const signOutInput = document.getElementById('cashSignOutAmount');
        if (signOutInput) {
            signOutInput.addEventListener('input', () => this.validateSignOut());
        }
        
        // Listen for transaction type changes
        const transactionType = document.getElementById('cashTransactionType');
        if (transactionType) {
            transactionType.addEventListener('change', () => this.updateTransactionForm());
        }
        const partyInput = document.getElementById('partyName');
        if (partyInput) {
            partyInput.addEventListener('input', () => this.populateDueBills());
        }
        const dueBillSelect = document.getElementById('dueBillSelect');
        if (dueBillSelect) {
            dueBillSelect.addEventListener('change', () => this.showDueBillDetails());
        }
        
        // Initialize form state (hide customer name for default "Cash Added")
        this.updateTransactionForm();
    }
    
    /**
     * Update form fields based on transaction type
     * Shows/hides customer name field and updates labels
     */
    static updateTransactionForm() {
        const type = document.getElementById('cashTransactionType').value;
        const amountLabel = document.getElementById('amountLabel');
        const notesLabel = document.getElementById('notesLabel');
        const customerNameRow = document.getElementById('customerNameRow');
        const dueBillRow = document.getElementById('dueBillRow');
        if (dueBillRow) dueBillRow.style.display = type === 'deposit' ? 'none' : 'block';
        if (type !== 'deposit') this.populateDueBills();
        
        if (type === 'deposit') {
            // Cash deposit - hide customer name
            if (customerNameRow) customerNameRow.style.display = 'none';
            if (amountLabel) amountLabel.textContent = t('ui.cash.amount_added');
            if (notesLabel) notesLabel.textContent = t('ui.cash.reason_optional');
        } else if (type === 'paid') {
            // Payment to supplier - show customer name
            if (customerNameRow) customerNameRow.style.display = 'block';
            if (amountLabel) amountLabel.textContent = t('ui.cash.amount_paid');
            if (notesLabel) notesLabel.textContent = t('ui.cash.notes_optional');
        } else {
            // Payment from customer - show customer name
            if (customerNameRow) customerNameRow.style.display = 'block';
            if (amountLabel) amountLabel.textContent = t('ui.cash.amount_received');
            if (notesLabel) notesLabel.textContent = t('ui.cash.notes_optional');
        }
    }

    /**
     * Open bills for the Cash tab "Due received/paid" picker (#98): sales
     * with money to collect, or purchases with money to pay, for the party
     * whose name is typed — exact name only (case/space-insensitive), and
     * nothing until a name is typed. Nothing is pre-selected: the user must
     * pick a bill or "No bill" explicitly.
     */
    static populateDueBills() {
        const select = document.getElementById('dueBillSelect');
        if (!select) return;
        const type = document.getElementById('cashTransactionType')?.value;
        const party = normalizeParty(document.getElementById('partyName')?.value);
        const sources = type === 'paid'
            ? [['purchase', AppState.purchaseHistory]]
            : [['retail', AppState.retailSalesHistory], ['wholesale', AppState.salesHistory]];
        const bills = [];
        if (party) {
            sources.forEach(([billType, list]) => {
                (list || []).forEach(bill => {
                    const due = outstandingDue(bill);
                    if (due <= 0 || !sameParty(billParty(bill), party)) return;
                    bills.push({ billType, bill, due, time: billTime(bill.date) || 0 });
                });
            });
        }
        bills.sort((a, b) => a.time - b.time); // oldest due first
        const options = [`<option value="${DUE_BILL_NONE}" selected>${L('ui.cash.choose_bill_option')}</option>`];
        bills.slice(0, 50).forEach(({ billType, bill, due }) => {
            options.push(`<option value="${Helpers.escapeHtml(`${billType}|${bill.id}`)}">#${Helpers.escapeHtml(bill.billNumber || String(bill.id).slice(0, 8))} · ${Helpers.escapeHtml(Helpers.formatDate(bill.date))} · ${L('ui.cash.bill_due', { amount: round2(due) })}</option>`);
        });
        options.push(`<option value="${DUE_BILL_UNLINKED}">${L('ui.cash.no_bill_option')}</option>`);
        select.innerHTML = options.join('');
        select.value = DUE_BILL_NONE;
        this.showDueBillDetails();
        if (!party) {
            const hint = document.getElementById('dueBillHint');
            if (hint) hint.textContent = t('ui.cash.type_full_name');
        } else if (bills.length === 0) {
            const hint = document.getElementById('dueBillHint');
            if (hint) hint.textContent = t('ui.cash.no_open_bill_for_name');
        }
    }

    /** Parse the picker value into a bill reference, or null for none/unlinked. */
    static parseDueBillChoice(value) {
        if (!value || value === DUE_BILL_NONE || value === DUE_BILL_UNLINKED) return null;
        const sep = value.indexOf('|');
        if (sep <= 0) return null;
        return { billType: value.slice(0, sep), billId: value.slice(sep + 1) };
    }

    /** Shows the chosen bill's party, date and current due under the picker. */
    static showDueBillDetails() {
        const hint = document.getElementById('dueBillHint');
        if (!hint) return;
        const value = document.getElementById('dueBillSelect')?.value;
        if (value === DUE_BILL_UNLINKED) {
            hint.textContent = t('ui.cash.unlinked_hint');
            return;
        }
        const choice = this.parseDueBillChoice(value);
        const bill = choice ? OutstandingManager.findBill(choice.billType, choice.billId) : null;
        hint.textContent = bill
            ? t('ui.cash.bill_hint', { party: billParty(bill) || 'N/A', date: Helpers.formatDate(bill.date), amount: round2(outstandingDue(bill)) })
            : t('msg.cash.choose_bill_or_no_bill');
    }

    /**
     * Auto sign-out any previous day sessions that weren't closed
     * Calculates transactions for that day, sets closing balance (actual cash) to 0
     * @param {Array} sessions - Cached sessions array
     * @async
     * @returns {Promise<void>}
     */
    static async autoSignOutPreviousDays(sessions) {
        try {
            const today = todayLocalISO(); // YYYY-MM-DD (local day, not UTC)
            
            // Find any sessions from earlier days that are not signed out
            let unclosedSessions = sessions.filter(s => s.date && s.date < today && !s.signedOut);

            // Closing figures are computed from that day's bills/expenses, which
            // may be older than the loaded history window: load that range first,
            // and skip (retry next time) any day we couldn't load rather than
            // writing wrong totals.
            const dayStart = (s) => parseLocalDate(s.date)?.getTime();
            const isOlder = (s) => Number.isFinite(dayStart(s)) && needsHistoryFrom(dayStart(s));
            const needOlder = unclosedSessions.filter(isOlder);
            if (needOlder.length > 0) {
                const oldest = Math.min(...needOlder.map(dayStart));
                let covered = false;
                try {
                    covered = await ensureHistoryFrom(oldest);
                } catch (err) {
                    console.warn('Could not load older history for auto sign-out:', err?.message || err);
                }
                if (!covered) {
                    unclosedSessions = unclosedSessions.filter(s => !isOlder(s));
                }
            }
            
            // Update all unclosed sessions in parallel
            const updatePromises = unclosedSessions.map(async (session) => {
                try {
                    const ref = sessionRef(session.id);
                    // Re-read inside a transaction so we never clobber a session that was
                    // signed out (or otherwise changed) on another device after we loaded it.
                    const updatedSession = await FirebaseService.db.runTransaction(async (tx) => {
                        const snap = await tx.get(ref);
                        if (!snap.exists) return null;
                        const fresh = { id: snap.id, ...snap.data() };
                        if (fresh.signedOut || fresh.date !== session.date) return null;

                        // Calculate transactions for that specific date
                        const transactions = this.calculateTransactionsForDate(fresh.date, fresh);
                        // Nobody counted the drawer: record "not counted", never a fake ₹0 count (#101)
                        const closingFields = autoCloseFields(fresh, transactions);
                        tx.update(ref, closingFields);
                        return { ...fresh, ...closingFields };
                    });
                    if (!updatedSession) return false;

                    // Update in cache too
                    const idx = sessions.findIndex(s => s.id === session.id);
                    if (idx !== -1) sessions[idx] = updatedSession;
                    
                    console.log(`Auto signed-out session for ${session.date} with expected ₹${updatedSession.expectedBalance}`);
                    return true;
                } catch (err) {
                    // Transactions need the server; offline we simply retry on next load
                    console.warn(`Auto sign-out skipped for ${session.date}:`, err?.message || err);
                    return false;
                }
            });
            
            const results = await Promise.all(updatePromises);
            const closedCount = results.filter(Boolean).length;
            
            if (closedCount > 0) {
                UIManager.showToast(t('msg.cash.auto_closed_previous_session_s', { closedCount }));
            }
        } catch (error) {
            console.error('Error auto signing out previous sessions:', error);
        }
    }

    /**
     * Calculate transactions for a specific date
     * Used for auto-closing sessions and historical data
     * @param {string} dateStr - Date in YYYY-MM-DD format
     * @param {Object} session - The cash session for that date
     * @returns {Object} Transaction totals
     */
    static calculateTransactionsForDate(dateStr, session) {
        const dayStart = parseLocalDate(dateStr);
        const dateStart = dayStart ? dayStart.getTime() : NaN;
        const dateEnd = dayStart ? new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1).getTime() : NaN;
        const inDay = (value) => {
            const t = billTime(value);
            return t >= dateStart && t < dateEnd;
        };

        const transactions = {
            cashSales: 0,
            cashPurchases: 0,
            businessExpenses: 0,
            personalExpenses: 0,
            dueReceived: 0,
            duePaid: 0,
            cashDeposits: 0
        };

        const sales = AppState.salesHistory || [];
        const retailSales = AppState.retailSalesHistory || [];
        const purchases = AppState.purchaseHistory || [];

        // Cash paid when the bill was saved (payment.* is canonical); cash
        // collected later on the bill counts as a due payment on its own day.
        [...sales, ...retailSales].forEach(sale => {
            if (inDay(sale.date)) transactions.cashSales += saleTimePayment(sale).cash;
        });
        purchases.forEach(purchase => {
            if (inDay(purchase.date)) transactions.cashPurchases += saleTimePayment(purchase).cash;
        });

        // Calculate cash expenses
        const payments = AppState.expensesHistory || [];
        payments.forEach(payment => {
            if (inDay(payment.date)) {
                const amount = Number(payment.amount) || 0;
                const category = (payment.category || payment.type || '').toLowerCase();
                if (category === 'personal') {
                    transactions.personalExpenses += amount;
                } else {
                    transactions.businessExpenses += amount;
                }
            }
        });

        // Due payments made that day: recorded on bills and/or as drawer legs
        // in the session, counted once (#98). Only the cash part is drawer cash.
        const dues = sumDueEvents(dueEvents({
            bills: { retail: retailSales, wholesale: sales, purchase: purchases },
            sessions: session ? [session] : [],
            from: dateStart,
            to: dateEnd
        }));
        transactions.dueReceived = dues.receivedCash;
        transactions.duePaid = dues.paidCash;

        // Get cash deposits from session
        if (session && session.cashDeposits) {
            session.cashDeposits.forEach(deposit => {
                transactions.cashDeposits += Number(deposit.amount) || 0;
            });
        }

        Object.keys(transactions).forEach(k => { transactions[k] = round2(transactions[k]); });
        return transactions;
    }

    /**
     * Load today's cash session from cached sessions
     * @param {Array} sessions - Cached sessions array
     */
    static loadTodaySessionFromCache(sessions) {
        const today = todayLocalISO(); // YYYY-MM-DD (local day)
        this.todaySession = sessions.find(s => s.date === today) || null;
    }

    /**
     * Load today's cash session from Firebase
     * Finds session matching today's date (YYYY-MM-DD format)
     * @async
     * @returns {Promise<void>}
     */
    static async loadTodaySession() {
        try {
            const today = todayLocalISO(); // YYYY-MM-DD (local day)
            const sessions = await FirebaseService.loadCashSessions();
            
            this.todaySession = sessions.find(s => s.date === today);
            
            if (this.todaySession) {
                // Session exists - calculate transactions
                await this.calculateTodayTransactions();
            }
        } catch (error) {
            console.error('Error loading cash session:', error);
        }
    }

    /**
     * Calculate all cash transactions for today
     * Aggregates sales, purchases, expenses, and due payments
     * @async
     * @returns {Promise<void>}
     */
    static async calculateTodayTransactions() {
        this.todayTransactions = this.calculateTransactionsForDate(todayLocalISO(), this.todaySession);
    }

    static updateUI() {
        const signInSection = document.getElementById('cashSignInSection');
        const signOutSection = document.getElementById('cashSignOutSection');
        const cashDepositSection = document.getElementById('cashDepositSection');
        const cashStatusCard = document.getElementById('cashStatusCard');

        if (this.todaySession) {
            // Session exists
            if (this.todaySession.signedOut) {
                // Already signed out for today - hide all action sections
                signInSection.style.display = 'none';
                signOutSection.style.display = 'none';
                cashDepositSection.style.display = 'none';
                if (cashStatusCard) cashStatusCard.style.display = 'block';
                
                this.updateStatusCard();
            } else {
                // Signed in but not signed out
                signInSection.style.display = 'none';
                signOutSection.style.display = 'block';
                cashDepositSection.style.display = 'block';
                if (cashStatusCard) cashStatusCard.style.display = 'block';
                
                this.updateStatusCard();
                this.updateSignOutSummary();
            }
        } else {
            // No session - show sign in with empty status
            signInSection.style.display = 'block';
            this.prefillOpeningAmount();
            signOutSection.style.display = 'none';
            cashDepositSection.style.display = 'none';
            if (cashStatusCard) cashStatusCard.style.display = 'block';
            
            this.updateStatusCard();
        }
    }

    static updateStatusCard() {
        const statusOpeningBalance = document.getElementById('statusOpeningBalance');
        const statusCashIn = document.getElementById('statusCashIn');
        const statusCashOut = document.getElementById('statusCashOut');
        const statusAvailable = document.getElementById('statusAvailable');
        const statusCashAdded = document.getElementById('statusCashAdded');
        const statusBuy = document.getElementById('statusBuy');
        const statusSale = document.getElementById('statusSale');
        const statusOthers = document.getElementById('statusOthers');
        const statusExpected = document.getElementById('statusExpected');
        const statusActual = document.getElementById('statusActual');
        const statusDiff = document.getElementById('statusDiff');
        
        // Card containers for show/hide
        const statusOpeningCard = document.getElementById('statusOpeningCard');
        const statusCashInCard = document.getElementById('statusCashInCard');
        const statusCashOutCard = document.getElementById('statusCashOutCard');
        const statusAvailableCard = document.getElementById('statusAvailableCard');
        const statusCashAddedCard = document.getElementById('statusCashAddedCard');
        const statusBuyCard = document.getElementById('statusBuyCard');
        const statusSaleCard = document.getElementById('statusSaleCard');
        const statusOthersCard = document.getElementById('statusOthersCard');
        const statusExpectedCard = document.getElementById('statusExpectedCard');
        const statusActualCard = document.getElementById('statusActualCard');
        const statusDiffCard = document.getElementById('statusDiffCard');

        if (!this.todaySession) {
            // No session - show 4 blocks with zeros
            if (statusOpeningCard) statusOpeningCard.style.display = 'block';
            if (statusCashInCard) statusCashInCard.style.display = 'block';
            if (statusCashOutCard) statusCashOutCard.style.display = 'block';
            if (statusAvailableCard) statusAvailableCard.style.display = 'block';
            if (statusCashAddedCard) statusCashAddedCard.style.display = 'none';
            if (statusBuyCard) statusBuyCard.style.display = 'none';
            if (statusSaleCard) statusSaleCard.style.display = 'none';
            if (statusOthersCard) statusOthersCard.style.display = 'none';
            if (statusExpectedCard) statusExpectedCard.style.display = 'none';
            if (statusActualCard) statusActualCard.style.display = 'none';
            if (statusDiffCard) statusDiffCard.style.display = 'none';
            
            if (statusOpeningBalance) statusOpeningBalance.textContent = '₹0';
            if (statusCashIn) statusCashIn.textContent = '₹0';
            if (statusCashOut) statusCashOut.textContent = '₹0';
            if (statusAvailable) statusAvailable.textContent = '₹0';
            return;
        }

        const opening = this.todaySession.openingBalance || 0;
        const cashAdded = this.todayTransactions.cashDeposits || 0;
        const purchases = this.todayTransactions.cashPurchases || 0;
        const sales = this.todayTransactions.cashSales || 0;
        const dueReceived = this.todayTransactions.dueReceived || 0;
        const totalExpenses = (this.todayTransactions.businessExpenses || 0) + (this.todayTransactions.personalExpenses || 0);
        const duePaid = this.todayTransactions.duePaid || 0;
        const others = totalExpenses + duePaid;
        const expected = this.calculateExpectedCash();
        
        // Calculate totals for 4-block view
        // Cash In = Opening + Cash Added + Sales + Due Received
        const totalCashIn = opening + cashAdded + sales + dueReceived;
        const totalCashOut = purchases + duePaid + totalExpenses;
        const availableCash = totalCashIn - totalCashOut;

        if (this.todaySession.signedOut) {
            // Signed out - show Opening Balance + 7 other blocks
            if (statusOpeningCard) statusOpeningCard.style.display = 'block';
            if (statusCashInCard) statusCashInCard.style.display = 'none';
            if (statusCashOutCard) statusCashOutCard.style.display = 'none';
            if (statusAvailableCard) statusAvailableCard.style.display = 'none';
            if (statusCashAddedCard) statusCashAddedCard.style.display = 'block';
            if (statusBuyCard) statusBuyCard.style.display = 'block';
            if (statusSaleCard) statusSaleCard.style.display = 'block';
            if (statusOthersCard) statusOthersCard.style.display = 'block';
            if (statusExpectedCard) statusExpectedCard.style.display = 'block';
            if (statusActualCard) statusActualCard.style.display = 'block';
            if (statusDiffCard) statusDiffCard.style.display = 'block';
            
            const actual = this.todaySession.closingBalance || 0;
            const diff = actual - expected;
            const absDiff = Math.abs(diff);
            
            // Color coding for difference amount
            let diffColor = '#22c55e'; // green for < 50
            if (absDiff >= 500) diffColor = '#ef4444'; // red for >= 500
            else if (absDiff >= 50) diffColor = '#f59e0b'; // orange for >= 50
            
            if (statusOpeningBalance) statusOpeningBalance.textContent = `₹${opening}`;
            if (statusCashAdded) statusCashAdded.textContent = `₹${cashAdded}`;
            if (statusBuy) statusBuy.textContent = `₹${purchases}`;
            if (statusSale) statusSale.textContent = `₹${sales}`;
            if (statusOthers) statusOthers.textContent = `₹${others}`;
            if (statusExpected) statusExpected.textContent = `₹${expected}`;
            if (statusActual) statusActual.textContent = `₹${actual}`;
            if (statusDiff) {
                statusDiff.textContent = `${diff >= 0 ? '+' : ''}₹${diff.toFixed(2)}`;
                statusDiff.style.color = diffColor;
            }
        } else {
            // Ongoing session - show 4 blocks
            if (statusOpeningCard) statusOpeningCard.style.display = 'block';
            if (statusCashInCard) statusCashInCard.style.display = 'block';
            if (statusCashOutCard) statusCashOutCard.style.display = 'block';
            if (statusAvailableCard) statusAvailableCard.style.display = 'block';
            if (statusCashAddedCard) statusCashAddedCard.style.display = 'none';
            if (statusBuyCard) statusBuyCard.style.display = 'none';
            if (statusSaleCard) statusSaleCard.style.display = 'none';
            if (statusOthersCard) statusOthersCard.style.display = 'none';
            if (statusExpectedCard) statusExpectedCard.style.display = 'none';
            if (statusActualCard) statusActualCard.style.display = 'none';
            if (statusDiffCard) statusDiffCard.style.display = 'none';
            
            if (statusOpeningBalance) statusOpeningBalance.textContent = `₹${opening}`;
            if (statusCashIn) statusCashIn.textContent = `₹${totalCashIn}`;
            if (statusCashOut) statusCashOut.textContent = `₹${totalCashOut}`;
            if (statusAvailable) statusAvailable.textContent = `₹${availableCash}`;
        }
    }

    static calculateExpectedCash() {
        if (!this.todaySession) return 0;
        return sessionTotals(this.todaySession, this.todayTransactions).expected;
    }

    static updateSignOutSummary() {
        const openingBalanceEl = document.getElementById('openingBalanceTotal');
        const cashSalesEl = document.getElementById('cashSalesTotal');
        const cashPurchasesEl = document.getElementById('cashPurchasesTotal');
        const businessExpensesEl = document.getElementById('cashBusinessExpensesTotal');
        const personalExpensesEl = document.getElementById('cashPersonalExpensesTotal');
        const dueReceivedEl = document.getElementById('dueReceivedTotal');
        const duePaidEl = document.getElementById('duePaidTotal');
        const cashDepositsEl = document.getElementById('cashDepositsTotal');
        const totalCashInEl = document.getElementById('totalCashIn');
        const totalCashOutEl = document.getElementById('totalCashOut');
        const expectedCashEl = document.getElementById('expectedCashAmount');
        
        const opening = this.todaySession?.openingBalance || 0;
        const sales = this.todayTransactions.cashSales || 0;
        const purchases = this.todayTransactions.cashPurchases || 0;
        const businessExpenses = this.todayTransactions.businessExpenses || 0;
        const personalExpenses = this.todayTransactions.personalExpenses || 0;
        const dueReceived = this.todayTransactions.dueReceived || 0;
        const duePaid = this.todayTransactions.duePaid || 0;
        const deposits = this.todayTransactions.cashDeposits || 0;
        
        const totals = sessionTotals(this.todaySession, this.todayTransactions);
        const totalCashIn = round2(totals.opening + totals.cashIn);
        const totalCashOut = totals.cashOut;
        
        if (openingBalanceEl) openingBalanceEl.textContent = `₹${opening}`;
        if (cashSalesEl) cashSalesEl.textContent = `₹${sales}`;
        if (cashPurchasesEl) cashPurchasesEl.textContent = `₹${purchases}`;
        if (businessExpensesEl) businessExpensesEl.textContent = `₹${businessExpenses}`;
        if (personalExpensesEl) personalExpensesEl.textContent = `₹${personalExpenses}`;
        if (dueReceivedEl) dueReceivedEl.textContent = `₹${dueReceived}`;
        if (duePaidEl) duePaidEl.textContent = `₹${duePaid}`;
        if (cashDepositsEl) cashDepositsEl.textContent = `₹${deposits}`;
        if (totalCashInEl) totalCashInEl.textContent = `₹${totalCashIn}`;
        if (totalCashOutEl) totalCashOutEl.textContent = `₹${totalCashOut}`;
        
        const expected = this.calculateExpectedCash();
        if (expectedCashEl) expectedCashEl.textContent = `₹${expected}`;
    }

    /**
     * Suggest the last counted closing as today's opening (#101). Editable;
     * never overwrites what the user already typed.
     */
    static prefillOpeningAmount() {
        const input = document.getElementById('cashSignInAmount');
        const hint = document.getElementById('cashSignInSuggestion');
        const last = lastCountedSession(this.cachedSessions || []);
        if (!input || !last) {
            if (hint) hint.style.display = 'none';
            return;
        }
        const amount = Number(last.closingBalance);
        if (input.value === '') input.value = String(amount);
        if (hint) {
            hint.textContent = t('ui.cash.suggested_from_last_count', { date: last.date, amount });
            hint.style.display = 'block';
        }
    }

    /**
     * Record the real count for a day the app closed without one (#101).
     * Transaction: only a still-uncounted session is updated.
     * @param {string} sessionId
     */
    static async recordLateCount(sessionId) {
        const amount = parseCashAmount(document.getElementById('lateCountAmount')?.value);
        if (amount === null) {
            UIManager.showToast(t('msg.cash.enter_cash_amount_counted'));
            return;
        }
        try {
            const ref = sessionRef(sessionId);
            const updated = await FirebaseService.db.runTransaction(async (tx) => {
                const snap = await tx.get(ref);
                if (!snap.exists) return null;
                const fresh = { id: snap.id, ...snap.data() };
                if (!isNotCounted(fresh)) return null;
                const expected = Number(fresh.expectedBalance) || 0;
                const fields = {
                    closingBalance: amount,
                    difference: round2(amount - expected),
                    counted: true,
                    countedLate: true,
                    countedAt: new Date().toISOString(),
                    countedBy: AppState.currentUser?.uid || 'unknown',
                    countedByName: AppState.userName || 'Unknown'
                };
                tx.update(ref, fields);
                return { ...fresh, ...fields };
            });
            if (!updated) {
                UIManager.showToast(t('msg.cash.day_already_has_count'));
                return;
            }
            const idx = (this.cachedSessions || []).findIndex(s => s.id === sessionId);
            if (idx !== -1) this.cachedSessions[idx] = updated;
            UIManager.closeModal(true);
            this.renderHistoryFromCache();
            UIManager.showToast(t('msg.cash.count_saved', { amount }));
        } catch (error) {
            console.error('Late count error:', error);
            UIManager.showToast(t('msg.cash.failed_save_count', { message: error.message }));
        }
    }

    static validateSignOut() {
        const actualAmount = parseCashAmount(document.getElementById('cashSignOutAmount')?.value);
        const expected = this.calculateExpectedCash();
        const difference = (actualAmount ?? 0) - expected;
        
        const alertDiv = document.getElementById('cashDifferenceAlert');
        if (alertDiv && actualAmount !== null) {
            if (Math.abs(difference) < 1) {
                alertDiv.style.display = 'block';
                alertDiv.style.background = '#d1f4e0';
                alertDiv.style.color = '#0f5132';
                alertDiv.textContent = t('ui.cash.cash_matches');
            } else if (difference > 0) {
                alertDiv.style.display = 'block';
                alertDiv.style.background = '#fff3cd';
                alertDiv.style.color = '#997404';
                alertDiv.textContent = t('ui.cash.extra_verify', { amount: Math.abs(difference).toFixed(2) });
            } else {
                alertDiv.style.display = 'block';
                alertDiv.style.background = '#f8d7da';
                alertDiv.style.color = '#842029';
                alertDiv.textContent = t('ui.cash.short_verify', { amount: Math.abs(difference).toFixed(2) });
            }
            // Q19 bands (#37): name a big difference or an impossible (negative) expected drawer
            const band = evaluateCashCount({ expected, counted: actualAmount }, AppState.settings?.checkThresholds)
                .filter(i => i.id !== 'cash-mismatch');
            alertDiv.style.whiteSpace = 'pre-line';
            if (band.length) alertDiv.textContent += band.map(i => `\n⚠ ${i.en} / ${i.hi}`).join('');
            // Owner/manager: today's anomaly summary before closing the day (#187)
            const anomalyLine = window.app?.anomalies?.cashCloseLine?.();
            if (anomalyLine) alertDiv.textContent += `\n🚨 ${anomalyLine}`;
        } else if (alertDiv) {
            alertDiv.style.display = 'none';
        }
    }

    static async signIn() {
        // 0 is a valid opening (empty drawer); only empty/negative input is rejected (#66)
        const amount = parseCashAmount(document.getElementById('cashSignInAmount')?.value);
        const openingNotes = Helpers.getInputText('cashSignInNotes');

        if (amount === null) {
            UIManager.showToast(t('msg.cash.enter_valid_opening_amount'));
            return;
        }

        try {
            // Compare with the last real count (days closed without a count are skipped, #101)
            const sessions = await FirebaseService.loadCashSessions();
            const lastCounted = lastCountedSession(sessions);
            
            if (lastCounted) {
                const lastClosing = Number(lastCounted.closingBalance);
                const diff = Math.abs(lastClosing - amount);
                if (diff > 1) {
                    const confirmed = await UIManager.showModal(
                        t('msg.cash.last_counted_closing_was_but', { date: lastCounted.date, lastClosing, amount, diff: diff.toFixed(2) }),
                        t('msg.cash.cash_mismatch_warning'),
                        true
                    );
                    if (!confirmed) return;
                }
            }

            const session = {
                id: Helpers.generateId(),
                date: todayLocalISO(),
                openingBalance: amount,
                signInTime: new Date().toISOString(),
                userId: AppState.currentUser?.uid || 'unknown',
                userName: AppState.userName || 'Unknown',
                signedOut: false,
                duePayments: []
            };
            if (openingNotes) session.openingNotes = openingNotes;

            await FirebaseService.saveCashSession(session);
            this.todaySession = session;
            await this.calculateTodayTransactions();
            this.updateUI();
            this.renderHistory();
            
            UIManager.showToast(t('msg.cash.cash_signed_in_successfully'));
            
            // Clear inputs
            document.getElementById('cashSignInAmount').value = '';
            const openingNotesInput = document.getElementById('cashSignInNotes');
            if (openingNotesInput) openingNotesInput.value = '';
        } catch (error) {
            console.error('Sign in error:', error);
            UIManager.showToast(t('msg.cash.failed_sign_in', { message: error.message }));
        }
    }

    static async signOut() {
        const actualAmount = parseCashAmount(document.getElementById('cashSignOutAmount')?.value);
        const closingNotes = Helpers.getInputText('cashSignOutNotes');

        if (actualAmount === null) {
            UIManager.showToast(t('msg.cash.enter_actual_cash_amount'));
            return;
        }

        const expected = this.calculateExpectedCash();
        const difference = round2(actualAmount - expected);

        // Confirm if there's a difference
        if (Math.abs(difference) > 1) {
            const message = difference > 0 
                ? t('msg.cash.signout_extra', { diff: Math.abs(difference).toFixed(2), expected, actual: actualAmount })
                : t('msg.cash.signout_short', { diff: Math.abs(difference).toFixed(2), expected, actual: actualAmount });
            
            const confirmed = await UIManager.showModal(message, t('msg.cash.confirm_sign_out'), true);
            if (!confirmed) return;
        }

        const closingFields = {
            closingBalance: actualAmount,
            expectedBalance: expected,
            difference: difference,
            signOutTime: new Date().toISOString(),
            signedOut: true,
            counted: true,
            transactions: {
                cashSales: this.todayTransactions.cashSales,
                cashPurchases: this.todayTransactions.cashPurchases,
                businessExpenses: this.todayTransactions.businessExpenses,
                personalExpenses: this.todayTransactions.personalExpenses,
                dueReceived: this.todayTransactions.dueReceived,
                duePaid: this.todayTransactions.duePaid,
                cashDeposits: this.todayTransactions.cashDeposits
            }
        };
        if (closingNotes) closingFields.closingNotes = closingNotes;
        const cashFlags = toFlags(evaluateCashCount({ expected, counted: actualAmount }, AppState.settings?.checkThresholds),
            AppState.currentUser?.uid || 'unknown', Date.now());
        if (cashFlags.length) closingFields.flags = cashFlags;
        const updatedSession = { ...this.todaySession, ...closingFields };
        const run = startCashCloseRun(this.todaySession, expected, actualAmount, difference);

        try {
            // Field-level update: never overwrite deposits/due payments added on another device
            await sessionRef(this.todaySession.id).update(closingFields);
            run.complete();
            this.todaySession = updatedSession;
            this.updateUI();
            this.renderHistory();
            
            UIManager.showToast(t('msg.cash.cash_signed_out_successfully'));
            
            // Clear inputs
            document.getElementById('cashSignOutAmount').value = '';
            const closingNotesInput = document.getElementById('cashSignOutNotes');
            if (closingNotesInput) closingNotesInput.value = '';
        } catch (error) {
            console.error('Sign out error:', error);
            run.completeAndFail('write_failed', { code: String(error?.code || 'unknown').slice(0, 40) });
            UIManager.showToast(t('msg.cash.failed_sign_out', { message: error.message }));
        }
    }

    static async recordTransaction() {
        const type = Helpers.getInputText('cashTransactionType');
        const amount = parseCashAmount(document.getElementById('transactionAmount')?.value);
        const notes = Helpers.getInputText('transactionNotes');

        if (!amount || amount <= 0) {
            UIManager.showToast(t('msg.common.enter_valid_amount'));
            return;
        }

        if (!this.todaySession || this.todaySession.signedOut) {
            UIManager.showToast(t('msg.cash.sign_in_first'));
            return;
        }

        if (type === 'deposit') {
            // Cash deposit
            const deposit = {
                id: Helpers.generateId(),
                amount: amount,
                reason: notes,
                timestamp: new Date().toISOString(),
                addedBy: AppState.userName || 'Unknown'
            };

            const updatedSession = {
                ...this.todaySession,
                cashDeposits: [...(this.todaySession.cashDeposits || []), deposit]
            };

            try {
                await sessionRef(this.todaySession.id).update({
                    cashDeposits: firebase.firestore.FieldValue.arrayUnion(deposit)
                });
                this.todaySession = updatedSession;
                await this.calculateTodayTransactions();
                this.updateUI();
                this.renderHistory();
                
                UIManager.showToast(t('msg.cash.added_cash_drawer', { amount }));
                
                // Clear inputs
                document.getElementById('transactionAmount').value = '';
                document.getElementById('transactionNotes').value = '';
            } catch (error) {
                console.error('Add deposit error:', error);
                UIManager.showToast(t('msg.cash.failed_add_deposit', { message: error.message }));
            }
        } else {
            // Due payment (received or paid)
            const typedParty = (document.getElementById('partyName')?.value || '').trim();
            const partyName = typedParty || 'N/A';

            // The user must choose explicitly: a bill of this party, or "No bill"
            const billChoice = document.getElementById('dueBillSelect')?.value || DUE_BILL_NONE;
            if (billChoice === DUE_BILL_NONE || (billChoice !== DUE_BILL_UNLINKED && !this.parseDueBillChoice(billChoice))) {
                UIManager.showToast(t('msg.cash.choose_bill_or_no_bill'));
                return;
            }

            // Linked to a bill: the one shared path (bill due + drawer leg, one transaction)
            const choice = this.parseDueBillChoice(billChoice);
            if (choice) {
                const { billType, billId } = choice;
                const bill = OutstandingManager.findBill(billType, billId);
                const expectedType = type === 'paid' ? 'purchase' : null;
                if (!bill || (expectedType ? billType !== expectedType : billType === 'purchase')) {
                    UIManager.showToast(t('msg.cash.bill_not_found_choose_again'));
                    this.populateDueBills();
                    return;
                }
                if (!sameParty(billParty(bill), typedParty)) {
                    UIManager.showToast(t('msg.cash.bill_not', { billParty: billParty(bill) || 'N/A', partyName }));
                    this.populateDueBills();
                    return;
                }
                const ok = await OutstandingManager.recordDuePayment({ billType, billId, cash: amount, online: 0, note: notes });
                if (ok) {
                    this.renderHistory();
                    document.getElementById('partyName').value = '';
                    document.getElementById('transactionAmount').value = '';
                    document.getElementById('transactionNotes').value = '';
                    this.populateDueBills();
                }
                return;
            }

            const payment = {
                id: Helpers.generateId(),
                type: type, // 'received' or 'paid'
                customer: partyName,
                amount: amount,
                method: 'cash', // All cash transactions
                cash: amount,
                online: 0,
                unlinked: true, // not tied to a bill in the app
                notes: notes,
                timestamp: new Date().toISOString(),
                recordedBy: AppState.userName || 'Unknown'
            };

            const session = this.todaySession;
            try {
                // arrayUnion is queued offline: show it now, don't wait for the server
                const write = sessionRef(session.id).update({
                    duePayments: firebase.firestore.FieldValue.arrayUnion(payment)
                });
                session.duePayments = [...(session.duePayments || []), payment];
                write.catch(error => {
                    console.error('Record payment error:', error);
                    session.duePayments = (session.duePayments || []).filter(p => p.id !== payment.id);
                    this.calculateTodayTransactions()
                        .then(() => this.updateUI())
                        .catch(e => console.error('Cash refresh failed:', e));
                    UIManager.showToast(t('msg.cash.failed_record_payment', { message: error.message }));
                });
                await this.calculateTodayTransactions();
                this.updateUI();
                this.renderHistory();
                
                UIManager.showToast(t(type === 'paid' ? 'msg.cash.recorded_paid_to' : 'msg.cash.recorded_received_from', { amount, partyName }));
                
                // Clear inputs
                document.getElementById('partyName').value = '';
                document.getElementById('transactionAmount').value = '';
                document.getElementById('transactionNotes').value = '';
                this.populateDueBills();
            } catch (error) {
                console.error('Record payment error:', error);
                UIManager.showToast(t('msg.cash.failed_record_payment', { message: error.message }));
            }
        }
    }

    static loadCustomerOptions() {
        const datalist = document.getElementById('customerOptionsForDue');
        if (!datalist) return;

        const customers = new Set();
        
        // Get customers from purchase history
        AppState.purchaseHistory?.forEach(purchase => {
            if (purchase.customerName) customers.add(purchase.customerName);
        });
        
        // Get customers from sales history (wholesale and retail)
        [...(AppState.salesHistory || []), ...(AppState.retailSalesHistory || [])].forEach(sale => {
            if (sale.customerName) customers.add(sale.customerName);
        });

        datalist.innerHTML = Array.from(customers)
            .sort()
            .map(name => `<option value="${Helpers.escapeHtml(name)}">`)
            .join('');
    }

    /**
     * Render history from cached sessions (faster, no Firebase call)
     */
    static renderHistoryFromCache() {
        const container = document.getElementById('cashHistoryList');
        if (!container) return;
        this.renderSessionList(container, this.cachedSessions || []);
    }

    /** Language switched (#143): redraw labels from cached data, no Firestore read. */
    static refreshForLanguage() {
        if (document.getElementById('cashTransactionType')) this.updateTransactionForm();
        this.updateUI();
        const container = document.getElementById('cashHistoryList');
        if (container && this.cachedSessions) this.renderSessionList(container, [...this.cachedSessions]);
    }

    static async renderHistory() {
        const container = document.getElementById('cashHistoryList');
        if (!container) return;

        try {
            const sessions = await FirebaseService.loadCashSessions();
            this.cachedSessions = sessions; // Update cache
            this.renderSessionList(container, sessions);
        } catch (error) {
            console.error('Error rendering history:', error);
            container.innerHTML = `<p style="text-align: center; color: #ef4444; padding: 20px;">${L('ui.cash.failed_load_history')}</p>`;
        }
    }

    /**
     * Session history list. Sessions the app closed without a count show
     * "Not counted" (no shortage) and are listed first for review (#101).
     * @param {HTMLElement} container
     * @param {Object[]} sessions
     */
    static renderSessionList(container, sessions) {
        // Roles & access (#84): without "Past cash days" only today and days still waiting for a count
        if (!can(AppState.userRole, 'oldCashSessions', AppState.settings?.roleAccess)) {
            const today = todayLocalISO();
            sessions = sessions.filter(s => s.date === today || isNotCounted(s));
        }
        sessions.sort((a, b) => String(b.date).localeCompare(String(a.date)));

        if (sessions.length === 0) {
            container.innerHTML = `<p style="text-align: center; color: #6c757d; padding: 20px;">${L('ui.cash.no_history')}</p>`;
            return;
        }

        const notCounted = sessions.filter(isNotCounted);
        const dayLabel = (session) => (parseLocalDate(session.date) || new Date(session.date)).toLocaleDateString('en-IN', {
            weekday: 'short',
            day: 'numeric',
            month: 'short'
        });
        const review = notCounted.length > 0 ? `
            <div style="background: #fff7ed; border: 1px solid #fdba74; border-radius: 8px; padding: 10px; margin-bottom: 10px; font-size: 13px; color: #9a3412;">
                <strong>${L('ui.cash.days_not_counted', { count: notCounted.length })}</strong>
                <div style="margin-top: 4px;">${L('ui.cash.tap_day_to_count')} ${notCounted.map(s => `<a href="#" onclick="window.app.cashManagement.showDetails('${Helpers.escapeJsAttr(s.date)}'); return false;" style="color: #9a3412; font-weight: 600;">${Helpers.escapeHtml(dayLabel(s))}</a>`).join(', ')}</div>
            </div>` : '';

        container.innerHTML = review + sessions.map(session => {
            const date = dayLabel(session);
            const uncounted = isNotCounted(session);

            const status = !session.signedOut
                ? `<span style="color: #22c55e; font-weight: 600;">● ${L('ui.cash.active')}</span>`
                : (uncounted ? `<span style="color: #c2410c; font-weight: 600;">⚠ ${L('ui.cash.not_counted')}</span>` : `<span style="color: #6c757d;">✓ ${L('ui.cash.closed')}</span>`);

            const diff = Number(session.difference) || 0;
            const absDiff = Math.abs(diff);
            let diffColor;
            if (absDiff < 50) {
                diffColor = '#22c55e'; // Green for small differences
            } else if (absDiff < 500) {
                diffColor = '#f59e0b'; // Yellow for medium differences
            } else {
                diffColor = '#ef4444'; // Red for large differences
            }
            const diffText = absDiff < 1 ? L('ui.cash.matched') : (diff > 0 ? `+₹${diff.toFixed(2)}` : `-₹${Math.abs(diff).toFixed(2)}`);
            const cashAdded = session.transactions?.cashDeposits || 0;
            const closedRows = uncounted ? `
                            <div>${L('ui.cash.closing')} <strong style="color: #c2410c;">${L('ui.cash.not_counted')}</strong></div>
                            <div>${L('ui.cash.expected')} <strong>₹${Helpers.escapeHtml(session.expectedBalance || 0)}</strong></div>
                            ` : `
                            <div>${L('ui.cash.closing')} <strong>₹${Helpers.escapeHtml(session.closingBalance)}</strong></div>
                            ${cashAdded > 0 ? `<div>${L('ui.cash.added')} <strong style="color: #10b981;">+₹${Helpers.escapeHtml(cashAdded)}</strong></div>` : ''}
                            <div>${L('ui.cash.expected')} <strong>₹${Helpers.escapeHtml(session.expectedBalance || 0)}</strong></div>
                            <div>${L('ui.cash.diff')} <strong style="color: ${diffColor};">${diffText}</strong></div>
                            `;

            return `
                <div onclick="window.app.cashManagement.showDetails('${Helpers.escapeJsAttr(session.date)}')" style="border-bottom: 1px solid #e5e7eb; padding: 12px 0; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#f8f9fa'" onmouseout="this.style.background='white'">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <strong style="font-size: 15px;">${date}</strong>
                        ${status}
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 14px; color: #6c757d;">
                        <div>${L('ui.cash.opening')} <strong>₹${Helpers.escapeHtml(session.openingBalance)}</strong></div>
                        ${session.signedOut ? closedRows : `<div>${L('ui.cash.in_progress')}</div>`}
                    </div>
                    ${session.duePayments && session.duePayments.length > 0 ? `
                        <div style="margin-top: 8px; font-size: 13px; color: #6c757d;">
                            ${L('ui.cash.due_payments_recorded', { count: session.duePayments.length })}
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');
    }

    static async showSessionDetails(sessionDate) {
        try {
            const sessions = await FirebaseService.loadCashSessions();
            const session = sessions.find(s => s.date === sessionDate);
            
            if (!session) {
                UIManager.showToast(t('msg.cash.session_not_found'));
                return;
            }
            if (session.date !== todayLocalISO() && !isNotCounted(session)
                && !can(AppState.userRole, 'oldCashSessions', AppState.settings?.roleAccess)) {
                UIManager.showToast(t('msg.roles.section_not_allowed'));
                return;
            }

        const date = (parseLocalDate(session.date) || new Date(session.date)).toLocaleDateString('en-IN', { 
            weekday: 'long', 
            day: 'numeric', 
            month: 'long',
            year: 'numeric'
        });

        const diff = session.difference || 0;
        const absDiff = Math.abs(diff);
        let diffColor = '#22c55e'; // green
        if (absDiff >= 500) diffColor = '#ef4444'; // red
        else if (absDiff >= 50) diffColor = '#f59e0b'; // yellow
        const uncounted = isNotCounted(session);
        const diffText = uncounted ? L('ui.cash.not_counted') : (absDiff < 1 ? L('ui.cash.matched') : (diff >= 0 ? `+₹${diff.toFixed(2)}` : `₹${diff.toFixed(2)}`));

        // An open session has no saved snapshot yet: use today's live totals.
        const isLiveToday = !session.signedOut && this.todaySession && this.todaySession.date === session.date;
        const txns = (isLiveToday ? this.todayTransactions : session.transactions) || {};
        const totals = sessionTotals(session, txns);
        const totalCashIn = totals.opening + totals.cashIn;
        const totalCashOut = totals.cashOut;
        const difference = session.signedOut && !uncounted ? (session.closingBalance - session.expectedBalance) : 0;
        const absDifference = Math.abs(difference);
        
        // Color coding based on difference amount
        let cardDiffColor = '#22c55e'; // green for < 50
        if (absDifference >= 500) cardDiffColor = '#ef4444'; // red for >= 500
        else if (absDifference >= 50) cardDiffColor = '#f59e0b'; // orange/yellow for >= 50
        
        const diffBgColor = session.signedOut ? `rgba(${parseInt(cardDiffColor.slice(1, 3), 16)}, ${parseInt(cardDiffColor.slice(3, 5), 16)}, ${parseInt(cardDiffColor.slice(5, 7), 16)}, 0.1)` : 'rgba(148, 163, 184, 0.1)';
        const diffTextColor = session.signedOut && !uncounted ? cardDiffColor : '#64748b';
        
        let modalContent = `
            <div style="padding: 0;">
                ${uncounted ? `
                <div style="background: #fff7ed; border: 1px solid #fdba74; padding: 10px; border-radius: 8px; margin-bottom: 10px; font-size: 13px; color: #9a3412;">
                    <strong>${L('ui.cash.closed_without_count')}</strong>
                    <div style="margin: 6px 0;">${L('ui.cash.record_if_known')}</div>
                    <div style="display: flex; gap: 6px;">
                        <input type="number" inputmode="decimal" min="0" id="lateCountAmount" placeholder="${L('ui.cash.cash_counted')}" style="flex: 1; padding: 8px; border: 1px solid #fdba74; border-radius: 6px;" />
                        <button type="button" onclick="window.app.cashManagement.recordLateCount('${Helpers.escapeJsAttr(session.id)}')" style="background: #ea580c; color: white; border: none; padding: 8px 12px; border-radius: 6px; font-weight: 600;">${L('ui.cash.save_count')}</button>
                    </div>
                </div>` : ''}
                <!-- Summary Card -->
                ${session.signedOut ? `
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-bottom: 10px;">
                    <!-- Expenses & Others -->
                    <div style="background: rgba(139, 92, 246, 0.1); padding: 10px; border-radius: 8px;">
                        <div style="font-size: 12px; color: #7c3aed; margin-bottom: 4px; font-weight: 600;">${L('ui.cash.expenses_others')}</div>
                        <div style="font-size: 20px; font-weight: 700; color: #6d28d9;">₹${Helpers.escapeHtml(totalCashOut)}</div>
                    </div>
                    
                    <!-- Expected Balance -->
                    <div style="background: rgba(139, 92, 246, 0.1); padding: 10px; border-radius: 8px;">
                        <div style="font-size: 12px; color: #7c3aed; margin-bottom: 4px; font-weight: 600;">${L('ui.cash.expected_balance')}</div>
                        <div style="font-size: 20px; font-weight: 700; color: #6d28d9;">₹${Helpers.escapeHtml(session.expectedBalance || 0)}</div>
                    </div>
                    
                    <!-- Actual Balance -->
                    <div style="background: rgba(139, 92, 246, 0.1); padding: 10px; border-radius: 8px;">
                        <div style="font-size: 12px; color: #7c3aed; margin-bottom: 4px; font-weight: 600;">${L('ui.cash.actual_balance')}</div>
                        <div style="font-size: 20px; font-weight: 700; color: #6d28d9;">${uncounted ? L('ui.cash.not_counted') : `₹${Helpers.escapeHtml(session.closingBalance)}`}</div>
                    </div>
                    
                    <!-- Difference -->
                    <div style="background: ${diffBgColor}; padding: 10px; border-radius: 8px;">
                        <div style="font-size: 12px; color: ${diffTextColor}; margin-bottom: 4px; font-weight: 600;">${L('ui.cash.difference')}</div>
                        <div style="font-size: 20px; font-weight: 700; color: ${diffTextColor};">${diffText}</div>
                    </div>
                </div>
                ` : `
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-bottom: 10px;">
                    <!-- Opening Balance -->
                    <div style="background: rgba(139, 92, 246, 0.1); padding: 10px; border-radius: 8px;">
                        <div style="font-size: 12px; color: #7c3aed; margin-bottom: 4px; font-weight: 600;">${L('ui.cash.opening_balance')}</div>
                        <div style="font-size: 20px; font-weight: 700; color: #6d28d9;">₹${Helpers.escapeHtml(session.openingBalance || 0)}</div>
                    </div>
                    
                    <!-- Cash In -->
                    <div style="background: rgba(139, 92, 246, 0.1); padding: 10px; border-radius: 8px;">
                        <div style="font-size: 12px; color: #7c3aed; margin-bottom: 4px; font-weight: 600;">${L('ui.cash.cash_in')}</div>
                        <div style="font-size: 20px; font-weight: 700; color: #6d28d9;">₹${Helpers.escapeHtml(totalCashIn - (session.openingBalance || 0))}</div>
                    </div>
                    
                    <!-- Cash Out -->
                    <div style="background: rgba(139, 92, 246, 0.1); padding: 10px; border-radius: 8px;">
                        <div style="font-size: 12px; color: #7c3aed; margin-bottom: 4px; font-weight: 600;">${L('ui.cash.cash_out')}</div>
                        <div style="font-size: 20px; font-weight: 700; color: #6d28d9;">₹${Helpers.escapeHtml(totalCashOut)}</div>
                    </div>
                    
                    <!-- Expected Cash -->
                    <div style="background: rgba(139, 92, 246, 0.1); padding: 10px; border-radius: 8px;">
                        <div style="font-size: 12px; color: #7c3aed; margin-bottom: 4px; font-weight: 600;">${L('ui.cash.expected_cash_title')}</div>
                        <div style="font-size: 20px; font-weight: 700; color: #6d28d9;">₹${Helpers.escapeHtml(isLiveToday ? totals.expected : (session.expectedBalance || 0))}</div>
                    </div>
                </div>
                `}
                
                <!-- Cash In Group -->
                <div style="background: #d1fae5; padding: 10px; border-radius: 8px; margin-bottom: 8px;">
                    <h3 style="margin: 0 0 6px 0; font-size: 13px; color: #166534;">${L('ui.cash.cash_in')}</h3>
                    <div style="display: grid; gap: 6px; font-size: 13px;">
                        <div style="display: flex; justify-content: space-between;">
                            <span>${L('ui.cash.opening_balance_2')}</span>
                            <strong style="color: #6366f1;">₹${Helpers.escapeHtml(session.openingBalance)}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>${L('ui.cash.cash_added_2')}</span>
                            <strong style="color: #10b981;">₹${Helpers.escapeHtml(txns.cashDeposits || 0)}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>${L('ui.cash.cash_sales')}</span>
                            <strong style="color: #22c55e;">₹${Helpers.escapeHtml(txns.cashSales || 0)}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>${L('ui.common.due_received')}</span>
                            <strong style="color: #3b82f6;">₹${Helpers.escapeHtml(txns.dueReceived || 0)}</strong>
                        </div>
                        <div style="border-top: 2px solid #059669; margin-top: 6px; padding-top: 6px; display: flex; justify-content: space-between; font-weight: 600;">
                            <span>${L('ui.cash.total_cash_in')}</span>
                            <strong style="color: #059669;">₹${Helpers.escapeHtml(totalCashIn)}</strong>
                        </div>
                    </div>
                </div>
                
                <!-- Cash Out Group -->
                <div style="background: #fee2e2; padding: 10px; border-radius: 8px; margin-bottom: 8px;">
                    <h3 style="margin: 0 0 6px 0; font-size: 13px; color: #991b1b;">${L('ui.cash.cash_out')}</h3>
                    <div style="display: grid; gap: 6px; font-size: 13px;">
                        <div style="display: flex; justify-content: space-between;">
                            <span>${L('ui.cash.cash_purchases')}</span>
                            <strong style="color: #ef4444;">₹${Helpers.escapeHtml(txns.cashPurchases || 0)}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>${L('ui.common.due_paid')}</span>
                            <strong style="color: #dc2626;">₹${Helpers.escapeHtml(txns.duePaid || 0)}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>${L('ui.cash.business_expenses')}</span>
                            <strong style="color: #f97316;">₹${Helpers.escapeHtml(txns.businessExpenses || 0)}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>${L('ui.cash.personal_expenses')}</span>
                            <strong style="color: #f59e0b;">₹${Helpers.escapeHtml(txns.personalExpenses || 0)}</strong>
                        </div>
                        <div style="border-top: 2px solid #dc2626; margin-top: 6px; padding-top: 6px; display: flex; justify-content: space-between; font-weight: 600;">
                            <span>${L('ui.cash.total_cash_out')}</span>
                            <strong style="color: #dc2626;">₹${Helpers.escapeHtml(totalCashOut)}</strong>
                        </div>
                    </div>
                </div>

                ${session.cashDeposits && session.cashDeposits.length > 0 ? `
                    <div style="background: #f0fdf4; padding: 10px; border-radius: 8px; margin-bottom: 12px; border: 1px solid #86efac;">
                        <h3 style="margin: 0 0 8px 0; font-size: 13px; color: #166534;">💵 ${L('ui.cash.cash_deposits', { count: session.cashDeposits.length })}</h3>
                        <div style="display: grid; gap: 6px;">
                            ${session.cashDeposits.map(d => `
                                <div style="background: white; padding: 8px; border-radius: 6px; border-left: 3px solid #10b981;">
                                    <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                                        <strong style="color: #333; font-size: 12px;">${Helpers.escapeHtml(d.reason || t('ui.cash.cash_added'))}</strong>
                                        <strong style="color: #10b981; font-size: 13px;">₹${Helpers.escapeHtml(d.amount)}</strong>
                                    </div>
                                    <div style="color: #6c757d; font-size: 10px;">
                                        ${L('ui.cash.added_by', { name: d.addedBy })}
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}

                ${session.duePayments && session.duePayments.length > 0 ? `
                    <div style="background: #f8f9fa; padding: 10px; border-radius: 8px; margin-bottom: 12px;">
                        <h3 style="margin: 0 0 8px 0; font-size: 13px; color: #495057;">💰 ${L('ui.cash.due_payments', { count: session.duePayments.length })}</h3>
                        <div style="display: grid; gap: 6px;">
                            ${session.duePayments.map(p => {
                                const isReceived = p.type !== 'paid';
                                const borderColor = isReceived ? '#3b82f6' : '#ef4444';
                                const amountColor = isReceived ? '#3b82f6' : '#ef4444';
                                const typeLabel = L(isReceived ? 'ui.cash.received_from' : 'ui.cash.paid_to');
                                return `
                                    <div style="background: white; padding: 8px; border-radius: 6px; border-left: 3px solid ${borderColor};">
                                        <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                                            <strong style="color: #333; font-size: 12px;">${typeLabel} ${Helpers.escapeHtml(p.customer)}</strong>
                                            <strong style="color: ${amountColor}; font-size: 13px;">${isReceived ? '+' : '-'}₹${Helpers.escapeHtml(p.amount)}</strong>
                                        </div>
                                        <div style="color: #6c757d; font-size: 10px;">
                                            ${Helpers.escapeHtml(p.method)} • ${Helpers.escapeHtml(p.notes || t('ui.cash.no_notes'))}
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                ` : ''}

                ${session.openingNotes || session.closingNotes ? `
                <!-- Notes -->
                <div style="background: #fffbeb; padding: 12px; border-radius: 8px; border-left: 3px solid #f59e0b;">
                    <h4 style="margin: 0 0 8px 0; font-size: 13px; color: #92400e;">📝 ${L('ui.cash.notes_title')}</h4>
                    ${session.openingNotes ? `<div style="font-size: 12px; color: #78350f; margin-bottom: 6px;"><strong>${L('ui.cash.sign_in_label')}</strong> ${Helpers.escapeHtml(session.openingNotes)}</div>` : ''}
                    ${session.closingNotes ? `<div style="font-size: 12px; color: #78350f;"><strong>${L('ui.cash.sign_out_label')}</strong> ${Helpers.escapeHtml(session.closingNotes)}</div>` : ''}
                </div>
                ` : ''}
            </div>
        `;

            UIManager.showModalWithHtml(modalContent, t('msg.cash.cash_session_details'), false);
        } catch (error) {
            console.error('Error loading session details:', error);
            UIManager.showToast(t('msg.cash.failed_load_session_details'));
        }
    }
}
