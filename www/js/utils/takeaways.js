/**
 * @fileoverview One-line takeaways for Money and Insights (docs/insights-redesign.md
 * §5.1, §5.5): plain sentences built from figures and comparisons, as i18n keys
 * + params (catalogues: ui.tk.*). Pure; the page translates and escapes them.
 * Each takeaway may carry a `link` (route) for its next step.
 * @module utils/takeaways
 */

const dirOf = (c) => (c ? c.dir : null);

/**
 * Profit headline (M6) with the comparison that matters most: last year when
 * known, else the previous period. Explains a loss and an unknown cost.
 * @param {Object} a
 * @param {?number} a.profit M6
 * @param {?{pct: number, dir: string}} a.vsLastYear
 * @param {?{pct: number, dir: string}} a.vsPrevious
 * @param {string} a.lastYearLabel e.g. "Oct 2025"
 * @param {string} a.previousLabel e.g. "Sep"
 * @param {?{name: string, diff: number}} a.driver biggest item change (I6)
 * @param {?{qty: number, estimate: number}} a.uncosted
 * @param {?{pct: number, dir: string}} a.salesVsLastYear
 * @returns {Array<{key: string, params?: Object, link?: string}>}
 */
export function profitTakeaways({ profit, vsLastYear, vsPrevious, lastYearLabel, previousLabel, driver, uncosted, salesVsLastYear }) {
    const out = [];
    if (profit === null || profit === undefined) {
        out.push({ key: 'ui.tk.profit_unknown' });
        return out;
    }
    const amount = Math.abs(Math.round(profit));
    const cmp = vsLastYear || vsPrevious;
    const label = vsLastYear ? lastYearLabel : previousLabel;
    if (profit < 0) out.push({ key: 'ui.tk.loss', params: { amount } });
    else if (cmp) out.push({ key: `ui.tk.profit_${cmp.dir}`, params: { amount, pct: Math.abs(cmp.pct), when: label } });
    else out.push({ key: 'ui.tk.profit', params: { amount } });
    if (driver && driver.name && Math.round(driver.diff) !== 0) {
        out.push({ key: driver.diff > 0 ? 'ui.tk.driver_up' : 'ui.tk.driver_down', params: { item: driver.name, amount: Math.abs(Math.round(driver.diff)) }, link: 'insights-items' });
    }
    if (dirOf(salesVsLastYear) === 'up' && dirOf(vsLastYear) === 'down') out.push({ key: 'ui.tk.gut_sales_up_profit_down', link: 'insights-items' });
    if (uncosted && uncosted.qty > 0) {
        out.push({ key: 'ui.tk.gut_uncosted', params: { qty: Math.round(uncosted.qty * 100) / 100, amount: Math.round(uncosted.estimate || 0) } });
    }
    return out;
}

/**
 * Cash (M14): which way the money went, and the biggest outflow.
 * @param {{net: number, out: Object, dueToReceive?: number, profit?: ?number}} a
 */
export function cashTakeaways({ net, out, profit, salesDue }) {
    const res = [{ key: net >= 0 ? 'ui.tk.cash_in' : 'ui.tk.cash_out', params: { amount: Math.abs(Math.round(net)) } }];
    const parts = [['purchases', out.atPurchase], ['dues_paid', out.duePaid], ['expenses', out.expenses]].filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1]);
    if (parts.length) res.push({ key: `ui.tk.biggest_out_${parts[0][0]}`, params: { amount: Math.round(parts[0][1]) } });
    if (profit !== null && profit !== undefined && salesDue > 0 && net < profit) {
        res.push({ key: 'ui.tk.gut_dues', params: { amount: Math.round(salesDue) }, link: 'due' });
    }
    return res;
}

/**
 * Spending (M4, M8–M10). Personal use (M8 + M9) only with `show.personal`; what
 * stays of the profit (M10) only with both `show.profit` and `show.personal`.
 * @param {{business: number, vsLastYear: ?Object, topCategory: ?string, withdrawn: number, kept: ?number, personal: number,
 *   show?: {profit?: boolean, personal?: boolean}}} a
 */
export function spendingTakeaways({ business, vsLastYear, topCategory, withdrawn, kept, personal, show = {} }) {
    const out = [];
    if (business > 0 && vsLastYear && vsLastYear.dir !== 'same' && topCategory) {
        out.push({ key: `ui.tk.expenses_${vsLastYear.dir}`, params: { pct: Math.abs(vsLastYear.pct), category: topCategory } });
    } else if (business > 0 && topCategory) {
        out.push({ key: 'ui.tk.expenses_top', params: { category: topCategory } });
    } else if (business <= 0) {
        out.push({ key: 'ui.tk.expenses_none' });
    }
    if (!show.personal) return out;
    const taken = Math.round((withdrawn || 0) + (personal || 0));
    if (show.profit && kept !== null && kept !== undefined) {
        out.push({ key: kept >= 0 ? 'ui.tk.kept' : 'ui.tk.kept_negative', params: { taken, kept: Math.abs(Math.round(kept)) } });
    } else if (taken > 0) {
        out.push({ key: 'ui.tk.taken', params: { taken } });
    }
    return out;
}

/**
 * Worth (M15).
 * @param {{worth: ?number, change: ?Object, receivable: number, sinceLabel: string}} a
 */
export function worthTakeaways({ worth, change, receivable, sinceLabel, accountsKnown = true }) {
    if (!accountsKnown && (worth === null || worth === undefined)) return [{ key: 'ui.tk.worth_accounts_unknown' }];
    if (worth === null || worth === undefined) return [{ key: 'ui.tk.worth_unknown', link: 'stock' }];
    const out = [];
    if (change && change.dir !== 'same') out.push({ key: `ui.tk.worth_${change.dir}`, params: { amount: Math.abs(Math.round(change.diff)), when: sinceLabel } });
    else out.push({ key: 'ui.tk.worth', params: { amount: Math.round(worth) } });
    if (receivable > 0) out.push({ key: 'ui.tk.worth_receivable', params: { amount: Math.round(receivable) }, link: 'due' });
    return out;
}
