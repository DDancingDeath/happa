/**
 * @fileoverview Likely cause of each mismatch class the real-data audit finds,
 * and whether it is already tracked. Keyed by `scope:spec@page`, `scope:spec`,
 * `spec@page` or `spec` (most specific first). When the audit reports
 * "not yet explained", find the cause, add it here, and add an anonymised
 * regression fixture + oracle test (tests/oracle/real-shapes.test.js).
 * No data in here: causes only.
 */

const NEGATIVE_STOCK = {
    short: 'Stock below zero (sold before bought): app writes the refilled deficit off (stock-replay.js:replayEvents, #215), oracle keeps its cost',
    cause: 'Stock went below zero (sold before the purchase was recorded, AC8). When the purchase refills the hole, '
        + 'www/js/utils/stock-replay.js:replayEvents values the stock at the refill rate and writes the uncosted units off '
        + '(#215 design: "uncosted" warning + check-line gap in utils/finance-calc.js:stockMovement); the oracle carries their cost '
        + 'into the average instead. Confirmed when M2_cogs_items_never_below_zero (same periods without those items) has no mismatches.',
    known: 'known (#215 design; AC8 data)',
    check: 'negativeStock'
};
const AC220 = {
    short: 'analytics.js:renderOutstandingDues counts cleared bills that keep an old due',
    cause: 'www/js/modules/analytics.js:renderOutstandingDues reads `due || payment.due` and ignores `cleared`, so cleared bills '
        + 'that still carry their old due are counted (see "Bills marked cleared that still carry a due amount").',
    known: 'known #220'
};
const OPENING = {
    short: 'Opening records counted as period activity (day.js:loadTodayData, reports.js:renderOverview, finance-calc.js:billsInRange)',
    cause: 'Opening records (tools/migrate: one per old unpaid bill, dated with the old bill\'s date) are filtered like ordinary bills '
        + 'by date in www/js/modules/day.js:loadTodayData, modules/reports.js:renderOverview and utils/finance-calc.js:billsInRange.',
    known: 'known (PR #18, batch-B fix/opening-records-excluded)'
};
const SAME_ROOT = 'new spec ID (same root as PR #18)';

