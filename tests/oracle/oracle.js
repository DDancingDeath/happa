/**
 * @fileoverview Independent "oracle" for the numbers the app shows (#216).
 *
 * Deliberately simple and deliberately separate: this file imports NOTHING
 * from www/ (no money.js, dates.js, stock-replay.js, due-payments.js). Each
 * function is a plain reading of a definition in docs/calculations.md; the
 * spec ID is in the function's comment / result keys. If the app and this
 * file disagree, one of them is wrong — read the spec, not the app, to decide
 * which.
 */

// ---------------------------------------------------------------- basics

const n = (v) => {
    const x = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(x) ? x : 0;
};
const has = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(typeof v === 'number' ? v : parseFloat(v));
export const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);

/**
 * Time (ms) of a bill/expense date in local (IST) time. Shapes seen in data:
 * epoch ms, 'YYYY-MM-DD', 'YYYY-MM-DDTHH:mm[:ss]', 'DD/MM/YYYY',
 * 'DD/MM/YYYY, h:mm:ss am'.
 */
export function timeOf(value) {
    if (typeof value === 'number') return value;
    const s = String(value ?? '').trim();
    if (/T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) return Date.parse(s);
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
    if (m) {
        let h = +(m[4] || 0);
        const ap = (m[7] || '').toLowerCase();
        if (ap === 'pm' && h !== 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        return new Date(+m[3], +m[2] - 1, +m[1], h, +(m[5] || 0), +(m[6] || 0)).getTime();
    }
    return NaN;
}

/** When a bill happened for stock purposes: numeric timestamp first, else its date. */
const eventTimeOf = (rec) => (typeof rec.timestamp === 'number' ? rec.timestamp : timeOf(rec.date));

/** [from, to) for the local calendar day containing `ms`. */
export function dayRange(ms) {
    const d = new Date(ms);
    return [new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()];
}

/** [from, to) for the local calendar month containing `ms`. */
export function monthRange(ms) {
    const d = new Date(ms);
    return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()];
}

const inRange = (t, [from, to]) => t >= from && t < to;
const dated = (list, range) => (list || []).filter(r => inRange(timeOf(r.date), range));

// ---------------------------------------------------------------- one bill

/** BILL-TOTAL: what the bill is worth. Purchases: net of labour (grandTotal). Sales: the sale total. */
export function billValue(bill) {
    for (const f of ['grandTotal', 'amountPayable', 'total', 'billTotal', 'saleTotal']) {
        if (has(bill[f])) return n(bill[f]);
    }
    return 0;
}

/** Labour deducted on a purchase. */
export const labourOf = (bill) => n(bill.laborCharges ?? bill.labour);

/** Later due payments recorded on the bill (cash/online/write-off parts). */
function laterPayments(bill) {
    return (bill.payments || []).map(p => {
        const at = p.at ?? timeOf(p.date);
        if (p.kind === 'writeOff') return { cash: 0, online: 0, writeOff: n(p.amount), at };
        if (p.cash !== undefined || p.online !== undefined) return { cash: n(p.cash), online: n(p.online), writeOff: 0, at };
        return { cash: n(p.amount), online: 0, writeOff: 0, at };
    });
}

/**
 * BILL-PAY: the bill's current payment state. Nested `payment.*` wins over the
 * top-level fields; very old bills only have `amountPaid` (cash).
 */
export function payState(bill) {
    const p = bill.payment || {};
    const pick = (...vs) => { for (const v of vs) if (has(v)) return n(v); return null; };
    const cash = pick(p.cash, bill.cashPayment, bill.amountPaid);
    const online = pick(p.online, bill.onlinePayment);
    let due = pick(p.due, bill.dueAmount, bill.due);
    if (due === null) due = (cash !== null || online !== null) ? Math.max(0, billValue(bill) - (cash || 0) - (online || 0)) : 0;
    return { cash: cash || 0, online: online || 0, due };
}

