/**
 * @fileoverview TIP scenario NumberChecks (#161, #160): once a day an owner's
 * or manager's phone runs the accounting checks (Diagnostics › Number checks,
 * utils/number-checks.js) on the data it has loaded and reports which check
 * failed, without amounts. Reads nothing. Reason = the first failed check.
 * Reason codes are stable: never renumber or reuse them.
 * @module tip/scenarios/number-checks
 */

const STORE_KEY = 'aadhat.tip.numberChecksDay';

export const NumberChecksTest = {
    id: 'NumberChecks',
    reasons: { ac1: 1, ac2: 2, ac3: 3, ac4: 4, ac5: 5, ac6: 6, ac7: 7, ac8: 8, other: 30 },
    timeoutMs: 60 * 1000,
    target: 95,
    onAbandon: 'discard',
    evaluate(props) {
        if (!props.failed) return props.checked ? 'succeed' : 'ignore';
        const reason = String(props.first || '').toLowerCase();
        return { result: 'fail', reason: NumberChecksTest.reasons[reason] ? reason : 'other' };
    }
};

/**
 * Counts only: how many checks ran / failed and the first failed id.
 * @param {Array<{id: string, status: string}>} results runNumberChecks()
 * @returns {Object}
 */
export function numberChecksProps(results) {
    const list = Array.isArray(results) ? results : [];
    const failed = list.filter(r => r && r.status === 'fail');
    return {
        checked: list.filter(r => r && r.status !== 'skip').length,
        failed: failed.length,
        first: failed.length ? String(failed[0].id).slice(0, 8) : null,
        failedIds: failed.map(r => r.id).join(',').slice(0, 64) || null
    };
}

/**
 * True at most once per local day per phone; marks the day when true.
 * @param {Storage} store
 * @param {string} dayKey YYYYMMDD
 * @returns {boolean}
 */
export function claimToday(store, dayKey) {
    try {
        if (!store || store.getItem(STORE_KEY) === dayKey) return false;
        store.setItem(STORE_KEY, dayKey);
        return true;
    } catch (_) {
        return false;
    }
}
