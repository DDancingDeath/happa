/**
 * @fileoverview Number-check mismatches as owner flags (#160): the daily TIP
 * NumberChecks run (Diagnostics › Number checks on this phone's loaded data,
 * utils/number-checks.js) turns each mismatch row into one anomaly record,
 * filed under what it is about: the bill (opens it), the item (opens Stock)
 * or the cash day. The id is the check plus that reference, so the same
 * mismatch found again (on any phone, any day) is the same record and keeps
 * its review; each new mismatch is its own flag. A check lists at most
 * MAX_ROWS rows per run (the rest come up as those are fixed). Pure.
 * @module utils/number-check-flags
 */

import { anomalyId, istDayKey, istHour } from './anomalies.js';
import { formatRupees, round2 } from './money.js';
import { t } from '../i18n/index.js';

/** Checks about money on bills or the drawer are high; the rest medium. */
const HIGH = new Set(['AC2', 'AC3', 'AC5', 'AC6']);

/** Where a mismatch row points: a bill, an item's stock or a cash day. */
function refOf(row) {
    const r = row?.ref || {};
    if (r.kind) return r.id || r.number ? { refKind: 'bill', refId: String(r.id || r.number), billType: r.kind, billNumber: r.number || null, party: String(r.party || ''), item: '' } : null;
    if (r.item) return { refKind: 'stock', refId: String(r.item), billType: null, billNumber: null, party: '', item: String(r.item) };
    if (r.day) return { refKind: 'cash', refId: String(r.day), billType: null, billNumber: null, party: '', item: '' };
    return null;
}

const shown = (row, v) => (row.unit === 'qty' ? `${round2(Number(v) || 0)} kg` : formatRupees(Number(v) || 0, { small: true }));

/**
 * Anomaly records for the mismatch rows of one run's failed checks.
 * @param {Array<{id: string, key: string, status: string, rows: Array}>} results runNumberChecks()
 * @param {number} now ms
 * @returns {Array<Object>} anomalies (utils/anomalies.js shape), one per row
 */
export function numberCheckFlags(results, now) {
    const out = [];
    (Array.isArray(results) ? results : []).filter(r => r && r.status === 'fail' && /^AC\d+$/.test(String(r.id))).forEach(r => {
        const id = String(r.id);
        const type = `numcheck-${id.toLowerCase()}`;
        (Array.isArray(r.rows) ? r.rows : []).forEach(row => {
            const ref = refOf(row);
            if (!ref) return;
            const text = (lang) => `${t(r.key, null, lang)}: ${t('ui.numchecks.flag_found', { expected: shown(row, row.expected), actual: shown(row, row.actual) }, lang)}`;
            out.push({
                id: anomalyId(type, ref.refKind, ref.refId),
                type,
                severity: HIGH.has(id) ? 'high' : 'medium',
                en: text('en'),
                hi: text('hi'),
                ...ref,
                userId: '',
                user: '',
                amount: row.unit === 'qty' ? 0 : round2(Math.abs(Number(row.diff) || 0)),
                at: now,
                dayKey: istDayKey(now),
                hour: istHour(now),
                detectedBy: 'numchecks'
            });
        });
    });
    return out;
}
