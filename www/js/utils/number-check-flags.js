/**
 * @fileoverview Number-check mismatches as owner flags (#160): the daily TIP
 * NumberChecks run (Diagnostics › Number checks on this phone's loaded data,
 * utils/number-checks.js) turns each failed check into one anomaly record.
 * The id is the check plus a fingerprint of what failed, so the same
 * mismatch found again (on any phone, any day) is the same record and keeps
 * its review; a different set of mismatches is a new flag. Pure.
 * @module utils/number-check-flags
 */

import { anomalyId, istDayKey, istHour } from './anomalies.js';
import { round2 } from './money.js';
import { t } from '../i18n/index.js';

/** Checks about money on bills or the drawer are high; the rest medium. */
const HIGH = new Set(['AC2', 'AC3', 'AC5', 'AC6']);
/** References named in the flag text; the rest are counted. */
const SHOWN = 3;

/** What a mismatch row is about: bill id, item or day. */
const refKey = (row) => {
    const r = row?.ref || {};
    return String(r.id || r.item || r.day || r.number || '');
};
const refLabel = (row) => {
    const r = row?.ref || {};
    return String(r.number || r.item || r.day || '');
};

/** FNV-1a (32 bit) in base 36: short and stable, not a secret. */
export function fingerprint(text) {
    let h = 0x811c9dc5;
    for (const ch of String(text)) {
        h ^= ch.codePointAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
}

/**
 * Anomaly records for the failed checks of one run.
 * @param {Array<{id: string, key: string, status: string, problems: number, rows: Array}>} results runNumberChecks()
 * @param {number} now ms
 * @returns {Array<Object>} anomalies (utils/anomalies.js shape), refKind 'check'
 */
export function numberCheckFlags(results, now) {
    return (Array.isArray(results) ? results : []).filter(r => r && r.status === 'fail' && /^AC\d+$/.test(String(r.id))).map(r => {
        const rows = Array.isArray(r.rows) ? r.rows : [];
        const id = String(r.id);
        const print = fingerprint(`${id}|${r.problems}|${rows.map(refKey).sort().join('|')}`);
        const labels = [...new Set(rows.map(refLabel).filter(Boolean))];
        const list = labels.slice(0, SHOWN).join(', ') + (r.problems > SHOWN ? ' …' : '');
        const text = (lang) => `${t(r.key, null, lang)}: ${t('ui.numchecks.flag_found', { count: r.problems }, lang)}${list ? ` (${list})` : ''}`;
        const money = rows.filter(x => x.unit !== 'qty');
        let amount = 0;
        money.forEach(x => { amount += Math.abs(Number(x.diff) || 0); });
        return {
            id: anomalyId(`numcheck-${id.toLowerCase()}`, 'check', print),
            type: `numcheck-${id.toLowerCase()}`,
            severity: HIGH.has(id) ? 'high' : 'medium',
            en: text('en'),
            hi: text('hi'),
            refKind: 'check',
            refId: `${id}-${print}`,
            billType: null,
            billNumber: null,
            party: '',
            item: '',
            userId: '',
            user: '',
            amount: round2(amount),
            at: now,
            dayKey: istDayKey(now),
            hour: istHour(now),
            detectedBy: 'numchecks'
        };
    });
}