/** BILL-AT-SAVE: what was paid when the bill was saved (current payment minus later due payments). */
export function paidAtSave(bill) {
    const now = payState(bill);
    const later = laterPayments(bill);
    return {
        cash: Math.max(0, now.cash - sum(later, x => x.cash)),
        online: Math.max(0, now.online - sum(later, x => x.online))
    };
}

/** BILL-DUE: money still owed on the bill (0 when cleared/written off or overpaid). */
export function openDue(bill) {
    if (bill.cleared) return 0;
    return Math.max(0, payState(bill).due);
}

/** Due payments (cash/online) made in `range` on the given bills plus session legs, each id once. */
export function duePaymentsIn(bills, sessions, range) {
    const seen = new Set();
    const out = { receivedCash: 0, receivedOnline: 0, paidCash: 0, paidOnline: 0, writtenOffReceivable: 0 };
    const add = (dir, cash, online) => {
        if (dir === 'paid') { out.paidCash += cash; out.paidOnline += online; } else { out.receivedCash += cash; out.receivedOnline += online; }
    };
    ['purchase', 'retail', 'wholesale'].forEach(type => (bills[type] || []).forEach(bill => {
        (bill.payments || []).forEach((p, i) => {
            const [x] = laterPayments({ payments: [p] });
            if (!inRange(x.at, range)) return;
            const id = p.id ? String(p.id) : `${type}:${bill.id}:${i}`;
            if (seen.has(id)) return;
            seen.add(id);
            add(type === 'purchase' ? 'paid' : 'received', x.cash, x.online);
            if (type !== 'purchase') out.writtenOffReceivable += x.writeOff;
        });
    }));
    (sessions || []).forEach(s => (s.duePayments || []).forEach((leg, i) => {
        const at = leg.at ?? timeOf(leg.date ?? leg.timestamp);
        if (Number.isFinite(at) && !inRange(at, range)) return;
        const id = leg.id ? String(leg.id) : `session:${s.id}:${i}`;
        if (seen.has(id)) return;
        seen.add(id);
        const split = leg.cash !== undefined || leg.online !== undefined;
        const cash = split ? n(leg.cash) : leg.method === 'cash' ? n(leg.amount) : 0;
        const online = split ? n(leg.online) : leg.method === 'cash' ? 0 : n(leg.amount);
        add(leg.type === 'paid' ? 'paid' : 'received', cash, online);
    }));
    return out;
}

const expenseAmount = (e) => n(e.amount);
/** EXP-KIND: 'personal' only when tagged personal; anything else (incl. untagged / legacy `type`) is business (owner decision #36). */
const isPersonal = (e) => String(e.category || e.type || '').toLowerCase() === 'personal';

// ---------------------------------------------------------------- Today (T*)

/** T1–T16: every number on Today for the local day containing `nowMs`. */
export function today(data, nowMs, session = null) {
    const range = dayRange(nowMs);
    const purchases = dated(data.purchases, range);
    const sales = [...dated(data.wholesaleSales, range), ...dated(data.retailSales, range)];
    const expenses = dated(data.expenses, range);
    const business = expenses.filter(e => !isPersonal(e));
    const personal = expenses.filter(isPersonal);
    const atSale = sales.map(paidAtSave);
    const atPurchase = purchases.map(paidAtSave);
    const dues = duePaymentsIn({ purchase: data.purchases, retail: data.retailSales, wholesale: data.wholesaleSales },
        session ? [session] : [], range);
    const expTotal = sum(expenses, expenseAmount);
    const cashIn = sum(atSale, p => p.cash) + dues.receivedCash;
    const onlineIn = sum(atSale, p => p.online) + dues.receivedOnline;
    const cashOut = sum(atPurchase, p => p.cash) + expTotal + dues.paidCash;
    const onlineOut = sum(atPurchase, p => p.online) + dues.paidOnline;
    return {
        T1_purchases: r2(sum(purchases, billValue)), T1_purchaseCount: purchases.length,
        T2_sales: r2(sum(sales, billValue)), T2_saleCount: sales.length,
        T3_labour: r2(sum(purchases, labourOf)),
        T4_businessExpenses: r2(sum(business, expenseAmount)),
        T5_personalExpenses: r2(sum(personal, expenseAmount)),
        T6_cashIn: r2(cashIn), T7_onlineIn: r2(onlineIn),
        T8_cashOut: r2(cashOut), T9_onlineOut: r2(onlineOut),
        T10_totalIn: r2(cashIn + onlineIn), T11_totalOut: r2(cashOut + onlineOut),
        T12_net: r2(cashIn + onlineIn - cashOut - onlineOut),
        T13_dueReceived: r2(dues.receivedCash + dues.receivedOnline),
        T14_duePaid: r2(dues.paidCash + dues.paidOnline),
        T15_dueToReceive: r2(sum(sales, openDue)),
        T16_dueToPay: r2(sum(purchases, openDue))
    };
}

