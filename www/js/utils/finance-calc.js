/**
 * @fileoverview Finance dashboard numbers (#215). Pure functions only.
 *
 *  - Profit on goods sold = sales − cost of goods sold − business expenses.
 *    Cost of goods sold (COGS) comes from the stock replay: each sale line is
 *    costed at the weighted-average cost of that item at the time of sale.
 *  - Stock value: opening / purchases / COGS / corrections / closing for the
 *    period, plus the value now. Check: opening + purchases − COGS +
 *    corrections = closing; a gap means goods were sold before their purchase
 *    was recorded (the replay can't cost them).
 *  - Cash flow = money received − money paid (bill-time payments, later due
 *    payments made in the period, all expenses).
 *  - Personal expenses are shown separately, not subtracted from business
 *    profit (owner decision #36). Untagged expenses count as business.
 *
 * With `detail: true` every number also comes with the records it is made of
 * (see finance-breakdown.js), from the same pass, so they always add up.
 * @module utils/finance-calc
 */

import {
    collectEvents, cloneState, createItemKeyResolver, replayEvents, replayWithValues,
    stateValue, eventTime
} from './stock-replay.js';
import { billTotal, outstandingDue, readLineItem, round2 } from './money.js';
import { saleTimePayment, dueEvents, sumDueEvents } from './due-payments.js';
import { parseAnyBillDate } from './dates.js';

/** Check-line gap (₹) above which the dashboard warns "numbers don't match". */
export const STOCK_CHECK_TOLERANCE = 100;

const inRange = (t, from, to) => Number.isFinite(t) && t >= from && t < to;
const num = (v) => parseFloat(v) || 0;

/** Expense / withdrawal time (ms) or null; undated records only count in "All". */
function recordTime(rec) {
    const d = parseAnyBillDate(rec?.date);
    return d ? d.getTime() : null;
}
function recordInRange(rec, from, to) {
    const t = recordTime(rec);
    return t !== null ? inRange(t, from, to) : from === -Infinity && to === Infinity;
}

/**
 * Bills whose stock-replay time falls in [from, to), so sales and their cost
 * always land in the same period. Undated bills only count in open-ended periods.
 */
export function billsInRange(bills, from, to) {
    return (bills || []).filter(b => inRange(eventTime(b), from, to));
}

/**
 * Which replay start can cost a period beginning at `from`:
 * the stock checkpoint when the period starts at/after it, otherwise an empty
 * state replayed from the beginning when the full history is loaded.
 * @param {{checkpoint: ?{state: Object, asOf: number}, fullHistory: boolean, from: number}} args
 * @returns {?{state: Object, from: number}} null when the period can't be costed yet
 */
export function pickReplayBase({ checkpoint, fullHistory, from }) {
    if (checkpoint && Number.isFinite(checkpoint.asOf) && from >= checkpoint.asOf) {
        return { state: checkpoint.state, from: checkpoint.asOf };
    }
    if (fullHistory) return { state: {}, from: -Infinity };
    return null;
}

/** Fields shared by every row that comes from a bill. */
export function billFields(bill, billType) {
    const t = eventTime(bill);
    return {
        t: t === Number.MAX_SAFE_INTEGER ? null : t,
        billId: bill?.id != null ? String(bill.id) : null,
        billType,
        billNo: String(bill?.billNumber || bill?.billNo || ''),
        party: String(bill?.customerName || bill?.customer || bill?.supplierName || '').trim()
    };
}

/**
 * Display names per item key: catalogue name (English + Hindi), else the
 * first line name seen for that key.
 */
function itemNamer(items, getKey) {
    const byId = new Map((items || []).map(i => [i.id, i]));
    const seen = new Map();
    return {
        note(key, rawName) {
            if (!seen.has(key) && rawName) seen.set(key, String(rawName).trim());
        },
        name(key) {
            const it = byId.get(key);
            return { item: it?.name || seen.get(key) || key, itemHi: it?.hindiName || it?.name || seen.get(key) || key };
        },
        getKey
    };
}

/** Per-item value rows of a running state. */
function stateRows(state, namer, prefix) {
    return Object.keys(state).filter(k => state[k].quantity > 0 && state[k].totalValue > 0).map(k => {
        const s = state[k];
        return {
            key: `${prefix}:${k}`, t: null, itemKey: k, ...namer.name(k),
            qty: s.quantity, rate: s.totalValue / s.quantity, amount: s.totalValue
        };
    });
}

