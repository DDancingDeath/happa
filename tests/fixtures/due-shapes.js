/**
 * @fileoverview Bills in every due shape stored by the app and its predecessors (#126), and the
 * figures the screens show from them. Shared by the due-writer and due-backfill tests: a change
 * to how a due is written, migrated or backfilled must leave every one of these figures as the
 * app showed them before #126's cut-over (shownBefore: each bill with the due the old app read,
 * known from how it was generated, in payment.due).
 */
import fc from 'fast-check';
import { outstandingTotals } from '../../www/js/utils/business-metrics.js';
import { buildAging } from '../../www/js/utils/aging.js';
import { partyDue } from '../../www/js/utils/party-due.js';
import { partyLedger } from '../../www/js/utils/statements.js';
import { todaySummary } from '../../www/js/utils/calc/today.js';
import { drawerDay } from '../../www/js/utils/calc/cash.js';
import { normalizePartyName } from '../../www/js/utils/aging.js';
import { outstandingDue, readPayment } from '../../www/js/utils/money.js';

/** Fixed "today" of the generated bills (IST noon). */
export const TODAY = new Date('2026-11-03T12:00:00+05:30');
export const TODAY_ISO = '2026-11-03';
const DAY = 86400000;

/**
 * Due shapes:
 *  modern       payment {cash, online, due, total} + top-level cashPayment / onlinePayment / dueAmount (equal)
 *  drift        as modern, but dueAmount stale (an older app paid the due through payment.* only)
 *  paymentOnly  payment {cash, online, due, total}, no top-level copies (older wholesale)
 *  topOnly      cashPayment / onlinePayment / dueAmount, no payment object
 *  paymentNoDue payment {cash, online} without due, + dueAmount
 *  nullDue      payment.due null, + dueAmount
 *  stringDue    top-level amounts stored as strings, no payment object
 *  topDue       cashPayment + a top-level `due`
 *  amountPaid   only amountPaid (cash): the due is derived as total − paid
 *  dueOnly      only dueAmount, no paid amounts at all (an unpaid credit bill of an older app)
 *  topDueOnly   only a top-level `due`
 *  opening      opening record carried from the old app (tools/migrate)
 */
export const SHAPES = ['modern', 'drift', 'paymentOnly', 'topOnly', 'paymentNoDue', 'nullDue', 'stringDue', 'topDue', 'amountPaid', 'dueOnly', 'topDueOnly', 'opening'];
export const TYPES = ['purchase', 'retail', 'wholesale'];
const PARTIES = ['Ravi', ' ravi ', 'Sita Devi', 'Gupta Traders'];

/**
 * One stored bill.
 * @param {{id: string, type: string, shape: string, total: number, cash: number, online: number, party?: string,
 *   daysAgo?: number, cleared?: boolean, voided?: boolean, stale?: number}} s
 */
export function legacyBill({ id, type, shape, total, cash, online, party = 'Ravi', daysAgo = 0, cleared = false, voided = false, stale = 50 }) {
    const due = Math.max(0, Math.round((total - cash - online) * 100) / 100);
    const at = TODAY.getTime() - daysAgo * DAY;
    const b = { id, billNumber: `B-${id}`, customerName: party, type, date: new Date(at).toISOString(), timestamp: at, items: [] };
    if (type === 'purchase') Object.assign(b, { isPurchase: true, grandTotal: total, amountPayable: total, billTotal: total });
    else Object.assign(b, { total });
    if (type === 'wholesale') b.source = 'sales-tab';
    const payment = { cash, online, due, total };
    switch (shape) {
        case 'modern': Object.assign(b, { payment, cashPayment: cash, onlinePayment: online, dueAmount: due }); break;
        case 'drift': Object.assign(b, { payment, cashPayment: cash, onlinePayment: online, dueAmount: due + stale }); break;
        case 'paymentOnly': Object.assign(b, { payment }); break;
        case 'topOnly': Object.assign(b, { cashPayment: cash, onlinePayment: online, dueAmount: due }); break;
        case 'paymentNoDue': Object.assign(b, { payment: { cash, online }, dueAmount: due }); break;
        case 'nullDue': Object.assign(b, { payment: { cash, online, due: null }, dueAmount: due }); break;
        case 'stringDue': Object.assign(b, { cashPayment: String(cash), onlinePayment: String(online), dueAmount: String(due) }); break;
        case 'topDue': Object.assign(b, { cashPayment: cash + online, due }); break;
        case 'amountPaid': Object.assign(b, { amountPaid: cash + online }); break;
        case 'dueOnly': Object.assign(b, { dueAmount: due }); break;
        case 'topDueOnly': Object.assign(b, { due }); break;
        case 'opening':
            Object.assign(b, {
                total: 0, cashPayment: 0, onlinePayment: 0, dueAmount: due, payment: { cash: 0, online: 0, due, total: 0 },
                openingBalance: { migrated: true, kind: type === 'purchase' ? 'payable' : 'receivable', billType: type, amount: due, billTotal: total, paidBefore: cash + online }
            });
            if (type === 'purchase') Object.assign(b, { grandTotal: 0, amountPayable: 0, billTotal: 0 });
            break;
        default: throw new Error(`unknown shape ${shape}`);
    }
    if (cleared) Object.assign(b, { cleared: true, clearedAt: b.date, clearedBy: 'u0' });
    if (voided) Object.assign(b, { voided: true, voidReason: 'test' });
    // Every shape stands for the same bill: the app read this due on it before #126
    Object.defineProperty(b, 'oldDue', { value: due, enumerable: false });
    return b;
}