// ---------------------------------------------------------------- Stock (S*) and cost of goods sold

/**
 * S1–S4 + COGS: weighted-average cost, replayed in time order.
 * Lines resolve to a catalogue item by itemId, else by English/Hindi name
 * (trimmed, case-insensitive). Purchases add at the line rate; sales remove at
 * the average cost at that moment (that cost is the cost of goods sold);
 * adjustments: add (at their rate), remove (at average cost, never below 0),
 * set (to a quantity, at its rate or the average cost).
 * Assumes stock never goes below zero (AC8); below zero the app writes the
 * value off and this simple oracle does not try to follow it.
 * @returns {{opening, purchases, cogs, adjustments, closing, perItem}} values for `range`
 */
export function stockReplay(data, range = [-Infinity, Infinity]) {
    const items = data.items || [];
    const keyOf = (line) => {
        if (line.itemId && items.some(i => i.id === line.itemId)) return line.itemId;
        const name = String(line.name ?? line.itemName ?? '').trim().toLowerCase();
        const hit = items.find(i => String(i.name).trim().toLowerCase() === name || String(i.hindiName || '').trim().toLowerCase() === name);
        return hit ? hit.id : name;
    };
    const ev = [];
    const qtyOf = (l) => n(l.qty ?? l.quantity);
    (data.purchases || []).forEach(b => (b.items || []).forEach(l => ev.push({ t: eventTimeOf(b), o: 0, k: keyOf(l), op: 'buy', q: qtyOf(l), rate: n(l.rate) })));
    (data.wholesaleSales || []).forEach(b => (b.items || []).forEach(l => ev.push({ t: eventTimeOf(b), o: 1, k: keyOf(l), op: 'sell', q: qtyOf(l) })));
    (data.retailSales || []).forEach(b => (b.items || []).forEach(l => ev.push({ t: eventTimeOf(b), o: 2, k: keyOf(l), op: 'sell', q: qtyOf(l) })));
    (data.stockAdjustments || []).forEach(a => ev.push({ t: eventTimeOf(a), o: 3, k: keyOf({ itemId: a.itemId, name: a.itemName }), op: 'adj-' + a.adjustType, q: n(a.quantity), rate: n(a.rate) }));
    ev.sort((a, b) => a.t - b.t || a.o - b.o);

    const st = {};
    const totals = { opening: 0, purchases: 0, cogs: 0, adjustments: 0, closing: 0 };
    const value = () => Object.values(st).reduce((a, s) => a + (s.q > 0 ? s.v : 0), 0);
    let openingTaken = false;
    for (const e of ev) {
        if (e.t >= range[1]) break;
        if (!openingTaken && e.t >= range[0]) { totals.opening = value(); openingTaken = true; }
        const s = st[e.k] || (st[e.k] = { q: 0, v: 0 });
        const avg = s.q > 0 ? s.v / s.q : 0;
        const before = s.v;
        if (e.op === 'buy' || e.op === 'adj-add') {
            s.q += e.q;
            s.v += e.q * (e.rate || 0);
        } else if (e.op === 'sell') {
            s.q -= e.q;
            s.v -= e.q * avg;
        } else if (e.op === 'adj-remove') {
            const out = Math.min(e.q, Math.max(0, s.q));
            s.q -= out;
            s.v -= out * avg;
        } else if (e.op === 'adj-set') {
            s.q = e.q;
            s.v = e.q * (e.rate > 0 ? e.rate : avg);
        }
        if (s.q <= 0) s.v = 0;
        const delta = s.v - before;
        if (e.t >= range[0]) {
            if (e.op === 'buy') totals.purchases += delta;
            else if (e.op === 'sell') totals.cogs -= delta;
            else totals.adjustments += delta;
        }
    }
    if (!openingTaken) totals.opening = value();
    totals.closing = value();
    const perItem = {};
    Object.entries(st).forEach(([k, s]) => { perItem[k] = { qty: s.q, rate: s.q > 0 ? s.v / s.q : 0, value: s.q > 0 ? s.v : 0 }; });
    Object.keys(totals).forEach(k => { totals[k] = r2(totals[k]); });
    return { ...totals, perItem };
}

