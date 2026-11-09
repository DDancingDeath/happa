/**
 * @fileoverview The "Already owes ₹X" line under the party name on the
 * purchase, retail and wholesale bills (#166). Refreshed by the bill-checks
 * run (ui/bill-highlight.js), so it is debounced with the rest of the live
 * checks. Information only — it never blocks saving.
 * Tap → Outstanding filtered to that party.
 * @module ui/party-due-line
 */

import { AppState } from '../utils/state.js';
import { billsForKind, partyDue, partyDueText } from '../utils/party-due.js';
import { t } from '../i18n/index.js';

const lineId = (kind) => `partyDue-${kind}`;

/**
 * Show / update / hide the due line for a billing form.
 * @param {'purchase'|'retail'|'wholesale'} kind
 * @param {string} inputId Party name input
 * @param {?Object} draft Check draft ({partyName, id, editingBill})
 * @returns {?Object} the due shown, or null when hidden
 */
export function renderPartyDue(kind, inputId, draft) {
    if (typeof document === 'undefined') return null;
    const input = inputId ? document.getElementById(inputId) : null;
    let el = document.getElementById(lineId(kind));
    const name = draft?.partyName ?? input?.value ?? '';
    const excludeId = draft?.editingBill?.id ?? draft?.id ?? null;
    const due = input ? partyDue(billsForKind(AppState, kind), name, { excludeId }) : null;

    if (!due) {
        if (el) {
            el.hidden = true;
            el.textContent = '';
            delete el.dataset.party;
        }
        return null;
    }
    if (!el) {
        el = document.createElement('button');
        el.type = 'button';
        el.id = lineId(kind);
        el.className = 'party-due-line';
        el.addEventListener('click', () => {
            if (el.dataset.party) window.app?.outstanding?.showParty?.(kind, el.dataset.party);
        });
        const row = input.closest('.form-row') || input;
        row.insertAdjacentElement('afterend', el);
    }
    el.hidden = false;
    el.dataset.party = String(name).trim();
    // Amber once the oldest bill is past 30 days (same buckets as Outstanding)
    el.classList.toggle('party-due-old', due.bucket > 0);
    el.textContent = `${kind === 'purchase' ? '📤' : '📥'} ${partyDueText(due, kind)}`;
    // Shown by CSS while the dues come from the phone's cache only (#59: html[data-updating])
    const mark = document.createElement('span');
    mark.className = 'updating-mark';
    mark.textContent = ` · ${t('ui.sync.updating_mark')}`;
    el.append(mark, ' ›');
    el.title = t('ui.billing.open_in_outstanding');
    return due;
}

/** Hide the line (bill cleared). */
export function hidePartyDue(kind) {
    if (typeof document === 'undefined') return;
    const el = document.getElementById(lineId(kind));
    if (el) {
        el.hidden = true;
        el.textContent = '';
        delete el.dataset.party;
    }
}
