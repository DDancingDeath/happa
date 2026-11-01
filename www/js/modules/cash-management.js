/**
 * @fileoverview Cash Management Module
 * Handles daily cash sessions, sign-in/out, transactions, and reconciliation
 * Tracks cash flow from sales, purchases, and expenses
 * @module modules/cash-management
 */

import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
import { updateSessionChecked, updateSession, addSessionEntry } from '../firebase/repos/cash-sessions.js';
import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { SyncStatus } from '../ui/sync-status.js';
import { Helpers } from '../utils/helpers.js';
import { todayLocalISO, parseLocalDate, parseAnyBillDate, displayLocale, localISODaysAgo, formatTimeOfDay } from '../utils/dates.js';
import { needsHistoryFrom, ensureHistoryFrom } from '../utils/history-window.js';
import { parseCashAmount, isNotCounted, autoCloseFields, sessionForDate, duplicateSessionDays, CASH_NEEDS_INTERNET, openHours } from '../utils/cash-session.js';
import {
    drawerDay, expectedCash, drawerStatus, signOutSummary, countCheck, closeCheck, openingCheck,
    savedDifference, differenceBand, sessionDetail, noBillLeg, lastCountedSession
} from '../utils/calc/cash.js';
import { round2, outstandingDue, formatRupees, formatAmount } from '../utils/money.js';
import { entryAmount } from '../utils/calc/billing.js';
import { toFlags } from '../utils/bill-checks.js';
import { OutstandingManager } from './outstanding.js';
import { normalizeParty, sameParty, billParty, legAmount as dueLegAmount } from '../utils/due-payments.js';
import { t, tn, getLang } from '../i18n/index.js';
import { pickLang } from '../i18n/localize.js';
import { can } from '../utils/role-access.js';
import { tip } from '../tip/index.js';
import { track } from '../services/usage.js';
import { cashCloseProps } from '../tip/scenarios/cash-close.js';

const L = (key, params) => Helpers.escapeHtml(t(key, params));

/** Colour of a cash difference band (calc/cash differenceBand). */
const DIFF_COLORS = Object.freeze({ ok: '#15803d', warn: '#f59e0b', high: '#ef4444' });
/** The same bands on the purple status card (light tints that read on it). */
const DIFF_ON_CARD = Object.freeze({ ok: '#bbf7d0', warn: '#fde68a', high: '#fecaca' });

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

/** Drawer action ('open' | 'close' | 'count' | 'entry') runs once at a time; its buttons wait (#95). */
const withCashLock = (action, fn) => Helpers.runExclusive(`cash-${action}`, `[data-cash-save="${action}"]`, fn);
/** Close day still waiting for the server after this long: say so (the button stays busy). */
const CLOSE_WAIT_MS = 8000;

