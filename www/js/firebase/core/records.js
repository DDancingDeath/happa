/**
 * @fileoverview History collections and their loaded records, shared by the data layer:
 * which collections the history window loads (and who may read them), the document id
 * and loaded payment state kept with each record, and their order. Moved verbatim out
 * of firestore-service.js (docs/architecture.md, phase 5, #69).
 * @module firebase/core/records
 */

import { AppState } from '../../utils/state.js';
import { canReadWithdrawals } from '../../utils/role-access.js';
import { canReadPersonalExpenses } from '../../utils/personal-expenses.js';
import { dateDescComparator } from '../../utils/history-range.js';

export const HISTORY_COLLECTIONS = [
    { key: 'purchases', stateKey: 'purchaseHistory', label: 'Purchases', stock: true, dues: true,
        views: ['billingDropdown', 'salesDropdown', 'history', 'due', 'stockView', 'money', 'insights', 'statements', 'today'] },
    { key: 'retailSales', stateKey: 'retailSalesHistory', label: 'Retail sales', stock: true, dues: true,
        views: ['billingDropdown', 'history', 'due', 'stockView', 'money', 'insights', 'statements', 'today'] },
    { key: 'wholesaleSales', stateKey: 'salesHistory', label: 'Sales', stock: true, dues: true,
        views: ['billingDropdown', 'salesDropdown', 'wholesaleHistory', 'wholesaleOutstanding', 'history', 'due', 'stockView', 'money', 'insights', 'statements', 'today'] },
    { key: 'expenses', stateKey: 'expensesHistory', label: 'Expenses', voidable: true,
        views: ['expensesHistory', 'money', 'insights', 'statements', 'today'] },
    // Shares AppState.expensesHistory with `expenses` (publishCollection merges them, #98)
    { key: 'personalExpenses', stateKey: 'expensesHistory', label: 'Personal expenses', optional: true, timestamped: true, voidable: true,
        views: ['expensesHistory', 'money', 'insights', 'statements', 'today'] },
    { key: 'stockAdjustments', stateKey: 'stockAdjustments', label: 'Stock adjustments', stock: true,
        views: ['stockAdjustmentHistory', 'stockView', 'money', 'insights', 'statements'] },
    { key: 'withdrawals', stateKey: 'withdrawalsHistory', label: 'Withdrawals', optional: true,
        views: ['money', 'statements'] }
];
export const HISTORY_SPEC = Object.fromEntries(HISTORY_COLLECTIONS.map(s => [s.key, s]));
export const ALL_HISTORY_VIEWS = [...new Set(HISTORY_COLLECTIONS.flatMap(s => s.views))];

/**
 * Whether this user may read a history collection (firestore.rules): withdrawals
 * only with Money, Statements or Insights on for the role (#57). Uses the last
 * known Roles & access, so a change applies from the next app start.
 */
export function historySpecReadable(spec, role = AppState.userRole, roleAccess = AppState.settings?.roleAccess) {
    if (spec.key === 'withdrawals') return canReadWithdrawals(role, roleAccess);
    if (spec.key === 'personalExpenses') return canReadPersonalExpenses(role, roleAccess);
    return true;
}

/** Firestore document id of each mapped record (the data may carry its own `id`). */
export const docIds = new WeakMap();

/**
 * Payment state of a bill as loaded from Firestore. Stored under a symbol key
 * so it survives `{...bill}` copies made by edit screens (and is never written
 * back: Firestore and JSON ignore symbol keys). update*() compare it with the
 * server copy to refuse overwriting payments recorded on another device.
 */
export const LOADED_PAYMENT = Symbol('aadhatLoadedPayment');
/** JSON with sorted object keys (Firestore returns map fields in its own order). */
export const stableJson = (v) => {
    if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
    if (v && typeof v === 'object' && !(typeof v.toMillis === 'function')) {
        return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
    }
    if (v && typeof v.toMillis === 'function') return String(v.toMillis());
    return JSON.stringify(v ?? null);
};
export const paymentSignature = (d) => {
    if (!d) return null;
    const p = d.payment && typeof d.payment === 'object' ? d.payment : {};
    const payments = Array.isArray(d.payments) ? d.payments : [];
    return stableJson([
        p.due ?? null, p.cash ?? null, p.online ?? null, p.total ?? null,
        payments.length, payments.length ? payments[payments.length - 1] : null,
        d.dueAmount ?? null, !!d.cleared
    ]);
};

export const mapDoc = (doc) => {
    // 'estimate': a bill saved on this device still shows its createdAt (#87) until the server confirms it
    const data = doc.data({ serverTimestamps: 'estimate' });
    const rec = { id: doc.id, ...data };
    docIds.set(rec, doc.id);
    rec[LOADED_PAYMENT] = paymentSignature(data);
    return rec;
};

/** Only owners/managers write checkpoint state (firestore.rules); staff devices never rebuild/roll forward. */
export const canManageCheckpoint = () => ['owner', 'manager'].includes(AppState.userRole);
export const isPermissionDenied = (e) => e?.code === 'permission-denied' || /insufficient permissions/i.test(String(e?.message || ''));
export const docIdOf = (rec) => (docIds.has(rec) ? docIds.get(rec) : String(rec?.id));
export const byDateDesc = dateDescComparator(docIdOf);
