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
/** OPENING: a due carried from the old app (`openingBalance` object). A balance only, never activity. */
export const isOpening = (bill) => !!bill && typeof bill.openingBalance === 'object' && bill.openingBalance !== null;
/** Bills that are activity in a period (opening records left out). */
const activity = (list) => (list || []).filter(b => !isOpening(b));
const dated = (list, range) => (list || []).filter(r => inRange(timeOf(r.date), range));
const datedBills = (list, range) => dated(activity(list), range);

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
    const out = { receivedCash: 0, receivedOnline: 0, paidCash: 0, paidOnline: 0, writtenOffReceivable: 0, receivedCount: 0, paidCount: 0 };
    const add = (dir, cash, online) => {
        if (dir === 'paid') { out.paidCash += cash; out.paidOnline += online; } else { out.receivedCash += cash; out.receivedOnline += online; }
        if (Math.abs(cash + online) >= 0.005) out[dir === 'paid' ? 'paidCount' : 'receivedCount'] += 1;
    };
    ['purchase', 'retail', 'wholesale'].forEach(type => (bills[type] || []).forEach(bill => {
        (bill.payments || []).forEach((p, i) => {
            const [x] = laterPayments({ payments: [p] });
            if (!inRange(x.at, range)) return;
            const id = p.id ? String(p.id) : `${type}:${bill.id}:${i}`;
            if (seen.has(id)) return;
            seen.add(id);
            add(type === 'purchase' ? 'paid' : 'received', x.cash, x.online);
            if (type !== 'purchase' && !isOpening(bill)) out.writtenOffReceivable += x.writeOff;
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
/** EXP-KIND: 'personal' only when tagged personal (`category`, else `type` on an expense with no category; any case); anything else (incl. untagged) is business (owner decision #36). */
const isPersonal = (e) => String(e.category || e.type || '').trim().toLowerCase() === 'personal';
export const isPersonalExpenseOracle = isPersonal;

// ---------------------------------------------------------------- Today (T*)

/** T1–T16: every number on Today for the local day containing `nowMs`. */
export function today(data, nowMs, session = null) {
    const range = dayRange(nowMs);
    const purchases = datedBills(data.purchases, range);
    const sales = [...datedBills(data.wholesaleSales, range), ...datedBills(data.retailSales, range)];
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

/** T17: the day's bill lines by item name (lines, kg, value, average rate), highest value first. */
export function todayItems(data, nowMs) {
    const range = dayRange(nowMs);
    const group = (bills) => {
        const rows = new Map();
        bills.forEach(b => (b.items || []).forEach(l => {
            const name = l.item || l.name || 'Unknown';
            const row = rows.get(name) || { name, lines: 0, kg: 0, value: 0 };
            row.lines += 1;
            row.kg += n(l.qty ?? l.quantity);
            row.value += n(l.total ?? l.amount);
            rows.set(name, row);
        }));
        return [...rows.values()].sort((a, b) => b.value - a.value)
            .map(r => ({ name: r.name, lines: r.lines, kg: r2(r.kg), value: r2(r.value), avgRate: r.kg > 0 ? r2(r.value / r.kg) : null }));
    };
    return {
        purchases: group(datedBills(data.purchases, range)),
        sales: group([...datedBills(data.wholesaleSales, range), ...datedBills(data.retailSales, range)])
    };
}

// ---------------------------------------------------------------- Labour (T-LAB-*)

/**
 * T-LAB-1 / T-LAB-2 / T-LAB-3 for the local day containing `nowMs`: labour deducted
 * on the day's purchases, and labour to pay = ⌈kg ÷ package kg⌉ × rate (whole
 * paise integers, so the rounding up does not depend on float division).
 */
export function labourDay(data, nowMs, { laborRate = 6, labourPackageKg = 35 } = {}) {
    const purchases = datedBills(data.purchases, dayRange(nowMs));
    const deducted = purchases.map(labourOf);
    const kg = r2(sum(purchases, b => sum(b.items || [], i => n(i.qty ?? i.quantity))));
    const kgP = Math.round(kg * 100);
    const pkP = Math.round(labourPackageKg * 100);
    const packages = kgP > 0 ? Math.floor((kgP + pkP - 1) / pkP) : 0;
    const toPay = r2(packages * laborRate);
    const ded = r2(sum(deducted, x => x));
    return {
        T_LAB_1_deducted: ded, T_LAB_1_bills: deducted.filter(x => x > 0).length,
        T_LAB_2_kg: kg, T_LAB_2_packages: packages, T_LAB_2_toPay: toPay,
        T_LAB_3_difference: r2(toPay - ded)
    };
}

// ---------------------------------------------------------------- Stock (S*) and cost of goods sold

/**
 * S1–S4 + COGS: weighted-average cost, replayed in time order.
 * Lines resolve to a catalogue item by itemId, else by English/Hindi name
 * (trimmed, case-insensitive). Purchases add at the line rate; sales (wholesale
 * and retail, owner decision #33) remove at
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
    activity(data.purchases).forEach(b => (b.items || []).forEach(l => ev.push({ t: eventTimeOf(b), o: 0, k: keyOf(l), op: 'buy', q: qtyOf(l), rate: n(l.rate) })));
    activity(data.wholesaleSales).forEach(b => (b.items || []).forEach(l => ev.push({ t: eventTimeOf(b), o: 1, k: keyOf(l), op: 'sell', q: qtyOf(l), line: `wholesale|${b.id}|${keyOf(l)}` })));
    activity(data.retailSales).forEach(b => (b.items || []).forEach(l => ev.push({ t: eventTimeOf(b), o: 2, k: keyOf(l), op: 'sell', q: qtyOf(l), line: `retail|${b.id}|${keyOf(l)}` })));
    (data.stockAdjustments || []).forEach(a => ev.push({ t: eventTimeOf(a), o: 3, k: keyOf({ itemId: a.itemId, name: a.itemName }), op: 'adj-' + a.adjustType, q: n(a.quantity), rate: n(a.rate) }));
    ev.sort((a, b) => a.t - b.t || a.o - b.o);

    const st = {};
    const totals = { opening: 0, purchases: 0, cogs: 0, adjustments: 0, closing: 0 };
    const cogsByItem = {};
    const cogsByLine = {};
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
            else if (e.op === 'sell') {
                totals.cogs -= delta;
                cogsByItem[e.k] = (cogsByItem[e.k] || 0) - delta;
                cogsByLine[e.line] = (cogsByLine[e.line] || 0) - delta;
            }
            else totals.adjustments += delta;
        }
    }
    if (!openingTaken) totals.opening = value();
    totals.closing = value();
    const perItem = {};
    Object.entries(st).forEach(([k, s]) => { perItem[k] = { qty: s.q, rate: s.q > 0 ? s.v / s.q : 0, value: s.q > 0 ? s.v : 0 }; });
    Object.keys(totals).forEach(k => { totals[k] = r2(totals[k]); });
    return { ...totals, perItem, cogsByItem, cogsByLine };
}

// ---------------------------------------------------------------- Finance (F*), new definitions from #215

/**
 * F1–F11 for [from, to). Personal expenses are not part of business profit (owner decision #36).
 * Bad debts = receivable dues written off in the period (by write-off date, #215).
 */
export function finance(data, range = [-Infinity, Infinity]) {
    const inR = (b) => inRange(eventTimeOf(b), range);
    const allSales = [...(data.wholesaleSales || []), ...(data.retailSales || [])];
    const sales = activity(allSales).filter(inR);
    const purchases = activity(data.purchases).filter(inR);
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
    const purchases = datedBills(data.purchases, range);
    const sales = [...datedBills(data.retailSales, range), ...datedBills(data.wholesaleSales, range)];
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
    const sales = [...datedBills(data.wholesaleSales, range), ...datedBills(data.retailSales, range)];
    const purchases = datedBills(data.purchases, range);
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

// ---------------------------------------------------------------- Money (M*) and Insights (I*) — redesign phase 1

const lineTotal = (l) => (has(l.total) ? n(l.total) : n(l.qty ?? l.quantity) * n(l.rate));
const partyKey = (name) => String(name ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * M1–M16 and I1/I3/I4 for [from, to) (BILL-TIME, OPENING left out, BILL-COUNT).
 * M2/M3/M6 follow F2/F4; M7 = labour; M12/M13 split cash/online (expenses are cash).
 */
export function metrics(data, range = [-Infinity, Infinity]) {
    const inR = (b) => inRange(eventTimeOf(b), range);
    const retail = activity(data.retailSales).filter(inR);
    const wholesale = activity(data.wholesaleSales).filter(inR);
    const sales = [...wholesale, ...retail];
    const purchases = activity(data.purchases).filter(inR);
    const f = finance(data, range);
    const stock = stockReplay(data, range);
    const exp = (data.expenses || []).filter(e => inRange(timeOf(e.date), range));
    const expenseTotal = sum(exp, expenseAmount);
    const dues = duePaymentsIn({ purchase: data.purchases, retail: data.retailSales, wholesale: data.wholesaleSales }, [], range);
    const at = (bills) => bills.reduce((a, b) => { const p = paidAtSave(b); a.cash += p.cash; a.online += p.online; return a; }, { cash: 0, online: 0 });
    const sold = at(sales);
    const bought = at(purchases);

    // I1: sale line totals per item (+ one '' row for bill-level differences), COGS per item.
    const items = data.items || [];
    const keyOf = (line) => {
        if (line.itemId && items.some(i => i.id === line.itemId)) return line.itemId;
        const name = String(line.name ?? line.itemName ?? '').trim().toLowerCase();
        const hit = items.find(i => String(i.name).trim().toLowerCase() === name || String(i.hindiName || '').trim().toLowerCase() === name);
        return hit ? hit.id : name;
    };
    const itemSales = {};
    const byType = { retail: {}, wholesale: {} };
    const addSales = (b, type) => {
        let lines = 0;
        const put = (k, v) => { itemSales[k] = (itemSales[k] || 0) + v; byType[type][k] = (byType[type][k] || 0) + v; };
        (b.items || []).forEach(l => { put(keyOf(l), lineTotal(l)); lines += lineTotal(l); });
        const rest = billValue(b) - lines;
        if (Math.abs(rest) >= 0.005) put('', rest);
    };
    wholesale.forEach(b => addSales(b, 'wholesale'));
    retail.forEach(b => addSales(b, 'retail'));
    [itemSales, byType.retail, byType.wholesale].forEach(o => Object.keys(o).forEach(k => { o[k] = r2(o[k]); }));
    const itemCogs = {};
    Object.entries(stock.cogsByItem).forEach(([k, v]) => { itemCogs[k] = r2(v); });

    const byParty = (bills) => {
        const out = {};
        bills.forEach(b => { const k = partyKey(b.customerName ?? b.supplierName); out[k] = r2((out[k] || 0) + billValue(b)); });
        return out;
    };
    const salesTotal = sum(sales, billValue);
    return {
        M1_sales: r2(salesTotal), M1_saleCount: sales.length,
        M1_retail: r2(sum(retail, billValue)), M1_retailCount: retail.length,
        M1_wholesale: r2(sum(wholesale, billValue)), M1_wholesaleCount: wholesale.length,
        M2_cogs: stock.cogs,
        M3_gross: r2(salesTotal - stock.cogs),
        M4_businessExpenses: f.F3_businessExpenses,
        M5_badDebts: f.F4_badDebts,
        M6_profit: f.F4_profit,
        M7_labour: r2(sum(purchases, labourOf)),
        M8_personalExpenses: f.F5_personalExpenses,
        M9_withdrawals: f.F11_withdrawals,
        M10_kept: r2(f.F4_profit - f.F5_personalExpenses - f.F11_withdrawals),
        M12_inCash: r2(sold.cash + dues.receivedCash), M12_inOnline: r2(sold.online + dues.receivedOnline),
        M13_outCash: r2(bought.cash + dues.paidCash + expenseTotal), M13_outOnline: r2(bought.online + dues.paidOnline),
        M14_net: f.F7_cashFlow,
        M16_purchases: r2(sum(purchases, billValue)), M16_purchaseCount: purchases.length,
        I1_itemSales: itemSales, I1_itemCogs: itemCogs, I2_itemRetail: byType.retail, I2_itemWholesale: byType.wholesale,
        I3_customers: byParty(sales), I4_suppliers: byParty(purchases)
    };
}

/**
 * I3 "Stopped coming": customers (PARTY) who bought in each of the same three
 * calendar months last year (the month before, this month, the month after) and
 * have no bill in the last `days` days. Unnamed customers are not parties.
 * @returns {string[]} party keys, sorted
 */
export function stoppedComing(data, nowMs, days = 60) {
    const now = new Date(nowMs);
    const want = [-1, 0, 1].map(k => monthOf(new Date(now.getFullYear() - 1, now.getMonth() + k, 1).getTime()));
    const by = {};
    activity([...(data.retailSales || []), ...(data.wholesaleSales || [])]).forEach(b => {
        const k = partyKey(b.customerName);
        const t = eventTimeOf(b);
        if (!k || !Number.isFinite(t)) return;
        const r = by[k] || (by[k] = { months: new Set(), last: -Infinity });
        r.months.add(monthOf(t));
        r.last = Math.max(r.last, t);
    });
    const cutoff = nowMs - days * 86400000;
    return Object.keys(by).filter(k => want.every(m => by[k].months.has(m)) && by[k].last < cutoff).sort();
}

/**
 * I7 low-profit items: catalogue items (not the '' bill-adjustment row) with sales of at
 * least `minSales` in the range and profit per ₹100 sold under `per100` (a loss included).
 * @returns {string[]} item keys, sorted
 */
export function lowProfitItems(data, range, { minSales = 5000, per100 = 3 } = {}) {
    const m = metrics(data, range);
    return Object.keys(m.I1_itemSales).filter(k => {
        const sales = m.I1_itemSales[k];
        if (!k || !(sales >= minSales)) return false;
        return ((sales - (m.I1_itemCogs[k] || 0)) / sales) * 100 < per100;
    }).sort();
}

/**
 * I8 sold below cost: sale lines (bill × item) whose value is below their cost of goods
 * sold by more than ₹0.50, per item: times, kg, ₹ lost.
 * @returns {Object<string, {times: number, qty: number, lost: number}>}
 */
export function belowCost(data, range) {
    const items = data.items || [];
    const keyOf = (line) => {
        if (line.itemId && items.some(i => i.id === line.itemId)) return line.itemId;
        const name = String(line.name ?? line.itemName ?? '').trim().toLowerCase();
        const hit = items.find(i => String(i.name).trim().toLowerCase() === name || String(i.hindiName || '').trim().toLowerCase() === name);
        return hit ? hit.id : name;
    };
    const cogs = stockReplay(data, range).cogsByLine;
    const lines = {};
    [['wholesale', data.wholesaleSales], ['retail', data.retailSales]].forEach(([type, list]) => activity(list)
        .filter(b => inRange(eventTimeOf(b), range))
        .forEach(b => (b.items || []).forEach(l => {
            const k = keyOf(l);
            if (!k) return;
            const x = lines[`${type}|${b.id}|${k}`] || (lines[`${type}|${b.id}|${k}`] = { k, sales: 0, qty: 0 });
            x.sales += lineTotal(l);
            x.qty += n(l.qty ?? l.quantity);
        })));
    const out = {};
    Object.entries(lines).forEach(([key, x]) => {
        const c = cogs[key] || 0;
        if (!(c - x.sales > 0.5)) return;
        const o = out[x.k] || (out[x.k] = { times: 0, qty: 0, lost: 0 });
        o.times += 1;
        o.qty = r2(o.qty + x.qty);
        o.lost = r2(o.lost + c - x.sales);
    });
    return out;
}

/**
 * I11 purchases by item: per item line value, labour share (the bill's labour × line
 * value ÷ the bill's line value), amount after labour and kg; a bill whose lines don't
 * add up to its total adds the difference to a '' row. Rows add up to M16.
 * @returns {Object<string, {lineValue: number, labour: number, amount: number, qty: number}>}
 */
export function purchaseItems(data, range) {
    const items = data.items || [];
    const keyOf = (line) => {
        if (line.itemId && items.some(i => i.id === line.itemId)) return line.itemId;
        const name = String(line.name ?? line.itemName ?? '').trim().toLowerCase();
        const hit = items.find(i => String(i.name).trim().toLowerCase() === name || String(i.hindiName || '').trim().toLowerCase() === name);
        return hit ? hit.id : name;
    };
    const out = {};
    const row = (k) => out[k] || (out[k] = { lineValue: 0, labour: 0, amount: 0, qty: 0 });
    activity(data.purchases).filter(b => inRange(eventTimeOf(b), range)).forEach(b => {
        const lines = b.items || [];
        const value = sum(lines, lineTotal);
        const labour = labourOf(b);
        let used = 0;
        lines.forEach(l => {
            const share = value > 0 ? labour * lineTotal(l) / value : 0;
            const r = row(keyOf(l));
            r.lineValue += lineTotal(l);
            r.labour += share;
            r.amount += lineTotal(l) - share;
            r.qty += n(l.qty ?? l.quantity);
            used += lineTotal(l) - share;
        });
        const rest = billValue(b) - used;
        if (Math.abs(rest) >= 0.005) row('').amount += rest;
    });
    Object.values(out).forEach(r => Object.keys(r).forEach(k => { r[k] = r2(r[k]); }));
    return out;
}

/**
 * C9 counted cash: closing balance of the last signed-out session with a real count
 * (not "not counted": `counted: false`, or closed by the app with no count), latest day
 * first, then latest sign-out. null when there is none.
 */
export function lastCountedCash(sessions) {
    const counted = (sessions || []).filter(s => s && s.signedOut === true && s.counted !== false
        && !(s.counted === undefined && s.autoSignedOut === true) && has(s.closingBalance));
    counted.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.signOutTime || '').localeCompare(String(a.signOutTime || '')));
    return counted.length ? { date: counted[0].date, amount: n(counted[0].closingBalance) } : null;
}

/**
 * M15 net worth: stock value (S4) + to receive (O4) + other accounts (owner-entered,
 * liabilities negative) + last counted drawer cash (C9) − to pay (O3).
 */
export function netWorth(data, { accounts = 0, drawer = 0 } = {}) {
    const d = dueTotals(data);
    return r2(finance(data).F6_stockValue + d.receivable + accounts + drawer - d.payable);
}

/**
 * I9 weekly kg: kg sold (retail + wholesale lines, any item key) in the last 8 weeks
 * (56 days up to now) ÷ 8, per item key (catalogue id, else the line name).
 */
export function weeklySoldKg(data, nowMs) {
    const items = data.items || [];
    const keyOf = (line) => {
        if (line.itemId && items.some(i => i.id === line.itemId)) return line.itemId;
        const name = String(line.name ?? line.itemName ?? '').trim().toLowerCase();
        const hit = items.find(i => String(i.name).trim().toLowerCase() === name || String(i.hindiName || '').trim().toLowerCase() === name);
        return hit ? hit.id : name;
    };
    const range = [nowMs - 56 * 86400000, nowMs + 1];
    const out = {};
    activity([...(data.retailSales || []), ...(data.wholesaleSales || [])]).filter(b => inRange(eventTimeOf(b), range))
        .forEach(b => (b.items || []).forEach(l => { const k = keyOf(l); out[k] = (out[k] || 0) + n(l.qty ?? l.quantity); }));
    Object.keys(out).forEach(k => { out[k] = r2(out[k] / 8); });
    return out;
}

/**
 * I10 overdue parties: parties with an open BILL-DUE on a bill more than `days`
 * local days old (bill day by its stock time), OPENING records included.
 * @returns {{parties: number, total: number, oldestDays: number}}
 */
export function overdue(bills, nowMs, days = 30) {
    const today = dayRange(nowMs)[0];
    const parties = new Set();
    let total = 0;
    let oldest = 0;
    (bills || []).forEach(b => {
        const due = openDue(b);
        const t = eventTimeOf(b);
        if (!(due > 0.005) || !Number.isFinite(t)) return;
        const age = Math.round((today - dayRange(t)[0]) / 86400000);
        if (age <= days) return;
        parties.add(partyKey(b.customerName));
        total += due;
        oldest = Math.max(oldest, age);
    });
    return { parties: parties.size, total: r2(total), oldestDays: oldest };
}

/** O3/O4 totals and bill counts over all bills (receivables include wholesale). */
export function dueTotals(data) {
    const allSales = [...(data.wholesaleSales || []), ...(data.retailSales || [])];
    return {
        payable: r2(sum(data.purchases || [], openDue)), payableCount: (data.purchases || []).filter(b => openDue(b) > 0).length,
        receivable: r2(sum(allSales, openDue)), receivableCount: allSales.filter(b => openDue(b) > 0).length
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
    const sales = [...datedBills(data.wholesaleSales, range), ...datedBills(data.retailSales, range)];
    const purchases = datedBills(data.purchases, range);
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

// ---------------------------------------------------------------- rate trends (RT*, PT*) — #65

const norm = (s) => String(s ?? '').trim().toLowerCase();
const pad = (x) => String(x).padStart(2, '0');
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** RT-WEEK: Monday (local IST date) of the week containing `ms`. */
export function weekOf(ms) {
    const d = new Date(ms);
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    return localDay(monday.getTime());
}

/** RT-MONTH. */
export const monthOf = (ms) => localDay(ms).slice(0, 7);

/** RT-LINE: catalogue item of a line, its kg and rate, or null when the line isn't used. */
function usedLine(line, items) {
    if (!line) return null;
    const kg = has(line.qty) ? n(line.qty) : n(line.quantity);
    if (!(kg > 0)) return null;
    const rate = n(line.rate) > 0 ? n(line.rate) : n(line.total) / kg;
    if (!(rate > 0)) return null;
    let item = items.find(i => i.id === line.itemId);
    if (!item) item = items.find(i => norm(i.name) === norm(line.name) || (i.hindiName && norm(i.hindiName) === norm(line.name)));
    return item ? { itemId: item.id, kg, rate } : null;
}

/**
 * RT1 / RT4 / PT1 per item and period: { [itemId]: { [period]: { [kind]: { kg, amount, avg, bills } } } }.
 * @param {{purchase?: Array, retail?: Array, wholesale?: Array}} sources
 * @param {(ms: number) => string} periodOf weekOf or monthOf
 */
export function rateBuckets(sources, items, periodOf) {
    const out = {};
    for (const kind of ['purchase', 'retail', 'wholesale']) {
        for (const bill of sources[kind] || []) {
            if (bill.deleted) continue;
            const t = eventTimeOf(bill);
            if (!Number.isFinite(t)) continue;
            const p = periodOf(t);
            const counted = new Set();
            for (const line of bill.items || []) {
                const u = usedLine(line, items);
                if (!u) continue;
                const s = (((out[u.itemId] ||= {})[p] ||= {})[kind] ||= { kg: 0, amount: 0, bills: 0 });
                s.kg += u.kg;
                s.amount += u.kg * u.rate;
                if (!counted.has(u.itemId)) { counted.add(u.itemId); s.bills += 1; }
            }
        }
    }
    for (const byP of Object.values(out)) {
        for (const byK of Object.values(byP)) {
            for (const s of Object.values(byK)) { s.avg = r2(s.amount / s.kg); s.kg = r2(s.kg); s.amount = r2(s.amount); }
        }
    }
    return out;
}

/**
 * RT2 for an item whose list only ever held one rate: changes [{at, old, new}].
 * Average of the day rates (rate in effect at the end of each local day) per period,
 * from the day of `fromMs` to the day of `toMs`.
 */
export function itemsPageRate(changes, current, fromMs, toMs, periodOf) {
    const sorted = [...changes].sort((a, b) => a.at - b.at);
    const rateAt = (ms) => {
        const before = sorted.filter(c => c.at < ms);
        if (before.length) return before[before.length - 1].new;
        return sorted.length ? sorted[0].old : current;
    };
    const sums = {};
    const first = new Date(fromMs);
    for (let d = new Date(first.getFullYear(), first.getMonth(), first.getDate()); d.getTime() <= toMs; d.setDate(d.getDate() + 1)) {
        const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
        const p = periodOf(d.getTime());
        (sums[p] ||= []).push(rateAt(end));
    }
    const out = {};
    for (const [p, list] of Object.entries(sums)) out[p] = r2(list.reduce((a, b) => a + b, 0) / list.length);
    return out;
}

/** PT3: kg and bills per type per local day of one item in a month ('YYYY-MM'). */
export function dailyKg(sources, items, itemId, month) {
    const out = {};
    for (const kind of ['purchase', 'retail', 'wholesale']) {
        for (const bill of sources[kind] || []) {
            if (bill.deleted) continue;
            const t = eventTimeOf(bill);
            if (!Number.isFinite(t) || monthOf(t) !== month) continue;
            const kg = (bill.items || []).map(l => usedLine(l, items)).filter(u => u && u.itemId === itemId).reduce((a, u) => a + u.kg, 0);
            if (!(kg > 0)) continue;
            const s = ((out[localDay(t)] ||= {})[kind] ||= { kg: 0, bills: 0 });
            s.kg = r2(s.kg + kg);
            s.bills += 1;
        }
    }
    return out;
}
