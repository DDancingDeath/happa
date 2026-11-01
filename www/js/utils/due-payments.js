/**
 * @fileoverview Due (udhaar) payments recorded after a bill was saved (#95, #98, #104, #107).
 *
 * One record per payment lives on the bill (`payments[]`, written in a
 * transaction with `payment.*` and `dueAmount`). When an open cash session
 * exists, the same payment is also added to the session's `duePayments` as a
 * drawer leg with the same `id`. Totals are computed from both places and
 * de-duplicated by that id, so:
 *   - a payment on an old bill that is no longer loaded still counts (session leg),
 *   - a payment recorded while no session was open still counts (bill entry),
 *   - nothing is counted twice.
 * Pure functions only (unit-tested).
 * @module utils/due-payments
 */

import { isActiveBill, isOpeningRecord, outstandingDue, readPayment, round2 } from './money.js';
import { parseAnyBillDate } from './dates.js';
import { hasPaise, typedAmount } from './calc/billing.js';

/** Bill type → collection key. */
export const BILL_COLLECTIONS = { purchase: 'purchases', retail: 'retailSales', wholesale: 'wholesaleSales' };

/**
 * Party name for comparing: Unicode-normalised, trimmed, inner spaces
 * collapsed, case-insensitive (works for Hindi names too).
 * @param {*} name
 * @returns {string}
 */
