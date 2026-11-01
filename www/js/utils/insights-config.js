/**
 * @fileoverview Owner choices behind the Money, Insights and Statements pages
 * (docs/insights-redesign.md §11). Each choice is one constant here; the owner
 * can override any of them in `settings/app.insights` (same keys), read through
 * insightsSettings(). Pure: no DOM, no Firestore.
 * @module utils/insights-config
 */

export const INSIGHTS_DEFAULTS = Object.freeze({
    /** #43: "This month" = calendar month to today ('calendar') or the last 30 days ('last30'). */
    monthMode: 'calendar',
    /** "This year" starts in this month (0 = January: calendar year; 3 = April: financial year). */
    yearStartMonth: 0,
    /** Labour on purchases in the cost of goods sold. false: shown as its own line under profit. */
    labourInCost: false,
    /** #39: what net worth adds up (payables are always taken off). */
    netWorthTerms: Object.freeze(['stock', 'receivable', 'accounts', 'drawer']),
    /** A party is overdue when its oldest open bill is older than this (days). */
    overdueDays: 30,
    /** An item is "low profit" under this much profit per ₹100 of sales… */
    lowMarginPer100: 3,
    /** …when it sold at least this much in the period (₹). */
    lowMarginMinSales: 5000,
    /** A regular buyer "stopped coming" after this many days without a bill. */
    stoppedComingDays: 60,
    /** Season index at or above this is a busy month, at or below `seasonQuiet` a quiet one. */
    seasonBusy: 1.5,
    seasonQuiet: 0.5,
    /** Changes smaller than this (%) read "about the same". */
    sameWithinPct: 2,
    /** Q7 (#111): Money › Spending nudges when business expenses are more than this per ₹100 of sales (M19). */
    expenseNudgePer100: 10
});

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * The owner's settings over the defaults; unknown or invalid values fall back.
 * @param {Object} [raw] `settings/app.insights`
 * @returns {typeof INSIGHTS_DEFAULTS}
 */
export function insightsSettings(raw = {}) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const d = INSIGHTS_DEFAULTS;
    const terms = Array.isArray(r.netWorthTerms)
        ? r.netWorthTerms.filter(x => d.netWorthTerms.includes(x))
        : d.netWorthTerms;
    return Object.freeze({
        monthMode: r.monthMode === 'last30' ? 'last30' : d.monthMode,
        yearStartMonth: Math.min(11, Math.max(0, Math.trunc(num(r.yearStartMonth, d.yearStartMonth)))),
        labourInCost: r.labourInCost === true,
        netWorthTerms: Object.freeze([...terms]),
        overdueDays: Math.max(1, num(r.overdueDays, d.overdueDays)),
        lowMarginPer100: num(r.lowMarginPer100, d.lowMarginPer100),
        lowMarginMinSales: Math.max(0, num(r.lowMarginMinSales, d.lowMarginMinSales)),
        stoppedComingDays: Math.max(1, num(r.stoppedComingDays, d.stoppedComingDays)),
        seasonBusy: num(r.seasonBusy, d.seasonBusy),
        seasonQuiet: num(r.seasonQuiet, d.seasonQuiet),
        sameWithinPct: Math.max(0, num(r.sameWithinPct, d.sameWithinPct)),
        expenseNudgePer100: Math.max(0, num(r.expenseNudgePer100, d.expenseNudgePer100))
    });
}
