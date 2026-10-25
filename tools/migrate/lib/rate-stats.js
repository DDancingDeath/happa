/**
 * Buying and rate patterns for the new project, in the Rate trends layout
 * (#227): one `rateStats/{itemId}_{YYYY}` doc per item and year,
 * { itemId, year, weeks: {'wYYYY-MM-DD': bucket}, months: {'mYYYY-MM': bucket}, updatedAt },
 * built by the app's own billsToYearDocs(), and `rateStats/_meta` written the
 * way the app's backfill writes it (only the keys firestore.rules allows).
 */
import { billsToYearDocs, MIGRATION_META_BY } from '../../../www/js/utils/rate-trends.js';

/**
 * @param {{purchase?: Array, retail?: Array, wholesale?: Array}} sources bills by kind
 * @param {Array} items catalogue
 * @param {number} updatedAt
 * @returns {Object.<string, Object>} docId -> doc
 */
export function buildRateStatsDocs(sources, items, updatedAt) {
    const docs = billsToYearDocs(sources, items);
    Object.values(docs).forEach(d => { d.updatedAt = updatedAt; });
    return docs;
}

/**
 * `rateStats/_meta` as the app's finishBackfill() writes it. `backfillAt` is
 * the backup time: the cutoff after which the rate line follows the Items
 * page, and before which the roll-forward leaves buckets as carried
 * (`by: 'migration'`, see clampWindowToMigration()).
 */
export function rateStatsMeta({ bills, docs, cutoff }) {
    return {
        backfillDone: true,
        backfillAt: cutoff,
        bills,
        reads: 0,
        months: Object.values(docs).reduce((n, d) => n + Object.keys(d.months || {}).length, 0),
        by: MIGRATION_META_BY,
        byUserId: ''
    };
}