/** Sessions read when Cash opens (today and the one before), and per "Load older" (#34). */
const RECENT_SESSIONS = 2;
const OLDER_SESSIONS_PAGE = 30;
const DUPLICATE_CHECK_DAYS = 31;

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
            const sessions = await this.loadRecentSessions();
            
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
        this.loadDuplicateDays().catch(e => console.warn('Cash: duplicate-day check failed:', e));
        
        // One set of listeners: the same fields move between the Cash page and Today › Cash (#96)
        const bindOnce = (id, type, fn) => {
            const el = document.getElementById(id);
            if (!el || el.dataset.cashBound) return;
            el.dataset.cashBound = '1';
            el.addEventListener(type, fn);
        };
        bindOnce('cashSignOutAmount', 'input', () => this.validateSignOut());
        bindOnce('cashTransactionType', 'change', () => this.updateTransactionForm());
        bindOnce('partyName', 'input', () => this.populateDueBills());
        bindOnce('dueBillSelect', 'change', () => this.showDueBillDetails());
        
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
            options.push(`<option value="${Helpers.escapeHtml(`${billType}|${bill.id}`)}">#${Helpers.escapeHtml(bill.billNumber || String(bill.id).slice(0, 8))} · ${Helpers.escapeHtml(Helpers.formatDate(bill.date))} · ${L('ui.cash.bill_due', { amount: formatAmount(due, { exact: true }) })}</option>`);
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
            ? t('ui.cash.bill_hint', { party: billParty(bill) || 'N/A', date: Helpers.formatDate(bill.date), amount: formatAmount(outstandingDue(bill), { exact: true }) })
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
            
            // Without the personal rows a day's personal total comes from its day doc; never close a
            // day on a guess: skip (retry next time) a day whose total couldn't be loaded (#98).
            const personalTotals = await this.loadPersonalDays(unclosedSessions.map(s => s.date));
            unclosedSessions = unclosedSessions.filter(s => personalTotals[s.date] !== null);

            // Update all unclosed sessions in parallel
            const updatePromises = unclosedSessions.map(async (session) => {
                try {
                    // Re-read inside a transaction so we never clobber a session that was
                    // signed out (or otherwise changed) on another device after we loaded it.
                    const updatedSession = await updateSessionChecked(session.id, (fresh) => {
                        if (fresh.signedOut || fresh.date !== session.date) return null;

                        // Calculate transactions for that specific date
                        const transactions = this.calculateTransactionsForDate(fresh.date, fresh);
                        // Nobody counted the drawer: record "not counted", never a fake ₹0 count (#101)
                        return autoCloseFields(fresh, transactions);
                    });
                    if (!updatedSession) return false;

                    // Update in cache too
                    const idx = sessions.findIndex(s => s.id === session.id);
                    if (idx !== -1) sessions[idx] = updatedSession;
                    
                    console.log(`Auto signed-out session for ${session.date} with expected ${updatedSession.expectedBalance}`);
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
        const readable = this.personalReadable();
        return drawerDay({
            date: dateStr,
            bills: { wholesale: AppState.salesHistory || [], retail: AppState.retailSalesHistory || [], purchase: AppState.purchaseHistory || [] },
            expenses: AppState.expensesHistory || [],
            session,
            personalReadable: readable,
            personalDay: readable ? null : FirebaseService.personalExpenseDay?.(dateStr)
        });
    }

    /**
     * Reads the latest sessions (today and the one before, #34) and merges
     * them into the cache; older days already loaded with "Load older" stay.
     * @returns {Promise<Object[]>} the cache
     */
    static async loadRecentSessions() {
        const [page, needed] = await Promise.all([
            FirebaseService.loadCashSessionsPage(RECENT_SESSIONS),
            FirebaseService.loadCashSessionsNeeded(todayLocalISO()).catch(err => {
                console.warn('Cash: targeted session queries failed:', err?.message || err);
                return [];
            })
        ]);
        const fresh = new Map([...needed, ...page.sessions].map(s => [s.id, s]));
        const kept = (this.cachedSessions || []).filter(s => !fresh.has(s.id));
        if (!this.olderCursor) {
            this.olderCursor = page.last;
            this.hasOlderSessions = page.more;
        }
        this.cachedSessions = [...fresh.values(), ...kept];
        return this.cachedSessions;
    }

    /**
     * Owner only: days of the last month with more than one session (#38),
     * read once per app session with one date-range query.
     */
    static async loadDuplicateDays() {
        if (AppState.userRole !== 'owner' || this.duplicateDays) return;
        const today = todayLocalISO();
        const fromIso = localISODaysAgo(DUPLICATE_CHECK_DAYS);
        try {
            this.duplicateDays = duplicateSessionDays(await FirebaseService.loadCashSessionsBetween(fromIso, today));
            if (this.duplicateDays.length > 0) this.renderHistoryFromCache();
        } catch (err) {
            console.warn('Cash: duplicate-day check failed:', err?.message || err);
        }
    }

    /** Next page of older days, added to the cache ("Load older"). */
    static async loadOlderSessions() {
        if (!this.olderCursor) return;
        const button = document.getElementById('cashLoadOlder');
        if (button) button.disabled = true;
        try {
            const page = await FirebaseService.loadCashSessionsPage(OLDER_SESSIONS_PAGE, this.olderCursor);
            const known = new Set((this.cachedSessions || []).map(s => s.id));
            this.cachedSessions = [...(this.cachedSessions || []), ...page.sessions.filter(s => !known.has(s.id))];
            this.olderCursor = page.last;
            this.hasOlderSessions = page.more;
            this.renderHistoryFromCache();
        } catch (error) {
            console.error('Error loading older cash days:', error);
            UIManager.showToast(t('ui.cash.failed_load_history'));
            if (button) button.disabled = false;
        }
    }

    /** Puts a session (new or changed) into the cache. */
    static cacheSession(session) {
        if (!session?.id) return;
        const list = this.cachedSessions || [];
        const idx = list.findIndex(s => s.id === session.id);
        if (idx === -1) list.unshift(session);
        else list[idx] = session;
        this.cachedSessions = list;
    }

    /**
     * Load today's cash session from cached sessions
     * @param {Array} sessions - Cached sessions array
     */
    static loadTodaySessionFromCache(sessions) {
        const today = todayLocalISO(); // YYYY-MM-DD (local day)
        this.todaySession = sessionForDate(sessions, today);
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
            const sessions = await FirebaseService.loadCashSessionsForDate(today);
            
            this.todaySession = sessionForDate(sessions, today);
            if (this.todaySession) this.cacheSession(this.todaySession);
            
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
        const today = todayLocalISO();
        this.todayTransactions = this.calculateTransactionsForDate(today, this.todaySession);
        if (this.personalReadable()) return;
        // Without the personal rows: again once today's personal total is in (#98)
        await this.loadPersonalDays([today]);
        this.todayTransactions = this.calculateTransactionsForDate(today, this.todaySession);
    }

    /** Whether this phone has the personal expense rows (their listener delivered them), else day totals (#98). */
    static personalReadable() {
        return !!FirebaseService.personalRowsLoaded?.();
    }

    /**
     * Loads the personal expense day totals of these days when the rows aren't loaded (#98).
     * @returns {Promise<Object<string, ?Object>>} per day: totals, or null when they couldn't be loaded
     */
    static async loadPersonalDays(days) {
        const out = {};
        if (this.personalReadable()) {
            days.forEach(d => { out[d] = undefined; });
            return out;
        }
        await Promise.all(days.map(async d => {
            out[d] = (await FirebaseService.loadPersonalExpenseDay?.(d)) ?? null;
        }));
        return out;
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
                this.renderLongOpen();
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

    /** C10 (Q25 of #111): the drawer open for 14 hours or more is called out above Close cash. */
    static renderLongOpen(now = Date.now()) {
        const box = document.getElementById('cashLongOpen');
        if (!box) return;
        const open = openHours(this.todaySession, now);
        box.hidden = !open?.long;
        box.textContent = open?.long ? t('ui.cash.long_open', { hours: open.hours, time: formatTimeOfDay(open.since, { lang: getLang() }) }) : '';
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

        const {
            opening, cashAdded, purchases, sales, others, expected,
            totalCashIn, totalCashOut, availableCash, actual, diff, diffLevel
        } = drawerStatus(this.todaySession, this.todayTransactions);

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
            
            const diffColor = DIFF_ON_CARD[diffLevel];

            if (statusOpeningBalance) statusOpeningBalance.textContent = formatRupees(opening, { exact: true });
            if (statusCashAdded) statusCashAdded.textContent = formatRupees(cashAdded, { exact: true });
            if (statusBuy) statusBuy.textContent = formatRupees(purchases, { exact: true });
            if (statusSale) statusSale.textContent = formatRupees(sales, { exact: true });
            if (statusOthers) statusOthers.textContent = formatRupees(others, { exact: true });
            if (statusExpected) statusExpected.textContent = formatRupees(expected, { exact: true });
            if (statusActual) statusActual.textContent = formatRupees(actual, { exact: true });
            if (statusDiff) {
                statusDiff.textContent = `${diff >= 0 ? '+' : ''}${formatRupees(diff, { decimals: 2 })}`;
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
            
            if (statusOpeningBalance) statusOpeningBalance.textContent = formatRupees(opening, { exact: true });
            if (statusCashIn) statusCashIn.textContent = formatRupees(totalCashIn, { exact: true });
            if (statusCashOut) statusCashOut.textContent = formatRupees(totalCashOut, { exact: true });
            if (statusAvailable) statusAvailable.textContent = formatRupees(availableCash, { exact: true });
        }
    }

    static calculateExpectedCash() {
        return expectedCash(this.todaySession, this.todayTransactions);
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
        
        const {
            opening, sales, purchases, businessExpenses, personalExpenses, dueReceived, duePaid, deposits,
            totalCashIn, totalCashOut, expected
        } = signOutSummary(this.todaySession, this.todayTransactions);
        
        if (openingBalanceEl) openingBalanceEl.textContent = formatRupees(opening, { exact: true });
        if (cashSalesEl) cashSalesEl.textContent = formatRupees(sales, { exact: true });
        if (cashPurchasesEl) cashPurchasesEl.textContent = formatRupees(purchases, { exact: true });
        if (businessExpensesEl) businessExpensesEl.textContent = formatRupees(businessExpenses, { exact: true });
        if (personalExpensesEl) personalExpensesEl.textContent = formatRupees(personalExpenses, { exact: true });
        if (dueReceivedEl) dueReceivedEl.textContent = formatRupees(dueReceived, { exact: true });
        if (duePaidEl) duePaidEl.textContent = formatRupees(duePaid, { exact: true });
        if (cashDepositsEl) cashDepositsEl.textContent = formatRupees(deposits, { exact: true });
        if (totalCashInEl) totalCashInEl.textContent = formatRupees(totalCashIn, { exact: true });
        if (totalCashOutEl) totalCashOutEl.textContent = formatRupees(totalCashOut, { exact: true });
        
        if (expectedCashEl) expectedCashEl.textContent = formatRupees(expected, { exact: true });
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
            hint.textContent = t('ui.cash.suggested_from_last_count', { date: last.date, amount: formatAmount(amount, { exact: true }) });
            hint.style.display = 'block';
        }
    }

    /**
     * Record the real count for a day the app closed without one (#101).
     * Transaction: only a still-uncounted session is updated.
     * @param {string} sessionId
     */
    static recordLateCount(sessionId) {
        return withCashLock('count', () => this._recordLateCount(sessionId));
    }

    static async _recordLateCount(sessionId) {
        const amount = parseCashAmount(document.getElementById('lateCountAmount')?.value);
        if (amount === null) {
            UIManager.showToast(t('msg.cash.enter_cash_amount_counted'));
            return;
        }
        try {
            const updated = await updateSessionChecked(sessionId, (fresh) => {
                if (!isNotCounted(fresh)) return null;
                return {
                    closingBalance: amount,
                    difference: savedDifference(amount, Number(fresh.expectedBalance) || 0),
                    counted: true,
                    countedLate: true,
                    countedAt: new Date().toISOString(),
                    countedBy: AppState.currentUser?.uid || 'unknown',
                    countedByName: AppState.userName || 'Unknown'
                };
            });
            if (!updated) {
                UIManager.showToast(t('msg.cash.day_already_has_count'));
                return;
            }
            AuditService.note(AuditService.ACTIONS.CASH_CLOSE, {
                date: updated.date || null, counted: amount, expected: updated.expectedBalance ?? null, difference: updated.difference ?? null, late: true
            });
            const idx = (this.cachedSessions || []).findIndex(s => s.id === sessionId);
            if (idx !== -1) this.cachedSessions[idx] = updated;
            UIManager.closeModal(true);
            this.renderHistoryFromCache();
            UIManager.showToast(t('msg.cash.count_saved', { amount: formatAmount(amount, { exact: true }) }));
        } catch (error) {
            console.error('Late count error:', error);
            UIManager.showToast(t('msg.cash.failed_save_count', { message: error.message }));
        }
    }

    static validateSignOut() {
        const actualAmount = parseCashAmount(document.getElementById('cashSignOutAmount')?.value);
        const check = countCheck(actualAmount, this.calculateExpectedCash(), AppState.settings?.checkThresholds);
        
        const alertDiv = document.getElementById('cashDifferenceAlert');
        if (alertDiv && actualAmount !== null) {
            if (check.kind === 'match') {
                alertDiv.style.display = 'block';
                alertDiv.style.background = '#d1f4e0';
                alertDiv.style.color = '#0f5132';
                alertDiv.textContent = t('ui.cash.cash_matches');
            } else if (check.kind === 'extra') {
                alertDiv.style.display = 'block';
                alertDiv.style.background = '#fff3cd';
                alertDiv.style.color = '#997404';
                alertDiv.textContent = t('ui.cash.extra_verify', { amount: formatAmount(check.amount, { decimals: 2 }) });
            } else {
                alertDiv.style.display = 'block';
                alertDiv.style.background = '#f8d7da';
                alertDiv.style.color = '#842029';
                alertDiv.textContent = t('ui.cash.short_verify', { amount: formatAmount(check.amount, { decimals: 2 }) });
            }
            // Q19 bands (#37): name a big difference or an impossible (negative) expected drawer
            const band = check.bands;
            alertDiv.style.whiteSpace = 'pre-line';
            if (band.length) alertDiv.textContent += band.map(i => `\n⚠ ${pickLang(i)}`).join('');
            // Owner/manager: today's anomaly summary before closing the day (#187)
            const anomalyLine = window.app?.anomalies?.cashCloseLine?.();
            if (anomalyLine) alertDiv.textContent += `\n🚨 ${anomalyLine}`;
        } else if (alertDiv) {
            alertDiv.style.display = 'none';
        }
    }

    static async signIn() {
        if (Helpers.isBusy('cash-open')) return;
        // 0 is a valid opening (empty drawer); only empty/negative input is rejected (#66)
        const amount = parseCashAmount(document.getElementById('cashSignInAmount')?.value);
        const openingNotes = Helpers.getInputText('cashSignInNotes');

        if (amount === null) {
            UIManager.showToast(t('msg.cash.enter_valid_opening_amount'));
            return;
        }

        try {
            // Compare with the last real count (days closed without a count are skipped, #101)
            const sessions = this.cachedSessions || await this.loadRecentSessions();
            const lastCounted = lastCountedSession(sessions);
            
            if (lastCounted) {
                const lastClosing = Number(lastCounted.closingBalance);
                const opening = openingCheck(lastClosing, amount);
                if (opening.needsConfirm) {
                    const confirmed = await UIManager.showModal(
                        t('msg.cash.last_counted_closing_was_but', { date: lastCounted.date, lastClosing: formatAmount(lastClosing, { exact: true }), amount: formatAmount(amount, { exact: true }), diff: formatAmount(opening.difference, { decimals: 2 }) }),
                        t('msg.cash.cash_mismatch_warning'),
                        true
                    );
                    if (!confirmed) return;
                }
            }

            const session = {
                date: todayLocalISO(),
                openingBalance: amount,
                signInTime: new Date().toISOString(),
                userId: AppState.currentUser?.uid || 'unknown',
                userName: AppState.userName || 'Unknown',
                signedOut: false,
                duePayments: []
            };
            if (openingNotes) session.openingNotes = openingNotes;

            await withCashLock('open', async () => {
                const { session: opened, joined } = await FirebaseService.openCashSession(session);
                if (!joined) AuditService.note(AuditService.ACTIONS.CASH_OPEN, { date: opened.date, openingBalance: opened.openingBalance });
                this.todaySession = opened;
                await this.calculateTodayTransactions();
                this.updateUI();
                this.renderHistory();

                UIManager.showToast(joined
                    ? t('msg.cash.joined_open_session', { name: opened.userName || '', amount: formatAmount(opened.openingBalance, { exact: true }) })
                    : t('msg.cash.cash_signed_in_successfully'));

                // Clear inputs
                document.getElementById('cashSignInAmount').value = '';
                const openingNotesInput = document.getElementById('cashSignInNotes');
                if (openingNotesInput) openingNotesInput.value = '';
            });
        } catch (error) {
            console.error('Sign in error:', error);
            UIManager.showToast(error?.code === CASH_NEEDS_INTERNET
                ? t('msg.cash.open_needs_internet')
                : t('msg.cash.failed_sign_in', { message: error.message }));
        }
    }

    static async signOut() {
        if (Helpers.isBusy('cash-close')) return;
        const actualAmount = parseCashAmount(document.getElementById('cashSignOutAmount')?.value);
        const closingNotes = Helpers.getInputText('cashSignOutNotes');

        if (actualAmount === null) {
            UIManager.showToast(t('msg.cash.enter_actual_cash_amount'));
            return;
        }
        // Closing is not queued offline: the count must use every phone's entries, and
        // another phone may close the day meanwhile (the rules then refuse this close).
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            UIManager.showToast(t('msg.cash.close_needs_internet'), 'warning');
            return;
        }
        // This phone's own entries not on the server yet are missing from the other phones' counts (#70).
        const unsynced = SyncStatus.pendingCount();
        if (unsynced > 0) {
            const go = await UIManager.showModal(tn('msg.cash.close_unsynced', unsynced), t('msg.cash.confirm_sign_out'), true);
            if (!go) return;
        }

        const expected = this.calculateExpectedCash();
        const check = closeCheck(actualAmount, expected, AppState.settings?.checkThresholds);

        // Confirm if there's a difference
        if (check.needsConfirm) {
            const message = check.extra
                ? t('msg.cash.signout_extra', { diff: formatAmount(check.amount, { decimals: 2 }), expected: formatAmount(expected, { exact: true }), actual: formatAmount(actualAmount, { exact: true }) })
                : t('msg.cash.signout_short', { diff: formatAmount(check.amount, { decimals: 2 }), expected: formatAmount(expected, { exact: true }), actual: formatAmount(actualAmount, { exact: true }) });
            
            const confirmed = await UIManager.showModal(message, t('msg.cash.confirm_sign_out'), true);
            if (!confirmed) return;
        }

        await withCashLock('close', () => this._closeSession(actualAmount, closingNotes, expected, check));
    }

    static async _closeSession(actualAmount, closingNotes, expected, check) {
        const difference = check.difference;
        const closingFields = {
            closingBalance: actualAmount,
            expectedBalance: expected,
            difference: difference,
            signOutTime: new Date().toISOString(),
            signedOut: true,
            counted: true,
            closedBy: AppState.currentUser?.uid || 'unknown',
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
        const cashFlags = toFlags(check.issues, AppState.currentUser?.uid || 'unknown', Date.now());
        if (cashFlags.length) closingFields.flags = cashFlags;
        const updatedSession = { ...this.todaySession, ...closingFields };
        const run = startCashCloseRun(this.todaySession, expected, actualAmount, difference);

        const waiting = setTimeout(() => UIManager.showToast(t('msg.cash.close_waiting'), 'warning'), CLOSE_WAIT_MS);
        try {
            // Field-level update: never overwrite deposits/due payments added on another device
            await updateSession(this.todaySession.id, closingFields);
            clearTimeout(waiting);
            track('cash.close');
            run.complete();
            AuditService.note(AuditService.ACTIONS.CASH_CLOSE, {
                date: this.todaySession.date, counted: actualAmount, expected, difference
            });
            this.todaySession = updatedSession;
            this.updateUI();
            this.renderHistory();
            
            UIManager.showToast(t('msg.cash.cash_signed_out_successfully'));
            
            // Clear inputs
            document.getElementById('cashSignOutAmount').value = '';
            const closingNotesInput = document.getElementById('cashSignOutNotes');
            if (closingNotesInput) closingNotesInput.value = '';
        } catch (error) {
            clearTimeout(waiting);
            console.error('Sign out error:', error);
            run.completeAndFail('write_failed', { code: String(error?.code || 'unknown').slice(0, 40) });
            UIManager.showToast(t('msg.cash.failed_sign_out', { message: error.message }));
        }
    }

    static recordTransaction() {
        return withCashLock('entry', () => this._recordTransaction());
    }

    /**
     * Takes a refused drawer entry out of `session` and of every other
     * in-memory copy of that session (today's, the history cache).
     * @param {Object} session
     * @param {'cashDeposits'|'duePayments'} field
     * @param {string} entryId
     */
    static dropSessionEntry(session, field, entryId) {
        const sid = String(session.id);
        [session, this.todaySession, ...(this.cachedSessions || [])].forEach(s => {
            if (s && String(s.id) === sid && Array.isArray(s[field])) s[field] = s[field].filter(e => e?.id !== entryId);
        });
    }

    static async _recordTransaction() {
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
            // Cash deposit, in whole rupees (MONEY-ROUND, #129)
            const depositAmount = entryAmount(amount);
            if (!(depositAmount > 0)) {
                UIManager.showToast(t('msg.common.enter_valid_amount'));
                return;
            }
            const deposit = {
                id: Helpers.generateId(),
                amount: depositAmount,
                reason: notes,
                timestamp: new Date().toISOString(),
                addedBy: AppState.userName || 'Unknown'
            };

            const session = this.todaySession;
            try {
                // Queued offline like the "No bill" entry below: show it now, don't wait for the server
                const write = addSessionEntry(session.id, 'cashDeposits', deposit);
                session.cashDeposits = [...(session.cashDeposits || []), deposit];
                write.catch(error => {
                    console.error('Add deposit error:', error);
                    this.dropSessionEntry(session, 'cashDeposits', deposit.id);
                    this.calculateTodayTransactions()
                        .then(() => this.updateUI())
                        .catch(e => console.error('Cash refresh failed:', e));
                    this.renderHistory();
                    UIManager.showToast(t('msg.cash.failed_add_deposit', { message: error.message }));
                });
                await this.calculateTodayTransactions();
                this.updateUI();
                this.renderHistory();
                
                UIManager.showToast(t('msg.cash.added_cash_drawer', { amount: formatAmount(depositAmount, { exact: true }) }));
                
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

            // "No bill" entries are in whole rupees (MONEY-ROUND, #129)
            const legAmount = entryAmount(amount);
            if (!(legAmount > 0)) {
                UIManager.showToast(t('msg.common.enter_valid_amount'));
                return;
            }
            const payment = noBillLeg({
                id: Helpers.generateId(),
                type, // 'received' or 'paid'
                party: partyName,
                amount: legAmount,
                notes,
                timestamp: new Date().toISOString(),
                recordedBy: AppState.userName || 'Unknown'
            });

            const session = this.todaySession;
            try {
                // arrayUnion is queued offline: show it now, don't wait for the server
                const write = addSessionEntry(session.id, 'duePayments', payment);
                session.duePayments = [...(session.duePayments || []), payment];
                write.catch(error => {
                    console.error('Record payment error:', error);
                    this.dropSessionEntry(session, 'duePayments', payment.id);
                    this.calculateTodayTransactions()
                        .then(() => this.updateUI())
                        .catch(e => console.error('Cash refresh failed:', e));
                    this.renderHistory();
                    UIManager.showToast(t('msg.cash.failed_record_payment', { message: error.message }));
                });
                await this.calculateTodayTransactions();
                this.updateUI();
                this.renderHistory();
                
                UIManager.showToast(t(type === 'paid' ? 'msg.cash.recorded_paid_to' : 'msg.cash.recorded_received_from', { amount: formatAmount(legAmount, { exact: true }), partyName }));
                
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
            if (!this.cachedSessions) await this.loadRecentSessions();
            if (this.todaySession) this.cacheSession(this.todaySession);
            this.renderSessionList(container, [...this.cachedSessions]);
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
        const pastDays = can(AppState.userRole, 'oldCashSessions', AppState.settings?.roleAccess);
        if (!pastDays) {
            const today = todayLocalISO();
            sessions = sessions.filter(s => s.date === today || isNotCounted(s));
        }
        sessions.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        const loadOlder = pastDays && this.hasOlderSessions
            ? `<button type="button" id="cashLoadOlder" onclick="window.app.cashManagement.loadOlder()" style="display: block; margin: 12px auto 4px; background: #f3f4f6; color: #374151; border: 1px solid #d1d5db; padding: 8px 16px; border-radius: 6px; font-weight: 600;">${L('ui.cash.load_older')}</button>`
            : '';

        if (sessions.length === 0) {
            container.innerHTML = `<p style="text-align: center; color: #6c757d; padding: 20px;">${L('ui.cash.no_history')}</p>${loadOlder}`;
            return;
        }

        const notCounted = sessions.filter(isNotCounted);
        const dayLabel = (session) => (parseAnyBillDate(session.date) || new Date(NaN)).toLocaleDateString(displayLocale(), {
            weekday: 'short',
            day: 'numeric',
            month: 'short'
        });
        const review = notCounted.length > 0 ? `
            <div style="background: #fff7ed; border: 1px solid #fdba74; border-radius: 8px; padding: 10px; margin-bottom: 10px; font-size: 13px; color: #9a3412;">
                <strong>${Helpers.escapeHtml(tn('ui.cash.days_not_counted', notCounted.length))}</strong>
                <div style="margin-top: 4px;">${L('ui.cash.tap_day_to_count')} ${notCounted.map(s => `<a href="#" onclick="window.app.cashManagement.showDetails('${Helpers.escapeJsAttr(s.date)}'); return false;" style="color: #9a3412; font-weight: 600;">${Helpers.escapeHtml(dayLabel(s))}</a>`).join(', ')}</div>
            </div>` : '';
        const dupDays = AppState.userRole === 'owner'
            ? [...new Set([...(this.duplicateDays || []), ...duplicateSessionDays(sessions)])].sort().reverse()
            : [];
        const duplicates = dupDays.length > 0 ? `
            <div style="background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; padding: 10px; margin-bottom: 10px; font-size: 13px; color: #991b1b;">
                <strong>${Helpers.escapeHtml(tn('ui.cash.duplicate_days', dupDays.length))}</strong>
                <div style="margin-top: 4px;">${dupDays.map(d => Helpers.escapeHtml(dayLabel({ date: d }))).join(', ')}</div>
            </div>` : '';

        container.innerHTML = review + duplicates + sessions.map(session => {
            const date = dayLabel(session);
            const uncounted = isNotCounted(session);

            const status = !session.signedOut
                ? `<span style="color: #15803d; font-weight: 600;">● ${L('ui.cash.active')}</span>`
                : (uncounted ? `<span style="color: #c2410c; font-weight: 600;">⚠ ${L('ui.cash.not_counted')}</span>` : `<span style="color: #6c757d;">✓ ${L('ui.cash.closed')}</span>`);

            const diff = Number(session.difference) || 0;
            const { abs: absDiff, level } = differenceBand(diff);
            const diffColor = DIFF_COLORS[level];
            const diffText = absDiff < 1 ? L('ui.cash.matched') : (diff > 0 ? `+${formatRupees(diff, { decimals: 2 })}` : formatRupees(-absDiff, { decimals: 2 }));
            const cashAdded = session.transactions?.cashDeposits || 0;
            const closedRows = uncounted ? `
                            <div>${L('ui.cash.closing')} <strong style="color: #c2410c;">${L('ui.cash.not_counted')}</strong></div>
                            <div>${L('ui.cash.expected')} <strong>${formatRupees(session.expectedBalance || 0, { exact: true })}</strong></div>
                            ` : `
                            <div>${L('ui.cash.closing')} <strong>${formatRupees(session.closingBalance, { exact: true })}</strong></div>
                            ${cashAdded > 0 ? `<div>${L('ui.cash.added')} <strong style="color: #10b981;">+${formatRupees(cashAdded, { exact: true })}</strong></div>` : ''}
                            <div>${L('ui.cash.expected')} <strong>${formatRupees(session.expectedBalance || 0, { exact: true })}</strong></div>
                            <div>${L('ui.cash.diff')} <strong style="color: ${diffColor};">${diffText}</strong></div>
                            `;

            return `
                <div onclick="window.app.cashManagement.showDetails('${Helpers.escapeJsAttr(session.date)}')" style="border-bottom: 1px solid #e5e7eb; padding: 12px 0; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#f8f9fa'" onmouseout="this.style.background='white'">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <strong style="font-size: 15px;">${date}</strong>
                        ${status}
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 14px; color: #6c757d;">
                        <div>${L('ui.cash.opening')} <strong>${formatRupees(session.openingBalance, { exact: true })}</strong></div>
                        ${session.signedOut ? closedRows : `<div>${L('ui.cash.in_progress')}</div>`}
                    </div>
                    ${session.duePayments && session.duePayments.length > 0 ? `
                        <div style="margin-top: 8px; font-size: 13px; color: #6c757d;">
                            ${Helpers.escapeHtml(tn('ui.cash.due_payments_recorded', session.duePayments.length))}
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('') + loadOlder;
    }

    static async showSessionDetails(sessionDate) {
        try {
            let session = sessionForDate(this.cachedSessions || [], sessionDate);
            if (!session) {
                session = sessionForDate(await FirebaseService.loadCashSessionsForDate(sessionDate), sessionDate);
                if (session) this.cacheSession(session);
            }
            
            if (!session) {
                UIManager.showToast(t('msg.cash.session_not_found'));
                return;
            }
            if (session.date !== todayLocalISO() && !isNotCounted(session)
                && !can(AppState.userRole, 'oldCashSessions', AppState.settings?.roleAccess)) {
                UIManager.showToast(t('msg.roles.section_not_allowed'));
                return;
            }

        const date = (parseAnyBillDate(session.date) || new Date(NaN)).toLocaleDateString(displayLocale(), { 
            weekday: 'long', 
            day: 'numeric', 
            month: 'long',
            year: 'numeric'
        });

        const diff = session.difference || 0;
        const absDiff = differenceBand(diff).abs;
        const uncounted = isNotCounted(session);
        const diffText = uncounted ? L('ui.cash.not_counted') : (absDiff < 1 ? L('ui.cash.matched') : `${diff >= 0 ? '+' : ''}${formatRupees(diff, { decimals: 2 })}`);

        // An open session has no saved snapshot yet: use today's live totals.
        const isLiveToday = !session.signedOut && this.todaySession && this.todaySession.date === session.date;
        const txns = (isLiveToday ? this.todayTransactions : session.transactions) || {};
        const { totals, totalCashIn, cashIn, totalCashOut, countedLevel } = sessionDetail(session, txns, uncounted);
        
        const cardDiffColor = DIFF_COLORS[countedLevel];
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
                        <button type="button" onclick="window.app.cashManagement.recordLateCount('${Helpers.escapeJsAttr(session.id)}')" data-cash-save="count" style="background: #ea580c; color: white; border: none; padding: 8px 12px; border-radius: 6px; font-weight: 600;">${L('ui.cash.save_count')}</button>
                    </div>
                </div>` : ''}
                <!-- Summary Card -->
                ${session.signedOut ? `
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-bottom: 10px;">
                    <!-- Expenses & Others -->
                    <div style="background: rgba(139, 92, 246, 0.1); padding: 10px; border-radius: 8px;">
                        <div style="font-size: 12px; color: #7c3aed; margin-bottom: 4px; font-weight: 600;">${L('ui.cash.expenses_others')}</div>
                        <div style="font-size: 20px; font-weight: 700; color: #6d28d9;">${formatRupees(totalCashOut, { exact: true })}</div>
                    </div>
                    
                    <!-- Expected Balance -->
                    <div style="background: rgba(139, 92, 246, 0.1); padding: 10px; border-radius: 8px;">
                        <div style="font-size: 12px; color: #7c3aed; margin-bottom: 4px; font-weight: 600;">${L('ui.cash.expected_balance')}</div>
                        <div style="font-size: 20px; font-weight: 700; color: #6d28d9;">${formatRupees(session.expectedBalance || 0, { exact: true })}</div>
                    </div>
                    
                    <!-- Actual Balance -->
                    <div style="background: rgba(139, 92, 246, 0.1); padding: 10px; border-radius: 8px;">
                        <div style="font-size: 12px; color: #7c3aed; margin-bottom: 4px; font-weight: 600;">${L('ui.cash.actual_balance')}</div>
                        <div style="font-size: 20px; font-weight: 700; color: #6d28d9;">${uncounted ? L('ui.cash.not_counted') : `${formatRupees(session.closingBalance, { exact: true })}`}</div>
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
                        <div style="font-size: 20px; font-weight: 700; color: #6d28d9;">${formatRupees(session.openingBalance || 0, { exact: true })}</div>
                    </div>
                    
                    <!-- Cash In -->
                    <div style="background: rgba(139, 92, 246, 0.1); padding: 10px; border-radius: 8px;">
                        <div style="font-size: 12px; color: #7c3aed; margin-bottom: 4px; font-weight: 600;">${L('ui.cash.cash_in')}</div>
                        <div style="font-size: 20px; font-weight: 700; color: #6d28d9;">${formatRupees(cashIn, { exact: true })}</div>
                    </div>
                    
                    <!-- Cash Out -->
                    <div style="background: rgba(139, 92, 246, 0.1); padding: 10px; border-radius: 8px;">
                        <div style="font-size: 12px; color: #7c3aed; margin-bottom: 4px; font-weight: 600;">${L('ui.cash.cash_out')}</div>
                        <div style="font-size: 20px; font-weight: 700; color: #6d28d9;">${formatRupees(totalCashOut, { exact: true })}</div>
                    </div>
                    
                    <!-- Expected Cash -->
                    <div style="background: rgba(139, 92, 246, 0.1); padding: 10px; border-radius: 8px;">
                        <div style="font-size: 12px; color: #7c3aed; margin-bottom: 4px; font-weight: 600;">${L('ui.cash.expected_cash_title')}</div>
                        <div style="font-size: 20px; font-weight: 700; color: #6d28d9;">${formatRupees(isLiveToday ? totals.expected : (session.expectedBalance || 0), { exact: true })}</div>
                    </div>
                </div>
                `}
                
                <!-- Cash In Group -->
                <div style="background: #d1fae5; padding: 10px; border-radius: 8px; margin-bottom: 8px;">
                    <h3 style="margin: 0 0 6px 0; font-size: 13px; color: #166534;">${L('ui.cash.cash_in')}</h3>
                    <div style="display: grid; gap: 6px; font-size: 13px;">
                        <div style="display: flex; justify-content: space-between;">
                            <span>${L('ui.cash.opening_balance_2')}</span>
                            <strong style="color: #6366f1;">${formatRupees(session.openingBalance, { exact: true })}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>${L('ui.cash.cash_added_2')}</span>
                            <strong style="color: #10b981;">${formatRupees(txns.cashDeposits || 0, { exact: true })}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>${L('ui.cash.cash_sales')}</span>
                            <strong style="color: #15803d;">${formatRupees(txns.cashSales || 0, { exact: true })}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>${L('ui.common.due_received')}</span>
                            <strong style="color: #3b82f6;">${formatRupees(txns.dueReceived || 0, { exact: true })}</strong>
                        </div>
                        <div style="border-top: 2px solid #059669; margin-top: 6px; padding-top: 6px; display: flex; justify-content: space-between; font-weight: 600;">
                            <span>${L('ui.cash.total_cash_in')}</span>
                            <strong style="color: #059669;">${formatRupees(totalCashIn, { exact: true })}</strong>
                        </div>
                    </div>
                </div>
                
                <!-- Cash Out Group -->
                <div style="background: #fee2e2; padding: 10px; border-radius: 8px; margin-bottom: 8px;">
                    <h3 style="margin: 0 0 6px 0; font-size: 13px; color: #991b1b;">${L('ui.cash.cash_out')}</h3>
                    <div style="display: grid; gap: 6px; font-size: 13px;">
                        <div style="display: flex; justify-content: space-between;">
                            <span>${L('ui.cash.cash_purchases')}</span>
                            <strong style="color: #ef4444;">${formatRupees(txns.cashPurchases || 0, { exact: true })}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>${L('ui.common.due_paid')}</span>
                            <strong style="color: #b91c1c;">${formatRupees(txns.duePaid || 0, { exact: true })}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>${L('ui.cash.business_expenses')}</span>
                            <strong style="color: #f97316;">${formatRupees(txns.businessExpenses || 0, { exact: true })}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>${L('ui.cash.personal_expenses')}</span>
                            <strong style="color: #f59e0b;">${formatRupees(txns.personalExpenses || 0, { exact: true })}</strong>
                        </div>
                        <div style="border-top: 2px solid #b91c1c; margin-top: 6px; padding-top: 6px; display: flex; justify-content: space-between; font-weight: 600;">
                            <span>${L('ui.cash.total_cash_out')}</span>
                            <strong style="color: #b91c1c;">${formatRupees(totalCashOut, { exact: true })}</strong>
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
                                        <strong style="color: #10b981; font-size: 13px;">${formatRupees(d.amount, { exact: true })}</strong>
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
                                            <strong style="color: ${amountColor}; font-size: 13px;">${isReceived ? '+' : '-'}${formatRupees(dueLegAmount(p), { exact: true })}</strong>
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