/**
 * Stock value movement over [from, to) via the replay.
 * @param {Object} args
 * @param {{state: Object, from: number}} args.base running state after every event before base.from
 * @param {Object} args.sources {purchases, wholesaleSales, retailSales, stockAdjustments}
 * @param {Array} args.items catalogue
 * @param {number} [args.from=-Infinity]
 * @param {number} [args.to=Infinity]
 * @param {boolean} [args.detail=false] also return the rows behind every number
 * @returns {?{opening: number, purchases: number, cogs: number, adjustments: number,
 *   closing: number, now: number, gap: number, saleLines: number,
 *   uncosted: {qty: number, estimate: number, unknownCost: number},
 *   deficitRefilled: {qty: number, value: number}, detail?: Object}}
 *   uncosted = units sold in the period beyond the stock on hand (costed at ₹0 by the
 *   replay, so profit may be overstated by ~estimate); deficitRefilled = purchases in
 *   the period that refilled such an earlier shortfall (why the check line is off).
 *   null when base can't cover `from`
 */
export function stockMovement({ base, sources, items, from = -Infinity, to = Infinity, detail = false }) {
    if (!base || from < base.from) return null;
    const getKey = createItemKeyResolver(items);
    const namer = itemNamer(items, getKey);
    const state = cloneState(base.state);
    const events = collectEvents(sources, { from: base.from });
    // Last known cost per item (average on hand, else last purchase rate): estimates uncosted units.
    const lastCost = {};
    Object.keys(state).forEach(k => {
        if (state[k].quantity > 0 && state[k].totalValue > 0) lastCost[k] = state[k].totalValue / state[k].quantity;
    });
    const noteCost = (key, ev) => {
        const s = state[key];
        if (s && s.quantity > 0 && s.totalValue > 0) lastCost[key] = s.totalValue / s.quantity;
        else if (ev.kind === 'purchase' && num(ev.item.rate) > 0) lastCost[key] = num(ev.item.rate);
    };
    let i = 0;
    while (i < events.length && events[i].t < from) i++;
    replayWithValues(state, events.slice(0, i), getKey, (ev, key) => noteCost(key, ev));
    const opening = stateValue(state);
    const openingState = detail ? cloneState(state) : null;

    let j = i;
    while (j < events.length && events[j].t < to) j++;
    let purchases = 0;
    let cogs = 0;
    let adjustments = 0;
    let saleLines = 0;
    const rows = { cogs: [], purchases: [], adjustments: [], uncosted: [] };
    const perItem = {};
    const bump = (key, field, v) => {
        if (!perItem[key]) perItem[key] = { purchases: 0, cogs: 0, adjustments: 0 };
        perItem[key][field] += v;
    };
    // Units sold beyond what was on hand: the replay costs them at ₹0 (#215 review).
    const uncosted = { qty: 0, estimate: 0, unknownCost: 0, lines: [] };
    // Purchases in this period that refilled an earlier oversold position (the check-line gap's usual cause).
    const deficit = { qty: 0, value: 0 };
    let n = 0;
    replayWithValues(state, events.slice(i, j), getKey, (ev, key, delta, prevQty) => {
        n++;
        const idx = i + n - 1;
        if (ev.kind === 'purchase') {
            const qty = num(ev.item.qty || ev.item.quantity);
            const rate = num(ev.item.rate);
            purchases += qty * rate;
            if (prevQty < 0 && qty > 0) {
                const covered = Math.min(qty, -prevQty);
                deficit.qty += covered;
                deficit.value += covered * rate;
            }
            if (detail) {
                namer.note(key, ev.item.name);
                bump(key, 'purchases', qty * rate);
                rows.purchases.push({ key: `p${n}`, ...billFields(ev.bill, 'purchase'), itemKey: key, ...namer.name(key), qty, rate, amount: qty * rate });
            }
        } else if (ev.kind === 'sale') {
            const qty = num(ev.item.qty || ev.item.quantity);
            cogs -= delta;
            saleLines++;
            const short = qty - Math.max(0, prevQty);
            if (short > 1e-9) {
                uncosted.qty += short;
                uncosted.lines.push({ idx, ev, key, qty: short, fallback: lastCost[key] || 0 });
            }
            if (detail) {
                namer.note(key, ev.item.name);
                bump(key, 'cogs', -delta);
                rows.cogs.push({ key: `c${n}`, ...billFields(ev.bill, ev.source), itemKey: key, ...namer.name(key), qty, rate: qty > 0 ? -delta / qty : 0, amount: -delta });
            }
        } else {
            adjustments += delta;
            if (detail) {
                namer.note(key, ev.adj.itemName);
                bump(key, 'adjustments', delta);
                const t = eventTime(ev.adj);
                rows.adjustments.push({
                    key: `a${n}`, t: t === Number.MAX_SAFE_INTEGER ? null : t, itemKey: key, ...namer.name(key),
                    qty: num(ev.adj.quantity), note: String(ev.adj.adjustType || ''), amount: delta
                });
            }
        }
        noteCost(key, ev);
    });
    // Estimate each uncosted unit at the item's next purchase rate (what refilling it cost),
    // else the last known cost; 0 when neither is known.
    uncosted.lines.forEach(u => {
        let rate = 0;
        for (let k = u.idx + 1; k < events.length; k++) {
            const ev = events[k];
            if (ev.kind === 'purchase' && num(ev.item.rate) > 0 && getKey(ev.item) === u.key) {
                rate = num(ev.item.rate);
                break;
            }
        }
        if (!rate) rate = u.fallback;
        if (!rate) uncosted.unknownCost += u.qty;
        uncosted.estimate += u.qty * rate;
        if (detail) {
            namer.note(u.key, u.ev.item.name);
            rows.uncosted.push({ key: `u${u.idx}`, ...billFields(u.ev.bill, u.ev.source), itemKey: u.key, ...namer.name(u.key), qty: u.qty, rate, amount: u.qty * rate });
        }
    });
    const closing = stateValue(state);
    const closingState = detail ? cloneState(state) : null;
    replayEvents(state, events.slice(j), getKey);
    const now = stateValue(state);
    const result = {
        opening: round2(opening),
        purchases: round2(purchases),
        cogs: round2(cogs),
        adjustments: round2(adjustments),
        closing: round2(closing),
        now: round2(now),
        gap: round2(opening + purchases - cogs + adjustments - closing),
        saleLines,
        uncosted: { qty: round2(uncosted.qty), estimate: round2(uncosted.estimate), unknownCost: round2(uncosted.unknownCost) },
        deficitRefilled: { qty: round2(deficit.qty), value: round2(deficit.value) }
    };
    if (detail) {
        const val = (st, k) => (st[k] && st[k].quantity > 0 && st[k].totalValue > 0 ? st[k].totalValue : 0);
        const keys = new Set([...Object.keys(perItem), ...Object.keys(openingState), ...Object.keys(closingState)]);
        const gap = [];
        keys.forEach(k => {
            const p = perItem[k] || { purchases: 0, cogs: 0, adjustments: 0 };
            const g = val(openingState, k) + p.purchases - p.cogs + p.adjustments - val(closingState, k);
            if (Math.abs(g) >= 0.005) gap.push({ key: `g:${k}`, t: null, itemKey: k, ...namer.name(k), amount: g });
        });
        result.detail = {
            ...rows,
            opening: stateRows(openingState, namer, 'o'),
            closing: stateRows(closingState, namer, 'z'),
            now: stateRows(state, namer, 'n'),
            gap
        };
    }
    return result;
}