// ---------------------------------------------------------------- Finance (F*), new definitions from #215

/**
 * F1–F11 for [from, to). Personal expenses are not part of business profit (owner decision #36).
 * Bad debts = receivable dues written off in the period (by write-off date, #215).
 */
export function finance(data, range = [-Infinity, Infinity]) {
    const inR = (b) => inRange(eventTimeOf(b), range);
    const allSales = [...(data.wholesaleSales || []), ...(data.retailSales || [])];
    const sales = allSales.filter(inR);
    const purchases = (data.purchases || []).filter(inR);
    const exp = (data.expenses || []).filter(e => inRange(timeOf(e.date), range));
    const business = sum(exp.filter(e => !isPersonal(e)), expenseAmount);
    const personal = sum(exp.filter(isPersonal), expenseAmount);
    const stock = stockReplay(data, range);
    const dues = duePaymentsIn({ purchase: data.purchases, retail: data.retailSales, wholesale: data.wholesaleSales }, [], range);
    const atSave = (b) => { const p = paidAtSave(b); return p.cash + p.online; };
    const moneyIn = sum(sales, atSave) + dues.receivedCash + dues.receivedOnline;
    const moneyOut = sum(purchases, atSave) + dues.paidCash + dues.paidOnline + business + personal;
    const salesTotal = sum(sales, billValue);
    return {
        F1_sales: r2(salesTotal), F1_saleCount: sales.length,
        F2_cogs: stock.cogs,
        F3_businessExpenses: r2(business),
        F4_badDebts: r2(dues.writtenOffReceivable),
        F4_profit: r2(salesTotal - stock.cogs - business - dues.writtenOffReceivable),
        F5_personalExpenses: r2(personal),
        F6_stockValue: stock.closing,
        F7_cashFlow: r2(moneyIn - moneyOut), F7_moneyIn: r2(moneyIn), F7_moneyOut: r2(moneyOut),
        F8_check: { opening: stock.opening, purchases: stock.purchases, cogs: stock.cogs, adjustments: stock.adjustments, closing: stock.closing },
        F9_dueToReceive: r2(sum(allSales, openDue)),
        F10_dueToPay: r2(sum(data.purchases || [], openDue)),
        F11_withdrawals: r2(sum((data.withdrawals || []).filter(w => inRange(timeOf(w.date), range)), w => n(w.amount)))
    };
}

// ---------------------------------------------------------------- Reports overview (R*)