export const CAUSES = {
    // ---- real data
    F2_cogs: NEGATIVE_STOCK,
    F4_profit: NEGATIVE_STOCK,
    R3_profit: { ...NEGATIVE_STOCK, cause: `= Finance profit (#36). ${NEGATIVE_STOCK.cause}` },
    A4_profit: { ...NEGATIVE_STOCK, cause: `= Finance profit (#36). ${NEGATIVE_STOCK.cause}` },
    A7_profitByDay: { ...NEGATIVE_STOCK, cause: `Per-day split of Finance profit (AC7_profitByDay_vs_finance agrees). ${NEGATIVE_STOCK.cause}` },
    F8_gap: { short: 'F8 check-line gap shown by design after refilled oversells', cause: 'The check-line gap the app shows on purpose when goods sold earlier are refilled (F8); same root as F2.', known: 'known (F8 by design; AC8 data)', check: 'negativeStock' },
    F6_stockValue: NEGATIVE_STOCK,
    S3_value: NEGATIVE_STOCK,
    S4_total: NEGATIVE_STOCK,
    // Calculation layer (business-metrics.js): the cost of goods sold is the same replay as F2.
    M2_cogs: NEGATIVE_STOCK,
    M3_gross: { ...NEGATIVE_STOCK, cause: `= sales − cost of goods sold (M2). ${NEGATIVE_STOCK.cause}` },
    M6_profit: { ...NEGATIVE_STOCK, cause: `= Finance profit (F4, #36). ${NEGATIVE_STOCK.cause}` },
    M10_kept: { ...NEGATIVE_STOCK, cause: `= profit (M6) − personal expenses − withdrawals. ${NEGATIVE_STOCK.cause}` },
    M11_profitByDay: { ...NEGATIVE_STOCK, cause: `Per-day split of profit (M6); the days add up to M6. ${NEGATIVE_STOCK.cause}` },
    M17_gap: { short: 'M17 check-line gap shown by design after refilled oversells', cause: 'The check-line gap the app shows on purpose when goods sold earlier are refilled (M17, as F8); same root as M2.', known: 'known (M17 by design; AC8 data)', check: 'negativeStock' },
    A3_expenses: {
        short: 'analytics.js:parseDate reads "D/M/YYYY, h:mm:ss pm" expense dates with new Date()',
        cause: 'www/js/modules/analytics.js:parseDate uses `new Date(text)`: expenses are dated "D/M/YYYY, h:mm:ss pm", '
            + 'which reads as month/day or Invalid Date, so most of the month\'s expenses are missed.',
        known: 'known #49 (new spec ID: A3)'
    },
    A3_expenseCount: { short: 'analytics.js:parseDate (as A3_expenses)', cause: 'Same as A3_expenses (analytics.js:parseDate).', known: 'known #49 (new spec ID: A3)' },
    A5_payable: { ...AC220, known: 'known #220 (new spec ID: A5)' },
    A5_payableCount: { ...AC220, known: 'known #220 (new spec ID: A5)' },
    A6_receivable: AC220,
    A6_receivableCount: AC220,
    AC5_due_to_pay: { ...AC220, cause: `Analytics differs from Finance/Reports/Outstanding. ${AC220.cause}` },
    AC5_due_to_receive: { ...AC220, cause: `Analytics differs from Finance/Reports. ${AC220.cause}` },
    AC6_stored_vs_live: {
        short: 'History: drawer total saved at close by the old formula (no due payments before #95) or bills edited after close',
        cause: 'History, not a formula error: the expected cash saved at close differs from today\'s recomputation (C7 itself matches '
            + 'the oracle). See AC6_stored_part: due received/paid were not part of the old app\'s drawer before #95, and some bills of '
            + 'those days were edited, re-dated or deleted after the drawer was closed.',
        known: 'expected (old drawer formula / edits after close)'
    },
    AC6_stored_part: { short: 'Drawer part that moved since close', cause: 'Which drawer part moved since close (see AC6_stored_vs_live).', known: 'expected (old drawer formula / edits after close)' },

    // ---- migrated state (opening records + synthetic bills)
    'migrated:T15_dueToReceive': { ...OPENING, cause: `Today "Due to receive" adds the carried due of opening records dated that day. ${OPENING.cause}` },
    'migrated:T16_dueToPay': { ...OPENING, cause: `Today "Due to pay" adds carried payables dated that day. ${OPENING.cause}` },
    'migrated:T2_saleCount': { ...OPENING, cause: `Today's bill count includes opening records (₹0 bills). ${OPENING.cause}`, known: SAME_ROOT },
    'migrated:T1_purchaseCount': { ...OPENING, cause: `Today's bill count includes opening records (₹0 bills). ${OPENING.cause}`, known: SAME_ROOT },
    'migrated:R2_saleCount': { ...OPENING, cause: `Reports bill count includes opening records. ${OPENING.cause}`, known: SAME_ROOT },
    'migrated:R1_purchaseCount': { ...OPENING, cause: `Reports bill count includes opening records. ${OPENING.cause}`, known: SAME_ROOT },
    'migrated:F1_saleCount': { ...OPENING, cause: `Finance sale count includes opening records. ${OPENING.cause}`, known: SAME_ROOT },
    'migrated:R4_cash': {
        ...OPENING,
        cause: `A due payment made after go-live on an opening record shows as cash on the old bill's date in Reports (R4 reads the bill's current cash). ${OPENING.cause}`,
        known: SAME_ROOT
    }
};

/**
 * The cause of a mismatch group. A cause with `check` (e.g. 'negativeStock') is
 * only given for the rows where `evidence[check](row)` confirms it applies; it is
 * never matched by spec ID alone.
 * @param {{scope: string, spec: string, page: string, rows?: Array<{period: string}>}} g a mismatch group
 * @param {Object} table CAUSES
 * @param {?Object<string, (row: Object) => boolean>} [evidence] the scope's checks
 * @returns {?{cause: string, known: string, short?: string}}
 */
export function causeFor(g, table, evidence = null) {
    const c = table[`${g.scope}:${g.spec}@${g.page}`] || table[`${g.scope}:${g.spec}`] || table[`${g.spec}@${g.page}`] || table[g.spec] || null;
    if (!c || !c.check) return c;
    const applies = evidence && evidence[c.check];
    const rows = g.rows || [];
    if (!applies || !rows.length) return null;
    const hit = rows.filter(r => applies(r)).length;
    if (hit === rows.length) return c;
    if (!hit) return null;
    const left = rows.length - hit;
    return {
        ...c,
        short: `${c.short || c.cause} (${hit} of ${rows.length}; ${left} not explained)`,
        cause: `${c.cause} Checked per period: it applies to ${hit} of ${rows.length}; the other ${left} are not explained by it.`,
        known: `partly ${c.known}; ${left} new`
    };
}