/**
 * Profit (F4) per day from a detailed summary: sales − cost of goods sold −
 * business expenses − bad debts, each counted on its own day. The days add up
 * to summary.profit.
 * @param {Object} detail `detail` from computeFinanceSummary({detail: true})
 * @param {(t: number) => string} dayKey
 * @returns {Object<string, number>}
 */
export function profitByDay(detail, dayKey) {
    const out = {};
    const add = (rows, sign) => (rows || []).forEach(r => {
        if (!Number.isFinite(r.t)) return;
        const k = dayKey(r.t);
        out[k] = (out[k] || 0) + sign * num(r.amount);
    });
    add(detail?.sales, 1);
    add(detail?.stock?.cogs, -1);
    add(detail?.business, -1);
    add(detail?.badDebts, -1);
    Object.keys(out).forEach(k => { out[k] = round2(out[k]); });
    return out;
}

/**
 * Sales rows at line level (so they group by item); a bill whose total
 * differs from its lines (discount, rounding, legacy shape) gets one extra row
 * so the rows always add up to billTotal().
 */
function saleRows(bill, billType, getKey, namer) {
    const base = billFields(bill, billType);
    const rows = [];
    let lines = 0;
    (Array.isArray(bill.items) ? bill.items : []).forEach((line, idx) => {
        const l = readLineItem(line);
        const key = getKey(line);
        namer.note(key, line.name);
        lines += l.total;
        rows.push({ key: `s:${billType}:${base.billId}:${idx}`, ...base, itemKey: key, ...namer.name(key), qty: l.qty, rate: l.rate, amount: l.total });
    });
    const diff = billTotal(bill) - lines;
    if (Math.abs(diff) >= 0.005) {
        rows.push({ key: `s:${billType}:${base.billId}:rest`, ...base, itemKey: '', item: '', itemHi: '', rest: true, amount: diff });
    }
    return rows;
}

