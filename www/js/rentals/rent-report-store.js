/**
 * @fileoverview Data of the Rentals yearly report (#157, RENT-19): one year's
 * charges and property expenses, each one bounded range query on `month` (a
 * single-field range, no extra index). Loaded with rent-report.js (import() on
 * first use; not precached).
 * @module rentals/rent-report-store
 */

import { FirebaseService } from '../firebase/firestore-service.js';
import { rentCol } from './rent-store.js';

/** Most charges / expenses one report reads; reaching it is said on screen. */
export const REPORT_LIMIT = 3000;

/**
 * Charges and expenses of the months first..last ('YYYY-MM').
 * @returns {Promise<{charges: Object[], expenses: Object[], cut: boolean}>}
 */
export async function yearData(first, last) {
    const range = (name) => FirebaseService.db.collection(rentCol(name))
        .where('month', '>=', first).where('month', '<=', last).limit(REPORT_LIMIT).get();
    const [ch, ex] = await Promise.all([range('rent_charges'), range('rent_expenses')]);
    const rows = (snap) => snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return { charges: rows(ch), expenses: rows(ex), cut: ch.size >= REPORT_LIMIT || ex.size >= REPORT_LIMIT };
}