/**
 * The bill as the app showed it before #126: its generated due in payment.due (not worked out by
 * app code), no dueAmount. The current readers read on it every figure the old app read on `bill`.
 * @param {Object} bill - from legacyBill / billArb, before any copy
 * @returns {Object}
 */
export function shownBefore(bill) {
    if (typeof bill.oldDue !== 'number') throw new Error(`${bill.id}: no oldDue (copied?)`);
    const out = { ...bill, payment: { ...(bill.payment && typeof bill.payment === 'object' ? bill.payment : {}), due: bill.oldDue } };
    delete out.dueAmount;
    return out;
}

/** A generated bill of any shape (amounts whole rupees, now and then with paise as saved before #129). */
export const billArb = (id) => fc.record({
    type: fc.constantFrom(...TYPES),
    shape: fc.constantFrom(...SHAPES),
    total: fc.oneof(fc.integer({ min: 1, max: 20000 }), fc.integer({ min: 100, max: 2000000 }).map(p => p / 100)),
    paidPart: fc.double({ min: 0, max: 1, noNaN: true }),
    onlinePart: fc.double({ min: 0, max: 1, noNaN: true }),
    party: fc.constantFrom(...PARTIES),
    daysAgo: fc.constantFrom(0, 0, 1, 5, 40, 400),
    cleared: fc.constantFrom(false, false, false, true),
    voided: fc.constantFrom(false, false, false, false, true),
    stale: fc.integer({ min: 1, max: 500 })
}).map(r => {
    const paid = Math.round(r.total * r.paidPart);
    const online = Math.round(paid * r.onlinePart);
    return legacyBill({ id, ...r, cash: paid - online, online });
});

/** A list of generated bills with ids b0, b1, … */
export const billsArb = (min = 1, max = 12) => fc.integer({ min, max }).chain(n => fc.tuple(...Array.from({ length: n }, (_, i) => billArb(`b${i}`))));

/** Bills by type, as the screens take them. */
export const byType = (bills) => ({
    purchase: bills.filter(b => b.type === 'purchase'),
    retail: bills.filter(b => b.type === 'retail'),
    wholesale: bills.filter(b => b.type === 'wholesale')
});

/** Figures only: a bill object inside a result (a list row's `bill`) stands for its id. */
const figuresOnly = (v) => {
    if (Array.isArray(v)) return v.map(figuresOnly);
    if (v && typeof v === 'object') {
        if ('id' in v && ('items' in v || 'customerName' in v)) return `bill:${v.id}`;
        return Object.fromEntries(Object.keys(v).sort().map(k => [k, figuresOnly(v[k])]));
    }
    return v;
};

/**
 * Every due figure the screens show for these bills: Outstanding (O3/O4, aging per party),
 * the "Already owes ₹X" line, the party statements (ST3), Today (T*) and the cash day (C1–C6),
 * and each bill's BILL-PAY / BILL-DUE.
 */
export function screenFigures(bills) {
    const t = byType(bills);
    const src = { purchases: t.purchase, retailSales: t.retail, wholesaleSales: t.wholesale };
    const parties = [...new Set(bills.map(b => normalizePartyName(b.customerName)))].sort();
    return figuresOnly({
        perBill: bills.map(b => [b.id, readPayment(b), outstandingDue(b)]),
        outstanding: outstandingTotals(src),
        aging: ['purchase', 'retail', 'wholesale'].map(k => buildAging(t[k], { today: TODAY }).parties.map(p => [p.key, p.total, p.bills.length])),
        owes: parties.flatMap(name => TYPES.map(k => partyDue(t[k], name, { today: TODAY }))),
        statements: parties.flatMap(key => ['customer', 'supplier'].map(kind => partyLedger(src, key, kind))),
        today: todaySummary({ bills: t, today: TODAY }),
        cashDay: drawerDay({ date: TODAY_ISO, bills: t })
    });
}
