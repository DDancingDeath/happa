/**
 * @fileoverview Bill fields shared by the save and the edit paths: the edit records'
 * sub-collection (#121), the money fields, the server `createdAt` (#115) and what an
 * overwrite keeps. Moved verbatim out of repos/bills.js (#69).
 * @module firebase/repos/bill-fields
 */

import { serverCreatedAt } from '../db.js';
import { billEditChanges, editCountOf, editRecord, hasEditChanges, nextEditNumber } from '../../utils/bill-edits.js';
import { AppState } from '../../utils/state.js';
import { t } from '../../i18n/index.js';

/** A bill's edit records (#121): a sub-collection, so the bill's own (dev_-prefixed) collection sets the environment. */
export const BILL_EDITS = 'edits';

export const billEditsRef = (billRef) => billRef.collection(BILL_EDITS);

/** Bill fields that Outstanding / other devices change after a bill is created. */
export const BILL_MONEY_FIELDS = ['payment', 'payments', 'dueAmount', 'cashPayment', 'onlinePayment', 'openDue', 'cleared'];

export const withServerCreatedAt = (record) => ({ ...record, createdAt: serverCreatedAt() });

/** Keeps the bill's stored `createdAt` on an overwrite (the rules refuse a change). */
export function keepStoredCreatedAt(record, stored) {
    if (stored && stored.createdAt !== undefined && stored.createdAt !== null) record.createdAt = stored.createdAt;
    else delete record.createdAt;
}

/** Keeps the bill's stored edit count on an overwrite (#121: it only moves with an edit record). */
export function keepEditCount(record, stored) {
    if (editCountOf(stored)) record.editCount = editCountOf(stored);
    else delete record.editCount;
}

/**
 * A retried new bill that changes what its unconfirmed first save stored is an edit (#121):
 * its record goes into the same transaction, with a fixed reason in the app language.
 * Sets `target.editCount`. @private
 */
export function logRetryEdit(tx, ref, server, after, target) {
    const changes = billEditChanges(server, after);
    if (!hasEditChanges(changes)) return;
    const n = nextEditNumber(server);
    target.editCount = n;
    tx.set(billEditsRef(ref).doc(String(n)), editRecord({
        n, at: serverCreatedAt(), by: AppState.currentUser?.uid || null, byName: AppState.userName,
        reason: t('ui.edits.retry_reason'), changes
    }));
}