/** R1–R8 for [from, to). Dues are all-time (not the period). */
export function reports(data, range) {
    const purchases = dated(data.purchases, range);
    const sales = [...dated(data.retailSales, range), ...dated(data.wholesaleSales, range)];
    const pTotal = sum(purchases, billValue);
    const sTotal = sum(sales, billValue);
    return {
        R1_purchases: r2(pTotal), R1_purchaseCount: purchases.length,
        R2_sales: r2(sTotal), R2_saleCount: sales.length,
        R3_profit: finance(data, range).F4_profit,
        R4_cash: r2(sum([...purchases, ...sales], b => payState(b).cash)),
        R5_online: r2(sum([...purchases, ...sales], b => payState(b).online)),
        R6_dueToPay: r2(sum(data.purchases || [], openDue)),
        R7_dueToReceive: r2(sum([...(data.retailSales || []), ...(data.wholesaleSales || [])], openDue)),
        R8_labour: r2(sum(purchases, labourOf))
    };
}

// ---------------------------------------------------------------- Analytics (A*)

/** A1–A6: "This month" = calendar month up to now (#43 recommendation). */
export function analyticsMonth(data, nowMs) {
    const range = [monthRange(nowMs)[0], nowMs + 1];
    const sales = [...dated(data.wholesaleSales, range), ...dated(data.retailSales, range)];
    const purchases = dated(data.purchases, range);
    const exp = dated(data.expenses, range).filter(e => !isPersonal(e));
    const allSales = [...(data.wholesaleSales || []), ...(data.retailSales || [])];
    return {
        A1_revenue: r2(sum(sales, billValue)),
        A2_purchases: r2(sum(purchases, billValue)),
        A3_expenses: r2(sum(exp, expenseAmount)), A3_expenseCount: exp.length,
        A4_profit: finance(data, range).F4_profit,
        A5_payable: r2(sum(data.purchases || [], openDue)),
        A5_payableCount: (data.purchases || []).filter(b => openDue(b) > 0).length,
        A6_receivable: r2(sum(allSales, openDue)),
        A6_receivableCount: allSales.filter(b => openDue(b) > 0).length
    };
}

// ---------------------------------------------------------------- Outstanding (O*)

/** O1–O4: open dues per party and in total. Receivable = retail only until #130 decides. */
export function outstanding(data) {
    const byParty = (bills) => {
        const out = {};
        bills.forEach(b => { const d = openDue(b); if (d > 0) out[b.customerName] = r2((out[b.customerName] || 0) + d); });
        return out;
    };
    const payable = byParty(data.purchases || []);
    const receivable = byParty(data.retailSales || []);
    const total = (o) => r2(Object.values(o).reduce((a, b) => a + b, 0));
    return { O1_payableByParty: payable, O2_receivableByParty: receivable, O3_payableTotal: total(payable), O4_receivableTotal: total(receivable) };
}

// ---------------------------------------------------------------- Cash drawer (C*)

/** C1–C7 for a session's day: what the drawer should hold. Only cash counts. */
export function drawer(data, session) {
    const range = dayRange(timeOf(session.date));
    const sales = [...dated(data.wholesaleSales, range), ...dated(data.retailSales, range)];
    const purchases = dated(data.purchases, range);
    const exp = dated(data.expenses, range);
    const dues = duePaymentsIn({ purchase: data.purchases, retail: data.retailSales, wholesale: data.wholesaleSales }, [session], range);
    const c = {
        C1_cashSales: r2(sum(sales, b => paidAtSave(b).cash)),
        C2_cashPurchases: r2(sum(purchases, b => paidAtSave(b).cash)),
        C3_businessExpenses: r2(sum(exp.filter(e => !isPersonal(e)), expenseAmount)),
        C3_personalExpenses: r2(sum(exp.filter(isPersonal), expenseAmount)),
        C4_dueReceived: r2(dues.receivedCash),
        C5_duePaid: r2(dues.paidCash),
        C6_deposits: r2(sum(session.cashDeposits || [], d => n(d.amount)))
    };
    const opening = n(session.openingBalance);
    c.C7_expected = r2(opening + c.C1_cashSales + c.C4_dueReceived + c.C6_deposits
        - c.C2_cashPurchases - c.C5_duePaid - c.C3_businessExpenses - c.C3_personalExpenses);
    return c;
}