/**
 * Every number on the Finance dashboard for [from, to).
 * @param {Object} args
 * @param {Object} args.sources {purchases, wholesaleSales, retailSales, stockAdjustments}
 * @param {Array} args.items
 * @param {?{state: Object, from: number}} args.base replay start (see pickReplayBase); null = cost unknown
 * @param {Array} [args.expenses]
 * @param {Array} [args.withdrawals]
 * @param {number} [args.from=-Infinity]
 * @param {number} [args.to=Infinity]
 * @param {Array} [args.sessions] cash sessions covering the period: their due-payment legs
 *   count payments on bills that are no longer in memory (deduped by payment id)
 * @param {boolean} [args.duesComplete=true] false when neither the full history nor the
 *   period's sessions are loaded: cash flow / bad debts may miss payments on old bills
 * @param {boolean} [args.detail=false] also return `detail` (rows behind every number)
 */
export function computeFinanceSummary({
    sources, items, base, expenses = [], withdrawals = [], sessions = [], duesComplete = true,
    from = -Infinity, to = Infinity, detail = false
}) {
    const wholesale = billsInRange(sources.wholesaleSales, from, to);
    const retail = billsInRange(sources.retailSales, from, to);
    const sales = [...wholesale, ...retail];
    const purchases = billsInRange(sources.purchases, from, to);

    const salesTotal = round2(sales.reduce((a, b) => a + billTotal(b), 0));
    const salesDue = round2(sales.reduce((a, b) => a + outstandingDue(b), 0));
    const purchasesTotal = round2(purchases.reduce((a, b) => a + billTotal(b), 0));
    // Labour deducted on purchase bills: not part of the goods' cost (owner question on #215).
    const labourOf = (b) => num(b.laborCharges);
    const labour = round2(purchases.reduce((a, b) => a + labourOf(b), 0));

    let businessExp = 0;
    let personalExp = 0;
    let uncategorisedExp = 0;
    let businessCount = 0;
    let personalCount = 0;
    const expenseRows = { business: [], personal: [] };
    (expenses || []).forEach((e, idx) => {
        if (!recordInRange(e, from, to)) return;
        const amount = num(e.amount);
        const personal = e.category === 'personal';
        if (personal) {
            personalExp += amount;
            personalCount++;
        } else {
            businessExp += amount;
            businessCount++;
            if (e.category !== 'business') uncategorisedExp += amount;
        }
        if (detail) {
            expenseRows[personal ? 'personal' : 'business'].push({
                key: `e:${e.id ?? idx}`, t: recordTime(e), category: String(e.category || ''),
                party: String(e.personName || '').trim(),
                note: [e.type, e.remarks].filter(Boolean).map(String).join(' · '),
                amount
            });
        }
    });
    businessExp = round2(businessExp);
    personalExp = round2(personalExp);
    uncategorisedExp = round2(uncategorisedExp);

    const withdrawalList = (withdrawals || []).filter(w => recordInRange(w, from, to));
    const withdrawn = round2(withdrawalList.reduce((a, w) => a + num(w.amount), 0));

    const billTypeOf = new Map();
    if (detail) {
        (sources.wholesaleSales || []).forEach(b => billTypeOf.set(`wholesale:${String(b.id)}`, b));
        (sources.retailSales || []).forEach(b => billTypeOf.set(`retail:${String(b.id)}`, b));
        (sources.purchases || []).forEach(b => billTypeOf.set(`purchase:${String(b.id)}`, b));
    }
    const atBillRows = (bills, type) => bills.map(b => {
        const p = saleTimePayment(b);
        return { key: `pay:${type}:${b.id}`, ...billFields(b, type), cash: p.cash, online: p.online, amount: p.cash + p.online };
    });
    const atBill = (bills) => bills.reduce((a, b) => {
        const p = saleTimePayment(b);
        return a + p.cash + p.online;
    }, 0);
    const events = dueEvents({
        bills: { retail: sources.retailSales || [], wholesale: sources.wholesaleSales || [], purchase: sources.purchases || [] },
        sessions: sessions || [],
        from, to
    });
    const dues = sumDueEvents(events);
    const receivedAtSale = round2(atBill(sales));
    const dueReceived = round2(dues.receivedCash + dues.receivedOnline);
    const paidAtPurchase = round2(atBill(purchases));
    const duePaid = round2(dues.paidCash + dues.paidOnline);
    const moneyIn = round2(receivedAtSale + dueReceived);
    const moneyOut = round2(paidAtPurchase + duePaid + businessExp + personalExp);
    // Receivables written off in the period: sold but never paid, so not profit.
    const badDebts = round2(dues.writtenOffReceivable);

    const stock = stockMovement({ base, sources, items, from, to, detail });
    const cogs = stock ? stock.cogs : null;
    const grossProfit = stock ? round2(salesTotal - cogs) : null;
    const profit = stock ? round2(grossProfit - businessExp - badDebts) : null;
    const afterPersonal = stock ? round2(profit - personalExp) : null;

    const summary = {
        sales: { total: salesTotal, count: sales.length, due: salesDue },
        purchases: { total: purchasesTotal, count: purchases.length, labour },
        expenses: { business: businessExp, businessCount, personal: personalExp, personalCount, uncategorised: uncategorisedExp },
        withdrawn,
        cogs,
        grossProfit,
        badDebts,
        profit,
        afterPersonal,
        afterWithdrawals: stock ? round2(afterPersonal - withdrawn) : null,
        stock,
        stockMismatch: !!stock && Math.abs(stock.gap) > STOCK_CHECK_TOLERANCE,
        // The gap is (mostly) goods sold in an earlier period before this purchase was entered.
        // (only when the refilled shortfall was sold before this period, not within it).
        mismatchFromEarlierSales: !!stock && stock.deficitRefilled.value > 0
            && stock.deficitRefilled.qty > stock.uncosted.qty + 1e-9
            && Math.abs(stock.gap - stock.deficitRefilled.value) <= STOCK_CHECK_TOLERANCE,
        uncostedWarning: !!stock && stock.uncosted.qty > 0,
        duesApproximate: !duesComplete,
        cash: { receivedAtSale, dueReceived, moneyIn, paidAtPurchase, duePaid, moneyOut, net: round2(moneyIn - moneyOut) }
    };

    if (detail) {
        const getKey = createItemKeyResolver(items);
        const namer = itemNamer(items, getKey);
        const dueRow = (e) => {
            const type = ['wholesale', 'retail', 'purchase'].find(tp => billTypeOf.has(`${tp}:${e.billId}`));
            const bill = type ? billTypeOf.get(`${type}:${e.billId}`) : null;
            return {
                key: `due:${e.id}`, ...(bill ? billFields(bill, type) : { billId: null, billType: null, billNo: '', party: '' }),
                t: Number.isFinite(e.at) ? e.at : null, party: e.party || (bill ? billFields(bill, type).party : ''),
                cash: e.cash, online: e.online, amount: e.cash + e.online
            };
        };
        summary.detail = {
            sales: [
                ...wholesale.flatMap(b => saleRows(b, 'wholesale', getKey, namer)),
                ...retail.flatMap(b => saleRows(b, 'retail', getKey, namer))
            ],
            business: expenseRows.business,
            personal: expenseRows.personal,
            withdrawn: withdrawalList.map((w, idx) => ({
                key: `w:${w.id ?? idx}`, t: recordTime(w), party: String(w.person || '').trim(),
                note: [w.purpose, w.notes].filter(Boolean).map(String).join(' · '), amount: num(w.amount)
            })),
            receivedAtSale: [...atBillRows(wholesale, 'wholesale'), ...atBillRows(retail, 'retail')].filter(r => r.amount !== 0),
            paidAtPurchase: atBillRows(purchases, 'purchase').filter(r => r.amount !== 0),
            dueReceived: events.filter(e => e.direction === 'received' && e.cash + e.online !== 0).map(dueRow),
            duePaid: events.filter(e => e.direction === 'paid' && e.cash + e.online !== 0).map(dueRow),
            badDebts: events.filter(e => e.direction === 'received' && e.writeOff !== 0)
                .map(e => ({ ...dueRow(e), key: `wo:${e.id}`, cash: undefined, online: undefined, writeOff: true, amount: e.writeOff })),
            labour: purchases.filter(b => labourOf(b) !== 0)
                .map(b => ({ key: `lab:${b.id}`, ...billFields(b, 'purchase'), labour: true, amount: labourOf(b) })),
            stock: stock ? stock.detail : null
        };
    }
    return summary;
}