export function normalizeParty(name) {
    return String(name ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** True when two party names are the same person (exact after normalising; '' never matches). */
export function sameParty(a, b) {
    const x = normalizeParty(a);
    return x !== '' && x === normalizeParty(b);
}

/** Party name stored on a bill (customer for sales, supplier for purchases). */
export const billParty = (bill) => String(bill?.customerName || bill?.supplierName || '');

/** Money direction of a due payment on a bill of this type. */
export const directionFor = (billType) => (billType === 'purchase' ? 'paid' : 'received');

const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

/**
 * Cash / online / written-off parts of one `payments[]` entry on a bill.
 * Entries written before #107 only carry `amount`; they were always added to
 * `payment.cash`, so they count as cash.
 * @param {Object} entry
 * @returns {{cash: number, online: number, writeOff: number}}
 */
export function entryParts(entry) {
    if (!entry || typeof entry !== 'object') return { cash: 0, online: 0, writeOff: 0 };
    if (entry.kind === 'writeOff') return { cash: 0, online: 0, writeOff: round2(num(entry.amount)) };
    const split = entry.cash !== undefined || entry.online !== undefined;
    return {
        cash: round2(split ? num(entry.cash) : num(entry.amount)),
        online: round2(split ? num(entry.online) : 0),
        writeOff: 0
    };
}

/**
 * Cash / online parts of a cash-session `duePayments` leg. Legs written by the
 * Cash tab before #98 carry `amount` + `method` ('cash' only in practice).
 * @param {Object} leg
 * @returns {{cash: number, online: number}}
 */
export function legParts(leg) {
    if (!leg || typeof leg !== 'object') return { cash: 0, online: 0 };
    if (leg.cash !== undefined || leg.online !== undefined) {
        return { cash: round2(num(leg.cash)), online: round2(num(leg.online)) };
    }
    const amount = round2(num(leg.amount));
    return leg.method === 'cash' ? { cash: amount, online: 0 } : { cash: 0, online: amount };
}

/** Time (ms) of a bill payment entry or session leg; NaN when unknown. */
export function entryTime(entry) {
    if (!entry) return NaN;
    if (typeof entry.at === 'number') return entry.at;
    const d = parseAnyBillDate(entry.date ?? entry.timestamp);
    return d ? d.getTime() : NaN;
}

/**
 * What was paid when the bill was saved: the bill's payment minus every later
 * due payment recorded on it. The drawer and Today count the later payments on
 * the day they were made, not on the bill's day.
 * @param {Object} bill
 * @returns {{cash: number, online: number}}
 */
export function saleTimePayment(bill) {
    if (!isActiveBill(bill)) return { cash: 0, online: 0 };
    const pay = readPayment(bill);
    let cash = 0;
    let online = 0;
    (Array.isArray(bill?.payments) ? bill.payments : []).forEach(e => {
        const p = entryParts(e);
        cash += p.cash;
        online += p.online;
    });
    return {
        cash: Math.max(0, round2(pay.cash - cash)),
        online: Math.max(0, round2(pay.online - online))
    };
}

/**
 * A bill's money in parts that add up to its total (T18, bill details): paid at
 * save (BILL-AT-SAVE), paid later (due payments recorded on the bill), written off
 * later, and the due still open (BILL-DUE).
 * @param {Object} bill
 * @returns {{atSave: {cash: number, online: number}, later: {cash: number, online: number, total: number}, writtenOff: number, due: number}}
 */
export function paymentBreakdown(bill) {
    const atSave = saleTimePayment(bill);
    const later = { cash: 0, online: 0, total: 0 };
    let writtenOff = 0;
    if (isActiveBill(bill)) {
        (Array.isArray(bill?.payments) ? bill.payments : []).forEach(e => {
            const p = entryParts(e);
            later.cash += p.cash;
            later.online += p.online;
            writtenOff += p.writeOff;
        });
    }
    later.cash = round2(later.cash);
    later.online = round2(later.online);
    later.total = round2(later.cash + later.online);
    return { atSave, later, writtenOff: round2(writtenOff), due: outstandingDue(bill) };
}
/**
 * Every due payment made in [from, to), from bill entries and session legs,
 * de-duplicated by payment id.
 * @param {Object} args
 * @param {{retail?: Object[], wholesale?: Object[], purchase?: Object[]}} args.bills
 * @param {Object[]} [args.sessions] Cash sessions whose `duePayments` to include
 * @param {number} args.from Inclusive start (ms)
 * @param {number} args.to Exclusive end (ms)
 * @returns {Array<{id: string, direction: 'received'|'paid', cash: number, online: number, writeOff: number, at: number, party: string, billId: ?string, billNo: string}>}
 */
export function dueEvents({ bills = {}, sessions = [], from, to }) {
    const inRange = (t) => Number.isFinite(t) && t >= from && t < to;
    const seen = new Set();
    const events = [];

    Object.entries(BILL_COLLECTIONS).forEach(([billType]) => {
        (bills[billType] || []).forEach(bill => {
            if (!isActiveBill(bill)) return;
            const list = Array.isArray(bill?.payments) ? bill.payments : [];
            // Money paid on an old-app due is real money on its day; writing it off is not a bad debt here.
            const opening = isOpeningRecord(bill);
            list.forEach((entry, i) => {
                const at = entryTime(entry);
                if (!inRange(at)) return;
                const id = entry.id ? String(entry.id) : `${billType}:${bill.id}:${i}`;
                if (seen.has(id)) return;
                seen.add(id);
                events.push({
                    id, direction: directionFor(billType), ...entryParts(entry), ...(opening ? { writeOff: 0 } : {}), at,
                    party: bill.customerName || bill.supplierName || '', billId: bill.id != null ? String(bill.id) : null,
                    billNo: String(bill.billNumber || bill.billNo || '')
                });
            });
        });
    });

    (sessions || []).forEach(session => {
        (Array.isArray(session?.duePayments) ? session.duePayments : []).forEach((leg, i) => {
            const at = entryTime(leg);
            // Legacy legs without a parseable time belong to their session's day.
            if (Number.isFinite(at) ? !inRange(at) : false) return;
            const id = leg.id ? String(leg.id) : `session:${session.id}:${i}`;
            if (seen.has(id)) return;
            seen.add(id);
            events.push({
                id, direction: leg.type === 'paid' ? 'paid' : 'received', ...legParts(leg), writeOff: 0,
                at, party: leg.customer || '', billId: leg.billId != null ? String(leg.billId) : null,
                billNo: String(leg.billNumber || '')
            });
        });
    });
    return events;
}

/**
 * Totals of due events by direction and method.
 * @param {ReturnType<typeof dueEvents>} events
 */
export function sumDueEvents(events) {
    const t = { receivedCash: 0, receivedOnline: 0, paidCash: 0, paidOnline: 0, writtenOffReceivable: 0, writtenOffPayable: 0 };
    (events || []).forEach(e => {
        if (e.direction === 'paid') {
            t.paidCash += e.cash;
            t.paidOnline += e.online;
            t.writtenOffPayable += e.writeOff;
        } else {
            t.receivedCash += e.cash;
            t.receivedOnline += e.online;
            t.writtenOffReceivable += e.writeOff;
        }
    });
    Object.keys(t).forEach(k => { t[k] = round2(t[k]); });
    return t;
}

/**
 * The bill fields a due payment writes, from the bill as just read on the server
 * (outstanding.js applyPaymentTransaction and "Complete all due"): cash and online
 * go up by the payment, the due goes down by it (to 0 under `tolerance`), the entry
 * is appended to `payments[]` and `paidAt` is its time (#163, rules: = entry.at).
 * `dueAmount` is written only when the bill has it. Refused when the payment is
 * more than the due + tolerance.
 * @param {Object} fresh - bill data
 * @param {{cash: number, online: number}} parts - already in paise
 * @param {Object} entry - the full payments[] entry (with `at`)
 * @param {number} [tolerance=0.01]
 * @returns {{ok: true, update: Object, due: number}|{ok: false, error: 'exceeds-due', due: number}}
 */
export function duePaymentUpdate(fresh, { cash, online }, entry, tolerance = 0.01) {
    const pay = readPayment(fresh);
    const total = round2(cash + online);
    if (total > pay.due + tolerance) return { ok: false, error: 'exceeds-due', due: pay.due };
    const newCash = round2(pay.cash + cash);
    const newOnline = round2(pay.online + online);
    let newDue = round2(pay.due - total);
    if (newDue < tolerance) newDue = 0;
    const update = {
        payment: {
            ...(fresh.payment && typeof fresh.payment === 'object' ? fresh.payment : {}),
            online: newOnline,
            cash: newCash,
            due: newDue,
            total: round2(newOnline + newCash)
        },
        payments: [...(Array.isArray(fresh.payments) ? fresh.payments : []), entry],
        paidAt: entry.at
    };
    if (Object.prototype.hasOwnProperty.call(fresh, 'dueAmount')) update.dueAmount = newDue;
    return { ok: true, update, due: newDue };
}

/**
 * DUE-ALL: what "Complete all due" settles for one party: every open bill whose
 * party is `partyKey` (by `keyOf`, e.g. aging.js normalizePartyName) with its
 * BILL-DUE, oldest first, and the total.
 * @param {Object[]} bills
 * @param {string} partyKey
 * @param {function(string): string} keyOf
 * @returns {{bills: Array<{bill: Object, due: number}>, total: number}}
 */
export function partyDues(bills, partyKey, keyOf) {
    const list = (bills || [])
        .filter(b => partyKey && keyOf(b?.customerName) === partyKey)
        .map(bill => ({ bill, due: outstandingDue(bill) }))
        .filter(x => x.due > 0)
        .sort((a, b) => (Number(a.bill.timestamp) || 0) - (Number(b.bill.timestamp) || 0));
    return { bills: list, total: round2(list.reduce((sum, x) => sum + x.due, 0)) };
}

/**
 * DUE-ALL: one bill's part of "Complete all due": its whole BILL-DUE (paise) received
 * in cash or online, as a payments[] entry with that amount (duePaymentUpdate).
 * Null when nothing is due any more (paid or cleared meanwhile).
 * @param {Object} fresh - bill data
 * @param {'cash'|'online'} method
 * @param {Object} entry - entry fields without the amounts (id, at, …)
 * @param {number} [tolerance=0.01]
 * @param {number} [confirmed=Infinity] - the due the user confirmed; more now = `changed`
 * @returns {?{amount: number, update?: Object, changed?: true}}
 */
export function settleDueUpdate(fresh, method, entry, tolerance = 0.01, confirmed = Infinity) {
    const due = round2(readPayment(fresh).due);
    if (!(due > 0) || fresh?.cleared) return null;
    if (due > confirmed + tolerance) return { amount: due, changed: true };
    const parts = method === 'online' ? { cash: 0, online: due } : { cash: due, online: 0 };
    const { update } = duePaymentUpdate(fresh, parts, { ...entry, amount: due, ...parts }, tolerance);
    return { amount: due, update };
}

/**
 * DUE-FIFO: one part of a party payment as saved. A part that pays its bill's whole
 * due keeps that due's paise (an old due saved before #129); any other part is whole
 * rupees (ROUNDING.payment), as "Record payment" saves it (DUE-CHECK).
 * @param {number} part
 * @param {number} due
 * @param {number} [tolerance=0.01]
 * @returns {number}
 */
export function partAsSaved(part, due, tolerance = 0.01) {
    const p = round2(part);
    const d = round2(due);
    if (hasPaise(d) && Math.abs(p - d) <= tolerance) return d;
    return typedAmount(p);
}

/**
 * DUE-FIFO: one payment from a party spread over their open bills, oldest first
 * (#152): the amount (whole rupees) fills each bill up to its due until it runs
 * out, so only the last bill reached can be part-paid, with the whole rupees left
 * (never above its due). What is not allocated is `left`.
 * @param {number[]} dues - BILL-DUE per bill, oldest first
 * @param {number} amount
 * @returns {{amounts: number[], allocated: number, left: number}}
 */
export function allocateOldestFirst(dues, amount) {
    let rest = typedAmount(Math.max(0, Number(amount) || 0));
    const amounts = (dues || []).map(d => {
        const due = round2(Math.max(0, Number(d) || 0));
        // Never more than was received: a part-paid bill gets the whole rupees left.
        const part = rest >= due ? due : Math.min(Math.floor(rest + 0.001), Math.floor(due));
        rest = round2(rest - part);
        return part;
    });
    return { amounts, allocated: round2(amounts.reduce((s, a) => s + a, 0)), left: rest };
}

/**
 * DUE-FIFO: checks a (possibly hand-edited) split of one payment: every part is
 * a number from 0 to that bill's due (+ tolerance), saved as partAsSaved, and at
 * least one is above 0.
 * @param {number[]} dues
 * @param {Array<number|string>} parts - per bill, same order
 * @param {number} [tolerance=0.01]
 * @returns {{ok: true, amounts: number[], total: number}|{ok: false, error: 'invalid'|'exceeds-due'|'empty', index?: number}}
 */
export function checkAllocation(dues, parts, tolerance = 0.01) {
    const amounts = [];
    for (let i = 0; i < dues.length; i++) {
        const raw = parts[i];
        const n = raw === '' || raw === null || raw === undefined ? 0 : Number(raw);
        if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'invalid', index: i };
        const a = partAsSaved(n, dues[i], tolerance);
        if (a > round2(dues[i]) + tolerance) return { ok: false, error: 'exceeds-due', index: i };
        amounts.push(a);
    }
    const total = round2(amounts.reduce((s, a) => s + a, 0));
    if (!(total > 0)) return { ok: false, error: 'empty' };
    return { ok: true, amounts, total };
}
